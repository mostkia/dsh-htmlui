/**
 * Bridge regression tests for @mostkia/dsh-htmlui.
 *
 * `assets/bridge.js` is the API every authored document calls, and it normally
 * only runs inside a sandboxed iframe. These tests run it in Node against a fake
 * window, document, fetch, and EventSource, so the published bridge contract is
 * checked without a browser.
 *
 * Run: node test/bridge.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../assets/bridge.js', import.meta.url), 'utf8');

/** Install one fake document environment and evaluate the bridge in it. */
function loadBridge(config) {
  const calls = [];
  const dispatched = [];
  const posted = [];
  const logs = [];
  const frames = new Set();
  const element = { attributes: {}, setAttribute: (name, value) => { element.attributes[name] = value; } };
  const document = {
    documentElement: element,
    dispatchEvent: (event) => dispatched.push(event),
  };
  const window_ = {
    __DSH_HTMLUI__: config,
    parent: { postMessage: (message) => posted.push(message) },
    addEventListener: (name, handler) => frames.add({ name, handler }),
    dispatchEvent: () => {},
  };
  window_.parent.parent = window_.parent;
  const EventSource = function EventSource(url) {
    this.url = url;
    this.listeners = new Map();
    this.addEventListener = (name, handler) => {
      const bucket = this.listeners.get(name) ?? [];
      bucket.push(handler);
      this.listeners.set(name, bucket);
    };
    this.emit = (name, data) => {
      for (const handler of this.listeners.get(name) ?? []) handler({ data: JSON.stringify(data) });
    };
    calls.push({ kind: 'eventsource', url });
  };
  const fetch_ = (url, init) => {
    const body = init === undefined ? undefined : JSON.parse(init.body);
    calls.push({ kind: 'fetch', url, body, init });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, actionId: 'a-1' }) });
  };
  const CustomEvent = function CustomEvent(type, init) {
    this.type = type;
    this.detail = init === undefined ? undefined : init.detail;
  };

  const run = new Function('window', 'document', 'fetch', 'EventSource', 'CustomEvent', 'console', source);
  // A recording console keeps expected warnings out of the run's stderr.
  const fakeConsole = {
    warn: (...args) => logs.push(args.map((value) => String(value)).join(' ')),
    info: () => {},
    error: (...args) => logs.push(args.map((value) => String(value)).join(' ')),
  };
  run(window_, document, fetch_, EventSource, CustomEvent, fakeConsole);
  return { window: window_, document, calls, dispatched, posted, frames, logs };
}

const baseConfig = {
  pluginVersion: '0.1.1',
  uiId: 'ui-1a2b3c4d',
  sessionId: 'session-1',
  token: 'tok-123',
  routeBase: '/plugins/@mostkia/dsh-htmlui',
  title: 'Panel',
  placement: 'inline',
  initialTheme: 'dark',
  state: { step: 3 },
};

test('installs exactly one bridge with the documented surface', () => {
  const env = loadBridge(baseConfig);
  const bridge = env.window.dshHTML;
  assert.ok(bridge !== undefined, 'window.dshHTML must exist');
  assert.equal(bridge.version, '0.1.1');
  assert.equal(bridge.uiId, 'ui-1a2b3c4d');
  assert.equal(bridge.sessionId, 'session-1');
  assert.equal(bridge.theme(), 'dark');
  assert.equal(env.document.documentElement.attributes['data-dsh-htmlui-theme'], 'dark');
  for (const key of ['send', 'resize', 'close', 'on', 'off', 'stream', 'ready', 'state']) {
    assert.ok(bridge[key] !== undefined, `${key} must be exposed`);
  }
  // Re-evaluating must not replace the installed bridge.
  const run = new Function('window', 'document', 'fetch', 'EventSource', 'CustomEvent', 'console', source);
  const first = env.window.dshHTML;
  run(env.window, env.document, () => assert.fail('must not fetch'), function () {}, function () {}, { warn: () => {}, info: () => {} });
  assert.equal(env.window.dshHTML, first);
});

test('send posts the action with its capability and session identity', async () => {
  const env = loadBridge(baseConfig);
  const result = await env.window.dshHTML.send('refresh', { range: '7d' });
  assert.equal(result.ok, true);
  const call = env.calls.find((entry) => entry.kind === 'fetch');
  assert.equal(call.url, '/plugins/@mostkia/dsh-htmlui/rpc');
  assert.equal(call.body.t, 'tok-123');
  assert.equal(call.body.uiId, 'ui-1a2b3c4d');
  assert.equal(call.body.op, 'action');
  assert.equal(call.body.action, 'refresh');
  assert.deepEqual(call.body.data, { range: '7d' });
  assert.equal(call.init.credentials, 'omit');
  // An action without a name is refused locally instead of bothering the host.
  const refused = await env.window.dshHTML.send('');
  assert.equal(refused.ok, false);
});

test('state reads the injected value and writes through the host', async () => {
  const env = loadBridge(baseConfig);
  assert.deepEqual(env.window.dshHTML.state.get(), { step: 3 });
  await env.window.dshHTML.state.set({ step: 4 });
  const call = env.calls.find((entry) => entry.kind === 'fetch' && entry.body.op === 'state');
  assert.deepEqual(call.body.value, { step: 4 });
});

test('a document an be closed and resized without a stream', async () => {
  const env = loadBridge(baseConfig);
  await env.window.dshHTML.resize('520x360');
  await env.window.dshHTML.close();
  const ops = env.calls.filter((entry) => entry.kind === 'fetch').map((entry) => entry.body.op);
  assert.deepEqual(ops, ['resize', 'close']);
  // The host page hears about both, so it can act without a round trip.
  assert.deepEqual(
    env.posted.map((message) => message.__dshHtmlUi),
    ['resize', 'close'],
  );
});

test('ready is replayed to a listener registered after the bridge ran', () => {
  const env = loadBridge(baseConfig);
  // The authored script always runs after this bridge, so the event it missed
  // must still reach it.
  const seen = [];
  env.window.dshHTML.on('ready', (detail) => seen.push(detail));
  assert.equal(seen.length, 1, 'a late ready listener still fires');
  assert.equal(seen[0].uiId, 'ui-1a2b3c4d');
  assert.equal(seen[0].sessionId, 'session-1');
  assert.equal(seen[0].theme, 'dark', 'the ready payload carries the theme');

  // The short form is the same subscription, with the same payload.
  const short = [];
  env.window.dshHTML.ready((detail) => short.push(detail));
  assert.deepEqual(short, seen);
  assert.equal(typeof env.window.dshHTML.ready(() => {}), 'function', 'and it returns a disposer like on()');
});

test('subscribing opens the stream and delivers frames', () => {
  const env = loadBridge(baseConfig);
  assert.equal(env.calls.filter((entry) => entry.kind === 'eventsource').length, 0, 'no stream until someone listens');
  const seen = [];
  env.window.dshHTML.on('assistant', (detail) => seen.push(detail));
  const opened = env.calls.filter((entry) => entry.kind === 'eventsource');
  assert.equal(opened.length, 1);
  assert.ok(opened[0].url.includes('uiId=ui-1a2b3c4d'));
  assert.ok(opened[0].url.includes('t=tok-123'));
  assert.equal(seen.length, 0);
  // The stream is opened once, however many listeners subscribe.
  env.window.dshHTML.on('session', () => {});
  assert.equal(env.calls.filter((entry) => entry.kind === 'eventsource').length, 1);
});

test('every event the host streams has a listener in the bridge', () => {
  const env = loadBridge(baseConfig);
  const seen = { assistant: [], reasoning: [], session: [], action: [], ui: [] };
  for (const type of Object.keys(seen)) env.window.dshHTML.on(type, (detail) => seen[type].push(detail));
  const source = env.calls.find((entry) => entry.kind === 'eventsource');
  assert.ok(source !== undefined);
  // The bridge subscribes to the named SSE events the host sends; a missing one
  // would be dropped silently and the document would never see it.
  const bridge = readFileSync(new URL('../assets/bridge.js', import.meta.url), 'utf8');
  for (const type of ['hello', 'assistant', 'reasoning', 'session', 'action', 'ui']) {
    assert.ok(bridge.includes(`addEventListener('${type}'`), `the bridge must forward the ${type} event`);
  }
});

test('theme changes reach both the document element and listeners', () => {
  const env = loadBridge(baseConfig);
  const seen = [];
  env.window.dshHTML.on('theme', (detail) => seen.push(detail.theme));
  const handler = [...env.frames].find((entry) => entry.name === 'message');
  assert.ok(handler !== undefined, 'the bridge listens for host messages');
  handler.handler({ data: { __dshHtmlUi: 'theme', theme: 'light' }, source: null });
  assert.deepEqual(seen, ['light']);
  assert.equal(env.document.documentElement.attributes['data-dsh-htmlui-theme'], 'light');
  assert.equal(env.window.dshHTML.theme(), 'light');
  // A handshake echoes the nonce back so the host can trust the sender.
  handler.handler({ data: { __dshHtmlUi: 'init', nonce: 'n-1', theme: 'dark' }, source: env.window.parent });
  const echo = env.posted.find((message) => message.__dshHtmlUi === 'ready');
  assert.equal(echo.nonce, 'n-1');
  assert.equal(env.document.documentElement.attributes['data-dsh-htmlui-theme'], 'dark');
});

test('an unconfigured bridge fails closed instead of throwing', async () => {
  const env = loadBridge(undefined);
  const bridge = env.window.dshHTML;
  assert.equal(bridge.uiId, '');
  const result = await bridge.send('anything');
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/u);
  assert.ok(env.logs.some((line) => line.includes('send failed')), 'the failure is reported, not swallowed');
  assert.equal(bridge.state.get(), null);
  assert.equal(typeof bridge.on, 'function');
});
