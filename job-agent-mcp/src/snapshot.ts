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
 */
import type { Page } from "playwright";

const MAX_CHARS = 12_000;

export interface SnapshotResult {
  url: string;
  title: string;
  kind: "aria" | "text";
  truncated: boolean;
  totalChars: number;
  content: string;
}

export async function snapshotPage(page: Page, offset = 0): Promise<SnapshotResult> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  let kind: "aria" | "text" = "aria";
  let content = "";
  try {
    content = await page.locator("body").ariaSnapshot({ timeout: 5_000 });
  } catch {
    kind = "text";
    content = await page
      .locator("body")
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
  };
}

export function formatSnapshot(s: SnapshotResult, offset = 0): string {
  const header = [
    `url: ${s.url}`,
    `title: ${s.title}`,
    `format: ${s.kind}`,
    s.truncated
      ? `note: truncated at ${offset + s.content.length}/${s.totalChars} chars — call browser_snapshot with offset=${offset + s.content.length} for more`
      : `note: complete (${s.totalChars} chars)`,
  ].join("\n");
  return `${header}\n---\n${s.content}`;
}
