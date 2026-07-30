/**
 * Scrolling as a loading primitive.
 *
 * Lazy lists are the worst failure mode in this toolset because they do not
 * error. A LinkedIn search page holds 25 results but renders about 10; the rest
 * are empty <li> placeholders. The snapshot comes back well-formed and the
 * agent reads it as "the list ends here" — a complete-looking, incomplete
 * answer. Every other gap we have fixed announced itself with an exception.
 *
 * Two things make this work where `browser_press('End')` did not:
 *
 * - The scroll container is often NOT the window. LinkedIn scrolls an inner
 *   element, so keyboard End (which acts on whatever has focus) only worked by
 *   accident. We resolve a real element and set its scrollTop.
 * - Jumping straight to the bottom frequently loads nothing: an
 *   IntersectionObserver that never observes an intersection never fires. So
 *   the travel is split into steps with a render pause between them, and the
 *   target is recomputed each step because the content grows underneath us.
 *
 * All stepping happens inside one in-page async function: the element
 * reference then survives the whole sequence, which matters because lazy
 * loading mutates the DOM between steps and invalidates positional selectors.
 */
import type { Page } from "playwright";
import { evalInPage } from "./pagefn.js";

/** Pause after each step so IntersectionObserver callbacks can run and paint. */
const STEP_PAUSE_MS = 350;
/** Cap on the settle loop that waits for lazily inserted content to stop arriving. */
const SETTLE_TIMEOUT_MS = 4_000;
const SETTLE_POLL_MS = 150;

export interface ScrollOutcome {
  found: boolean;
  /** How the resolved container was identified, for the tool result. */
  container: string;
  from: number;
  to: number;
  clientHeight: number;
  /** Content height before and after — growth means rows were appended. */
  heightBefore: number;
  heightAfter: number;
  /**
   * Element count before and after. Needed alongside height because lazy lists
   * come in two shapes: appending new rows (height grows) and filling in
   * placeholder rows that already occupied their space (height does not).
   */
  nodesBefore: number;
  nodesAfter: number;
  atBottom: boolean;
}

interface ScrollArgs {
  selector: string | null;
  to: "top" | "bottom" | number;
  steps: number;
  pauseMs: number;
}

/**
 * In-page. Resolves the container, then walks to the target in `steps`
 * increments. Everything it needs is declared inside — see pagefn.ts.
 */
async function scrollInPage(args: ScrollArgs): Promise<ScrollOutcome | null> {
  const { selector, to, steps, pauseMs } = args;

  const describe = (el: Element): string => {
    if (el === document.scrollingElement || el === document.documentElement) return "page";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const scrollable = (el: Element): boolean => {
    const st = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(st.overflowY)) return false;
    return el.scrollHeight > el.clientHeight + 4;
  };

  let target: Element | null = null;
  if (selector) {
    target = document.querySelector(selector);
    if (!target) return null;
  } else {
    // Prefer the document when the page itself scrolls; otherwise take the
    // largest inner scroller, which is the shape app layouts use.
    const doc = (document.scrollingElement || document.documentElement) as Element;
    if (doc.scrollHeight > doc.clientHeight + 4) {
      target = doc;
    } else {
      let best: Element | null = null;
      let bestArea = 0;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!scrollable(el)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      target = best || doc;
    }
  }

  const el = target as HTMLElement;
  const from = el.scrollTop;
  const heightBefore = el.scrollHeight;
  const nodesBefore = el.querySelectorAll("*").length;
  const limit = (): number => Math.max(0, el.scrollHeight - el.clientHeight);
  const goal = (): number =>
    to === "top" ? 0 : to === "bottom" ? limit() : Math.max(0, Math.min(limit(), to as number));

  const n = Math.max(1, steps);
  for (let i = 1; i <= n; i++) {
    // Recomputed every step: lazy loading grows scrollHeight underneath us, so
    // a target captured up front would stop short of the real bottom.
    const step = from + (goal() - from) * (i / n);
    el.scrollTop = step;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  if (to === "bottom") {
    el.scrollTop = limit();
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  return {
    found: true,
    container: describe(el),
    from,
    to: el.scrollTop,
    clientHeight: el.clientHeight,
    heightBefore,
    heightAfter: el.scrollHeight,
    nodesBefore,
    nodesAfter: el.querySelectorAll("*").length,
    atBottom: el.scrollTop >= limit() - 2,
  };
}

/** In-page fingerprint of "how much content is here right now". */
function contentSignature(selector: string | null): { h: number; n: number } | null {
  const el = selector
    ? document.querySelector(selector)
    : (document.scrollingElement || document.body);
  if (!el) return null;
  return { h: el.scrollHeight, n: el.querySelectorAll("*").length };
}

/**
 * Wait until lazily inserted content stops arriving. Network idle alone is not
 * enough — rendering lands a frame or two after the response does.
 */
export async function waitForContentSettled(page: Page, selector: string | null): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = "";
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const sig = JSON.stringify(await evalInPage(page, contentSignature, selector).catch(() => null));
    if (sig === last) {
      if (++stableRounds >= 2) return;
    } else {
      stableRounds = 0;
      last = sig;
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
}

export async function scrollContainer(
  page: Page,
  selector: string | null,
  to: "top" | "bottom" | number,
  steps: number,
): Promise<ScrollOutcome | null> {
  const outcome = await evalInPage(page, scrollInPage, {
    selector,
    to,
    steps,
    pauseMs: STEP_PAUSE_MS,
  });
  if (!outcome) return null;
  await waitForContentSettled(page, selector);
  return outcome;
}

export function formatScroll(o: ScrollOutcome): string {
  const grewPx = o.heightAfter - o.heightBefore;
  const grewNodes = o.nodesAfter - o.nodesBefore;
  const loaded = grewPx > 0 || grewNodes > 0;
  const detail = loaded
    ? `loaded: yes (${grewNodes > 0 ? `+${grewNodes} elements` : "no new elements"}, ` +
      `${grewPx > 0 ? `+${grewPx}px` : "same height"})`
    : `loaded: nothing new${
        o.atBottom ? " — at the bottom with no growth, so this really is the end of the list" : ""
      }`;
  return [
    `container: ${o.container}`,
    `scrollTop: ${Math.round(o.from)} → ${Math.round(o.to)} (viewport ${o.clientHeight}px, content ${o.heightAfter}px)`,
    detail,
    o.atBottom ? "position: at bottom" : "position: more to scroll",
  ].join("\n");
}
