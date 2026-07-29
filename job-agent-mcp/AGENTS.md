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
8. **One tool per control type, split by failure mode** (added 2026-07-28 after
   a LinkedIn *Add experience* run): text/contenteditable → `browser_fill`;
   native `<select>` → `browser_select`; typeahead listbox → `browser_fill` +
   ArrowDown + Enter. Native selects were previously unreachable — `fill` errors
   with "not an `<input>`", clicking an `<option>` times out (they are not in a
   clickable DOM layer), and typeahead by first letter does nothing.
   `browser_select` wraps `locator.selectOption()`, which fires `input` and
   `change` natively — do NOT add a manual dispatch on top, it double-fires.
   It resolves the option itself (visible text → value attribute → unique
   prefix) instead of delegating to Playwright's matcher, so a miss can report
   the real option list; that error message is the agent's discovery path and
   the reason collapsing options in the snapshot is safe.
9. **Snapshot cost is managed in two places** (added 2026-07-28, same run).
   (a) `scope`: a CSS selector rooting the snapshot at a subtree, with a
   session-level default in `snapshot.ts` module state — every tool funnels
   through `snapshotPage`, so setting it once reaches click/fill/press/navigate
   without threading a parameter through each handler. A scope that matches
   nothing falls back to the full page and says `scope missed, full page`: an
   empty tree would leave the agent unable to tell "dialog closed" from
   "selector typo". (b) Option collapsing: Playwright's ARIA snapshot
   enumerates every `<option>`, so one 1926-2026 year picker outweighs the
   dialog containing it. Runs longer than 10 under a `combobox` collapse to a
   summary line. **`listbox` nodes are deliberately never collapsed** — that is
   the typeahead popup, where reading the filtered suggestions is the point.

10. **Perception doubles as verification** (added 2026-07-29, same LinkedIn
    run). Tools report success on the *call*, not the *result*: `browser_fill`
    appended into a contenteditable instead of replacing, and a Ctrl+A/Delete
    failed to clear — both returned success. `browser_diff` answers "did that
    step actually do what I think". Four constraints, each load-bearing:
    (a) the node model is walked from the **DOM, not the ARIA tree** — ARIA
    omits contenteditable text, i.e. it is blind to the bug the tool exists to
    catch; (b) nodes pair by **keyed sibling alignment**, never by a global
    role+name lookup — LinkedIn's company picker has three buttons all named
    "Ant Group", and alignment only ever runs between the children of two
    already-paired parents, with duplicates separated by ordinal;
    (c) never diff serialized text — React re-renders churn indentation;
    (d) index paths count the MODEL tree, so role-less wrapper `<div>`s are
    transparent and adding one does not renumber everything below it.
    Appeared/vanished subtrees are reported at their root with a descendant
    count — a dialog holding four `<select>`s is otherwise 265 removal lines,
    enough to trip the size fallback and bury the one fact that mattered.
    Scope applies BEFORE the diff, never after.
    Alignment is two passes (2026-07-29, replacing the original path pairing,
    which made a single mid-list insertion renumber every following sibling and
    surface as a run of phantom `changed`): **keyed** by
    (role+name, ordinal-among-equal-keys), falling back to a truncated subtree
    text digest for container roles with no name of their own (`<li>`);
    then a **positional residue** pass that pairs whatever is left when the
    roles agree. The residue pass is what keeps a node whose NAME changed (a
    character counter ticking) as one `changed` instead of a remove+add — its
    key moved, so the keyed pass could not match it. DOM ids are deliberately
    NOT part of the key: LinkedIn is Ember and regenerates `ember1234` ids on
    re-render, so keying on them would be worse than useless.
11. **Only browser_snapshot and browser_diff set the diff baseline.** Action
    tools deliberately do not, so `snapshot → act → diff` measures the action.
    Navigation clears it outright.
12. **Anything shipped into the page must survive esbuild's keep-names
    transform.** We run under tsx, which rewrites nested functions to
    `__name(fn, "fn")`; that helper does not exist in the browser, so handing
    a function with inner helpers to `page.evaluate` dies with
    `ReferenceError: __name is not defined` — in production, not just in tests.
    `nodemodel.ts` ships the walker as a string wrapped in a closure that
    declares its own `__name`. Evaluating a string is CSP-safe because
    Playwright evaluates through CDP, which page `script-src` does not gate
    (LinkedIn forbids `eval`, so `new Function` inside the page is not an
    option). **Never `.catch(() => [])` around a page.evaluate that feeds the
    diff** — an empty node list is indistinguishable from "nothing changed",
    which is how this bug hid for a whole test run.

## Current toolset (v0.4)

browser_navigate / browser_snapshot (offset pagination + `scope` + `full`) /
browser_set_snapshot_scope (session-wide scope) / browser_diff (verify the last
action) / browser_click (role+name first, selector as escape hatch) /
browser_fill (never submits) / browser_select (native `<select>` only) /
browser_press / browser_screenshot / browser_tabs / browser_back /
browser_open_human (human handoff)

Source layout: `browser.ts`/`chrome.ts` (lifecycle), `snapshot.ts` (ARIA
perception, scope, option collapsing), `nodemodel.ts` (DOM node model +
structural diff), `server.ts` (tool surface).

## Known issues / TODO

- [ ] `activePage` picks "the last tab" — unreliable in a shared browser;
      needs `browser_tab_select`
- [ ] Domain tools: `search_jobs` / `extract_jd` (distilled from recorded flows)
- [x] Golden-set regression: `scripts/golden-add-experience.ts` (`npm run golden`),
      including `assertDiff` per-step DOM assertions
- [ ] Golden set for job search / JD extraction pages — **note: the "10 offline
      job-page snapshots" referenced in planning do not exist yet**; the only
      golden set in the repo is the Add-experience one
- [x] `browser_diff` mid-list insertion cascade — fixed 2026-07-29 by keyed
      sibling alignment (see ADR 10); regression-tested in the golden set
- [ ] **The ARIA tree does not expose `contenteditable` text.** A filled
      description reads back as a bare `textbox "Description"`, so the agent
      cannot verify what it wrote. The golden set works around it via the
      character counter the field drives; a real fix needs screenshot-based or
      DOM-text extraction.
- [ ] Screenshot-based extraction for fields not exposed in the ARIA tree

## Conventions

- pnpm; `pnpm run typecheck` must pass before any commit
- Tests: `pnpm run smoke` (offline self-hosted site), `pnpm run golden`
  (LinkedIn Add-experience replica, over real MCP stdio), `pnpm run roundtrip`,
  and `scripts/attach-test.ts`; all run through the attach path
- Scripts that spawn the server as a subprocess (`golden`, `roundtrip`) pin
  their own `JOB_AGENT_CDP` + `JOB_AGENT_PROFILE`, so a run never collides with
  the browser the user is working in. Never hardcode a POSIX `/tmp` path —
  Chrome fails to start from one on Windows (this bit `mcp-roundtrip.ts`, fixed
  2026-07-28). `smoke` and `attach-test` still use the default port/profile and
  will drive the shared window — they import `browser.ts` directly, and its
  env is read at module load, so isolating them means setting env before the
  import rather than passing it down. Run them when no session is in flight
- Golden-set style: assert through the MCP client, not the internals, so tool
  descriptions and error strings are covered too; assert the token budget
  alongside behaviour; and keep at least one fixture that reproduces a known
  bug with an `expectFailure` assertion, so the harness proves it can still
  detect it
- Desktop config lives at the MSIX-virtualized path on Store installs:
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`
- Pair-development flow: user owns `server.ts`; infrastructure
  (browser/chrome/snapshot) is largely cloud-maintained; cross-device commits
  via device_commit_files with mtime guards. Save your editor buffers before
  pulling — two overwrite near-misses so far.
