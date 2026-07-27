# job-agent-mcp

Browser tools for a job-hunting agent, packaged as an MCP server (stdio).
Playwright drives a **real, user-grade Chrome** over a dedicated profile; the
human and the agent share the same browser window. One server, many clients:
Claude Code, Claude Desktop, and cloud Cowork sessions (proxied through the
desktop bridge as `mcp__remote-devices__job-agent__*`).

## Tools (v0.2)

| Tool | Description |
|---|---|
| `browser_navigate` | Open a URL in the active tab, returns an ARIA snapshot |
| `browser_snapshot` | Read the current page as an ARIA (role+name) tree; `offset` paginates |
| `browser_click` | Click by ARIA role+name (preferred) or raw Playwright selector |
| `browser_fill` | Fill a text input (never submits) |
| `browser_press` | Press a keyboard key (`Enter`, `Escape`, ...) |
| `browser_screenshot` | Viewport screenshot — fallback sense for oddly structured pages |
| `browser_tabs` | List open tabs |
| `browser_back` | Go back in history |
| `browser_open_human` | Hand the shared window to the human (logins, QR codes, captchas) |

Design notes: perception is ARIA-first (what the agent reads is exactly what it
can click); screenshots are the fallback. **No tool sends messages or submits
applications autonomously — send-class actions always go through the human.**

## Install

Requires Node 20+ and Chrome.

```bash
cd job-agent-mcp
npm install     # or pnpm install
```

### One-time login

```bash
npm run login                        # opens JOB_AGENT_HOME (or example.com)
npm run login -- https://example.org # or any site
```

This opens the dedicated profile (`~/.job-agent/profile`) in a plain Chrome
window. Log in manually; the login state persists in the profile and is reused
by the agent's browser. Your daily Chrome profile is never touched.

## Architecture

Attach-only: the server connects to Chrome over CDP (port `9222` by default).
If nothing is listening, it spawns Chrome itself as a plain detached process
and polls until the port is up — no manual command needed. Human and agent
share the window: the user can watch, intervene, or complete logins in place,
and the agent continues in the same tabs.

## Claude integration

### A. Claude Code

```bash
claude mcp add job-agent -- npx tsx /absolute/path/to/job-agent-mcp/src/server.ts
# with custom env:
claude mcp add job-agent -e JOB_AGENT_CDP=9223 -e JOB_AGENT_HOME=https://example.com \
  -- npx tsx /absolute/path/to/job-agent-mcp/src/server.ts
```

### B. Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`;
Windows: `%APPDATA%\Claude\`, or the MSIX-virtualized path
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\` for Store installs):

```json
{
  "mcpServers": {
    "job-agent": {
      "command": "node",
      "args": [
        "C:\\path\\to\\job-agent-mcp\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\path\\to\\job-agent-mcp\\src\\server.ts"
      ],
      "env": {
        "JOB_AGENT_HOME": "https://example.com"
      }
    }
  }
}
```

All env vars are optional — defaults work out of the box. Restart the desktop
app after editing. With the desktop app online, cloud Cowork sessions see the
tools as `mcp__remote-devices__job-agent__*` automatically.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `JOB_AGENT_PROFILE` | Dedicated browser profile directory | `~/.job-agent/profile` |
| `JOB_AGENT_CDP` | CDP port (auto-spawns Chrome when nothing is listening) | `9222` |
| `JOB_AGENT_HOME` | Default URL for `npm run login` | `https://example.com` |
| `CHROME_PATH` | Chrome/Chromium executable (when auto-detection fails) | auto-detect |
| `JOB_AGENT_SPAWN_ARGS` | Extra Chrome args on auto-spawn, comma-separated (CI: `--headless=new,--no-sandbox`) | none |

## Testing

```bash
npm run typecheck
npm run smoke                      # offline self-hosted site, full tool internals
npx tsx scripts/attach-test.ts     # auto-spawn + attach path
npx tsx scripts/mcp-roundtrip.ts   # real MCP stdio round-trip
```

In headless environments, set `CHROME_PATH` and
`JOB_AGENT_SPAWN_ARGS="--headless=new,--no-sandbox"`.

## Roadmap

- [ ] `browser_tab_select` — explicit tab targeting (the "last tab" heuristic is fragile)
- [ ] Domain tools: `search_jobs` / `extract_jd` on top of the atomic tools
- [ ] Golden-set regression: offline snapshots of job pages + assertions
- [ ] Screenshot-based extraction for fields not exposed in the ARIA tree
- [ ] Standalone agent loop + CLI as an alternative decision layer
