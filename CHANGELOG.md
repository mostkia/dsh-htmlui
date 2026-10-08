# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.3

### Added

- A project can ship its own backend: a `server.js` beside the project's `index.html`, run by this
  plugin in the DSH process and called from that project's own documents with `dshHTML.app(path,
  init)` — no model turn, no tokens, no waiting for the assistant. A panel that polls an API, reads
  a file, or keeps a cache in memory no longer has to ask the model for it, and the answer comes
  back as data the page can render directly (`{ ok, status, body, text(), json() }`;
  `dshHTML.appUrl(path, query)` is the same address for a resource the page loads itself). The
  declaration lives in the project's `meta.json` (`"backend": true`, or a path inside the project),
  and the module is kept between calls so a cache or a counter survives; it is dropped after ten
  idle minutes, and editing the file — or anything it requires from the project folder — reloads it
  on the next call, with no cold start and no page refresh. `server.js` is CommonJS for that reason:
  an ES module graph cannot be invalidated, so an `.mjs` backend would only ever reload its entry.
- The reader decides, and only the reader. A declaration is not permission: until **Run this
  project's backend** is ticked where the project is imported or edited, every call answers `403`.
  The allowance is kept in the plugin's settings rather than in the project, so a folder copied from
  anywhere cannot grant itself the right to run code on this machine, and un-ticking the switch
  unloads the backend on the next call instead of on the next restart. Backend code runs in this
  process with this plugin's privileges — it is not a sandbox, and the skills, the manifest form and
  the docs say so where the choice is made.
- The call is bounded in the ways the rest of the carrier is: the route is keyed by the calling
  document's own UI id and checked with its capability token, so a document reaches the backend of
  the project it came from and no other; one call gets `appTimeoutMs` (ten seconds by default, now a
  config value because "too slow" is a property of the panel and not of the plugin); request bodies
  and answers are capped; calls take from the same rate-limit bucket as everything else; and a
  handler that throws or never answers becomes a `500`/`504` answer carrying the reason rather than
  a stalled request. `/health` reports every loaded backend with its call and failure counts, since
  a loaded backend is otherwise invisible.
- A project's backend may declare that it wants to stay loaded: `resident: true` on the module
  export. Without it nothing changes — an idle backend is still dropped after ten minutes — but a
  resident one is never dropped for being idle, which is the difference between "runs while you look
  at it" and "keeps running": a watcher keeps watching, and sending its alert, with the panel closed.
  Because such a backend is by definition one that nothing calls, wanting to stop it can no longer be
  expressed as "the next call will notice", so stopping becomes its own act: `POST
  /templates/backend/stop { slug }` unloads the module (calling its `stop()` hook) **without**
  touching the reader's allowance, and opening the project again loads it again. Turning the
  allowance off, or turning residency off, unloads immediately for the same reason.
- The reader keeps the last word about lifetime, separately from trust: `POST /templates/backend`
  takes a `resident` flag beside `allowed`, stored per project in the plugin's settings
  (`backendResident`), so a declaration is a request and not a decision — the same shape as the
  allowance itself, and for the same reason. Both answers, and whether the module is loaded right
  now, are reported in the catalogue (`backend: { declared, allowed, resident, loaded }`) and in
  `/health` (`resident`, `declaredResident`), because "was it called recently" no longer describes
  the lifetime of a resident backend.

### Changed

- The idle-unload delay is the `backendIdleMs` setting (default ten minutes, clamped to between one
  second and one hour). It is the same rule as before, made visible: how long an idle backend is
  worth holding is a property of the machine, not of the plugin.
- The manager rows and the drawer's project rows are laid out for a narrow screen: the manager row is
  three lines (what it is; the process — placement, revision, id — with its backend's marks pushed to
  the right; then the controls), and a drawer row is two (the choice and its pencil, then
  `Stop backend` on the left with the marks on the right). What residency means lives in a tooltip
  rather than in a line of small print, which is what had been wrapping rows onto a second line.

### Fixed

- A floating window no longer opens larger than the screen it is drawn in. The 520×360 default — or
  a `size` the model chose while looking at a desktop — opened wider than a phone's viewport, which
  put the window's own resize handle off the edge: the one control that could have made it smaller
  was the one that could not be touched, and the surface stayed stuck. Geometry is now fitted
  wherever it is set (at creation, on a `resize` message, while dragging, and while resizing), so a
  window can still be moved and resized freely but can never end up bigger than the view it lives
  in. A geometry that already fits comes back untouched, which is every desktop case.
- The manifest form follows the project the reader picks. Opening one project's details with its
  pencil and then choosing a different project left the form on the first one — the selection said
  one thing and the form said another, and the save went to the project the form still held rather
  than the one on screen. Picking a project now moves an open edit form with it; a half-filled
  *adopt* form is deliberately left alone, since that one is about a folder rather than a catalogue
  entry.
- A fullscreen surface covers the whole screen on a phone. It is positioned over the conversation
  column, which is right on a desktop — the sidebar belongs to the reader — but on a narrow viewport
  that measurement pointed at a column inside the shell, and the surface came up 32px short. Narrow
  viewports now cover the viewport itself, in viewport units and with `flexShrink: 0` and a matching
  `minWidth`, because a width alone is only a request while the layer is a flex item in the host's
  layout. The desktop measurement is untouched.

## 0.1.2

### Added

- The plugin's own surfaces have a phone layout. Below `max-width: 640px` the create dialog becomes a
  bottom sheet — scrim, top-only radius, a close control in its header, a footer whose two buttons
  stand a thumb tall — and the composer entry collapses to its mark. Every value that makes a phone
  behave differently now lives in one `MOBILE` object at the top of `client.js`, under a map of the
  places a mobile change can reach (the breakpoint, the entry, the sheet, the three shared row
  buttons, and the two injected stylesheets), so "change the phone layout" is one edit rather than a
  search for literals. Desktop branches keep the value they always had, item by item.
- A phone can scroll a document that does not scroll itself. When a one-finger vertical drag starts
  inside a hosted document, the bridge decides **once** who owns the gesture: the document keeps it if
  it can scroll, and the gesture stops at the document's edge instead of handing the remainder to the
  conversation — one owner for the whole drag, which is what removed the press-instant jitter that
  deciding per event caused. Y only, one dispatch per animation frame, and sampled from screen
  coordinates so a seat that moves under the finger cannot pollute the measurement.
- The frame-wide layer lifts the shell's chrome above an inline document on a phone: the
  scroll-to-bottom button, the sidebar, the right column and the drawer backdrop get a stacking level
  of their own, scoped to the shell's own mobile gate (`max-width: 1023px` **and** a coarse pointer)
  so a desktop layout is untouched.

### Fixed

- The inline height cap is **640px**. It was 560, which made a document taller than a phone screen
  start scrolling inside itself earlier than it needed to; the seat in the transcript and the frame
  that draws the document still ask one function for the number, so they cannot disagree.
- The create sheet's controls keep the size this plugin gives them. A mobile-polish plugin installed
  alongside (`dsh-web-mobile`) holds every text field on the page at 16px with `!important` on iOS so
  Safari cannot focus-zoom, and leaves `select` out on purpose — which left this dialog with 16px
  text inputs beside 12px selects. An inline style cannot win against `!important`, so the sheet's two
  sizes are restated from a second injected stylesheet, scoped to the dialog's own id: between two
  `!important` declarations specificity decides, and an id beats any number of attribute selectors.
  Nothing outside the dialog is touched.
- The manifest form's Cancel is a phone control too. It kept the 22px desktop button beside a 34px
  confirm in the same footer row; both now come from `MOBILE`, as does the gap between them.

## 0.1.1

### Added

- Slot rows: the bulk half of a slot. A slot *value* is inlined into the document, which is what
  makes `dshHTML.store.get` synchronous — and also why it has to stay small (192 KiB), so a
  notebook ran out of room. `dshHTML.store.rows` adds records addressed by key, kept in one
  SQLite file per slot (`$DSH_HOME/htmlui/store/<name>.db`, through `node:sqlite`, which ships
  with Node — still no dependency, and the package's engine floor already guarantees it):
  `keys()` pages metadata (key, title, size, time) so a list is drawn without fetching any body,
  `get()` / `set()` / `remove()` move one record at a time so a large collection never rewrites
  itself, and `search()` scans keys, titles, and text — a `LIKE` scan rather than FTS5, because
  the trigram tokenizer cannot answer a two-character Chinese query, which was measured before it
  was written. A row may be 16 MiB, and the number of rows and of slots is no longer limited. No
  SQL text crosses the bridge: keys and values are bound parameters against host-written
  statements, so a document cannot reach anything outside its own slot (a raw-SQL channel would
  have had to block `ATTACH`, which `node:sqlite` does not expose a lever for). Row change events
  carry the key rather than the body, and row reads have their own, wider rate limit. `/health`
  now reports each slot's kind, row count, and bytes.
- The shared store: named slots a document can keep data in when the data has to outlive the
  panel. `dshHTML.state` is keyed by the interface — closing the panel makes its value
  unreachable — and the sandbox has no `localStorage`, so a notebook had no honest place to put
  its pages. A document declares the names it uses
  (`<meta name="dsh-htmlui" content="store=notes">`), reads them synchronously (the values are
  inlined with the document, so the first frame can already paint them), writes them with
  `dshHTML.store.set(...)`, and hears about another panel's write over the existing SSE stream
  (`dshHTML.store.on(...)`, which carries the new value so no second request is needed). The
  declaration is also the permission model: an interface may touch exactly the slots it named.
  A slot value lives in `$DSH_HOME/htmlui/store/<name>.json`, eight names per document, and
  nothing but an explicit `store.remove(name)` — or deleting the file by hand — ever removes it.

### Fixed

- `/health` reports a slot's kind from the files that exist. The layers were merged into one entry
  in directory-read order, so a slot whose value layer had been deleted still called itself `both`
  instead of `rows`; the probe now decides from presence, not order.
- `css` and `js` are merged whatever the source, and a dropped argument is reported. Both were
  only merged for `html` and `path`, so a `template` render silently ignored them: the caller saw
  `status=ok`, assumed its script was in the document, and spent turns on why nothing ran. The
  merge is uniform now, and the result names what happened — `merged=css,js`, and `ignored=…` plus
  a hint when a call passed more than one source (`template` > `path` > `html`) or `variables`
  without a template. A file- or template-backed document keeps its old latitude for inline
  supplements: only the composed-document cap applies, not the inline-fragment cap.

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
