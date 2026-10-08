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
  const note = (name) => {
    if (hookLog !== null) hookLog.push(name);
  };
  return {
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      note('useState');
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect: () => {
      note('useEffect');
    },
    useRef: (initial) => {
      note('useRef');
      return { current: initial };
    },
    useCallback: (fn) => {
      note('useCallback');
      return fn;
    },
    useMemo: (fn) => {
      note('useMemo');
      return fn();
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      note('useSyncExternalStore');
      return getSnapshot();
    },
  };
}

/**
 * Records one component's OWN hook sequence, so a changing order can be caught.
 * Children are not walked: React error #310 is about the hooks a component itself
 * calls being a different count than on its previous render, not about its subtree.
 */
let hookLog = null;
function hookOrder(Component, props) {
  hookLog = [];
  try {
    Component(props);
  } catch {
    /* a throw still leaves the order that preceded it, which is the point */
  }
  const seen = hookLog.join(' ');
  hookLog = null;
  return seen;
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
  // Inline hosting is per page, not per record: a reset has to forget it too, or one suite's
  // hosted document would appear in the next one's overlay.
  state.inlineHosted.clear();
  state.inlineSeats.clear();
  state.inlineHeights.clear();
  resetCreate();
  for (const entry of records) __internals.publish(entry);
}

/** The create dialog is shared state, so every reset has to close it too. */
function resetCreate() {
  state.create = { open: false, source: 'blank', placement: 'dock-right', busy: false };
}

// --------------------------------------------------------------------- tests

test('an inline frame is seamless: no chrome, no border, content-sized', () => {
  const { text, elements } = render(__internals.HtmlUiFrame, { record: recordFor('inline'), theme: 'light', variant: 'inline' });
  // The body is the ticket-less state until the effect resolves.
  assert.match(text, /Preparing interface/u);
  assert.ok(elements.length > 0);
  // It reads as part of the conversation: the title is not drawn, there is no close
  // control, and no box around it.
  assert.ok(!text.includes('看板'), 'no title row');
  assert.ok(!text.includes('✕'), 'no close control');
  const styles = elements.map((element) => element.props.style ?? {});
  for (const style of styles) {
    assert.notEqual(style.border, '1px solid var(--dsw-alias-border-l1, #ddd)', 'no frame border');
    assert.equal(style.background === 'var(--dsw-alias-bg-base, #fff)', false, 'no opaque background');
  }
  // The height comes from the document's own measurement when it reports one.
  const measured = render(__internals.HtmlUiFrame, {
    record: recordFor('inline'),
    theme: 'light',
    variant: 'inline',
    initialSize: { h: 180 },
  });
  assert.match(measured.text, /Preparing interface/u);
  // The height convention, unchanged by hosting: a document taller than the cap scrolls inside
  // its own frame instead of swallowing the conversation, a very short one keeps a floor, and a
  // document that reports nothing — everything in it positioned, so it has no measurable height
  // — gets a sensible box. The seat and the frame ask one function for this number, so the room
  // the transcript reserves and the room the document is drawn in can never disagree.
  const boxHeight = (initialSize) =>
    render(__internals.HtmlUiFrame, { record: recordFor('inline', { sizeText: '' }), theme: 'light', variant: 'inline', initialSize }).elements[0]
      .props.style.height;
  assert.equal(boxHeight({ h: 4000 }), '640px', 'a very long document is capped, so it scrolls itself');
  assert.equal(boxHeight({ h: 12 }), '60px', 'a very short one keeps a floor');
  assert.equal(boxHeight(undefined), '220px', 'a document that reports nothing gets the default box');
  assert.equal(boxHeight({ h: 300 }), '300px', 'and an ordinary one is taken as it measures');
  assert.equal(__internals.inlineHeightOf(4000), 640, 'the seat reserves exactly what the frame draws');
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

test('an inline tool card points at the tail, and a superseded one yields', () => {
  const meta = { htmlui: true, op: 'render', uiId: 'ui-11110000', sessionId: 'session-1', title: 'A', placement: 'inline', revision: 1, bytes: 5 };
  resetStore();
  const first = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(first.text, /A/);
  // The document is drawn by the turn tail, not by this row: one seat draws it, so a
  // GUI that shows tool rows cannot show two copies of the same interface.
  assert.match(first.text, /shown at the end of this turn/u);
  assert.ok(!first.text.includes('Preparing interface'), 'the row does not draw the document itself');

  // An update arrives: the store moves to revision 2 and the old card yields.
  resetStore([__internals.recordFromMeta({ ...meta, revision: 2 }, undefined)]);
  const superseded = render(__internals.HtmlUiToolView, { phase: 'result', block: { meta } });
  assert.match(superseded.text, /this revision was replaced/u);
  assert.ok(!superseded.text.includes('shown at the end'), 'a superseded card must not claim the current revision');
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

test('the fallback dock draws nothing without a record, but still measures the column', () => {
  const meta = (uiId, placement) => ({ htmlui: true, op: 'render', uiId, sessionId: 'session-1', title: uiId, placement, revision: 1, bytes: 5 });
  resetStore();
  // Nothing to draw, so no visible surface: the dock's only output is its measuring
  // node, which is a zero-height child of the conversation column. A fullscreen
  // surface is placed from that measurement rather than over the user's sidebar.
  const idle = render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-right'] });
  assert.equal(idle.text, '', 'nothing visible without a record');
  assert.ok(idle.elements.length > 0, 'the measuring node is still rendered, which is what the geometry is read from');

  resetStore([__internals.recordFromMeta(meta('ui-33330000', 'float'), undefined)]);
  // A float is not the dock's business, so the dock still draws nothing visible.
  assert.equal(render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-right'] }).text, '');

  resetStore([__internals.recordFromMeta(meta('ui-44440000', 'dock-right'), undefined)]);
  const claimed = render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-right'] });
  assert.match(claimed.text, /Preparing interface/u);
  assert.ok(!claimed.text.includes('ui-44440000'), 'a docked split draws no title row');
  assert.match(claimed.text, /✕/u);
});

test('the right pane renders nothing until it has something to host', () => {
  resetStore();
  // An empty column costs the reader half the frame, and the column is not the
  // plugin's to open or close: with nothing to show, the plugin shows nothing.
  assert.equal(__internals.HtmlUiRightPane({ sessionId: 'session-1' }), null);
  assert.equal(render(__internals.HtmlUiRightPane, { sessionId: 'session-1' }).text, '');

  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-55550000', sessionId: 'session-1', title: 'R', placement: 'dock-right', revision: 1, bytes: 5 }, undefined),
  ]);
  const hosted = render(__internals.HtmlUiRightPane, { sessionId: 'session-1' });
  // The tab carries the title, so the body draws the document without one — but each
  // object keeps its own collapse and close, because the column can hold several.
  assert.match(hosted.text, /Preparing interface/u);
  assert.ok(!hosted.text.includes('R'), 'the tab title is not repeated inside the body');
  assert.match(hosted.text, /✕/u, 'one object can be closed without closing the tab');
  assert.match(hosted.text, /▾/u, 'and collapsed on its own');

  // Collapsing has to give the space back: a collapsed row takes its control row only.
  const expandedRow = hosted.elements.filter((element) => element.props?.style?.flex !== undefined).map((element) => element.props.style.flex);
  assert.ok(expandedRow.includes('1 1 auto'), 'an expanded object shares the column height');
  __internals.state.collapsed.set('ui-55550000', true);
  const collapsed = render(__internals.HtmlUiRightPane, { sessionId: 'session-1' });
  const collapsedRow = collapsed.elements.filter((element) => element.props?.style?.flex !== undefined).map((element) => element.props.style.flex);
  assert.ok(collapsedRow.includes('0 0 auto'), 'a collapsed object keeps only its control row');
  assert.ok(!collapsedRow.includes('1 1 auto'), 'and does not hold an empty share of the column');
  __internals.state.collapsed.delete('ui-55550000');
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
  assert.match(open.text, /New or reuse \(2\)/u);
  assert.match(open.text, /Blank canvas/u, 'the blank canvas is always the first way in');
  assert.match(open.text, /starter/);
  assert.match(open.text, /mine/);
  assert.match(open.text, /Apply/u, 'one action applies it locally');
  assert.match(open.text, /Ask the model/u, 'and one hands it to the model');
  assert.match(open.text, /bundled/u, 'a packaged template is marked');
  // A long catalogue must not push the composer off the screen: the list scrolls inside
  // the drawer instead of growing without limit.
  assert.ok(
    open.elements.some((element) => element.props?.style?.overflowY === 'auto' && element.props?.style?.maxHeight !== undefined),
    'the drawer caps its list height and scrolls it',
  );

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
  // The layer draws the chrome, so the frame inside must not draw a second one.
  assert.equal(overlay.text.match(/fullscreen/gu).length, 1, 'exactly one title row');

  // Two surfaces, one pinned: the other stays mounted but hidden, because unmounting would
  // destroy its document and coming back would reload the interface from scratch.
  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-66660000', sessionId: 'viewed', title: 'F', placement: 'fullscreen', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-66660001', sessionId: 'viewed', title: 'G', placement: 'fullscreen', revision: 1, bytes: 5 }, undefined),
  ]);
  __internals.state.fullscreen = 'ui-66660000';
  const both = render(__internals.HtmlUiOverlay, { ctx });
  const surfaces = both.elements.filter((element) => element.props?.['aria-modal'] === 'true');
  assert.equal(surfaces.length, 2, 'both fullscreen surfaces stay in the tree');
  assert.equal(surfaces.filter((surface) => surface.props.style.display === 'none').length, 1, 'and the inactive one is hidden, not removed');

  // A Session switch swaps the *visibility* of the overlay groups and nothing else: every
  // session keeps its frames mounted while another is on screen, so a float or fullscreen
  // layer comes back exactly as it was instead of being reloaded from scratch. Unmounting them
  // with the session they belonged to is what lost their documents' state on every switch.
  const floatOf = (uiId, sessionId) =>
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId, sessionId, title: uiId, placement: 'float', revision: 1, bytes: 5 }, undefined);
  resetStore([floatOf('ui-77770001', 'viewed'), floatOf('ui-77770002', 'other')]);
  const ctxOther = { sessions: { list: { getSnapshot: () => ({ current: 'other', byId: {} }), subscribe: () => () => {} } } };
  const drawn = (other) => {
    const tree = render(__internals.HtmlUiOverlay, { ctx: other ? ctxOther : ctx });
    return {
      frames: tree.elements.filter((element) => element.type === __internals.HtmlUiFrame).map((element) => element.props.record.uiId),
      group: (owner) => tree.elements.find((element) => element.props?.['data-htmlui-overlay'] === owner),
    };
  };
  const here = drawn(false);
  assert.deepEqual([...here.frames].sort(), ['ui-77770001', 'ui-77770002'], 'both sessions keep their frames while one is viewed');
  assert.equal(here.group('viewed').props.style.display, 'contents', 'the viewed session is shown');
  assert.equal(here.group('other').props.style.display, 'none', 'the other one is only hidden');
  const there = drawn(true);
  assert.deepEqual([...there.frames].sort(), ['ui-77770001', 'ui-77770002'], 'and the switch mounts nothing and drops nothing');
  assert.equal(there.group('viewed').props.style.display, 'none', 'the session left behind is hidden');
  assert.equal(there.group('other').props.style.display, 'contents', 'and the one entered is shown');
  resetStore();
});

/**
 * One Tool row as the Chat snapshot materializes it: a `tool-call` Node whose `data.root` is
 * the tool block. The block that carries the host's answer is the `tool-result`, and the
 * presentation meta rides on it — which is where the tail reads the interface from.
 */
const toolRow = (meta, turn) => ({
  kind: 'tool-call',
  location: { kind: 'turn', turn: { turn } },
  data: { root: { kind: 'tool-result', meta, subCalls: [] } },
});

/**
 * A Chat-snapshot stand-in for the tail's selectors: the ordered node keys, those nodes, and
 * the Turn windows (`[turn, startTime, endTime]`, the end omitted while a turn is open).
 */
function chatSnapshot({ windows, rows = {} }) {
  const entries = new Map(Object.entries(rows));
  const turns = new Map();
  for (const [turn, start, end] of windows) {
    turns.set(turn, {
      turn,
      start: { seq: 0, time: start },
      ...(end === undefined ? {} : { end: { seq: 0, time: end } }),
    });
  }
  return {
    order: [...entries.keys()],
    nodes: { get: (key) => entries.get(key) },
    timeline: { turnOrder: windows.map(([turn]) => turn), turns },
  };
}

const useChatOf = (snapshot) => (selector) => selector(snapshot);

/** The inline seats a tree holds: the transcript's placeholders, in order. */
const seatsOf = (tree) =>
  tree.elements
    .filter((element) => element.props?.['data-htmlui-inline-seat'] !== undefined)
    .map((element) => element.props['data-htmlui-inline-seat']);

test('an inline interface is seated in the turn that made it, and only there', () => {
  // An interface belongs to the turn whose tool call made it: that turn's own chat nodes name
  // it, so its tail — and only its tail — holds its seat. Nothing is elected while rendering:
  // re-deciding mid-flight is what tore an interface out of one tail and rebuilt it in another.
  // The seat is a placeholder, not the document: the document itself is hosted by the overlay
  // (see the hosting test below), so a rebuilt transcript cannot destroy it.
  resetStore([
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: 'ui-bb660001', sessionId: 'session-tail', title: 'T', placement: 'inline', revision: 1, bytes: 5 },
      undefined,
    ),
  ]);
  const snapshot = chatSnapshot({
    windows: [
      [7, 100, 200],
      [8, 300, 400],
      [9, 600, undefined],
    ],
    rows: {
      // The call that made it.
      k1: toolRow({ htmlui: true, op: 'render', uiId: 'ui-bb660001', sessionId: 'session-tail' }, 7),
      // A later call that merely *mentions* it — listing a session's interfaces, updating it —
      // must not claim it: claiming it is what made the turn that ended draw a copy of
      // somebody else's interface.
      k2: toolRow({ htmlui: true, op: 'list', uiId: 'ui-bb660001', sessionId: 'session-tail' }, 8),
      k3: toolRow({ htmlui: true, op: 'update', uiId: 'ui-bb660001', sessionId: 'session-tail' }, 9),
    },
  });
  const useChat = useChatOf(snapshot);
  const owner = render(__internals.HtmlUiInlineTail, { sessionId: 'session-tail', seq: 40, turn: { turn: 7 }, useChat });
  assert.deepEqual(seatsOf(owner), ['ui-bb660001'], 'the turn that made the interface holds its seat');
  for (const turn of [8, 9]) {
    const stranger = render(__internals.HtmlUiInlineTail, { sessionId: 'session-tail', seq: 41 + turn, turn: { turn }, useChat });
    assert.deepEqual(seatsOf(stranger), [], `a turn that only mentions it holds no seat (turn ${turn})`);
  }
  // Without a session, a sequence, or the turn this tail closes there is nothing to decide.
  assert.equal(__internals.HtmlUiInlineTail({ sessionId: 'session-tail' }), null);
  assert.equal(__internals.HtmlUiInlineTail({ seq: 40 }), null);
  // A session holding no inline interface holds no seat.
  assert.deepEqual(seatsOf(render(__internals.HtmlUiInlineTail, { sessionId: 'session-other', seq: 1, turn: { turn: 7 }, useChat })), []);
});

test('an inline document is hosted by the overlay, and its seat holds the space', () => {
  // The document is drawn from the frame-wide overlay, never from the transcript: the transcript
  // is rebuilt whenever the reader switches Session — or a turn scrolls out of the virtualized
  // window — and a frame inside it would be destroyed by that rebuild, losing its state. The
  // seat in the transcript only reserves the room the document takes, and says where it goes.
  resetStore([
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: 'ui-99000001', sessionId: 'viewed', title: 'Inline', placement: 'inline', revision: 1, bytes: 5 },
      undefined,
    ),
  ]);
  const record = state.byId.get('ui-99000001');
  const ctxFor = (current) => ({ sessions: { list: { getSnapshot: () => ({ current, byId: {} }), subscribe: () => () => {} } } });
  const hosted = (tree) => tree.elements.filter((element) => element.props?.['data-htmlui-inline-host'] !== undefined);

  // A page load must not build the document of every old turn: hosting starts when a seat has
  // actually been on screen.
  assert.equal(hosted(render(__internals.HtmlUiOverlay, { ctx: ctxFor('viewed') })).length, 0, 'nothing is hosted before its seat appears');

  __internals.claimInlineSeat('ui-99000001', { isConnected: true, parentElement: null });
  assert.equal(state.inlineHosted.has('ui-99000001'), true, 'the first seat is what starts hosting');
  const here = render(__internals.HtmlUiOverlay, { ctx: ctxFor('viewed') });
  assert.equal(hosted(here).length, 1, 'the overlay hosts the document');
  assert.equal(here.elements.filter((element) => element.type === __internals.HtmlUiFrame).length, 1, 'with the frame inside it');

  // The height the document asks for is what the seat reserves, and the bounds are shared with
  // the frame, so the two can never disagree about how much room the interface takes.
  state.inlineHeights.set('ui-99000001', 321);
  assert.equal(render(__internals.InlineSeat, { record }).elements[0].props.style.height, '321px', 'the seat holds the document height');
  assert.equal(__internals.inlineHeightOf(undefined), 220, 'an unmeasured document gets the fallback');
  assert.equal(__internals.inlineHeightOf(10), 60, 'a tiny one keeps a floor');
  assert.equal(__internals.inlineHeightOf(4000), 640, 'and a very long one is capped');

  // Switching Session hides the group; it does not unmount the document.
  const away = render(__internals.HtmlUiOverlay, { ctx: ctxFor('other') });
  assert.equal(hosted(away).length, 1, 'the document stays mounted while another session is on screen');
  assert.equal(away.elements.find((element) => element.props?.['data-htmlui-overlay'] === 'viewed').props.style.display, 'none', 'and its group is the hidden one');

  // Losing the seat only hides it; closing the interface is what stops the hosting.
  __internals.releaseInlineSeat('ui-99000001');
  assert.equal(state.inlineHosted.has('ui-99000001'), true, 'a lost seat keeps hosting the document');
  __internals.retire('ui-99000001');
  assert.equal(state.inlineHosted.has('ui-99000001'), false, 'closing it forgets the hosting');
  assert.equal(state.inlineHeights.has('ui-99000001'), false, 'and its height');
  resetStore();
});

test('a template applied from the drawer stays put instead of being redrawn per turn', () => {
  // The reported bug: applying a template from the composer drawer during a streaming answer
  // put a fresh copy at the bottom of the conversation as soon as that answer — and every later
  // one — finished, because the newest tail kept adopting whatever the session held. The
  // interface belongs where the conversation stood when the reader applied it, and it must not
  // move from there.
  const windows = [
    [7, 100, 200],
    [8, 300, 400],
    [9, 600, undefined],
  ];
  const snapshot = chatSnapshot({ windows });
  const useChat = useChatOf(snapshot);
  const tail = (turn, seq) => render(__internals.HtmlUiInlineTail, { sessionId: 'session-drawer', seq, turn: { turn }, useChat });

  // Applied while turn 8 was answering: it lands where the conversation stood — turn 7 — and
  // turn 8's own tail, the one that appears the instant that answer ends, holds no seat for it.
  resetStore([
    { uiId: 'ui-dd770001', sessionId: 'session-drawer', title: '日历', placement: 'inline', revision: 1, bytes: 5, createdAt: 350 },
  ]);
  assert.deepEqual(seatsOf(tail(7, 50)), ['ui-dd770001'], 'it appears at once, where the conversation stood');
  assert.deepEqual(seatsOf(tail(8, 51)), [], 'the answer that was streaming holds no copy of it');
  assert.deepEqual(seatsOf(tail(9, 52)), [], 'and neither does any later turn');

  // Applied with the session idle: the last closed turn is the bottom of the conversation, so
  // it appears there — and the next answer still does not re-seat it.
  resetStore([
    { uiId: 'ui-dd770002', sessionId: 'session-drawer', title: '计算器', placement: 'inline', revision: 1, bytes: 5, createdAt: 500 },
  ]);
  assert.deepEqual(seatsOf(tail(8, 60)), ['ui-dd770002'], 'an idle insertion lands at the end of the last turn');
  assert.deepEqual(seatsOf(tail(9, 61)), [], 'the next turn does not carry it down to itself');

  // Older than every loaded turn: the window can open mid-conversation, and the first loaded
  // turn is the honest seat — anything is better than dropping the interface.
  resetStore([
    { uiId: 'ui-dd770003', sessionId: 'session-drawer', title: '早', placement: 'inline', revision: 1, bytes: 5, createdAt: 50 },
  ]);
  assert.deepEqual(seatsOf(tail(7, 70)), ['ui-dd770003'], 'an interface older than the window sits at its top');
  assert.deepEqual(seatsOf(tail(8, 71)), [], 'and is not seated again below');
  resetStore();
});

test('the forwarded wheel scrolls the conversation, and the band stops at the composer', () => {
  resetStore();
  // The band a hosted document is clipped to ends where the composer begins. The composer is
  // drawn *over* the transcript, so clipping to the scroll container alone let a document
  // scrolled to the bottom paint on top of the input box.
  const composerSeat = { isConnected: true, getBoundingClientRect: () => ({ top: 700 }) };
  state.composerSeat = composerSeat;
  assert.equal(__internals.transcriptBandBottom(900), 700, 'the band ends at the composer');
  assert.equal(__internals.transcriptBandBottom(600), 600, 'and it never extends the band it is given');
  composerSeat.isConnected = false;
  assert.equal(__internals.transcriptBandBottom(900), 900, 'with no composer seat the band is the fallback');
  state.composerSeat = null;

  // A wheel the document could not use scrolls the transcript the frame used to be a child of,
  // and past its end it goes on to the page — the same chain the frame had before it was hosted.
  const scroller = {
    top: 100,
    get scrollTop() {
      return this.top;
    },
    set scrollTop(value) {
      this.top = Math.min(300, Math.max(0, value));
    },
    scrollLeft: 0,
    isConnected: true,
  };
  const seat = { isConnected: true, parentElement: null };
  __internals.claimInlineSeat('ui-wheel0001', seat);
  state.inlineSeats.set('ui-wheel0001', { element: seat, scroller });
  __internals.scrollTranscriptBy('ui-wheel0001', 0, 120);
  assert.equal(scroller.scrollTop, 220, 'the conversation takes the forwarded delta');
  scroller.scrollTop = 300;
  const page = {
    top: 0,
    get scrollTop() {
      return this.top;
    },
    set scrollTop(value) {
      this.top = value;
    },
    scrollLeft: 0,
  };
  const previous = document.scrollingElement;
  document.scrollingElement = page;
  __internals.scrollTranscriptBy('ui-wheel0001', 0, 120);
  assert.equal(page.scrollTop, 120, 'past the end of the transcript it chains on to the page');
  document.scrollingElement = previous;
  resetStore();
});

test('the session page names each interface with the project it came from', () => {
  // 计算器(calculator): the title a reader recognises, then the project, so two
  // interfaces built from the same project are told apart at a glance.
  resetStore([
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: 'ui-cc550001', sessionId: 'session-1', title: '计算器', placement: 'float', template: 'calculator', revision: 1, bytes: 5 },
      undefined,
    ),
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: 'ui-cc550002', sessionId: 'session-1', title: '手写', placement: 'inline', revision: 1, bytes: 5 },
      undefined,
    ),
  ]);
  const page = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
  assert.ok(page.text.includes('计算器(calculator)'), 'the project id rides along with the title');
  assert.ok(page.text.includes('手写') && !page.text.includes('手写('), 'an interface with no project stays plain');
  resetStore();
});

test('the session page carries its own way to start a project', () => {
  // The composer control is small and easy to miss; the page the reader is already on
  // offers the same flow in words.
  resetStore();
  const page = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
  assert.match(page.text, /New HTML project/u, 'the create flow is offered here too');
  resetStore();
});

test('the create dialog asks what to start from and where to put it', () => {
  resetStore();
  resetCreate();
  // Closed, it is not in the tree at all.
  assert.equal(__internals.HtmlUiCreateDialog({ sessionId: 'session-1' }), null);
  __internals.state.create.open = true;
  __internals.state.templates.loaded = true;
  __internals.state.templates.dir = '/opt/html-templates';
  __internals.state.templates.items = [
    { slug: 'starter', name: 'starter', description: 'demo', bundled: true, bytes: 10 },
  ];
  const dialog = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  for (const text of ['New HTML interface', 'New HTML project', 'Blank canvas', 'starter', 'Right column', 'Floating window', 'Fullscreen', 'Create', 'Cancel', 'Use this directory']) {
    assert.ok(dialog.text.includes(text), `the dialog offers ${text}`);
  }
  // Only the project list is capped: a long catalogue must not push 默认生成位置 and the
  // buttons below the fold, and everything else in the form keeps its natural size.
  const capped = dialog.elements.filter((element) => element.props?.style?.overflowY === 'auto' && element.props?.style?.maxHeight !== undefined);
  assert.equal(capped.length, 1, 'exactly one region scrolls inside the dialog');
  // The catalogue's directory is on screen and editable, not hidden in documentation.
  const directory = dialog.elements.find((element) => element.props?.type === 'text');
  assert.ok(directory !== undefined, 'a directory box is part of the dialog');
  assert.equal(directory.props.value, '/opt/html-templates', 'showing the directory the catalogue came from');
  // A catalogue entry reads as 项目名称（进程ID）: the human name leads and the id follows
  // when the two differ, which is what `template=` takes.
  __internals.state.templates.items = [
    { slug: 'my-page', name: '我的页面', description: '自述', bundled: false, bytes: 10 },
    { slug: 'red', name: 'red', description: '', bundled: false, bytes: 10 },
  ];
  const named = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  assert.ok(named.text.includes('我的页面（my-page）'), 'the name leads and the id follows');
  assert.ok(!named.text.includes('我的页面（my-page） — '), 'the description stays out of the row');
  assert.ok(!named.text.includes('red（red）'), 'and an entry whose name is its id stays plain');
  // Every project carries a pencil that reopens the same form, prefilled, to edit it.
  const pencils = named.elements.filter((element) => typeof element.props?.['aria-label'] === 'string' && element.props['aria-label'].startsWith('Edit this project'));
  assert.equal(pencils.length, 2, 'one pencil per project, and none for the blank canvas');
  __internals.state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', busy: false };
  pencils[0].props.onClick();
  assert.equal(__internals.state.adopt.open, true, 'the pencil opens the form');
  assert.equal(__internals.state.adopt.existing, true, 'and says it is an edit');
  assert.equal(__internals.state.adopt.slug, 'my-page');
  assert.equal(__internals.state.adopt.name, '我的页面', 'prefilled from the project itself');
  assert.equal(__internals.state.adopt.description, '自述');
  const editing = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  assert.ok(editing.text.includes('Edit project details'), 'the form reads as an edit');
  assert.ok(editing.text.includes('Save changes'), 'and its button saves rather than creates');
  assert.ok(!editing.text.includes('Nothing is written yet'), 'without claiming nothing exists');
  // Picking a different project is also a statement about which project the open form is about:
  // it follows, because a save that lands on the previously opened project is exactly the failure
  // this guards against.
  const sourceChoices = editing.elements.filter((element) => element.props?.type === 'radio' && element.props?.name === 'dsh-create-source');
  const other = sourceChoices.find((element) => element.props?.value === 'red');
  assert.ok(other !== undefined, 'every project has a source choice');
  other.props.onChange();
  assert.equal(__internals.state.create.source, 'red', 'the choice moves');
  assert.equal(__internals.state.adopt.slug, 'red', 'and so does the open edit form');
  __internals.state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', busy: false };
  __internals.state.templates.candidates = [
    { kind: 'dir', name: 'my-folder', html: 2 },
    { kind: 'file', name: '我的页面.html', html: 1 },
  ];
  const withCandidates = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  assert.match(withCandidates.text, /Not projects yet \(2\)/u);
  assert.match(withCandidates.text, /my-folder/u);
  assert.match(withCandidates.text, /我的页面\.html/u);
  assert.match(withCandidates.text, /Adopt/u);

  // Adopting asks for the manifest instead of writing one behind the reader's back:
  // the slug is what a template is addressed by, so it is filled in and confirmed.
  __internals.state.adopt = { open: true, existing: false, source: 'my-folder', slug: 'my-folder', name: 'my-folder', description: '', placement: 'dock-right', busy: false };
  const adopting = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  for (const text of ['Project details for my-folder', 'Project name', 'Process ID', 'Details', 'Where it opens', 'Write the manifest']) {
    assert.ok(adopting.text.includes(text), `the adopt form offers ${text}`);
  }
  const slugBox = adopting.elements.find((element) => element.props?.type === 'text' && element.props.value === 'my-folder');
  assert.ok(slugBox !== undefined, 'the id is prefilled from the folder name');

  // A project that ships a backend is offered the switch; one that does not is told what would
  // offer it, and never given a switch that would do nothing.
  const withBackend = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  __internals.state.adopt = Object.assign({}, __internals.state.adopt, { backendDeclared: true });
  const offered = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  assert.ok(!withBackend.elements.some((element) => element.props?.type === 'checkbox'), 'no switch without a declaration');
  assert.ok(withBackend.text.includes('No backend here'), 'and the line that says what would offer one');
  const switch_ = offered.elements.find((element) => element.props?.type === 'checkbox');
  assert.ok(switch_ !== undefined, 'a declared backend is offered as a switch');
  assert.equal(switch_.props.checked, false, 'and it starts off: the declaration is not permission');
  assert.ok(offered.text.includes('Run this project'), 'the switch says what it does');
  assert.ok(offered.text.includes('as trusted as the plugin itself'), 'and what granting it means');

  __internals.state.adopt = { open: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', busy: false };
  __internals.state.templates.candidates = [];
  // The chosen place is the one the placement has to name.
  assert.equal(__internals.state.create.placement, 'dock-right');
  resetCreate();
});

test('the session manager lists what is attached and can remove it', () => {
  // A click-through background layer and a seamless inline one offer no control of
  // their own, so this page is the only way for a user to take them away.
  resetStore();
  const empty = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
  assert.match(empty.text, /no HTML interface/u);

  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-99000001', sessionId: 'session-1', title: '看板', placement: 'background', revision: 2, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-99000002', sessionId: 'session-1', title: '表单', placement: 'inline', revision: 1, bytes: 5 }, undefined),
  ]);
  const listed = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
  assert.match(listed.text, /\(2\)/u, 'the count is the session count');
  for (const text of ['看板', '表单', 'background', 'inline', 'ui-99000001', 'ui-99000002', 'Close interface']) {
    assert.ok(listed.text.includes(text), `the manager shows ${text}`);
  }
  // A different session is not this session's business.
  const other = render(__internals.HtmlUiManager, { sessionId: 'session-2' });
  assert.match(other.text, /no HTML interface/u);
});

test('the sandbox follows the project, and only unsafe touches the origin', () => {
  // The frame's isolation is per project. Strict, local and open all keep the document
  // away from this page; only the level the reader chose explicitly gives that up.
  const strict = __internals.sandboxFor('strict');
  assert.ok(strict.includes('allow-scripts'), 'a document may still run its own script');
  assert.ok(!strict.includes('allow-same-origin'), 'and cannot reach the DSH page');
  assert.equal(__internals.sandboxFor('local'), strict, 'serving a project’s files changes no sandbox flag');
  assert.equal(__internals.sandboxFor('open'), strict, 'and neither does allowing the network');
  assert.equal(__internals.sandboxFor(undefined), strict, 'an interface with no level is strict');
  assert.ok(__internals.sandboxFor('unsafe').includes('allow-same-origin'), 'unsafe is the one that drops isolation');
});

test('a background layer is dimmed by the client, and that is what keeps the interface usable', () => {
  // `shell.overlay` is a frame-wide layer above every column, and its host creates a
  // stacking context, so nothing rendered from there can reach behind the interface. A
  // fully opaque document would cover the whole workspace — and because the layer takes no
  // pointer events, its own document could not offer a way out either. The dimming is
  // therefore the safety of the mode, not a decoration: at 0.4 the interface stays
  // readable and every control stays clickable.
  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-88000002', sessionId: 'viewed', title: '壁纸', placement: 'background', revision: 1, bytes: 5 }, undefined),
  ]);
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'viewed', byId: {} }), subscribe: () => () => {} } } };
  const overlay = render(__internals.HtmlUiOverlay, { ctx });
  const layer = overlay.elements.find((element) => element.props?.style?.position === 'fixed' && element.props?.style?.zIndex === 1);
  assert.ok(layer !== undefined, 'the background layer is on screen');
  assert.equal(layer.props.style.opacity, 0.25, 'and is kept translucent');
  assert.equal(layer.props.style.pointerEvents, 'none', 'it takes no clicks of its own');
  assert.ok(!overlay.text.includes('Hide background'), 'and it carries no extra control');
  resetStore();
});

test('a float window carries its own minimize, and a hidden one stays alive', () => {
  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-88000001', sessionId: 'viewed', title: '浮窗', placement: 'float', revision: 1, bytes: 5 }, undefined),
  ]);
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'viewed', byId: {} }), subscribe: () => () => {} } } };
  const shown = render(__internals.HtmlUiOverlay, { ctx });
  assert.match(shown.text, /Preparing interface/u, 'a float renders its document');

  // Minimizing puts it away without deleting the record — and without unmounting the frame,
  // because unmounting destroys the document and restoring it would reload the interface
  // from scratch, losing whatever lived in it.
  const record = __internals.recordsFor('viewed').find((entry) => entry.placement === 'float');
  __internals.state.hidden.add(record.uiId);
  const hidden = render(__internals.HtmlUiOverlay, { ctx });
  assert.match(hidden.text, /Preparing interface/u, 'a hidden float keeps its frame in the tree');
  const wrapper = hidden.elements.find((element) => element.props?.style?.display === 'none');
  assert.ok(wrapper !== undefined, 'hidden by style, not by removal');
  assert.equal(__internals.recordsFor('viewed').length, 1, 'and the record is still there to restore');

  // The control itself is offered on the frame, next to the close.
  const frame = render(__internals.HtmlUiFrame, { record, theme: 'light', variant: 'float', onMinimize: () => {}, onDismiss: () => {} });
  assert.match(frame.text, /—/u, 'the minimize control is drawn');
  assert.match(frame.text, /✕/u, 'next to the close');
  resetStore();
});

test('a float remembers where it was left, and a touch brings it to the front', () => {
  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-66000001', sessionId: 'viewed', title: 'A', placement: 'float', size: { w: 400, h: 300, x: 40, y: 60 }, sizeText: '400x300+40+60', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-66000002', sessionId: 'viewed', title: 'B', placement: 'float', size: { w: 400, h: 300, x: 80, y: 100 }, sizeText: '400x300+80+100', revision: 1, bytes: 5 }, undefined),
  ]);
  const [first, second] = __internals.recordsFor('viewed');
  // The reader moves the first window; the component remembers it in module state, so
  // hiding it later (which unmounts it) cannot lose the place.
  __internals.state.geometry.set(first.uiId, { w: 420, h: 320, x: 500, y: 260 });
  const restored = render(__internals.HtmlUiFrame, { record: first, theme: 'light', variant: 'float', onMinimize: () => {}, onDismiss: () => {} });
  const box = restored.elements.map((element) => element.props?.style ?? {}).find((style) => style.position === 'fixed');
  assert.equal(box.left, '500px', 'the remembered left edge is used');
  assert.equal(box.top, '260px', 'and the remembered top edge');
  assert.equal(box.width, '420px', 'as are its remembered dimensions');

  // Stacking: untouched windows sit at the base, and the one touched comes forward.
  const base = render(__internals.HtmlUiFrame, { record: second, theme: 'light', variant: 'float' });
  const baseBox = base.elements.map((element) => element.props?.style ?? {}).find((style) => style.position === 'fixed');
  assert.equal(baseBox.zIndex, 2, 'an untouched window sits at the base of the stack');
  __internals.raiseFloat(second.uiId);
  const raised = render(__internals.HtmlUiFrame, { record: second, theme: 'light', variant: 'float' });
  const raisedBox = raised.elements.map((element) => element.props?.style ?? {}).find((style) => style.position === 'fixed');
  assert.ok(raisedBox.zIndex > baseBox.zIndex, 'the touched window is drawn above');
  resetStore();
});

test('the session page restores every form that can be hidden', () => {
  resetStore([
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-77000001', sessionId: 'session-1', title: '背景', placement: 'background', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-77000002', sessionId: 'session-1', title: '浮窗', placement: 'float', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-77000003', sessionId: 'session-1', title: '右栏', placement: 'dock-right', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-77000004', sessionId: 'session-1', title: '全屏', placement: 'fullscreen', revision: 1, bytes: 5 }, undefined),
    __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-77000005', sessionId: 'session-1', title: '内联', placement: 'inline', revision: 1, bytes: 5 }, undefined),
  ]);
  const listed = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
  const restores = (listed.text.match(/Show/gu) ?? []).length;
  // Three of the five: a background layer is always on screen and an inline surface lives in
  // the conversation, so neither can be hidden and neither has anything to restore.
  assert.equal(restores, 3, 'three of the five forms can be shown again');
  assert.ok(listed.text.includes('Close interface'), 'and every one of them can be closed, which is what the label now says');
  resetStore();
});

test('every surface keeps one hook order, records or not', () => {
  // React error #310 in the live page came from exactly this: hooks placed after an
  // early return. The count only changed once a seat actually had records, so no test
  // noticed. Rendering the same component in both states catches it here.
  const dockProps = { session: { id: 'session-hooks' }, placements: ['dock-top', 'panel'] };
  resetStore();
  const emptyOrder = hookOrder(__internals.HtmlUiDock, dockProps);
  assert.ok(emptyOrder.includes('useCallback'), 'the dock does call callbacks');
  const filled = ['dock-top', 'panel'].map((placement) =>
    __internals.recordFromMeta(
      { htmlui: true, op: 'render', uiId: `ui-${placement.replace('-', '')}0000`, sessionId: 'session-hooks', title: placement, placement, revision: 1, bytes: 5 },
      undefined,
    ),
  );
  resetStore(filled);
  assert.equal(hookOrder(__internals.HtmlUiDock, dockProps), emptyOrder, 'a dock must call the same hooks with and without records');
  resetStore();
  assert.equal(hookOrder(__internals.HtmlUiDock, { placements: ['dock-top'] }), emptyOrder, 'nor may a missing session shorten the sequence');

  const withoutRecord = hookOrder(__internals.HtmlUiToolView, { phase: 'result', block: { meta: undefined }, ctx: undefined });
  const withRecord = hookOrder(__internals.HtmlUiToolView, {
    phase: 'result',
    block: { meta: { htmlui: true, op: 'render', uiId: 'ui-hook0001', sessionId: 'session-hooks', title: 'H', placement: 'inline', revision: 1, bytes: 5 } },
    ctx: undefined,
  });
  assert.equal(withRecord, withoutRecord, 'the tool card keeps one order with and without a record');

  resetStore();
  assert.equal(
    hookOrder(__internals.HtmlUiTemplateDrawer, { sessionId: 'session-hooks' }),
    hookOrder(__internals.HtmlUiTemplateDrawer, { sessionId: undefined }),
    'the drawer keeps one order open or closed',
  );
  assert.equal(
    hookOrder(__internals.HtmlUiRightPane, { sessionId: 'session-hooks' }),
    hookOrder(__internals.HtmlUiRightPane, { sessionId: undefined }),
    'the right-pane body keeps one order',
  );
  assert.equal(
    hookOrder(__internals.HtmlUiOverlay, { ctx: { sessions: {} } }),
    hookOrder(__internals.HtmlUiOverlay, { ctx: { sessions: { list: { getSnapshot: () => ({ current: 'viewed', byId: {} }), subscribe: () => () => {} } } } }),
    'the overlay keeps one order with and without the viewed session',
  );
});

test('the capability is read from either URL shape', () => {
  // A project that serves its own files is opened at `…/files/<id>/<token>/index.html`,
  // because a relative subresource request has no query string to carry the token in. The
  // closing path read only the query, found nothing, and never sent the close — so those
  // interfaces could not be removed and came back on every load.
  __internals.state.tickets.clear();
  __internals.state.tickets.set('ui-token001', { url: '/plugins/@mostkia/dsh-htmlui/ui/ui-token001?t=query-token&r=1' });
  assert.equal(__internals.ticketToken('ui-token001'), 'query-token', 'the plain document route carries it in the query');
  __internals.state.tickets.set('ui-token002', { url: '/plugins/@mostkia/dsh-htmlui/files/ui-token002/path-Token_1/index.html?r=1' });
  assert.equal(__internals.ticketToken('ui-token002'), 'path-Token_1', 'the file route carries it in the path');
  assert.equal(__internals.ticketToken('ui-unknown'), undefined, 'and an interface this page never loaded has none');
  __internals.state.tickets.clear();
});

test('a closed surface stays closed until the host drops the record', () => {
  const record = __internals.recordFromMeta(
    { htmlui: true, op: 'render', uiId: 'ui-close0001', sessionId: 'session-close', title: 'C', placement: 'float', revision: 1, bytes: 5 },
    undefined,
  );
  resetStore([record]);
  assert.equal(__internals.recordsFor('session-close').length, 1);
  // The user closes it. The host may still list it for a while (the close request is
  // in flight, or it failed); a convergence must not resurrect it, or the close looks
  // like a button that does nothing.
  __internals.dismissRecord('ui-close0001');
  assert.equal(__internals.recordsFor('session-close').length, 0);
  __internals.convergeSession('session-close', [
    { uiId: 'ui-close0001', sessionId: 'session-close', title: 'C', placement: 'float', revision: 1, bytes: 5, sizeText: '' },
  ]);
  assert.equal(__internals.recordsFor('session-close').length, 0, 'a dismissal outlives a stale list');
  // Once the host stops listing the id, the dismissal is spent - but the transcript
  // card that carried the interface is still there, and it must NOT bring it back:
  // that is how a closed surface reappeared every time the page was reloaded.
  __internals.convergeSession('session-close', []);
  assert.equal(__internals.state.dismissed.has('ui-close0001'), false);
  __internals.publish(record);
  assert.equal(__internals.recordsFor('session-close').length, 0, 'a card cannot resurrect what the host dropped');
  // The host itself remains authoritative: what it lists is shown.
  __internals.publish(record, { fromHost: true });
  assert.equal(__internals.recordsFor('session-close').length, 1, 'the host answer is published');
  __internals.state.dismissed.clear();
});

test('a bare frame draws no chrome of its own', () => {
  // The fullscreen layer draws its own bar; without this the surface showed two.
  const framed = render(__internals.HtmlUiFrame, { record: recordFor('dock-top'), theme: 'light', variant: 'dock', onDismiss: () => {} });
  assert.match(framed.text, /✕/u);
  const bare = render(__internals.HtmlUiFrame, { record: recordFor('dock-top'), theme: 'light', variant: 'dock', bare: true, onDismiss: () => {} });
  assert.ok(!bare.text.includes('✕'), 'no close control of its own');
  assert.match(bare.text, /Preparing interface/u, 'but the document is still rendered');
});

test('a floating window is fitted to the viewport it is drawn in', () => {
  const fit = __internals.fitFloat;
  const viewport = (w, h) => {
    window.innerWidth = w;
    window.innerHeight = h;
  };

  // A desktop keeps exactly what it asked for: 520×360 at 96,96 fits, so nothing moves.
  viewport(1280, 800);
  assert.deepEqual(fit({ w: 520, h: 360, x: 96, y: 96 }), { w: 520, h: 360, x: 96, y: 96 });

  // A phone: the same default would hang its resize handle off the right edge, and the window
  // could then never be made smaller. It is fitted instead, and stays fully on screen.
  viewport(390, 844);
  const phone = fit({ w: 520, h: 360, x: 96, y: 96 });
  assert.ok(phone.w <= 390 - 8 * 2, `width fits the phone (${phone.w})`);
  assert.ok(phone.h <= 844 - 8 * 2, `height fits the phone (${phone.h})`);
  assert.ok(phone.x >= 8 && phone.x + phone.w <= 390 - 8, 'and its far edge, where the handle is, stays reachable');
  assert.ok(phone.y >= 8 && phone.y + phone.h <= 844 - 8);

  // A size the model picked for a desktop, opened on a phone, is fitted the same way.
  const big = fit({ w: 1200, h: 2000, x: -50, y: 9999 });
  assert.equal(big.w, 390 - 16);
  assert.equal(big.h, 844 - 16);
  assert.equal(big.x, 8);
  assert.equal(big.y, 8);

  // Growing past the viewport is capped, so the handle cannot leave the screen again; shrinking
  // is not: the reader keeps every size that fits.
  const grown = fit({ w: 5000, h: 5000, x: 20, y: 20 });
  assert.equal(grown.w, 390 - 16);
  const small = fit({ w: 300, h: 200, x: 20, y: 20 });
  assert.deepEqual(small, { w: 300, h: 200, x: 20, y: 20 });

  // A window already at the far corner is pulled back rather than left hanging over the edge.
  const corner = fit({ w: 300, h: 200, x: 9999, y: 9999 });
  assert.equal(corner.x + corner.w, 390 - 8);
  assert.equal(corner.y + corner.h, 844 - 8);

  viewport(1280, 800);
});

// ------------------------------------------------------- project backends (keepAlive)

/**
 * One catalogue row for a project that ships a backend, as the host reports it: declared,
 * allowed, resident and running. The marks the UI draws all hang off these four booleans.
 */
const backendProject = (overrides = {}) => ({
  slug: 'heimiao',
  name: '黑喵',
  description: '',
  bytes: 1,
  backend: Object.assign({ declared: true, allowed: true, resident: true, loaded: true }, overrides),
});

/** The catalogue is shared state; every test that needs one sets the whole shape. */
function setCatalogue(items) {
  state.templates = {
    open: true,
    loaded: true,
    loadedAt: Date.now(),
    items,
    candidates: [],
    error: null,
    dir: '/opt/html-templates',
    configured: true,
    asked: true,
    savingDir: false,
    adopting: '',
    notice: null,
  };
}

/**
 * Render with our own Chinese table active. These assertions are about the words a reader
 * reads, and the default in this harness is English — the table has to be the one in play.
 */
function withChinese(fn) {
  const previous = document.documentElement.lang;
  document.documentElement.lang = 'zh';
  try {
    return fn();
  } finally {
    document.documentElement.lang = previous;
  }
}

const buttonsLabelled = (tree, label) =>
  tree.elements.filter((element) => element.type === 'button' && Array.isArray(element.children) && element.children[0] === label);

const checkboxes = (tree) => tree.elements.filter((element) => element.type === 'input' && element.props?.type === 'checkbox');

test('a resident backend is marked on the project row and in the manager, and can be stopped from both', () => {
  resetStore();
  resetCreate();
  const declared = backendProject();
  const undeclared = { slug: 'plain', name: '平静', description: '', bytes: 1, backend: { declared: false, allowed: false, resident: false, loaded: false } };
  const silent = { slug: 'bare', name: 'bare', description: '', bytes: 1 };
  setCatalogue([declared, undeclared, silent]);
  state.create.open = true;

  withChinese(() => {
    // The drawer's project list is the authoritative way to end a backend: it lists projects,
    // not interfaces, so it is still here after every panel — and every manager row — is gone.
    const dialog = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
    for (const text of ['常驻', '已加载', '已授权']) {
      assert.ok(dialog.text.includes(text), `the project row says ${text}`);
    }
    // What residency means is a tooltip now: as an inline line of small print it wrapped onto a
    // second row on a phone, which made every row taller than the control it was explaining.
    assert.ok(
      dialog.elements.some((element) => typeof element.props?.title === 'string' && element.props.title.includes('关掉面板也不会停')),
      'the residency chip explains itself in a tooltip',
    );
    const stops = buttonsLabelled(dialog, '停止后台');
    assert.equal(stops.length, 1, 'one stop control, for the only project that has a backend');
    assert.equal(stops[0].props.disabled, false, 'a loaded backend can be stopped');
    assert.ok(dialog.text.includes('只结束这个进程，不撤销授权'), 'and the list says what stopping does not do');

    // A project that declares no backend, and one whose row says nothing about backends at all,
    // get no marks: an empty chip would read as a state nobody can act on.
    setCatalogue([undeclared, silent]);
    const without = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
    for (const mark of ['常驻', '跟随面板', '已加载', '未加载', '已授权', '未授权', '停止后台']) {
      assert.ok(!without.text.includes(mark), `a project with no backend shows no ${mark}`);
    }
    setCatalogue([declared, undeclared, silent]);

    // The manager lists interfaces, so the backend has to be named there too — and the row is
    // where 隐藏/移除 sits, which is exactly the control a reader mistakes for stopping it.
    resetStore([
      __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-be000001', sessionId: 'session-1', title: '看板', placement: 'float', template: 'heimiao', revision: 1, bytes: 5 }, undefined),
      __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-be000002', sessionId: 'session-1', title: '手写', placement: 'float', template: 'plain', revision: 1, bytes: 5 }, undefined),
      __internals.recordFromMeta({ htmlui: true, op: 'render', uiId: 'ui-be000003', sessionId: 'session-1', title: '空', placement: 'float', revision: 1, bytes: 5 }, undefined),
    ]);
    const manager = render(__internals.HtmlUiManager, { sessionId: 'session-1' });
    assert.ok(manager.text.includes('带后台'), 'the row says the project has a backend');
    assert.ok(manager.text.includes('常驻') && manager.text.includes('已加载'), 'and what state that backend is in');
    assert.ok(manager.text.includes('隐藏或移除界面不等于停止后台'), 'hiding is not stopping, said where both controls are');
    assert.equal(buttonsLabelled(manager, '停止后台').length, 1, 'and the one control that does stop it');
    for (const mark of ['未加载', '跟随面板', '已授权', '未授权']) {
      assert.ok(!manager.text.includes(mark), `the manager shows no backend mark for a project that declares none (${mark})`);
    }
    resetStore();
  });
  resetCreate();
});

test('the resident switch is offered only for a declared backend that may run', () => {
  resetStore();
  resetCreate();
  // The project's effective answer is 跟随面板: an edit must open showing that, or the next
  // save would turn 常驻 back on for a reader who had already turned it off.
  setCatalogue([backendProject({ resident: false, loaded: false })]);
  state.create.open = true;
  const form = (adopt) => {
    state.adopt = Object.assign(
      { open: true, existing: true, source: 'heimiao', slug: 'heimiao', name: '黑喵', description: '', placement: 'dock-right', security: 'strict', busy: false },
      adopt,
    );
    return render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  };

  withChinese(() => {
    // Nothing to run: no switches at all, and nothing said about 常驻.
    const undeclared = form({ backendDeclared: false, backend: false, resident: false });
    assert.equal(checkboxes(undeclared).length, 0, 'no backend, no switches');
    assert.ok(!undeclared.text.includes('常驻'), 'and nothing about 常驻');

    // Declared but not yet allowed: the allowance is the only question on the table, because
    // a process that may not run has nothing to keep resident.
    const notAllowed = form({ backendDeclared: true, backend: false, resident: true });
    assert.equal(checkboxes(notAllowed).length, 1, 'only the allowance switch');
    assert.ok(!notAllowed.text.includes('常驻（关掉面板也继续跑）'), 'and no resident switch before the backend may run');

    // Allowed: both switches, the second starting from the host's effective value.
    const allowed = form({ backendDeclared: true, backend: true, resident: true });
    const boxes = checkboxes(allowed);
    assert.equal(boxes.length, 2, 'the allowance and the resident switch');
    assert.equal(boxes[1].props.checked, true, 'an edit starts from what the host reports');
    assert.ok(allowed.text.includes('常驻'), 'the switch says what it is');
    // Same reason as the chips: the explanation is a tooltip, so the form does not grow a second
    // wrapped line on a phone.
    assert.ok(
      allowed.elements.some((element) => typeof element.props?.title === 'string' && element.props.title.includes('关掉面板也会继续跑')),
      'and explains itself in a tooltip',
    );
    assert.ok(allowed.text.includes('停止后台'), 'and names the controls that stop it');
    // Unchecking it is one of those ways: the box is the value the form carries to the host.
    boxes[1].props.onChange({ target: { checked: false } });
    assert.equal(state.adopt.resident, false, 'the box is the value the form submits');

    // The pencil reopens the form on an existing project: it must start from that project's
    // effective answer, which the host reports as 跟随面板.
    state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false };
    const pencil = buttonsLabelled(render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' }), '✎');
    assert.equal(pencil.length, 1, 'the project row keeps its pencil');
    pencil[0].props.onClick();
    assert.equal(state.adopt.resident, false, 'the form starts from the project\u2019s effective answer');
    assert.equal(checkboxes(render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' }))[1].props.checked, false, 'and so does its switch');

    // Adopting a folder that ships a server.js: its metadata is not read yet, and what it
    // declares is 常驻, so the default follows the declaration.
    resetCreate();
    state.create.open = true;
    state.templates.candidates = [{ kind: 'dir', name: 'with-server', html: 1, server: true }];
    const adopt = buttonsLabelled(render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' }), '设为项目');
    assert.equal(adopt.length, 1, 'the copied-in folder is offered');
    adopt[0].props.onClick();
    assert.equal(state.adopt.backendDeclared, true, 'the folder declares a backend');
    assert.equal(state.adopt.resident, true, 'and a new project defaults to what it declares');
  });
  state.templates.candidates = [];
  resetCreate();
});

test('stopping a backend posts the stop route, and the row behind the message agrees with it', async () => {
  // The route is the contract the host half implements: only the project id rides along, so a
  // stop can never double as a permission change, and the catalogue is re-read afterwards —
  // the message and the 已加载/未加载 mark come from different answers otherwise.
  const realFetch = globalThis.fetch;
  const saved = Object.assign({}, state.templates);
  const calls = [];
  let stopped = true;
  globalThis.fetch = (url, options) => {
    const text = String(url);
    calls.push({ url: text, body: JSON.parse(options.body) });
    const payload = text.endsWith('/templates/backend/stop')
      ? { ok: true, slug: 'heimiao', stopped, allowed: true, declared: true, resident: true }
      : { ok: true, templates: [backendProject({ loaded: !stopped })], candidates: [] };
    return Promise.resolve({ json: () => Promise.resolve(payload) });
  };
  try {
    const result = await __internals.stopBackend('heimiao');
    assert.ok(calls[0].url.endsWith('/templates/backend/stop'), 'the stop route is the one that is called');
    assert.deepEqual(calls[0].body, { slug: 'heimiao' }, 'and it carries the project id and nothing else');
    assert.equal(result.ok, true);
    assert.equal(result.stopped, true, 'the answer says a process really ended');
    assert.match(result.message, /heimiao/u, 'and names the project it happened to');
    assert.ok(calls.some((call) => call.url.endsWith('/templates')), 'the catalogue is re-read, so the row agrees with the message');

    // A backend that was already gone is not a failure, and is not reported as one.
    stopped = false;
    const idle = await __internals.stopBackend('heimiao');
    assert.equal(idle.ok, true, 'nothing to stop is not an error');
    assert.match(idle.message, /not running/u, 'and it says so instead of claiming a stop');
  } finally {
    globalThis.fetch = realFetch;
    state.templates = saved;
  }
});

