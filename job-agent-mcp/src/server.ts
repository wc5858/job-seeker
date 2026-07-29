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
import { activePage, getContext, closeBrowser } from "./browser.js";
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
    description: "List open tabs (index, title, url). The last tab is the active one for tools.",
    inputSchema: {},
  },
  async () => {
    const ctx = await getContext();
    const lines = await Promise.all(
      ctx.pages().map(async (p, i) => `${i}: ${await p.title().catch(() => "?")} — ${p.url()}`),
    );
    return ok(lines.join("\n") || "(no tabs)");
  },
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
