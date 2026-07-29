/**
 * Golden set: "LinkedIn Add experience".
 *
 * Distilled from a real LinkedIn form-automation run that exposed two holes —
 * native <select>s were unreachable by any tool, and every snapshot returned the
 * whole 12k-30k-char profile page when only the dialog mattered. The fixture is
 * a hermetic replica of that dialog, so the regression is testable offline:
 * it carries all three control types LinkedIn mixes in one form —
 *
 *   - native <select>      → browser_select                    (Employment type,
 *                                                               Start/End month
 *                                                               + year, Location
 *                                                               type)
 *   - typeahead listbox    → browser_fill + ArrowDown + Enter  (Company)
 *   - contenteditable      → browser_fill                      (Description)
 *
 * Budget assertion: with the scope set to the dialog, NO tool result in the
 * whole flow may exceed MAX_RESULT_CHARS.
 *
 * Runs the real MCP server over stdio, so tool descriptions, error strings and
 * snapshot formatting are all under test — not just the internals.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAX_RESULT_CHARS = 2_000;

// ---------------------------------------------------------------- fixture ---

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const YEARS = Array.from({ length: 101 }, (_, i) => String(2026 - i)); // 1926-2026
const COMPANIES = ["Anthropic", "Anthropic Labs", "Apple", "Amazon Web Services", "Google"];

const opts = (placeholder: string, values: string[]) =>
  `<option value="">${placeholder}</option>` +
  values.map((v) => `<option value="${v}">${v}</option>`).join("");

/** A profile page big enough that a full-page snapshot is the actual problem. */
const filler = Array.from(
  { length: 90 },
  (_, i) =>
    `<li><h3>Update ${i}: shipping browser tooling for agents</h3>` +
    `<a href="/post/${i}">Read post ${i} about automating web forms reliably</a>` +
    `<p>Reactions ${i * 7} &middot; Comments ${i}</p></li>`,
).join("");

const DIALOG = `
<div role="dialog" aria-label="Add experience">
  <h2>Add experience</h2>
  <label for="title">Title</label>
  <input id="title" type="text" />

  <label for="etype">Employment type</label>
  <select id="etype">${opts("Please select", [
    "Full-time", "Part-time", "Self-employed", "Freelance",
    "Contract", "Internship", "Apprenticeship", "Seasonal",
  ])}</select>

  <label for="company">Company or organization</label>
  <input id="company" type="text" role="combobox" aria-autocomplete="list"
         aria-expanded="false" aria-controls="company-list" autocomplete="off" />
  <ul id="company-list" role="listbox" aria-label="Company suggestions" hidden></ul>

  <!-- Three buttons with identical accessible names. Pairing diff nodes by
       role+name cannot tell them apart; pairing by path can. Straight from
       LinkedIn's company picker. -->
  <ul id="company-results">
    <li><button type="button" aria-pressed="false">Ant Group</button></li>
    <li><button type="button" aria-pressed="false">Ant Group</button></li>
    <li><button type="button" aria-pressed="false">Ant Group</button></li>
  </ul>

  <!-- Reproduces the observed LinkedIn headline bug: whatever you write, the
       field glues the previous text back on the front, so browser_fill reports
       success and silently produces "old textnew text". -->
  <label id="hl-label">Headline</label>
  <div id="headline" contenteditable="true" role="textbox"
       aria-labelledby="hl-label">Fullstack Engineer</div>

  <label for="smonth">Start month</label>
  <select id="smonth">${opts("Month", MONTHS)}</select>
  <label for="syear">Start year</label>
  <select id="syear">${opts("Year", YEARS)}</select>

  <label for="emonth">End month</label>
  <select id="emonth">${opts("Month", MONTHS)}</select>
  <label for="eyear">End year</label>
  <select id="eyear">${opts("Year", YEARS)}</select>

  <label for="ltype">Location type</label>
  <select id="ltype">${opts("Please select", ["On-site", "Hybrid", "Remote"])}</select>

  <!-- A list whose rows carry no accessible name of their own. Inserting into
       the MIDDLE of it is what used to renumber every following sibling and
       surface as a run of phantom "changed" entries. -->
  <label id="skills-label">Skills</label>
  <ul id="skills" aria-labelledby="skills-label">
    <li>TypeScript</li><li>Playwright</li><li>MCP</li>
  </ul>
  <button type="button" class="add-skill">Insert skill</button>

  <label id="desc-label">Description</label>
  <div id="desc" contenteditable="true" role="textbox" aria-labelledby="desc-label"></div>
  <!-- LinkedIn shows a live counter here; it is also the only way to read a
       contenteditable back, since the ARIA tree does not expose its text. -->
  <p id="desc-count">0/2,000 characters</p>

  <button type="button" class="save">Save</button>
</div>`;

// Page script: the dialog is created on demand (as LinkedIn does), so "scope
// matches nothing" is reachable, and the typeahead is real keyboard-driven.
const SCRIPT = `
var COMPANIES = ${JSON.stringify(COMPANIES)};
document.getElementById('add-exp').addEventListener('click', function () {
  if (document.querySelector('div[role=dialog]')) return;
  var host = document.createElement('div');
  host.innerHTML = document.getElementById('dialog-tpl').innerHTML;
  document.body.appendChild(host);
  wireTypeahead();
  var desc = document.getElementById('desc');
  desc.addEventListener('input', function () {
    document.getElementById('desc-count').textContent =
      desc.innerText.trim().length + '/2,000 characters';
  });
  var headline = document.getElementById('headline');
  var PREFIX = 'Fullstack Engineer';
  headline.addEventListener('input', function () {
    var cur = headline.innerText;
    if (cur.indexOf(PREFIX) !== 0) headline.innerText = PREFIX + cur;
  });
  var results = document.getElementById('company-results');
  results.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });
  document.querySelector('div[role=dialog] button.add-skill').addEventListener('click', function () {
    var ul = document.getElementById('skills');
    var li = document.createElement('li');
    li.textContent = 'Rust';
    ul.insertBefore(li, ul.children[1]);
  });
  document.querySelector('div[role=dialog] button.save').addEventListener('click', function () {
    document.querySelector('div[role=dialog]').remove();
  });
});
document.getElementById('inject-many').addEventListener('click', function () {
  var ul = document.getElementById('activity');
  for (var i = 0; i < 200; i++) {
    var li = document.createElement('li');
    li.innerHTML = '<h3>Injected ' + i + '</h3><a href="/x/' + i + '">Open injected item ' + i + '</a><p>meta ' + i + '</p>';
    ul.appendChild(li);
  }
});
function wireTypeahead() {
  var input = document.getElementById('company');
  var list = document.getElementById('company-list');
  var active = -1;
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var hits = q ? COMPANIES.filter(function (c) { return c.toLowerCase().indexOf(q) === 0; }) : [];
    list.innerHTML = '';
    active = -1;
    hits.forEach(function (c) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = c;
      li.addEventListener('mousedown', function () { commit(c); });
      list.appendChild(li);
    });
    list.hidden = hits.length === 0;
    input.setAttribute('aria-expanded', String(hits.length > 0));
  });
  input.addEventListener('keydown', function (e) {
    var items = list.querySelectorAll('[role=option]');
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = e.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      for (var i = 0; i < items.length; i++) {
        items[i].setAttribute('aria-selected', String(i === active));
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) commit(items[active].textContent);
    }
  });
  function commit(value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    list.innerHTML = '';
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('data-committed', value);
  }
}`;

const PAGE = `<!doctype html><html><head><title>Ada Lovelace | LinkedIn</title></head><body>
<header><h1>Ada Lovelace</h1><p>Building agents that use the web</p></header>
<nav><a href="/feed">Feed</a><a href="/jobs">Jobs</a><a href="/network">My Network</a></nav>
<main>
  <section><h2>Experience</h2><button id="add-exp" type="button">Add experience</button></section>
  <section><h2>Activity</h2>
    <button id="inject-many" type="button">Load 200 more</button>
    <ul id="activity">${filler}</ul>
  </section>
</main>
<template id="dialog-tpl">${DIALOG}</template>
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
    // Dedicated port + profile: the golden run must never fight the browser the
    // user is actually working in.
    JOB_AGENT_CDP: process.env.JOB_AGENT_CDP ?? "9334",
    JOB_AGENT_PROFILE:
      process.env.JOB_AGENT_PROFILE ?? path.join(os.tmpdir(), "ja-profile-golden"),
    JOB_AGENT_SPAWN_ARGS: process.env.JOB_AGENT_SPAWN_ARGS ?? "--headless=new",
  },
});
const client = new Client({ name: "golden-add-experience", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
let maxScopedChars = 0;
let scopeActive = false;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail.replace(/\n/g, "\n       ")}` : ""}`);
  }
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  if (scopeActive) maxScopedChars = Math.max(maxScopedChars, text.length);
  return { text, isError: res.isError === true, chars: text.length };
}

// ------------------------------------------------------- diff assertions ---

interface DiffLine {
  op: "+" | "-" | "~";
  path: string;
  role: string;
  name: string;
  /** For `~` lines: the post-change value of each field that moved. */
  to: Partial<Record<"name" | "value" | "state", string>>;
  raw: string;
}

interface ParsedDiff {
  noChanges: boolean;
  /** True when browser_diff bailed out to a full snapshot instead of a diff. */
  fellBack: boolean;
  lines: DiffLine[];
}

function parseDiff(text: string): ParsedDiff {
  const noChanges = text.startsWith("no changes");
  const fellBack =
    text.includes("returned full snapshot") || text.includes("baseline set. Diffs work from here");
  const lines: DiffLine[] = [];
  for (const raw of text.split("\n")) {
    const m = /^([+\-~]) \[([^\]]*)\] (\S+)(?: "([^"]*)")?/.exec(raw);
    if (!m) continue;
    const to: DiffLine["to"] = {};
    for (const f of raw.matchAll(/(name|value|state) "([^"]*)" → "([^"]*)"/g)) {
      to[f[1] as "name" | "value" | "state"] = f[3];
    }
    lines.push({ op: m[1] as "+" | "-" | "~", path: m[2], role: m[3], name: m[4] ?? "", to, raw });
  }
  return { noChanges, fellBack, lines };
}

interface Expectation {
  op: "+" | "-" | "~";
  role: string;
  name?: string;
  /** Exact post-change value. Deliberately exact: "contains" is what hid the append bug. */
  value?: string;
  state?: string;
}

/**
 * Run an action, then assert the DOM changed the way the step is supposed to.
 *
 *  - empty diff            → hard failure: the step silently did nothing
 *  - expectation unmet     → hard failure
 *  - changes beyond expect → flagged for manual confirmation, not failed:
 *                            the page structure may simply have moved on
 *
 * Returns the parsed diff so a test can make a meta-assertion about it.
 */
async function assertDiff(
  label: string,
  action: () => Promise<unknown>,
  expected: Expectation[],
  opts: { expectFailure?: boolean } = {},
): Promise<ParsedDiff> {
  await action();
  const res = await call("browser_diff");
  const parsed = parseDiff(res.text);
  const problems: string[] = [];

  if (parsed.noChanges) {
    problems.push("diff is empty — this step had NO EFFECT on the page");
  }
  const matched = new Set<DiffLine>();
  for (const e of expected) {
    const hit = parsed.lines.find(
      (l) =>
        l.op === e.op &&
        l.role === e.role &&
        (e.name === undefined || l.name === e.name) &&
        (e.value === undefined || l.to.value === e.value) &&
        (e.state === undefined || (l.to.state ?? "").includes(e.state)),
    );
    if (hit) matched.add(hit);
    else {
      problems.push(
        `no ${e.op} ${e.role}${e.name ? ` "${e.name}"` : ""}` +
          (e.value !== undefined ? ` with value exactly "${e.value}"` : "") +
          (e.state !== undefined ? ` with state containing "${e.state}"` : ""),
      );
    }
  }

  if (opts.expectFailure) {
    // The point of this case is that the assertion SHOULD fail — a golden set
    // that cannot detect the known-bad behaviour is not protecting anything.
    check(`${label} — detected as wrong (as designed)`, problems.length > 0, res.text.slice(0, 400));
  } else {
    check(label, problems.length === 0, `${problems.join("\n")}\n--- diff was:\n${res.text}`);
  }

  const extras = parsed.lines.filter((l) => !matched.has(l));
  if (extras.length && !parsed.fellBack) {
    console.log(
      `       note: ${extras.length} unexpected change(s) — needs manual confirmation:\n` +
        extras.slice(0, 5).map((l) => `         ${l.raw}`).join("\n"),
    );
  }
  return parsed;
}

// ------------------------------------------------------------------- flow ---

console.log("\n== 1. the problem: full-page snapshot ==");
const nav = await call("browser_navigate", { url: base });
check("page loads", nav.text.includes("Ada Lovelace"), nav.text.slice(0, 200));
check(
  `full page is expensive (${nav.chars} chars, > 8000)`,
  nav.chars > 8_000,
  `got ${nav.chars} chars — fixture is not representative any more`,
);

console.log("\n== 2. scope on a dialog that does not exist yet ==");
const early = await call("browser_set_snapshot_scope", { scope: 'div[role="dialog"]' });
check("reports the selector matches nothing yet", early.text.includes("matches nothing"), early.text);
const missed = await call("browser_snapshot");
check('falls back and says "scope missed, full page"', missed.text.includes("scope missed, full page"), missed.text.slice(0, 300));
check("fallback really is the full page", missed.text.includes("Add experience"));

console.log("\n== 3. open the dialog — every snapshot is now scoped ==");
scopeActive = true;
const open = await call("browser_click", { role: "button", name: "Add experience" });
check("dialog opened", open.text.includes('dialog "Add experience"'), open.text.slice(0, 300));
check("no scope-miss note", !open.text.includes("scope missed"));
check(`click result is small (${open.chars} chars)`, open.chars <= MAX_RESULT_CHARS, open.text);
check(
  "long option lists collapsed (year select)",
  /combobox "Start year": \[102 options collapsed/.test(open.text),
  open.text,
);
check(
  "short option lists stay readable (employment type)",
  open.text.includes('option "Self-employed"'),
  open.text,
);

console.log("\n== 4. native <select> — the control that had no tool ==");
for (const [name, value, expect] of [
  ["Employment type", "Full-time", "Full-time"],
  ["Start month", "Jan", "January"], // unique-prefix match
  ["Start year", "2019", "2019"],
  ["End month", "March", "March"],
  ["End year", "2023", "2023"],
  ["Location type", "Remote", "Remote"],
] as const) {
  const r = await call("browser_select", { role: "combobox", name, value });
  check(
    `select ${name} = ${value}${value === expect ? "" : ` → ${expect}`}`,
    !r.isError && r.text.includes(`selected: '${expect}'`),
    r.text.slice(0, 300),
  );
  check(`  result is small (${r.chars} chars)`, r.chars <= MAX_RESULT_CHARS);
}

console.log("\n== 5. typeahead listbox — must keep working untouched ==");
const fill = await call("browser_fill", { role: "combobox", name: "Company or organization", text: "Anthropic" });
check("fill typeahead", !fill.isError, fill.text);
const down = await call("browser_press", { key: "ArrowDown" });
check(
  "suggestions are visible (listbox NOT collapsed)",
  down.text.includes('listbox "Company suggestions"') && down.text.includes('option "Anthropic Labs"'),
  down.text.slice(0, 400),
);
const enter = await call("browser_press", { key: "Enter" });
check("Enter commits the highlighted suggestion", enter.text.includes("Anthropic"), enter.text.slice(0, 300));

console.log("\n== 6. contenteditable ==");
const desc = await call("browser_fill", {
  selector: "#desc",
  text: "Built the browser tool layer the agent runs on.",
});
check("fill contenteditable", !desc.isError, desc.text);

console.log("\n== 7. wrong-control errors must name the right tool ==");
const onTypeahead = await call("browser_select", {
  role: "combobox",
  name: "Company or organization",
  value: "Anthropic",
});
check("select on a typeahead is rejected", onTypeahead.isError, onTypeahead.text);
check(
  "  and points at fill + ArrowDown/Enter",
  onTypeahead.text.includes("browser_fill") && onTypeahead.text.includes("ArrowDown"),
  onTypeahead.text,
);
const onCe = await call("browser_select", { selector: "#desc", value: "whatever" });
check("select on a contenteditable is rejected", onCe.isError, onCe.text);
check("  and points at browser_fill", onCe.text.includes("browser_fill"), onCe.text);
const badValue = await call("browser_select", { role: "combobox", name: "Location type", value: "Underwater" });
check("unknown option is rejected", badValue.isError, badValue.text);
check(
  "  and lists the real options",
  badValue.text.includes("On-site") && badValue.text.includes("Hybrid"),
  badValue.text,
);
const ambiguous = await call("browser_select", { role: "combobox", name: "End month", value: "J" });
check("ambiguous prefix is rejected", ambiguous.isError, ambiguous.text);
check("  and names the candidates", ambiguous.text.includes("January") && ambiguous.text.includes("June"), ambiguous.text);

console.log("\n== 8. final state, read back through the scoped snapshot ==");
const final = await call("browser_snapshot");
for (const expected of [
  'option "Full-time" [selected]',
  'selected "January"',
  'selected "2019"',
  'selected "March"',
  'selected "2023"',
  'option "Remote" [selected]',
]) {
  check(`form holds: ${expected}`, final.text.includes(expected), final.text);
}
// The ARIA tree does not expose contenteditable text, so read the field back
// through the character counter it drives — which also proves fill() dispatched
// real input events rather than just setting a property.
const counted = Number(/(\d+)\/2,000 characters/.exec(final.text)?.[1] ?? 0);
check(`description was written (counter says ${counted} chars)`, counted > 0, final.text);
check(`final snapshot is small (${final.chars} chars)`, final.chars <= MAX_RESULT_CHARS, final.text);

console.log("\n== 9. browser_diff: the empty diff is the important answer ==");
await call("browser_snapshot"); // establishes the baseline
const quiet = await call("browser_diff");
check("nothing happened → 'no changes'", quiet.text.startsWith("no changes"), quiet.text);
check("  and it says so in words, not an empty string", quiet.text.length > 20 && quiet.text.includes("NO EFFECT"), quiet.text);
check(`  and it is cheap (${quiet.chars} chars)`, quiet.chars < 200);

console.log("\n== 10. browser_diff: a fill that works ==");
await assertDiff(
  "fill Description → exactly the new value",
  () => call("browser_fill", { selector: "#desc", text: "Rewrote the description." }),
  [{ op: "~", role: "textbox", name: "Description", value: "Rewrote the description." }],
);

console.log("\n== 11. browser_diff: the append bug it exists to catch ==");
const appended = await assertDiff(
  "fill Headline → exactly the new value",
  () => call("browser_fill", { selector: "#headline", text: "Staff Engineer" }),
  [{ op: "~", role: "textbox", name: "Headline", value: "Staff Engineer" }],
  { expectFailure: true },
);
const headlineNow = appended.lines.find((l) => l.name === "Headline")?.to.value ?? "";
check(
  `  the diff shows the concatenation: "${headlineNow}"`,
  headlineNow.includes("Fullstack Engineer") && headlineNow.includes("Staff Engineer"),
  `got "${headlineNow}"`,
);
check(
  "  which browser_fill itself reported as success",
  !(await call("browser_fill", { selector: "#headline", text: "Staff Engineer" })).isError,
);

console.log("\n== 12. browser_diff: select changes option state ==");
await call("browser_snapshot"); // re-baseline after the noisy headline step
await assertDiff(
  "select Employment type = Contract → option state moves",
  () => call("browser_select", { role: "combobox", name: "Employment type", value: "Contract" }),
  [{ op: "~", role: "option", name: "Contract", state: "selected" }],
);

console.log("\n== 13. browser_diff: duplicate names are told apart by ordinal ==");
const dup = await assertDiff(
  "click the 2nd of three identical 'Ant Group' buttons",
  () => call("browser_click", { selector: "#company-results li:nth-child(2) button" }),
  [{ op: "~", role: "button", name: "Ant Group", state: "pressed=true" }],
);
const pressed = dup.lines.filter((l) => l.op === "~" && l.name === "Ant Group");
check(
  `  exactly one of the three moved (got ${pressed.length})`,
  pressed.length === 1,
  pressed.map((l) => l.raw).join("\n"),
);

console.log("\n== 14. browser_diff: mid-list insertion does not cascade ==");
await call("browser_snapshot");
const inserted = await assertDiff(
  "insert a row into the MIDDLE of a list",
  () => call("browser_click", { role: "button", name: "Insert skill" }),
  [{ op: "+", role: "listitem" }],
);
check(
  `  exactly one node added (got ${inserted.lines.filter((l) => l.op === "+").length})`,
  inserted.lines.filter((l) => l.op === "+").length === 1,
  inserted.lines.map((l) => l.raw).join("\n"),
);
check(
  "  and the following siblings did NOT shift into phantom 'changed' entries",
  inserted.lines.every((l) => l.op !== "~"),
  inserted.lines.filter((l) => l.op === "~").map((l) => l.raw).join("\n"),
);
check(
  "  nothing reported as removed",
  inserted.lines.every((l) => l.op !== "-"),
  inserted.lines.filter((l) => l.op === "-").map((l) => l.raw).join("\n"),
);

console.log("\n== 15. browser_diff: a scoped subtree disappearing ==");
scopeActive = false; // the dialog is about to vanish; the fallback is a full page by design
const saved = await call("browser_click", { role: "button", name: "Save" });
check("Save closes the dialog", !saved.isError);
const gone = await call("browser_diff");
check(
  "diff reports the scope no longer matches",
  gone.text.includes("no longer matches") || gone.text.includes("scope"),
  gone.text.slice(0, 300),
);

console.log("\n== 16. browser_diff unscoped: the dialog node is removed ==");
await call("browser_set_snapshot_scope", {});
await call("browser_click", { role: "button", name: "Add experience" });
await call("browser_snapshot"); // baseline with the dialog present
await assertDiff(
  "click Save → dialog removed from the tree",
  () => call("browser_click", { role: "button", name: "Save" }),
  [{ op: "-", role: "dialog", name: "Add experience" }],
);

console.log("\n== 17. browser_diff: bails out when the diff is not smaller ==");
await call("browser_snapshot");
await call("browser_click", { role: "button", name: "Load 200 more" });
const huge = await call("browser_diff");
check(
  `falls back with 'diff too large, returned full snapshot' (${huge.chars} chars)`,
  huge.text.startsWith("diff too large, returned full snapshot"),
  huge.text.slice(0, 200),
);

console.log("\n== 18. browser_diff: navigation invalidates the baseline ==");
await call("browser_snapshot");
const afterNav = await call("browser_navigate", { url: base });
check("navigate succeeds", !afterNav.isError);
const postNav = await call("browser_diff");
check(
  "diff after navigation returns a full snapshot, not a bogus diff",
  parseDiff(postNav.text).fellBack,
  postNav.text.slice(0, 300),
);

console.log("\n== 19. browser_snapshot({full:true}) ignores scope ==");
await call("browser_set_snapshot_scope", { scope: 'div[role="dialog"]' });
await call("browser_click", { role: "button", name: "Add experience" });
const forced = await call("browser_snapshot", { full: true });
check(
  `full:true returns the whole page (${forced.chars} chars) despite the scope`,
  forced.chars > 8_000 && forced.text.includes("Ada Lovelace"),
  forced.text.slice(0, 200),
);

console.log("\n== 20. reading a collapsed option list on purpose ==");
// Documented escape hatch: scope a snapshot AT the select. Deliberately outside
// the budget — the caller is opting into the big read.
const oneSelect = await call("browser_snapshot", { scope: "#syear" });
check(
  `scoping at the select expands its options (${oneSelect.chars} chars)`,
  oneSelect.text.includes('option "1926"') && !oneSelect.text.includes("options collapsed"),
  oneSelect.text.slice(0, 300),
);

console.log("\n== 21. scope can be cleared ==");
const cleared = await call("browser_set_snapshot_scope", {});
check("clears", cleared.text.includes("cleared"), cleared.text);
const wide = await call("browser_snapshot");
check("full page is back", wide.chars > 8_000, `got ${wide.chars} chars`);

// ----------------------------------------------------------------- verdict ---

console.log(
  `\nlargest scoped tool result: ${maxScopedChars} chars (budget ${MAX_RESULT_CHARS}), ` +
    `vs ${nav.chars} unscoped`,
);
check(`every scoped result stayed under ${MAX_RESULT_CHARS} chars`, maxScopedChars <= MAX_RESULT_CHARS);

await client.close();
site.close();

if (failures > 0) {
  console.error(`\nGOLDEN ADD-EXPERIENCE FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("\nGOLDEN ADD-EXPERIENCE OK");
process.exit(0);
