/**
 * Chrome helpers: locate the installed Chrome and spawn it as a plain,
 * detached user process over the dedicated profile.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE_DIR =
  process.env.JOB_AGENT_PROFILE ?? path.join(os.homedir(), ".job-agent", "profile");

export function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `Chrome not found. Set CHROME_PATH to your Chrome executable. Tried:\n${candidates.join("\n")}`,
    );
  }
  return found;
}

/** Spawn a detached Chrome over the dedicated profile. Returns the binary used. */
export function spawnChrome(url: string, extraArgs: string[] = []): string {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const chrome = findChrome();
  spawn(chrome, [`--user-data-dir=${PROFILE_DIR}`, ...extraArgs, url], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return chrome;
}
