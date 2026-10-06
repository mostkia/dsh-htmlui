# @mostkia/dsh-htmlui

English | [中文](README.zh.md)

**HTML session UI for [DeepSeek Harness](https://github.com/deepseek-ai).** The
model authors HTML/CSS/JS, the plugin renders it in a sandboxed iframe attached
to the conversation, and interaction flows back to the model over POST + SSE.

`dsh-genui` renders a fixed, whitelisted component vocabulary from JSON. This
plugin renders the real thing: any HTML, any CSS, any script — placed where the
conversation needs it.

## What it looks like

| Rendering in the conversation | Docked in the right column |
|---|---|
| ![inline](docs/images/01-inline.png) | ![right column](docs/images/02-dock-right.png) |

| Floating window | Fullscreen |
|---|---|
| ![float](docs/images/03-float.png) | ![fullscreen](docs/images/04-fullscreen.png) |

| Session manager | Import a project, and set its permissions |
|---|---|
| ![session manager](docs/images/05-session-manager.png) | ![import and permissions](docs/images/06-import-and-permissions.png) |

| One click from the composer | A project can carry anything — here, Live2D |
|---|---|
| ![one click](docs/images/07-one-click-deploy.png) | ![live2d](docs/images/08-live2d.png) |

## Why it is different

- **Real documents, not a component vocabulary.** Any HTML, CSS and JavaScript —
  canvas, WebGL, video, a third-party library, a whole app.
- **Five places to live.** `inline` in the transcript, `dock-right` in the session's
  own column, a draggable `float`, a fullscreen surface, and a click-through
  `background` layer.
- **Two-way, without polling.** A document calls `dshHTML.send(...)`; the action
  reaches the model as a message. The model streams values back over SSE, and the
  page updates in place — live counters keep counting while the model is quiet.
- **Your own folder is the catalogue.** Point the plugin at a directory; every
  project inside appears in the picker. Import one with a pencil, edit its manifest
  in a form (name, process id, description, default placement), and create from it
  **with no model round trip at all**.
- **Per-project permissions.** Each imported project declares how much its
  documents may do — one self-contained document, its own files beside it (so
  `css/style.css`, `app.js` and images just work), the wider web as well, or
  unrestricted. The strict default is what the plugin has always done.
- **A session page, not a hidden store.** `HTML管理` lists every interface in this
  session with its placement and source project, hides and restores it, and removes
  it — records live host-side, keyed to the session.
- **Sandboxed by construction.** Documents run in an opaque-origin iframe and are
  reached through a per-document capability token; a page cannot touch the host UI
  unless the reader grants the unrestricted level to that one project.

## Placements

| `placement` | Where it lives |
|---|---|
| `inline` | In the transcript, at the end of the turn that attached it: seamless — no chrome, no border, no background, height taken from the document itself |
| `dock-right` | The session's right column: a real left/right split (the widest surface), as a tab hosting this session's right-placed interfaces. Falls back to the wide dock above the composer while the column cannot open a tab |
| `float` | A draggable, resizable window (`size: "520x360+80+60"`). Hiding one keeps its document alive, so nothing typed into it is lost |
| `background` | A full-frame, click-through layer at a fixed 25% opacity, so the interface underneath stays readable. It belongs to no view: close it from the session page |
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

Without npm, the same package installs straight from the repository:

```sh
dsh plugin --profile web add github:mostkia/dsh-htmlui
```

Requires DSH `>=0.1.7-0` (the pre-release line is included on purpose, so `0.1.7-rc.*`
installs, and each 0.2 pre-release line has its own branch — see
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for what was checked against
`0.2.0-rc.2`). Then hard-refresh the page. A working client half logs
`[dsh-htmlui] client active (0.1.1)` in the browser console.

Two cheap ways to confirm which generation a running host has loaded:

```sh
curl -s http://127.0.0.1:3080/plugins/@mostkia/dsh-htmlui/health
# {"ok":true,"plugin":"@mostkia/dsh-htmlui","version":"0.1.1",...}
```

Editing the host half (`index.js`) does **not** reload in a running host: the
loader keeps the module generation it activated. Cold-start `dsh` after host-half
changes; the browser half only needs a refresh.

[docs/VERIFY.md](docs/VERIFY.md) is the live acceptance checklist: which
generation is running, what each placement should look like, how the round trip
to the model shows up, and how to read a symptom.

## How it works

- **Host half** (`index.js`, plain ESM, no dependencies): the `html_ui` and
  `html_ui_template` tools, storage under `$DSH_HOME/htmlui`, and an HTTP carrier
  at `/plugins/@mostkia/dsh-htmlui` — a document ticket route, the composed
  document, a per-session list, the template catalogue and its apply route, a
  POST action channel, an SSE stream, and a health probe. Each route is guarded
  by the policy described under [Security](#security).
- **Browser half** (`client.js`, hand-written module, no build step): registers
  the tool view, the composer dock, and the frame-wide overlay, and hosts every
  document in an iframe.
- **Bridge** (`assets/bridge.js`, injected at serve time): exposes
  `window.dshHTML` with `send`, `state`, `resize`, `close`, and
  `on(...)` for the streamed `assistant` text, `reasoning`, `session`, `action`,
  `ui`, `theme`, and `ready` events, plus `ready(...)` for the immediate form.
  Visible text is localized through the Client locale service (English and
  Chinese dictionaries ship with the package) and falls back to English literals.

The model never receives the document body: what it reads is a compact summary
(`ui_id`, `placement`, `bytes`, revision), and the browser loads the document
itself from the carrier's ticket route. Large documents belong in a file and are
attached by `path`, so they never sit in the model context.

## Security

Documents run in an iframe with `sandbox="allow-scripts allow-forms allow-modals
allow-popups allow-downloads allow-pointer-lock"`, i.e. **without**
`allow-same-origin`: an opaque origin with no cookies, no storage, and no access
to the host page. Every document carries a per-document capability token (HMAC of
a plugin-local secret) that gates its document, action, state, and SSE routes.
That token appears in exactly one place — the frame URL the ticket route hands
out — so no tool result, session log entry, list response, or stream frame ever
contains it, and a token-free address cannot be loaded.

The served document carries a strict CSP. Because a sandboxed frame without
`allow-same-origin` has an *opaque* origin, and an opaque origin matches no URL,
every same-origin allowance names this host explicitly rather than `'self'` —
including `script-src`, which is what lets the injected bridge load at all.

The carrier's own policy: only loopback Host/Origin pairs are trusted, an
opaque-origin frame is accepted only with a valid token, cross-site ticket
requests are refused, mutating routes are POST-only, and each document gets a
small token bucket so a runaway script cannot flood the model. No secrets belong
in a document, and the plugin never asks for any.

**What that boundary does and does not cover.** Loopback *is* the trust boundary,
and it is worth stating plainly: a request with no `Origin` at all — `curl`, a
script, another local process — is treated as trusted, because a local process
already has everything the user has. The carrier cannot tell the DSH page from
such a caller, so it bounds what one caller can do rather than pretending to
authenticate it: the page-facing list route requires an explicit session, ticket
minting is rate limited per document, and a capability is revoked the moment its
interface is closed or superseded. A *browser* attacker is a different matter and
is refused outright: another origin is rejected, a sandboxed frame on someone
else's page has no token, and a rebound Host name fails the loopback check.
If you expose this beyond loopback, read the `allowedOrigins` paragraph below
first — that is the setting that changes the trust boundary.

A deployment that deliberately serves DSH beyond loopback (`webServer.host:
0.0.0.0`, a LAN address, a reverse proxy) has a browser origin the default policy
refuses, which would leave the whole feature returning 403. List that origin in
`allowedOrigins` and it is trusted — that origin, exactly, and nothing else:

```yaml
      config:
        allowedOrigins:
          - http://dsh.lan:3080
```

`/health` reports `trust.loopbackOnly` and the number of listed origins, so the
active posture is never a guess.

## Configuration

Optional row config (nothing here needs a machine-specific path):

```yaml
- insert:
    - id: dsh-htmlui
      name: '@mostkia/dsh-htmlui'
      config:
        root: ''              # storage root; default $DSH_HOME/htmlui
        maxInlineBytes: 16384 # largest inline html/css/js accepted per part
        actionPrompt: ''      # sentence appended to an [html-ui:action] message
        allowedOrigins: []    # extra trusted browser origins (see Security)
```

Runtime state lives under `$DSH_HOME/htmlui`: `ui/<id>/index.html` (the authored
document, kept clean and portable — nothing is injected on disk),
`templates/<name>/` for managed templates or `templates/<name>.html` for
hand-written ones, `state/<session>.json`, and a `secret` used for capability
tokens. Deleting a `ui/<id>/` directory by hand is safe at any time: an interface
whose record is gone simply disappears from its session. (A record whose session
no longer exists is left in place rather than garbage-collected, so an interface
cannot vanish because a session was archived.)

## Templates

```
html_ui_template { "op": "save", "name": "orders-dashboard", "ui_id": "ui-1a2b3c4d" }
html_ui { "op": "render", "template": "orders-dashboard", "variables": { "title": "本周订单" } }
```

`{{token}}` placeholders are substituted from `variables`. Templates persist
across sessions; `templates/starter` ships with the package as a readable
example.

A hand-written document is a template too. Drop `my-panel.html` into
`<root>/templates/` and address it as `template: "my-panel"` — no manifest to
write. A managed template of the same name takes precedence while it exists, and
removing it uncovers the file again.

The composer also carries a **template drawer** (the `⟨/⟩ Templates` control
beside it; localized through the Client locale service). It lists the catalogue,
**applies** one straight into the session with no model round trip, and offers
`Ask the model` when the other path is what you want. A surface created that way
is a normal record: the model sees it in `html_ui op=list` and can update or
close it.

## Development

```sh
npm test        # 133 assertions: 12 package, 10 doc contract, 35 host, 33 browser, 9 bridge, 17 render smoke, 10 adversarial, 2 packed, 5 harness schema
npm run check   # syntax check for all three shipped scripts, then the suites
```

Neither half needs a build step: the host half is plain ESM, and the browser half
is the module the loader materializes as-is. Both are plain JavaScript with no
runtime dependency on the harness module graph, and the plugin declares no
dependencies at all. CI runs both suites on Ubuntu and Windows across Node 22 and
24 (`.github/workflows/ci.yml`). Release steps and the prepared
awesome-dsh-plugin entry live in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

MIT
