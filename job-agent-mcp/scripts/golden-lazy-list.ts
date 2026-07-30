/**
 * Golden set: "LinkedIn search results", i.e. the lazy list.
 *
 * The failure this pins down is the nastiest one in the toolset because it does
 * not raise: a search page holds 25 results but renders about 10, the rest being
 * empty <li> placeholders. The ARIA snapshot comes back perfectly well-formed
 * and an agent reads it as "the list ends here". Every other gap we closed
 * announced itself with an exception; this one returns a complete-looking,
 * incomplete answer.
 *
 * The fixture reproduces the three properties that made the real page hard:
 *
 *   1. the scroll container is NOT the window — the page scrolls too, so
 *      auto-detection picks the document and gets nowhere;
 *   2. rows are filled by an IntersectionObserver, so jumping straight to the
 *      bottom loads only what lands in view and silently skips the middle;
 *   3. placeholders occupy their final height, so "did the content grow?"
 *      cannot be answered by scrollHeight alone.
 *
 * Driven through the real MCP server over stdio.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOTAL = 25;
const PRERENDERED = 10;

// ---------------------------------------------------------------- fixture ---

const rows = Array.from({ length: TOTAL }, (_, i) =>
  i < PRERENDERED
    ? `<li data-i="${i}" data-filled="1"><a href="/job/${i}">Job ${i} — Senior Engineer</a><p>Company ${i}</p></li>`
    : `<li data-i="${i}"></li>`,
).join("");

const SCRIPT = `
var list = document.querySelector('.scaffold-layout__list');
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    if (!e.isIntersecting) return;
    var li = e.target;
    if (li.dataset.filled) return;
    li.dataset.filled = '1';
    li.innerHTML = '<a href="/job/' + li.dataset.i + '">Job ' + li.dataset.i +
      ' — Senior Engineer</a><p>Company ' + li.dataset.i + '</p>';
    io.unobserve(li);
  });
}, { root: list, threshold: 0.1 });
document.querySelectorAll('#results li').forEach(function (li) {
  if (!li.dataset.filled) io.observe(li);
});`;

const PAGE = `<!doctype html><html><head><title>Jobs | LinkedIn</title><style>
  .scaffold-layout__list { height: 300px; overflow-y: auto; border: 1px solid #ccc; }
  #results { margin: 0; padding: 0; }
  #results li { min-height: 60px; list-style: none; }
  /* Makes the DOCUMENT scroll as well, so auto-detection finds the page and
     not the list — exactly why browser_scroll takes a selector. */
  .page-filler { height: 1800px; }
</style></head><body>
<header><h1>Search results</h1><p>${TOTAL} results</p></header>
<div class="scaffold-layout__list"><ul id="results">${rows}</ul></div>
<div class="page-filler">Sponsored content and People you may know live down here.</div>
<script>${SCRIPT}</script>
</body></html>`;

// ------------------------------------------------------------------ harness ---

const site = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(PAGE);
});
await new Promise<void>((r) => site.listen(0, r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  stderr: "inherit",
  env: {
    ...process.env,
    JOB_AGENT_CDP: process.env.JOB_AGENT_CDP ?? "9341",
    JOB_AGENT_PROFILE:
      process.env.JOB_AGENT_PROFILE ?? path.join(os.tmpdir(), "ja-profile-lazy"),
    JOB_AGENT_SPAWN_ARGS: process.env.JOB_AGENT_SPAWN_ARGS ?? "--headless=new",
  },
});
const client = new Client({ name: "golden-lazy-list", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail.replace(/\n/g, "\n       ")}` : ""}`);
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  return { text, isError: res.isError === true, chars: text.length };
}

// Anchored to end-of-line so it counts tree nodes only: the header warning
// mentions "[not rendered]" too, mid-sentence.
const countUnrendered = (t: string) => (t.match(/\[not rendered\]$/gm) ?? []).length;
const countJobs = (t: string) => (t.match(/link "Job \d+ — Senior Engineer"/g) ?? []).length;

const LIST = ".scaffold-layout__list";

// ------------------------------------------------------------------- flow ---

console.log("\n== 1. the silent failure: a complete-looking, incomplete list ==");
const first = await call("browser_navigate", { url: base });
check(
  `${PRERENDERED} of ${TOTAL} rows have content (got ${countJobs(first.text)})`,
  countJobs(first.text) === PRERENDERED,
  first.text.slice(0, 400),
);
check(
  `the other ${TOTAL - PRERENDERED} are marked [not rendered] (got ${countUnrendered(first.text)})`,
  countUnrendered(first.text) === TOTAL - PRERENDERED,
  first.text.slice(0, 800),
);
check(
  "the header warns the list is unfinished",
  first.text.includes("incomplete:") && first.text.includes("browser_scroll"),
  first.text.split("---")[0],
);

console.log("\n== 2. auto-detect scrolls the PAGE, which is not the list ==");
const pageScroll = await call("browser_scroll", { to: "bottom" });
check("auto-detected container is the page", pageScroll.text.includes("container: page"), pageScroll.text.slice(0, 300));
check(
  `scrolling the page loads none of the list — this is why \`selector\` exists ` +
    `(still ${countUnrendered(pageScroll.text)} unrendered)`,
  countUnrendered(pageScroll.text) === TOTAL - PRERENDERED,
  pageScroll.text.slice(0, 300),
);

console.log("\n== 3. one-shot jump misses the middle (IntersectionObserver never fires) ==");
await call("browser_navigate", { url: base });
const oneShot = await call("browser_scroll", { selector: LIST, to: "bottom", steps: 1 });
check(`targets the inner container`, oneShot.text.includes("container: div.scaffold-layout__list"), oneShot.text.slice(0, 200));
check("reaches the bottom", oneShot.text.includes("position: at bottom"), oneShot.text.slice(0, 300));
const missedByOneShot = countUnrendered(oneShot.text);
check(
  `still leaves rows unrendered in the middle (got ${missedByOneShot})`,
  missedByOneShot > 0,
  "a single jump loaded everything — the fixture no longer models lazy loading",
);

console.log("\n== 4. stepped scroll loads the whole list ==");
await call("browser_navigate", { url: base });
const stepped = await call("browser_scroll", { selector: LIST, to: "bottom", steps: 5 });
check(
  `all ${TOTAL} rows rendered (got ${countJobs(stepped.text)})`,
  countJobs(stepped.text) === TOTAL,
  stepped.text.slice(0, 600),
);
check(`no [not rendered] left (got ${countUnrendered(stepped.text)})`, countUnrendered(stepped.text) === 0);
check("the 'incomplete' warning is gone", !stepped.text.includes("incomplete:"), stepped.text.split("---")[0]);
check(
  "stepping beat the one-shot jump",
  missedByOneShot > countUnrendered(stepped.text),
  `one-shot left ${missedByOneShot}, stepped left ${countUnrendered(stepped.text)}`,
);
check(
  "the report says content loaded",
  /loaded: yes/.test(stepped.text),
  stepped.text.slice(0, 300),
);

console.log("\n== 5. scrolling an already-complete list says so ==");
const again = await call("browser_scroll", { selector: LIST, to: "bottom", steps: 3 });
check(
  "reports nothing new and that this is the end",
  again.text.includes("loaded: nothing new") && again.text.includes("really is the end"),
  again.text.slice(0, 300),
);

console.log("\n== 6. browser_diff sees what the scroll loaded ==");
await call("browser_navigate", { url: base });
await call("browser_snapshot");
await call("browser_scroll", { selector: LIST, to: "bottom", steps: 5 });
const diff = await call("browser_diff");
const addedLinks = (diff.text.match(/^\+ .*link "Job \d+/gm) ?? []).length;
check(
  `diff attributes the new rows to the scroll (${addedLinks} added links, or a size fallback)`,
  addedLinks > 0 || diff.text.includes("diff too large"),
  diff.text.slice(0, 400),
);

console.log("\n== 7. to:'top' and numeric offsets ==");
const top = await call("browser_scroll", { selector: LIST, to: "top" });
check("scrolls back to the top", /scrollTop: \d+ → 0\b/.test(top.text), top.text.slice(0, 200));
const mid = await call("browser_scroll", { selector: LIST, to: 300, steps: 2 });
check("accepts an absolute scrollTop", /scrollTop: 0 → 300\b/.test(mid.text), mid.text.slice(0, 200));

console.log("\n== 8. browser_scroll_into_view reaches a known row ==");
const into = await call("browser_scroll_into_view", { role: "link", name: `Job ${TOTAL - 1} —` });
check("scrolls to the last row without error", !into.isError, into.text.slice(0, 300));
check("and it is in the returned snapshot", into.text.includes(`Job ${TOTAL - 1} — Senior Engineer`), into.text.slice(0, 300));

console.log("\n== 9. defaults: selector only, no `to` or `steps` ==");
await call("browser_navigate", { url: base });
const defaults = await call("browser_scroll", { selector: LIST });
check("defaults to scrolling to the bottom", defaults.text.includes("position: at bottom"), defaults.text.slice(0, 300));
check(
  `and defaults to enough steps to load the list (got ${countUnrendered(defaults.text)} unrendered)`,
  countUnrendered(defaults.text) === 0,
  defaults.text.slice(0, 300),
);

console.log("\n== 10. a selector that matches nothing fails loudly ==");
const bad = await call("browser_scroll", { selector: ".does-not-exist", to: "bottom" });
check("errors instead of silently scrolling the wrong thing", bad.isError, bad.text);
check("and suggests the fix", bad.text.includes("auto-detect"), bad.text);

// ----------------------------------------------------------------- verdict ---

await client.close();
site.close();

if (failures > 0) {
  console.error(`\nGOLDEN LAZY-LIST FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("\nGOLDEN LAZY-LIST OK");
process.exit(0);
