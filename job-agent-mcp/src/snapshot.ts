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
  try {
    content = await root.ariaSnapshot({ timeout: 5_000 });
    content = collapseSelectOptions(content);
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
  return `${header.join("\n")}\n---\n${s.content}`;
}
