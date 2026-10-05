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
  // A docked split is seamless: the document, and a faint control cluster, without a
  // title row or a box around either.
  assert.match(bottom.text, /Preparing interface/u);
  assert.ok(!bottom.text.includes('ui-33330000'), 'a docked split draws no title row');
  assert.match(bottom.text, /✕/u);

  resetStore([__internals.recordFromMeta(meta('ui-44440000', 'panel'), undefined)]);
  const panel = render(__internals.HtmlUiDock, { session: { id: 'session-1' }, placements: ['dock-top', 'panel'] });
  assert.match(panel.text, /Preparing interface/u);
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
  // The tab already carries the title, so the body draws the document alone.
  assert.match(hosted.text, /Preparing interface/u);
  assert.ok(!hosted.text.includes('R'), 'the tab title is not repeated inside the body');
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
});

test('an inline interface renders in the newest turn tail, and only there', () => {
  // A turn tail renders once per turn, so rendering inline interfaces in every tail
  // would stack a copy per turn; rendering them in the tail that created them would
  // need the record to carry its turn. The newest tail is the one seat that needs
  // neither, and it is where "the current interfaces" belong.
  const inline = __internals.recordFromMeta(
    { htmlui: true, op: 'render', uiId: 'ui-bb660001', sessionId: 'session-tail', title: 'T', placement: 'inline', revision: 1, bytes: 5 },
    undefined,
  );
  resetStore([inline]);
  __internals.state.tailSeq.clear();
  // The newest tail is learned by rendering: the first tail claims the slot, and a
  // later tail takes it over.
  const older = render(__internals.HtmlUiInlineTail, { sessionId: 'session-tail', seq: 10 });
  assert.match(older.text, /Preparing interface/u, 'the first tail seen renders the interface');
  const newer = render(__internals.HtmlUiInlineTail, { sessionId: 'session-tail', seq: 40 });
  assert.match(newer.text, /Preparing interface/u, 'a newer turn takes the interface over');
  const olderAgain = render(__internals.HtmlUiInlineTail, { sessionId: 'session-tail', seq: 10 });
  assert.equal(olderAgain.text, '', 'and the older turn stops drawing it');
  // Without a session or a sequence there is nothing to decide.
  assert.equal(__internals.HtmlUiInlineTail({ sessionId: 'session-tail' }), null);
  assert.equal(__internals.HtmlUiInlineTail({ seq: 40 }), null);
  // A session with no inline interface draws nothing even in its newest tail.
  __internals.state.tailSeq.clear();
  assert.equal(render(__internals.HtmlUiInlineTail, { sessionId: 'session-other', seq: 1 }).text, '');
});

test('the tool card points at the tail instead of drawing a second copy', () => {
  const block = {
    meta: { htmlui: true, op: 'render', uiId: 'ui-bb660002', sessionId: 'session-tail', title: 'Card', placement: 'inline', revision: 1, bytes: 5 },
  };
  const card = render(__internals.HtmlUiToolView, { phase: 'result', block, ctx: undefined });
  assert.match(card.text, /Card/u, 'the row still names the interface');
  assert.match(card.text, /shown at the end of this turn/u, 'and says where it is drawn');
  assert.ok(!card.text.includes('Preparing interface'), 'it does not draw the document as well');
});

test('the create dialog asks what to start from and where to put it', () => {
  resetStore();
  resetCreate();
  // Closed, it is not in the tree at all.
  assert.equal(__internals.HtmlUiCreateDialog({ sessionId: 'session-1' }), null);
  __internals.state.create.open = true;
  __internals.state.templates.loaded = true;
  __internals.state.templates.items = [
    { slug: 'starter', name: 'starter', description: 'demo', bundled: true, bytes: 10 },
  ];
  const dialog = render(__internals.HtmlUiCreateDialog, { sessionId: 'session-1' });
  for (const text of ['New HTML interface', 'Blank canvas', 'starter', 'Right column', 'Floating window', 'Fullscreen', 'Create', 'Cancel']) {
    assert.ok(dialog.text.includes(text), `the dialog offers ${text}`);
  }
  // The chosen place is the one the placement has to name.
  assert.equal(__internals.state.create.placement, 'dock-right');
  resetCreate();
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
