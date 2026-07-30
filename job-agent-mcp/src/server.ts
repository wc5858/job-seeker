/**
 * job-agent-mcp — browser tools as an MCP server (stdio).
 *
 * Tool design principles (the harness thinking):
 * - Atomic tools first (navigate/snapshot/click/fill/select/press/screenshot/
 *   tabs/back); domain tools (search_jobs etc.) get layered on top once flows
 *   stabilize.
 * - Perception: browser_snapshot returns the ARIA tree — cheap and precise.
 *   browser_screenshot is the fallback sense for weird pages. On app-sized
 *   pages, browser_set_snapshot_scope narrows every snapshot to one subtree.
 * - Targeting: click/fill/select accept EITHER {role, name} (preferred —
 *   matches what the snapshot shows) OR a raw Playwright {selector} as an
 *   escape hatch.
 * - One tool per control type, because the failure modes differ: browser_fill
 *   for text/contenteditable, browser_select for native <select>, and
 *   fill + ArrowDown/Enter for typeahead listboxes.
 * - Safety: this server only exposes in-page actions. Nothing here sends
 *   messages/applications autonomously; the human supervises the headed
 *   browser, and "send"-class domain tools will require explicit confirmation
 *   when they are added.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  activePage,
  getContext,
  closeBrowser,
  listPages,
  selectPage,
  isSelected,
  clearSelection,
} from "./browser.js";
import {
  snapshotPage,
  formatSnapshot,
  setSnapshotScope,
  getSnapshotScope,
} from "./snapshot.js";
import {
  captureNodes,
  diffNodes,
  formatDiff,
  isEmptyDiff,
  setBaseline,
  getBaseline,
  clearBaseline,
  baselineMismatch,
} from "./nodemodel.js";
import { scrollContainer, waitForContentSettled, formatScroll } from "./scroll.js";
import type { Page, Locator } from "playwright";

/**
 * A diff that costs more than the snapshot it summarizes is not worth reading —
 * hand back the snapshot instead.
 */
const DIFF_TOO_LARGE_RATIO = 0.6;

/** Capture the node model as the baseline that the next browser_diff compares against. */
async function rebaseline(page: Page): Promise<void> {
  const scope = getSnapshotScope();
  const { nodes, scopeMissed } = await captureNodes(page, scope);
  setBaseline({ url: page.url(), scope, scopeMissed, capturedAt: Date.now(), nodes });
}

const server = new McpServer({ name: "job-agent", version: "0.1.0" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** Resolve a target from role+name or a raw selector. */
function resolveTarget(
  page: Page,
  args: { role?: string; name?: string; selector?: string },
): Locator {
  if (args.selector) return page.locator(args.selector).first();
  if (args.role) {
    return page
      .getByRole(args.role as Parameters<Page["getByRole"]>[0], {
        name: args.name,
        exact: false,
      })
      .first();
  }
  if (args.name) return page.getByText(args.name, { exact: false }).first();
  throw new Error("Provide either {role, name} or {selector}.");
}

const targetShape = {
  role: z
    .string()
    .optional()
    .describe("ARIA role from the snapshot, e.g. 'button', 'link', 'textbox'"),
  name: z
    .string()
    .optional()
    .describe("Accessible name (visible text) — supports partial match"),
  selector: z
    .string()
    .optional()
    .describe("Raw Playwright selector (escape hatch), e.g. 'css=.job-card >> nth=0'"),
};

server.registerTool(
  "browser_open_human",
  {
    description:
      "Hand the browser to the human: navigates the shared window to a URL for actions the agent must not or cannot do — logins, QR codes, captchas. The window stays shared; automation continues in it after the user says they are done.",
    inputSchema: {
      url: z.string().describe("Absolute URL, e.g. https://example.com/login"),
      reason: z.string().describe("Why human action is needed — shown to the user"),
    },
  },
  async ({ url, reason }) => {
    const page = await activePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return ok(
      `Page opened in the shared browser window at ${url} (reason: ${reason}). ` +
        `The keyboard is now the user's — ask them to complete the action there. ` +
        `Do NOT close the window and do NOT take further browser actions until the user says they are done; ` +
        `then simply continue with normal browser tools in the same window.`,
    );
  },
);

server.registerTool(
  "browser_navigate",
  {
    description:
      "Open a URL in the active tab. Returns a page snapshot after load.",
    inputSchema: { url: z.string().describe("Absolute URL, e.g. https://example.com") },
  },
  async ({ url }) => {
    const page = await activePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    // New document: every cached path refers to a tree that no longer exists.
    clearBaseline();
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Read the current page as an ARIA (role+name) tree — the primary way to see the page. " +
      "Use offset to paginate long pages, and scope to read only one subtree (e.g. the open dialog) " +
      "instead of the whole page.",
    inputSchema: {
      offset: z.number().int().min(0).optional().describe("Character offset for pagination"),
      scope: z
        .string()
        .optional()
        .describe(
          "CSS selector to root this snapshot at, e.g. 'div[role=\"dialog\"]'. " +
            "Overrides the session default from browser_set_snapshot_scope for this call only; " +
            "pass 'body' to force a full page read. Falls back to the full page if it matches nothing.",
        ),
      full: z
        .boolean()
        .optional()
        .describe(
          "Escape hatch: ignore the session scope and read the entire page. " +
            "Leaves the browser_diff baseline untouched, so it does not disturb an " +
            "in-progress verification.",
        ),
    },
  },
  async ({ offset, scope, full }) => {
    const page = await activePage();
    if (full) {
      const snap = await snapshotPage(page, offset ?? 0, null);
      return ok(formatSnapshot(snap, offset ?? 0));
    }
    const snap = await snapshotPage(page, offset ?? 0, scope);
    // A plain snapshot is the agent saying "this is the state I now know about" —
    // exactly the baseline a later browser_diff should measure against.
    await rebaseline(page);
    return ok(formatSnapshot(snap, offset ?? 0));
  },
);

server.registerTool(
  "browser_diff",
  {
    description:
      "Verify that your last action actually did what you think — returns ONLY what changed " +
      "since the last browser_snapshot or browser_diff, then re-baselines. Use it after every " +
      "state-changing step you care about: tools report success on the call, not on the result, " +
      "so a fill that appended instead of replacing, or a clear that did not clear, both look " +
      "like success until you diff. Reports added / removed / changed nodes (changed says " +
      "whether name, value or state moved). 'no changes' means your action had NO EFFECT — " +
      "it is the most important answer this tool gives. Nodes are paired by position, so " +
      "duplicate names (three buttons all called 'Ant Group') are still told apart. " +
      "Respects the snapshot scope. Falls back to a full snapshot when there is no usable " +
      "baseline or the diff is not smaller than the snapshot.",
    inputSchema: {},
  },
  async () => {
    const page = await activePage();
    const scope = getSnapshotScope();
    const url = page.url();

    const { nodes, scopeMissed } = await captureNodes(page, scope);
    const before = getBaseline();
    const mismatch = baselineMismatch(before, url, scope, scopeMissed);
    if (mismatch) {
      const snap = await snapshotPage(page);
      setBaseline({ url, scope, scopeMissed, capturedAt: Date.now(), nodes });
      return ok(
        `${mismatch} — returned full snapshot, baseline set. Diffs work from here on.\n` +
          formatSnapshot(snap),
      );
    }

    const diff = diffNodes(before!.nodes, nodes);
    setBaseline({ url, scope, scopeMissed, capturedAt: Date.now(), nodes });

    if (isEmptyDiff(diff)) return ok(formatDiff(diff));

    const rendered = formatDiff(diff);
    const snap = await snapshotPage(page);
    const full = formatSnapshot(snap);
    if (rendered.length > full.length * DIFF_TOO_LARGE_RATIO) {
      return ok(`diff too large, returned full snapshot\n${full}`);
    }
    return ok(scopeMissed ? `scope missed, full page\n${rendered}` : rendered);
  },
);

server.registerTool(
  "browser_set_snapshot_scope",
  {
    description:
      "Set a session-wide snapshot scope (CSS selector): every tool that returns a snapshot " +
      "(navigate/click/press/select/snapshot/back) then returns only that subtree. Use it when " +
      "working inside a dialog or form on a large page — a full LinkedIn page is 12k-30k chars, " +
      "the dialog is under 2k. Call with no argument to clear it. If the selector stops matching " +
      "(dialog closed), snapshots fall back to the full page and say 'scope missed, full page'.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          "CSS selector, e.g. 'div[role=\"dialog\"]'. Omit or pass an empty string to clear the scope.",
        ),
    },
  },
  async ({ scope }) => {
    setSnapshotScope(scope ?? null);
    const active = getSnapshotScope();
    if (!active) return ok("Snapshot scope cleared — snapshots now return the full page.");
    // Report whether it matches right now, so a typo surfaces here and not as a
    // confusing "scope missed" on the next unrelated tool call.
    const page = await activePage();
    const snap = await snapshotPage(page);
    return ok(
      snap.scopeMissed
        ? `Snapshot scope set to '${active}', but it matches nothing on the current page right now — ` +
            `snapshots will return the full page until it appears.`
        : `Snapshot scope set to '${active}' — snapshots now return ${snap.totalChars} chars instead of the full page.`,
    );
  },
);

server.registerTool(
  "browser_click",
  {
    description:
      "Click an element identified by ARIA role+name (preferred, from the snapshot) or a raw selector. Returns a fresh snapshot.",
    inputSchema: targetShape,
  },
  async (args) => {
    const page = await activePage();
    const target = resolveTarget(page, args);
    try {
      await target.click({ timeout: 8_000 });
    } catch (e) {
      return fail(
        `Click failed: ${(e as Error).message.split("\n")[0]}\nTip: take a browser_snapshot and retry with an exact role+name from it.`,
      );
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

server.registerTool(
  "browser_fill",
  {
    description:
      "Fill a text input (clears it first). Identify it by role+name or selector. Does NOT submit — use browser_press with 'Enter' or click a button explicitly.",
    inputSchema: { ...targetShape, text: z.string().describe("Text to fill") },
  },
  async (args) => {
    const page = await activePage();
    const target = resolveTarget(page, args);
    try {
      await target.fill(args.text, { timeout: 8_000 });
    } catch (e) {
      return fail(`Fill failed: ${(e as Error).message.split("\n")[0]}`);
    }
    return ok(`Filled. Current value set on target. Not submitted.`);
  },
);

interface SelectOptionInfo {
  label: string;
  value: string;
}

/**
 * Pick an <option> for a human-supplied string. Visible text wins over the
 * value attribute (that is what the agent read in the snapshot), and a unique
 * prefix is accepted last so "Jan" can hit "January" without guessing.
 */
function matchOption(
  options: SelectOptionInfo[],
  wanted: string,
): { hit: SelectOptionInfo } | { ambiguous: SelectOptionInfo[] } | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const w = norm(wanted);
  const byLabelExact = options.find((o) => o.label === wanted);
  if (byLabelExact) return { hit: byLabelExact };
  const byLabel = options.find((o) => norm(o.label) === w);
  if (byLabel) return { hit: byLabel };
  const byValue = options.find((o) => o.value === wanted) ?? options.find((o) => norm(o.value) === w);
  if (byValue) return { hit: byValue };
  const prefix = options.filter((o) => norm(o.label).startsWith(w) && w.length > 0);
  if (prefix.length === 1) return { hit: prefix[0] };
  if (prefix.length > 1) return { ambiguous: prefix };
  return null;
}

server.registerTool(
  "browser_select",
  {
    description:
      "Choose an option in a NATIVE <select> dropdown — the one control browser_fill and " +
      "browser_click cannot touch (fill rejects it as not-an-input; the options are not in a " +
      "clickable DOM layer). Identify the select by role+name (a <select> has ARIA role " +
      "'combobox') or a raw selector, and give the option's visible text. " +
      "NOT for typeahead/autocomplete comboboxes that render their own listbox " +
      "(LinkedIn's company/location fields): for those keep using browser_fill then " +
      "browser_press 'ArrowDown' and 'Enter'. Returns a fresh snapshot.",
    inputSchema: {
      ...targetShape,
      value: z
        .string()
        .describe(
          "The option's visible text (preferred, e.g. 'Full-time'); its value attribute also works. " +
            "A unique prefix is accepted, so 'Jan' matches 'January'.",
        ),
    },
  },
  async (args) => {
    const page = await activePage();
    const target = resolveTarget(page, args);

    let info: { tag: string; role: string | null; options: SelectOptionInfo[] };
    try {
      info = await target.evaluate(
        (el) => {
          const tag = el.tagName.toLowerCase();
          const sel = el as unknown as HTMLSelectElement;
          return {
            tag,
            role: el.getAttribute("role"),
            options:
              tag === "select"
                ? Array.from(sel.options).map((o) => ({
                    label: (o.label || o.textContent || "").trim(),
                    value: o.value,
                  }))
                : [],
          };
        },
        undefined,
        { timeout: 8_000 },
      );
    } catch (e) {
      return fail(
        `Could not resolve the target: ${(e as Error).message.split("\n")[0]}\n` +
          `Tip: take a browser_snapshot and retry with an exact role+name from it.`,
      );
    }

    if (info.tag !== "select") {
      return fail(
        `Target is <${info.tag}>${info.role ? ` role="${info.role}"` : ""}, not a native <select>, ` +
          `so browser_select does not apply.\n` +
          `- Text input or contenteditable → use browser_fill.\n` +
          `- Custom dropdown / typeahead listbox (LinkedIn company, location) → browser_fill the text, ` +
          `then browser_press 'ArrowDown' and 'Enter'.\n` +
          `- Button, checkbox, radio, or an option in an already-open custom menu → browser_click.`,
      );
    }

    const match = matchOption(info.options, args.value);
    const listed = info.options
      .map((o) => (o.label === o.value ? `'${o.label}'` : `'${o.label}' (value='${o.value}')`))
      .join(", ");
    if (!match) {
      return fail(`No option matches '${args.value}'. Available options: ${listed || "(none)"}`);
    }
    if ("ambiguous" in match) {
      return fail(
        `'${args.value}' is ambiguous — it prefixes ${match.ambiguous
          .map((o) => `'${o.label}'`)
          .join(", ")}. Pass the full option text.`,
      );
    }

    try {
      // selectOption fires `input` and `change` natively (that is the whole
      // point of using it over setting .value), so frameworks bound to the
      // select see the update — no manual dispatch needed.
      await target.selectOption({ value: match.hit.value }, { timeout: 8_000 });
    } catch (e) {
      return fail(
        `Select failed: ${(e as Error).message.split("\n")[0]}\n` +
          `The <select> may be hidden or covered by an overlay — check with browser_screenshot.`,
      );
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const snap = await snapshotPage(page);
    return ok(`selected: '${match.hit.label}' (value='${match.hit.value}')\n${formatSnapshot(snap)}`);
  },
);

server.registerTool(
  "browser_upload_file",
  {
    description:
      "Attach a local file to a file input — the Resume field on an application form, a " +
      "portfolio, a cover letter. Targets the <input type=file> itself via setInputFiles; it " +
      "never clicks the visible button, because that opens the OS file dialog, which is outside " +
      "the page and cannot be driven. This also handles the common case where the input is " +
      "hidden behind a styled 'Choose file' label or drag-and-drop zone (a display:none input " +
      "does not even appear in the snapshot): point role+name or selector at the visible " +
      "label/button/dropzone and the associated input is found from it. Returns the file names " +
      "the page now holds, plus a snapshot so you can confirm they are shown.",
    inputSchema: {
      ...targetShape,
      path: z.string().optional().describe("Absolute path to the file to attach"),
      paths: z
        .array(z.string())
        .optional()
        .describe("Several files at once, for inputs that accept multiple (resume + portfolio)"),
    },
  },
  async (args) => {
    const requested = args.paths?.length ? args.paths : args.path ? [args.path] : [];
    if (requested.length === 0) return fail("Provide `path` or a non-empty `paths` array.");

    // Validate before touching the page: a missing file must be a loud error,
    // never a silently empty upload that looks like it worked.
    const resolved = requested.map((p) => path.resolve(p));
    const missing = resolved.filter((p) => !fs.existsSync(p));
    if (missing.length) {
      return fail(
        `File(s) not found:\n${missing.map((p) => `  ${p}`).join("\n")}\n` +
          `Paths are resolved from the server's working directory (${process.cwd()}); ` +
          `pass absolute paths to be safe.`,
      );
    }
    const notFiles = resolved.filter((p) => !fs.statSync(p).isFile());
    if (notFiles.length) return fail(`Not a file: ${notFiles.join(", ")}`);

    const page = await activePage();
    const target = resolveTarget(page, args);
    let handle;
    try {
      // Flat on purpose: no nested named functions, so esbuild's keep-names
      // transform has nothing to rewrite (see pagefn.ts) and this can return a
      // live element handle, which evalInPage's JSON round-trip cannot.
      handle = await target.evaluateHandle((el) => {
        if (el instanceof HTMLInputElement && el.type === "file") return el;
        const forId = el.getAttribute("for");
        if (forId) {
          const byFor = document.getElementById(forId);
          if (byFor instanceof HTMLInputElement && byFor.type === "file") return byFor;
        }
        // A text box, textarea or select is never a stand-in for an upload
        // field. Without this, the search below climbs to the <form> and
        // happily attaches the file to an unrelated input — a silent wrong
        // result, which is worse than refusing.
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          return null;
        }
        const inside = el.querySelectorAll('input[type="file"]');
        if (inside.length === 1) return inside[0];
        if (inside.length > 1) return null;
        const label = el.closest("label");
        if (label) {
          const lf = label.getAttribute("for");
          if (lf) {
            const t = document.getElementById(lf);
            if (t instanceof HTMLInputElement && t.type === "file") return t;
          }
          const within = label.querySelectorAll('input[type="file"]');
          if (within.length === 1) return within[0];
        }
        // Styled drop zones keep the real input as a nearby sibling, so walk up
        // a little — but stop at the form/section boundary, because "some file
        // input somewhere on this form" is a guess, not a match. Only an
        // unambiguous single candidate counts.
        let cur: Element | null = el.parentElement;
        for (let i = 0; i < 3 && cur; i++) {
          const tag = cur.tagName;
          if (tag === "FORM" || tag === "BODY" || tag === "HTML" || tag === "MAIN") break;
          const found = cur.querySelectorAll('input[type="file"]');
          if (found.length === 1) return found[0];
          if (found.length > 1) return null;
          cur = cur.parentElement;
        }
        return null;
      });
    } catch (e) {
      return fail(
        `Could not resolve the target: ${(e as Error).message.split("\n")[0]}\n` +
          `Tip: take a browser_snapshot and target the visible label or button near the field ` +
          `(a hidden file input is not in the snapshot at all).`,
      );
    }

    const input = handle.asElement();
    if (!input) {
      // Only on the failure path: work out WHY, so the message is actionable
      // rather than "did not work".
      const why = await target
        .evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          nearby: el.parentElement
            ? el.parentElement.querySelectorAll('input[type="file"]').length
            : 0,
          onPage: document.querySelectorAll('input[type="file"]').length,
        }))
        .catch(() => null);
      const detail = !why
        ? ""
        : why.nearby > 1
          ? `\nThere are ${why.nearby} file inputs next to this element, so the right one is ambiguous — ` +
            `pass a selector for the exact input.`
          : why.tag === "input" || why.tag === "textarea" || why.tag === "select"
            ? `\nYou targeted a <${why.tag}>, which is a different field. The page has ${why.onPage} ` +
              `file input(s); target the label, button or drop zone belonging to the upload field.`
            : `\nThe page has ${why.onPage} file input(s) in total.`;
      return fail(
        `Found the element, but no <input type="file"> is associated with it.${detail}\n` +
          `Note that a visible file input appears in the snapshot as a BUTTON, not a textbox, and a ` +
          `hidden one does not appear at all — target its label or drop zone, or pass a selector ` +
          `such as 'input[type=file]'.`,
      );
    }
    try {
      await input.setInputFiles(resolved);
    } catch (e) {
      return fail(`Upload failed: ${(e as Error).message.split("\n")[0]}`);
    }

    // Read back what the input actually holds — the same reason browser_diff
    // exists: a call that returned is not proof of a result.
    const attached = await input
      .evaluate((el) =>
        Array.from((el as HTMLInputElement).files ?? []).map((f) => `${f.name} (${f.size} bytes)`),
      )
      .catch(() => [] as string[]);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    return ok(
      `attached ${attached.length} file(s): ${attached.join(", ") || "(input reports none — check the page)"}\n` +
        formatSnapshot(await snapshotPage(page)),
    );
  },
);

/** One line per tab, marking the one every tool currently acts on. */
async function tabLines(): Promise<string> {
  const pages = await listPages();
  const lines = await Promise.all(
    pages.map(async (p, i) => {
      const title = await p.title().catch(() => "?");
      return `${isSelected(p) ? "*" : " "} ${i}: ${title} — ${p.url()}`;
    }),
  );
  const active = await activePage();
  const idx = pages.indexOf(active);
  return (
    `${lines.join("\n") || "(no tabs)"}\n` +
    (pages.some((p) => isSelected(p))
      ? `* = active tab (explicitly selected); all tools act on it until you call browser_select_tab again.`
      : `No tab explicitly selected — tools default to the last one (index ${idx}). ` +
        `Call browser_select_tab to pin one.`)
  );
}

server.registerTool(
  "browser_select_tab",
  {
    description:
      "Choose which tab every other tool acts on, and bring it to the front. Essential when the " +
      "user has their own tabs open: without it the tools fall back to 'the last tab' and a form " +
      "sitting in tab 0 is unreachable. Do NOT re-navigate to a form's URL to reach it — that " +
      "reloads the page and discards everything already filled in. Identify the tab by index " +
      "(from browser_tabs), or by a url/title pattern. Selection sticks until changed.",
    inputSchema: {
      index: z.number().int().min(0).optional().describe("Tab index from browser_tabs"),
      urlPattern: z
        .string()
        .optional()
        .describe("Case-insensitive regex (a plain substring works too) matched against the URL"),
      titlePattern: z
        .string()
        .optional()
        .describe("Case-insensitive regex (a plain substring works too) matched against the title"),
    },
  },
  async ({ index, urlPattern, titlePattern }) => {
    const pages = await listPages();
    if (pages.length === 0) return fail("No open tabs.");

    let candidates = pages;
    if (index !== undefined) {
      if (index >= pages.length) {
        return fail(`No tab at index ${index}. Open tabs:\n${await tabLines()}`);
      }
      candidates = [pages[index]];
    } else if (urlPattern || titlePattern) {
      const re = (p: string) => {
        try {
          return new RegExp(p, "i");
        } catch {
          return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
      };
      const withMeta = await Promise.all(
        pages.map(async (p) => ({ page: p, title: await p.title().catch(() => ""), url: p.url() })),
      );
      candidates = withMeta
        .filter(
          (m) =>
            (!urlPattern || re(urlPattern).test(m.url)) &&
            (!titlePattern || re(titlePattern).test(m.title)),
        )
        .map((m) => m.page);
    } else {
      return fail("Provide index, urlPattern or titlePattern.");
    }

    if (candidates.length === 0) {
      return fail(`No tab matches. Open tabs:\n${await tabLines()}`);
    }
    if (candidates.length > 1) {
      return fail(
        `${candidates.length} tabs match — pass an index instead. Open tabs:\n${await tabLines()}`,
      );
    }
    await selectPage(candidates[0]);
    // Paths and the diff baseline belong to the old document.
    clearBaseline();
    const page = await activePage();
    return ok(
      `Active tab is now ${pages.indexOf(page)}: ${await page.title().catch(() => "?")} — ${page.url()}\n` +
        `${await tabLines()}\n---\n${formatSnapshot(await snapshotPage(page))}`,
    );
  },
);

server.registerTool(
  "browser_new_tab",
  {
    description:
      "Open a new tab and make it the active one. Use this instead of navigating the current tab " +
      "when the current tab holds work you must not lose, such as a partly filled form.",
    inputSchema: {
      url: z.string().optional().describe("Absolute URL to open; omit for a blank tab"),
    },
  },
  async ({ url }) => {
    const ctx = await getContext();
    const page = await ctx.newPage();
    await selectPage(page);
    clearBaseline();
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    }
    return ok(`Opened and selected a new tab.\n${await tabLines()}\n---\n${formatSnapshot(await snapshotPage(page))}`);
  },
);

server.registerTool(
  "browser_close_tab",
  {
    description:
      "Close a tab by index. Closing the active tab drops the selection, and tools fall back to " +
      "the last remaining tab until you select one again.",
    inputSchema: { index: z.number().int().min(0).describe("Tab index from browser_tabs") },
  },
  async ({ index }) => {
    const pages = await listPages();
    if (index >= pages.length) {
      return fail(`No tab at index ${index}. Open tabs:\n${await tabLines()}`);
    }
    const victim = pages[index];
    const wasActive = isSelected(victim);
    const label = `${await victim.title().catch(() => "?")} — ${victim.url()}`;
    await victim.close();
    if (wasActive) clearSelection();
    clearBaseline();
    return ok(`Closed tab ${index}: ${label}\n${await tabLines()}`);
  },
);

server.registerTool(
  "browser_scroll",
  {
    description:
      "Scroll a container to load lazily rendered content. Use this whenever a snapshot shows " +
      "nodes marked [not rendered]: those rows exist but their content has not loaded, and the " +
      "tree LOOKS complete without them — a list that ends early is the failure this prevents. " +
      "Do NOT use browser_press('End') for this; it acts on whatever has focus and only works by " +
      "accident. Scrolls in `steps` increments with a pause between them, because jumping " +
      "straight to the bottom often loads nothing (an IntersectionObserver that never observes " +
      "an intersection never fires). Waits for content to settle, then returns a fresh snapshot. " +
      "The report says whether the content height grew — if it did not and you are at the " +
      "bottom, the list really has ended.",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector of the scrolling element, e.g. '.scaffold-layout__list'. Omit to auto-detect: " +
            "the page itself when it scrolls, otherwise the largest inner scroller. Many apps " +
            "(LinkedIn included) scroll an inner element rather than the window, so pass this when " +
            "auto-detection scrolls the wrong thing.",
        ),
      to: z
        .union([z.enum(["top", "bottom"]), z.number()])
        .default("bottom")
        .describe("'bottom', 'top', or an absolute scrollTop in pixels"),
      steps: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Split the travel into this many increments, pausing between each to let content render"),
    },
  },
  async ({ selector, to, steps }) => {
    const page = await activePage();
    const outcome = await scrollContainer(page, selector ?? null, to, steps);
    if (!outcome) {
      return fail(
        `No element matches selector '${selector}'. Take a browser_snapshot to check the page, ` +
          `or omit selector to auto-detect the scrolling container.`,
      );
    }
    const snap = await snapshotPage(page);
    return ok(`${formatScroll(outcome)}\n---\n${formatSnapshot(snap)}`);
  },
);

server.registerTool(
  "browser_scroll_into_view",
  {
    description:
      "Scroll a specific element into view, by ARIA role+name or selector — for reaching a known " +
      "target (a 'Next' button below the fold, a row near the end of a long list) rather than " +
      "sweeping a container. Waits for content to settle and returns a fresh snapshot.",
    inputSchema: targetShape,
  },
  async (args) => {
    const page = await activePage();
    const target = resolveTarget(page, args);
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 8_000 });
    } catch (e) {
      return fail(
        `Could not scroll to it: ${(e as Error).message.split("\n")[0]}\n` +
          `If the element is inside a lazily rendered list it may not exist yet — ` +
          `browser_scroll the container first, then retry.`,
      );
    }
    await waitForContentSettled(page, null);
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

server.registerTool(
  "browser_press",
  {
    description: "Press a keyboard key on the focused element, e.g. 'Enter', 'Escape', 'ArrowDown'.",
    inputSchema: { key: z.string() },
  },
  async ({ key }) => {
    const page = await activePage();
    await page.keyboard.press(key);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

server.registerTool(
  "browser_screenshot",
  {
    description:
      "Take a screenshot of the current viewport — the fallback sense when the ARIA snapshot is confusing (canvas-heavy or oddly structured pages).",
    inputSchema: {},
  },
  async () => {
    const page = await activePage();
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    return {
      content: [
        {
          type: "image" as const,
          data: buf.toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
    };
  },
);

server.registerTool(
  "browser_tabs",
  {
    description:
      "List open tabs (index, title, url), marking with '*' the one every tool currently acts " +
      "on. Use browser_select_tab to change it.",
    inputSchema: {},
  },
  async () => ok(await tabLines()),
);

server.registerTool(
  "browser_back",
  {
    description: "Go back in the active tab's history. Returns a snapshot.",
    inputSchema: {},
  },
  async () => {
    const page = await activePage();
    await page.goBack({ timeout: 15_000 }).catch(() => {});
    clearBaseline();
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logging (stdout is the MCP channel)
  console.error("[job-agent-mcp] ready on stdio");
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  console.error("[job-agent-mcp] fatal:", err);
  process.exit(1);
});
