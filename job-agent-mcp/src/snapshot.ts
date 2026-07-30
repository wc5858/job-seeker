/**
 * Page perception for the agent — "DOM over screenshots".
 *
 * Primary: Playwright's ARIA snapshot (role + accessible-name tree) — compact,
 * structured, and what role/name-based locators key off, so what the agent
 * reads is exactly what it can click.
 * Fallback: title + trimmed innerText when the ARIA snapshot fails.
 *
 * Output is truncated to keep tool results context-friendly; the caller can
 * paginate with the `offset` argument instead of receiving a firehose.
 *
 * SCOPE: a full-page ARIA tree on an app like LinkedIn runs 12k-30k chars while
 * the agent usually only cares about one dialog. `scope` (a CSS selector) roots
 * the snapshot at a subtree; the session-level default set via
 * `setSnapshotScope` applies to EVERY tool that returns a snapshot, so a
 * multi-step form task pays for the dialog only. A scope that matches nothing
 * falls back to the full page and says so — never silently return an empty tree,
 * because the agent cannot tell "dialog closed" from "selector typo" otherwise.
 *
 * The other half of the cost is native <select>s: Playwright enumerates every
 * <option>, so one year picker outweighs the dialog containing it. Long option
 * lists are collapsed to a one-line summary — see collapseSelectOptions.
 */
import type { Page, Locator } from "playwright";
import { evalInPage } from "./pagefn.js";

/** How much of a field's value to show before cutting it. */
const VALUE_CHARS = 240;

interface FieldInfo {
  name: string;
  /** "input", "input:email", "textarea" or "contenteditable". */
  kind: string;
  maxLength: number | null;
  value: string;
}

/**
 * Read editable fields straight from the DOM, because the ARIA snapshot loses
 * exactly what matters when filling a form:
 *
 *   - it flattens newlines to spaces, so a multi-line answer reads as mangled
 *     (this produced a false bug report to the user — the field was fine);
 *   - it renders <input> and <textarea> identically as `textbox`, so there is
 *     no way to see that a field is single-line, and no way to see maxlength.
 *     A long answer written into a maxlength-capped input is silently cut;
 *   - it omits contenteditable values entirely.
 */
function collectFields(scopeSel: string | null): FieldInfo[] | null {
  const root: Element | null = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return null;

  const SKIP_TYPES = new Set([
    "button", "submit", "reset", "hidden", "file", "checkbox", "radio", "image", "range", "color",
  ]);
  const out: FieldInfo[] = [];
  const nodes = root.querySelectorAll(
    'input, textarea, [contenteditable=""], [contenteditable="true"]',
  );

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement;
    let kind: string;
    let value: string;
    let maxLength: number | null = null;
    if (el.tagName === "INPUT") {
      const inp = el as HTMLInputElement;
      const type = (inp.getAttribute("type") || "text").toLowerCase();
      if (SKIP_TYPES.has(type)) continue;
      kind = type === "text" ? "input" : `input:${type}`;
      value = inp.value;
      maxLength = inp.maxLength >= 0 ? inp.maxLength : null;
    } else if (el.tagName === "TEXTAREA") {
      const ta = el as HTMLTextAreaElement;
      kind = "textarea";
      value = ta.value;
      maxLength = ta.maxLength >= 0 ? ta.maxLength : null;
    } else {
      // Nested editable regions belong to their host, not to themselves.
      if (el.parentElement && el.parentElement.isContentEditable) continue;
      kind = "contenteditable";
      value = el.innerText || "";
    }

    // Accessible name, resolved the same way the ARIA tree resolves it, so the
    // annotation can be matched back onto the right line.
    let name = el.getAttribute("aria-label") || "";
    if (!name) {
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const parts: string[] = [];
        const ids = by.split(/\s+/);
        for (let k = 0; k < ids.length; k++) {
          const t = document.getElementById(ids[k]);
          if (t && t.textContent) parts.push(t.textContent);
        }
        name = parts.join(" ");
      }
    }
    if (!name && el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && lbl.textContent) name = lbl.textContent;
    }
    if (!name) {
      const wrap = el.closest("label");
      if (wrap && wrap.textContent) name = wrap.textContent;
    }
    if (!name) name = el.getAttribute("placeholder") || "";
    out.push({ name: name.replace(/\s+/g, " ").trim(), kind, maxLength, value });
  }
  return out;
}

/** Newlines survive as a visible marker: the tree is line-based, so a real \n would break it. */
function renderValue(value: string): string {
  const flat = value.replace(/\r\n|\r|\n/g, "⏎");
  if (flat.length <= VALUE_CHARS) return flat;
  return `${flat.slice(0, VALUE_CHARS)}… [truncated, ${value.length} chars total]`;
}

/**
 * Annotate `textbox` lines with what kind of control they actually are.
 *
 * Matched by accessible name, and ONLY when that name is unique among the
 * fields found — a positional match would be faster but would silently
 * mislabel a field's maxlength when the two lists diverge, and wrong metadata
 * here is worse than none.
 */
function annotateFields(content: string, fields: FieldInfo[]): string {
  const byName = new Map<string, FieldInfo | "ambiguous">();
  for (const f of fields) {
    if (!f.name) continue;
    byName.set(f.name, byName.has(f.name) ? "ambiguous" : f);
  }
  return content
    .split("\n")
    .map((line) => {
      const m = /^(\s*- textbox "([^"]*)")(?::\s?(.*))?$/.exec(line);
      if (!m) return line;
      const found = byName.get(m[2]);
      if (!found || found === "ambiguous") return line;
      const meta = [found.kind];
      if (found.maxLength !== null) {
        meta.push(`maxlength=${found.maxLength}`);
        meta.push(`${found.value.length} used`);
      }
      const rendered = found.value ? `: ${renderValue(found.value)}` : "";
      return `${m[1]} [${meta.join(", ")}]${rendered}`;
    })
    .join("\n");
}

const MAX_CHARS = 12_000;

/** How long to wait for a scope selector to show up before declaring a miss. */
const SCOPE_WAIT_MS = 500;

/**
 * Native <select> option lists longer than this are summarized instead of
 * enumerated. Playwright's ARIA snapshot lists every <option>, so a single
 * LinkedIn year picker (1926-2026) costs ~2k chars — more than the whole
 * dialog around it. Short lists stay expanded because reading them is cheap
 * and often the point (employment type, location type); the long ones are
 * months/years/countries, which the agent can set blind with browser_select
 * (it accepts a unique prefix and lists the real options when it misses).
 */
const OPTION_COLLAPSE_THRESHOLD = 10;

/**
 * Collapse long option runs under `combobox` nodes — i.e. native <select>s.
 * Deliberately does NOT touch `listbox` nodes: those are typeahead suggestion
 * popups, where reading the freshly-filtered options is the entire workflow.
 */
function collapseSelectOptions(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^(\s*)- combobox\b(.*):\s*$/.exec(line);
    // A combobox at the very top of the snapshot is what the caller scoped to;
    // they asked for this element specifically, so show all of it.
    if (!head || (i === 0 && head[1].length === 0)) {
      out.push(line);
      continue;
    }
    const indent = head[1].length;
    const options: string[] = [];
    let j = i + 1;
    let pureOptions = true;
    for (; j < lines.length; j++) {
      const child = lines[j];
      if (!child.trim()) break;
      const childIndent = child.length - child.trimStart().length;
      if (childIndent <= indent) break;
      if (!/^\s*- option\b/.test(child)) {
        pureOptions = false;
        break;
      }
      options.push(child);
    }
    if (!pureOptions || options.length <= OPTION_COLLAPSE_THRESHOLD) {
      out.push(line);
      continue;
    }
    const selected = options.find((o) => o.includes("[selected]"));
    const selectedName = selected ? /- option "([^"]*)"/.exec(selected)?.[1] : undefined;
    out.push(
      `${head[1]}- combobox${head[2]}: [${options.length} options collapsed` +
        (selectedName === undefined ? "" : `, selected "${selectedName}"`) +
        `] — set it with browser_select`,
    );
    i = j - 1;
  }
  return out.join("\n");
}

/**
 * Container roles whose emptiness means "content is missing here", so an agent
 * reading the tree does not mistake a lazy placeholder for the end of a list.
 *
 * `cell` and `option` are deliberately excluded: an empty table cell or an empty
 * placeholder <option> is ordinary markup, not a symptom.
 */
const PLACEHOLDER_ROLES = new Set([
  "listitem", "article", "row", "treeitem", "group", "region", "tabpanel", "figure",
]);

/**
 * Mark container nodes that carry no accessible content at all.
 *
 * Playwright serializes a node with children as `- listitem:` and a named one as
 * `- listitem "x"`; a bare `- listitem` therefore has neither. On a lazy list
 * that is a row whose contents have not rendered yet — the failure that returns
 * a well-formed but incomplete answer instead of an error.
 */
function markUnrendered(content: string): { text: string; count: number } {
  let count = 0;
  const text = content
    .split("\n")
    .map((line) => {
      const m = /^\s*- ([a-z]+)\s*$/.exec(line);
      if (!m || !PLACEHOLDER_ROLES.has(m[1])) return line;
      count++;
      return `${line} [not rendered]`;
    })
    .join("\n");
  return { text, count };
}

export interface SnapshotResult {
  url: string;
  title: string;
  kind: "aria" | "text";
  truncated: boolean;
  totalChars: number;
  content: string;
  /** The scope selector that was requested (per-call or session default). */
  scope?: string;
  /** True when `scope` was requested but matched nothing — content is the full page. */
  scopeMissed: boolean;
  /** Container nodes with no accessible content — lazy rows that have not rendered. */
  unrendered: number;
}

/**
 * Session-level default scope. Module state is the right home for it: every
 * snapshot-returning tool already funnels through snapshotPage, so setting it
 * here reaches click/fill/press/navigate without threading a parameter through
 * each tool handler.
 */
let sessionScope: string | null = null;

export function setSnapshotScope(scope: string | null): void {
  sessionScope = scope && scope.trim() ? scope.trim() : null;
}

export function getSnapshotScope(): string | null {
  return sessionScope;
}

export async function snapshotPage(
  page: Page,
  offset = 0,
  /** Per-call override. `undefined` = use the session default; `null` = force full page. */
  scope?: string | null,
): Promise<SnapshotResult> {
  const url = page.url();
  const title = await page.title().catch(() => "");

  const requested = scope === undefined ? sessionScope : scope;
  let root: Locator = page.locator("body");
  let scopeMissed = false;
  if (requested) {
    const scoped = page.locator(requested).first();
    const found = await scoped
      .waitFor({ state: "attached", timeout: SCOPE_WAIT_MS })
      .then(() => true)
      .catch(() => false);
    if (found) root = scoped;
    else scopeMissed = true;
  }

  let kind: "aria" | "text" = "aria";
  let content = "";
  let unrendered = 0;
  try {
    content = await root.ariaSnapshot({ timeout: 5_000 });
    content = collapseSelectOptions(content);
    const marked = markUnrendered(content);
    content = marked.text;
    unrendered = marked.count;
    const fields = await evalInPage(
      page,
      collectFields,
      scopeMissed ? null : (requested ?? null),
    ).catch(() => null);
    if (fields && fields.length) content = annotateFields(content, fields);
  } catch {
    kind = "text";
    content = await root
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    content = content.replace(/\n{3,}/g, "\n\n");
  }
  const totalChars = content.length;
  const slice = content.slice(offset, offset + MAX_CHARS);
  return {
    url,
    title,
    kind,
    truncated: offset + MAX_CHARS < totalChars,
    totalChars,
    content: slice,
    scope: requested ?? undefined,
    scopeMissed,
    unrendered,
  };
}

export function formatSnapshot(s: SnapshotResult, offset = 0): string {
  const header = [
    `url: ${s.url}`,
    `title: ${s.title}`,
    `format: ${s.kind}`,
  ];
  if (s.scope) {
    header.push(
      s.scopeMissed
        ? `scope: ${s.scope} — scope missed, full page`
        : `scope: ${s.scope}`,
    );
  }
  header.push(
    s.truncated
      ? `note: truncated at ${offset + s.content.length}/${s.totalChars} chars — call browser_snapshot with offset=${offset + s.content.length} for more`
      : `note: complete (${s.totalChars} chars)`,
  );
  if (s.unrendered > 0) {
    // Without this the tree looks complete and the agent stops early.
    header.push(
      `incomplete: ${s.unrendered} node(s) marked [not rendered] — rows exist but their ` +
        `content has not loaded. This list is NOT finished; call browser_scroll ` +
        `(to='bottom', steps=5) before reading it as complete.`,
    );
  }
  return `${header.join("\n")}\n---\n${s.content}`;
}
