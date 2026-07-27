/**
 * Verifies ATTACH mode's self-spawn path: no Chrome on the port → getContext
 * spawns one (headless in CI via JOB_AGENT_SPAWN_ARGS) → attaches → navigates.
 */
import http from "node:http";
import { activePage, closeBrowser } from "../src/browser.js";

const site = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<html><head><title>attach-ok</title></head><body><h1>attached</h1></body></html>`);
});
await new Promise<void>((r) => site.listen(0, r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const page = await activePage(); // should trigger spawn + poll + attach
await page.goto(base, { waitUntil: "domcontentloaded" });
if ((await page.title()) !== "attach-ok") throw new Error("navigation failed");
console.log("auto-spawn + attach + navigate: OK");

await closeBrowser(); // attach mode: must NOT kill the browser
site.close();
console.log("ATTACH TEST OK");
process.exit(0);
