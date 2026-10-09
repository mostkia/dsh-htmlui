# Acceptance checklist

What to run and what to expect. Every step is observable from the outside; none
of it needs a debugger. `$PORT` below is the DSH web port (3080 by default), and
`$ROOT` is the plugin data root (`$DSH_HOME/htmlui` unless `config.root` says
otherwise).

## 0. Which generation is live

The host half only adopts new code on a cold start: a running host keeps the
module generation it activated, and re-enabling the bundle does not replace it.

```sh
curl -s http://127.0.0.1:$PORT/plugins/@mostkia/dsh-htmlui/health
```

Expect `"version"` to match `package.json`, plus the placement list, the trust
posture (`loopbackOnly`), and the interface/template/stream counts. In the page
console, expect `[dsh-htmlui] client active (<version>)` after a refresh.

If `/health` 404s, the host is still running an older generation: cold-start
`dsh` and check again.

## 1. Host half, no browser needed

```sh
# the carrier answers and names its version
curl -s http://127.0.0.1:$PORT/plugins/@mostkia/dsh-htmlui

# a document needs a ticket; without one the address is refused
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/plugins/@mostkia/dsh-htmlui/ui/ui-00000000
# expect 403
```

An agent in any session can then attach an interface with the `html_ui` tool and
will see a protocol block back:

```
[html-ui]
status=ok
op=render
ui_id=ui-xxxxxxxx
placement=dock-right
next=update it later with html_ui op=update id=ui-xxxxxxxx
```

## 2. Forms, in the page

Attach one of each and confirm it appears where its placement promises:

| Placement | What to look for |
|---|---|
| `inline` | The document renders at the end of the turn that attached it, seamlessly: no chrome, no border, no background, height taken from the document (680×383 measured). It scrolls only past the height cap. A template applied from the drawer was attached by no call, so it lands at the end of the last turn that had *closed* when it was applied — and, like a tool-created one, it stays there |
| `dock-right` | The session's right column opens a tab hosting it (851×830 measured): no title row of its own, and **each object keeps a faint ▾ collapse and ✕ close** in the corner — the column can hold several independent surfaces, so one of them being in the way must not close the tab for all of them. Closing the tab itself retires the session's right-column interfaces (after a delay that a mere column hide or session switch survives), so the session page cannot list surfaces nothing can show. The tab is registered only while something needs it: with no `dock-right` record the column holds **no HTML UI page at all**. While that column cannot open a tab (no controller bound) it falls back to the wide dock above the composer, never to both |
| `float` | A window that drags by its **title text** and resizes from the corner (arrows work on the focused handle); `size` sets where it starts. The ✕ closes it for good: the record leaves the host store |
| `fullscreen` | The surface covers the **conversation column**, not the frame: the left sidebar keeps its width and stays usable (measured from our own seat inside the column, so no other plugin's DOM is read). Its two controls are the float's: "Minimize" gives the chat back while **keeping** the record, and ✕ asks once before deleting it |
| Session page | The conversation's view row carries an `HTML programs` page listing one row per programme — resident processes in one group, this session's interfaces in another — with per-row `Minimize`, `Close UI` (which becomes `Restart UI`, asking where to put it) and `Close backend`; both destructive controls ask once, in place |
| `background` | A click-through layer over the frame (1920×919 measured, the whole frame because it has no chrome): the page under it still receives clicks |

Two constraints of the host layout, worth knowing before judging a failure:

- The fallback dock is rendered by the input dock, which the product mounts only
  while a composer for that session is on screen. In a state without one, a
  `dock-right` record has no seat and is simply not visible.
- A record created or closed *somewhere else* — another tab, or the model updating
  an interface whose card is scrolled out of the virtualized transcript — is picked
  up when the page loads its records (`/ui/list`), not live: the page keeps no
  session-level event stream. Inside a document, the model's output still streams
  live over that document's own SSE channel.
- The measurement to expect from a document is its own `innerWidth`/`innerHeight`.
  A first reading of `0×0` with `visibility: hidden` happens while a seat is still
  activating; the next reading settles. Do not judge a seat on one sample.
- **A window survives a Session switch.** Put something into a `float` (type into it,
  or scroll its document), switch to another Session, and switch back: the window is
  still there with its state, and its document never reloaded. `background` and
  `fullscreen` behave the same, and so does an `inline` document. The console names
  the mechanism — with `DEBUG_FRAMES` on, the session being left must log **no**
  `frame unmounted` for it.
- **An inline document is hosted, and you can see it.** It is drawn from the frame-wide
  layer and clipped to the transcript's own viewport, while the transcript keeps a seat
  of exactly its height (the seat carries `data-htmlui-inline-seat`, the host
  `data-htmlui-inline-host`). So, in a session holding one: scroll the transcript and the
  document stays glued to its place instead of floating over the composer; scroll its turn
  out of the virtualized window and it stops being painted (the document keeps running —
  nothing is unmounted); switch Session and come back, and it is there with whatever state
  it held. The seat reserves the room the document asks for, so the conversation around it
  does not move when it loads.
- **The wheel still works through an inline document.** With the pointer over a document that
  has nothing to scroll, the wheel scrolls the conversation as before; with the pointer over a
  document that *can* scroll (or one of its inner lists), the document keeps the wheel and the
  conversation does not move. Past the end of either one the delta carries on, which is the
  chain the frame had when it was a child of the transcript. The bridge forwards only what the
  document could not use, and the host applies it to the transcript.
- **The document never paints over the input box.** The composer is drawn *over* the
  transcript, so the band a hosted document is clipped to ends where the composer begins:
  scroll a session with an inline document to its very bottom — the document is cut off at the
  input box and the input box stays fully usable.
- **The height convention still holds.** A document taller than the cap (640 px, `INLINE_MAX_HEIGHT`)
  is drawn at the cap and scrolls *inside its own frame*; an ordinary one is drawn at whatever it
  measured; a very short one keeps a 60 px floor; and a document that reports nothing — everything
  in it is `position: absolute`/`fixed`, so it has no measurable height — gets the 220 px default
  box. The seat in the transcript reserves exactly the height the frame draws, because one function
  answers for both, so the conversation around it never shifts when the document loads.
- **The phone has two gates, and they are deliberately different.** The layout breakpoint is
  `max-width: 640px` (`MOBILE.maxWidthPx`): below it the composer entry collapses and the create
  dialog is a bottom sheet, with every one of its phone values read from the single `MOBILE` object
  in `client.js`. The z-index lift our injected stylesheet gives the shell's chrome uses the
  *shell's* own gate instead — `max-width: 1023px` **and** `pointer: coarse` — because that
  stylesheet exists only to out-rank the shell's mobile navigation, which appears under exactly
  those two conditions. So a narrow window with a mouse has the sheet and no lift, while a wide
  touch screen has the lift and no sheet. Judge a mobile defect inside the gate that owns it, and
  expect the desktop values at every width above 640 px.
- **The sheet's fields keep the size this plugin gave them.** Another installed plugin holds every
  text field on the page at 16px with `!important` on iOS — so Safari cannot focus-zoom — and it
  leaves `select` out on purpose. Inside the create sheet that used to mean 16px text inputs beside
  12px selects. The sheet's own sizes (12px, and 11.5px for the directory row below the layout
  breakpoint) are therefore restated by a second injected stylesheet, scoped to the dialog's id and
  gated on the same mobile query. Expect one size inside the sheet on every engine: the `select`
  controls read 12px like the text fields, the directory field stays smaller, and nothing outside
  the dialog is touched.

## 3. The template drawer

The composer carries a `⟨/⟩ 模板` control. Open it and check:

- The catalogue lists the packaged `starter` template (marked 自带) plus anything
  you saved.
- **套用** puts a surface in the session immediately — no model turn, no message
  in the transcript. Ask the model for `html_ui op=list` and it should name the
  new id.
- **交给模型** fills the composer draft with an instruction instead of sending it.
- With the drawer closed, nothing extra occupies the composer.
- **The applied surface stays put.** Start a turn, then 套用 a template while the
  answer is still streaming: it appears at once, in the transcript where the
  conversation stood — and the answer *finishing* must not add a copy of it at the
  bottom. Talk to the model two or three more times: the surface stays exactly
  where it is and scrolls up with the transcript, and its document is never
  reloaded (console: one `frame mount` for that id, no later unmount/remount).
  This is the regression the "newest tail" election caused: an extra copy at the
  end of every answer.

## 4. The round trip

Inside a document, click a control wired to `dshHTML.send('name', {...})`.

- Expect the document's own status line to change immediately (local feedback).
- Expect a user message carrying `[html-ui:action] ui=… action="name"` and the
  payload, followed by the model's reaction.
- A control that only calls local logic must not produce such a message.

Then update the interface with `html_ui op=update`: the surface must reload and
show the new document without a manual refresh, in the tab that ran the call. A
tab that did *not* run it converges on its next `/ui/list` (page load), for the
reason noted under Forms.

## 5. Theme

Toggle the DSH theme. A document that reads `--dsh-htmlui-*` or calls
`dshHTML.theme()` must follow; the injected `data-dsh-htmlui-theme` attribute
flips with it.

## 6. A project's backend

A project may ship a `server.js` beside its `index.html`; the host runs it, and the project's own
documents call it with `dshHTML.app(...)` — no model turn and no tokens. Setting one up, in order:

1. Put `server.js` in the project folder and set `"backend": true` in its `meta.json` (`true` means
   `server.js`; a string names another file inside the project).
2. Open the project's pencil — or adopt a folder that ships one — and tick **Run this project's
   backend**. The catalogue reports both facts as `backend.declared` and `backend.allowed`, and the
   form offers the tick only when the first is true.
3. Render the project and run `await dshHTML.app('ping')` in the document's own console.

What to expect:

- Before step 2 the same call answers `403`, with a message naming the project. After it, the
  backend's own value comes back; un-ticking the switch stops it on the next call, not on the next
  restart.
- A backend keeps state between calls: a counter in its module increments across two calls. Edit
  `server.js`, call again, and the edited file answers — no cold start and no page refresh.
- `curl -s http://127.0.0.1:$PORT/plugins/@mostkia/dsh-htmlui/health` lists it under `backends`
  with `calls` and `failures`; a loaded backend is visible nowhere else.
- A handler that throws answers `500` with its message in `detail`; one that never resolves answers
  `504` after `appTimeoutMs` (ten seconds by default) — the panel is told, not left waiting.
- A document from another project cannot reach it: the route is keyed by the calling document's own
  id, so the project comes from the record, never from the request.
- **Residency.** Set `backendIdleMs` to `20000` in the plugin settings, give a project's `server.js`
  `resident: true`, and call it once: `/health` shows it with `resident: true` and `declaredResident:
  true`, and the catalogue row reads `backend: { declared: true, allowed: true, resident: true,
  loaded: true }`. Close its panel, wait past the idle delay, and it is **still** listed and still
  doing its work (its own timer keeps firing). Tick residency off in the form, or press **Stop
  backend** in the manager (or in the drawer row), and it is gone from `/health` immediately while
  `allowed` stays true — opening the project again loads it again. Restore `backendIdleMs` after.
- Residency is per project and belongs to the reader: a project that declares it can still be held to
  the idle rule by turning the switch off, and the answer survives a restart in `settings.json`.

## 7. Triage

| Symptom | Likely cause | Check |
|---|---|---|
| Tool missing from the agent's list | Host half not activated | `/health`, then cold-start |
| Card renders, the frame says "HTML UI unavailable" | Ticket refused or the document is gone | Console network tab: `/ui/ticket` status; `/health` counts |
| Frame blank, console reports a CSP violation | The document loads a third-party origin | The carrier allows only this host; fetch through the model instead |
| An interaction does nothing | The document never called `dshHTML.send`, or it errored | The document's own console; `dshHTML.lastError()` |
| A surface stays after `op=close` | Another page closed it and this one has not synced | Reload; it converges on `/ui/list` |
| An image or font inside a document 404s | A relative URL resolves against the carrier, not the workspace | Use an absolute URL or a data URL |
| 403 on every carrier route | The page's origin is not loopback and is not listed | `/health` → `trust`, then `config.allowedOrigins` |
| `dshHTML.app` answers 403 | The project ships a backend but the reader has not allowed it | The project's pencil → the backend switch; `/templates` reports `backend.declared` / `.allowed` |
| `dshHTML.app` answers 404 | The manifest declares no backend, or the file it names is gone | `meta.json`'s `backend`, and the file it points at |
| `dshHTML.app` answers 504 | The handler did not answer inside `appTimeoutMs` | The handler's own timing; raise `appTimeoutMs` for a slow API |
| A backend keeps running after its panel is closed | It declared `resident: true` and the reader's answer allows it | Expected; press **Stop backend** in the manager or the drawer row, or switch residency off |
| A resident backend never picks up an edit | A resident module is only reloaded when something calls it | Call it once (open the panel), or stop it and let the next call load the new file |
| A stopped backend came back | Opening the project again loads it; a rule stored by the app may resume its work | `POST /templates/backend/stop`, and stop the work in the app itself |
