# Prepared pull request body for awesome-dsh-plugin

Submission is one pull request that adds a single file; see
[PUBLISHING.md](PUBLISHING.md) for the path and the rules. This is the body to
paste with it, so a reviewer does not have to reverse-engineer the plugin.

---

## Add `mostkia/dsh-htmlui`

A conversational UI plugin: the model authors HTML/CSS/JS, the plugin attaches it
to the conversation, and interaction flows back to the model over POST, with the
model's output streamed back into the document over SSE.

`dsh-genui` renders a whitelisted component vocabulary from JSON. This renders
the real thing — any HTML, any CSS, any script — placed where the conversation
needs it, with reusable templates.

**Category:** `ui`. **Install:** `dsh plugin --profile web add github:mostkia/dsh-htmlui`
(the package is not on the npm registry yet, so this is the install the README states).

### What it adds

- Two tools: `html_ui` (`render` / `update` / `close` / `list`) and
  `html_ui_template` (`save` / `list` / `show` / `remove`).
- Five placements, each live-verified by a document that measured itself: `inline`
  (seamless, in the conversation flow, height taken from the document), `dock-right`
  (the session's right column), `float`, `background` and
  `fullscreen`. The vertical docks were removed after acceptance: a surface that only
  squeezes the session view reads as a window parked inside the conversation.
- An injected `window.dshHTML` bridge: `send`, `state`, `resize`, `close`,
  `on('assistant' | 'session' | 'action' | 'ui' | 'theme' | 'ready')`.
- Host-side storage under `$DSH_HOME/htmlui`, with hand-written
  `templates/<name>.html` files usable as templates without a manifest.

### Reviewer notes

Things worth stating rather than leaving to be discovered:

- **No install scripts, no lifecycle scripts, no dependencies.** The package has
  no `dependencies` at all; peer dependencies are all optional. Nothing runs at
  install time.
- **It opens an HTTP carrier** at `/plugins/@mostkia/dsh-htmlui` on the DSH web
  server (routes: document ticket, document, bridge asset, POST action, SSE
  events, health). The web server ships no origin policy, so the plugin supplies
  one: only loopback Host/Origin pairs are trusted, an opaque-origin sandboxed
  frame is accepted only with a per-document capability token, cross-site ticket
  requests are refused, and mutating routes are POST-only. A deployment that
  deliberately serves DSH beyond loopback can list its own origin in
  `allowedOrigins`; nothing else is trusted implicitly.
- **Documents run in a sandbox** with `allow-scripts allow-forms allow-modals
  allow-popups allow-downloads allow-pointer-lock` and **without**
  `allow-same-origin`: an opaque origin with no cookies, no storage, and no access
  to the host page. Their `connect-src` is limited to this host.
- **No network egress of its own.** The plugin never talks to a third party; the
  only outbound traffic is whatever the model already does.
- **The model never receives document bodies.** The tool result it reads is a
  compact summary; the browser gets the document over the carrier. Capability
  tokens never appear in a tool result, session log entry, list response, or
  stream frame.
- **No telemetry, no credentials, no secrets.** The plugin reads no credential
  store and asks for no secret; the SKILL forbids an interface from requesting
  one.

### Verification

`npm test` runs ten suites (188 assertions) with no harness and no browser: package
integrity and a scan that refuses machine-specific strings, the documentation
contract against the code, the host half, a project's own backend, the browser half,
the document bridge, a shallow render of every component branch, adversarial input,
the packed artefact, and the harness schema. CI runs them on Ubuntu and
Windows across Node 22 and 24. `docs/VERIFY.md` is the live acceptance checklist.
