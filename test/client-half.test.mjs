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
  if (options.locale !== undefined) services.locale = options.locale;
  const context = {
    registrations,
    injections,
    logs,
    effects,
    // The documented optional-service access for a dynamic Client half.
    get: (key) => services[key],
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

/** Drain every pending microtask, however long the promise chain is. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('exposes the harness client contract', () => {
  assert.deepEqual(inject, ['slots', 'sessions']);
  assert.equal(typeof apply, 'function');
});

test('registers the tool card, the fallback dock, the drawer, the overlay, the turn tail and the right-pane body', () => {
  const context = createClientContext();
  const dispose = apply(context);
  assert.deepEqual(context.injections, [
    'tool.call.toolview',
    'conversation.input.dock',
    'shell.overlay',
    'conversation.chat.turnTail',
    'conversation.input.right',
    'conversation.input.dock',
    'sidebar.right.pane.tab',
  ]);
  const byId = context.registrations.map((entry) => `${entry.options.name}#${entry.options.key ?? entry.options.id}`);
  assert.deepEqual(byId, [
    'tool.call.toolview#html_ui',
    'conversation.input.dock#htmlui-dock',
    'shell.overlay#htmlui-overlay',
    'conversation.chat.turnTail#htmlui-inline',
    'conversation.input.right#htmlui-templates',
    'conversation.input.dock#htmlui-templates-dock',
    `sidebar.right.pane.tab#${__internals.TAB_ID}`,
  ]);
  assert.equal(typeof dispose, 'function');
});

test('the drawer loads the catalogue and applies a template without the model', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = init === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/templates')) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, count: 1, templates: [{ slug: 'starter', name: 'starter', description: 'demo', bundled: true, bytes: 10 }] }),
      });
    }
    if (url.endsWith('/templates/render')) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            ui: { uiId: 'ui-99990000', sessionId: body.sessionId, title: 'auto', placement: 'dock-top', sizeText: '', revision: 1, bytes: 4 },
          }),
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'unexpected' }) });
  };
  try {
    __internals.state.byId.clear();
    __internals.state.bySession.clear();
    __internals.state.templates.open = false;
    __internals.state.templates.loaded = false;
    __internals.state.templates.items = [];

    // Opening the drawer is what loads the catalogue, and it loads it once.
    assert.equal(__internals.toggleTemplates(), true);
    await settle();
    assert.equal(__internals.state.templates.items.length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/templates')).length, 1);
    __internals.toggleTemplates();
    __internals.toggleTemplates();
    await settle();
    assert.equal(calls.filter((call) => call.url.endsWith('/templates')).length, 1, 'the catalogue is loaded once');
    assert.equal(__internals.state.templates.open, true);

    // Applying one publishes the record the host created, so every surface shows it.
    assert.equal(await __internals.applyTemplate('starter', 'session-drawer'), true);
    assert.equal(__internals.state.byId.get('ui-99990000').placement, 'dock-top');
    assert.equal(__internals.recordsFor('session-drawer').length, 1);
    const rendered = calls.find((call) => call.url.endsWith('/templates/render'));
    assert.equal(rendered.body.template, 'starter');
    assert.equal(rendered.body.sessionId, 'session-drawer');

    // Nothing to apply is a refusal, not a request.
    assert.equal(await __internals.applyTemplate('', 'session-drawer'), false);
    assert.equal(await __internals.applyTemplate('starter', ''), false);
  } finally {
    globalThis.fetch = originalFetch;
    __internals.state.templates.open = false;
  }
});

test('handing a template to the model writes the instruction into the draft', () => {
  const drafts = [];
  const scoped = { get: () => ({ input: { for: () => ({ setDraft: (text) => drafts.push(text) }) } }) };
  const ctx = { sessions: { scope: (id) => (id === 'session-1' ? scoped : undefined) } };
  assert.equal(__internals.askModelForTemplate('starter', 'session-1', ctx), true);
  assert.deepEqual(drafts, ['Render the template starter with html_ui']);
  // An unreachable composer is a refusal, not a crash.
  assert.equal(__internals.askModelForTemplate('starter', 'session-none', ctx), false);
  assert.equal(__internals.askModelForTemplate('', 'session-1', ctx), false);
  assert.equal(__internals.askModelForTemplate('starter', 'session-1', undefined), false);
});

test('visible text comes from the locale service when there is one', () => {
  const registered = [];
  const disposed = [];
  const dictionary = { close: 'Schließen', apply: 'Anwenden' };
  const locale = {
    register(ns, language, dict) {
      registered.push({ ns, language, dict });
      return () => disposed.push(`${ns}:${language}`);
    },
    bind() {
      // The real lookup returns the key itself for an unknown entry.
      return (key) => (dictionary[key] === undefined ? key : dictionary[key]);
    },
  };
  const dispose = apply(createClientContext({ locale }));
  assert.deepEqual(registered.map((entry) => entry.language).sort(), ['en', 'zh'], 'every locale this plugin carries is registered');
  assert.ok(registered.every((entry) => entry.ns === __internals.LOCALE_NS));
  assert.ok(registered.every((entry) => Object.keys(entry.dict).length === Object.keys(__internals.MESSAGES.en).length), 'the dictionaries stay the same shape');
  assert.deepEqual(Object.keys(__internals.MESSAGES.zh).sort(), Object.keys(__internals.MESSAGES.en).sort(), 'and cover the same keys');

  assert.equal(__internals.tr('close', 'Close'), 'Schließen');
  assert.equal(__internals.tr('apply', 'Apply'), 'Anwenden');
  assert.equal(__internals.tr('templatesTitle', 'HTML UI templates'), 'HTML UI templates', 'an untranslated key keeps the literal');
  assert.equal(__internals.tr('apply', 'Apply', { slug: 'x' }), 'Anwenden', 'params are only used by the literals that carry them');
  assert.equal(__internals.tr('draft', 'Render {slug}', { slug: 'starter' }), 'Render starter');

  dispose();
  assert.equal(disposed.length, 2, 'the dictionaries are disposed with the plugin');
});

test('without a locale service the English literals stand, and a refusal is survivable', () => {
  apply(createClientContext());
  assert.equal(__internals.tr('close', 'Close'), 'Close');

  // A service that refuses the dictionary must not cost us the surfaces.
  const refusing = createClientContext({
    locale: {
      register() {
        throw new Error('namespace occupied');
      },
      bind() {
        throw new Error('unreachable');
      },
    },
  });
  const dispose = apply(refusing);
  assert.equal(typeof dispose, 'function');
  assert.equal(__internals.tr('close', 'Close'), 'Close');
  assert.ok(refusing.logs.some((line) => String(line).includes('locale service refused')));
});

test('dock-right keeps its fallback until the column can actually open a tab', () => {
  // A registered tab type is not enough: without a controller the interface would have
  // no seat at all, so the wide dock has to keep claiming it, and let go the moment the
  // column can take it — one seat draws a record, never two.
  const base = ['dock-right'];
  resetRightPane();
  const registeredTab = { register: () => () => {} };
  apply(createClientContext({ tabs: registeredTab }));
  assert.equal(__internals.rightPaneReady(), false, 'a tab type alone cannot open a tab');
  assert.deepEqual(__internals.dockPlacements(base), ['dock-right'], 'so the fallback holds');

  // With the controller bound, the right column takes over and the dock lets go.
  resetRightPane();
  const controller = { openTab: () => {} };
  apply(createClientContext({ tabs: registeredTab, controller }));
  assert.equal(__internals.rightPaneReady(), true);
  assert.deepEqual(__internals.dockPlacements(base), [], 'the dock stops claiming it');

  // A controller that cannot open a tab is no more use than none at all.
  resetRightPane();
  apply(createClientContext({ tabs: registeredTab, controller: {} }));
  assert.equal(__internals.rightPaneReady(), false);
  assert.deepEqual(__internals.dockPlacements(base), ['dock-right']);

  // The dock claims nothing else: the vertical split forms are gone.
  assert.deepEqual(__internals.dockPlacements(['float']), ['float']);
  resetRightPane();
});

test('a theme switch does not reload an open document', async () => {
  resetRightPane();
  const tickets = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (url.endsWith('/ui/ticket')) {
      const body = JSON.parse(init.body);
      tickets.push(body);
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, url: `http://127.0.0.1:3080/ui/${body.uiId}?t=abc&theme=${body.theme}` }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: false }) });
  };
  try {
    __internals.state.tickets.clear();
    const first = await __internals.ensureTicket('ui-77770000', 'light');
    assert.match(first, /theme=light/u);
    // The same document under a different theme keeps its URL: the frame's theme
    // arrives over postMessage, and changing src would reload the document and
    // lose everything it holds in memory.
    const second = await __internals.ensureTicket('ui-77770000', 'dark');
    assert.equal(second, first);
    assert.equal(tickets.length, 1, 'exactly one ticket was minted');
  } finally {
    globalThis.fetch = originalFetch;
    __internals.state.tickets.clear();
  }
});

test('one dock remains, and it is the fallback seat for dock-right', () => {
  resetRightPane();
  const context = createClientContext();
  apply(context);
  const dock = context.registrations.find((entry) => entry.options.id === 'htmlui-dock');
  assert.ok(dock !== undefined, 'the fallback dock is registered');
  assert.equal(dock.options.name, 'conversation.input.dock');
  assert.equal(
    context.registrations.some((entry) => entry.options.name === 'conversation.composer.dock'),
    false,
    'the seat below the composer was removed with the vertical split forms',
  );
  // Every remaining placement belongs to exactly one seat, and only dock-right is a
  // dock's business.
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  for (const placement of ['inline', 'dock-right', 'float']) {
    __internals.publish(
      __internals.recordFromMeta(
        { htmlui: true, op: 'render', uiId: `ui-${placement.replace('-', '')}0000`, sessionId: 'session-dock', placement, revision: 1 },
        undefined,
      ),
    );
  }
  assert.deepEqual(__internals.recordsIn('session-dock', ['dock-right']).map((record) => record.placement), ['dock-right']);
  assert.deepEqual(__internals.recordsIn('session-dock', ['inline']).map((record) => record.placement), ['inline']);
  assert.deepEqual(__internals.recordsIn('session-dock', ['float']).map((record) => record.placement), ['float']);
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

test('dismissing a surface closes it locally and asks the host with a token', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = init === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith('/ui/ticket')) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, url: `/plugins/@mostkia/dsh-htmlui/ui/${body.uiId}?t=fresh-token&r=1` }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  try {
    __internals.state.byId.clear();
    __internals.state.bySession.clear();
    __internals.state.tickets.clear();
    __internals.state.dismissed.clear();
    const record = __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: 'ui-dddd4444', sessionId: 'session-d', placement: 'float', revision: 1 },
      undefined,
    );
    __internals.publish(record);

    // Path one: this page loaded the interface, so it already holds the capability.
    // The host validates every /rpc with it, and a close without one is refused with
    // 403 - which is exactly how a working close button came to look dead.
    __internals.state.tickets.set('ui-dddd4444', { url: '/plugins/@mostkia/dsh-htmlui/ui/ui-dddd4444?t=known-token&r=1' });
    __internals.dismissRecord('ui-dddd4444');
    await settle();
    const first = calls.find((call) => call.body !== undefined && call.body.op === 'close');
    assert.ok(first !== undefined, 'the host must be told to drop the record');
    assert.equal(first.body.uiId, 'ui-dddd4444');
    assert.equal(first.body.t, 'known-token', 'the close carries the capability the page holds');
    assert.ok(first.url.endsWith('/rpc'));
    assert.equal(__internals.state.byId.get('ui-dddd4444'), undefined);
    assert.equal(__internals.recordsFor('session-d').length, 0);

    // Path two: a record this page never loaded has no capability yet, so one is
    // minted first and the close uses what comes back.
    calls.length = 0;
    __internals.state.dismissed.clear();
    __internals.publish(record);
    __internals.dismissRecord('ui-dddd4444');
    await settle();
    assert.ok(calls.some((call) => call.url.endsWith('/ui/ticket')), 'a ticket is minted first');
    const second = calls.find((call) => call.body !== undefined && call.body.op === 'close');
    assert.ok(second !== undefined);
    assert.equal(second.body.t, 'fresh-token', 'and the close uses the capability that arrived');
  } finally {
    globalThis.fetch = originalFetch;
    __internals.state.tickets.clear();
    __internals.state.dismissed.clear();
  }
});

test('an interface the snapshot predates is settled by asking the host', async () => {
  // A tool result does not have to carry a timestamp, so "the host did not list it"
  // cannot be read as "the host dropped it": it may just be newer than the snapshot.
  // The card asks again instead of guessing, and the answer decides.
  const listCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/ui/list')) {
      listCalls.push(body);
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            count: 1,
            uis: [{ uiId: 'ui-new00001', sessionId: body.sessionId, title: 'new', placement: 'panel', revision: 1, bytes: 5, sizeText: '', createdAt: 9_000 }],
          }),
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  try {
    __internals.state.byId.clear();
    __internals.state.bySession.clear();
    __internals.state.dismissed.clear();
    __internals.state.hostListed.clear();
    __internals.state.hostSynced.clear();
    __internals.state.hostSyncedAt.clear();
    const sessionId = 'session-ask';
    // An empty snapshot: as far as this page knows, the session holds nothing.
    __internals.convergeSession(sessionId, []);
    assert.equal(__internals.recordsFor(sessionId).length, 0);

    // A card arrives for an id the snapshot does not have, with no timestamp.
    __internals.publish(
      __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-new00001', sessionId, title: 'new', placement: 'panel', revision: 1, bytes: 5 }, undefined),
    );
    assert.equal(__internals.recordsFor(sessionId).length, 0, 'it is not shown on the card alone');

    // Asking settles it: the host lists it, and the ordinary convergence publishes it.
    // The three-argument first call is the convergence itself, which asks nothing.
    assert.equal(listCalls.length, 0, 'the empty snapshot was handed in, not fetched');
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(listCalls.length, 1, 'the page asked the host, once');
    assert.equal(__internals.recordsFor(sessionId).length, 1, 'and the host answer is what decides');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a transcript card cannot republish what the host has dropped', () => {
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  __internals.state.dismissed.clear();
  __internals.state.hostListed.clear();
  __internals.state.hostSynced.clear();
  __internals.state.hostSyncedAt.clear();
  const sessionId = 'session-authority';
  const card = (uiId, createdAt) =>
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId, sessionId, title: uiId, placement: 'dock-top', revision: 1, bytes: 5, createdAt },
      undefined,
    );

  // Before any sync a card is the only source of truth, which is how a first render
  // shows the interface its tool call just carried.
  __internals.publish(card('ui-card0001', 1_000));
  assert.equal(__internals.recordsFor(sessionId).length, 1);

  // The host answers without it: the record goes, and the card cannot bring it back.
  // Every historical card keeps its meta, so this is what a closed interface used to
  // ride back in on.
  __internals.convergeSession(sessionId, []);
  assert.equal(__internals.recordsFor(sessionId).length, 0);
  __internals.publish(card('ui-card0001', 1_000));
  assert.equal(__internals.recordsFor(sessionId).length, 0, 'the host dropped it, so it stays dropped');

  // What the host lists is shown, whoever else mentions it.
  __internals.convergeSession(sessionId, [
    { uiId: 'ui-listed01', sessionId, title: 'listed', placement: 'panel', revision: 1, bytes: 5, sizeText: '', createdAt: 500 },
  ]);
  assert.equal(__internals.recordsFor(sessionId).length, 1);

  // An interface attached after that snapshot cannot be in it, so its card still
  // shows it at once rather than waiting for the next sync.
  __internals.publish(card('ui-fresh001', Date.now() + 60_000));
  assert.equal(__internals.recordsFor(sessionId).length, 2, 'a new interface appears immediately');
});

test('one message key means one thing everywhere it is used', () => {
  // `unavailable` was once used for both "the catalogue is unavailable" and "this
  // document failed to load", so a broken frame said the template catalogue was
  // missing. A key with two different fallbacks is always that mistake.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const seen = new Map();
  for (const match of source.matchAll(/tr\('([a-zA-Z]+)',\s*'([^']*)'/gu)) {
    const [, key, fallback] = match;
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, fallback);
      continue;
    }
    assert.equal(known, fallback, `"${key}" is used for two different messages`);
  }
  assert.ok(seen.size >= 10, 'the scan should find the interface text');
  // Every key it uses must exist in both dictionaries, which is what the locale
  // service is handed.
  for (const [key] of seen) {
    assert.equal(typeof __internals.MESSAGES.en[key], 'string', `MESSAGES.en.${key} must exist`);
    assert.equal(typeof __internals.MESSAGES.zh[key], 'string', `MESSAGES.zh.${key} must exist`);
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
      url: '/plugins/@mostkia/dsh-htmlui/ui/ui-1a2b3c4d?r=3',
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
  store.collapsed.set('ui-cccc3333', true);
  __internals.retire('ui-cccc3333');
  assert.equal(store.byId.get('ui-cccc3333'), undefined);
  assert.equal(__internals.recordsFor('session-c').length, 0);
  assert.equal(store.fullscreen, null);
  assert.equal(store.collapsed.has('ui-cccc3333'), false, 'a retired surface leaves no local state behind');
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

test('a seat that hands no session falls back to the one being viewed', () => {
  // The input zones do not always carry a session. Relying on the props alone is how
  // a docked interface rendered nowhere while the overlay and the drawer stayed up.
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ current: 'session-viewed', byId: {} }),
        subscribe: () => () => {},
      },
    },
  };
  assert.equal(__internals.resolveSessionId({ ctx }), 'session-viewed');
  // The owner's own value still wins when it is there.
  assert.equal(__internals.resolveSessionId({ ctx, session: { sessionId: 'session-own' } }), 'session-own');
  assert.equal(__internals.resolveSessionId({ sessionId: 'session-direct', ctx }), 'session-direct');
  // And a context that cannot answer is not a crash.
  assert.equal(__internals.resolveSessionId({}), undefined);
  assert.equal(__internals.resolveSessionId(undefined), undefined);
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

test('the seats share one list answer instead of each asking', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, count: 1, uis: [{ uiId: 'ui-10100000', sessionId: 'session-sync', title: 'one', placement: 'panel', revision: 1, bytes: 1, sizeText: '' }] }),
    });
  };
  try {
    __internals.state.byId.clear();
    __internals.state.bySession.clear();
    __internals.state.sessionSync.clear();
    // Five seats render at once on a page load; they must make one request.
    await Promise.all([
      __internals.syncSession('session-sync'),
      __internals.syncSession('session-sync'),
      __internals.syncSession('session-sync'),
    ]);
    assert.equal(calls.filter((call) => call.url.endsWith('/ui/list')).length, 1, 'one request for the session');
    assert.equal(__internals.recordsFor('session-sync').length, 1, 'and the seats all see the answer');
    // An explicit refresh asks again.
    await __internals.syncSession('session-sync', { force: true });
    assert.equal(calls.filter((call) => call.url.endsWith('/ui/list')).length, 2);
    // A session with no id is not a request at all.
    await __internals.syncSession(undefined);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __internals.state.sessionSync.clear();
  }
});

test('a reloaded page rebuilds every seat from the host list alone', () => {
  // After F5 the transcript may be virtualized, so the tool cards are not rendered:
  // every surface has to come back from /ui/list, whose records carry no `htmlui`
  // flag and a different shape. This is what the reload path depends on.
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  resetRightPane();
  const hostRecord = (uiId, placement, extra) =>
    Object.assign({ uiId, sessionId: 'session-reload', title: `t-${uiId}`, placement, revision: 1, bytes: 10, sizeText: '' }, extra);
  __internals.convergeSession('session-reload', [
    hostRecord('ui-aaaa0001', 'dock-right'),
    hostRecord('ui-aaaa0002', 'float', { size: { w: 500, h: 400, x: 20, y: 20 }, sizeText: '500x400+20+20' }),
    hostRecord('ui-aaaa0003', 'background'),
    hostRecord('ui-aaaa0004', 'fullscreen'),
    hostRecord('ui-aaaa0005', 'inline'),
  ]);
  assert.equal(__internals.recordsFor('session-reload').length, 5);
  // The right pane is reset here, so the fallback is active and the dock claims
  // dock-right — the only placement that has a second possible seat.
  assert.deepEqual(
    __internals.recordsIn('session-reload', __internals.dockPlacements(['dock-right'])).map((entry) => entry.placement).sort(),
    ['dock-right'],
  );
  assert.equal(__internals.recordsIn('session-reload', ['inline']).length, 1);
  assert.equal(__internals.recordsIn('session-reload', ['dock-right']).length, 1);
  assert.equal(__internals.recordsIn('session-reload', ['background']).length, 1);
  assert.equal(__internals.recordsIn('session-reload', ['float']).length, 1);
  const fullscreen = __internals.activeFullscreen(__internals.recordsFor('session-reload'));
  assert.equal(fullscreen === undefined ? undefined : fullscreen.uiId, 'ui-aaaa0004', 'the layer finds its record');
  assert.equal(fullscreen.title, 't-ui-aaaa0004', 'and the title the client renders is a string');
});

test('a superseded card stops claiming the interface', () => {
  __internals.state.byId.clear();
  __internals.state.bySession.clear();
  const record = (uiId, revision) => ({ htmlui: true, op: 'render', uiId, sessionId: 'session-r', title: uiId, placement: 'inline', revision });
  // Before the store knows the id, the card renders (it is about to publish).
  assert.equal(__internals.isCurrentRevision('ui-55550000', 1), true);
  __internals.publish(__internals.recordFromMeta(record('ui-55550000', 2), undefined));
  assert.equal(__internals.isCurrentRevision('ui-55550000', 2), true, 'the card carrying the current revision renders');
  assert.equal(__internals.isCurrentRevision('ui-55550000', 1), false, 'the earlier card yields to it');
  // A card that is ahead of the store must not be hidden while it catches up.
  assert.equal(__internals.isCurrentRevision('ui-55550000', 3), true);
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
