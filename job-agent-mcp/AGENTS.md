# job-agent-mcp — Agent Collaboration Guide

> This file is the project's externalized memory: architecture decisions,
> conventions, and current state. Read it before touching anything.
> **When a decision changes, update this file in the same change** —
> conversation memory is unreliable; this file is the source of truth.

## What this is

Browser tool layer for a job-hunting agent: Playwright driving a real Chrome,
exposed as an MCP server (stdio). Consumers: Claude Code (local), Claude
Desktop, and cloud Cowork sessions (proxied through the desktop bridge as
`mcp__remote-devices__job-agent__*`).

## Architecture Decision Record (condensed)

1. **Perception is ARIA-first; screenshots are the fallback.** The ARIA
   snapshot is cheap, structured, and isomorphic with role+name targeting —
   what the agent reads is exactly what it can click. Note: some sites render
   certain fields (e.g. salaries) in ways the ARIA tree cannot capture; use
   `browser_screenshot` for those.
2. **ATTACH-ONLY** (launch mode was removed 2026-07-27): the server only ever
   attaches over CDP (port from `JOB_AGENT_CDP`, default 9222). If the port is
   silent, `attachOrSpawn` spawns a real Chrome as a plain detached process
   and polls until it is up. Human and agent share one window;
   `browser_open_human` simply navigates the shared window and hands over.
   Tests also run through attach (headless env: `CHROME_PATH` +
   `JOB_AGENT_SPAWN_ARGS="--headless=new,--no-sandbox"`).
3. **Dedicated profile** (`~/.job-agent/profile`): never touches the user's
   daily Chrome; login state lives here. Chrome's ProcessSingleton allows only
   one browser process per profile — a lock conflict surfaces as "spawned but
   port never came up", reported with a diagnostic message.
4. **getContext never caches a failed promise** — attach failures are temporal
   (profile busy, browser starting) and must be retryable on the next call.
5. **closeBrowser never kills the user's browser** — for a connectOverCDP
   browser, close() only drops the connection.
6. **Tools are semantic interfaces for the model, not code-organization
   units.** `browser_navigate` (agent keeps working; returns a snapshot) and
   `browser_open_human` (agent stops; returns handoff instructions, no
   snapshot) share implementation but must stay separate tools.
7. **Safety red line: no autonomous send/submit tools.** Sending messages or
   applications always goes through the human.

## Current toolset (v0.2)

browser_navigate / browser_snapshot (offset pagination) / browser_click
(role+name first, selector as escape hatch) / browser_fill (never submits) /
browser_press / browser_screenshot / browser_tabs / browser_back /
browser_open_human (human handoff)

## Known issues / TODO

- [ ] `activePage` picks "the last tab" — unreliable in a shared browser;
      needs `browser_tab_select`
- [ ] Domain tools: `search_jobs` / `extract_jd` (distilled from recorded flows)
- [ ] Golden-set regression: offline snapshots of job pages + assertions
- [ ] Screenshot-based extraction for fields not exposed in the ARIA tree

## Conventions

- pnpm; `pnpm run typecheck` must pass before any commit
- Tests: `pnpm run smoke` (offline self-hosted site) and
  `scripts/attach-test.ts`; both run through the attach path
- Desktop config lives at the MSIX-virtualized path on Store installs:
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`
- Pair-development flow: user owns `server.ts`; infrastructure
  (browser/chrome/snapshot) is largely cloud-maintained; cross-device commits
  via device_commit_files with mtime guards. Save your editor buffers before
  pulling — two overwrite near-misses so far.
