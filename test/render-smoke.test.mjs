/**
 * Shallow render smoke tests for @mostkia/dsh-htmlui's browser half.
 *
 * The components are normally rendered by React inside the DSH page, and this
 * package ships without a renderer (no react-dom, no test renderer). These tests
 * therefore call each component function with a stub hook runtime and walk the
 * element tree it returns. That is a "shallow render": it proves the branches
 * execute, that the tree carries the expected elements and copy, and that no
 * branch throws — it does NOT prove React's scheduling, effects, or layout. The
 * frame's sandbox attribute is asserted where it is declared, and the live page
 * remains the only full acceptance.
 *
 * Run: node test/render-smoke.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ------------------------------------------------------------------ fake React

/** Deterministic hooks: enough to execute a branch, never to run an effect. */
function stubReact() {
  return {
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
}

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded.push(module);
    },
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  body: null,
  documentElement: { attributes: {}, setAttribute() {}, classList: { contains: () => false } },
  dispatchEvent() {},
};

await import('../client.js');
const exported = loaded[0].factory((id) => {
  if (id === 'react') return stubReact();
  throw new Error(`unexpected require(${id})`);
});
const { __internals } = exported;
const { state } = __internals;

// --------------------------------------------------------------- tree walking

/**
 * Walk an element tree, expanding this package's own components shallowly.
 * @returns {{ text: string, elements: object[] }}
 */
function walk(node, elements = [], text = []) {
  if (node === null || node === undefined || node === false) return { elements, text };
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node));
    return { elements, text };
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, elements, text);
    return { elements, text };
  }
  if (typeof node.type === 'function') {
    elements.push(node);
    walk(node.type(node.props), elements, text);
    return { elements, text };
  }
  elements.push(node);
  for (const child of node.children ?? []) walk(child, elements, text);
  return { elements, text };
}

const render = (component, props) => {
  const tree = walk(component(props ?? {}));
  return { tree, text: tree.text.join(' '), elements: tree.elements };
};

const recordFor = (placement, overrides = {}) => ({
  uiId: 'ui-1a2b3c4d',
  sessionId: 'session-1',
  title: '看板',
  placement,
  sizeText: '520x360+40+40',
  revision: 1,
  bytes: 10,
  createdAt: 1,
  ...overrides,
});

function resetStore(records = []) {
  state.byId.clear();
  state.bySession.clear();
  state.tickets.clear();
  state.collapsed.clear();
  state.fullscreen = null;
  state.fullscreenDismissed.clear();
  state.rightPane.available = false;
  state.rightPane.controller = undefined;
  for (const entry of records) __internals.publish(entry);
}

// --------------------------------------------------------------------- tests

test('an inline frame renders its chrome and a loading body', () => {
  const { text, elements } = render(__internals.HtmlUiFrame, { record: recordFor('inline'), theme: 'light', variant: 'inline' });
  assert.match(text, /看板/);
  assert.match(text, /inline/);
  // The body is the ticket-less state until the effect resolves.
  assert.match(text, /Preparing interface/u);
  assert.ok(elements.length > 0);
});

test('a failing surface reports itself instead of rendering nothing', () => {
  // Silence is the worst outcome for a seat: a dock that renders nothing looks exactly
  // like a plugin that is not installed. The boundary turns it into a line to report.
  const boundary = new __internals.HtmlUiBoundary({ ctx: undefined, children: null });
  assert.equal(boundary.state.error, null, 'a healthy boundary holds no error');
  const failed = new __internals.HtmlUiBoundary({ ctx: undefined, children: null });
  failed.state = { error: new Error('boom') };
  const text = walk(failed.render()).text.join('');
  assert.match(text, /failed to render/u);
  assert.match(text, /boom/u);
  assert.equal(__internals.HtmlUiBoundary.getDerivedStateFromError(new Error('x')).error.message, 'x');
  assert.match(__internals.CLIENT_ACTIVE_LINE, /client active/u);
});

test('the tool card asks for its own row to open, and tolerates an owner without one', () => {
  // The tool row is collapsed by default, and an inline interface lives inside it:
  // without this the caller asks for a panel and sees a one-line tool call.
  const calls = [];
  const disclosure = __internals.useOptionalDisclosure({
    useDisclosure: () => ({ expanded: false, setExpanded: (open) => calls.push(open), toggle: () => {} }),
  });
  assert.equal(disclosure.expanded, false);
  disclosure.setExpanded(true);
  assert.deepEqual(calls, [true], 'the card can open its own row');
  // A slimmer owner that supplies no hook must not crash the card.
  assert.equal(__internals.useOptionalDisclosure({}), null);
  assert.equal(__internals.useOptionalDisclosure({ useDisclosure: 'not a hook' }), null);
});

test('a float frame carries its own drag chrome and a close control', () => {
  const { text } = render(__internals.HtmlUiFrame, { record: recordFor('float'), theme: 'light', variant: 'float', onDismiss: () => {} });
  assert.match(text, /看板/);
  assert.match(text, /float/);
  assert.match(text, /✕/u);
});

test('a background frame renders no chrome at all', () => {
  const withChrome = render(__internals.HtmlUiFrame, { record: recordFor('dock-top'), theme: 'light', variant: 'dock', onDismiss: () => {} });
  assert.match(withChrome.text, /✕/u, 'a dock frame has chrome');
  const background = render(__internals.HtmlUiFrame, { record: recordFor('background'), theme: 'light', variant: 'background' });
  assert.ok(!background.text.includes('✕'), 'a background frame must not offer controls');
  assert.ok(!background.text.includes('background'), 'nor a placement label');
  assert.match(background.text, /Preparing interface/u, 'but it still renders the document');
});

test('the tool card reports each phase without throwing', () => {
  resetStore();
  const preparing = render(__internals.HtmlUiToolView, { phase: 'preparing', block: {} });
  assert.match(preparing.text, /Preparing HTML interface/u);

  const started = render(__internals.HtmlUiToolView, {
    phase: 'start',
    block: { arguments: '{"op":"render","placement":"float","title":"看板"}' },
  });
  assert.match(started.text, /HTML UI/);
  assert.match(started.text, /float/);
});

test('an inline tool card renders the document, and a superseded one does not', () => {
  const meta = { htmlui: true, op: 'render', uiId: 'ui-11110000', sessionId: 'session-1', title: 'A', placement: 'inline', revision: 1, bytes: 5 };
  resetStore();
  const first = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(first.text, /A/);
  assert.match(first.text, /Preparing interface/u, 'the current card owns the document');

  // An update arrives: the store moves to revision 2 and the old card yields.
  resetStore([__internals.recordFromMeta({ ...meta, revision: 2 }, undefined)]);
  const superseded = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(superseded.text, /this revision was replaced/u);
  assert.ok(!superseded.text.includes('Preparing interface'), 'a superseded card must not render a second live copy');
});

test('a docked card offers the right-column route when the column is available', () => {
  const meta = { htmlui: true, op: 'render', uiId: 'ui-22220000', sessionId: 'session-1', title: 'B', placement: 'dock-right', revision: 1, bytes: 5 };
  resetStore([__internals.recordFromMeta(meta, undefined)]);
  state.rightPane.available = false;
  const fallback = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(fallback.text, /placed: dock-right/u);
  assert.ok(!fallback.text.includes('Open in the right column'), 'no right-column button without the service');

  state.rightPane.available = true;
  state.rightPane.controller = { openTab: () => {} };
  const withColumn = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(withColumn.text, /Open in the right column/u);
});

test('the composer docks render nothing until their own placement appears', () => {
  const meta = (uiId, placement) => ({ htmlui: true, op: 'render', uiId, sessionId: 'session-1', title: uiId, placement, revision: 1, bytes: 5 });
  resetStore();
  assert.equal(__internals.HtmlUiDock({ session: { id: 'session-1' }, placements: ['dock-top', 'panel'] }), null);

  resetStore([__internals.recordFromMeta(meta('ui-33330000', 'dock-bottom'), undefined)]);
  assert.equal(
    __internals.HtmlUiDock({ session: { id: 'session-1' }, placements: ['dock-top', 'panel'] }),
    null,
    'the top dock does not claim a bottom placement',
  );
  const bottom = render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-bottom'] });
  assert.match(bottom.text, /ui-33330000/);

  resetStore([__internals.recordFromMeta(meta('ui-44440000', 'panel'), undefined)]);
  const panel = render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-top', 'panel'] });
  assert.match(panel.text, /ui-44440000/);
});

test('the right pane states its empty case and then hosts its own records', () => {
  resetStore();
  const empty = render(__internals.HtmlUiRightPane, { sessionId: 'session-1' });
  assert.match(empty.text, /no right-column interface/u);

  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-55550000', sessionId: 'session-1', title: 'R', placement: 'dock-right', revision: 1, bytes: 5 }, undefined),
  ]);
  const hosted = render(__internals.HtmlUiRightPane, { sessionId: 'session-1' });
  assert.match(hosted.text, /R/);
});

test('the template drawer renders nothing closed and a row per template open', () => {
  const templates = { open: false, loaded: true, items: [], error: null };
  state.templates = templates;
  assert.equal(__internals.HtmlUiTemplateDrawer({ sessionId: 'session-1' }), null, 'a closed drawer occupies nothing');

  templates.open = true;
  templates.items = [
    { slug: 'starter', name: 'starter', description: 'demo panel', bundled: true, bytes: 10 },
    { slug: 'mine', name: 'mine', description: '', bundled: false, bytes: 2 },
  ];
  const open = render(__internals.HtmlUiTemplateDrawer, { sessionId: 'session-1' });
  assert.match(open.text, /HTML UI templates \(2\)/u);
  assert.match(open.text, /starter/);
  assert.match(open.text, /mine/);
  assert.match(open.text, /Apply/u, 'one action applies it locally');
  assert.match(open.text, /Ask the model/u, 'and one hands it to the model');
  assert.match(open.text, /bundled/u, 'a packaged template is marked');

  // An empty catalogue and an unavailable one both explain themselves.
  templates.items = [];
  assert.match(render(__internals.HtmlUiTemplateDrawer, { sessionId: 'session-1' }).text, /No templates yet/u);
  templates.error = 'unavailable';
  assert.match(render(__internals.HtmlUiTemplateDrawer, { sessionId: 'session-1' }).text, /Template catalogue unavailable/u);
  templates.open = false;
});

test('the overlay renders nothing without a session, and the fullscreen layer when pinned', () => {
  resetStore();
  assert.equal(__internals.HtmlUiOverlay({ ctx: { sessions: {} } }), null);

  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-66660000', sessionId: 'viewed', title: 'F', placement: 'fullscreen', revision: 1, bytes: 5 }, undefined),
  ]);
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'viewed', byId: {} }), subscribe: () => () => {} } } };
  const overlay = render(__internals.HtmlUiOverlay, { ctx });
  assert.match(overlay.text, /fullscreen/u);
  assert.match(overlay.text, /Back to chat/u, 'the switch back is part of the layer');
});
