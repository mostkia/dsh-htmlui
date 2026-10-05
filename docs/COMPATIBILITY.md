# Compatibility

What this plugin depends on, which harness versions were checked, and how the
peer range is maintained.

## The surface it uses

The plugin calls documented services and registers into documented slots. It
imports no harness package at runtime, so every dependency below is a *contract*
dependency, checked at build-and-review time rather than linked at load time.

| Direction | Dependency | Used for |
|---|---|---|
| Host | `dsh-host-webserver` | `ctx.webServer.register({ kind, path, handler })` — the HTTP carrier |
| Host | `dsh-tools` | `ctx.tools.register(definition)`, `output.presentationMeta` |
| Host | `dsh-api-session-controller` | `ctx.sessionController.prompt({ requestId, sessionId, mode, content })` |
| Host | `dsh-system-prompt` | `ctx.systemPrompt.section({ name, order, text })` |
| Host | `dsh-agent` | the `agent/assistant-stream` event |
| Host | `dsh-session` | the `session/event` event |
| Client | `dsh-client-ui-tool` | the `tool.call.toolview` slot, keyed by tool name |
| Client | `dsh-client-ui-conversation` | `conversation.input.dock`, `conversation.composer.dock`, `conversation.view` |
| Client | `dsh-client-ui-layout` | `shell.overlay` |
| Client | `dsh-client-ui-sidebar-right` | `sidebar.right.pane.tab`, and the `sidebarRightTabs` / `sidebarRight` services |
| Client | react | the component runtime the loader provides |

## Verified against 0.2.0-rc.2

The published packages were fetched from the registry and their declarations
read directly (`npm pack @deepseek-ai/<package>@0.2.0-rc.2`, then the `.d.ts`
files). Every contract above was found unchanged:

- `tool.call.toolview`, `conversation.input.dock`, `conversation.composer.dock`,
  `conversation.view`, `shell.overlay`, and `sidebar.right.pane.tab` all still
  exist, with the same kinds, scopes, and registration fields.
- `ctx.sidebarRightTabs.register({ id, kind, multiple?, title, … })` is unchanged,
  and the two services are still provided as `sidebarRightTabs` and
  `sidebarRight`.
- `WebRoute`, `register(route)`, and `registerUpgrade(route)` are unchanged.
- `output.presentationMeta?(args, value): JsonValue` is unchanged.
- `sessionController.prompt(request, signal)` is still
  `{ requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }`,
  which is the exact shape this plugin sends.
- `systemPrompt.section(section: PromptSection)` and the
  `agent/assistant-stream` / `session/event` event signatures are unchanged.
- `AssistantStreamFrame` still carries `{ type: 'chunk', chunk: StreamChunk }`,
  and `StreamChunk` is still the tagged union that this plugin maps from
  (`text-delta`, `reasoning-delta`, `tool-call-delta`, …).

**What this does not prove:** it is a declaration-level check, not a run. The
runtime behaviour on a 0.2 line is verified by walking
[VERIFY.md](VERIFY.md) on that line. Treat the table above as "the contracts are
still there", not as "it has been run".

## Why the peer range looks like that

npm's semver rule for pre-releases is the trap: a range only admits a
pre-release version when one of its comparators names the *same*
major.minor.patch with a pre-release tag. `>=0.1.7-0` therefore admits
`0.1.7-rc.2` but **refuses** `0.2.0-rc.1`, even though `0.2.0-rc.1` is newer. A
plain `>=0.1.7` refuses the pre-release line this plugin was developed on.

So each pre-release line is listed explicitly, and each line carries its own
ceiling — an open-ended first branch would also admit `1.0.0`:

```
>=0.1.7-0 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-alpha.1 <0.3.0-0
```

Maintenance, when a new pre-release line appears upstream:

1. Fetch the new packages and re-run the check above.
2. Add one more `|| >=<line> <0.3.0-0` branch (or a new major ceiling).
3. `node test/package.test.mjs` fails if the branches are dropped, if a line
   loses its ceiling, or if the `0.1.7-0` floor disappears, so this cannot rot
   silently.

## Re-running the check

```sh
cache=$(mktemp -d)
for p in dsh-host-webserver dsh-tools dsh-api-session-controller \
         dsh-system-prompt dsh-agent dsh-session dsh-llm \
         dsh-client-ui-tool dsh-client-ui-conversation dsh-client-ui-layout \
         dsh-client-ui-sidebar-right; do
  npm pack "@deepseek-ai/$p@<version>" --pack-destination "$cache"
done
# then grep the extracted lib/types trees for the names in the table above
```
