# Live acceptance record

What was actually measured on a real deployment, as opposed to what the suites
assert. The suites cannot run a browser, so this file is the only place where a
browser's answer is recorded.

## Environment

| Item | Value |
|---|---|
| DSH | `0.1.7-rc.2`, profile `web` |
| Host | Windows, Node 24 |
| Plugin | installed with `plugin_manager install_bundle` from the workspace directory |
| Viewport | 1920×919 (reported by the documents themselves) |
| Data root | the profile's default `$DSH_HOME/htmlui` |

## Method

Two independent sources, neither of which trusts the other:

1. **The carrier, driven directly.** `POST /ui/list` was asked for the session's
   records over loopback, so the host's own view of the data could be compared
   with what the page rendered.
2. **A self-checking document.** A document reports its own measurements back
   through the action channel (`dshHTML.send`), which arrives as a
   `[html-ui:action]` message. It measures `innerWidth`/`innerHeight`,
   `document.visibilityState`, `dpr`, the bridge surface, and whether the sandbox
   actually isolates it (`window.parent.document` must throw, `localStorage` must
   be unavailable).

Every reading below is a machine value, not an impression.

## Results

| Placement | Reading | Verdict |
|---|---|---|
| `float` | `bridge: true`; the panel's own button returned `9/9` checks | works, end to end |
| `dock-right` | `851×830, visible` once its tab activated | works |
| `background` | `1920×919, visible` | works |
| `fullscreen` | `1920×845, visible` (74 px less than `background`: its chrome row) | works |
| `inline` | the document loaded; the card lives inside the tool row | works after the fix below |
| `dock-top` | first reading `0×0, hidden`; every later reading `769×321, visible` | works after the fixes below |
| `panel` | `769×321, visible` | works after the fixes below |
| `dock-bottom` | `293×321, visible` | works after the fixes below |

All eight placements reported a real size, from documents measuring themselves, on
the second live run. The three dock seats had never loaded before it.

The nine self-checks that passed inside a live document: `window.dshHTML` exists,
version, `uiId`, `sessionId`, theme, `parent.document` access refused,
`localStorage` unavailable, state readable, SSE subscription available.

Two seat facts worth knowing, both measured rather than assumed:

- The dock above the input is 769 px wide on a 1920 px viewport; the composer's own
  dock below it is 293 px. They are not the same seat, and they are not the same
  width.
- Frames were observed to remount in batches — several ids reloading within the same
  millisecond, and one id reloading while its revision never changed — which recreates
  the iframe and clears the document's own state. This run did not establish what
  triggers it; a console line per mount (`frame mounted <id>`) and one per URL change
  (`reloading the document <id>`) exist so the next run can. Whatever the trigger,
  `dshHTML.state` is the supported place for state that has to survive it.

Interpretation notes, because two readings are easy to misread:

- A document reporting `w=0 h=0` with `visibility: hidden` is **normal** during a
  mount or a tab activation: `dock-right` reported exactly that and then
  `851×830, visible` 20 ms later. A single such sample is not a failure. Judging a
  seat from one sample cost this run two wrong conclusions.
- The host reported eight records for the session with every placement correct
  throughout the run, so the data layer was never the problem.

## Defects this run found

1. **A docked interface rendered nowhere, silently.** The three dock seats never
   appeared. The live slot tree showed this plugin's dock entry `active: false`
   (rendering `null`) while its drawer entry in the same slot was active: the dock
   resolved its session from the owner props alone, and an input zone does not
   always carry one. The overlay and the drawer — the two seats that worked — fall
   back to the viewed session. Every seat now resolves the same way, and every
   registered surface is wrapped in an error boundary so a render failure becomes
   a visible line instead of an empty seat.
2. **An inline interface was invisible.** It renders inside the tool call row, and
   that row is collapsed by default. The card now asks the owner to open its row
   through the `useDisclosure` prop the tool-card contract provides.
3. **A theme switch reloaded every open document.** The ticket URL carried the
   theme, so a theme change changed `src` and the frame reloaded — the run shows
   four frames reloading in the same millisecond, which is exactly what that looks
   like from outside. The theme already travels over the init and theme messages,
   so the URL is no longer theme-specific.

All three were fixed in the client half and verified by the suites; the first two
are what the next live run should confirm.

## What this record does not cover

- Heights and the drag behaviour of the dock handle under a moving pointer (a
  single in-browser measurement settles it).
- Whether a right-column tab can ever open against a different session than the
  card's own.
- DSH versions above `0.1.7-rc.2`: `docs/COMPATIBILITY.md` records what was checked
  against `0.2.0-rc.2` by reading its published declarations, which is a weaker
  claim than a run.

## Repeating it

`docs/VERIFY.md` is the checklist. The self-checking document used here is a
throwaway; attach any document that calls `dshHTML.send` with its own measurements
and the readings arrive as messages.
