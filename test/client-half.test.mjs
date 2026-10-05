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

function createClientContext(options = {}) {
  const registrations = [];
  const injections = [];
  const logs = [];
  const effects = [];
  const services = {};
  if (options.tabs !== undefined) services.sidebarRightTabs = options.tabs;
  if (options.controller !== undefined) services.sidebarRight = options.controller;
  const context = {
    registrations,
    injections,
    logs,
    effects,
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
      register(options_, component) {
        registrations.push({ options: options_, component });
        return () => {};
      },
    },
    inject(keys, callback) {
      const scope = {
        effect(factory) {
          const result = typeof factory === 'function' ? factory() : undefined;
          effects.push(typeof result === 'function' ? result : () => {});
          return result;
        },
      };
      for (const key of keys) {
        if (services[key] !== undefined) scope[key] = services[key];
      }
      callback(scope);
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

test('registers the tool card, both docks, the frame overlay, and the right-pane body', () => {
  const context = createClientContext();
  const dispose = apply(context);
  assert.deepEqual(context.injections, [
    'tool.call.toolview',
    'conversation.input.dock',
    'conversation.composer.dock',
    'shell.overlay',
    'sidebar.right.pane.tab',
  ]);
  const byId = context.registrations.map((entry) => `${entry.options.name}#${entry.options.key ?? entry.options.id}`);
  assert.deepEqual(byId, [
    'tool.call.toolview#html_ui',
    'conversation.input.dock#htmlui-dock',
    'conversation.composer.dock#htmlui-dock-bottom',
    'shell.overlay#htmlui-overlay',
    `sidebar.right.pane.tab#${__internals.TAB_ID}`,
  ]);
  assert.equal(typeof dispose, 'function');
});

test('dock-top and dock-bottom land in different seats', () => {
  resetRightPane();
  const context = createClientContext();
  apply(context);
  const topDock = context.registrations.find((entry) => entry.options.id === 'htmlui-dock');
  const bottomDock = context.registrations.find((entry) => entry.options.id === 'htmlui-dock-bottom');
  assert.ok(topDock !== undefined && bottomDock !== undefined);
  assert.equal(topDock.options.name, 'conversation.input.dock');
  assert.equal(bottomDock.options.name, 'conversation.composer.dock');
  // A record is claimed by exactly one dock: the seats do not overlap.
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  for (const placement of ['dock-top', 'dock-bottom', 'panel', 'dock-right']) {
    __internals.publish(
      __internals.recordFromMeta(
        { htmlui: true, op: 'render', uiId: `ui-${placement.replace('-', '')}0000`, sessionId: 'session-dock', placement, revision: 1 },
        undefined,
      ),
    );
  }
  const top = __internals.recordsIn('session-dock', ['dock-top', 'panel']).map((record) => record.placement);
  const bottom = __internals.recordsIn('session-dock', ['dock-bottom']).map((record) => record.placement);
  assert.deepEqual(top.sort(), ['dock-top', 'panel']);
  assert.deepEqual(bottom, ['dock-bottom']);
});

/** The module keeps its store across `apply` calls, so tests reset what they assert. */
function resetRightPane() {
  __internals.state.rightPane.available = false;
  __internals.state.rightPane.controller = undefined;
  __internals.state.rightPane.opened.clear();
}

test('dock-right falls back to the composer dock when the column has no tab service', () => {
  resetRightPane();
  const context = createClientContext();
  apply(context);
  assert.equal(__internals.state.rightPane.available, false);
  assert.equal(__internals.state.rightPane.controller, undefined);
  // Without a controller the reveal is refused rather than thrown.
  assert.equal(__internals.openRightPane('ui-1a2b3c4d'), false);
});

test('dock-right registers its tab type and reveals it through the column', () => {
  const registered = [];
  const opened = [];
  const context = createClientContext({
    tabs: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    controller: {
      openTab(kind, options) {
        opened.push({ kind, options });
      },
    },
  });
  apply(context);
  assert.equal(__internals.state.rightPane.available, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, __internals.TAB_ID);
  assert.equal(registered[0].kind, __internals.TAB_KIND);
  assert.equal(registered[0].multiple, false);
  assert.equal(registered[0].title(), 'HTML UI');

  __internals.state.rightPane.opened.clear();
  assert.equal(__internals.openRightPane('ui-1a2b3c4d'), true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, __internals.TAB_KIND);
  assert.equal(opened[0].options.params.uiId, 'ui-1a2b3c4d');
  assert.ok(__internals.state.rightPane.opened.has('ui-1a2b3c4d'));
});

test('a tab service that refuses the definition keeps the fallback intact', () => {
  resetRightPane();
  const context = createClientContext({
    tabs: {
      register() {
        throw new Error('kind already registered');
      },
    },
  });
  assert.doesNotThrow(() => apply(context));
  assert.equal(__internals.state.rightPane.available, false);
  assert.ok(context.logs.some((line) => line.includes('right-pane tab type unavailable')));
});

test('tearing the tab type down returns dock-right to its fallback', () => {
  resetRightPane();
  const context = createClientContext({
    tabs: { register: () => () => {} },
  });
  apply(context);
  assert.equal(__internals.state.rightPane.available, true);
  assert.ok(context.effects.length > 0, 'the tab type is owned by an effect');
  for (const dispose of context.effects) dispose();
  assert.equal(__internals.state.rightPane.available, false);
});

test('dismissing a surface closes it locally and tells the host', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: init === undefined ? undefined : JSON.parse(init.body) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  try {
    __internals.state.byId.clear();
    __internals.state.bySession.clear();
    __internals.publish(
      __internals.recordFromMeta(
        { htmlui: true, op: 'render', uiId: 'ui-dddd4444', sessionId: 'session-d', placement: 'float', revision: 1 },
        undefined,
      ),
    );
    __internals.dismissRecord('ui-dddd4444');
    await Promise.resolve();
    assert.equal(__internals.state.byId.get('ui-dddd4444'), undefined);
    assert.equal(__internals.recordsFor('session-d').length, 0);
    const close = calls.find((call) => call.body !== undefined && call.body.op === 'close');
    assert.ok(close !== undefined, 'the host must be told to drop the record');
    assert.equal(close.body.uiId, 'ui-dddd4444');
    assert.ok(close.url.endsWith('/rpc'));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('republishing an identical record notifies nobody', () => {
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  const meta = { htmlui: true, op: 'render', uiId: 'ui-eeee5555', sessionId: 'session-e', title: 'E', placement: 'inline', revision: 4, bytes: 12 };
  __internals.publish(__internals.recordFromMeta(meta, undefined));
  const after = __internals.state.revision;
  // A component effect that republishes the same projection must not re-render
  // itself forever.
  __internals.publish(__internals.recordFromMeta({ ...meta }, undefined));
  assert.equal(__internals.state.revision, after, 'an identical projection is a no-op');
  // A real change still notifies.
  __internals.publish(__internals.recordFromMeta({ ...meta, revision: 5 }, undefined));
  assert.equal(__internals.state.revision, after + 1);
  // So does a placement change, which invalidates the cached document URL.
  __internals.state.tickets.set('ui-eeee5555', { url: 'stale', theme: 'light' });
  __internals.publish(__internals.recordFromMeta({ ...meta, revision: 6, placement: 'float' }, undefined));
  assert.equal(__internals.state.tickets.get('ui-eeee5555'), undefined);
});

test('a session converges on what the host reports', () => {
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  const record = (uiId) => ({ htmlui: true, op: 'render', uiId, sessionId: 'session-c', title: uiId, placement: 'inline', revision: 1 });
  __internals.publish(__internals.recordFromMeta(record('ui-11110000'), undefined));
  __internals.publish(__internals.recordFromMeta(record('ui-22220000'), undefined));
  // The host no longer lists the first one: it was closed from elsewhere.
  __internals.convergeSession('session-c', [
    { uiId: 'ui-22220000', sessionId: 'session-c', title: 'two', placement: 'float', sizeText: '', revision: 2, bytes: 0 },
    { uiId: 'ui-33330000', sessionId: 'session-c', title: 'three', placement: 'panel', sizeText: '', revision: 1, bytes: 0 },
  ]);
  assert.deepEqual(
    __internals.recordsFor('session-c').map((entry) => entry.uiId).sort(),
    ['ui-22220000', 'ui-33330000'],
  );
  assert.equal(__internals.state.byId.get('ui-22220000').placement, 'float', 'the host answer wins');
  // A refused or malformed answer changes nothing.
  __internals.convergeSession('session-c', undefined);
  assert.equal(__internals.recordsFor('session-c').length, 2);
});

test('the fullscreen layer opens by itself and honours switching back', () => {
  const fullscreenRecord = (uiId) => ({ uiId, placement: 'fullscreen', sessionId: 'session-1' });
  __internals.state.fullscreen = null;
  __internals.state.fullscreenDismissed.clear();
  assert.equal(__internals.activeFullscreen([]), undefined);

  const first = fullscreenRecord('ui-aaaa0001');
  assert.equal(__internals.activeFullscreen([first]).uiId, 'ui-aaaa0001');

  // "Switch back to chat" must keep it closed. The old selection logic re-picked
  // the same record on the next render, so the button looked broken.
  __internals.state.fullscreen = null;
  __internals.state.fullscreenDismissed.add('ui-aaaa0001');
  assert.equal(__internals.activeFullscreen([first]), undefined);

  // Opening it explicitly wins over the dismissal.
  __internals.state.fullscreen = 'ui-aaaa0001';
  assert.equal(__internals.activeFullscreen([first]).uiId, 'ui-aaaa0001');

  // A newly attached interface opens by itself again.
  __internals.state.fullscreen = null;
  const second = fullscreenRecord('ui-bbbb0002');
  assert.equal(__internals.activeFullscreen([first, second]).uiId, 'ui-bbbb0002');

  // Retiring the pinned interface clears both the pin and its dismissal.
  __internals.state.fullscreen = 'ui-bbbb0002';
  __internals.state.fullscreenDismissed.add('ui-bbbb0002');
  __internals.retire('ui-bbbb0002');
  assert.equal(__internals.state.fullscreen, null);
  assert.equal(__internals.state.fullscreenDismissed.has('ui-bbbb0002'), false);
  assert.equal(__internals.activeFullscreen([first]), undefined, 'the one still dismissed stays dismissed');
});
