/**
 * Hermetic smoke test: serves a tiny local site, then exercises the tool
 * internals (navigate → snapshot → fill → click → verify) end to end.
 */
import http from "node:http";
import { activePage, closeBrowser } from "../src/browser.js";
import { snapshotPage, formatSnapshot } from "../src/snapshot.js";

const site = http.createServer((req, res) => {
  if (req.url?.startsWith("/job")) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<html><head><title>Job Detail</title></head><body>
      <h1>Fullstack Engineer</h1><p>Salary: 20-40K</p>
      <a href="/">Back to list</a></body></html>`);
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<html><head><title>Job List</title></head><body>
    <h1>Mock Job Board</h1>
    <input aria-label="Search jobs" placeholder="Search jobs" />
    <button>Search</button>
    <ul><li><a href="/job/1">Fullstack Engineer - Example Co</a></li></ul>
  </body></html>`);
});
await new Promise<void>((r) => site.listen(0, r));
const port = (site.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

console.log("== navigate + snapshot ==");
const page = await activePage();
await page.goto(base, { waitUntil: "domcontentloaded" });
const snap = await snapshotPage(page);
console.log(formatSnapshot(snap));
if (snap.kind !== "aria" || !snap.content.includes("Search jobs")) {
  throw new Error("ARIA snapshot missing expected content");
}

console.log("\n== fill by role+name ==");
await page.getByRole("textbox", { name: "Search jobs" }).fill("fullstack agent");
console.log("filled:", await page.getByRole("textbox", { name: "Search jobs" }).inputValue());

console.log("\n== click link by role+name ==");
await page.getByRole("link", { name: "Fullstack Engineer" }).first().click();
await page.waitForLoadState("domcontentloaded");
const snap2 = await snapshotPage(page);
if (!snap2.title.includes("Job Detail")) throw new Error("navigation via click failed");
console.log("after click:", page.url(), "|", snap2.title);

console.log("\n== screenshot ==");
const shot = await page.screenshot({ type: "jpeg", quality: 60 });
console.log("screenshot bytes:", shot.length);

await closeBrowser();
site.close();
console.log("\nSMOKE OK");
