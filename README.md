# @mostkia/dsh-htmlui

English | [中文](README.zh.md)

**An HTML UI layer for DeepSeek Harness 🎉**

HTML can be inserted into the conversation stream, run as a window, docked in the
right column, taken fullscreen, or mounted behind everything (experimental). It is
deeply integrated with the agent: the model authors HTML templates directly, and
the layer between model and DSH turns them into interactive panels that automate
long, repetitive, fixed workflows — with none of the inefficiency or imprecision of
describing the same thing in words again.

It also hosts practical HTML tools, and those tools can be handed to the agent to
improve. Custom templates can be uploaded and kept, permissions are managed per
project, and the whole thing is meant to make your DSH workspace nicer and faster —
one plus one, more than two.

## What it looks like

| Inline, straight into the stream | Docked in the right column (collapsible, several at once) |
|---|---|
| ![inline](docs/images/01-inline.png) | ![right column](docs/images/02-dock-right.png) |

| Floating window (draggable, several at once, minimizable) | Fullscreen (several at once, minimizable) |
|---|---|
| ![float](docs/images/03-float.png) | ![fullscreen](docs/images/04-fullscreen.png) |

| HTML session management (several open, still manageable) | Import a project and set its permissions |
|---|---|
| ![session manager](docs/images/05-session-manager.png) | ![import and permissions](docs/images/06-import-and-permissions.png) |

| One click from the composer | A project can carry anything — here, Live2D streaming |
|---|---|
| ![one click](docs/images/07-one-click-deploy.png) | ![live2d](docs/images/08-live2d.png) |

## Highlights

- **HTML, rendered globally.** In principle any HTML/CSS/JS — canvas, WebGL, video,
  a third-party library, a whole application.
- **Plenty of places to live.** `inline` in the conversation, `dock-right` in the
  session's column, a draggable `float`, a `fullscreen` surface, and a click-through
  `background` layer.
- **Two-way, without polling.** A document calls `dshHTML.send(...)` and the action
  reaches the model as a message; the model streams data back over SSE and the page
  updates in place, as it arrives.
- **A template library you import and export.** Point the plugin at a directory of
  HTML projects, move one in or out, keep a useful tool for the next session — and a
  template can be created **with no model round trip at all**.
- **Permissions per project.** Levels let safety and capability meet at a point you
  choose, project by project.
- **A session page, not a hidden store.** `HTML管理` lists every interface in this
  session with its placement and source project, and can hide, restore or remove it;
  records are kept host-side and bound to the session.
- **Sandboxed by construction.** Documents run in an opaque-origin iframe and are
  reached through a per-document capability token, which keeps DSH's own content
  safe. (A sandbox cannot stop you from granting unrestricted permissions — do that
  only with care.)

## Five placements

| `placement` | Where it lives |
|---|---|
| `inline` | In the transcript, at the end of the turn that attached it: seamless — no chrome, no border, no background, height taken from the document itself |
| `dock-right` | The session's right column: a real left/right split (the widest surface), as a tab hosting this session's right-placed interfaces. Falls back to the wide dock above the composer while the column cannot open a tab |
| `float` | A draggable, resizable window (`size: "520x360+80+60"`). **Minimizing keeps the document alive**, so showing it again loses nothing that was typed into it |
| `background` | A full-frame, click-through layer at a fixed 25% opacity, so the interface underneath stays readable. It belongs to no view — close it from the session page when you are done |
| `fullscreen` | Covers the session, with a built-in switch back to chat. Surfaces stay mounted while you are elsewhere, so returning does not reload them |

A document can declare its own placement instead of the caller naming it — useful
for a template, which then carries its home with it:

```html
<meta name="dsh-htmlui" content="placement=dock-right; size=520x360; title=Orders">
```

The tool argument wins over the declaration, the declaration wins over the
`inline` default, and an unusable value is ignored.

## Install

```sh
dsh plugin --profile web add @mostkia/dsh-htmlui
```

No npm needed either — straight from the repository:

```sh
dsh plugin --profile web add github:mostkia/dsh-htmlui
```

Requires DSH `>=0.1.7-0` (the pre-release line is included on purpose, so
`0.1.7-rc.*` installs too). Hard-refresh the page after installing; when the
browser half activates it logs `[dsh-htmlui] client active (0.1.0)` to the console.

The easiest way to confirm which generation a running host actually has:

```sh
curl -s http://127.0.0.1:3080/plugins/@mostkia/dsh-htmlui/health
# {"ok":true,"plugin":"@mostkia/dsh-htmlui","version":"0.1.0",...}
```

Changing the host half (`index.js`) does **not** take effect in a running host: the
loader keeps the module generation it activated. Restart `dsh` for the host half;
the browser half only needs a page refresh.

[docs/VERIFY.md](docs/VERIFY.md) is the on-machine acceptance checklist: which
generation is running, what each placement should look like, how the round trip
shows up in the conversation, and what to inspect for a given symptom.

## How it works

- **Host half** (`index.js`, plain ESM, zero dependencies): the two tools
  (`html_ui` / `html_ui_template`), storage under `$DSH_HOME/htmlui`, and an HTTP
  carrier mounted at `/plugins/@mostkia/dsh-htmlui` — document tickets, the composed
  document, per-session listing, the template directory and its use, the POST action
  channel, the SSE event stream, and a health probe. Every route is governed by the
  policy described under [Security](#security).
- **Browser half** (`client.js`, a hand-written module, no build step): registers the
  tool card, the composer dock, the frame-wide overlay, and puts each document in an
  iframe.
- **Bridge** (`assets/bridge.js`, injected when served): exposes `window.dshHTML`
  with `send`, `state`, `resize`, `close`, `on(...)` and `ready(...)`. Visible text
  in the interfaces goes through the client locale service (en/zh dictionaries
  ship with the package), falling back to English constants when it is absent.

**The model never receives the document body**: it reads a compact summary of the
tool result (`ui_id` / `placement` / `bytes` / revision), while the browser loads the
document itself from the carrier's ticket route. Large documents go to a file and are
referenced with `path`, so they never sit in the model's context.

## Security

Documents run in an iframe with
`sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"`
and **without** `allow-same-origin`: an opaque origin, no cookies, no local storage,
no access to the host page. Each document carries a capability token derived from it
(an HMAC over the plugin's local secret), and the document, action, state and SSE
routes are all gated by it. That token appears in exactly one place — the iframe URL
handed out by the ticket route — so tool results, session logs, list responses and
event-stream frames never contain it, and an address without it cannot load at all.

A strict CSP travels with every document. Note that a sandboxed frame without
`allow-same-origin` is an **opaque origin**, and an opaque origin matches no URL, so
**every same-origin allowance names this machine's own origin explicitly rather than
`'self'`** — `script-src` being the one that lets the injected bridge load.

The carrier's own policy: only loopback Host/Origin pairs are trusted; an
opaque-origin frame must present a valid token; cross-site ticket requests are
refused outright; writes are POST only; and each document gets a small token bucket
so a script cannot flood the model. Nothing secret belongs in a document, and the
plugin never asks for one.

**What this boundary covers, and what it does not.** Loopback *is* the trust boundary,
and it is worth saying plainly: a request with **no `Origin` header at all** (curl, a
script, another local process) is treated as trusted — a local process already has
everything the user has. The carrier cannot tell the DSH page apart from such a
caller, so it chooses to **narrow the blast radius** instead of pretending to
authenticate: the page-facing listing route must name its session explicitly, ticket
issuance is rate-limited per document, and a document's capability token dies the
moment its interface is closed or superseded. Against a **browser** attacker it is a
different matter, and there it refuses everything: other origins are rejected, a
sandboxed frame in someone else's page has no token, and a Host name obtained by DNS
rebinding fails the loopback check. If you intend to serve this beyond loopback, read
the `allowedOrigins` section below — that is the switch that moves the trust boundary.

If DSH is deliberately exposed beyond loopback (`webServer.host: 0.0.0.0`, a LAN
address, a reverse proxy), the browser origin is one the default policy refuses and
the whole plugin answers 403. Naming that origin in `allowedOrigins` trusts it — that
one origin, and nothing else:

```yaml
      config:
        allowedOrigins:
          - http://dsh.lan:3080
```

`/health` reports `trust.loopbackOnly` and how many origins are listed, so the
current posture never has to be guessed.

## Configuration

All row configuration is optional, and none of it needs a machine path:

```yaml
- insert:
    - id: dsh-htmlui
      name: '@mostkia/dsh-htmlui'
      config:
        root: ''              # storage root, defaults to $DSH_HOME/htmlui
        maxInlineBytes: 16384 # cap on one inline html/css/js fragment
        actionPrompt: ''      # sentence appended to an [html-ui:action] message
        allowedOrigins: []    # extra trusted browser origins (see Security)
```

Runtime data lives under `$DSH_HOME/htmlui`: `ui/<id>/index.html` (the document as
authored — clean and portable on disk, with nothing injected into it),
`templates/<name>/` (hosted templates) or `templates/<name>.html` (hand-written ones),
`state/<session>.json`, and `secret`, which backs the capability tokens. Deleting a
`ui/<id>/` directory by hand is always safe: the record goes with it and the interface
disappears from the session. (Records whose session no longer exists are kept rather
than collected, so an interface never vanishes just because its session was archived.)

## Templates

```
html_ui_template { "op": "save", "name": "orders-dashboard", "ui_id": "ui-1a2b3c4d" }
html_ui { "op": "render", "template": "orders-dashboard", "variables": { "title": "Orders this week" } }
```

`{{token}}` placeholders are replaced from `variables`. Templates outlive a session.

**Hand-written documents are templates too**: drop `my-panel.html` into
`<root>/templates/` and call it with `template: "my-panel"` — no manifest to write. A
hosted template of the same name wins, and removing it uncovers the hand-written file
again.

Beside the composer is the way in: **`⟨+⟩ New HTML`** opens the create dialog, which
lists the projects in your templates directory, lets you **apply one to this session
with no model round trip at all**, and offers the create flow for a blank canvas, a
project, or a folder you just copied in. What it creates is an ordinary record: the
model sees it in `html_ui op=list`, and can update or close it.

## Development

```sh
npm test        # 158 assertions: package integrity 13 + doc contract 10 + host 40 + browser 38 + bridge 11 + shallow render 29 + adversarial input 10 + packed artefact 2 + harness schema 5
npm run check   # syntax-checks the three shipped scripts, then runs the tests
```

Neither half has a build step: the host half is plain ESM, and the browser half is the
module the loader materializes directly. Both are plain JavaScript, neither depends on
the harness module graph at runtime, and the plugin itself has zero dependencies. CI
runs the same suites on Ubuntu and Windows across Node 22 and 24
(`.github/workflows/ci.yml`). Release steps and the prepared awesome-dsh-plugin entry
are in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

MIT
