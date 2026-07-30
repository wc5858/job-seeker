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
    **Always go through `evalInPage` in `pagefn.ts`** (extracted 2026-07-30 when
    `scroll.ts` became the second caller); never call `page.evaluate` with a
    function directly. Evaluating a string is CSP-safe because
    Playwright evaluates through CDP, which page `script-src` does not gate
    (LinkedIn forbids `eval`, so `new Function` inside the page is not an
    option). **Never `.catch(() => [])` around a page.evaluate that feeds the
    diff** — an empty node list is indistinguishable from "nothing changed",
    which is how this bug hid for a whole test run.

13. **Lazy lists are the only failure mode that does not raise** (added
    2026-07-30, same LinkedIn run). A search page holds 25 results and renders
    ~10; the rest are empty `<li>`. The ARIA snapshot is well-formed, so the
    agent reads it as "list ended" — a complete-looking, incomplete answer.
    Fixed on both sides: `snapshot.ts` marks childless, unnamed container nodes
    `[not rendered]` and adds an `incomplete:` header line, and `browser_scroll`
    loads them. `cell` and `option` are excluded from the marking — an empty
    table cell or placeholder `<option>` is ordinary markup, not a symptom.
14. **Scrolling is a loading primitive, not a viewport tweak.** Two properties
    are load-bearing: (a) the scroll container is usually NOT the window, so we
    resolve an element and set `scrollTop` — this is why `browser_press('End')`
    only ever worked by accident, it acts on whatever has focus; (b) travel is
    split into steps with a render pause, because an IntersectionObserver that
    never observes an intersection never fires — a one-shot jump loads only
    what lands in view. The golden set pins this: one-shot leaves 10 of 25 rows
    unrendered, 5 steps leaves 0. The target is recomputed every step since
    content grows underneath. All stepping happens inside ONE in-page async
    function so the element reference survives DOM mutation between steps.
    "Did anything load?" counts new elements AND new height: placeholder rows
    already occupy their final height, so height alone misses fill-in-place
    lazy loading.
15. **Auto-detection prefers the document, then the largest inner scroller.**
    On a layout where both scroll (LinkedIn) that picks the page and loads
    nothing, which is exactly why `selector` exists and why the golden set
    asserts the wrong-container behaviour rather than hiding it.

16. **Human verification is a boundary, not a gap.** CAPTCHAs, Cloudflare
    Turnstile and friends are never to be solved, worked around, or probed —
    that is what they are for, and write actions need a human anyway. **The
    agent's job ends at "the form is filled in, stopped before submit."**
    Filling everything and handing over is the successful outcome, not a
    partial one. This sits alongside ADR 7 (no autonomous send/submit): 7 says
    do not press the button, this says do not defeat the check that guards it.
17. **File uploads go to the input, never through the button** (added
    2026-07-30, from a Workable application). Clicking the visible control
    opens the OS file dialog, which is outside the page and undrivable;
    `setInputFiles` on the `<input type=file>` is the only route. Two ARIA
    facts make this field hard to even see: a visible file input serializes as
    `button`, and a `display:none` one **does not appear in the snapshot at
    all** — which is the Workable shape (a styled "Choose file" label plus a
    drop zone). So `browser_upload_file` resolves the input from whatever
    visible element you target. The search deliberately refuses to climb past
    `<form>` and refuses ambiguity: attaching a resume to the wrong input
    silently is worse than an error. Targeting a text field is refused
    outright — a textbox is never a stand-in for an upload control.
18. **The active tab is explicit state.** "The last tab" was a real dead end:
    with the form in tab 0 and the user's own LinkedIn in tab 1, every tool
    addressed the wrong tab, and re-navigating to the form would have wiped the
    answers already typed in. `browser_select_tab` pins a tab and every tool
    follows it until it changes; `browser_tabs` marks it with `*`. The
    last-tab fallback survives only for the unselected case, so a popup opened
    by the site is still picked up.
19. **Snapshot fidelity for text fields** (added 2026-07-30, same run). The
    ARIA tree flattens newlines to spaces — which once produced a *false* bug
    report to the user about a mangled field — renders `<input>` and
    `<textarea>` identically as `textbox` with no maxlength, and omits
    contenteditable values. `snapshot.ts` therefore annotates textbox lines
    from the DOM: `[input, maxlength=120, 34 used]`, newlines as `⏎`, and
    `… [truncated, N chars total]` instead of a bare cut. Matching is **by
    accessible name and only when unique** — a positional match is faster but
    would mislabel a field's maxlength when the two lists diverge, and wrong
    metadata is worse than none. This also closes the old "ARIA does not expose
    contenteditable text" known issue.

## Current toolset (v0.6)

browser_navigate / browser_snapshot (offset pagination + `scope` + `full`) /
browser_set_snapshot_scope (session-wide scope) / browser_diff (verify the last
action) / browser_click (role+name first, selector as escape hatch) /
browser_fill (never submits) / browser_select (native `<select>` only) /
browser_upload_file (resolves the input from the visible control) /
browser_scroll (lazy-load driver) / browser_scroll_into_view / browser_press /
browser_screenshot / browser_tabs (marks the active tab) / browser_select_tab /
browser_new_tab / browser_close_tab / browser_back / browser_open_human
(human handoff)

Source layout: `browser.ts`/`chrome.ts` (lifecycle + active-tab selection),
`snapshot.ts` (ARIA perception, scope, option collapsing, `[not rendered]`
marking, field annotation), `nodemodel.ts`
(DOM node model + structural diff), `scroll.ts` (container resolution, stepped
scrolling, settle wait), `pagefn.ts` (the only sanctioned way to run our code
in the page), `server.ts` (tool surface).

## Known issues / TODO

- [ ] `activePage` picks "the last tab" — unreliable in a shared browser;
      needs `browser_tab_select`
- [ ] Domain tools: `search_jobs` / `extract_jd` (distilled from recorded flows)
- [x] Golden-set regression: `scripts/golden-add-experience.ts` (`npm run golden`),
      including `assertDiff` per-step DOM assertions
- [x] Golden set for lazy-loaded search results:
      `scripts/golden-lazy-list.ts` (`npm run golden:lazy`)
- [x] Golden set for the Workable application form (upload, tabs, field
      fidelity): `scripts/golden-application-form.ts` (`npm run golden:apply`)
- [ ] Golden set for JD extraction pages — **note: the "10 offline job-page
      snapshots" referenced in planning still do not exist**; the golden sets in
      the repo are the two above, both built from hermetic fixtures
- [x] `browser_diff` mid-list insertion cascade — fixed 2026-07-29 by keyed
      sibling alignment (see ADR 10); regression-tested in the golden set
- [x] **The ARIA tree does not expose `contenteditable` text** — fixed
      2026-07-30 by the DOM-sourced field annotation (ADR 19); the value now
      appears in the snapshot with newlines intact
- [ ] Screenshot-based extraction for other fields not exposed in the ARIA tree
      (some sites render salaries in ways the tree cannot capture)
- [ ] Field annotation matches by accessible name, so two fields sharing a name
      are both left unannotated. Fails safe, but they show no maxlength

## Conventions

- pnpm; `pnpm run typecheck` must pass before any commit
- Tests: `pnpm run smoke` (offline self-hosted site), `pnpm run golden`
  (LinkedIn Add-experience replica, over real MCP stdio), `pnpm run golden:lazy`
  (lazy-loaded search results), `pnpm run golden:apply` (Workable application
  form), `pnpm run roundtrip`, and `scripts/attach-test.ts`; all run through the
  attach path
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
