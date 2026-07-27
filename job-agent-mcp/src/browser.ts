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

/** The page the agent is currently working on = the most recently active tab. */
export async function activePage(): Promise<Page> {
  const ctx = await getContext();
  const pages = ctx.pages();
  if (pages.length === 0) {
    return await ctx.newPage();
  }
  return pages[pages.length - 1];
}

/**
 * Drop our CDP connection. NEVER kills the user's browser — for a
 * connectOverCDP browser, close() only terminates the connection.
 */
export async function closeBrowser(): Promise<void> {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  await ctx?.browser()?.close().catch(() => {});
}
