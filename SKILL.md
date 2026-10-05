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
2. Attach it: `html_ui { "op": "render", "path": "ui/dashboard.html", "title": "订单看板", "placement": "dock-top" }`.

Inline `html` is capped (16 KiB by default) and stays in the conversation
context forever, so use it only for small sketches.

Iterate with `update`: pass the same `id` from the previous result and only the
parts you changed (`path`, or `html`, or `css`/`js` next to either). The document
is replaced in place, and the browser surface refreshes without a new card.

## Placement

| `placement` | Where it lives |
|---|---|
| `inline` (default) | In the transcript, as part of the tool call |
| `dock-top` / `dock-bottom` | Full width above / below the composer |
| `panel` | The same dock, meant to be updated in place |
| `dock-right` | The session's right column, as its own tab; falls back to the dock above the composer when the column is unavailable |
| `float` | A draggable, resizable window; give `size`, e.g. `"520x360+80+60"` |
| `background` | A click-through layer over the frame (decorative) |
| `fullscreen` | Covers the session and offers a built-in "切回聊天" switch |

Give `size` as `"WxH"` or `"WxH+X+Y"`.

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
| `dshHTML.state.get()` / `.set(value)` | Server-side state for this document; survives reloads (this sandbox has no `localStorage`). |
| `dshHTML.resize('520x420')` | Ask the host to resize the surface. |
| `dshHTML.close()` | Ask the host to remove the surface. |
| `dshHTML.on(type, handler)` | `assistant` (streamed model text, and `{ type: 'tool', name }` while a tool call streams), `reasoning` (the model's thinking, kept apart from its answer), `session`, `action`, `ui`, `theme`, `ready`. |
| `dshHTML.stream()` | Open the SSE stream explicitly. |
| `dshHTML.theme()` | `'light'` or `'dark'`. |

`document` also receives `dsh-htmlui:<type>` CustomEvents with the same payloads.

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
  no `localStorage`, no parent DOM. `dshHTML` is the whole API surface.
- **Network.** `connect-src` allows only this host, so do not fetch third-party
  origins from inside a document; fetch data through the model or a host tool.

## Reading results

`html_ui` answers with a compact protocol block:

```
[html-ui]
status=ok
op=render
ui_id=ui-1a2b3c4d
title="订单看板"
placement=dock-top
size=520x360
bytes=4821
revision=1
next=update it later with html_ui op=update id=ui-1a2b3c4d
```

The document body never returns to the model — only this summary. When a user
interaction arrives, it looks like:

```
[html-ui:action] ui=ui-1a2b3c4d action="refresh" title="订单看板" placement=dock-top
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
