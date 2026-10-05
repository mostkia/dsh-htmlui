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
| `inline` | The document renders at the end of the turn that attached it, seamlessly: no chrome, no border, no background, height taken from the document (680×383 measured). It scrolls only past the height cap |
| `dock-right` | The session's right column opens a tab hosting it (851×830 measured): seamless, no title of its own, and **no controls inside the surface** — the tab's own close is the one control. Closing that tab retires the session's right-column interfaces (after a delay that a mere column hide or session switch survives), so the session page cannot list surfaces nothing can show. The tab itself is registered only while something needs it: with no `dock-right` record the column holds **no HTML UI page at all**. While that column cannot open a tab (no controller bound) it falls back to the wide dock above the composer, never to both |
| `float` | A window that drags by its **title text** and resizes from the corner (arrows work on the focused handle); `size` sets where it starts. The ✕ closes it for good: the record leaves the host store |
| `fullscreen` | The surface covers the **conversation column**, not the frame: the left sidebar keeps its width and stays usable (measured from our own seat inside the column, so no other plugin's DOM is read). "Back to chat" gives the chat back while **keeping** the record; ✕ deletes it |
| Session page | The conversation's view row carries an `HTML UI` page listing this session's interfaces with a `Remove` per row and `Remove all` — the only way to take away a click-through `background` layer or a seamless `inline` one |
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

## 3. The template drawer

The composer carries a `⟨/⟩ 模板` control. Open it and check:

- The catalogue lists the packaged `starter` template (marked 自带) plus anything
  you saved.
- **套用** puts a surface in the session immediately — no model turn, no message
  in the transcript. Ask the model for `html_ui op=list` and it should name the
  new id.
- **交给模型** fills the composer draft with an instruction instead of sending it.
- With the drawer closed, nothing extra occupies the composer.

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

## 6. Triage

| Symptom | Likely cause | Check |
|---|---|---|
| Tool missing from the agent's list | Host half not activated | `/health`, then cold-start |
| Card renders, the frame says "HTML UI unavailable" | Ticket refused or the document is gone | Console network tab: `/ui/ticket` status; `/health` counts |
| Frame blank, console reports a CSP violation | The document loads a third-party origin | The carrier allows only this host; fetch through the model instead |
| An interaction does nothing | The document never called `dshHTML.send`, or it errored | The document's own console; `dshHTML.lastError()` |
| A surface stays after `op=close` | Another page closed it and this one has not synced | Reload; it converges on `/ui/list` |
| An image or font inside a document 404s | A relative URL resolves against the carrier, not the workspace | Use an absolute URL or a data URL |
| 403 on every carrier route | The page's origin is not loopback and is not listed | `/health` → `trust`, then `config.allowedOrigins` |
