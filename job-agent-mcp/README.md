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
| `browser_upload_file` | Attach local file(s) to a file input, including hidden ones |
| `browser_scroll` | Scroll a container in steps to load lazily rendered content |
| `browser_scroll_into_view` | Scroll a specific element into view by role+name or selector |
| `browser_press` | Press a keyboard key (`Enter`, `Escape`, ...) |
| `browser_screenshot` | Viewport screenshot — fallback sense for oddly structured pages |
| `browser_tabs` | List open tabs, marking the active one |
| `browser_select_tab` | Choose which tab every tool acts on (index / url / title) |
| `browser_new_tab` | Open a tab and make it active |
| `browser_close_tab` | Close a tab by index |
| `browser_back` | Go back in history |
| `browser_open_human` | Hand the shared window to the human (logins, QR codes, captchas) |

Design notes: perception is ARIA-first (what the agent reads is exactly what it
can click); screenshots are the fallback. **No tool sends messages or submits
applications autonomously — send-class actions always go through the human.**

**Human verification is a boundary, not a gap.** Nothing here solves or works
around CAPTCHAs or Cloudflare Turnstile; that is what they are for. The agent's
job ends at *the form is filled in, stopped before submit* — that is the
successful outcome, not a partial one.

### Picking the right tool for a form control

Three controls look alike in a snapshot but fail in different ways, so they get
different tools:

| Control | Tool |
|---|---|
| Text input, textarea, `contenteditable` | `browser_fill` |
| Native `<select>` | `browser_select` |
| Typeahead / autocomplete listbox (LinkedIn company, location) | `browser_fill`, then `browser_press` `ArrowDown` + `Enter` |
| File input, visible or hidden behind a styled button | `browser_upload_file` |

`browser_select` only accepts a real `<select>`; point it at anything else and
it says which of the other two paths to take. Give it the option's visible text
(`Full-time`); its `value` attribute and a unique prefix (`Jan` → `January`)
also work, and a wrong value comes back with the actual option list.

### Reading form fields accurately

The raw ARIA tree loses three things that decide whether a form gets filled
correctly, so snapshots annotate `textbox` lines from the DOM:

```
- textbox "Why do you want to work here?" [input, maxlength=120, 34 used]: ...
- textbox "Cover letter" [textarea, maxlength=5000, 58 used]: Dear team,⏎⏎I have shipped...
- textbox "Additional notes" [contenteditable]: Para one⏎Para two
```

- **`<input>` and `<textarea>` are otherwise identical** in the tree, both just
  `textbox`, and maxlength is invisible. A long answer written into a capped
  single-line input is silently cut at submit time.
- **Newlines were flattened to spaces.** That once produced a false bug report
  about a mangled field that was actually fine. They now show as `⏎`.
- **Long values** end with `… [truncated, 900 chars total]` rather than simply
  stopping, which looked like the field held only that much.
- **contenteditable values** were omitted entirely; they now appear.

Annotation is matched by accessible name and only when that name is unique
among the page's fields — a positional match would be faster but could pin the
wrong maxlength to a field, and wrong metadata is worse than none.

### Uploading files

```
browser_upload_file  selector='label.choose-resume'  path='/abs/path/resume.pdf'
```

It always drives the `<input type=file>` via `setInputFiles` and never clicks
the visible control, because that opens the OS file dialog, which is outside
the page and cannot be automated. Two things make the field hard to even find,
both handled:

- a **visible** file input appears in the snapshot as a `button`, not a textbox;
- a **hidden** one (`display:none`, the Workable shape — a styled "Choose file"
  label plus a drop zone) does not appear in the snapshot **at all**.

So point it at whatever is visible — the label, the button, the drop zone — and
the associated input is resolved from there. `paths: [...]` attaches several at
once. Missing files are a hard error, and the result reports the file names the
input actually holds, so an upload that did not land cannot look like one that
did. The search refuses to climb past `<form>` and refuses ambiguous matches:
attaching a resume to the wrong field silently is worse than an error.

### Working with several tabs

Tools act on one explicitly selected tab:

```
browser_select_tab  urlPattern='/apply'
```

Without this, tools fall back to "the last tab" — so a form open in tab 0 with
the user's own browsing in tab 1 is simply unreachable, and re-navigating to the
form's URL to reach it reloads the page and discards everything already typed.
Selection sticks until changed; `browser_tabs` marks the active tab with `*`.
Select by `index`, `urlPattern` or `titlePattern` (case-insensitive regex; a
plain substring works). An ambiguous pattern is refused rather than guessed.

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
npm run golden:apply               # golden set: Workable application form
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

`npm run golden:apply` covers the application-form shape: a resume input hidden
behind a styled label and drop zone, a second tab competing for the tools, and
fields whose type, maxlength and newlines the raw ARIA tree loses. It asserts
that switching tabs does not lose typed answers, that uploads reach the page,
and that a misdirected upload errors instead of silently attaching to the wrong
field. It carries a Turnstile widget that the suite never touches.

`golden` and `roundtrip` use their own CDP port and profile, so they never
disturb the browser you are working in. In headless environments, set
`CHROME_PATH` and `JOB_AGENT_SPAWN_ARGS="--headless=new,--no-sandbox"`.

## Roadmap

- [x] Explicit tab targeting — `browser_select_tab` (the "last tab" heuristic was fragile)
- [ ] Domain tools: `search_jobs` / `extract_jd` on top of the atomic tools
- [x] Golden-set regression: LinkedIn *Add experience* form (`npm run golden`)
- [x] Golden set for lazy-loaded search results (`npm run golden:lazy`)
- [x] Golden set for the Workable application form (`npm run golden:apply`)
- [ ] Golden set for JD extraction pages
- [ ] Screenshot-based extraction for fields not exposed in the ARIA tree
      (contenteditable text used to be one; that is now handled by field annotation)
- [ ] Standalone agent loop + CLI as an alternative decision layer
