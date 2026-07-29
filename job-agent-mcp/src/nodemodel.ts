/**
 * Normalized node model + structural diff — the agent's verification primitive.
 *
 * Why this exists: two tool calls can both report success and still leave the
 * page wrong. Observed on LinkedIn: browser_fill APPENDED into a contenteditable
 * instead of replacing ("old textnew text"), and a Ctrl+A / Delete pair failed
 * to clear a field so the next fill appended again. Nothing in the tool results
 * said so. browser_diff answers "did my last step actually do what I think?".
 *
 * Design constraints, each of them learned the hard way:
 *
 * - DOM-derived, not ARIA-derived. Playwright's ARIA snapshot does not expose
 *   contenteditable text at all — the exact field where the append bug lived.
 *   A diff built on it is structurally blind to the bug it exists to catch, so
 *   the model is walked from the DOM and carries `value` explicitly.
 * - Never diff serialized text. React re-renders shift indentation and reorder
 *   attributes, which a text diff reports as a wall of phantom changes.
 * - Index paths count positions in the MODEL tree, not the DOM tree: role-less
 *   wrapper elements are transparent and their children hoist to the nearest
 *   meaningful ancestor. A React refactor that adds a wrapper <div> therefore
 *   does not shift every path below it.
 * - Nodes pair by KEYED SIBLING ALIGNMENT, never by a global role+name lookup.
 *   LinkedIn's company typeahead renders three buttons all named "Ant Group",
 *   so a global name lookup misassigns them by construction. Alignment happens
 *   only between the children of two already-paired parents, and duplicates are
 *   distinguished by their ordinal within that sibling list — so the three
 *   buttons still pair 1-1, 2-2, 3-3.
 *
 * Paths are addresses in the output, NOT the pairing mechanism. An earlier
 * version paired on them directly, which meant inserting one node in the middle
 * of a list shifted every following sibling and surfaced as a run of bogus
 * `changed` entries instead of a single `added`. Keyed alignment fixes that:
 * see alignChildren.
 */
import type { Page } from "playwright";

/** A baseline older than this is treated as stale — the page has moved on. */
export const BASELINE_TTL_MS = 5 * 60_000;

export interface AriaNode {
  /** Index chain from the scope root through the model tree, e.g. "0/3/1/7". */
  path: string;
  role: string;
  name: string;
  value?: string;
  state?: string;
}

export interface FieldChange {
  field: "name" | "value" | "state";
  from: string;
  to: string;
}

/** A whole subtree that appeared or vanished, reported at its root. */
export interface SubtreeChange {
  node: AriaNode;
  /** How many nodes below it moved with it. */
  descendants: number;
}

export interface NodeDiff {
  added: SubtreeChange[];
  removed: SubtreeChange[];
  changed: Array<{ node: AriaNode; fields: FieldChange[] }>;
}

export interface Baseline {
  url: string;
  /** The scope the model was captured under — a different scope is not comparable. */
  scope: string | null;
  /** Whether that scope actually matched. A scoped tree and a full-page tree share no paths. */
  scopeMissed: boolean;
  capturedAt: number;
  nodes: AriaNode[];
}

// --------------------------------------------------------------- capture ---

/**
 * Runs in page context. Everything it needs must be defined inside: Playwright
 * ships this to the browser as source text, so module-scope references would be
 * undefined at runtime.
 */
function walkDocument(scopeSel: string | null): AriaNode[] | null {
  const root: Element | null = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return null;

  // Every value this function uses must be declared HERE. Playwright ships the
  // function to the browser as source text, so a module-scope constant would be
  // a ReferenceError at runtime, not a compile error.
  /** Safety valve: a pathological page should not blow up memory or the payload. */
  const MAX_NODES = 4_000;

  const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "LINK", "META"]);
  // Roles whose accessible name comes from their own text — emit the node and
  // stop, so the name is not duplicated as a child text node.
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "option", "tab", "menuitem", "treeitem",
    "checkbox", "radio", "switch", "cell", "columnheader", "rowheader",
  ]);
  const INPUT_TEXT = new Set([
    "text", "email", "search", "tel", "url", "password", "number", "", "date", "month",
  ]);
  const TAG_ROLE: Record<string, string> = {
    BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", OPTION: "option",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell",
    TH: "columnheader", NAV: "navigation", MAIN: "main", HEADER: "banner",
    FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog",
    PROGRESS: "progressbar", METER: "meter", IFRAME: "iframe",
  };

  const out: AriaNode[] = [];
  let overflowed = false;

  const cap = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();

  const isEditable = (el: Element): boolean =>
    (el as HTMLElement).isContentEditable === true &&
    !(el.parentElement && (el.parentElement as HTMLElement).isContentEditable);

  function visible(el: Element): boolean {
    if (el.tagName === "OPTION") return true; // options in a closed select
    if ((el as HTMLElement).hidden) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden";
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "IMG") return el.getAttribute("alt") ? "img" : null;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "hidden") return null;
      if (INPUT_TEXT.has(t)) return "textbox";
      return "textbox";
    }
    if (tag === "SELECT") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "SECTION") return el.getAttribute("aria-label") ? "region" : null;
    if (isEditable(el)) return "textbox";
    return TAG_ROLE[tag] ?? null;
  }

  function labelText(el: Element): string {
    const byLabelledBy = el.getAttribute("aria-labelledby");
    if (byLabelledBy) {
      const parts = byLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl?.textContent) return lbl.textContent;
    }
    const wrapping = el.closest("label");
    if (wrapping?.textContent) return wrapping.textContent;
    return "";
  }

  function nameOf(el: Element, role: string): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return cap(flat(aria));
    if (role === "img") return cap(flat(el.getAttribute("alt") || ""));
    const labelled = labelText(el);
    if (labelled) return cap(flat(labelled));
    if (NAME_FROM_CONTENT.has(role)) return cap(flat((el as HTMLElement).innerText || el.textContent || ""));
    const title = el.getAttribute("title") || el.getAttribute("placeholder");
    return title ? cap(flat(title)) : "";
  }

  function valueOf(el: Element, role: string): string | undefined {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return (el as HTMLInputElement).value;
    if (tag === "SELECT") {
      return Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => o.label || o.textContent || "")
        .join(", ");
    }
    if (isEditable(el)) return cap(flat((el as HTMLElement).innerText || ""), 500);
    if (role === "progressbar" || role === "meter") return el.getAttribute("value") ?? undefined;
    return undefined;
  }

  function stateOf(el: Element): string | undefined {
    const s: string[] = [];
    if (el.tagName === "OPTION" && (el as HTMLOptionElement).selected) s.push("selected");
    const inp = el as HTMLInputElement;
    if (el.tagName === "INPUT" && (inp.type === "checkbox" || inp.type === "radio") && inp.checked) {
      s.push("checked");
    }
    if ((el as HTMLInputElement).disabled) s.push("disabled");
    for (const attr of ["aria-selected", "aria-checked", "aria-expanded", "aria-pressed", "aria-current"]) {
      const v = el.getAttribute(attr);
      if (v && v !== "false") s.push(`${attr.slice(5)}=${v}`);
    }
    if (el.tagName === "DETAILS" || el.tagName === "DIALOG") {
      if ((el as HTMLDetailsElement).open) s.push("open");
    }
    return s.length ? s.join(" ") : undefined;
  }

  function emit(path: string, node: Omit<AriaNode, "path">): void {
    if (out.length >= MAX_NODES) {
      overflowed = true;
      return;
    }
    out.push({ path, ...node });
  }

  function walk(container: Element, parentPath: string, startIdx: number): number {
    let idx = startIdx;
    const kids = container.childNodes;
    for (let k = 0; k < kids.length; k++) {
      const n = kids[k];
      if (n.nodeType === 3) {
        const t = flat(n.nodeValue || "");
        if (!t) continue;
        emit(parentPath === "" ? String(idx) : `${parentPath}/${idx}`, { role: "text", name: cap(t) });
        idx++;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (SKIP.has(el.tagName)) continue;
      if (!visible(el)) continue;
      const role = roleOf(el);
      if (!role) {
        // Transparent wrapper: children keep numbering at this level, so adding
        // a layout <div> does not renumber everything beneath it.
        idx = walk(el, parentPath, idx);
        continue;
      }
      const path = parentPath === "" ? String(idx) : `${parentPath}/${idx}`;
      emit(path, {
        role,
        name: nameOf(el, role),
        value: valueOf(el, role),
        state: stateOf(el),
      });
      idx++;
      if (!NAME_FROM_CONTENT.has(role) && !isEditable(el)) walk(el, path, 0);
    }
    return idx;
  }

  walk(root, "", 0);
  if (overflowed) out.push({ path: "!", role: "note", name: `truncated at ${MAX_NODES} nodes` });
  return out;
}

export interface CaptureResult {
  nodes: AriaNode[];
  /** True when a scope was requested but matched nothing (nodes are the full page). */
  scopeMissed: boolean;
}

/**
 * Ship the walker into the page as a self-contained expression.
 *
 * We run under tsx, and esbuild's keep-names transform rewrites every nested
 * function into `__name(fn, "fn")`. That helper is defined in the Node module
 * scope, not in the page, so handing the function straight to page.evaluate
 * dies with `ReferenceError: __name is not defined` — in production, not just
 * in tests. Wrapping the source in a closure that declares its own `__name`
 * fixes it without touching page globals. Evaluating a string is CSP-safe here:
 * Playwright evaluates through CDP, which is not subject to the page's
 * script-src policy (this matters — LinkedIn forbids eval).
 */
function walkerExpression(scopeSel: string | null): string {
  return `(function (scopeSel) {
    var __name = function (f) { return f; };
    return (${walkDocument.toString()})(scopeSel);
  })(${JSON.stringify(scopeSel)})`;
}

/**
 * Errors deliberately propagate. An empty node list is indistinguishable from
 * "nothing changed", so swallowing a walker failure here would make browser_diff
 * confidently report "no changes" forever — the exact silent-success failure the
 * tool exists to expose.
 */
export async function captureNodes(page: Page, scope: string | null): Promise<CaptureResult> {
  if (scope) {
    const scoped = await page.evaluate<AriaNode[] | null>(walkerExpression(scope));
    if (scoped) return { nodes: scoped, scopeMissed: false };
  }
  const full = await page.evaluate<AriaNode[] | null>(walkerExpression(null));
  return { nodes: full ?? [], scopeMissed: scope !== null };
}

// ------------------------------------------------------------------ diff ---

const parentOf = (p: string): string | null => {
  const i = p.lastIndexOf("/");
  return i === -1 ? null : p.slice(0, i);
};

interface TreeNode {
  node: AriaNode;
  children: TreeNode[];
  /** Nodes in this subtree, including itself. */
  size: number;
  digest?: string;
}

/**
 * Rebuild the model tree from the flat, document-ordered node list. Parents
 * always precede their children there, so a single pass suffices.
 */
function buildTree(nodes: AriaNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const node of nodes) {
    const t: TreeNode = { node, children: [], size: 1 };
    byPath.set(node.path, t);
    const pp = parentOf(node.path);
    const parent = pp === null ? undefined : byPath.get(pp);
    if (parent) parent.children.push(t);
    else roots.push(t);
  }
  const size = (t: TreeNode): number => {
    for (const c of t.children) t.size += size(c);
    return t.size;
  };
  for (const r of roots) size(r);
  return roots;
}

/** Truncated subtree text, used to identify container nodes that have no name. */
const DIGEST_CHARS = 60;

function digestOf(t: TreeNode): string {
  if (t.digest !== undefined) return t.digest;
  let s = t.node.name || t.node.value || "";
  for (const c of t.children) {
    if (s.length >= DIGEST_CHARS) break;
    s += `|${digestOf(c)}`;
  }
  t.digest = s.slice(0, DIGEST_CHARS);
  return t.digest;
}

/**
 * The identity of a node among its siblings.
 *
 * Deliberately excludes `value` and `state` — those are what we are trying to
 * observe changing, so folding them in would turn every edit into a
 * remove+add. Falls back to a subtree text digest for container roles that
 * carry no accessible name of their own (<li>, generic regions): without it,
 * inserting one row into a list makes every following row look renamed, which
 * is the exact cascade this alignment exists to kill.
 *
 * DOM ids are deliberately NOT used: LinkedIn is Ember, whose `ember1234` ids
 * are regenerated on re-render, so keying on them would be worse than useless.
 */
function keyOf(t: TreeNode): string {
  const { role, name } = t.node;
  return name ? `${role}|${name}` : `${role}|~${digestOf(t)}`;
}

type Pair = [TreeNode | null, TreeNode | null];

/**
 * Align two sibling lists. Two passes, in the spirit of React's reconciler:
 *
 *  1. Keyed: match by (key, ordinal-among-equal-keys). Order-preserving and
 *     duplicate-safe — three identical buttons pair 1-1, 2-2, 3-3, and a row
 *     inserted mid-list leaves exactly one unmatched newcomer.
 *  2. Positional residue: whatever is left over pairs up in order when the
 *     roles agree. This is what turns a node whose NAME changed (a character
 *     counter ticking over) back into one `changed` entry instead of a
 *     remove+add — its key moved, so pass 1 could not match it.
 */
function alignChildren(before: TreeNode[], after: TreeNode[]): Pair[] {
  const buckets = new Map<string, TreeNode[]>();
  for (const t of before) {
    const k = keyOf(t);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(t);
    else buckets.set(k, [t]);
  }

  const cursor = new Map<string, number>();
  const partner = new Map<TreeNode, TreeNode>();
  const takenOld = new Set<TreeNode>();
  for (const t of after) {
    const k = keyOf(t);
    const bucket = buckets.get(k);
    if (!bucket) continue;
    const i = cursor.get(k) ?? 0;
    if (i >= bucket.length) continue;
    cursor.set(k, i + 1);
    partner.set(t, bucket[i]);
    takenOld.add(bucket[i]);
  }

  const restOld = before.filter((t) => !takenOld.has(t));
  const restNew = after.filter((t) => !partner.has(t));
  const usedOld = new Set<TreeNode>();
  for (let i = 0; i < Math.min(restOld.length, restNew.length); i++) {
    if (restOld[i].node.role !== restNew[i].node.role) continue;
    partner.set(restNew[i], restOld[i]);
    usedOld.add(restOld[i]);
  }

  const pairs: Pair[] = [];
  for (const t of after) pairs.push([partner.get(t) ?? null, t]);
  for (const t of before) {
    if (!takenOld.has(t) && !usedOld.has(t)) pairs.push([t, null]);
  }
  return pairs;
}

function fieldChanges(prev: AriaNode, next: AriaNode): FieldChange[] {
  const fields: FieldChange[] = [];
  if (prev.name !== next.name) fields.push({ field: "name", from: prev.name, to: next.name });
  if ((prev.value ?? "") !== (next.value ?? "")) {
    fields.push({ field: "value", from: prev.value ?? "", to: next.value ?? "" });
  }
  if ((prev.state ?? "") !== (next.state ?? "")) {
    fields.push({ field: "state", from: prev.state ?? "", to: next.state ?? "" });
  }
  return fields;
}

export function diffNodes(before: AriaNode[], after: AriaNode[]): NodeDiff {
  const diff: NodeDiff = { added: [], removed: [], changed: [] };

  // An unpaired node takes its whole subtree with it, and is reported at its
  // root with a descendant count. Closing a dialog holding four <select>s
  // otherwise emits 265 lines — one per <option> — which is unreadable and big
  // enough to trip the "diff too large" fallback, burying the one useful fact.
  const visit = (pair: Pair): void => {
    const [oldT, newT] = pair;
    if (!oldT && newT) {
      diff.added.push({ node: newT.node, descendants: newT.size - 1 });
      return;
    }
    if (oldT && !newT) {
      diff.removed.push({ node: oldT.node, descendants: oldT.size - 1 });
      return;
    }
    if (!oldT || !newT) return;
    // Same slot, different role: a different element entirely, not a mutation.
    if (oldT.node.role !== newT.node.role) {
      diff.removed.push({ node: oldT.node, descendants: oldT.size - 1 });
      diff.added.push({ node: newT.node, descendants: newT.size - 1 });
      return;
    }
    const fields = fieldChanges(oldT.node, newT.node);
    if (fields.length) diff.changed.push({ node: newT.node, fields });
    for (const child of alignChildren(oldT.children, newT.children)) visit(child);
  };

  for (const pair of alignChildren(buildTree(before), buildTree(after))) visit(pair);
  return diff;
}

export function isEmptyDiff(d: NodeDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

const describe = (n: AriaNode) =>
  `[${n.path}] ${n.role}${n.name ? ` "${n.name}"` : ""}` +
  (n.value ? ` value="${n.value}"` : "") +
  (n.state ? ` (${n.state})` : "");

const quote = (s: string) => `"${s}"`;

/**
 * Machine-readable on purpose: one change per line, prefixed +/-/~, so the
 * golden set can assert on it and the agent can scan it without prose.
 */
export function formatDiff(d: NodeDiff): string {
  if (isEmptyDiff(d)) {
    // The single most important return value: the last step changed nothing.
    // Never let this degrade into an empty string the agent reads as success.
    return "no changes — the page is identical to the cached baseline. If you just performed an action, IT HAD NO EFFECT.";
  }
  const lines: string[] = [];
  const sub = (c: SubtreeChange) =>
    describe(c.node) + (c.descendants ? ` (+${c.descendants} descendants)` : "");
  for (const c of d.added) lines.push(`+ ${sub(c)}`);
  for (const c of d.removed) lines.push(`- ${sub(c)}`);
  for (const c of d.changed) {
    const what = c.fields
      .map((f) => `${f.field} ${quote(f.from)} → ${quote(f.to)}`)
      .join("; ");
    lines.push(`~ [${c.node.path}] ${c.node.role}${c.node.name ? ` "${c.node.name}"` : ""}: ${what}`);
  }
  const header =
    `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed`;
  return `${header}\n---\n${lines.join("\n")}`;
}

// -------------------------------------------------------------- baseline ---

let baseline: Baseline | null = null;

export function setBaseline(b: Baseline): void {
  baseline = b;
}

export function getBaseline(): Baseline | null {
  return baseline;
}

/** Called on navigation: a new document makes every cached path meaningless. */
export function clearBaseline(): void {
  baseline = null;
}

/**
 * Why the cached baseline cannot be diffed against the current page, or null if
 * it can. Checked before every diff — a mismatched baseline is worse than none.
 */
export function baselineMismatch(
  b: Baseline | null,
  url: string,
  scope: string | null,
  scopeMissed: boolean,
): string | null {
  if (!b) return "no baseline cached yet";
  if (b.url !== url) return `url changed since the baseline (${b.url})`;
  if (b.scope !== scope) return `snapshot scope changed since the baseline (was ${b.scope ?? "none"})`;
  if (b.scopeMissed !== scopeMissed) {
    return scopeMissed
      ? "the scope no longer matches, so this is a full-page tree and the baseline was scoped"
      : "the scope matches again, but the baseline was captured as a full page";
  }
  if (Date.now() - b.capturedAt > BASELINE_TTL_MS) return "baseline is stale (older than 5 minutes)";
  return null;
}
