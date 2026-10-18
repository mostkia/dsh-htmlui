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
function loadBridge(config, overrides = {}) {
  const calls = [];
  const dispatched = [];
  const posted = [];
  const logs = [];
  const frames = new Set();
  const element = { attributes: {}, setAttribute: (name, value) => { element.attributes[name] = value; } };
  const documentListeners = new Map();
  const document = {
    documentElement: element,
    dispatchEvent: (event) => dispatched.push(event),
    addEventListener: (name, handler) => {
      const bucket = documentListeners.get(name) ?? [];
      bucket.push(handler);
      documentListeners.set(name, bucket);
    },
    emit: (name, event) => {
      for (const handler of documentListeners.get(name) ?? []) handler(event);
    },
  };
  const window_ = {
    __DSH_HTMLUI__: config,
    parent: { postMessage: (message) => posted.push(message) },
    addEventListener: (name, handler) => frames.add({ name, handler }),
    dispatchEvent: () => {},
  };
  // A frame the test drives by hand: the bridge coalesces forwarded input into one message per
  // frame, so a test that emits two wheels has to say when that frame ends.
  const frameQueue = [];
  let frameClock = 0;
  window_.requestAnimationFrame = (callback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  };
  window_.cancelAnimationFrame = () => {};
  window_.parent.parent = window_.parent;
  // The host speaks to the bridge with postMessage; a test has to be able to do the same.
  window_.emit = (name, event) => {
    for (const entry of frames) if (entry.name === name) entry.handler(event);
  };
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
  const fetch_ = overrides.fetch ?? ((url, init) => {
    const body = init === undefined ? undefined : JSON.parse(init.body);
    calls.push({ kind: 'fetch', url, body, init });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, actionId: 'a-1' }) });
  });
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
  return {
    window: window_,
    document,
    calls,
    dispatched,
    posted,
    frames,
    logs,
    /** End one animation frame, as the browser would after the events of that frame. */
    flushFrames: () => {
      for (const callback of frameQueue.splice(0)) {
        frameClock += 16;
        callback(frameClock);
      }
    },
  };
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
  for (const key of ['send', 'resize', 'close', 'on', 'off', 'stream', 'ready', 'state', 'app', 'appUrl']) {
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

test('a document calls its own project backend with no model round trip', async () => {
  const answers = [];
  const env = loadBridge(baseConfig, {
    fetch: (url, init) => {
      answers.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"now":7}') });
    },
  });
  const bridge = env.window.dshHTML;

  // A body makes it a POST, and the answer is read as text so `json()` works on any engine.
  const answer = await bridge.app('status', { body: { range: '7d' }, query: { fresh: 1 } });
  assert.equal(answers[0].url, '/plugins/@mostkia/dsh-htmlui/app/ui-1a2b3c4d/status?t=tok-123&fresh=1');
  assert.equal(answers[0].init.method, 'POST');
  assert.equal(answers[0].init.body, '{"range":"7d"}');
  assert.equal(answers[0].init.headers['content-type'], 'application/json');
  assert.equal(answers[0].init.credentials, 'omit');
  assert.deepEqual(answer.json(), { now: 7 });
  assert.equal(answer.body, '{"now":7}');

  // No body means GET, and a leading slash is not part of the path.
  await bridge.app('/plain');
  assert.equal(answers[1].url, '/plugins/@mostkia/dsh-htmlui/app/ui-1a2b3c4d/plain?t=tok-123');
  assert.equal(answers[1].init.method, 'GET');
  assert.equal(answers[1].init.body, undefined);

  // The same address, for a resource the page loads itself rather than fetches.
  assert.equal(bridge.appUrl('img/logo.png', { v: 2 }), '/plugins/@mostkia/dsh-htmlui/app/ui-1a2b3c4d/img/logo.png?t=tok-123&v=2');

  // A bridge that was never configured fails closed instead of throwing.
  const bare = loadBridge({});
  const refused = await bare.window.dshHTML.app('status');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not configured/u);
  assert.equal(bare.window.dshHTML.appUrl('status'), null);
});

test('state reads the injected value and writes through the host', async () => {  const env = loadBridge(baseConfig);
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

test('the handshake makes the document state its height again', async () => {
  // The report sent when the document loads can arrive before the host page has its
  // listener attached. A static document never measures twice, so without answering the
  // handshake the height is lost and the surface falls back to a fixed box — which shows
  // a scrollbar for content that would have fitted.
  const env = loadBridge(baseConfig);
  const handler = [...env.frames].find((entry) => entry.name === 'message');
  // The fake document has no body until a document has one; the bridge measures both and
  // guards for the head-time case, so the body has to exist for a height to be reported.
  env.document.body = { scrollHeight: 0 };
  env.document.documentElement.scrollHeight = 337;
  assert.ok(!env.posted.some((message) => message.__dshHtmlUi === 'content'), 'nothing is reported until asked');
  handler.handler({ data: { __dshHtmlUi: 'init', nonce: 'n-2', theme: 'dark' }, source: env.window.parent });
  // Measurement is coalesced into a frame, so it lands on the next turn.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const report = env.posted.find((message) => message.__dshHtmlUi === 'content');
  assert.ok(report !== undefined, 'the handshake is answered with the measured height');
  assert.equal(report.height, 337);
  assert.equal(report.nonce, 'n-2', 'and it carries the nonce the host just sent');
});

test('a wheel the document cannot use is forwarded to the conversation', () => {
  // An inline document is hosted outside the transcript, so the browser's scroll chaining has
  // nowhere to go: without this, a wheel over a document with nothing to scroll would do nothing
  // at all. The bridge forwards exactly what the document could not use — decided synchronously
  // on a passive listener, so a scrollable document keeps its own wheel and never both.
  const env = loadBridge(baseConfig);
  const wheel = () => env.posted.filter((message) => message.__dshHtmlUi === 'wheel');
  const flat = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, parentElement: null };

  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 1, 'a wheel nothing can use is forwarded');
  assert.equal(wheel()[0].deltaY, 120);
  assert.equal(wheel()[0].uiId, 'ui-1a2b3c4d', 'and it names the document it came from');

  // A scrollable ancestor with room keeps the wheel: the browser scrolls it and nothing is sent.
  const inner = { scrollTop: 0, scrollHeight: 900, clientHeight: 200, scrollWidth: 100, clientWidth: 100, parentElement: null };
  const nested = Object.assign({}, flat, { parentElement: inner });
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: nested });
  env.flushFrames();
  assert.equal(wheel().length, 1, 'a document that can scroll keeps its own wheel');
  // At the end of that scrollable there is no room left, so the conversation takes it again.
  inner.scrollTop = 700;
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: nested });
  env.flushFrames();
  assert.equal(wheel().length, 2, 'and the conversation takes it at the end of the document');
  // Scrolling back up inside the document keeps it there too.
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: -120, deltaMode: 0, target: nested });
  env.flushFrames();
  assert.equal(wheel().length, 2, 'upwards inside a document that has room stays inside it');

  // Lines and pages are converted to pixels, because the host scrolls in pixels.
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 3, deltaMode: 1, target: flat });
  env.flushFrames();
  assert.equal(wheel()[2].deltaY, 48, 'a line-wise delta is converted');
  // A pinch gesture zooms; it is not a scroll to hand over.
  env.document.emit('wheel', { ctrlKey: true, deltaX: 0, deltaY: 120, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 3, 'a pinch gesture is left alone');
});

test('the wheels of one frame are summed into one message', () => {
  // A wheel that reports faster than the display used to cost one host scroll per event, which is
  // a main-thread scroll of the transcript each time. The deltas of a frame now arrive together,
  // so the forwarded path costs the same as a native one: one scroll per frame.
  const env = loadBridge(baseConfig);
  const wheel = () => env.posted.filter((message) => message.__dshHtmlUi === 'wheel');
  const flat = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, parentElement: null };

  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 40, deltaMode: 0, target: flat });
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 40, deltaMode: 0, target: flat });
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 40, deltaMode: 0, target: flat });
  assert.equal(wheel().length, 0, 'nothing is sent before the frame ends');
  env.flushFrames();
  assert.equal(wheel().length, 1, 'the three of them leave as one message');
  assert.equal(wheel()[0].deltaY, 120, 'carrying the sum');

  // The next frame is a new message: coalescing must not swallow a later tick.
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: -60, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 2);
  assert.equal(wheel()[1].deltaY, -60);
});

test('a released drag keeps the conversation moving, and a new touch stops it', async () => {
  // A script-driven scroll has no velocity of its own: the moment the finger lifts it stops dead,
  // which is the "the page sticks to my thumb" report. The bridge therefore takes the speed of the
  // last of the gesture and decays it per frame, the way a native fling does.
  const env = loadBridge(baseConfig);
  const touches = () => env.posted.filter((message) => message.__dshHtmlUi === 'touch');
  const flat = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, parentElement: null };

  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 500 }] });
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 480 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 1, 'the drag itself is forwarded');
  assert.equal(touches()[0].deltaY, 20);

  // A second sample, a moment later, is what the release reads its speed from.
  await new Promise((resolve) => setTimeout(resolve, 20));
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 460 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 2);

  const before = touches().length;
  env.document.emit('touchend', { touches: [] });
  assert.ok(touches().length > before, 'the release starts the fling at once');
  const firstFling = touches()[touches().length - 1].deltaY;
  assert.ok(firstFling > 0, 'in the direction the finger was moving');

  env.flushFrames();
  const secondFling = touches()[touches().length - 1].deltaY;
  assert.ok(secondFling > 0, 'and the transcript keeps moving after the finger is gone');
  assert.ok(secondFling < firstFling, 'slower every frame, the way a fling decays');

  // A finger on the glass stops it: the next gesture must not fight a leftover fling.
  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 460 }] });
  const stopped = touches().length;
  env.flushFrames();
  env.flushFrames();
  assert.equal(touches().length, stopped, 'a new touch ends the fling');
});

test('a drag inside a scrolling document is handed to the conversation at its edge', () => {
  // A document with its own scroll box used to trap the gesture: once it reached its end the drag
  // did nothing at all, and the conversation could not be scrolled from that spot. The document
  // now hands the gesture over at its edge — once, and never takes it back mid-drag.
  const env = loadBridge(baseConfig);
  const touches = () => env.posted.filter((message) => message.__dshHtmlUi === 'touch');
  const inner = { scrollTop: 0, scrollHeight: 900, clientHeight: 200, scrollWidth: 100, clientWidth: 100, parentElement: null };
  const flat = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, parentElement: inner };

  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 500 }] });
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 480 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 0, 'a document that still has room keeps the gesture');

  // At the bottom edge the conversation takes it.
  inner.scrollTop = 700;
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 460 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 1, 'the edge hands the gesture over');
  assert.equal(touches()[0].deltaY, 20);

  // And it stays handed over: dragging back must not start scrolling the document again.
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 490 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 2, 'the rest of the gesture belongs to the conversation');
  assert.equal(touches()[1].deltaY, -30);

  // A document already at its top hands over on the very first downward movement.
  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 500 }] });
  inner.scrollTop = 0;
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 540 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 3, 'no room in that direction means no wait');
  assert.equal(touches()[2].deltaY, -40);
});

test('a document hosted inside the transcript leaves the wheel and the finger to the browser', () => {
  // In flow mode the frame is a descendant of the transcript's scroller again, so the browser
  // scrolls it, chains what it cannot use to the conversation at its edge, and runs the release's
  // momentum itself. Forwarding as well moved the page twice — the wheel was caught in review, the
  // finger on a phone.
  const env = loadBridge(baseConfig);
  const wheel = () => env.posted.filter((message) => message.__dshHtmlUi === 'wheel');
  const touches = () => env.posted.filter((message) => message.__dshHtmlUi === 'touch');
  const flat = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100, parentElement: null };

  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 1, 'a hosted frame forwards its wheel');

  env.window.emit('message', { data: { __dshHtmlUi: 'hosting', flow: true } });
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 1, 'inside the transcript the browser chains it, and nothing is forwarded');

  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 500 }] });
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 480 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 0, 'and a finger is the browser’s too, for the same reason');

  // Back to a hosted arrangement: the wheel and the finger are forwarded again.
  env.window.emit('message', { data: { __dshHtmlUi: 'hosting', flow: false } });
  env.document.emit('wheel', { ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0, target: flat });
  env.flushFrames();
  assert.equal(wheel().length, 2);

  env.document.emit('touchstart', { touches: [{ screenX: 10, screenY: 500 }] });
  env.document.emit('touchmove', { touches: [{ screenX: 10, screenY: 480 }], target: flat });
  env.flushFrames();
  assert.equal(touches().length, 1, 'with the frame back in the overlay the finger is forwarded again');
});

test('the shared store reads at once, writes through the host, and follows other panels', async () => {
  // The store is the one place a document's data outlives the panel that wrote it, so the bridge
  // has to be honest about both halves: reads are synchronous (the values travel with the
  // document, which is what lets a notebook paint its pages in the first frame) and writes are a
  // round trip that also updates the local copy.
  const env = loadBridge(Object.assign({}, baseConfig, { store: { notes: { value: { pages: 2 }, bytes: 20, updatedAt: 1 } } }));
  const store = env.window.dshHTML.store;
  assert.deepEqual(store.get('notes'), { pages: 2 }, 'a declared slot is readable immediately');
  assert.equal(store.get('elsewhere'), null, 'an undeclared name reads as null');
  assert.deepEqual(store.list().map((entry) => entry.name), ['notes']);

  const written = await store.set('notes', { pages: 3 });
  assert.equal(written.ok, true);
  const call = env.calls.find((entry) => entry.kind === 'fetch' && entry.body.op === 'store');
  assert.deepEqual(call.body, { t: 'tok-123', uiId: 'ui-1a2b3c4d', op: 'store', store: 'set', name: 'notes', value: { pages: 3 } });
  assert.deepEqual(store.get('notes'), { pages: 3 }, 'the local copy follows the write');

  // Another panel's write arrives over the stream, and the local copy is current by the time a
  // listener runs: a reader that reacts to the event never sees a stale value.
  const seen = [];
  store.on((detail) => seen.push([detail.slot, store.get(detail.slot)]));
  env.window.dshHTML.stream().emit('store', { slot: 'notes', uiId: 'ui-remote', value: { pages: 9 }, bytes: 21, updatedAt: 2 });
  assert.deepEqual(seen, [['notes', { pages: 9 }]], 'the change is applied before the listener reads it');

  await store.remove('notes');
  assert.equal(store.get('notes'), null, 'a removed slot reads as empty again');
});

test('the row layer speaks keys, pages, and search, and keeps its events apart', async () => {
  // A row is fetched rather than inlined, so the whole rows API is promises; and its events are
  // metadata only, which is why they must not be confused with the value layer's value-carrying
  // events on the same stream.
  const env = loadBridge(Object.assign({}, baseConfig, { store: { notes: { value: null, bytes: 0, updatedAt: null } } }));
  const rows = env.window.dshHTML.store.rows;

  await rows.set('notes', 'n1', '第一条', { title: '会议' });
  const setCall = env.calls.filter((entry) => entry.kind === 'fetch' && entry.body.rows === 'set').pop();
  assert.deepEqual(setCall.body, { t: 'tok-123', uiId: 'ui-1a2b3c4d', op: 'store', store: 'rows', rows: 'set', name: 'notes', key: 'n1', value: '第一条', title: '会议' });

  await rows.keys('notes', { offset: 0, limit: 20 });
  assert.equal(env.calls.filter((entry) => entry.body.rows === 'keys').pop().body.limit, 20);
  await rows.get('notes', 'n1');
  assert.equal(env.calls.filter((entry) => entry.body.rows === 'get').pop().body.key, 'n1');
  await rows.search('notes', '插槽', { limit: 5 });
  const search = env.calls.filter((entry) => entry.body.rows === 'search').pop();
  assert.equal(search.body.text, '插槽');
  assert.equal(search.body.limit, 5);
  await rows.remove('notes', 'n1');
  assert.equal(env.calls.filter((entry) => entry.body.rows === 'remove').pop().body.key, 'n1');

  // Two subscriptions, one stream: each sees only its own layer.
  const valueSeen = [];
  const rowSeen = [];
  env.window.dshHTML.store.on((change) => valueSeen.push(change));
  rows.on((change) => rowSeen.push(change));
  const stream = env.window.dshHTML.stream();
  stream.emit('store', { slot: 'notes', layer: 'rows', uiId: 'ui-remote', key: 'n2', bytes: 12, updatedAt: 3, removed: false });
  stream.emit('store', { slot: 'notes', layer: 'value', uiId: 'ui-remote', value: { a: 1 }, bytes: 8, updatedAt: 4, removed: false });
  assert.deepEqual(rowSeen.map((change) => change.key), ['n2']);
  assert.deepEqual(valueSeen.map((change) => change.value), [{ a: 1 }], 'the value layer ignores row events');
  assert.deepEqual(env.window.dshHTML.store.get('notes'), { a: 1 }, 'and its local copy follows only its own');
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
