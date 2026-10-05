/**
 * Browser-half regression tests for @mostkia/dsh-htmlui.
 *
 * The browser half normally runs only inside a live DSH page, so these tests load
 * it the same way the harness does — through `window.__ModuleLoader__.load` — with
 * a stub `react` and a fake client context. That exercises the module contract,
 * the slot registrations, the placement parser, and the record store without a
 * browser, a profile, or a harness.
 *
 * Run: node test/client-half.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------------ fake React

/** Only what the module touches at load time and during wiring; no rendering. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => 0,
  };
}

// ------------------------------------------------------------- module loading

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded.push(module);
    },
  },
  addEventListener() {},
  removeEventListener() {},
  parent: undefined,
};

await import('../client.js');

assert.equal(loaded.length, 1, 'the module body registers exactly one factory');
const module_ = loaded[0];
assert.equal(module_.id, '@mostkia/dsh-htmlui');
assert.equal(typeof module_.factory, 'function');

const react = stubReact();
const exported = module_.factory((id) => {
  if (id === 'react') return react;
  throw new Error(`unexpected require(${id})`);
});

const { apply, inject, __internals } = exported;
const store = __internals.state;

// -------------------------------------------------------------- fake context

function createClientContext() {
  const registrations = [];
  const injections = [];
  const logs = [];
  const context = {
    registrations,
    injections,
    logs,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    slots: {
      inject(key, callback) {
        injections.push(key);
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ current: 'session-1', byId: {} }),
        subscribe: () => () => {},
      },
    },
  };
  return context;
}

// --------------------------------------------------------------------- tests

test('exposes the harness client contract', () => {
  assert.deepEqual(inject, ['slots', 'sessions']);
  assert.equal(typeof apply, 'function');
});

test('registers the tool card, the composer dock, and the frame overlay', () => {
  const context = createClientContext();
  const dispose = apply(context);
  assert.deepEqual(context.injections, ['tool.call.toolview', 'conversation.input.dock', 'shell.overlay']);
  const byId = context.registrations.map((entry) => `${entry.options.name}#${entry.options.key ?? entry.options.id}`);
  assert.deepEqual(byId, ['tool.call.toolview#html_ui', 'conversation.input.dock#htmlui-dock', 'shell.overlay#htmlui-overlay']);
  assert.equal(typeof dispose, 'function');
});

test('the activation line names the installed version', () => {
  assert.ok(
    __internals.CLIENT_ACTIVE_LINE.includes(pkg.version),
    `activation line ${__internals.CLIENT_ACTIVE_LINE} must name ${pkg.version}`,
  );
  assert.ok(__internals.CLIENT_ACTIVE_LINE.includes('[dsh-htmlui] client active'));
});

test('the frame sandbox never grants the same origin', () => {
  assert.ok(__internals.FRAME_SANDBOX.includes('allow-scripts'), 'inline documents must run their own script');
  assert.ok(!__internals.FRAME_SANDBOX.includes('allow-same-origin'), 'the host page must stay unreachable');
  assert.ok(!__internals.FRAME_SANDBOX.includes('allow-top-navigation'));
  assert.equal(__internals.ROUTE_BASE, '/plugins/@mostkia/dsh-htmlui');
});

test('placement geometry parses the documented shapes', () => {
  assert.deepEqual(__internals.parseSizeText('520x360'), { w: 520, h: 360 });
  assert.deepEqual(__internals.parseSizeText('520x360+80+60'), { w: 520, h: 360, x: 80, y: 60 });
  assert.deepEqual(__internals.parseSizeText('640X480 + 10 + 20'), { w: 640, h: 480, x: 10, y: 20 });
  assert.deepEqual(__internals.parseSizeText({ w: 400, h: 300 }), { w: 400, h: 300 });
  assert.equal(__internals.parseSizeText(''), undefined);
  assert.equal(__internals.parseSizeText('auto'), undefined);
  assert.equal(__internals.parseSizeText(undefined), undefined);
});

test('a tool result projection becomes a placement record', () => {
  const record = __internals.recordFromMeta(
    {
      htmlui: true,
      op: 'render',
      uiId: 'ui-1a2b3c4d',
      sessionId: 'session-1',
      title: '看板',
      placement: 'float',
      size: '520x360+80+60',
      url: '/plugins/@mostkia/dsh-htmlui/ui/ui-1a2b3c4d?t=x',
      revision: 3,
      bytes: 2048,
    },
    undefined,
  );
  assert.equal(record.uiId, 'ui-1a2b3c4d');
  assert.equal(record.sessionId, 'session-1');
  assert.equal(record.placement, 'float');
  assert.equal(record.sizeText, '520x360+80+60');
  assert.equal(record.revision, 3);
  // Anything that is not an html_ui projection must not enter the store.
  assert.equal(__internals.recordFromMeta({ htmlui: false, op: 'list' }, 'session-1'), undefined);
  assert.equal(__internals.recordFromMeta({ htmlui: true, op: 'list' }, 'session-1'), undefined);
  assert.equal(__internals.recordFromMeta(undefined, 'session-1'), undefined);
});

test('the store keeps records per session and survives a revision bump', () => {
  store.byId.clear();
  store.bySession.clear();
  store.tickets.clear();
  const base = { htmlui: true, op: 'render', uiId: 'ui-aaaa1111', sessionId: 'session-a', title: 'A', placement: 'inline', revision: 1 };
  __internals.publish(__internals.recordFromMeta(base, undefined));
  __internals.publish(__internals.recordFromMeta({ ...base, uiId: 'ui-bbbb2222', title: 'B' }, undefined));
  assert.equal(__internals.recordsFor('session-a').length, 2);
  assert.equal(__internals.recordsFor('session-b').length, 0);
  assert.deepEqual(
    __internals.recordsFor('session-a').map((record) => record.title),
    ['A', 'B'],
  );
  assert.equal(__internals.recordsIn('session-a', ['inline']).length, 2);
  assert.equal(__internals.recordsIn('session-a', ['float']).length, 0);

  // A revision bump invalidates the cached document URL for that record only.
  store.tickets.set('ui-aaaa1111', { url: 'stale', theme: 'light' });
  store.tickets.set('ui-bbbb2222', { url: 'fresh', theme: 'light' });
  __internals.publish(__internals.recordFromMeta({ ...base, revision: 2 }, undefined));
  assert.equal(store.tickets.get('ui-aaaa1111'), undefined);
  assert.equal(store.tickets.get('ui-bbbb2222').url, 'fresh');
});

test('retiring a record detaches it from its session and clears fullscreen', () => {
  store.byId.clear();
  store.bySession.clear();
  const meta = { htmlui: true, op: 'render', uiId: 'ui-cccc3333', sessionId: 'session-c', title: 'C', placement: 'fullscreen', revision: 1 };
  __internals.publish(__internals.recordFromMeta(meta, undefined));
  store.fullscreen = 'ui-cccc3333';
  __internals.retire('ui-cccc3333');
  assert.equal(store.byId.get('ui-cccc3333'), undefined);
  assert.equal(__internals.recordsFor('session-c').length, 0);
  assert.equal(store.fullscreen, null);
});

test('the viewed session resolves from the current pointer or the main view', () => {
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'session-x', byId: {} }) } } };
  assert.equal(__internals.resolveViewedSessionId(ctx), 'session-x');
  const fallback = {
    sessions: {
      list: {
        getSnapshot: () => ({
          current: undefined,
          byId: { 'session-y': { id: 'session-y', retainedBy: { mainView: 1 } }, 'session-z': { id: 'session-z', retainedBy: { mainView: 0 } } },
        }),
      },
    },
  };
  assert.equal(__internals.resolveViewedSessionId(fallback), 'session-y');
  assert.equal(__internals.resolveViewedSessionId({ sessions: {} }), undefined);
  assert.equal(__internals.resolveViewedSessionId({}), undefined);
});

test('tool card props are read defensively across phases', () => {
  assert.deepEqual(__internals.argsOf({ arguments: '{"op":"render"}' }), { op: 'render' });
  assert.deepEqual(__internals.argsOf({ arguments: { op: 'close' } }), { op: 'close' });
  assert.equal(__internals.argsOf({ arguments: 'not json' }), undefined);
  assert.equal(__internals.argsOf(undefined), undefined);
  assert.deepEqual(__internals.metaOf({ meta: { htmlui: true } }), { htmlui: true });
  assert.equal(__internals.metaOf({ meta: 'nope' }), undefined);
  assert.equal(__internals.metaOf({}), undefined);
});

test('session identity is read from the composer dock owner props', () => {
  assert.equal(__internals.sessionIdOf({ session: { id: 'session-1' } }), 'session-1');
  assert.equal(__internals.sessionIdOf({ session: { sessionId: 'session-2' } }), 'session-2');
  assert.equal(__internals.sessionIdOf({ sessionId: 'session-3' }), 'session-3');
  assert.equal(__internals.sessionIdOf({}), undefined);
});
