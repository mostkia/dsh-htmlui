---
name: dsh-htmlui
description: Author an HTML/CSS/JS interface and attach it to the DSH conversation with the html_ui tool — inline in the transcript, docked around the composer, floating, fullscreen, or as a resident panel — and talk to the model from inside it through window.dshHTML.
whenToUse: Use when a request needs a real interactive surface (dashboard, form, editor, multi-step tool, app-like flow) rather than prose, a code block, or a fixed component vocabulary.
---

# DSH HTML UI

`html_ui` attaches a document you author to the conversation. The host renders it
in a sandboxed iframe; the document talks back through `window.dshHTML`.

## Two tools

| Tool | Use it for |
|---|---|
| `html_ui` | `render` (new), `update` (replace by `id`), `close` (remove), `list` (what this session holds) |
| `html_ui_template` | `save` (freeze a working document), `list`, `show`, `remove` |

## Preferred shape: a file

Large documents belong in a file, not in the conversation:

1. Write the document with the file tools (`write`).
2. Attach it to the session's right column, where it gets the most room:
   `html_ui { "op": "render", "path": "ui/dashboard.html", "title": "订单看板", "placement": "dock-right" }`.
   With `inline` (the default) the document appears at the end of the turn that
   attached it, seamlessly, in the conversation flow.

Inline `html` is capped (16 KiB by default) and stays in the conversation
context forever, so use it only for small sketches.

Iterate with `update`: pass the same `id` from the previous result and only the
parts you changed (`path`, or `html`, or `css`/`js` next to either). The document
is replaced in place, and the browser surface refreshes without a new card.

## Templates

There are two things in the catalogue: the **blank canvas**, and whatever is in the
**templates directory the user chose** (from the `⟨+⟩ New HTML` dialog, with the system
folder picker). Nothing else is listed — no bundled samples, no hidden store — so
`html_ui_template op=list` is exactly what the user sees.

- `html_ui op=render template=blank` starts an empty project.
- `html_ui_template op=save name=<slug>` writes into that directory, so the user can
  reuse it from the dialog. With no directory chosen it fails and says so.
- `css` and `js` are merged into the document **whatever the source** — `html`, `path`,
  and `template` alike — and the result says so (`merged=css,js`). If you pass more than
  one source, one wins (`template` > `path` > `html`) and the others come back as
  `ignored=…` with a hint: nothing is dropped silently. `variables` only mean something
  with a template, and are reported the same way.

## Placement
| `placement` | Where it lives |
|---|---|
| `inline` (default) | In the transcript, at the end of the turn that attached it. Seamless: no chrome, no border, no background, and the height comes from the document — do not paint a page background |
| `dock-right` | The session's right column: a real left/right split, and the widest surface. Falls back to the wide dock above the composer when the column is unavailable |
| `float` | A draggable, resizable window; give `size`, e.g. `"520x360+80+60"` |
| `background` | A click-through layer over the frame (decorative) |
| `fullscreen` | Covers the session and offers a built-in "切回聊天" switch |

The vertical docks (`dock-top` / `dock-bottom`) and `panel` were removed: a surface that
only squeezes the session view reads as a window parked inside the conversation, and
`dock-right` already gives a real split.

Give `size` as `"WxH"` or `"WxH+X+Y"`.

### A document may declare its own placement

A document is the best place to say where it belongs, and a template should carry
that with it. Declare it in the head:

```html
<meta name="dsh-htmlui" content="placement=dock-right; size=520x360; title=Orders">
```

or on the root element:

```html
<html data-dsh-htmlui-placement="float" data-dsh-htmlui-size="520x360">
```

Precedence: the tool argument wins, then the declaration, then `inline`. An
unusable value is ignored rather than fatal, and an `update` whose document
declares nothing keeps the placement the record already has.

## Inside the document: `window.dshHTML`

```html
<button id="refresh">刷新</button>
<pre id="out"></pre>
<script>
  document.getElementById('refresh').addEventListener('click', async () => {
    const result = await dshHTML.send('refresh', { range: '7d' });
    document.getElementById('out').textContent = JSON.stringify(result);
  });
  dshHTML.on('assistant', (event) => {
    if (event.type === 'text') document.getElementById('out').textContent += event.text;
  });
</script>
```

| Call | Meaning |
|---|---|
| `dshHTML.send(action, data)` | Send an interaction to the model. It arrives as a user message carrying `[html-ui:action]`. Returns `{ ok, actionId }`. |
| `dshHTML.send(action, data, { steer: true })` | Same, but steers the running turn instead of queueing the next one. |
| `dshHTML.state.get()` / `.set(value)` | Server-side state for this document; survives reloads (this sandbox has no `localStorage`). It belongs to *this panel of this session*: closing the interface throws the key away. |
| `dshHTML.store.get(name)` / `.set(name, value)` | The **value layer** of a named slot: small, synchronous, shared by every panel that declared it, kept on disk. `get` is synchronous, `set` returns `{ ok, bytes }`, and the data outlives this panel, this session, and a host restart. `remove(name)` forgets one, `list()` reports what this document declared, `on(handler)` hears about writes from any other panel. |
| `dshHTML.store.rows.*` | The **row layer** of the same slot: many records addressed by a key, in SQLite, fetched when wanted — this is where bulk data goes. `keys(name, {offset, limit})`, `get(name, key)`, `set(name, key, value, {title})`, `remove(name, key)`, `search(name, text, {limit})`, `on(handler)`. All of them return promises. |
| `dshHTML.resize('520x420')` | Ask the host to resize the surface. |
| `dshHTML.close()` | Ask the host to remove the surface. |
| `dshHTML.on(type, handler)` | `assistant` (streamed model text, and `{ type: 'tool', name }` while a tool call streams), `reasoning` (the model's thinking, kept apart from its answer), `session`, `action`, `store`, `ui`, `theme`, `ready`. |
| `dshHTML.ready(handler)` | The immediate form of `on('ready', …)`: it fires right away with `{ uiId, sessionId, theme }`, and returns a disposer. |
| `dshHTML.stream()` | Open the SSE stream explicitly. |
| `dshHTML.theme()` | `'light'` or `'dark'`. |

`document` also receives `dsh-htmlui:<type>` CustomEvents with the same payloads.

**Keep durable state in `dshHTML.state`, not in a JavaScript variable.** The host
manages the surface list, and any change that remounts a seat recreates the iframe,
which reloads your document and clears everything it held — scroll position, form
input, a chart's own data. `state.get()`/`state.set()` live on the host, so they
come back after a reload, and they are the only storage this sandbox has.

**When the data has to outlive the panel, use a slot.** `state` is keyed by the
interface, so closing the panel makes its value unreachable; a slot is keyed by name
and stays on disk. Declare the names in the document head, and only those names are
readable and writable:

```html
<meta name="dsh-htmlui" content="placement=dock-right; store=notes">
```

A slot has two layers, and picking the right one is the whole design decision:

```js
// Value layer — small, and it travels with the document.
const prefs = dshHTML.store.get('notes') ?? {};        // synchronous: it came with the document
await dshHTML.store.set('notes', { ...prefs, tab: id }); // { ok, bytes }; capped at 192 KiB
dshHTML.store.on((change) => {                          // another panel wrote the value
  if (change.slot === 'notes' && change.uiId !== dshHTML.uiId) render(change.value);
});

// Row layer — many records, fetched when wanted. This is where a notebook's pages go.
const page = await dshHTML.store.rows.keys('notes', { limit: 200 });   // metadata only
const one = await dshHTML.store.rows.get('notes', id);                 // { value, title, … }
await dshHTML.store.rows.set('notes', id, text, { title: firstLine }); // one row, not the corpus
const hits = await dshHTML.store.rows.search('notes', '插槽');          // keys, titles, text
await dshHTML.store.rows.remove('notes', id);
dshHTML.store.rows.on((change) => { reload(change.key); });            // carries the key, not the body
```

- **Value layer**: whatever it holds is inlined into every load of the page, so it is
  capped at 192 KiB — settings, the active tab, a small cache. Reads are synchronous.
- **Row layer**: rows live in one SQLite file per slot and are fetched on demand, so
  there is no size ceiling worth planning around — one row may be up to 16 MiB, a slot
  may hold as many rows as you like, and there is no limit on how many slots exist.
  A write of one row touches one row, so a big collection never rewrites itself.
- Both layers use the same declared name, and are independent: the value holds your
  preferences while the rows hold your data.
- Search is a substring scan over keys, titles, and text — correct for Chinese at any
  query length, which an FTS5 trigram index is not (it needs three characters).
- Eight declared names per document. Use slots for the user's data, never for secrets:
  everything a document writes is readable by every other document that declares the
  same name.

## Design rules

- **Local first.** Selection, validation, sorting, filtering, scoring, tab
  switching, and anything else the document can decide itself must stay local.
  Call `send` only when the model's judgement, generation, or a host tool is
  genuinely required — every `send` costs a turn.
- **Honest affordances.** If a control needs the model, wire it to `send`.
  Controls that do nothing should not look clickable.
- **No secrets.** Never ask for passwords, API keys, tokens, or recovery codes,
  and never render one into the document.
- **Theme.** The host sets `data-dsh-htmlui-theme="light|dark"` on `<html>` and
  provides `--dsh-htmlui-bg`, `--dsh-htmlui-fg`, `--dsh-htmlui-muted`,
  `--dsh-htmlui-border`, `--dsh-htmlui-accent`. Prefer those over hard colors.
- **No host assumptions.** The document is an opaque-origin sandbox: no cookies,
  no `localStorage`, no parent DOM. `dshHTML` is the whole API surface. It is
  served in standards mode even when you write only a fragment.
- **An `inline` document must not paint a full-page background.** The surface has no
  chrome, no border and no background of its own so it reads as part of the
  conversation; a `body { background: … }` puts a white box back in the transcript.
  Give your own panels the background instead, and let the height be whatever the
  content needs — the host measures the document and sizes the frame to it (up to a
  cap, beyond which it scrolls).
- **Relative URLs resolve against the carrier**, not your workspace: a relative
  `<img src="logo.png">` points at `/plugins/@mostkia/dsh-htmlui/ui/logo.png` and
  will 404. Reference media absolutely, as a data URL, or not at all.
- **Network.** `connect-src` allows only this host, so do not fetch third-party
  origins from inside a document; fetch data through the model or a host tool.

## The user can start one without you

Beside the composer there is a `⟨+⟩ New HTML` control. It opens a dialog that asks what
to start from (the blank canvas, or any saved template) and where it should go (right
column, in the conversation, floating window, fullscreen, background layer), then
creates the interface through the host route — **without a model round trip**. So a
user may already have an interface in front of them that you never created: read
`html_ui op=list` before assuming a placement is free, and treat an existing `ui_id`
as the thing to `update` rather than something to replace with a second copy.

The right column's tab is registered only while a `dock-right` interface exists, so a
session with none has no HTML UI page in that column at all.

## Reading results

`html_ui` answers with a compact protocol block:

```
[html-ui]
status=ok
op=render
ui_id=ui-1a2b3c4d
title="订单看板"
placement=dock-right
size=520x360
bytes=4821
revision=1
next=update it later with html_ui op=update id=ui-1a2b3c4d
```

The document body never returns to the model — only this summary. When a user
interaction arrives, it looks like:

```
[html-ui:action] ui=ui-1a2b3c4d action="refresh" title="订单看板" placement=dock-right
payload={"range":"7d"}
```

React to it: `update` the document, or answer in prose. Update state through the
document's own tools rather than re-sending the whole file when only data changed.

## Templates

```
html_ui_template { "op": "save", "name": "orders-dashboard", "ui_id": "ui-1a2b3c4d", "description": "订单看板骨架" }
html_ui { "op": "render", "template": "orders-dashboard", "variables": { "title": "本周订单" } }
```

`{{name}}` tokens in the template are replaced by `variables`. Templates are
stored host-side, so they survive sessions — check `html_ui_template op=list`
before inventing a new one. A hand-written `templates/<name>.html` file in the
plugin data root is a template too, so the user's own documents are already
addressable by file name; prefer reusing one over rebuilding it.

The user can also apply a template themselves from the composer's drawer, with no
model round trip, so an interface may exist that you never created:
`html_ui op=list` is how you find out what a session already holds, and
`html_ui op=update` works on it like any other.
