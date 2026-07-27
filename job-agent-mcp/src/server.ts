/**
 * job-agent-mcp — browser tools as an MCP server (stdio).
 *
 * Tool design principles (the harness thinking):
 * - Atomic tools first (navigate/snapshot/click/fill/press/screenshot/tabs/back);
 *   domain tools (search_jobs etc.) get layered on top once flows stabilize.
 * - Perception: browser_snapshot returns the ARIA tree — cheap and precise.
 *   browser_screenshot is the fallback sense for weird pages.
 * - Targeting: click/fill accept EITHER {role, name} (preferred — matches what
 *   the snapshot shows) OR a raw Playwright {selector} as an escape hatch.
 * - Safety: this server only exposes in-page actions. Nothing here sends
 *   messages/applications autonomously; the human supervises the headed
 *   browser, and "send"-class domain tools will require explicit confirmation
 *   when they are added.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { activePage, getContext, closeBrowser } from "./browser.js";
import { snapshotPage, formatSnapshot } from "./snapshot.js";
import type { Page, Locator } from "playwright";

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
    return ok(formatSnapshot(await snapshotPage(page)));
  },
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Read the current page as an ARIA (role+name) tree — the primary way to see the page. Use offset to paginate long pages.",
    inputSchema: {
      offset: z.number().int().min(0).optional().describe("Character offset for pagination"),
    },
  },
  async ({ offset }) => {
    const page = await activePage();
    const snap = await snapshotPage(page, offset ?? 0);
    return ok(formatSnapshot(snap, offset ?? 0));
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
