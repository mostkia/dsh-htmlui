/**
 * Host-half regression tests for @mostkia/dsh-htmlui.
 *
 * The host half is plain Node, so it runs against a fake Cordis context: no
 * harness, no profile, no browser. Everything the tests touch lives in a
 * throwaway directory, so a developer machine's real plugin data is never read
 * or written.
 *
 * Run: node --test test/host-half.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-htmlui-test-'));
process.env.DSH_HTMLUI_ROOT = join(scratch, 'data');

const { apply } = await import('../index.js');

/** Minimal Cordis context stand-in: inject, effect, on, get, logger. */
function createContext(services) {
  const disposed = [];
  const listeners = new Map();

  /** Run one registration factory eagerly; collect whatever disposer it yields. */
  function runEffect(factory) {
    if (typeof factory !== 'function') return undefined;
    if (factory.constructor.name === 'GeneratorFunction') {
      const iterator = factory();
      for (const disposer of iterator) {
        if (typeof disposer === 'function') disposed.push(disposer);
      }
      return () => {};
    }
    const result = factory();
    if (typeof result === 'function') disposed.push(result);
    return result;
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      return services[key];
    },
    inject(keys, callback) {
      const scope = {
        logger: ctx.logger,
        get: (key) => (keys.includes(key) ? services[key] : undefined),
        reflect: { get: (key) => (keys.includes(key) ? services[key] : undefined) },
        effect: runEffect,
        on: ctx.on,
      };
      // An injected Cordis scope exposes each requested service as a property.
      for (const key of keys) {
        if (services[key] !== undefined) scope[key] = services[key];
      }
      callback(scope);
    },
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return () => {};
    },
    effect: runEffect,
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args);
    },
  };
  return { ctx, disposed, listeners };
}

function createFakeServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
}

function createFakeSessionController() {
  const prompts = [];
  return {
    prompts,
    async prompt(request) {
      prompts.push(request);
      return { accepted: true };
    },
  };
}

/**
 * Build one fake request/response exchange. `callRoute` awaits the end; a stream
 * route never ends, so its caller inspects the recorded chunks instead.
 */
function createExchange({ method = 'GET', url = '/', headers = {}, body = undefined }) {
  const chunks = [];
  const listeners = new Map();
  const res = {
    statusCode: 0,
    headers: {},
    ended: false,
    writeHead(status, headers_) {
      this.statusCode = status;
      this.headers = headers_ ?? {};
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.ended = true;
      if (typeof this.onEnd === 'function') this.onEnd();
    },
    flushHeaders() {},
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return res;
    },
    once(name, handler) {
      return res.on(name, handler);
    },
  };
  const req = {
    method,
    url,
    headers,
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return req;
    },
    destroy() {
      res.ended = true;
    },
  };
  return {
    req,
    res,
    chunks,
    text: () => chunks.join(''),
    /** Fire one lifecycle event at both ends, as node would on socket close. */
    emit(name) {
      for (const handler of listeners.get(name) ?? []) handler();
    },
    /** Feed the body after the handler has subscribed. */
    start() {
      queueMicrotask(() => {
        if (body !== undefined) {
          for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body, 'utf8'));
        }
        for (const handler of listeners.get('end') ?? []) handler();
      });
    },
  };
}

/** Drive the registered route handler with a fake request/response pair. */
function callRoute(route, options) {
  const exchange = createExchange(options ?? {});
  return new Promise((resolve) => {
    exchange.res.onEnd = () =>
      resolve({ status: exchange.res.statusCode, headers: exchange.res.headers, text: exchange.text() });
    route.handler(exchange.req, exchange.res);
    exchange.start();
  });
}

/** Open a response that stays open (an SSE stream) and return its live recorder. */
function startRoute(route, options) {
  const exchange = createExchange(options ?? {});
  route.handler(exchange.req, exchange.res);
  exchange.start();
  return exchange;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

let harness;
before(() => {
  const server = createFakeServer();
  const sessionController = createFakeSessionController();
  const tools = { registered: [], register(definition) { this.registered.push(definition); return () => {}; } };
  const systemPrompt = { sections: [], section(section) { this.sections.push(section); return () => {}; }, getSectionOrder() { return 10; } };
  harness = {
    server,
    sessionController,
    tools,
    systemPrompt,
    ...createContext({ webServer: server, tools, systemPrompt, sessionController }),
  };
  apply(harness.ctx, {});
});

after(() => {
  for (const dispose of harness.disposed) {
    try {
      dispose();
    } catch {
      /* cleanup is best effort */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

const route = () => harness.server.routes[0];

function tool(name) {
  const found = harness.tools.registered.find((definition) => definition.name === name);
  assert.ok(found, `tool ${name} must be registered`);
  return found;
}

function exec(sessionId = 'session-test') {
  return { agent: { session: { id: sessionId, header: { cwd: scratch } } } };
}

test('registers the http carrier, both tools, and the prompt contract', () => {
  assert.equal(harness.server.routes.length, 1);
  assert.equal(route().kind, 'prefix');
  assert.equal(route().path, '/plugins/@mostkia/dsh-htmlui');
  assert.deepEqual(
    harness.tools.registered.map((definition) => definition.name).sort(),
    ['html_ui', 'html_ui_template'],
  );
  assert.equal(harness.systemPrompt.sections.length, 1);
});

test('render accepts an inline document and reports a machine-independent id', async () => {
  const result = await tool('html_ui').execute(
    { op: 'render', html: '<h1>hello</h1>', title: 'Hello', placement: 'float', size: '520x360+40+40' },
    exec(),
  );
  assert.equal(result.ok, true);
  assert.match(result.uiId, /^ui-[0-9a-f]{8}$/u);
  assert.equal(result.placement, 'float');
  assert.equal(result.size, '520x360+40+40');
  assert.equal(result.sessionId, 'session-test');
  assert.match(result.url, /^\/plugins\/@mostkia\/dsh-htmlui\/ui\/ui-[0-9a-f]{8}\?r=1$/u);
  assert.ok(existsSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', result.uiId, 'index.html')));
});

test('the tool ack the model sees carries no document body', async () => {
  const definition = tool('html_ui');
  const value = await definition.execute({ op: 'render', html: '<p>secret body</p>', placement: 'inline' }, exec());
  const blocks = definition.output.render({}, value);
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /^\[html-ui\]/u);
  assert.match(text, /status=ok/u);
  assert.ok(!text.includes('secret body'), 'the document body must not return to the model');
  const meta = definition.output.presentationMeta({}, value);
  assert.equal(meta.htmlui, true);
  assert.equal(meta.uiId, value.uiId);
  assert.equal(meta.sessionId, 'session-test');
});

test('inline html over the configured cap is refused with a next step', async () => {
  const result = await tool('html_ui').execute({ op: 'render', html: `<p>${'x'.repeat(40_000)}</p>` }, exec());
  assert.equal(result.ok, false);
  assert.match(result.error, /maxInlineBytes/u);
  assert.match(result.hint, /path/u);
});

test('a file-backed document is read from disk and merged with css and js', async () => {
  const file = join(scratch, 'panel.html');
  writeFileSync(file, '<!doctype html><html><head><title>t</title></head><body><div id="app"></div></body></html>', 'utf8');
  const result = await tool('html_ui').execute(
    { op: 'render', path: 'panel.html', css: '#app{color:red}', js: 'console.log(1)', placement: 'dock-top' },
    exec(),
  );
  assert.equal(result.ok, true);
  const served = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', result.uiId, 'index.html'), 'utf8');
  assert.ok(served.includes('<div id="app"></div>'), 'the authored body survives');
  assert.ok(served.includes('#app{color:red}'), 'inline css is merged');
  assert.ok(served.includes('console.log(1)'), 'inline js is merged');
});

test('update replaces a document in place and bumps the revision', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>v1</p>' }, exec());
  const updated = await tool('html_ui').execute({ op: 'update', id: created.uiId, html: '<p>v2</p>' }, exec());
  assert.equal(updated.ok, true);
  assert.equal(updated.uiId, created.uiId);
  assert.equal(updated.revision, 2);
  const served = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', created.uiId, 'index.html'), 'utf8');
  assert.ok(served.includes('v2'));
});

test('list reports only the calling session and close removes the document', async () => {
  const mine = await tool('html_ui').execute({ op: 'render', html: '<p>mine</p>', title: 'Mine' }, exec('session-a'));
  await tool('html_ui').execute({ op: 'render', html: '<p>other</p>', title: 'Other' }, exec('session-b'));
  const listed = await tool('html_ui').execute({ op: 'list' }, exec('session-a'));
  assert.equal(listed.ok, true);
  assert.ok(listed.count >= 1);
  assert.ok(listed.summary.includes('Mine'));
  assert.ok(!listed.summary.includes('Other'));
  const closed = await tool('html_ui').execute({ op: 'close', id: mine.uiId }, exec('session-a'));
  assert.equal(closed.ok, true);
  assert.equal(existsSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', mine.uiId)), false);
});

test('unknown ids and unsupported ops fail with actionable hints', async () => {
  const missing = await tool('html_ui').execute({ op: 'close', id: 'ui-00000000' }, exec());
  assert.equal(missing.ok, false);
  assert.match(missing.hint, /op=list/u);
  const unsupported = await tool('html_ui').execute({ op: 'sing' }, exec());
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.hint, /render/u);
});

test('templates save, render with variables, list, and remove', async () => {
  const saved = await tool('html_ui_template').execute(
    { op: 'save', name: 'Counter', html: '<button id="b">{{label}}</button>', description: 'demo' },
    exec(),
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.name, 'counter');
  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec());
  assert.ok(listed.summary.includes('counter'));
  const rendered = await tool('html_ui').execute({ op: 'render', template: 'counter', variables: { label: '加一' } }, exec());
  assert.equal(rendered.ok, true);
  const served = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', rendered.uiId, 'index.html'), 'utf8');
  assert.ok(served.includes('加一'), 'variables are substituted');
  const removed = await tool('html_ui_template').execute({ op: 'remove', name: 'counter' }, exec());
  assert.equal(removed.ok, true);
  const missing = await tool('html_ui').execute({ op: 'render', template: 'counter' }, exec());
  assert.equal(missing.ok, false);
});

test('the document route demands a capability token and injects the bridge', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>doc</p>' }, exec());
  const denied = await callRoute(route(), { url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}` });
  assert.equal(denied.status, 403);

  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId, theme: 'dark' }),
  });
  assert.equal(entry.status, 200);
  const ticket = JSON.parse(entry.text);
  assert.equal(ticket.ok, true);
  assert.match(ticket.url, /theme=dark/u);

  const document = await callRoute(route(), { url: ticket.url, headers: { host: '127.0.0.1:3080' } });
  assert.equal(document.status, 200);
  assert.ok(document.text.includes('window.__DSH_HTMLUI__='), 'runtime config is injected');
  assert.ok(document.text.includes('/assets/bridge.js'), 'the bridge is injected');
  assert.ok(document.text.includes('<p>doc</p>'), 'the authored document survives');
  assert.match(document.headers['content-security-policy'], /connect-src http:\/\/127\.0\.0\.1:3080/u);
});

test('a cross-origin page cannot reach the carrier, an opaque frame can with a token', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>x</p>' }, exec());
  const foreign = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  assert.equal(foreign.status, 403);

  const crossSite = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  assert.equal(crossSite.status, 403);

  const opaqueWithoutToken = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: { host: '127.0.0.1:3080', origin: 'null' },
    body: JSON.stringify({ uiId: created.uiId, op: 'state', value: 1 }),
  });
  assert.equal(opaqueWithoutToken.status, 403);
});

test('an action from the frame becomes a user prompt in the owning session', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>x</p>', title: 'Panel' }, exec('session-action'));
  // A capability token can only be minted by the host, so ask for it through the ticket route.
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const ticket = JSON.parse(entry.text);
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(ticket.url)[1];
  assert.equal(typeof capability, 'string');

  const rpc = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: { host: '127.0.0.1:3080', origin: 'null' },
    body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'action', action: 'refresh', data: { range: '7d' } }),
  });
  assert.equal(rpc.status, 200);
  const value = JSON.parse(rpc.text);
  assert.equal(value.ok, true);
  assert.equal(harness.sessionController.prompts.length, 1);
  const prompt = harness.sessionController.prompts[0];
  assert.equal(prompt.sessionId, 'session-action');
  assert.equal(prompt.mode, 'queue');
  assert.match(prompt.content[0].text, /\[html-ui:action\] ui=ui-[0-9a-f]{8} action="refresh"/u);
  assert.match(prompt.content[0].text, /"range":"7d"/u);
});

test('state written by a frame survives a host restart', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>x</p>' }, exec('session-state'));
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];
  const written = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: { host: '127.0.0.1:3080', origin: 'null' },
    body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'state', value: { step: 3 } }),
  });
  assert.equal(written.status, 200);
  const reloaded = await callRoute(route(), { url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}?t=${capability}` });
  assert.ok(reloaded.text.includes('"step":3'), 'the persisted state is re-injected on reload');
});

test('the SSE stream applies the same origin policy as the rest of the carrier', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>x</p>' }, exec());
  const denied = await callRoute(route(), {
    url: `/plugins/@mostkia/dsh-htmlui/events?uiId=${created.uiId}&t=wrong`,
    headers: { host: '127.0.0.1:3080', origin: 'null' },
  });
  assert.equal(denied.status, 403);
});

test('a per-document rate limit protects the model from a runaway frame', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>x</p>' }, exec('session-rate'));
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];
  let limited = 0;
  for (let index = 0; index < 14; index += 1) {
    const response = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/rpc',
      headers: { host: '127.0.0.1:3080', origin: 'null' },
      body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'action', action: 'tick' }),
    });
    if (response.status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'the bucket must eventually refuse');
});

test('the health route reports the running generation and its counts', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const response = await callRoute(route(), {
    url: '/plugins/@mostkia/dsh-htmlui/health',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.ok, true);
  assert.equal(body.plugin, '@mostkia/dsh-htmlui');
  assert.equal(body.version, pkg.version, 'the reported version must match the manifest');
  assert.ok(body.placements.includes('fullscreen'));
  assert.equal(typeof body.counts.uis, 'number');
  assert.equal(typeof body.counts.templates, 'number');
  assert.equal(typeof body.counts.sseClients, 'number');
  assert.ok(!JSON.stringify(body).includes(process.env.DSH_HTMLUI_ROOT), 'the carrier never discloses the storage path');
  const foreign = await callRoute(route(), {
    url: '/plugins/@mostkia/dsh-htmlui/health',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  });
  assert.equal(foreign.status, 403);
});

test('another session cannot rewrite, remove, or freeze an interface it does not own', async () => {
  const mine = await tool('html_ui').execute({ op: 'render', html: '<p>mine</p>', title: 'Mine' }, exec('session-owner'));
  const hijack = await tool('html_ui').execute({ op: 'update', id: mine.uiId, html: '<p>hijacked</p>' }, exec('session-intruder'));
  assert.equal(hijack.ok, false);
  assert.match(hijack.error, /another session/u);
  const removal = await tool('html_ui').execute({ op: 'close', id: mine.uiId }, exec('session-intruder'));
  assert.equal(removal.ok, false);
  const stored = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', mine.uiId, 'index.html'), 'utf8');
  assert.ok(stored.includes('mine'), 'the document survives an intruder update');
  assert.ok(!stored.includes('hijacked'), 'the intruder body never lands');

  const owned = await tool('html_ui').execute({ op: 'update', id: mine.uiId, html: '<p>mine2</p>' }, exec('session-owner'));
  assert.equal(owned.ok, true, 'the owner still updates its own interface');

  const stolen = await tool('html_ui_template').execute({ op: 'save', name: 'stolen', ui_id: mine.uiId }, exec('session-intruder'));
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /another session/u);
});

test('only documents can be attached or frozen by path', async () => {
  writeFileSync(join(scratch, 'notes.txt'), 'not a document', 'utf8');
  const refused = await tool('html_ui').execute({ op: 'render', path: 'notes.txt' }, exec());
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not an HTML document/u);
  const frozen = await tool('html_ui_template').execute({ op: 'save', name: 'nope', path: 'notes.txt' }, exec());
  assert.equal(frozen.ok, false);
  assert.match(frozen.error, /not an HTML document/u);
  // The allowlist still accepts the other document spellings.
  writeFileSync(join(scratch, 'panel.htm'), '<p>htm</p>', 'utf8');
  const accepted = await tool('html_ui').execute({ op: 'render', path: 'panel.htm' }, exec());
  assert.equal(accepted.ok, true);
});

test('the SSE stream delivers model output and interface lifecycle for its session only', async () => {
  const sseClients = async () =>
    JSON.parse(
      (
        await callRoute(route(), {
          url: '/plugins/@mostkia/dsh-htmlui/health',
          headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
        })
      ).text,
    ).counts.sseClients;
  const before = await sseClients();

  const created = await tool('html_ui').execute({ op: 'render', html: '<p>stream</p>', title: 'Stream' }, exec('session-sse'));
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];

  const stream = startRoute(route(), {
    url: `/plugins/@mostkia/dsh-htmlui/events?uiId=${created.uiId}&t=${capability}`,
    headers: { host: '127.0.0.1:3080', origin: 'null' },
  });
  assert.equal(stream.res.statusCode, 200);
  assert.match(stream.res.headers['content-type'], /text\/event-stream/u);
  await tick();
  assert.match(stream.text(), /event: hello/u, 'the stream opens with a hello frame');
  assert.ok(stream.text().includes(`"uiId":"${created.uiId}"`));
  assert.equal(await sseClients(), before + 1, 'an open stream is tracked by the hub');

  // The model's streamed text is what an interface subscribes for.
  harness.ctx.emit('agent/assistant-stream', {
    agent: { session: { id: 'session-sse' } },
    frame: { type: 'chunk', chunk: { text: 'hello from the model' } },
  });
  await tick();
  assert.match(stream.text(), /event: assistant/u);
  assert.ok(stream.text().includes('"text":"hello from the model"'));

  // Another session's traffic must never reach this document.
  harness.ctx.emit('agent/assistant-stream', {
    agent: { session: { id: 'session-elsewhere' } },
    frame: { type: 'chunk', chunk: { text: 'private' } },
  });
  await tick();
  assert.ok(!stream.text().includes('private'), 'a stream is scoped to its own session');

  // Durable session events and interface lifecycle frames ride the same stream.
  harness.ctx.emit('session/event', { id: 'session-sse' }, { seq: 41, type: 'message' });
  await tick();
  assert.match(stream.text(), /event: session/u);
  assert.ok(stream.text().includes('"seq":41'));

  await tool('html_ui').execute({ op: 'update', id: created.uiId, html: '<p>stream2</p>' }, exec('session-sse'));
  await tick();
  assert.match(stream.text(), /event: ui/u);
  assert.ok(stream.text().includes('"action":"update"'));

  // A closed request leaves the hub, so a long-lived host does not accumulate streams.
  stream.emit('close');
  assert.equal(await sseClients(), before, 'a closed stream is released');
});

test('a hand-written template is just an html file in the templates directory', async () => {
  const directory = join(process.env.DSH_HTMLUI_ROOT, 'templates');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'my-panel.html'), '<h1>{{title}}</h1>', 'utf8');

  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec());
  assert.ok(listed.summary.includes('my-panel'), 'a dropped file is listed as a template');
  const rendered = await tool('html_ui').execute({ op: 'render', template: 'my-panel', variables: { title: '手写模板' } }, exec());
  assert.equal(rendered.ok, true);
  const served = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', rendered.uiId, 'index.html'), 'utf8');
  assert.ok(served.includes('手写模板'), 'variables apply to a hand-written template too');

  // A managed template of the same name takes precedence while it exists.
  await tool('html_ui_template').execute({ op: 'save', name: 'my-panel', html: '<p>managed</p>' }, exec());
  const managed = await tool('html_ui').execute({ op: 'render', template: 'my-panel' }, exec());
  assert.ok(readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', managed.uiId, 'index.html'), 'utf8').includes('managed'));

  // Removing the managed one uncovers the hand-written file, then removes it.
  await tool('html_ui_template').execute({ op: 'remove', name: 'my-panel' }, exec());
  const uncovered = await tool('html_ui').execute({ op: 'render', template: 'my-panel' }, exec());
  assert.equal(uncovered.ok, true, 'the hand-written file is in force again');
  assert.ok(readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', uncovered.uiId, 'index.html'), 'utf8').includes('{{title}}'));
  assert.equal((await tool('html_ui_template').execute({ op: 'remove', name: 'my-panel' }, exec())).ok, true);
  assert.equal((await tool('html_ui').execute({ op: 'render', template: 'my-panel' }, exec())).ok, false);
});

test('the document URL changes with the revision so an update reloads the frame', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>v1</p>' }, exec('session-rev'));
  assert.match(created.url, /[?&]r=1(?:&|$)/u, 'the first document carries its revision');
  const ticket = async () => {
    const entry = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ uiId: created.uiId }),
    });
    return JSON.parse(entry.text).url;
  };
  const before = await ticket();
  await tool('html_ui').execute({ op: 'update', id: created.uiId, html: '<p>v2</p>' }, exec('session-rev'));
  const after = await ticket();
  assert.notEqual(before, after, 'a new revision must yield a different URL');
  assert.match(after, /[?&]r=2(?:&|$)/u);
  // The token is unchanged: it identifies the document, not its revision.
  assert.equal(/t=([A-Za-z0-9_-]+)/u.exec(before)[1], /t=([A-Za-z0-9_-]+)/u.exec(after)[1]);
  // And the composed document really serves the new body.
  const served = await callRoute(route(), { url: after, headers: { host: '127.0.0.1:3080' } });
  assert.ok(served.text.includes('v2'));
});

test('an explicitly allowed origin works on an exposed deployment', async () => {
  // The default posture refuses a non-loopback page; an operator who exposes the
  // server on purpose lists its origin, and only that origin, instead.
  const server = createFakeServer();
  const tools = { registered: [], register(definition) { this.registered.push(definition); return () => {}; } };
  const systemPrompt = { sections: [], section(entry) { this.sections.push(entry); return () => {}; }, getSectionOrder() { return 10; } };
  const context = createContext({ webServer: server, tools, systemPrompt, sessionController: createFakeSessionController() });
  apply(context.ctx, { allowedOrigins: ['http://dsh.lan:3080', 'not a url'] });
  const route = server.routes[0];

  const refused = await callRoute(route, {
    url: '/plugins/@mostkia/dsh-htmlui/health',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  });
  assert.equal(refused.status, 403, 'an unlisted origin stays refused');

  const allowed = await callRoute(route, {
    url: '/plugins/@mostkia/dsh-htmlui/health',
    headers: { host: 'dsh.lan:3080', origin: 'http://dsh.lan:3080' },
  });
  assert.equal(allowed.status, 200);
  const body = JSON.parse(allowed.text);
  assert.equal(body.trust.loopbackOnly, false);
  assert.equal(body.trust.allowedOrigins, 1, 'an unusable entry is ignored');

  // The frame's opaque origin still needs a token even on an exposed deployment.
  const opaque = await callRoute(route, {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: { host: 'dsh.lan:3080', origin: 'null' },
    body: JSON.stringify({ uiId: 'ui-00000000', op: 'state', value: 1 }),
  });
  assert.equal(opaque.status, 403);
  for (const dispose of context.disposed) {
    try {
      dispose();
    } catch {
      /* best effort */
    }
  }
});

test('a capability token never reaches a durable projection', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>token</p>', title: 'Token' }, exec('session-token'));
  assert.ok(!created.url.includes('t='), 'the tool value must not carry the token');
  const projection = tool('html_ui').output.presentationMeta({}, created);
  assert.ok(!JSON.stringify(projection).includes('t='), 'the tool projection must not carry the token');

  const listed = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/list',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ sessionId: 'session-token' }),
  });
  assert.equal(listed.status, 200);
  assert.ok(!listed.text.includes('t='), 'the list response must not carry the token');

  const onDisk = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', created.uiId, 'meta.json'), 'utf8');
  assert.ok(!onDisk.includes('t='), 'the record on disk must not carry the token');

  // The ticket is the one place it appears, and the document cannot be fetched
  // without it.
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url);
  assert.ok(capability !== null, 'the ticket hands out the capability');
  const bare = await callRoute(route(), { url: created.url, headers: { host: '127.0.0.1:3080' } });
  assert.equal(bare.status, 403, 'the token-free address is not loadable');
  const framed = await callRoute(route(), { url: JSON.parse(entry.text).url, headers: { host: '127.0.0.1:3080' } });
  assert.equal(framed.status, 200);
});

test('every presentation projection stays lossless JSON', async () => {
  // The registry rejects a projection carrying `undefined`, including a bare
  // `undefined` return, so this guards the fix for that failure.
  const definition = tool('html_ui');
  const values = [
    await definition.execute({ op: 'list' }, exec()),
    await definition.execute({ op: 'render', html: '<p>x</p>' }, exec()),
    await definition.execute({ op: 'close', id: 'ui-00000000' }, exec()),
    await definition.execute({ op: 'sing' }, exec()),
  ];
  for (const value of values) {
    const meta = definition.output.presentationMeta({}, value);
    assert.notEqual(meta, undefined, 'a projection must be an object, never undefined');
    for (const [key, member] of Object.entries(meta)) {
      assert.notEqual(member, undefined, `projection member ${key} must not be undefined`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, 'the projection must round-trip losslessly');
  }
  const template = tool('html_ui_template');
  for (const value of [
    await template.execute({ op: 'list' }, exec()),
    await template.execute({ op: 'save', name: 'lossless', html: '<p>x</p>' }, exec()),
  ]) {
    const meta = template.output.presentationMeta({}, value);
    assert.notEqual(meta, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
  }
});

test('every stored document keeps the authored document free of plugin markup on disk', async () => {
  const file = join(scratch, 'clean.html');
  writeFileSync(file, '<!doctype html><html><head></head><body><p>clean</p></body></html>', 'utf8');
  const created = await tool('html_ui').execute({ op: 'render', path: file }, exec());
  const stored = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', created.uiId, 'index.html'), 'utf8');
  assert.ok(!stored.includes('__DSH_HTMLUI__'), 'injection happens at serve time, not on disk');
  assert.ok(!stored.includes('bridge.js'));
});
