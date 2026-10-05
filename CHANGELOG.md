# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1

### Fixed

- The tool-result presentation projection now always returns lossless JSON. A
  projection that carried an unset optional field, or that returned `undefined`
  for `list` and `close`, was rejected by the tool registry
  (`output.presentationMeta returned non-lossless JSON`), which failed the whole
  tool call even though the document had already been stored.

### Added

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
