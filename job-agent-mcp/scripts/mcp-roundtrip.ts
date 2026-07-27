/**
 * Full MCP round-trip: spawns the real server over stdio, connects with the
 * SDK client, lists tools, and drives navigate → click against a local site.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url?.startsWith("/job")) {
    res.end(`<html><head><title>Job Detail</title></head><body><h1>Fullstack Engineer</h1></body></html>`);
  } else {
    res.end(`<html><head><title>Job List</title></head><body>
      <a href="/job/1">Fullstack Engineer</a></body></html>`);
  }
});
await new Promise<void>((r) => site.listen(0, r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  stderr: "inherit",
  env: {
    ...process.env,
    HEADLESS: "1",
    JOB_AGENT_PROFILE: "/tmp/ja-profile-rt",
    ...(process.env.JOB_AGENT_EXECUTABLE
      ? { JOB_AGENT_EXECUTABLE: process.env.JOB_AGENT_EXECUTABLE }
      : {}),
  },
});
const client = new Client({ name: "smoke-client", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const nav = await client.callTool({ name: "browser_navigate", arguments: { url: base } });
const navText = (nav.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
console.log("\nnavigate result head:\n" + navText.slice(0, 200));
if (!navText.includes("Job List")) throw new Error("navigate result missing title");

const click = await client.callTool({
  name: "browser_click",
  arguments: { role: "link", name: "Fullstack Engineer" },
});
const clickText = (click.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
if (!clickText.includes("Job Detail")) throw new Error("click did not navigate");
console.log("\nclick → landed on Job Detail ✓");

const shot = await client.callTool({ name: "browser_screenshot", arguments: {} });
const img = (shot.content as Array<{ type: string; data?: string }>)[0];
console.log("screenshot base64 length:", img?.data?.length ?? 0);

await client.close();
site.close();
console.log("\nMCP ROUNDTRIP OK");
