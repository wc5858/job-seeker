/**
 * Golden set: "Workable application form".
 *
 * Distilled from a real application run (Pixlr, on Workable) that hit three
 * separate walls:
 *
 *   1. Resume was a required <input type=file> hidden behind a styled "Choose
 *      file" label and a drop zone. A display:none file input is not in the
 *      ARIA snapshot at all, so the agent could not even see the field, let
 *      alone fill it — the form was impossible to complete.
 *   2. The user had their own tab open. Tools addressed "the last tab", so the
 *      form in tab 0 was unreachable, and re-navigating to it would have wiped
 *      every answer already typed in.
 *   3. The snapshot flattened a textarea's newlines into spaces, which led to
 *      reporting a formatting bug to the user that did not exist; and a
 *      single-line maxlength-capped input was indistinguishable from a
 *      textarea, so a long answer was silently truncated.
 *
 * The fixture reproduces all three. It also carries a Turnstile placeholder,
 * which the suite deliberately never touches — see the human-verification
 * boundary in AGENTS.md.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ------------------------------------------------------------ test files ---

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ja-upload-"));
const resumePath = path.join(tmp, "ada-lovelace-resume.pdf");
const portfolioPath = path.join(tmp, "portfolio.pdf");
// Minimal but genuinely PDF-shaped, so nothing downstream chokes on the bytes.
fs.writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
fs.writeFileSync(portfolioPath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const missingPath = path.join(tmp, "does-not-exist.pdf");

// ---------------------------------------------------------------- fixture ---

const FORM = `<!doctype html><html><head><title>Apply — Senior Engineer at Pixlr</title>
<style>.visually-hidden{display:none}.dropzone{border:2px dashed #999;padding:12px}</style>
</head><body>
<h1>Apply for Senior Engineer</h1>
<form id="application">
  <label for="fullname">Full name</label>
  <input id="fullname" type="text" maxlength="80" />

  <label for="email">Email</label>
  <input id="email" type="email" />

  <!-- The trap: single-line and capped, but ARIA renders it exactly like the
       textarea below, so a long answer gets silently cut at submit time. -->
  <label for="why">Why do you want to work here?</label>
  <input id="why" type="text" maxlength="120" />

  <label for="cover">Cover letter</label>
  <textarea id="cover" maxlength="5000" rows="8"></textarea>

  <label id="notes-label">Additional notes</label>
  <div id="notes" contenteditable="true" role="textbox" aria-labelledby="notes-label"></div>

  <!-- Workable's shape: the real input is display:none; what a human sees is
       the label and the drop zone. Wrapped in a field container, as real forms
       are — the resolver deliberately refuses to search past the <form>, since
       "some file input somewhere on this form" is a guess, not a match. -->
  <div class="field" id="resume-field">
    <label for="resume" class="choose-resume">Choose file</label>
    <input id="resume" type="file" class="visually-hidden" accept=".pdf,.doc,.docx" />
    <div class="dropzone" id="resume-dropzone">Drag and drop your resume here</div>
    <p id="files-resume"></p>
  </div>

  <div class="field" id="portfolio-field">
    <label for="portfolio">Portfolio (optional, multiple)</label>
    <input id="portfolio" type="file" multiple />
    <p id="files-portfolio"></p>
  </div>

  <div id="turnstile" data-widget="cf-turnstile">Verify you are human</div>
  <button type="submit">Submit application</button>
</form>
<script>
document.querySelectorAll('input[type=file]').forEach(function (inp) {
  inp.addEventListener('change', function () {
    var out = document.getElementById('files-' + inp.id);
    if (!out) return;
    out.textContent = 'Attached: ' + Array.prototype.map.call(inp.files, function (f) {
      return f.name;
    }).join(', ');
  });
});
document.getElementById('application').addEventListener('submit', function (e) {
  e.preventDefault(); // the suite never submits; this is belt and braces
});
</script>
</body></html>`;

const OTHER = `<!doctype html><html><head><title>Feed | LinkedIn</title></head><body>
<h1>Your feed</h1><p>A tab the user already had open.</p></body></html>`;

const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url?.startsWith("/other") ? OTHER : FORM);
});
await new Promise<void>((r) => site.listen(0, r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

// ------------------------------------------------------------------ harness ---

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  stderr: "inherit",
  env: {
    ...process.env,
    JOB_AGENT_CDP: process.env.JOB_AGENT_CDP ?? "9345",
    JOB_AGENT_PROFILE: process.env.JOB_AGENT_PROFILE ?? path.join(os.tmpdir(), "ja-profile-apply"),
    JOB_AGENT_SPAWN_ARGS: process.env.JOB_AGENT_SPAWN_ARGS ?? "--headless=new",
  },
});
const client = new Client({ name: "golden-application-form", version: "0.0.1" });
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

/** Parse `* 0: Title — url` lines out of a tab listing. */
function parseTabs(text: string) {
  const out: Array<{ active: boolean; index: number; title: string; url: string }> = [];
  for (const line of text.split("\n")) {
    const m = /^([* ]) (\d+): (.*) — (\S+)$/.exec(line);
    if (m) out.push({ active: m[1] === "*", index: Number(m[2]), title: m[3], url: m[4] });
  }
  return out;
}

// ------------------------------------------------------------------- flow ---

console.log("\n== 1. the snapshot distinguishes single-line from multi-line ==");
await call("browser_navigate", { url: `${base}/apply` });
const fields = await call("browser_snapshot");
check(
  "a capped single-line input shows its type AND maxlength",
  /textbox "Why do you want to work here\?" \[input, maxlength=120/.test(fields.text),
  fields.text,
);
check(
  "a textarea is labelled as one",
  /textbox "Cover letter" \[textarea, maxlength=5000/.test(fields.text),
  fields.text,
);
check(
  "a typed input keeps its type",
  /textbox "Email" \[input:email\]/.test(fields.text),
  fields.text,
);
check(
  "contenteditable is distinguished from both",
  /textbox "Additional notes" \[contenteditable\]/.test(fields.text),
  fields.text,
);

console.log("\n== 2. newlines survive, and truncation is announced ==");
const multiline = "Dear team,\n\nI have shipped browser tooling for agents.\n\nAda";
await call("browser_fill", { selector: "#cover", text: multiline });
const afterFill = await call("browser_snapshot");
check(
  "newlines are preserved as ⏎ instead of being flattened to spaces",
  afterFill.text.includes("Dear team,⏎⏎I have shipped browser tooling for agents.⏎⏎Ada"),
  afterFill.text,
);
check(
  "the used-character count is shown against maxlength",
  new RegExp(`maxlength=5000, ${multiline.length} used`).test(afterFill.text),
  afterFill.text,
);
await call("browser_fill", { selector: "#cover", text: "x".repeat(900) });
const truncated = await call("browser_snapshot");
check(
  "a long value is marked [truncated, N chars total] rather than just cut",
  truncated.text.includes("[truncated, 900 chars total]"),
  truncated.text.slice(0, 600),
);

console.log("\n== 3. the hidden file input really is invisible ==");
check(
  "no file field for the resume appears in the snapshot",
  !/textbox "Choose file"/.test(fields.text) && !/button "Choose file"/.test(fields.text),
  "the fixture no longer models a hidden input",
);
check("only its label text shows", fields.text.includes("Choose file"), fields.text.slice(0, 400));

console.log("\n== 4. upload through the visible label ==");
const up = await call("browser_upload_file", { selector: "label.choose-resume", path: resumePath });
check("upload succeeds via the label", !up.isError, up.text.slice(0, 400));
check("the tool reports what the input now holds", up.text.includes("ada-lovelace-resume.pdf"), up.text.slice(0, 300));
check(
  "and the page shows the file name",
  up.text.includes("Attached: ada-lovelace-resume.pdf"),
  up.text.slice(0, 800),
);

console.log("\n== 5. upload through the drop zone ==");
const viaZone = await call("browser_upload_file", {
  selector: "#resume-dropzone",
  path: portfolioPath,
});
check("the associated input is found from the drop zone", !viaZone.isError, viaZone.text.slice(0, 400));
check("and it replaced the attachment", viaZone.text.includes("portfolio.pdf"), viaZone.text.slice(0, 300));

console.log("\n== 6. several files at once ==");
check(
  "a VISIBLE file input shows up as a button, not a textbox — worth knowing when targeting it",
  /button "Portfolio \(optional, multiple\)"/.test(fields.text),
  fields.text,
);
const multi = await call("browser_upload_file", {
  role: "button",
  name: "Portfolio",
  paths: [resumePath, portfolioPath],
});
check("multi-file upload succeeds", !multi.isError, multi.text.slice(0, 400));
check("attached 2 file(s)", multi.text.includes("attached 2 file(s)"), multi.text.slice(0, 200));
check(
  "both names reach the page",
  multi.text.includes("ada-lovelace-resume.pdf") && multi.text.includes("portfolio.pdf"),
  multi.text.slice(0, 600),
);

console.log("\n== 7. bad input fails loudly, never silently ==");
const missing = await call("browser_upload_file", { selector: "#portfolio", path: missingPath });
check("a missing file is an error", missing.isError, missing.text);
check("and the path is named", missing.text.includes("does-not-exist.pdf"), missing.text);
const noPath = await call("browser_upload_file", { selector: "#portfolio" });
check("no path at all is an error", noPath.isError, noPath.text);
const notUpload = await call("browser_upload_file", { selector: "#fullname", path: resumePath });
check(
  "targeting a text field is an error, NOT a silent upload to some other input",
  notUpload.isError,
  notUpload.text.slice(0, 400),
);
check("and it says what to target instead", notUpload.text.includes("drop zone"), notUpload.text);
const strayTarget = await call("browser_upload_file", { selector: "h1", path: resumePath });
check("so is a target with no upload field near it", strayTarget.isError, strayTarget.text.slice(0, 300));

console.log("\n== 8. multi-tab: the form must stay reachable ==");
await call("browser_fill", { selector: "#fullname", text: "Ada Lovelace" });
await call("browser_fill", { selector: "#why", text: "Because the tooling is the product." });
const opened = await call("browser_new_tab", { url: `${base}/other` });
check("the new tab becomes active", opened.text.includes("Your feed"), opened.text.slice(0, 300));
const listing = await call("browser_tabs");
const tabs = parseTabs(listing.text);
check(`two tabs are listed (got ${tabs.length})`, tabs.length === 2, listing.text);
check(
  "the active one is marked with *",
  tabs.filter((t) => t.active).length === 1 && tabs.find((t) => t.active)?.url.includes("/other") === true,
  listing.text,
);

console.log("\n== 9. switching back does not lose typed answers ==");
const back = await call("browser_select_tab", { urlPattern: "/apply" });
check("selected by urlPattern", !back.isError && back.text.includes("Apply"), back.text.slice(0, 300));
check(
  "the name typed before the switch is still there",
  /textbox "Full name" \[input, maxlength=80, 12 used\]: Ada Lovelace/.test(back.text),
  back.text,
);
check(
  "so is the capped answer",
  back.text.includes("Because the tooling is the product."),
  back.text,
);
check("and the uploaded file is still attached", back.text.includes("Attached:"), back.text);

console.log("\n== 10. the other ways to select a tab ==");
const formIndex = parseTabs((await call("browser_tabs")).text).find((t) => t.url.includes("/apply"))!.index;
await call("browser_select_tab", { urlPattern: "/other" });
const byIndex = await call("browser_select_tab", { index: formIndex });
check("selected by index", !byIndex.isError && byIndex.text.includes("Apply"), byIndex.text.slice(0, 200));
await call("browser_select_tab", { urlPattern: "/other" });
const byTitle = await call("browser_select_tab", { titlePattern: "Pixlr" });
check("selected by titlePattern", !byTitle.isError && byTitle.text.includes("Apply"), byTitle.text.slice(0, 200));
const noMatch = await call("browser_select_tab", { urlPattern: "nope-not-here" });
check("a pattern matching nothing errors and lists the tabs", noMatch.isError && noMatch.text.includes(": "), noMatch.text);
const ambiguous = await call("browser_select_tab", { urlPattern: "127\\.0\\.0\\.1" });
check("an ambiguous pattern refuses rather than guessing", ambiguous.isError && ambiguous.text.includes("pass an index"), ambiguous.text);

console.log("\n== 11. closing a tab ==");
const otherIndex = parseTabs((await call("browser_tabs")).text).find((t) => t.url.includes("/other"))!.index;
const closed = await call("browser_close_tab", { index: otherIndex });
check("closes it", !closed.isError && closed.text.includes("Closed tab"), closed.text.slice(0, 200));
check(`one tab left`, parseTabs(closed.text).length === 1, closed.text);
const stillThere = await call("browser_snapshot");
check("the form tab survived and kept its data", stillThere.text.includes("Ada Lovelace"), stillThere.text.slice(0, 300));

console.log("\n== 12. the human-verification boundary ==");
check(
  "the Turnstile widget is present in the fixture and left untouched",
  stillThere.text.includes("Verify you are human"),
  stillThere.text.slice(0, 600),
);

// ----------------------------------------------------------------- verdict ---

await client.close();
site.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nGOLDEN APPLICATION-FORM FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("\nGOLDEN APPLICATION-FORM OK");
process.exit(0);
