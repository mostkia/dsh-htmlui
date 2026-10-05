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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    { op: 'render', path: 'panel.html', css: '#app{color:red}', js: 'console.log(1)', placement: 'dock-right' },
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

/**
 * Point the catalogue at a directory of the reader's own, as the dialog's folder picker
 * does. The catalogue holds the blank canvas plus this directory and nothing else, so
 * every template test starts here.
 */
function useTemplatesDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-htmlui-${label}-`));
  writeFileSync(join(process.env.DSH_HTMLUI_ROOT, 'settings.json'), JSON.stringify({ templatesDir: dir, templatesAsked: true }), 'utf8');
  return dir;
}

/** Take the directory away again, leaving only the blank canvas. */
function clearTemplatesDir() {
  writeFileSync(join(process.env.DSH_HTMLUI_ROOT, 'settings.json'), JSON.stringify({ templatesAsked: true }), 'utf8');
}

test('templates save, render with variables, list, and remove', async () => {
  useTemplatesDir('save');
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

test('the document policy lets the injected bridge load in an opaque origin', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>csp</p>' }, exec('session-csp'));
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const framed = await callRoute(route(), { url: JSON.parse(entry.text).url, headers: { host: '127.0.0.1:3080' } });
  const csp = framed.headers['content-security-policy'];
  const directives = new Map(
    csp.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/u);
      return [name, sources];
    }),
  );
  // The bridge is an external same-origin script. A sandboxed frame has an opaque
  // origin, where 'self' matches nothing, so the script source must name the host:
  // without it the browser blocks the bridge and every document loses its API.
  assert.ok(directives.get('script-src').includes('http://127.0.0.1:3080'), `script-src must allow the host: ${csp}`);
  assert.ok(!directives.get('script-src').includes("'self'"), 'an opaque origin cannot use self');
  assert.ok(directives.get('script-src').includes("'unsafe-inline'"), 'the runtime config is inline');
  // The frame is embedded by the host page, so frame-ancestors must name it too.
  assert.deepEqual(directives.get('frame-ancestors'), ['http://127.0.0.1:3080', 'https://127.0.0.1:3080']);
  assert.ok(directives.get('style-src').includes('http://127.0.0.1:3080'));
  assert.ok(directives.get('font-src').includes('http://127.0.0.1:3080'));
  assert.ok(!csp.includes("'self'"), `no directive may rely on self in an opaque origin: ${csp}`);
  assert.ok(framed.text.includes('/assets/bridge.js'), 'and the bridge is what that allowance is for');
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
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hello from the model' } },
  });
  await tick();
  assert.match(stream.text(), /event: assistant/u);
  assert.ok(stream.text().includes('"text":"hello from the model"'));

  // Reasoning carries a `text` field too, but it is not assistant output.
  harness.ctx.emit('agent/assistant-stream', {
    agent: { session: { id: 'session-sse' } },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'weighing options' } },
  });
  await tick();
  assert.match(stream.text(), /event: reasoning/u);
  assert.ok(stream.text().includes('"text":"weighing options"'));
  // Frame by frame: reasoning must not ride the assistant event.
  const frames = stream.text().split('\n\n').filter((block) => block.trim().length > 0);
  const reasoningFrame = frames.find((block) => block.includes('weighing options'));
  assert.ok(reasoningFrame !== undefined && reasoningFrame.startsWith('event: reasoning'), 'reasoning rides its own event');
  const textFrame = frames.find((block) => block.includes('hello from the model'));
  assert.ok(textFrame !== undefined && textFrame.startsWith('event: assistant'), 'text rides the assistant event');
  assert.ok(!textFrame.includes('weighing options'));

  // A tool call in flight is reported as a tool frame, not as text.
  harness.ctx.emit('agent/assistant-stream', {
    agent: { session: { id: 'session-sse' } },
    frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'grep', argumentsDelta: '{"q"' } },
  });
  await tick();
  assert.ok(stream.text().includes('"type":"tool"'));
  assert.ok(stream.text().includes('"name":"grep"'));

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

test('a hand-written template is just an html file in the reader directory', async () => {
  const directory = useTemplatesDir('handwritten');
  writeFileSync(join(directory, 'my-panel.html'), '<h1>{{title}}</h1>', 'utf8');

  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec());
  assert.ok(listed.summary.includes('my-panel'), 'a dropped file is listed as a template');
  const rendered = await tool('html_ui').execute({ op: 'render', template: 'my-panel', variables: { title: '手写模板' } }, exec());
  assert.equal(rendered.ok, true);
  const served = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', rendered.uiId, 'index.html'), 'utf8');
  assert.ok(served.includes('手写模板'), 'variables apply to a hand-written template too');

  // A managed template of the same name takes precedence while it exists, and it is
  // written into the same directory — there is only the one catalogue now.
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
  clearTemplatesDir();
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

test('a document can declare where it belongs, and an argument outranks it', async () => {
  const declared = `<!doctype html><html><head>
    <meta name="dsh-htmlui" content="placement=dock-right; size=520x360+40+40; title=自述位置">
    </head><body><p>declared</p></body></html>`;
  const byMeta = await tool('html_ui').execute({ op: 'render', html: declared }, exec('session-declare'));
  assert.equal(byMeta.ok, true);
  assert.equal(byMeta.placement, 'dock-right', 'the meta declaration is honoured');
  assert.equal(byMeta.size, '520x360+40+40');
  assert.equal(byMeta.title, '自述位置');

  const byAttribute = `<!doctype html><html data-dsh-htmlui-placement="float" data-dsh-htmlui-size="420x300"><body><p>attr</p></body></html>`;
  const attr = await tool('html_ui').execute({ op: 'render', html: byAttribute }, exec('session-declare'));
  assert.equal(attr.placement, 'float');
  assert.equal(attr.size, '420x300');

  // The tool argument wins, and a nonsense declaration is ignored, not fatal.
  const overridden = await tool('html_ui').execute(
    { op: 'render', html: declared, placement: 'inline', title: '参数优先' },
    exec('session-declare'),
  );
  assert.equal(overridden.placement, 'inline');
  assert.equal(overridden.title, '参数优先');

  const nonsense = await tool('html_ui').execute(
    { op: 'render', html: '<meta name="dsh-htmlui" content="placement=teleport; size=nope">' },
    exec('session-declare'),
  );
  assert.equal(nonsense.ok, true);
  assert.equal(nonsense.placement, 'inline', 'an unusable placement falls back to the default');
  assert.equal(nonsense.size, '', 'and an unusable size is dropped');

  // An update whose document declares nothing keeps what the record already had.
  const moved = await tool('html_ui').execute({ op: 'update', id: byMeta.uiId, html: '<p>quiet</p>' }, exec('session-declare'));
  assert.equal(moved.placement, 'dock-right', 'an undeclared update keeps the record placement');
  assert.equal(moved.title, '自述位置');

  // Declaring a new one moves it.
  const renamed = await tool('html_ui').execute(
    { op: 'update', id: byMeta.uiId, html: '<meta name="dsh-htmlui" content="placement=float; title=Moved">' },
    exec('session-declare'),
  );
  assert.equal(renamed.placement, 'float');
  assert.equal(renamed.title, 'Moved');
});

test('the blank canvas renders like any other template, with nothing configured', async () => {
  // The catalogue is the blank canvas plus the reader's directory, so on a fresh store
  // this is the one entry, and it has to render without any file behind it.
  clearTemplatesDir();
  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec());
  assert.ok(listed.summary.includes('blank'), 'the blank canvas is listed');

  const rendered = await tool('html_ui').execute(
    { op: 'render', template: 'blank', title: '画布' },
    exec('session-blank'),
  );
  assert.equal(rendered.ok, true);
  assert.equal(rendered.placement, 'dock-right', 'the blank canvas declares its own placement');
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: rendered.uiId }),
  });
  const framed = await callRoute(route(), { url: JSON.parse(entry.text).url, headers: { host: '127.0.0.1:3080' } });
  assert.ok(framed.text.includes('HTML 画布'), 'the built-in document is served');
  assert.ok(framed.text.includes('/assets/bridge.js'), 'the bridge is injected into it');

  const onDisk = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', rendered.uiId, 'index.html'), 'utf8');
  assert.ok(onDisk.includes('HTML 画布'));
  assert.ok(!onDisk.includes('bridge.js'), 'injection stays at serve time');
});

test('list reports every interface of a session, so each id stays reachable', async () => {
  const sessionId = 'session-many';
  const ids = [];
  for (let index = 0; index < 13; index += 1) {
    const made = await tool('html_ui').execute({ op: 'render', html: `<p>${index}</p>`, title: `Many ${index}` }, exec(sessionId));
    assert.equal(made.ok, true);
    ids.push(made.uiId);
  }
  const listed = await tool('html_ui').execute({ op: 'list' }, exec(sessionId));
  assert.equal(listed.count, 13);
  for (const id of ids) {
    assert.ok(listed.summary.includes(id), `${id} must be listed, or the model cannot close it`);
  }
});

test('a fragment is served in standards mode, and an authored doctype is kept', async () => {
  const fragment = await tool('html_ui').execute({ op: 'render', html: '<div>fragment</div>' }, exec('session-doctype'));
  const ticket = async (uiId) => {
    const entry = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ uiId }),
    });
    return callRoute(route(), { url: JSON.parse(entry.text).url, headers: { host: '127.0.0.1:3080' } });
  };
  const served = await ticket(fragment.uiId);
  assert.match(served.text, /^<!doctype html>/iu, 'a fragment must not be served in quirks mode');
  assert.ok(served.text.includes('<div>fragment</div>'), 'and the fragment survives');
  assert.equal(served.text.match(/<!doctype/giu).length, 1, 'exactly one doctype');

  const full = await tool('html_ui').execute({
    op: 'render',
    html: '<!doctype html><html><head><title>t</title></head><body><p>full</p></body></html>',
  }, exec('session-doctype'));
  const servedFull = await ticket(full.uiId);
  assert.equal(servedFull.text.match(/<!doctype/giu).length, 1, 'an authored doctype is not doubled');
  assert.match(servedFull.text, /^<!doctype html>/iu);

  // The stored document is never rewritten: injection and the doctype are serve-time.
  const stored = readFileSync(join(process.env.DSH_HTMLUI_ROOT, 'ui', fragment.uiId, 'index.html'), 'utf8');
  assert.equal(stored, '<div>fragment</div>');
});

test('the page can list templates and apply one without the model', async () => {
  const listed = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: '{}',
  });
  assert.equal(listed.status, 200);
  const catalogue = JSON.parse(listed.text);
  assert.ok(catalogue.count >= 1);
  const blank = catalogue.templates.find((template) => template.slug === 'blank');
  assert.ok(blank !== undefined, 'the blank canvas is in the catalogue');
  assert.equal(blank.bundled, true);
  assert.equal(catalogue.configured, false, 'nothing is configured on a fresh store');

  const applied = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates/render',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ template: 'blank', sessionId: 'session-drawer' }),
  });
  assert.equal(applied.status, 200);
  const record = JSON.parse(applied.text).ui;
  assert.equal(record.sessionId, 'session-drawer');
  assert.equal(record.placement, 'dock-right', 'the template declares its own placement');
  assert.ok(!record.url.includes('t='), 'the record projection stays token-free');
  // It is a real record: the model can list and close it like any other.
  const listedAgain = await tool('html_ui').execute({ op: 'list' }, exec('session-drawer'));
  assert.ok(listedAgain.summary.includes(record.uiId));
  const closed = await tool('html_ui').execute({ op: 'close', id: record.uiId }, exec('session-drawer'));
  assert.equal(closed.ok, true);

  // Refusals are statuses, not crashes.
  const cases = [
    [{ template: 'blank' }, 400, /sessionId/u],
    [{ sessionId: 'session-drawer' }, 400, /template name/u],
    [{ template: 'nope', sessionId: 'session-drawer' }, 404, /unknown template/u],
  ];
  for (const [body, status, expected] of cases) {
    const response = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/templates/render',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, JSON.stringify(body));
    assert.match(JSON.parse(response.text).error, expected);
  }
  const foreign = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    body: '{}',
  });
  assert.equal(foreign.status, 403, 'the catalogue is for the page, not for another origin');
});

test('freezing an interface accepts either field name and still checks ownership', async () => {
  useTemplatesDir('freeze');
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>freeze me</p>', title: 'Freeze' }, exec('session-freeze'));
  // `id` is what the html_ui tool calls this field; a model carrying it across must
  // not be told there is nothing to save.
  const byAlias = await tool('html_ui_template').execute({ op: 'save', name: 'frozen-alias', id: created.uiId }, exec('session-freeze'));
  assert.equal(byAlias.ok, true, byAlias.error ?? 'the alias must work');
  const byName = await tool('html_ui_template').execute({ op: 'save', name: 'frozen-name', ui_id: created.uiId }, exec('session-freeze'));
  assert.equal(byName.ok, true);
  // The alias does not bypass the ownership check.
  const intruder = await tool('html_ui_template').execute({ op: 'save', name: 'stolen-alias', id: created.uiId }, exec('session-other'));
  assert.equal(intruder.ok, false);
  assert.match(intruder.error, /another session/u);
  await tool('html_ui_template').execute({ op: 'remove', name: 'frozen-alias' }, exec('session-freeze'));
  await tool('html_ui_template').execute({ op: 'remove', name: 'frozen-name' }, exec('session-freeze'));
});

test('the carrier list is scoped to one session and cannot be unscoped', async () => {
  await tool('html_ui').execute({ op: 'render', html: '<p>mine</p>' }, exec('session-scoped-a'));
  await tool('html_ui').execute({ op: 'render', html: '<p>theirs</p>' }, exec('session-scoped-b'));
  const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };
  const scoped = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/list',
    headers,
    body: JSON.stringify({ sessionId: 'session-scoped-a' }),
  });
  assert.equal(scoped.status, 200);
  const records = JSON.parse(scoped.text).uis;
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, 'session-scoped-a');

  // No session, no list: the model's cross-session view is its own tool.
  const unscoped = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/list',
    headers,
    body: '{}',
  });
  assert.equal(unscoped.status, 400);
  assert.match(JSON.parse(unscoped.text).error, /sessionId/u);
});

test('resizing rewrites only the record, not the document', async () => {
  const created = await tool('html_ui').execute({ op: 'render', html: '<p>resizable</p>' }, exec('session-resize'));
  const entry = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const token = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];
  const documentPath = join(process.env.DSH_HTMLUI_ROOT, 'ui', created.uiId, 'index.html');
  const before = statSync(documentPath).mtimeMs;

  const resized = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: { host: '127.0.0.1:3080', origin: 'null' },
    body: JSON.stringify({ t: token, uiId: created.uiId, op: 'resize', size: '640x480+20+20' }),
  });
  assert.equal(resized.status, 200);
  assert.equal(JSON.parse(resized.text).size, '640x480+20+20');
  await tick();
  assert.equal(statSync(documentPath).mtimeMs, before, 'the document file must not be rewritten');

  // A no-op resize is free: it does not spend the bucket, so a frame cannot be
  // throttled by repeating its own size.
  for (let index = 0; index < 20; index += 1) {
    const again = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/rpc',
      headers: { host: '127.0.0.1:3080', origin: 'null' },
      body: JSON.stringify({ t: token, uiId: created.uiId, op: 'resize', size: '640x480+20+20' }),
    });
    assert.equal(again.status, 200, 'an unchanged size is not rate limited');
  }
});

test('a composed document over the cap is refused before it is stored', async () => {
  const file = join(scratch, 'big.html');
  const half = 'x'.repeat(600 * 1024);
  writeFileSync(file, `<p>${half}</p>`, 'utf8');
  const before = readdirSync(join(process.env.DSH_HTMLUI_ROOT, 'ui')).length;
  // The file alone is under the cap; the inline parts are what push it over.
  const refused = await tool('html_ui').execute(
    { op: 'render', path: file, css: `/*${half}*/`, js: `//${half}` },
    exec('session-big'),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /larger than/u);
  assert.equal(readdirSync(join(process.env.DSH_HTMLUI_ROOT, 'ui')).length, before, 'nothing is stored');
});

test('the catalogue reads the directory the reader chose', async () => {
  // The list is not a fixed set: it is whatever the directories hold, and the reader's
  // own directory is read first. The setting is a plain file, so this checks the scan
  // order rather than the route that writes it.
  const own = mkdtempSync(join(tmpdir(), 'dsh-htmlui-templates-'));
  writeFileSync(
    join(own, 'mine.html'),
    '<!doctype html><html><head><meta name="dsh-htmlui" content="placement=float"></head><body>mine</body></html>',
    'utf8',
  );
  const settingsPath = join(process.env.DSH_HTMLUI_ROOT, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ templatesDir: own, templatesAsked: true }), 'utf8');

  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec('session-dir'));
  assert.ok(listed.summary.includes('mine'), 'a template in the reader directory is listed');

  const rendered = await tool('html_ui').execute({ op: 'render', template: 'mine' }, exec('session-dir'));
  assert.equal(rendered.ok, true, rendered.error ?? 'and it renders like any other');
  assert.equal(rendered.placement, 'float', 'with the placement the file declares');

  // Clearing the setting goes back to the defaults, which do not have it.
  writeFileSync(settingsPath, JSON.stringify({ templatesAsked: true }), 'utf8');
  const after = await tool('html_ui_template').execute({ op: 'list' }, exec('session-dir'));
  assert.ok(!after.summary.includes('mine'), 'and it is gone once the directory is cleared');
});

test('a copied-in folder is adopted with the manifest the reader filled in', async () => {
  const own = mkdtempSync(join(tmpdir(), 'dsh-htmlui-adopt-'));
  writeFileSync(join(process.env.DSH_HTMLUI_ROOT, 'settings.json'), JSON.stringify({ templatesDir: own, templatesAsked: true }), 'utf8');
  // A folder the reader filled themselves: html inside, no manifest, so it lists nowhere.
  mkdirSync(join(own, '我的页面'), { recursive: true });
  writeFileSync(join(own, '我的页面', 'page.html'), '<p>hello</p>', 'utf8');

  const before = await tool('html_ui_template').execute({ op: 'list' }, exec('session-adopt'));
  assert.ok(!before.summary.includes('我的页面'), 'it is not a project yet');

  const adopted = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates/adopt',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({
      name: '我的页面',
      meta: { slug: 'my-page', name: '我的页面', description: '一个自己拷进来的页面', placement: 'float' },
    }),
  });
  assert.equal(adopted.status, 200, `adopt said: ${adopted.text}`);
  const saved = JSON.parse(adopted.text);
  assert.equal(saved.slug, 'my-page', 'the id the reader chose is used');
  const meta = JSON.parse(readFileSync(join(own, '我的页面', 'meta.json'), 'utf8'));
  assert.equal(meta.name, '我的页面');
  assert.equal(meta.description, '一个自己拷进来的页面');
  assert.equal(meta.placement, 'float');
  // The differently named html file is copied to index.html so the folder reads as one
  // project, and the reader's own file is left where they put it.
  assert.ok(existsSync(join(own, '我的页面', 'index.html')));
  assert.ok(existsSync(join(own, '我的页面', 'page.html')), 'the original is untouched');

  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec('session-adopt'));
  assert.ok(listed.summary.includes('my-page'), 'and it is a project from then on');
  const rendered = await tool('html_ui').execute({ op: 'render', template: 'my-page' }, exec('session-adopt'));
  assert.equal(rendered.ok, true, rendered.error ?? 'it renders');
  assert.equal(rendered.placement, 'float', 'the manifest placement is honoured');

  // A traversal-shaped name is refused: only names inside the directory are adoptable.
  const refused = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates/adopt',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ name: '../../escape' }),
  });
  assert.equal(refused.status, 400);
  clearTemplatesDir();
});

test('an existing project is edited in place, addressed by its slug', async () => {
  // The pencil beside a project reopens the same form. The folder is called 我的页面 and
  // the project's id is my-page, so the request addresses the id and the manifest has to
  // be found by it — and the edit must not turn into a rename or a second project.
  const own = mkdtempSync(join(tmpdir(), 'dsh-htmlui-edit-'));
  writeFileSync(join(process.env.DSH_HTMLUI_ROOT, 'settings.json'), JSON.stringify({ templatesDir: own, templatesAsked: true }), 'utf8');
  mkdirSync(join(own, '我的页面'), { recursive: true });
  writeFileSync(join(own, '我的页面', 'index.html'), '<p>hello</p>', 'utf8');
  writeFileSync(
    join(own, '我的页面', 'meta.json'),
    JSON.stringify({ slug: 'my-page', name: '我的页面', description: '旧描述', placement: 'inline' }),
    'utf8',
  );

  const edited = await callRoute(route(), {
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/templates/adopt',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ name: 'my-page', meta: { slug: 'my-page', name: '改名后的页面', description: '新描述', placement: 'float' } }),
  });
  assert.equal(edited.status, 200);
  assert.equal(JSON.parse(edited.text).slug, 'my-page', 'the same project keeps its id');
  assert.ok(existsSync(join(own, '我的页面', 'meta.json')), 'and stays in its folder');

  const saved = JSON.parse(readFileSync(join(own, '我的页面', 'meta.json'), 'utf8'));
  assert.equal(saved.name, '改名后的页面');
  assert.equal(saved.description, '新描述');
  assert.equal(saved.placement, 'float');

  const listed = await tool('html_ui_template').execute({ op: 'list' }, exec('session-edit'));
  assert.equal((listed.summary.match(/my-page/gu) ?? []).length, 1, 'editing must not leave a second entry behind');
  clearTemplatesDir();
});

test('a project at a higher security level serves its own files, and only then', async () => {
  // A project the reader imported brings its own app.js. At `strict` that request must
  // 404 — the default stays what it always was — and at `local` the file is served from
  // the project's own folder, with the document served beside it so relative paths work.
  const own = mkdtempSync(join(tmpdir(), 'dsh-htmlui-sec-'));
  writeFileSync(join(process.env.DSH_HTMLUI_ROOT, 'settings.json'), JSON.stringify({ templatesDir: own, templatesAsked: true }), 'utf8');
  mkdirSync(join(own, 'site'), { recursive: true });
  writeFileSync(join(own, 'site', 'index.html'), '<p>site</p>', 'utf8');
  writeFileSync(join(own, 'site', 'app.js'), 'console.log(1);', 'utf8');
  writeFileSync(join(own, 'site', 'meta.json'), JSON.stringify({ slug: 'site', name: 'site', security: 'local' }), 'utf8');

  // The ticket route hands out the capability token the frame will use.
  const ticketFor = async (uiId) => {
    const ticket = await callRoute(route(), {
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ uiId, sessionId: 'session-sec' }),
    });
    const url = JSON.parse(ticket.text).url;
    if (typeof url !== 'string') throw new Error(`ticket said: ${ticket.text}`);
    // The capability is in the path for a project that serves files, and in the query for
    // the plain document route. The helper reads whichever this interface uses.
    const pathMatch = /\/files\/[^/]+\/([^/]+)\//u.exec(url);
    const queryMatch = /[?&]t=([^&]+)/u.exec(url);
    const capability = pathMatch === null ? queryMatch[1] : pathMatch[1];
    return { token: capability, url, file: (name) => `/plugins/@mostkia/dsh-htmlui/files/${uiId}/${capability}/${name}` };
  };
  const getRoute = (url) => callRoute(route(), { method: 'GET', url, headers: { host: '127.0.0.1:3080' } });

  const strictRendered = await tool('html_ui').execute({ op: 'render', html: '<p>strict</p>', placement: 'inline' }, exec('session-sec'));
  assert.equal(strictRendered.ok, true, strictRendered.error ?? 'strict still renders');
  assert.equal(strictRendered.security, 'strict', 'an interface with no project level is strict');
  const strictTicket = await ticketFor(strictRendered.uiId);
  assert.match(strictTicket.url, /\/ui\/ui-/u, 'a strict interface keeps the plain document URL');
  const strictFile = await getRoute(strictTicket.file('app.js'));
  assert.equal(strictFile.status, 404, 'a strict interface serves no files');

  const rendered = await tool('html_ui').execute({ op: 'render', template: 'site' }, exec('session-sec'));
  assert.equal(rendered.ok, true, rendered.error ?? 'the project renders');
  assert.equal(rendered.security, 'local', 'the project carries the level it was imported with');
  const ticket = await ticketFor(rendered.uiId);
  assert.match(ticket.url, /\/files\/.*\/index\.html/u, 'a project at a higher level is served with a directory URL');
  const file = await getRoute(ticket.file('app.js'));
  assert.equal(file.status, 200, `the project's own file is served: ${file.text.slice(0, 80)}`);
  assert.match(file.text, /console\.log/u);

  const document = await getRoute(ticket.file('index.html'));
  assert.equal(document.status, 200, 'and the document itself is served there too');
  assert.match(document.text, /<p>site<\/p>/u);

  // Escaping the project folder is refused rather than read.
  const escaped = await getRoute(`/plugins/@mostkia/dsh-htmlui/files/${rendered.uiId}/${ticket.token}/../../../settings.json`);
  assert.ok(escaped.status === 403 || escaped.status === 404, `a path outside the project is not served (${escaped.status})`);

  const wrongToken = await getRoute(`/plugins/@mostkia/dsh-htmlui/files/${rendered.uiId}/nope/app.js`);
  assert.equal(wrongToken.status, 403, 'and the capability token is still required');

  // A nested relative reference — `css/style.css` — carries the token from the document's
  // own URL, because a subresource request has no query string to put it in.
  mkdirSync(join(own, 'site', 'css'), { recursive: true });
  writeFileSync(join(own, 'site', 'css', 'style.css'), 'body{color:red}', 'utf8');
  const nested = await getRoute(ticket.file('css/style.css'));
  assert.equal(nested.status, 200, `a nested relative path resolves: ${nested.text.slice(0, 60)}`);
  assert.match(nested.text, /color:red/u);
  clearTemplatesDir();
});

test('every tool renders content blocks, not a bare string', () => {
  // The harness takes `output.render`'s return value as the result's `content` and
  // calls `.some()` on it. A tool that returned a string therefore failed every single
  // call — the template tool did, and no test noticed because they only call execute.
  const samples = {
    html_ui: [
      { ok: true, op: 'render', uiId: 'ui-aaaa0001', title: 'T', placement: 'inline', size: '', bytes: 10, revision: 1 },
      { ok: false, op: 'render', error: 'nope' },
      { ok: true, op: 'list', count: 1, summary: 'ui-aaaa0001 inline T' },
    ],
    html_ui_template: [
      { ok: true, op: 'save', name: 'x', bytes: 10 },
      { ok: false, op: 'show', error: 'unknown template: x' },
      { ok: true, op: 'list', count: 1, summary: 'x' },
    ],
  };
  for (const definition of [tool('html_ui'), tool('html_ui_template')]) {
    const values = samples[definition.name];
    assert.ok(Array.isArray(values), `no samples for ${definition.name}`);
    for (const value of values) {
      const blocks = definition.output.render({}, value);
      assert.ok(Array.isArray(blocks), `${definition.name} must render an array of content blocks`);
      assert.ok(blocks.length > 0, `${definition.name} must render at least one block`);
      for (const block of blocks) {
        assert.equal(block.type, 'text');
        assert.equal(typeof block.text, 'string');
        assert.ok(block.text.length > 0, `${definition.name} rendered an empty block`);
      }
    }
  }
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
