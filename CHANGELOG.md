# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0

### Added

- A template drawer in the composer (`⟨/⟩ 模板`): it lists the catalogue, applies
  a template straight into the session with no model round trip, and offers to
  hand the instruction to the model instead. Two page-facing routes back it
  (`POST /templates`, `POST /templates/render`), guarded by the same loopback
  origin policy as the rest of the carrier, and a surface created that way is an
  ordinary record the model can list, update, and close.
- `test/schema.test.mjs`: the declared schemas are checked with the harness's own
  validators (`assertObjectJsonSchema`, `validateJsonSchemaValue`) whenever a
  harness package is reachable, so a keyword outside the supported subset — which
  fails activation in a way a fake-context test cannot see — is caught here. It
  also asserts that a real tool result satisfies the declared output schema, and
  that the schema is not vacuous.
- `html_ui op=list` reports every interface of a session instead of the first
  twelve, so each id stays reachable for a follow-up `close`; a truncated list
  says so. Retiring a surface now drops its collapsed flag too.
- `test/packed.test.mjs`: the published artifact is now tested as an artifact.
  The suite runs `npm pack`, extracts the tarball, and activates the host half
  from that extraction — the bridge asset, the starter template, `/health`, and
  both tools all have to work from the shipped files. This is the failure a
  missing `files` entry causes: the repository works and the published package
  does not. It skips, loudly, where the environment cannot pack or extract.
- A document can declare its own placement, size, and title, which is what makes
  a template carry its home with it:
  `<meta name="dsh-htmlui" content="placement=dock-top; size=520x360; title=Orders">`
  or `data-dsh-htmlui-placement` / `-size` / `-title` on the root element. The
  tool argument wins over the declaration, the declaration wins over the `inline`
  default, an unusable value is ignored, and an update whose document declares
  nothing keeps the placement the record already has. The shipped template
  demonstrates it.
- `test/robustness.test.mjs` plus `test/harness.mjs`: the host half is now fed
  what a broken document, a hostile page, or a clumsy model would send —
  malformed bodies, object ids, traversal-shaped names and paths, over-cap
  payloads, prototype-polluting keys, nonsense sizes, and a socket that stops
  accepting writes. The contract is asserted rather than assumed: a status
  instead of a throw, `ok: false` instead of a throw, a dead stream released,
  and nothing written outside the data root.
- Every carrier request now runs inside one containment boundary, so a bug in
  this route owner cannot throw into the web server or leave a request
  unanswered; `readOwnedUi` reports an unusable id as unknown instead of letting
  the store's validation steer control flow through an exception.
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
  the host-half assertions.

### Fixed

- Reasoning no longer arrives as assistant text. `StreamChunk` is a tagged union
  in which `text-delta` and `reasoning-delta` both carry `text`, so the previous
  mapping leaked the model's thinking into the answer an interface displayed; the
  chunk tag decides the event now.
- A fragment is served in standards mode. A document authored as inline `html`
  declares no doctype, and a document without one is parsed in quirks mode, where
  the box model differs from what any modern stylesheet assumes. The composed
  document adds one when the author wrote none, and never rewrites what is stored.
### Fixed

- The wheel still reaches the conversation through a hosted `inline` document. Hosting moved the
  frame out of the transcript, so the browser's own scroll chaining — which used to carry a wheel
  the document could not use up to the conversation — had nowhere to go, and a wheel over a
  document with nothing to scroll did nothing. The bridge now forwards exactly what the document
  could not use: the decision is made synchronously on a passive listener (a scrollable ancestor
  of the pointer with room in that direction keeps the wheel), the host scrolls the transcript by
  the same delta, and past the end of the transcript the delta carries on to the page. Line- and
  page-mode deltas are converted to pixels, and a pinch gesture is left alone.
- A hosted `inline` document can no longer paint over the input box. The composer is drawn
  *over* the transcript, so the scroll container's own rectangle reaches under it, and clipping a
  document to that rectangle let it cover the input box once the conversation was scrolled down.
  The band a hosted document is clipped to now ends where the composer begins, measured from the
  plugin's own seat inside that block (the column's edges were already measured the same way).
- An `inline` interface now survives a Session switch, and a turn scrolling out of the
  virtualized transcript, the way the other forms do. Its document is *hosted* by the
  frame-wide overlay — clipped to the transcript's own viewport and placed over a seat the
  transcript keeps at exactly the document's height — instead of being a child of the turn
  that attached it. A child frame is destroyed the moment the product rebuilds the
  transcript (a Session switch, or the virtualized window moving past its turn), which is
  why the interface came back empty; a hosted frame is hidden in those moments and never
  unmounted, so its runtime state is still there on the way back. Hosting starts when the
  seat is first on screen, so a page load still builds only the documents of the turns
  actually rendered, and the seat reserves the height the document reports, so the
  conversation around it does not move when it loads.
- A `float`, `background` or `fullscreen` interface survives a Session switch. The overlay
  seat rendered the viewed Session's records alone, so switching away unmounted that
  session's windows and switching back reloaded every document from scratch — the same loss
  the minimize/restore path had already been fixed for, one level up. The seat now keeps
  every session's overlay surfaces mounted and merely hides the groups that are not on
  screen (`display: none`), so a window comes back exactly as it was left.
- An `inline` interface stays where it was put. The turn tail elected a "newest
  tail" while rendering, so every tail adopted whatever the session held and drew
  another copy of it at the bottom of the conversation: a template applied from
  the drawer was rebuilt — and its document reloaded — at the instant every later
  answer ended. A tail now draws exactly what belongs to its own turn: the
  interfaces a render call *in that turn* made, read from the tool result's
  presentation meta on the `tool-call` node's `tool-result` block (the result
  text is the human-readable ack, and a `list`/`update`/`close` that merely names
  an id must not claim it), plus the ones the reader applied while the
  conversation stood there, for a template that no call made. Nothing is elected
  while rendering, so one interface is drawn by one tail and it scrolls up with
  the transcript like anything else in it.
- A `dock-right` interface always has a seat. The tab *type* registering was
  treated as "the column works", but opening the tab needs the controller too, and
  the composer dock stopped claiming `dock-right` as soon as the type registered —
  so between those two moments the interface rendered nowhere. Readiness now needs
  both halves, the reveal effect retries when the controller binds, and the
  fallback holds until then.
- A theme switch no longer reloads every open document. The ticket URL carried the
  theme, so changing it changed `src`, which reloaded the frame and discarded
  everything the interface held in memory (form input, scroll, a chart's own
  state); the theme already travels over the init and theme messages. A failed
  ticket is also recoverable now, instead of leaving the surface broken until a
  page reload.
- The dock resize handle resizes. The wrapper was constrained with `maxHeight`
  while the frame asked for `height: 100%`, and a percentage against an indefinite
  height resolves to `auto`, so dragging only clipped. It sets a concrete height,
  responds to the arrow keys, and is a labelled `separator` for assistive tech,
  as are the glyph-only buttons; the fullscreen layer is `aria-modal` and Escape
  leaves it. (A hook placed after an early return was moved back above it.)
- The peer range caps every branch. `>=0.1.7-0` had no upper comparator, so a
  future `0.3.0` or `1.0.0` satisfied it — the opposite of what
  `docs/COMPATIBILITY.md` describes. Each line now carries its own ceiling, and
  the package test fails if one loses it.
- A resize no longer rewrites the document. `op=resize` persisted through the
  whole-document write, so a frame could re-serialize a megabyte document per
  request; it now skips an unchanged size entirely, spends the same bucket as an
  action, and writes metadata only. The shared body cap came down from 2 MiB to
  256 KiB, above the largest legitimate payload.
- The document cap applies to what is stored, not only to what was read:
  `path` at the limit plus a large inline `css`/`js` used to exceed it silently.
- An existing `secret` is never rewritten. Treating an unexpected shape as
  "missing" rotated the key and silently invalidated the capability of every open
  interface.
- Atomic writes use a unique temp suffix, so two writers can no longer collide on
  the same temporary path.
- The page-facing list route requires a session. A caller supplying none received
  every session's records; the model's cross-session view is its own tool. Ticket
  minting is rate limited per document.
- The README states what the loopback boundary does and does not cover, including
  that a local process without an `Origin` is trusted by construction — the
  carrier bounds it instead of pretending to authenticate it.
- Document text routes through the Client locale service (`ctx.get("locale")`,
  the documented optional access) with English literals as the fallback, so the
  surfaces are bilingual instead of hardcoded, and a deployment without the
  service still reads correctly. The bridge applies the theme from the URL at
  startup, so a missed init handshake no longer leaves a frame in the wrong theme.
- The document CSP lets the injected bridge load. A sandboxed frame without
  `allow-same-origin` has an opaque origin, and an opaque origin matches no URL,
  so `script-src` without this host blocked `assets/bridge.js` outright:
  `window.dshHTML` would not have existed in any document, so every interface
  would have failed on its first use while still rendering normally. Every
  same-origin allowance now names this request's host — including
  `frame-ancestors`, where `'self'` could make the frame refuse to display.
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
