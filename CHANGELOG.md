# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1

### Fixed

- `html_ui op=update` actually refreshes the interface. The document URL now
  carries the revision, so the frame's `src` changes and the browser reloads it;
  before, React kept the same `src` and the surface showed the previous document
  until a manual refresh — which defeated "update in place".
- A tool card whose revision has been superseded stops rendering the document and
  shows a compact line instead, so an update no longer leaves two live copies of
  one interface in the transcript.
- A background surface passes its dismiss handler, so a document that closes
  itself is removed from the page too.
- "Switch back to chat" in fullscreen mode actually switches back. The layer
  re-selected the same record on the next render, so the button appeared to do
  nothing; a dismissal is now remembered, while a newly attached interface still
  opens by itself.
- Republishing an identical record no longer notifies subscribers. A component
  effect that republishes its own projection could otherwise re-render itself
  forever.
- The dock's height handle captures the pointer, so the drag keeps tracking once
  the cursor leaves the six-pixel strip.
- A background placement no longer draws the host chrome row: the layer is
  click-through, so a header there was decorative and misleading.
- A session converges on the host's answer: an interface closed from another page
  or by the model disappears here instead of being rendered until a reload.
- `dock-bottom` really sits below the composer card. Both vertical placements
  used to render in the same seat above the input, which made the documented
  split untrue; the bottom placement now uses the seat under the composer, and a
  test asserts the two seats never claim the same record.
- The tool-result presentation projection now always returns lossless JSON. A
  projection that carried an unset optional field, or that returned `undefined`
  for `list` and `close`, was rejected by the tool registry
  (`output.presentationMeta returned non-lossless JSON`), which failed the whole
  tool call even though the document had already been stored.

### Added

- `allowedOrigins` row config: a deliberately exposed deployment (a LAN address,
  `webServer.host: 0.0.0.0`, a reverse proxy) can trust its own browser origin
  instead of being refused wholesale by the loopback-only default. The default
  posture is unchanged, an unusable entry is ignored, and `/health` reports the
  active trust posture.
- A hand-written `templates/<name>.html` file in the data root is a usable
  template: no manifest, no subdirectory, addressable as `template: "<name>"`.
  A managed template of the same name takes precedence, and removing it uncovers
  the file. This is the "reuse your own document later" path that needs no model
  round trip to set up.
- The SSE carrier is covered end to end: a stream's hello frame, forwarded model
  text, session events, interface lifecycle frames, per-session isolation, and
  the hub releasing a closed stream.
- Mutating tool paths are scoped to the calling session: another session can no
  longer rewrite, remove, or freeze an interface by guessing its id.
- Attaching or freezing a document by path accepts only `.html`, `.htm`, or
  `.xhtml` files.
- `docs/PUBLISHING.md` and `docs/awesome-dsh-plugin.yml` prepare the release and
  the marketplace submission.
- `dock-right` now uses the session's right column: the plugin registers a
  `dsh-htmlui-panel` tab type, reveals it when a right-placed interface appears,
  and drops back to the composer dock when that column exposes no tab service.
- `GET /plugins/@mostkia/dsh-htmlui/health` reports the running plugin version,
  the supported placements, and interface/template/stream counts, so an operator
  can confirm which generation a live host is running without reading logs. It
  never discloses the storage path.
- The browser half prints `[dsh-htmlui] client active (<version>)`, so the loaded
  module generation is visible in the page console.
- `test/client-half.test.mjs`: the browser half now has executable tests (module
  contract, slot registrations, frame sandbox, placement parsing, record store,
  viewed-session resolution).
- GitHub Actions CI runs both suites on Ubuntu and Windows across Node 22 and 24.

## 0.1.0

### Added

- Host half: the `html_ui` tool (`render` / `update` / `close` / `list`) and the
  `html_ui_template` tool (`save` / `list` / `show` / `remove`), storage under
  `$DSH_HOME/htmlui`, and an HTTP carrier with document tickets, composed
  documents, a POST action channel, and an SSE event stream.
- Browser half: sandboxed iframes rendered inline in the transcript, docked above
  and below the composer, floating, as a click-through background layer, in
  fullscreen with a switch back to chat, and as a resident panel.
- Bridge: `window.dshHTML` with `send`, `state`, `resize`, `close`, and
  `on('assistant' | 'session' | 'action' | 'ui' | 'theme' | 'ready')`.
- Capability tokens per document, a loopback-only origin policy, POST-only
  mutating routes, a per-document rate limit, and a document CSP.
- Model-facing `SKILL.md`, a shipped `starter` template, bilingual READMEs, and
  17 host-half assertions.
