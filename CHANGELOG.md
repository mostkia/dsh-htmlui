# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1

### Added

- `docs/COMPATIBILITY.md`, and the peer range widened to admit the 0.2
  pre-release lines. Each pre-release line needs its own branch because semver
  only admits a pre-release when a comparator names that same
  major.minor.patch, so `>=0.1.7-0` alone silently refused `0.2.0-rc.*`. The
  contracts this plugin uses were checked against `0.2.0-rc.2` by reading its
  published declarations; `@deepseek-ai/dsh-client-ui-sidebar-right`, which the
  code already registered into, is now declared as a peer too.
- A `reasoning` stream event. The host maps the model's stream by chunk tag
  instead of by "has a text field", so thinking no longer rides the `assistant`
  event, and a tool call in flight arrives as `{ type: 'tool', name }`.
- `docs/VERIFY.md`: the live acceptance checklist — which generation is running,
  what each of the eight placements should look like, how the round trip to the
  model shows up, and a triage table from symptom to check. The documentation
  contract asserts that it covers every placement, and the release guide points
  at it as a precondition.
- `docs/marketplace-pr.md`: the prepared pull request body, stating what the
  plugin adds, what it deliberately does not do (no install scripts, no
  dependencies, no third-party egress), and the security posture a reviewer
  should check.

### Fixed

- Reasoning no longer arrives as assistant text. `StreamChunk` is a tagged union
  in which `text-delta` and `reasoning-delta` both carry `text`, so the previous
  mapping leaked the model's thinking into the answer an interface displayed; the
  chunk tag decides the event now.
- The READMEs no longer claim the browser receives a document through the tool
  result's presentation projection. It carries the record only; the document
  itself is loaded from the carrier's ticket route.
- A capability token no longer appears in any durable projection. The tool
  result, its presentation projection, the `/ui/list` response, and the record on
  disk all carry a token-free address now; the ticket route is the single place
  the token is handed out, and a token-free address cannot be loaded at all.
- `window.dshHTML.send()` now includes the `op` the host dispatches on. Without
  it every interaction an interface sent was refused as an unsupported
  operation — the model round trip was broken end to end, and only a test of the
  bridge itself could see it.
- `dshHTML.on('ready', …)` fires for a listener registered after the bridge ran,
  which is every listener: the document's own script always loads after it.
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

- `test/doc-contract.test.mjs`: the three audiences of this plugin's interface —
  the model (SKILL.md and the prompt contract), the user (both READMEs), and
  every authored document (the bridge API) — are checked against the code, so a
  placement, an operation, or a bridge member can no longer drift out of the
  documentation that teaches it.
- The template shipped with the package is covered: it lists, reports its real
  size, renders with substituted variables, and arrives with the bridge injected
  and no placeholder left behind.
- `test/package.test.mjs`: the release checks are now automated — the manifest
  the loader and the marketplace read, the files the package promises, the
  entries the loader resolves by itself, the two import rules, the version stated
  in four places, the skill's frontmatter, the prepared marketplace entry, and a
  scan that refuses any machine-specific path or address in the repository.
- `test/render-smoke.test.mjs`: every browser-half component is executed for
  each of its branches against a stub hook runtime and its element tree is
  walked, so the render path has executable coverage for the first time. It is a
  shallow render — branches, copy, and structure, not React scheduling or layout.
- `test/bridge.test.mjs`: the injected document bridge now has executable tests
  (surface, action posting, state, resize/close, ready replay, streaming, theme
  handshake, unconfigured failure), run by `npm test` and CI.
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
