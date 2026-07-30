/**
 * Browser lifecycle — ATTACH-ONLY.
 *
 * The server always works by attaching (CDP) to a real, user-grade Chrome
 * process over the dedicated profile. If nothing is listening on the port,
 * it spawns that Chrome itself as a plain detached process and polls until
 * the port is up. Human and agent share the same browser window: login state
 * persists in the profile, the user can watch or take over at any time, and
 * the agent resumes in the same tabs afterwards.
 *
 * Headless environments (CI/tests): point CHROME_PATH at a Chromium binary
 * and set JOB_AGENT_SPAWN_ARGS="--headless=new,--no-sandbox".
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { spawnChrome } from "./chrome.js";

const CDP_PORT = process.env.JOB_AGENT_CDP ?? "9222";

let contextPromise: Promise<BrowserContext> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryConnect(endpoint: string) {
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: 3_000 });
  } catch {
    return null;
  }
}

async function attachOrSpawn(): Promise<BrowserContext> {
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  let browser = await tryConnect(endpoint);
  if (!browser) {
    const extra = process.env.JOB_AGENT_SPAWN_ARGS?.split(",").filter(Boolean) ?? [];
    spawnChrome("about:blank", [`--remote-debugging-port=${CDP_PORT}`, ...extra]);
    const deadline = Date.now() + 15_000;
    while (!browser && Date.now() < deadline) {
      await sleep(500);
      browser = await tryConnect(endpoint);
    }
    if (!browser) {
      throw new Error(
        `Could not attach to Chrome on port ${CDP_PORT} after spawning it. ` +
          `Most likely another Chrome window is already using this profile WITHOUT ` +
          `the debug port (the new process joined it and exited). Ask the user to close all ` +
          `windows of that profile, then retry — the browser will be respawned automatically.`,
      );
    }
  }
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("CDP attach: no browser context found");
  return ctx;
}

export async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = attachOrSpawn().catch((err) => {
      // Never cache a failed attach — these errors are temporal (profile busy,
      // browser starting up) and must be retryable on the next tool call.
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

/**
 * Explicitly selected tab, or null to fall back to the "last tab" heuristic.
 *
 * The heuristic alone was a real dead end: with the application form in tab 0
 * and the user's own LinkedIn in tab 1, every tool addressed the wrong tab and
 * the form was simply unreachable — re-navigating to it would have wiped the
 * answers already typed in. Selection is sticky on purpose: once set, every
 * tool works on that tab until it is changed or the tab closes.
 *
 * The fallback is kept for the unselected case so that a popup opened by the
 * site is still picked up automatically.
 */
let selectedPage: Page | null = null;

export async function listPages(): Promise<Page[]> {
  const ctx = await getContext();
  return ctx.pages().filter((p) => !p.isClosed());
}

/** The page every tool acts on. */
export async function activePage(): Promise<Page> {
  const pages = await listPages();
  if (selectedPage && !selectedPage.isClosed() && pages.includes(selectedPage)) {
    return selectedPage;
  }
  selectedPage = null; // it went away; drop the stale selection
  if (pages.length === 0) {
    const ctx = await getContext();
    return await ctx.newPage();
  }
  return pages[pages.length - 1];
}

/** Make `page` the active tab and bring it to the front of the shared window. */
export async function selectPage(page: Page): Promise<void> {
  selectedPage = page;
  await page.bringToFront().catch(() => {});
}

export function isSelected(page: Page): boolean {
  return selectedPage === page;
}

export function clearSelection(): void {
  selectedPage = null;
}

/**
 * Drop our CDP connection. NEVER kills the user's browser — for a
 * connectOverCDP browser, close() only terminates the connection.
 */
export async function closeBrowser(): Promise<void> {
  selectedPage = null;
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  await ctx?.browser()?.close().catch(() => {});
}
