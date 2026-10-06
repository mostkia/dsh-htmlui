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

The final sweep checked one placement at a time, each with its own document
reporting its own measurements and its own button, so a failure could not be
attributed to the wrong surface.

| Placement | Reading | Verdict |
|---|---|---|
| `dock-top` | `1633×321, visible` | works, **since removed** |
| `dock-bottom` | `325×321, visible` (a narrower seat, as measured) | works, **since removed** |
| `dock-right` | `851×830, visible`; the tab opens itself | works |
| `panel` | `1633×321, visible` | works |
| `float` | `520×343, visible` for a requested `520x380+140+140` (343 = 380 minus its chrome); its ✕ drops the record from the host (`/ui/list` count 1 → 0) | works |
| `fullscreen` | `1920×882, visible`; "Back to chat" leaves the layer and keeps the record (host count stays 1); ✕ deletes it | works |
| `background` | `1920×919, visible` — the whole frame, because this layer has no chrome | works |
| `inline` | `680×383, visible`, rendered at the end of a turn | works |

The `inline` seat moved after this sweep. It rendered in whichever turn was newest, so an
interface applied while an answer streamed was redrawn — and its document reloaded — at
the bottom of the conversation as soon as that answer, and every later one, finished. It
now renders in the turn that owns it and stays there as the conversation grows;
[VERIFY.md](VERIFY.md) carries the check for it.

Sizes depend on the window; the pairs are what matter. `dock-top`/`panel` were the
same seat (1633 px wide here) and `dock-bottom` was a different and narrower one

## Removed after acceptance

`dock-top`, `dock-bottom` and `panel` are gone. They worked, and the user judged them
unsuitable: a surface that only takes height from the session view reads as a window
parked inside the conversation rather than part of it, and the same content is better
placed in the right column, which is a real left/right split. `inline` was reworked
instead — seamless, content-sized, rendered at the end of its turn — and `dock-right`
was made seamless too, since its tab already carries the title.
(325 px), and the two overlay layers differ by exactly one chrome row: `background`
fills all 919 px, `fullscreen` gives up 37 px to its title bar. That last number is
also the evidence for the single-title-bar fix: the same layer measured 845 px
before it, i.e. one extra row.

The nine self-checks that passed inside a live document: `window.dshHTML` exists,
version, `uiId`, `sessionId`, theme, `parent.document` access refused,
`localStorage` unavailable, state readable, SSE subscription available.

## Fixes this sweep produced

The one-at-a-time run found defects the earlier all-at-once run could not:

1. **A dock would not render at all** — `useRef`/`useCallback` sat after two early
   returns, which stayed invisible while the session never resolved. Once records
   matched, the hook count changed between renders and React raised error #310; the
   surface boundary turned that into a red line instead of silence, which is how it
   was found at all.
2. **A closed interface came back from its own transcript card** — a card keeps its
   meta forever, so it republished records the host had dropped. That produced a
   stale panel, an emptied right-column tab, and a frame stuck on a 404 ticket.
   The host is authoritative now: after a session syncs, a card may only publish an
   id the host listed or one created after that snapshot, and an id the host does
   not know is settled by asking again rather than by guessing from a timestamp.
3. **The float header swallowed its own buttons** — dragging captured the pointer on
   the whole header row, so the ✕ never received a click. The grip is the title text
   now, and a pointerdown on a button never starts a drag.
4. **A close carried no capability**, so the host refused every one with 403 and a
   working close button looked dead.
5. **One message key meant two things**, so a frame that failed to load blamed the
   template catalogue.
6. **A dock entry was squashed to its first row** when the composer's dock had other
   entries competing for height, which is what a drawer "flattened to its title bar"
   was.

## Seat notes

`inline` first rendered inside the tool call row, which **this GUI does not show**, so
the surface existed and could not be seen. It now renders in the newest turn's tail
(`conversation.chat.turnTail`), the slot every shipped in-flow feature uses, and the
tool row keeps a line naming it. That is one seat drawing the document, so a GUI that
does show tool rows cannot show two copies.

Scoping an interface to the turn that *created* it would need the record to carry that
turn, which is a host change. Rendering the session's inline interfaces in the newest
tail needs neither, and it is what a reader expects of "the current interfaces".

Two seat facts worth knowing, both measured rather than assumed:

- The dock above the input is the wide seat; the composer's own dock below it is much
  narrower (325 px against 1633 px in this run). They are not the same seat, and they
  are not the same width.
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
