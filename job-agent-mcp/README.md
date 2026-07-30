# job-agent-mcp

Browser tools for a job-hunting agent, packaged as an MCP server (stdio).
Playwright drives a **real, user-grade Chrome** over a dedicated profile; the
human and the agent share the same browser window. One server, many clients:
Claude Code, Claude Desktop, and cloud Cowork sessions (proxied through the
desktop bridge as `mcp__remote-devices__job-agent__*`).

## Tools (v0.3)

| Tool | Description |
|---|---|
| `browser_navigate` | Open a URL in the active tab, returns an ARIA snapshot |
| `browser_snapshot` | Read the current page as an ARIA (role+name) tree; `offset` paginates, `scope` narrows to a subtree, `full` ignores the scope |
| `browser_set_snapshot_scope` | Set a session-wide snapshot scope so *every* tool returns just that subtree |
| `browser_diff` | Verify the last action: what changed since the previous snapshot/diff |
| `browser_click` | Click by ARIA role+name (preferred) or raw Playwright selector |
| `browser_fill` | Fill a text input or contenteditable (never submits) |
| `browser_select` | Choose an option in a native `<select>` |
| `browser_scroll` | Scroll a container in steps to load lazily rendered content |
| `browser_scroll_into_view` | Scroll a specific element into view by role+name or selector |
| `browser_press` | Press a keyboard key (`Enter`, `Escape`, ...) |
| `browser_screenshot` | Viewport screenshot — fallback sense for oddly structured pages |
| `browser_tabs` | List open tabs |
| `browser_back` | Go back in history |
| `browser_open_human` | Hand the shared window to the human (logins, QR codes, captchas) |

Design notes: perception is ARIA-first (what the agent reads is exactly what it
can click); screenshots are the fallback. **No tool sends messages or submits
applications autonomously — send-class actions always go through the human.**

### Picking the right tool for a form control

Three controls look alike in a snapshot but fail in different ways, so they get
different tools:

| Control | Tool |
|---|---|
| Text input, textarea, `contenteditable` | `browser_fill` |
| Native `<select>` | `browser_select` |
| Typeahead / autocomplete listbox (LinkedIn company, location) | `browser_fill`, then `browser_press` `ArrowDown` + `Enter` |

`browser_select` only accepts a real `<select>`; point it at anything else and
it says which of the other two paths to take. Give it the option's visible text
(`Full-time`); its `value` attribute and a unique prefix (`Jan` → `January`)
also work, and a wrong value comes back with the actual option list.

### Keeping snapshots small

A full LinkedIn profile page is a 12k–30k-char ARIA tree when all the agent
needs is the open dialog. Two mechanisms cut that down:

```
browser_set_snapshot_scope  scope='div[role="dialog"]'
```

Every tool that returns a snapshot (navigate/click/press/select/snapshot/back)
then returns only that subtree until you clear it. If the selector stops
matching — the dialog closed — snapshots fall back to the full page and say
`scope missed, full page` rather than silently returning nothing. Pass `scope`
to `browser_snapshot` directly to override it for a single call (`body` forces
a full read).

Second, Playwright's ARIA snapshot enumerates every `<option>`, so one year
picker (1926–2026) costs more than the dialog around it. Option lists longer
than 10 collapse to a summary line:

```
- combobox "Start year": [102 options collapsed, selected "2019"] — set it with browser_select
```

Short lists stay expanded, and typeahead `listbox` popups are never collapsed —
reading the filtered suggestions is the whole point of that interaction. To see
a collapsed list, scope a snapshot at that select (`scope: '#start-year'`), or
just call `browser_select`, which reports the real options when it misses.

On the LinkedIn *Add experience* form this takes the worst tool result from
~12,000 chars to under 1,700.

### Lazy lists: the failure that doesn't raise

A LinkedIn search page holds 25 results but renders about 10; the rest are empty
`<li>` placeholders. The snapshot comes back well-formed, so an agent reads it
as "the list ends here" — a complete-looking, incomplete answer. Every other gap
in this toolset announces itself with an exception; this one does not.

Two halves to the fix. Empty container nodes are marked in the snapshot, and the
header says the list is unfinished:

```
incomplete: 15 node(s) marked [not rendered] — rows exist but their content has not
loaded. This list is NOT finished; call browser_scroll (to='bottom', steps=5) ...
---
- listitem [not rendered]
```

And `browser_scroll` loads them:

```
browser_scroll  selector='.scaffold-layout__list'  to='bottom'  steps=5
```

- **Pass `selector` when the page itself scrolls.** Auto-detection uses the
  document when it scrolls and the largest inner scroller otherwise, so on a
  layout that has both — LinkedIn — it scrolls the page and loads nothing.
- **Steps matter.** Jumping straight to the bottom often loads nothing: an
  IntersectionObserver that never observes an intersection never fires. The
  travel is split into increments with a render pause between them, and the
  target is recomputed each step because the content grows underneath. In the
  golden set a one-shot jump leaves 10 of 25 rows unrendered; 5 steps leaves 0.
- **`browser_press('End')` is not a substitute** — it acts on whatever has
  focus, which is why it only ever worked by accident.

The result reports whether anything actually loaded, counting both new elements
and new height (placeholder rows already occupy their final height, so height
alone would miss them):

```
loaded: nothing new — at the bottom with no growth, so this really is the end of the list
```

`browser_scroll_into_view` takes role+name or a selector, for reaching a known
target rather than sweeping a container.

### Verifying that a step actually worked

Tools report success on the *call*, not on the *result*. Two silent failures
seen on LinkedIn: `browser_fill` appended into a contenteditable instead of
replacing (`"Fullstack EngineerStaff Engineer"`), and a Ctrl+A/Delete pair
failed to clear a field so the next fill appended again. Both tool calls
returned success.

`browser_diff` is the check. Take a `browser_snapshot` to set a baseline, act,
then diff:

```
~ [9] textbox "Headline": value "Fullstack Engineer" → "Fullstack EngineerStaff Engineer"
- [24] dialog "Add experience" (+264 descendants)
+ [3/1] option "Ant Group" (aria-pressed=true)
```

The most important answer it gives is `no changes` — spelled out, never an
empty string, because that means your last action had **no effect**.

Details that matter:

- Nodes are paired by **keyed sibling alignment**, never by a global role+name
  lookup. LinkedIn's company picker renders three buttons all named "Ant
  Group"; a global lookup mixes them up by construction. Alignment runs only
  between the children of two already-paired parents, and tells duplicates
  apart by their ordinal in that list — so inserting one row into the middle
  of a list is reported as a single `added`, not as a cascade of renamed
  siblings. Paths like `2/4/1` are addresses in the output, not the pairing
  mechanism.
- The model is read from the DOM, not from the ARIA tree, so it carries
  `value` for inputs, selects and contenteditables. The ARIA tree omits
  contenteditable text entirely — the exact field the append bug lived in.
- A subtree that appears or vanishes is reported at its root with a
  descendant count, not as hundreds of lines.
- Scope is applied first, then the diff. On a real page the ads, "People you
  may know" and notification counts churn on every render; scope removes the
  irrelevant regions, the diff removes the unchanged ones. That order is not
  interchangeable.
- It falls back to a plain full snapshot — saying why — when there is no
  baseline, after navigation, when the scope or URL changed, when the baseline
  is over 5 minutes old, or when the diff would not be smaller than the
  snapshot (`diff too large, returned full snapshot`).

`browser_snapshot({ full: true })` forces a complete page read, ignoring the
scope, and leaves the baseline untouched so it does not disturb a verification
in progress.

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
npm run golden                     # golden set: LinkedIn "Add experience" replica
npm run golden:lazy                # golden set: lazy-loaded search results
npm run roundtrip                  # real MCP stdio round-trip
npx tsx scripts/attach-test.ts     # auto-spawn + attach path
```

`npm run golden` is the regression gate for form automation: a hermetic replica
of LinkedIn's *Add experience* dialog carrying all three control types at once,
driven through the real MCP server over stdio. It asserts the tool contract
(including error strings) and enforces the token budget — no tool result in the
scoped flow may exceed 2000 characters.

It also asserts *what each step should change in the DOM*, via `assertDiff`:

- an empty diff is a hard failure — the step silently did nothing;
- an unmet expectation is a hard failure;
- changes beyond what was expected are flagged for manual confirmation rather
  than failed, since the page structure may simply have moved on.

The fixture deliberately includes a headline field that appends instead of
replacing, and one case asserts that `assertDiff` *catches* it — a golden set
that cannot detect the known-bad behaviour is not protecting anything. After
changing a prompt or a selector, this pinpoints which step regressed instead of
leaving you to judge the final state.

`npm run golden:lazy` covers the search-results shape: a list whose rows are
filled by an IntersectionObserver, inside an inner scroll container, on a page
that also scrolls. It asserts the placeholder marking, that auto-detection
scrolls the page rather than the list, and that a stepped scroll loads rows a
one-shot jump misses.

`golden` and `roundtrip` use their own CDP port and profile, so they never
disturb the browser you are working in. In headless environments, set
`CHROME_PATH` and `JOB_AGENT_SPAWN_ARGS="--headless=new,--no-sandbox"`.

## Roadmap

- [ ] `browser_tab_select` — explicit tab targeting (the "last tab" heuristic is fragile)
- [ ] Domain tools: `search_jobs` / `extract_jd` on top of the atomic tools
- [x] Golden-set regression: LinkedIn *Add experience* form (`npm run golden`)
- [x] Golden set for lazy-loaded search results (`npm run golden:lazy`)
- [ ] Golden set for JD extraction pages
- [ ] Screenshot-based extraction for fields not exposed in the ARIA tree
      (contenteditable text is one — the ARIA tree omits it entirely)
- [ ] Standalone agent loop + CLI as an alternative decision layer
