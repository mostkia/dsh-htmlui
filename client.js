/*
 * @mostkia/dsh-htmlui — browser half.
 *
 * Renders every attached HTML document in a sandboxed iframe and places it where
 * its record says it belongs:
 *
 *   inline                 the tool card that carried it, inside the transcript
 *   dock-right      the session side panel (a real left/right split)
 *   panel                  the same dock, refreshed in place
 *   float                  a draggable, resizable window over the frame
 *   background             a click-through layer over the frame
 *   fullscreen             covers the session, with a built-in switch back to chat
 *   dock-right             the session's right column, as a tab
 *
 * The frame talks back through the host HTTP carrier, never through host DOM
 * access: `window.dshHTML` is injected by the host half.
 */
window.__ModuleLoader__.load({
  id: '@mostkia/dsh-htmlui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const ROUTE_BASE = '/plugins/@mostkia/dsh-htmlui';
    /**
     * The version this browser half belongs to, and the line that announces it.
     *
     * The marker is not decoration: during acceptance it was repeatedly unclear whether a page was
     * running the current browser half, and each wrong guess cost a round. It is logged *and*
     * shown in the create dialog, so the answer is one glance instead of one assumption. This
     * constant is the only place the client states its version, and `package.test.mjs` holds it
     * to the packaged one.
     */
    const CLIENT_VERSION = '0.1.3';
    const CLIENT_ACTIVE_LINE = `[dsh-htmlui] client active (${CLIENT_VERSION})`;
    /**
     * One line per frame mount and unmount. A frame that is remounted loses its
     * document, and during acceptance that was indistinguishable from a URL change
     * without this. It is a debug line: silence it here when it is not needed.
     */
    const DEBUG_FRAMES = true;
    /** Right-sidebar tab type: its `id` is also the key its body registers under. */
    const TAB_ID = '@mostkia/dsh-htmlui/panel';
    const TAB_KIND = 'dsh-htmlui-panel';
    const FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
    /**
     * The sandbox for one document.
     *
     * The default is what it has always been: an opaque-origin frame that can run script
     * but cannot touch the page around it, so a document can never reach the DSH
     * interface. A project the reader imported themselves can be raised to `unsafe`,
     * which adds `allow-same-origin` — and with it, access to this page. That is a real
     * trade, so it is per project, chosen by the reader, never a default, and the form
     * says so where the choice is made.
     */
    function sandboxFor(security) {
      return security === 'unsafe' ? `${FRAME_SANDBOX} allow-same-origin` : FRAME_SANDBOX;
    }
    // The tallest an inline document is drawn before it starts scrolling inside itself. Taller than
    // a phone screen would waste the conversation, and this is the point where a document is asked
    // to scroll rather than grow.
    const INLINE_MAX_HEIGHT = 640;
    const DOCK_MIN_HEIGHT = 140;

    /**
     * Everything that makes a phone behave differently — the map, then the values.
     *
     * The map matters more than the numbers. A later change to a mobile surface has to be *complete*,
     * so this is the list of places it can touch (all of them in this file):
     *
     *   1. `narrowViewport()` — the only layout breakpoint; every other branch below keys off it.
     *   2. `HtmlUiTemplateButton` — the composer entry, which collapses to its mark on a phone.
     *   3. `HtmlUiCreateDialog` — the dialog becomes a bottom sheet: scrim, radius, padding, the
     *      header row and its close control, the hint, the directory row, and the footer button pair.
     *   4. the shared small-button style — `Object.assign({}, buttonStyle, { flex: '0 0 auto' }, ...)`
     *      — used by the directory and template rows: three occurrences, one shape. Change all three.
     *   5. the injected `dsh-htmlui-chrome-lift` stylesheet inside `apply()`. It is deliberately
     *      scoped to the *shell's* mobile gate (`max-width: 1023px` **and** `pointer: coarse`), not
     *      to the breakpoint above: it mirrors how the shell decides to show its mobile navigation.
     *   6. the injected `dsh-htmlui-sheet-fields` stylesheet, also in `apply()`. Another installed
     *      plugin holds *every* text field on the page at 16px with `!important`, so iOS Safari
     *      cannot focus-zoom the viewport, and its comment says it means to reach third-party panels
     *      — ours included. Our fields are ours to size, so the sheet's two sizes are stated again
     *      there, with `SHEET_ID` supplying the specificity that decides between two `!important`
     *      rules.
     *
     * Touch forwarding is behaviour, not styling, and lives in `assets/bridge.js`.
     *
     * Every phone value those places use is in `MOBILE` below, and none of them is written as a
     * literal at its call site: one edit here reaches all of them, which is the point. A new
     * mobile-only number belongs in this object first — a literal inside a `narrow ?` branch is
     * exactly the value that gets half-changed.
     *
     * These are the phone values; every desktop branch keeps exactly the value it had before.
     */
    const MOBILE = {
      /** The one layout breakpoint, in pixels. */
      maxWidthPx: 640,
      /** The composer entry, once it collapses to its mark. */
      entryHeight: '24px',
      entryPadding: '0 7px',
      /** Tap targets inside the sheet. */
      buttonHeight: '34px',
      buttonPadding: '0 12px',
      buttonFont: '12.5px',
      /** The sticky footer pair: it splits the row, so it is wider than a row button. */
      footerButtonPadding: '0 14px',
      footerGap: '8px',
      /** The sheet itself. */
      sheetRadius: '14px 14px 0 0',
      sheetPadding: '14px 14px calc(14px + env(safe-area-inset-bottom, 0px))',
      sheetMaxHeight: '88vh',
      scrim: 'rgba(0,0,0,0.45)',
      /** Its header: the title, the line under it, and the square close control. */
      titleFont: '15px',
      titleWeight: 650,
      hintFont: '12px',
      closeRadius: '9px',
      closeFont: '15px',
      /** Its sections, packed tighter than the desktop dialog packs them. */
      sectionMargin: '4px 0',
      dirRowGap: '4px',
      /** The directory field: compact, and its text shrinks with it. */
      inputHeight: '30px',
      inputPadding: '0 9px',
      inputRadius: '8px',
      inputFont: '11.5px',
    };

    /**
     * The id the create sheet carries, so the injected field-size rule can name it.
     *
     * It is an id rather than a class on purpose. The rule it has to out-rank is another plugin's
     * page-wide `!important` field floor, and between two `!important` declarations the higher
     * *specificity* wins — not the later one, and not the inline style.
     */
    const SHEET_ID = 'dsh-htmlui-sheet';

    /**
     * The size of a text control inside that sheet, on both branches: the form's fields are the same
     * fields whether it is drawn as a dialog or as a bottom sheet. The one exception is the directory
     * row, which is compact on a phone (`MOBILE.inputFont`).
     *
     * It is named because the injected rule has to state the same number to the browser, and a second
     * copy of a number is how two copies drift apart.
     */
    const SHEET_FIELD_FONT = '12px';

    /**
     * The dock's height limits, in the current window.
     *
     * A docked surface is a split of the session view, so its natural size is half the
     * window and its ceiling is most of it — not a fixed 720 px that made "split the
     * view" impossible on a tall screen.
     */
    function dockLimits() {
      const viewport = typeof window === 'object' && Number.isFinite(window === null || window === undefined ? undefined : window.innerHeight) ? window.innerHeight : 800;
      return { min: DOCK_MIN_HEIGHT, max: Math.max(DOCK_MIN_HEIGHT + 80, Math.round(viewport * 0.85)) };
    }

    /** The height a docked split opens at: half the window. */
    function defaultDockHeight() {
      const limits = dockLimits();
      const viewport = typeof window === 'object' && Number.isFinite(window === null || window === undefined ? undefined : window.innerHeight) ? window.innerHeight : 800;
      return Math.min(limits.max, Math.max(limits.min, Math.round(viewport * 0.5)));
    }
    const DEFAULT_FLOAT = { w: 520, h: 360, x: 96, y: 96 };

    /**
     * True once the page is going away. The right column's body unmounts on a reload just
     * as it does when its tab is closed, so the two have to be told apart before a
     * teardown may be read as "the reader closed the tab".
     */
    let pageUnloading = false;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        pageUnloading = true;
      });
      window.addEventListener('beforeunload', () => {
        pageUnloading = true;
      });
    }

    // ------------------------------------------------------------------ store

    const state = {
      byId: new Map(),
      bySession: new Map(),
      tickets: new Map(),
      /** One shared /ui/list answer per session, so the seats do not each ask. */
      sessionSync: new Map(),
      /** Ids the user closed here, so a convergence cannot bring them back. */
      dismissed: new Set(),
      /** Last ids the host listed per session, and which sessions have been asked. */
      hostListed: new Map(),
      hostSynced: new Set(),
      hostSyncedAt: new Map(),
      /** Sessions whose list answer is in flight right now. */
      hostSyncing: new Set(),
      /** The conversation column's own left edge and width, measured from our seats. */
      column: { left: 0, width: 0 },
      /**
       * Inline interfaces whose transcript seat has been on screen at least once.
       *
       * An inline document is hosted by the overlay, because the transcript it belongs to is
       * rebuilt whenever the reader switches Session — a frame living in it is destroyed by that
       * rebuild, and the document comes back empty. Hosting starts when the seat first appears,
       * so a page load still only loads the documents whose turn is actually rendered.
       */
      inlineHosted: new Set(),
      /** The transcript seat of each hosted inline interface, with the scroller that clips it. */
      inlineSeats: new Map(),
      /** The height each inline document asked for, so its seat can hold the space it occupies. */
      inlineHeights: new Map(),
      /**
       * The plugin's own seat inside the composer block, when one is mounted.
       *
       * The composer sits *over* the transcript rather than beside it, so the scroll container's
       * own rectangle reaches under the input box. Clipping a hosted inline document to that
       * rectangle would paint it on top of the input box; the composer's top edge is what the
       * band really ends at, and this seat is inside that block, which is how it is known
       * without reading anyone else's DOM.
       */
      composerSeat: null,
      /** Interfaces the reader put away without deleting: floats, for now. */
      hidden: new Set(),
      /** Where each float was left, so hiding and restoring it keeps its place. */
      geometry: new Map(),
      /** Float stacking: the last one touched is drawn on top. */
      floatZ: new Map(),
      floatZTop: 1,
      collapsed: new Map(),
      fullscreen: null,
      /** Interfaces the user switched away from, so auto-open does not fight them. */
      fullscreenDismissed: new Set(),
      /** Right-sidebar availability: the native split needs the column's tab service. */
      rightPane: { available: false, controller: undefined, opened: new Set() },
      /** The template drawer: what the catalogue holds and whether it is showing. */
      templates: { open: false, loaded: false, loadedAt: 0, items: [], candidates: [], error: null, dir: undefined, configured: false, asked: true, savingDir: false, adopting: '', notice: null },
      /** The user's own create flow: what to start from, and where it should go. */
      create: { open: false, source: 'blank', placement: 'dock-right', busy: false, dirInput: undefined },
      /**
       * The manifest form, shared by adopting a copied-in folder and editing an existing
       * project: `existing` decides whether it creates or saves over one.
       */
      adopt: { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false },
      listeners: new Set(),
      revision: 0,
      theme: 'light',
    };

    function bump() {
      state.revision += 1;
      for (const listener of [...state.listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[dsh-htmlui] store listener failed', error);
        }
      }
    }

    function subscribe(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    }

    const getRevision = () => state.revision;

    function useStore() {
      useSyncExternalStore(subscribe, getRevision, getRevision);
    }

    function addToSession(sessionId, uiId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      const bucket = state.bySession.get(sessionId) ?? new Set();
      bucket.add(uiId);
      state.bySession.set(sessionId, bucket);
    }

    function removeFromSession(sessionId, uiId) {
      const bucket = state.bySession.get(sessionId);
      if (bucket === undefined) return;
      bucket.delete(uiId);
      if (bucket.size === 0) state.bySession.delete(sessionId);
    }

    /** Equality for the fields a surface actually renders. */
    function sameRecord(a, b) {
      if (a === undefined || b === undefined) return false;
      return (
        a.uiId === b.uiId &&
        a.sessionId === b.sessionId &&
        a.title === b.title &&
        a.placement === b.placement &&
        a.sizeText === b.sizeText &&
        a.url === b.url &&
        a.revision === b.revision &&
        a.bytes === b.bytes
      );
    }

    /**
     * Publish a record into the store.
     *
     * `fromHost` marks an answer that came from the plugin's own carrier
     * (`/ui/list`, a ticket, an applied template). Everything else is a tool card in
     * the transcript — and a card keeps its `meta` forever, so it will happily
     * republish a record the host has already dropped: a closed interface came back
     * from its card, an emptied right-column tab reopened, and its frame asked for a
     * ticket that no longer existed. Once a session has been synced with the host,
     * the host is the authority on which ids exist.
     */
    /** Ids whose existence this page has already put to the host once. */
    const askedAbout = new Set();

    /**
     * Ask the host to settle one id's existence. A tool card may carry an interface
     * the last snapshot predates, and it may also be a card whose record the host has
     * dropped; only the host can tell those apart, so the question is asked once and
     * the answer arrives as a convergence.
     */
    function askTheHost(sessionId, uiId) {
      const key = `${sessionId}\u0000${uiId}`;
      if (askedAbout.has(key)) return;
      askedAbout.add(key);
      setTimeout(() => {
        syncSession(sessionId, { force: true });
      }, 120);
    }

    /** Records a card announced before its session had a host answer, by session. */
    const heldRecords = new Map();
    /** The most a session may hold while waiting; a transcript cannot exceed it much. */
    const MAX_HELD_PER_SESSION = 32;

    function holdForHostAnswer(sessionId, record) {
      const uiId = String(record.uiId ?? '');
      let held = heldRecords.get(sessionId);
      if (held === undefined) {
        held = new Map();
        heldRecords.set(sessionId, held);
      }
      if (!held.has(uiId) && held.size >= MAX_HELD_PER_SESSION) return;
      held.set(uiId, record);
    }

    /**
     * Settle what the cards announced: the host's list decides, exactly as it does for a
     * card that arrives after a sync. Asked once per record, and never twice.
     */
    function settleHeld(sessionId) {
      const held = heldRecords.get(sessionId);
      if (held === undefined) return;
      heldRecords.delete(sessionId);
      const listed = state.hostListed.get(sessionId);
      for (const [uiId, record] of held) {
        if (listed !== undefined && listed.has(uiId)) publish(record, { fromHost: true });
      }
    }

    function publish(record, options) {
      if (record === null || typeof record !== 'object') return;
      const uiId = String(record.uiId ?? '');
      if (uiId.length === 0) return;
      if (state.dismissed.has(uiId)) return;
      const fromHost = options !== undefined && options.fromHost === true;
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
      if (
        !fromHost &&
        sessionId !== undefined &&
        !state.hostSynced.has(sessionId) &&
        state.hostSyncing.has(sessionId)
      ) {
        // A reload rebuilds the whole transcript, so every tool card of every earlier
        // turn mounts again and republishes its record — while the first list answer for
        // that session is still in flight. Publishing then would put a page back into
        // the column for a record the host may no longer have. These wait instead, and
        // the answer decides. (A card that slips in before the ask even starts is
        // retired by the convergence that follows, so the column never keeps it.)
        holdForHostAnswer(sessionId, record);
        return;
      }
      if (!fromHost && sessionId !== undefined && state.hostSynced.has(sessionId)) {
        const listed = state.hostListed.get(sessionId);
        const syncedAt = state.hostSyncedAt.get(sessionId) ?? 0;
        const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : undefined;
        // A record created after that snapshot cannot be in it, so a new interface
        // still shows the moment its card lands.
        const knownNew = createdAt !== undefined && createdAt > syncedAt;
        if (!knownNew && listed !== undefined && !listed.has(uiId)) {
          // The snapshot may simply be older than this interface (a tool result does
          // not have to carry a timestamp), so ask again rather than guess. The host's
          // answer decides, and it arrives through the normal convergence. Asking once
          // per id is what keeps a record the host dropped from coming back.
          askTheHost(sessionId, uiId);
          return;
        }
      }
      const previous = state.byId.get(uiId);
      const next = Object.assign({}, previous, record, { uiId });
      // Republishing an identical record must not notify: a component effect that
      // republishes would otherwise re-render itself forever.
      if (sameRecord(previous, next)) return;
      state.byId.set(uiId, next);
      if (previous === undefined || previous.sessionId !== record.sessionId) {
        if (previous !== undefined) removeFromSession(previous.sessionId, uiId);
        addToSession(record.sessionId, uiId);
      }
      if (
        previous === undefined ||
        previous.revision !== record.revision ||
        previous.placement !== record.placement ||
        previous.url !== record.url
      ) {
        state.tickets.delete(uiId);
      }
      syncRightPane();
      bump();
    }

    function retire(uiId, sessionId) {
      const record = state.byId.get(uiId);
      state.byId.delete(uiId);
      state.tickets.delete(uiId);
      state.collapsed.delete(uiId);
      state.fullscreenDismissed.delete(uiId);
      state.inlineHosted.delete(uiId);
      state.inlineSeats.delete(uiId);
      state.inlineHeights.delete(uiId);
      removeFromSession(sessionId ?? record?.sessionId, uiId);
      if (state.fullscreen === uiId) state.fullscreen = null;
      syncRightPane();
      bump();
    }

    /** Forget a dismissal once the host no longer lists the record at all. */
    function forgetDismissal(uiId) {
      state.dismissed.delete(uiId);
    }

    /**
     * Which record owns the fullscreen layer. An explicit choice wins; otherwise
     * the session's first fullscreen-placed record the user has not switched away
     * from, so a newly attached interface opens by itself while "switch back to
     * chat" keeps the one it just closed closed.
     */
    function activeFullscreen(records) {
      if (typeof state.fullscreen === 'string') {
        const pinned = records.find((record) => record.uiId === state.fullscreen);
        if (pinned !== undefined) return pinned;
      }
      return records.find(
        (record) => record.placement === 'fullscreen' && !state.fullscreenDismissed.has(record.uiId),
      );
    }

    function recordsFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
      const ids = state.bySession.get(sessionId);
      if (ids === undefined) return [];
      const out = [];
      for (const id of ids) {
        const record = state.byId.get(id);
        if (record !== undefined) out.push(record);
      }
      out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      return out;
    }

    function recordsIn(sessionId, placements) {
      return recordsFor(sessionId).filter((record) => placements.includes(record.placement));
    }

    /**
     * Converge one session's surfaces on the host's answer: publish what it
     * reports, and drop local records it no longer knows about (closed from
     * another page, or removed by the model).
     */
    function convergeSession(sessionId, uis) {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || !Array.isArray(uis)) return;
      const seen = new Set();
      for (const record of uis) {
        seen.add(String(record.uiId ?? ''));
        publish(record, { fromHost: true });
      }
      // From here on this session knows what exists, so a transcript card can no
      // longer reintroduce what the host has dropped.
      state.hostListed.set(sessionId, seen);
      state.hostSynced.add(sessionId);
      state.hostSyncedAt.set(sessionId, Date.now());
      // Whatever cards announced while this answer was in flight is settled now: the
      // list above is the only thing that can bring a record back.
      settleHeld(sessionId);
      for (const known of recordsFor(sessionId)) {
        if (!seen.has(known.uiId)) retire(known.uiId, sessionId);
      }
      // A dismissal ends when the host stops listing the id: from then on a record
      // with that id is a new interface the user has not closed.
      for (const uiId of state.dismissed) {
        if (!seen.has(uiId)) forgetDismissal(uiId);
      }
      syncRightPane();
    }

    /** How long one session's list answer is shared between the seats that ask. */
    const SESSION_SYNC_TTL_MS = 2_000;

    /**
     * Pull the session's stored records, so a reloaded page rebuilds surfaces whose
     * originating tool call has scrolled out of the transcript. Five seats ask for
     * the same answer at the same moment on every page load, so they share one
     * request; `force` bypasses the share for an explicit refresh.
     */
    function syncSession(sessionId, options) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return Promise.resolve();
      const force = options !== undefined && options.force === true;
      const cached = state.sessionSync.get(sessionId);
      const now = Date.now();
      if (!force && cached !== undefined && now - cached.at < SESSION_SYNC_TTL_MS) return cached.promise;
      // While this answer is in flight, a transcript card may not claim a seat from a
      // record the host could have dropped: it waits, and the answer decides.
      state.hostSyncing.add(sessionId);
      const promise = postJson('/ui/list', { sessionId })
        .then((value) => {
          if (value !== null && value.ok === true) convergeSession(sessionId, value.uis);
          return value;
        })
        .finally(() => {
          state.hostSyncing.delete(sessionId);
        });
      state.sessionSync.set(sessionId, { at: now, promise });
      return promise;
    }

    function useSessionSync(sessionId) {
      useEffect(() => {
        if (sessionId === undefined) return undefined;
        let cancelled = false;
        syncSession(sessionId).then((value) => {
          if (cancelled) return undefined;
          return value;
        });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);
    }

    /**
     * The right column is usable only when both halves are there: the tab type is
     * registered, and a controller can actually open it. Anything less leaves a
     * dock-right interface with no seat, so the fallback has to hold.
     */
    function rightPaneReady() {
      return state.rightPane.available === true && typeof state.rightPane.controller?.openTab === 'function';
    }

    /**
     * Reveal the right-sidebar tab that hosts this session's dock-right interfaces.
     * Returns false when the column exposes no tab service, in which case the
     * caller keeps its fallback (the composer dock).
     */
    function openRightPane(uiId) {
      const controller = state.rightPane.controller;
      if (controller === undefined || typeof controller.openTab !== 'function') return false;
      try {
        controller.openTab(TAB_KIND, { params: { uiId, source: '@mostkia/dsh-htmlui' } });
        if (typeof uiId === 'string' && uiId.length > 0) state.rightPane.opened.add(uiId);
        return true;
      } catch (error) {
        logWarn(undefined, '[dsh-htmlui] right pane refused the tab', error);
        return false;
      }
    }

    // ----------------------------------------------------------------- helpers

    function parseSizeText(value) {
      if (value === null || value === undefined) return undefined;
      if (typeof value === 'object') {
        const out = {};
        if (Number.isFinite(value.w ?? value.width)) out.w = Number(value.w ?? value.width);
        if (Number.isFinite(value.h ?? value.height)) out.h = Number(value.h ?? value.height);
        if (Number.isFinite(value.x ?? value.left)) out.x = Number(value.x ?? value.left);
        if (Number.isFinite(value.y ?? value.top)) out.y = Number(value.y ?? value.top);
        return Object.keys(out).length === 0 ? undefined : out;
      }
      const text = String(value).trim().toLowerCase().replace(/\s+/gu, '');
      const match = /^(\d{2,6})?(?:x(\d{2,6}))?(?:\+(-?\d{1,6}))?(?:\+(-?\d{1,6}))?$/u.exec(text);
      if (match === null || match[0].length === 0) return undefined;
      const out = {};
      if (match[1] !== undefined) out.w = Number(match[1]);
      if (match[2] !== undefined) out.h = Number(match[2]);
      if (match[3] !== undefined) out.x = Number(match[3]);
      if (match[4] !== undefined) out.y = Number(match[4]);
      return Object.keys(out).length === 0 ? undefined : out;
    }

    /**
     * Keep a floating window inside what the reader can actually see and reach.
     *
     * A window that opens wider or taller than the viewport — the 520×360 default on a phone, or a
     * `size` the model picked while looking at a desktop — puts its own resize handle past the
     * edge of the screen, and then the one control that could bring it back is the one that cannot
     * be touched. So the geometry is fitted wherever it is set, not only where it is drawn: the
     * window can still be moved and resized afterwards, it just cannot end up bigger than the view
     * it is drawn in.
     *
     * A geometry that already fits comes back untouched, which is every desktop case: this only
     * ever shrinks something that would not have fitted anyway.
     */
    const FLOAT_MARGIN = 8;
    /** The smallest a window may be: below this it holds no readable interface. */
    const FLOAT_MIN_W = 240;
    const FLOAT_MIN_H = 160;

    function fitFloat(rect) {
      const viewW = typeof window === 'object' && Number.isFinite(window?.innerWidth) && window.innerWidth > 0 ? Math.round(window.innerWidth) : undefined;
      const viewH = typeof window === 'object' && Number.isFinite(window?.innerHeight) && window.innerHeight > 0 ? Math.round(window.innerHeight) : undefined;
      if (viewW === undefined || viewH === undefined) return rect;
      const maxW = Math.max(FLOAT_MIN_W, viewW - FLOAT_MARGIN * 2);
      const maxH = Math.max(FLOAT_MIN_H, viewH - FLOAT_MARGIN * 2);
      const w = Math.min(maxW, Math.max(FLOAT_MIN_W, Number.isFinite(rect?.w) && rect.w > 0 ? Math.round(rect.w) : maxW));
      const h = Math.min(maxH, Math.max(FLOAT_MIN_H, Number.isFinite(rect?.h) && rect.h > 0 ? Math.round(rect.h) : maxH));
      // The window may be placed anywhere from the margin to the last position at which its far
      // edge — and with it the resize handle — is still on screen.
      const spanX = Math.max(FLOAT_MARGIN, viewW - w - FLOAT_MARGIN);
      const spanY = Math.max(FLOAT_MARGIN, viewH - h - FLOAT_MARGIN);
      const x = Math.min(spanX, Math.max(FLOAT_MARGIN, Number.isFinite(rect?.x) ? Math.round(rect.x) : FLOAT_MARGIN));
      const y = Math.min(spanY, Math.max(FLOAT_MARGIN, Number.isFinite(rect?.y) ? Math.round(rect.y) : FLOAT_MARGIN));
      return Object.assign({}, rect, { w, h, x, y });
    }

    function newNonce() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch {
        /* fall through */
      }
      return `n-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function readTheme() {
      try {
        const body = document.body;
        if (body !== null && body !== undefined) {
          if (body.hasAttribute('data-ds-dark-theme')) return 'dark';
          const value = body.getAttribute('data-theme');
          if (value === 'dark') return 'dark';
        }
        const root = document.documentElement;
        if (root !== null && root !== undefined) {
          if (root.getAttribute('data-ds-dark-theme') !== null) return 'dark';
          if (root.classList !== undefined && root.classList.contains('dark')) return 'dark';
        }
      } catch {
        /* keep the default */
      }
      return 'light';
    }

    /** Prefer the host logger when the caller has a context; the console is the fallback. */
    function logWarn(ctx, message, error) {
      const detail = error === undefined || error === null ? '' : `: ${error.message ?? String(error)}`;
      if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`${message}${detail}`);
        return;
      }
      if (error === undefined) console.warn(message);
      else console.warn(message, error);
    }

    function postJson(path, body) {
      return fetch(ROUTE_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then((response) => response.json())
        .catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
    }

    function ensureTicket(uiId, theme) {
      // The URL is not theme-specific. A frame's theme travels over the init and
      // theme messages, so a theme switch must not mint a new URL: changing `src`
      // reloads the document and throws away everything the interface holds
      // (form input, scroll position, a chart's own state).
      const cached = state.tickets.get(uiId);
      if (cached !== undefined) return Promise.resolve(cached.url);
      return postJson('/ui/ticket', { uiId, theme }).then((value) => {
        if (value === null || value.ok !== true || typeof value.url !== 'string') return undefined;
        state.tickets.set(uiId, { url: value.url });
        if (value.ui !== undefined) publish(value.ui, { fromHost: true });
        return value.url;
      });
    }

    function resolveViewedSessionId(ctx) {
      try {
        const list = ctx.sessions?.list;
        if (list === undefined) return undefined;
        const snapshot = typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined;
        if (snapshot === undefined || snapshot === null) return undefined;
        if (typeof snapshot.current === 'string' && snapshot.current.length > 0) return snapshot.current;
        const byId = snapshot.byId ?? {};
        for (const key of Object.keys(byId)) {
          const entry = byId[key];
          if (entry !== undefined && entry !== null && entry.retainedBy !== undefined && entry.retainedBy.mainView > 0) {
            return String(entry.id ?? key);
          }
        }
      } catch {
        /* an unfamiliar session snapshot shape simply yields no session */
      }
      return undefined;
    }

    function sessionIdOf(props) {
      const session = props?.session;
      if (session !== undefined && session !== null) {
        if (typeof session.id === 'string') return session.id;
        if (session.sessionId !== undefined) return String(session.sessionId);
      }
      if (typeof props?.sessionId === 'string') return props.sessionId;
      return undefined;
    }

    /**
     * The session a surface belongs to: the owner's own props first, then the session
     * the user is looking at. A seat that hands no session (the input zones do not
     * always carry one) must not silently render nothing — that is exactly how a
     * docked interface disappeared while the overlay and the drawer stayed alive.
     */
    function resolveSessionId(props) {
      return sessionIdOf(props) ?? resolveViewedSessionId(props?.ctx);
    }

    /**
     * Whether a tool card still carries the current document for its id. After an
     * `op=update` the earlier card in the transcript would otherwise keep a second
     * live copy of the same interface on screen.
     */
    function isCurrentRevision(uiId, revision) {
      const known = state.byId.get(uiId);
      if (known === undefined) return true;
      return (known.revision ?? 1) <= (revision ?? 1);
    }

    function argsOf(block) {
      if (block === null || block === undefined || typeof block !== 'object') return undefined;
      const raw = block.arguments ?? block.args;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      if (raw !== null && typeof raw === 'object') return raw;
      return undefined;
    }

    function metaOf(block) {
      if (block === null || block === undefined || typeof block !== 'object') return undefined;
      const meta = block.meta ?? block.presentationMeta ?? block.resultMeta;
      return meta !== null && typeof meta === 'object' ? meta : undefined;
    }

    function recordFromMeta(meta, fallbackSessionId) {
      if (meta === null || meta === undefined || meta.htmlui !== true) return undefined;
      if (typeof meta.uiId !== 'string' || meta.uiId.length === 0) return undefined;
      return {
        uiId: meta.uiId,
        sessionId: typeof meta.sessionId === 'string' && meta.sessionId.length > 0 ? meta.sessionId : fallbackSessionId,
        title: typeof meta.title === 'string' ? meta.title : '',
        placement: typeof meta.placement === 'string' && meta.placement.length > 0 ? meta.placement : 'inline',
        sizeText: typeof meta.size === 'string' ? meta.size : '',
        // Which project this interface came from; the session page shows it in
        // parentheses beside the title.
        template: typeof meta.template === 'string' && meta.template.length > 0 ? meta.template : undefined,
        // The level the interface was created with, which decides its sandbox.
        security: typeof meta.security === 'string' && meta.security.length > 0 ? meta.security : 'strict',
        url: typeof meta.url === 'string' ? meta.url : undefined,
        revision: Number.isFinite(meta.revision) ? meta.revision : 1,
        bytes: Number.isFinite(meta.bytes) ? meta.bytes : 0,
        createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : undefined,
        updatedAt: Date.now(),
      };
    }

    // ---------------------------------------------------------------- messages

    /**
     * Visible text, resolved through the Client locale service when one is present
     * (`ctx.get("locale")`, the documented optional access). The English literal in
     * each call is the fallback, so the surfaces read correctly with no locale
     * service, during startup, and for a locale this plugin does not carry.
     */
    const LOCALE_NS = '@mostkia/dsh-htmlui';
    const MESSAGES = {
      en: {
        close: 'Close',
        open: 'Open',
        openInRight: 'Open in the right column',
        superseded: '· this revision was replaced; the interface is in the newest card below',
        placed: 'placed: ',
        fullscreenSuffix: '· fullscreen',
        backToChat: 'Back to chat',
        inlineAtTail: 'inline · shown at the end of this turn',
        templatesButton: '⟨+⟩ New HTML',
        templatesTooltip: 'New HTML interface, or reuse a saved template',
        templatesTitle: 'New or reuse',
        apply: 'Apply',
        applyHint: 'Apply to this session (no model round trip)',
        toModel: 'Ask the model',
        toModelHint: 'Put the instruction in the composer instead',
        collapse: 'Hide',
        managerView: 'HTML manager',
        managerTitle: 'HTML interfaces in this session',
        managerClose: 'Close interface',
      managerRestoreUi: 'Restore interface',
      managerRestoreUiHint: 'Open this project again in this session',
      managerRestoreUiDone: 'Interface restored.',
      managerRestoreUiFailed: 'Could not restore that interface.',
        closeFailed: 'The host refused to remove it; it is still attached.',
        managerRestore: 'Show',
        managerHidden: 'hidden',
        minimize: 'Hide the window',
        managerCloseAll: 'Close all interfaces',
        managerEmpty: 'This session has no HTML interface.',
        managerNew: 'New HTML project',
        create: 'Create',
        creating: 'Creating…',
        createTitle: 'New HTML interface',
        createHint: 'Nothing here goes through the model; the interface is created in this session right away.',
        createSource: 'New HTML project',
        createDirPlaceholder: 'No directory chosen yet',
        createDirBrowse: 'Browse…',
        createDirBrowseHint: 'Choose the folder with the system file browser',
        createDirNoPicker: 'This build cannot open a folder picker; type the path instead.',
        createDirSave: 'Use this directory',
        createDirUnset: 'No directory yet: choose the folder that holds your HTML projects.',
        dirSaved: 'Saved. The list is re-read immediately — no restart needed for this.',
        dirNeedsRestart: 'The setting did not reach the host: restart dsh and try again.',
        candidatesTitle: 'Not projects yet',
        candidatesHint: 'These are in the directory but carry no project manifest. Adopt one and it becomes a template you can create from.',
        candidateDir: 'folder',
        candidateFile: 'file',
        candidateAdopt: 'Adopt',
        adoptTitle: 'Project details for',
        adoptSlug: 'Process ID',
        adoptSlugHint: 'lowercase letters, digits, dot, dash, underscore',
        adoptName: 'Project name',
        adoptDescription: 'Details',
        adoptPlacement: 'Where it opens',
        adoptSecurity: 'Security level',
      adoptBackend: 'Run this project’s backend',
      adoptBackendHint: 'Its server.js runs inside the DSH process with this plugin’s privileges — as trusted as the plugin itself.',
      adoptBackendNone: 'No backend here: a server.js in the project folder, named by “backend” in meta.json, is what offers one.',
      // 常驻 reads as a second decision about the same backend: first whether it may run at
      // all, then whether it survives the panel. Both are about the same process, so both
      // live in the same form, and the hint names every way to stop it.
      residentSwitch: 'Resident',
      residentHint: 'Checked: once loaded it is not unloaded when idle, so it keeps running after the panel closes. To stop it, use Stop backend in its manager row or its project row, or uncheck this switch — either unloads it right away.',
      backendBadge: 'Backend',
      managerBackends: 'Backend processes',
      managerBackendsHint: 'still running, with no interface of theirs left in this session',
      backendResident: 'Resident',
      backendFollow: 'Follows the panel',
      backendResidentHint: 'Stays up after the panel closes',
      backendFollowHint: 'Unloads a while after the panel closes',
      backendLoaded: 'Loaded',
      backendIdle: 'Not loaded',
      backendAllowed: 'Allowed',
      backendDenied: 'Not allowed',
      stopBackend: 'Stop backend',
      stopBackendHint: 'Projects with a backend: Stop backend ends the process only — it does not withdraw permission, and opening its panel again loads it again.',
      managerBackendHint: 'Hiding or removing an interface does not stop its backend. A resident one keeps running until you press Stop backend.',
      backendStopDone: 'Stopped the {slug} backend; opening that panel again loads it again.',
      backendStopIdle: 'The {slug} backend was not running.',
      backendStopFailed: 'The host did not stop it; the backend may still be running.',
        securityStrict: 'Strict (default)',
        securityLocal: 'Own files only',
        securityOpen: 'Own files + network',
        securityUnsafe: 'Unrestricted (unsafe)',
        securityHint_strict: 'One document, no external files, no network: what this plugin has always done.',
        securityHint_local: 'The project’s own folder is served beside the document: app.js, css, images and fonts load from it.',
        securityHint_open: 'Also allows https/http/ws: CDN scripts, external stylesheets, API calls and sockets.',
        securityHint_unsafe: 'Also drops the sandbox’s origin isolation, so the document can reach this DSH page and everything in it. Only for HTML you wrote yourself.',
        adoptHint: 'Nothing is written yet: fill this in and the project is created with it.',
        adoptConfirm: 'Write the manifest',
        editTitle: 'Edit project details',
        editHint: 'These details are saved over the project’s manifest.',
        editConfirm: 'Save changes',
        editProject: 'Edit this project’s details',
        adopted: 'It is a project now.',
        edited: 'Saved.',
        createPlacement: 'Where',
        placementDockRight: 'Right column (a real split)',
        placementInline: 'In the conversation',
        placementFloat: 'Floating window',
        placementFullscreen: 'Fullscreen',
        placementBackground: 'Background layer',
        placementBackgroundHint: 'Full-screen and always on screen, in every view, at 25% opacity so the interface stays readable. Close it from the session page when you are done.',
        cancel: 'Cancel',
        createMore: 'More template actions',
        buildTagHint: 'The browser half this page is running',
        newBlank: 'Blank canvas',
        newBlankHint: 'Start an empty interface in the right column (no model round trip)',
        newBlankDescription: 'An empty space in the right column, to fill as you like',
        newTitle: 'New',
        expand: 'Show',
        surfaceError: 'This HTML UI surface failed to render',
        retry: 'Retry',
        resizeHandle: 'Resize the panel',
        bundled: 'bundled',
        loading: 'Reading templates…',
        empty: 'No templates yet: have the model save one with html_ui_template, or drop your own .html into the templates directory.',
        catalogueUnavailable: 'Template catalogue unavailable',
        frameUnavailable: 'This interface could not be loaded',
        draft: 'Render the template {slug} with html_ui',
      },
      zh: {
        close: '关闭',
        open: '打开',
        openInRight: '在右侧栏打开',
        superseded: '· 这一版已被更新，界面在下方最新卡片里',
        placed: '已投放到 ',
        fullscreenSuffix: '· 全覆盖模式',
        backToChat: '切回聊天',
        inlineAtTail: '内联 · 显示在本轮末尾',
        templatesButton: '⟨+⟩ 新建 HTML',
        templatesTooltip: '新建 HTML 界面，或复用已保存的模板',
        templatesTitle: '新建 / 复用',
        apply: '套用',
        applyHint: '套用到当前会话（不经过模型）',
        toModel: '交给模型',
        toModelHint: '把指令放进输入框，交给模型',
        collapse: '收起',
        managerView: 'HTML管理器',
        managerTitle: '本会话的 HTML 界面',
        managerClose: '关闭 UI 界面',
        managerRestoreUi: '恢复 UI 界面',
        managerRestoreUiHint: '在本会话里重新打开这个项目',
        managerRestoreUiDone: '界面已恢复。',
        managerRestoreUiFailed: '界面恢复失败。',
        closeFailed: '宿主拒绝移除，这个界面仍然挂着。',
        managerRestore: '恢复显示',
        managerHidden: '已隐藏',
        minimize: '隐藏窗口',
        managerCloseAll: '关闭全部 UI 界面',
        managerEmpty: '本会话没有 HTML 界面。',
        managerNew: '新建 HTML 项目',
        create: '创建',
        creating: '正在创建…',
        createTitle: '新建 HTML 界面',
        createHint: '整个过程不经过模型：界面会立刻在本会话里建好。',
        createSource: '新建HTML项目',
        createDirPlaceholder: '还没有选择目录',
        createDirBrowse: '浏览…',
        createDirBrowseHint: '用系统文件浏览器选择文件夹',
        createDirNoPicker: '这个构建打不开文件夹选择器，请手动输入路径。',
        createDirSave: '使用这个目录',
        createDirUnset: '还没有目录：请选择存放你的 HTML 项目的文件夹。',
        dirSaved: '已保存，列表会立刻重新读取 —— 这一项不需要重启。',
        dirNeedsRestart: '设置没能到达宿主：请冷启动 dsh 后再试。',
        candidatesTitle: '尚未登记为项目',
        candidatesHint: '这些东西已经在目录里，但缺少项目清单（meta.json）。点"设为项目"即可成为可用的模板。',
        candidateDir: '文件夹',
        candidateFile: '文件',
        candidateAdopt: '设为项目',
        adoptTitle: '补全项目信息：',
        adoptSlug: '进程ID',
        adoptSlugHint: '仅支持小写英文数字或._-',
        adoptName: '项目名称',
        adoptDescription: '详细描述',
        adoptPlacement: '默认生成位置',
        adoptSecurity: '安全等级',
        adoptBackend: '允许该项目的后台代码运行',
        adoptBackendHint: '项目目录里的 server.js 会在 DSH 进程内运行，权限与本插件相同——等于完全信任它。',
        adoptBackendNone: '该项目没有后台：在项目目录放一个 server.js，并在 meta.json 里用 backend 字段指认它。',
        residentSwitch: '常驻',
        residentHint: '勾上：加载后不参与空闲卸载，关掉面板也会继续跑。想停它：用管理器行或项目行里的「停止后台」，或取消勾选这个开关 —— 两者都会当场卸载。',
        backendBadge: '带后台',
        managerBackends: '后台进程',
        managerBackendsHint: '仍在运行，本会话里已经没有它的界面了',
        backendResident: '常驻',
        backendFollow: '跟随面板',
        backendResidentHint: '关掉面板也不会停',
        backendFollowHint: '关掉面板一会儿后会自动卸载',
        backendLoaded: '已加载',
        backendIdle: '未加载',
        backendAllowed: '已授权',
        backendDenied: '未授权',
        stopBackend: '停止后台',
        stopBackendHint: '带后台的项目：「停止后台」只结束这个进程，不撤销授权；下次打开它的面板会重新加载。',
        managerBackendHint: '隐藏或移除界面不等于停止后台：常驻的后台要按「停止后台」才会停。',
        backendStopDone: '已停止 {slug} 的后台；再打开该面板会重新加载它。',
        backendStopIdle: '{slug} 的后台没有在跑。',
        backendStopFailed: '宿主没有停止它，后台可能还在跑。',
        securityStrict: '严格（默认）',
        securityLocal: '允许自身文件',
        securityOpen: '自身文件 + 允许联网',
        securityUnsafe: '不限制（不安全）',
        securityHint_strict: '单个文档：不加载外部文件、不联网 —— 插件一直以来的行为。',
        securityHint_local: '把项目自己的文件夹作为静态资源提供：app.js、css、图片、字体都能按相对路径加载。',
        securityHint_open: '在上一级基础上放开 https/http/ws：可用 CDN 脚本、外部样式表、调用 API 与 WebSocket。',
        securityHint_unsafe: '额外去掉沙箱的源隔离，文档脚本可以访问这个 DSH 页面本身。只对你自己写的 HTML 使用。',
        adoptHint: '此时还没有写入任何东西：填完后点下面的按钮，才会带着这些信息创建项目。',
        adoptConfirm: '写入清单',
        editTitle: '编辑项目信息',
        editHint: '这些信息会覆盖写入该项目的清单文件。',
        editConfirm: '保存修改',
        editProject: '编辑这个项目的信息',
        adopted: '已成为项目。',
        edited: '已保存。',
        createPlacement: '生成位置',
        placementDockRight: '右侧栏（真正的左右分屏）',
        placementInline: '对话流内',
        placementFloat: '浮动窗',
        placementFullscreen: '全屏',
        placementBackground: '背景层',
        placementBackgroundHint: '全屏常驻：切到任何视图它都在屏幕上，为保持界面可读固定为 25% 不透明度；用完请到「HTML管理器」里关闭它。',
        cancel: '取消',
        createMore: '更多模板操作',
        buildTagHint: '当前页面运行的浏览器半部版本',
        newBlank: '空白画布',
        newBlankHint: '在右侧栏新建一块空白界面（不经过模型）',
        newBlankDescription: '右侧栏里的空白空间，随你填什么',
        newTitle: '新建',
        expand: '展开',
        surfaceError: '这个 HTML UI 表面渲染失败',
        retry: '重试',
        resizeHandle: '调整面板高度',
        bundled: '自带',
        loading: '正在读取模板…',
        empty: '还没有模板：让模型用 html_ui_template 存一个，或把你的 .html 放进模板目录。',
        catalogueUnavailable: '模板目录不可用',
        frameUnavailable: '这个界面加载失败',
        draft: '用 html_ui 渲染模板 {slug}',
      },
    };
    /** Bound once the locale service is reached; null means "literal fallback only". */
    let translateRef = null;
    /** The locale service itself, so the active language can be read directly. */
    let localeRef = null;

    /**
     * The language the page is actually in.
     *
     * A host locale id is not something to guess: registering a dictionary under `zh`
     * while the column's locale says `zh-CN` silently falls back to English, which is
     * how a Chinese session ends up reading English labels. Reading the active language
     * and choosing our own table by its leading tag makes the mismatch impossible.
     */
    function activeLanguage() {
      try {
        const snapshot = localeRef?.getLocale?.();
        const active = snapshot?.active ?? snapshot?.locale ?? snapshot?.id;
        if (typeof active === 'string' && active.length > 0) return active;
      } catch (error) {
        /* a snapshot that refuses is not fatal */
      }
      const declared = typeof document === 'object' && document !== null && document.documentElement !== null ? document.documentElement.lang : undefined;
      if (typeof declared === 'string' && declared.length > 0) return declared;
      return 'en';
    }

    /** Our own dictionary for the active language, matched on the leading tag. */
    function ownDictionary() {
      const active = activeLanguage();
      const exact = MESSAGES[active];
      if (exact !== undefined) return exact;
      const leading = String(active).split('-')[0];
      return MESSAGES[leading];
    }

    /**
     * Resolve one message, in this order: the host's bound dictionary, then our own
     * table for the active language, then the caller's literal.
     */
    function tr(key, fallback, params) {
      let text = fallback;
      if (translateRef !== null) {
        try {
          const value = translateRef(key);
          if (typeof value === 'string' && value.length > 0 && value !== key) text = value;
        } catch (error) {
          /* a broken dictionary must not break a render */
        }
      }
      if (text === fallback) {
        const own = ownDictionary();
        const value = own === undefined ? undefined : own[key];
        if (typeof value === 'string' && value.length > 0) text = value;
      }
      if (params !== undefined) {
        for (const [name, replacement] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(replacement));
        }
      }
      return text;
    }

    /**
     * The same slug rule the host applies, so the value shown in the adopt form is the
     * one that will actually be written.
     */
    function slugifyClient(value) {
      const text = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^[^a-z0-9]+/u, '')
        .replace(/[-._]+$/u, '')
        .slice(0, 64);
      return text;
    }

    // ---------------------------------------------------------------- templates

    /** Load the catalogue the host keeps, so the drawer can offer it. */
    function loadTemplates() {
      return postJson('/templates', {}).then((value) => {
        if (value !== null && value.ok === true && Array.isArray(value.templates)) {
          state.templates.items = value.templates;
          state.templates.candidates = Array.isArray(value.candidates) ? value.candidates : [];
          state.templates.error = null;
          // The directory travels with the catalogue: the page shows where the list came
          // from instead of leaving the reader to guess, and knows whether to ask.
          state.templates.dir = typeof value.dir === 'string' && value.dir.length > 0 ? value.dir : undefined;
          state.templates.configured = value.configured === true;
          state.templates.asked = value.asked === true;
        } else {
          state.templates.error = (value !== null && value.error) || 'unavailable';
        }
        state.templates.loaded = true;
        // Stamped for the one reader that has to know how old this is: the manager asks for a
        // fresh catalogue when this reading is too old to say whether a backend is still running.
        state.templates.loadedAt = Date.now();
        bump();
        return state.templates.items;
      });
    }

    /**
     * The backend facts one catalogue row carries, in the shape the UI reads.
     *
     * A host that predates the field simply has none, and a project that declares no backend
     * gets `undefined`: every mark keys off `declared`, so an old payload draws nothing rather
     * than claiming a backend that is not there.
     */
    function backendInfoOf(template) {
      const backend = template === null || template === undefined ? undefined : template.backend;
      if (backend === null || backend === undefined || typeof backend !== 'object') return undefined;
      return {
        declared: backend.declared === true,
        allowed: backend.allowed === true,
        resident: backend.resident === true,
        loaded: backend.loaded === true,
      };
    }

    /** One project by slug: what a session record's `template` field points at. */
    function templateBySlug(slug) {
      if (typeof slug !== 'string' || slug.length === 0) return undefined;
      const items = Array.isArray(state.templates.items) ? state.templates.items : [];
      for (const item of items) {
        if (item !== null && item !== undefined && item.slug === slug) return item;
      }
      return undefined;
    }

    /** The age past which the catalogue in hand is not trusted about a running process. */
    const BACKEND_CATALOGUE_FRESH_MS = 30000;

    /**
     * Whether the catalogue in hand can answer the backend questions on the manager page.
     *
     * Two ways it cannot: a host that answered before the field existed, and a reading old
     * enough that a backend stopped since then would still be drawn as running. The result is
     * asked for once per mount — a request per render would ask the host on every keystroke.
     */
    function backendCatalogueStale() {
      if (state.templates.loaded !== true) return true;
      const at = state.templates.loadedAt;
      if (typeof at !== 'number' || !Number.isFinite(at) || Date.now() - at > BACKEND_CATALOGUE_FRESH_MS) return true;
      const items = Array.isArray(state.templates.items) ? state.templates.items : [];
      return items.length > 0 && !items.some((item) => item !== null && item !== undefined && item.backend !== undefined);
    }

    /**
     * Stop one project's backend process.
     *
     * Only the process: the permission and the project's own rules are untouched, which is why
     * this sits beside the switches instead of replacing them — a reader who wants it gone for
     * good turns the permission off, and the host unloads on the spot for that too. Returns the
     * line to show, so both callers say the same thing about the same act.
     */
    function stopBackend(slug) {
      if (typeof slug !== 'string' || slug.length === 0) return Promise.resolve(null);
      return postJson('/templates/backend/stop', { slug }).then((value) => {
        if (value === null || value.ok !== true) {
          return { ok: false, slug, message: tr('backendStopFailed', 'The host did not stop it; the backend may still be running.') };
        }
        const message =
          value.stopped === true
            ? tr('backendStopDone', 'Stopped the {slug} backend; opening that panel again loads it again.', { slug })
            : tr('backendStopIdle', 'The {slug} backend was not running.', { slug });
        // The catalogue is the only thing on this page that says "loaded", so it is re-read
        // before the answer is shown: the row behind the message has to agree with it.
        return loadTemplates().then(() => ({ ok: true, slug, stopped: value.stopped === true, message }));
      });
    }

    /**
     * Point the catalogue at a directory of the reader's own.
     *
     * The host validates the path — a typo would otherwise look exactly like a directory
     * with no templates in it — and the catalogue is re-read straight away, so the list
     * in front of the reader is the list that directory holds.
     */
    function saveTemplatesDir(dir) {
      state.templates.savingDir = true;
      state.templates.notice = null;
      bump();
      return postJson('/templates/dir', { dir: typeof dir === 'string' ? dir : '' })
        .then((value) => {
          state.templates.savingDir = false;
          if (value === null || value.ok !== true) {
            state.templates.error = (value !== null && value.error) || 'failed';
            // The honest wording: a directory change is read live, so a failure here
            // means the running host predates the route — which a restart fixes.
            state.templates.notice = tr('dirNeedsRestart', 'The setting did not reach the host: restart dsh and try again.');
            bump();
            return false;
          }
          state.templates.dir = typeof value.dir === 'string' && value.dir.length > 0 ? value.dir : undefined;
          state.templates.configured = value.configured === true;
          state.templates.error = null;
          state.templates.notice = tr('dirSaved', 'Saved. The list is re-read immediately — no restart needed for this.');
          return loadTemplates().then(() => true);
        })
        .catch(() => {
          state.templates.savingDir = false;
          state.templates.error = 'failed';
          state.templates.notice = tr('dirNeedsRestart', 'The setting did not reach the host: restart dsh and try again.');
          bump();
          return false;
        });
    }

    /**
     * Adopt one thing the reader copied into the directory.
     *
     * The host gives it the manifest that makes it a project — that is the step a copied
     * file is missing, and why it looked like it never arrived. The manifest is the one
     * the reader filled in: this function is the only place it is sent, so a dropped
     * argument here means the form was written for nothing.
     */
    function adoptTemplate(name, manifest, allowBackend, resident) {
      state.adopt.busy = true;
      state.templates.adopting = typeof name === 'string' ? name : '';
      bump();
      return postJson('/templates/adopt', { name, meta: manifest })
        .then((value) => {
          state.adopt.busy = false;
          state.templates.adopting = '';
          if (value === null || value.ok !== true) {
            state.templates.error = (value !== null && value.error) || 'failed';
            bump();
            return false;
          }
          state.templates.error = null;
          // An edit says so: "it is a project now" would be false for one that already was.
          state.templates.notice =
            state.adopt.existing === true ? tr('edited', 'Saved.') : tr('adopted', 'It is a project now.');
          // The allowance is stored against the project id — which for something just adopted is
          // the id the form wrote, not the folder name it was adopted from. A refusal here is
          // not fatal to the manifest that was just written.
          const slug = typeof value.slug === 'string' && value.slug.length > 0 ? value.slug : state.adopt.slug;
          // `resident` travels only when the form actually offered it: a project whose backend is
          // not declared has nothing to keep resident, and sending a setting for it would leave a
          // rule in the host that no declaration backs. `allowed` keeps its old rule — sent only
          // when the choice was on screen, so a project without a backend is never approved by
          // accident — and it is left out entirely when the caller chose nothing, because an
          // absent field is not a refusal and must not become one.
          const settings = { slug };
          if (allowBackend !== undefined) settings.allowed = allowBackend === true;
          if (resident !== undefined) settings.resident = resident === true;
          const asked = allowBackend === undefined && resident === undefined ? Promise.resolve(true) : postJson('/templates/backend', settings).then(() => true, () => false);
          state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false };
          return asked.then(() => loadTemplates()).then(() => true);
        })
        .catch(() => {
          state.adopt.busy = false;
          state.templates.adopting = '';
          state.templates.error = 'failed';
          bump();
          return false;
        });
    }

    /** Tell the host the question has been put, so it is asked once and not every load. */
    function markTemplatesAsked() {
      if (state.templates.asked === true) return Promise.resolve(false);
      state.templates.asked = true;
      return postJson('/templates/dir', { asked: true }).then(() => true, () => false);
    }

    function toggleTemplates() {
      state.templates.open = state.templates.open !== true;
      bump();
      if (state.templates.open && !state.templates.loaded) loadTemplates();
      return state.templates.open;
    }

    /**
     * Apply a template to a session straight from the page: no model round trip,
     * and the returned record is published so every surface picks it up at once.
     *
     * `placement` overrides what the document declares, which is what lets the create
     * dialog ask where the new interface should go.
     */
    function applyTemplate(slug, sessionId, placement) {
      if (typeof slug !== 'string' || slug.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
        return Promise.resolve(false);
      }
      const body = { template: slug, sessionId };
      if (typeof placement === 'string' && placement.length > 0) body.placement = placement;
      return postJson('/templates/render', body).then((value) => {
        if (value !== null && value.ok === true && value.ui !== undefined) {
          publish(value.ui, { fromHost: true });
          state.templates.error = null;
          return true;
        }
        state.templates.error = (value !== null && value.error) || 'failed';
        bump();
        return false;
      });
    }

    /** Hand a template to the model instead, by putting the instruction in the draft. */
    function askModelForTemplate(slug, sessionId, ctx) {
      if (typeof slug !== 'string' || slug.length === 0) return false;
      try {
        const scoped = ctx?.sessions?.scope?.(sessionId);
        const conversation = scoped?.get?.('conversation');
        const input = conversation?.input?.for?.(scoped);
        if (input === undefined || typeof input.setDraft !== 'function') return false;
        input.setDraft(tr('draft', `Render the template ${slug} with html_ui`, { slug }));
        return true;
      } catch (error) {
        logWarn(ctx, 'dsh-htmlui: could not reach the composer draft', error);
        return false;
      }
    }

    // ------------------------------------------------------------------ styles

    const createOptionStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 6px',
      borderRadius: '7px',
      fontSize: '12px',
      cursor: 'pointer',
    };

    const surfaceChrome = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 6px 4px 10px',
      minHeight: '28px',
      borderBottom: '1px solid var(--dsw-alias-border-l1, #e2e2e2)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02))',
      cursor: 'default',
      userSelect: 'none',
    };

    const titleStyle = {
      flex: '1 1 auto',
      minWidth: '0',
      fontSize: '12px',
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary, #666)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };

    const buttonStyle = {
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '22px',
      minWidth: '22px',
      padding: '0 6px',
      border: '1px solid var(--dsw-alias-border-l1, #ddd)',
      borderRadius: '6px',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: '11px',
      lineHeight: '1',
      cursor: 'pointer',
    };

    /**
     * A chip: the small rounded mark a status reads as. Always a `span` and never a control —
     * a mark that looks like a button is one readers try to press, and the one pressable thing
     * in this family has a label that says what it does.
     */
    const chipStyle = {
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      height: '16px',
      padding: '0 6px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l1, #ddd)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      color: 'var(--dsw-alias-label-secondary, #888)',
      fontSize: '10px',
      lineHeight: '1',
      whiteSpace: 'nowrap',
    };

    /** One chip, so a status reads the same wherever it is shown. */
    function chip(text, key) {
      return h('span', { key, style: chipStyle }, text);
    }

    /** A control that cannot do anything right now: dimmed, and not a pointer. */
    const disabledStyle = { opacity: 0.5, cursor: 'default' };

    /**
     * The backend status of one project, as chips and nothing else.
     */
    /**
     * The backend state of one project, as chips and nothing else.
     *
     * The sentence that used to sit beside them now lives in the residency chip's tooltip: on a
     * phone the small print wrapped onto a second line, which made every row taller than the
     * control it was explaining, and the chips read on their own anyway.
     */
    function backendChips(backend, withPermission) {
      const marks = [];
      // Keys, because these are handed to React as an array: an unkeyed one is a console warning
      // on every render of every row that has a backend.
      if (withPermission === true) {
        marks.push(chip(backend.allowed ? tr('backendAllowed', 'Allowed') : tr('backendDenied', 'Not allowed'), 'allowed'));
      }
      marks.push(
        h(
          'span',
          {
            key: 'resident',
            style: chipStyle,
            title: backend.resident
              ? tr('backendResidentHint', 'Stays up after the panel closes')
              : tr('backendFollowHint', 'Unloads a while after the panel closes'),
          },
          backend.resident ? tr('backendResident', 'Resident') : tr('backendFollow', 'Follows the panel'),
        ),
        chip(backend.loaded ? tr('backendLoaded', 'Loaded') : tr('backendIdle', 'Not loaded'), 'loaded'),
      );
      return marks;
    }

    /** The one control that ends a running backend process. Never a permission change. */
    function stopBackendButton(slug, backend, onDone, extraStyle) {
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, buttonStyle, extraStyle ?? {}, backend.loaded === true ? {} : disabledStyle),
          disabled: backend.loaded !== true,
          title: tr('stopBackendHint', 'Projects with a backend: Stop backend ends the process only — it does not withdraw permission, and opening its panel again loads it again.'),
          'aria-label': `${tr('stopBackend', 'Stop backend')}: ${slug}`,
          onClick: () => {
            stopBackend(slug).then((result) => {
              if (result !== null) onDone(result);
            });
          },
        },
        tr('stopBackend', 'Stop backend'),
      );
    }

    const frameStyle = {
      display: 'block',
      width: '100%',
      height: '100%',
      border: '0',
      background: 'transparent',
    };

    const emptyStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: '80px',
      color: 'var(--dsw-alias-label-secondary, #888)',
      fontSize: '12px',
    };

    /** A visible failure beats an invisible seat. */
    const errorStyle = {
      padding: '8px 10px',
      border: '1px solid var(--dsw-alias-state-error-primary, #c33)',
      borderRadius: '8px',
      color: 'var(--dsw-alias-state-error-primary, #c33)',
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    };

    // -------------------------------------------------------------- inline hosting

    /**
     * The height an inline document asks for.
     *
     * One function for both halves of the arrangement: the hosted frame renders at this height,
     * and the transcript seat holds exactly the same space, so the conversation lays out as if
     * the document were still a child of it.
     */
    function inlineHeightOf(measured) {
      return measured !== undefined && Number.isFinite(measured) ? Math.min(INLINE_MAX_HEIGHT, Math.max(60, measured)) : 220;
    }

    /** The scroll container an element lives in: the box that clips and scrolls the transcript. */
    function scrollContainerOf(element) {
      if (element === null || element === undefined) return null;
      if (typeof window !== 'object' || window === null || typeof window.getComputedStyle !== 'function') return null;
      let node = element.parentElement;
      while (node !== null && node !== undefined && node !== document.body) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return node;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Where the transcript's visible band ends.
     *
     * The composer is drawn *over* the transcript — the scroll container reaches under the input
     * box, which is why a hosted document clipped to the container alone covered the input box.
     * The band ends where the composer begins, and the plugin's own seat inside that block says
     * where that is (see `state.composerSeat`); without one, the band simply ends where it did.
     */
    function transcriptBandBottom(fallback) {
      const seat = state.composerSeat;
      const top =
        seat !== null && seat !== undefined && seat.isConnected === true && typeof seat.getBoundingClientRect === 'function'
          ? seat.getBoundingClientRect().top
          : Number.NaN;
      return Number.isFinite(top) && top > 0 ? Math.min(fallback, top) : fallback;
    }

    /**
     * Whether this is a narrow viewport — a phone, or a window squeezed that far.
     *
     * The surfaces this plugin adds beside the composer are sized for a desktop row; below this
     * width the entry collapses to its mark and a dialog becomes a sheet from the bottom, which is
     * the only shape that fits a 390px screen without a magnifying glass.
     */
    function narrowViewport() {
      return (
        typeof window === 'object' &&
        window !== null &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia(`(max-width: ${MOBILE.maxWidthPx}px)`).matches
      );
    }

    /**
     * The hosted boxes, by interface.
     *
     * Each entry is the fixed wrapper the sync loop places; its first child is the frame itself,
     * placed inside it at the seat's offset. The overlay's refs write this map and the loop reads
     * it — never through React, because scrolling must not re-render the page.
     */
    const inlineBoxes = new Map();
    let inlineSyncQueued = false;

    /**
     * Place every hosted inline frame over the seat it belongs to.
     *
     * A hosted frame is a fixed layer clipped to the transcript's own viewport, not a child of
     * the transcript: it scrolls away with its seat instead of floating over the rest of the
     * page, and it is not painted at all while its seat is gone — which is what happens to a
     * Session's seats while another Session is on screen. The frame itself never unmounts, which
     * is the entire point: the document keeps its runtime state through all of it.
     */
    function syncInlineBoxes() {
      for (const [uiId, wrapper] of inlineBoxes) {
        const inner = wrapper.firstElementChild;
        if (inner === null) continue;
        const seat = state.inlineSeats.get(uiId);
        const element = seat === undefined ? undefined : seat.element;
        if (element === undefined || element.isConnected !== true) {
          // No seat on screen: the document stays mounted and simply is not painted.
          if (wrapper.style.display !== 'none') wrapper.style.display = 'none';
          continue;
        }
        const scroller =
          seat.scroller !== null && seat.scroller !== undefined && seat.scroller.isConnected === true
            ? seat.scroller
            : scrollContainerOf(element);
        // With no scroll container of its own the transcript scrolls with the page, and the
        // window is then the box to clip to — bounded by the conversation column, so a fallback
        // never paints over the sidebar either. Guessing wrong the other way — and hiding the
        // document whenever no scroller was found — would make an inline interface disappear for
        // a layout this does not recognize, which is far worse.
        const raw = scroller === null || scroller === undefined ? null : scroller.getBoundingClientRect();
        const columnKnown = state.column.width > 0;
        const left = raw !== null ? raw.left : columnKnown ? state.column.left : 0;
        const width = raw !== null ? raw.width : columnKnown ? state.column.width : window.innerWidth;
        const top = raw !== null ? raw.top : 0;
        const height = Math.max(0, transcriptBandBottom(raw !== null ? raw.top + raw.height : window.innerHeight) - top);
        const at = element.getBoundingClientRect();
        if (wrapper.style.display !== 'block') wrapper.style.display = 'block';
        wrapper.style.position = 'fixed';
        wrapper.style.left = `${Math.round(left)}px`;
        wrapper.style.top = `${Math.round(top)}px`;
        wrapper.style.width = `${Math.round(width)}px`;
        wrapper.style.height = `${Math.round(height)}px`;
        wrapper.style.overflow = 'hidden';
        wrapper.style.pointerEvents = 'none';
        inner.style.position = 'absolute';
        inner.style.left = `${Math.round(at.left - left)}px`;
        inner.style.top = `${Math.round(at.top - top)}px`;
        inner.style.width = `${Math.round(at.width)}px`;
        inner.style.height = `${Math.round(at.height)}px`;
        inner.style.pointerEvents = 'auto';
      }
    }

    /**
     * Scroll the conversation for a hosted document that could not take the wheel itself.
     *
     * The document's bridge forwards the wheel only when nothing inside it could scroll, so this
     * restores what the interface did before it was hosted: the document keeps its own scrolling
     * and the transcript takes everything else. Scrolling past the end of the transcript goes on
     * to the page, which is the same chain the frame had when it was a child of the transcript.
     */
    function scrollTranscriptBy(uiId, dx, dy) {
      const seat = state.inlineSeats.get(uiId);
      const element = seat === undefined ? undefined : seat.element;
      const known = seat === undefined ? undefined : seat.scroller;
      // A wheel can arrive before any scroll has taught us which box scrolls this seat, so the
      // ancestors are walked once more rather than falling straight through to the page.
      const scroller =
        known !== null && known !== undefined && known.isConnected === true
          ? known
          : element !== undefined && element !== null && element.isConnected === true
            ? scrollContainerOf(element)
            : undefined;
      const move = (target) => {
        if (target === null || target === undefined) return false;
        const beforeTop = target.scrollTop;
        const beforeLeft = target.scrollLeft;
        if (Number.isFinite(dy) && dy !== 0) target.scrollTop = beforeTop + dy;
        if (Number.isFinite(dx) && dx !== 0) target.scrollLeft = beforeLeft + dx;
        return target.scrollTop !== beforeTop || target.scrollLeft !== beforeLeft;
      };
      if (move(scroller)) return;
      const page = document.scrollingElement;
      if (page === null || page === undefined || page === scroller) return;
      move(page);
    }

    /** Place the hosted frames again, at most once per animation frame. */
    function scheduleInlineSync() {
      if (inlineSyncQueued) return;
      inlineSyncQueued = true;
      const run = () => {
        inlineSyncQueued = false;
        syncInlineBoxes();
      };
      if (typeof window === 'object' && window !== null && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
      else if (typeof setTimeout === 'function') setTimeout(run, 16);
    }

    /**
     * Bind an inline interface to the seat it occupies in the transcript.
     *
     * The first claim is what starts hosting it: from then on the overlay owns the frame and this
     * element only says where it belongs. Losing the seat — a Session switch, a turn scrolled out
     * of the virtualized transcript — hides the frame and never destroys it.
     */
    function claimInlineSeat(uiId, element) {
      const known = state.inlineSeats.get(uiId);
      if (known !== undefined && known.element === element) {
        scheduleInlineSync();
        return;
      }
      state.inlineSeats.set(uiId, { element, scroller: scrollContainerOf(element) });
      if (!state.inlineHosted.has(uiId)) {
        state.inlineHosted.add(uiId);
        bump();
      }
      scheduleInlineSync();
    }

    /** The seat is gone; the hosted frame is hidden until another one claims it. */
    function releaseInlineSeat(uiId) {
      state.inlineSeats.delete(uiId);
      scheduleInlineSync();
    }

    // ---------------------------------------------------------------- surfaces

    /** The frame plus, for every variant but `background`, a slim host chrome row. */
    function HtmlUiFrame(props) {
      const { record, theme, variant, bare } = props;
      const [url, setUrl] = useState(undefined);
      const [status, setStatus] = useState('loading');
      const [attempt, setAttempt] = useState(0);
      const [contentHeight, setContentHeight] = useState(undefined);
      const frameRef = useRef(null);
      const nonceRef = useRef(newNonce());
      const urlRef = useRef(undefined);
      const initial = props.initialSize ?? parseSizeText(record.sizeText) ?? {};
      const [size, setSize] = useState(() => {
        if (variant === 'float') {
          // A reader's own placement outlives the mount: hiding a window unmounts it, and
          // coming back to the declared corner instead of where it was left reads as a
          // window that forgot. The remembered geometry is used first, the declared size
          // second, and the default last.
          const remembered = state.geometry.get(record.uiId);
          return fitFloat({
            w: remembered?.w ?? initial.w ?? DEFAULT_FLOAT.w,
            h: remembered?.h ?? initial.h ?? DEFAULT_FLOAT.h,
            x: remembered?.x ?? initial.x ?? DEFAULT_FLOAT.x,
            y: remembered?.y ?? initial.y ?? DEFAULT_FLOAT.y,
          });
        }
        return { w: initial.w, h: initial.h };
      });

      // Remember every move and resize for as long as the page lives.
      useEffect(() => {
        if (variant !== 'float') return undefined;
        state.geometry.set(record.uiId, Object.assign({}, size));
        return undefined;
      }, [variant, record.uiId, size.w, size.h, size.x, size.y]);

      // A mount means React recreated this frame, which reloads the document and loses
      // whatever it held; a URL change logs separately, just below. Between them the
      // console names the mechanism instead of leaving it to inference.
      useEffect(() => {
        if (DEBUG_FRAMES === true) console.debug('[dsh-htmlui] frame mounted', record.uiId);
        return () => {
          if (DEBUG_FRAMES === true) console.debug('[dsh-htmlui] frame unmounted', record.uiId);
        };
      }, []);

      useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        ensureTicket(record.uiId, theme).then((next) => {
          if (cancelled) return;
          if (typeof next !== 'string') {
            setStatus('error');
            return;
          }
          // A frame whose URL changes reloads the document and loses whatever it held.
          // Saying so in the console is how a reload is told apart from a remount (a
          // remount logs nothing here, because this ref starts empty again).
          if (urlRef.current !== undefined && urlRef.current !== next) {
            console.debug('[dsh-htmlui] reloading the document', record.uiId, 'revision', record.revision);
          }
          urlRef.current = next;
          setUrl(next);
        });
        return () => {
          cancelled = true;
        };
      }, [record.uiId, record.revision, record.placement, attempt]);

      const handshake = useCallback(() => {
        const frame = frameRef.current;
        if (frame === null || frame.contentWindow === null) return;
        try {
          frame.contentWindow.postMessage({ __dshHtmlUi: 'init', nonce: nonceRef.current, theme }, '*');
        } catch {
          /* the frame is mid-navigation */
        }
      }, [theme]);

      useEffect(() => {
        if (url === undefined) return undefined;
        handshake();
        return undefined;
      }, [url, handshake]);

      useEffect(() => {
        function onMessage(event) {
          const frame = frameRef.current;
          if (frame === null || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (data === null || typeof data !== 'object' || data.__dshHtmlUi === undefined) return;
          // The document is allowed to speak before it has been told the nonce. A frame
          // that finishes loading first measures itself and reports its height with no
          // nonce yet; dropping that report left the surface at its fallback height with
          // a scrollbar, which is the very bug the measurement exists to prevent. The
          // source check above already establishes that the message came from this frame,
          // and a static document never measures twice, so this one report is the only
          // chance to learn how tall it is.
          const allowedBeforeHandshake = data.__dshHtmlUi === 'content' || data.__dshHtmlUi === 'ready';
          if (data.nonce !== nonceRef.current && !allowedBeforeHandshake) return;
          if (data.__dshHtmlUi === 'ready') setStatus('ready');
          if (data.__dshHtmlUi === 'close') props.onDismiss?.(record.uiId);
          // A hosted inline document cannot chain its wheel to the transcript any more (it is no
          // longer a descendant of it), so its bridge forwards what it could not use and this
          // scrolls the conversation with it. Other forms are overlays, where a wheel over them
          // has never moved the chat behind them.
          if (data.__dshHtmlUi === 'wheel' && variant === 'inline') {
            scrollTranscriptBy(record.uiId, Number(data.deltaX), Number(data.deltaY));
          }
          // A finger cannot chain the way a wheel can: a touch the document cannot use stops at the
          // frame, so the bridge forwards it — sampled in screen coordinates, because the hosted
          // frame follows its seat while the host scrolls — and this scrolls the conversation.
          if (data.__dshHtmlUi === 'touch' && variant === 'inline') {
            scrollTranscriptBy(record.uiId, Number(data.deltaX), Number(data.deltaY));
          }
          if (data.__dshHtmlUi === 'resize') {
            const next = parseSizeText(data.size);
            if (next !== undefined) setSize((current) => fitFloat(Object.assign({}, current, next)));
          }
          if (data.__dshHtmlUi === 'content') {
            // The document measured itself. An iframe never grows to its content, and a
            // surface meant to blend into the transcript must not show a scrollbar for
            // a few lines of content.
            const height = Number(data.height);
            if (Number.isFinite(height) && height > 0) setContentHeight(Math.round(height));
          }
        }
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [record.uiId, props.onDismiss, variant]);

      // An inline document is hosted by the overlay (`HtmlUiInlineHost`, through the seat the
      // transcript keeps for it), so its height has to be published: the seat holds exactly that
      // much space, and the two must agree or the conversation would lay out around a gap.
      useEffect(() => {
        if (variant !== 'inline') return undefined;
        const height = inlineHeightOf(contentHeight ?? initial.h);
        if (state.inlineHeights.get(record.uiId) === height) return undefined;
        state.inlineHeights.set(record.uiId, height);
        bump();
        return undefined;
      }, [variant, record.uiId, contentHeight, initial.h]);

      const dragRef = useRef(null);
      const onPointerDown = useCallback(
        (event) => {
          if (variant !== 'float' || event.button !== 0) return;
          // A control inside the grip keeps its own click, whatever else is draggable.
          const target = event.target;
          if (target !== event.currentTarget && typeof target?.closest === 'function' && target.closest('button') !== null) return;
          dragRef.current = { dx: event.clientX - (size.x ?? 0), dy: event.clientY - (size.y ?? 0) };
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* unsupported capture is not fatal */
            }
          }
          event.preventDefault();
        },
        [size.x, size.y, variant],
      );

      const onPointerMove = useCallback(
        (event) => {
          const drag = dragRef.current;
          if (drag === null || drag === undefined) return;
          const x = Math.max(0, event.clientX - drag.dx);
          const y = Math.max(0, event.clientY - drag.dy);
          setSize((current) => fitFloat(Object.assign({}, current, { x, y })));
        },
        [],
      );

      const onPointerUp = useCallback(() => {
        dragRef.current = null;
      }, []);

      const resizeRef = useRef(null);
      const onResizeDown = useCallback(
        (event) => {
          if (event.button !== 0) return;
          resizeRef.current = { w: size.w ?? DEFAULT_FLOAT.w, h: size.h ?? DEFAULT_FLOAT.h, x: event.clientX, y: event.clientY };
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* unsupported capture is not fatal */
            }
          }
          event.preventDefault();
          event.stopPropagation();
        },
        [size.w, size.h],
      );

      const onResizeMove = useCallback((event) => {
        const start = resizeRef.current;
        if (start === null || start === undefined) return;
        const w = Math.max(240, start.w + (event.clientX - start.x));
        const h = Math.max(160, start.h + (event.clientY - start.y));
        setSize((current) => fitFloat(Object.assign({}, current, { w, h })));
      }, []);

      const onResizeUp = useCallback(() => {
        resizeRef.current = null;
      }, []);

      const body = useMemo(() => {
        if (status === 'error') {
          // A ticket can legitimately fail once (rate limited, or the interface was
          // closed in another tab). Without a way back the surface would stay broken
          // until the page is reloaded, so the failure is recoverable.
          return h(
            'div',
            { style: Object.assign({}, emptyStyle, { display: 'flex', alignItems: 'center', gap: '8px' }) },
            h('span', null, tr('frameUnavailable', 'This interface could not be loaded')),
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                onClick: () => {
                  state.tickets.delete(record.uiId);
                  setStatus('loading');
                  setAttempt((current) => current + 1);
                },
              },
              tr('retry', 'Retry'),
            ),
          );
        }
        if (url === undefined) {
          return h('div', { style: emptyStyle }, 'Preparing interface…');
        }
        return h('iframe', {
          ref: frameRef,
          src: url,
          title: record.title !== undefined && record.title.length > 0 ? record.title : `HTML UI ${record.uiId}`,
          sandbox: sandboxFor(record.security),
          referrerPolicy: 'no-referrer',
          allow: 'clipboard-write',
          onLoad: handshake,
          style: frameStyle,
        });
      }, [url, status, record.uiId, record.title, handshake, attempt]);

      if (variant === 'float') {
        const w = size.w ?? DEFAULT_FLOAT.w;
        const hh = size.h ?? DEFAULT_FLOAT.h;
        return h(
          'div',
          {
            style: {
              position: 'fixed',
              left: `${size.x ?? DEFAULT_FLOAT.x}px`,
              top: `${size.y ?? DEFAULT_FLOAT.y}px`,
              width: `${w}px`,
              height: `${hh}px`,
              display: 'flex',
              flexDirection: 'column',
              pointerEvents: 'auto',
              borderRadius: '10px',
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l2, #ccc)',
              background: 'var(--dsw-alias-bg-overlay, #fff)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
              // The last window touched is drawn on top of the others, which is what a
              // click on a floating window is normally asking for.
              zIndex: 2 + (state.floatZ.get(record.uiId) ?? 0),
            },
            onPointerDownCapture: () => raiseFloat(record.uiId),
          },
          h(
            'div',
            { style: Object.assign({}, surfaceChrome) },
            h(
              'span',
              {
                style: Object.assign({}, titleStyle, {
                  flex: '1 1 auto',
                  // The grip is the title, not the row. Dragging from the row took a
                  // pointer capture over the whole header, and a captured row swallows
                  // the click its own buttons need: the ✕ never fired.
                  cursor: 'grab',
                  touchAction: 'none',
                }),
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel: onPointerUp,
              },
              `${record.title !== undefined && record.title.length > 0 ? record.title : record.uiId} · float`,
            ),
            // Minimizing hides the window without deleting it: the session page can bring
            // it back, which is the difference between "out of the way" and "gone".
            props.onMinimize !== undefined
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: buttonStyle,
                    onClick: () => props.onMinimize(record.uiId),
                    title: tr('minimize', 'Hide the window'),
                    'aria-label': tr('minimize', 'Hide the window'),
                  },
                  '—',
                )
              : null,
            props.onDismiss !== undefined
              ? h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => props.onDismiss(record.uiId),
                  title: tr('close', 'Close'),
                  'aria-label': tr('close', 'Close'),
                },
                '✕',
              )
              : null,
          ),
          h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', background: 'var(--dsw-alias-bg-base, #fff)' } }, body),
          h('div', {
            style: {
              position: 'absolute',
              right: '0',
              bottom: '0',
              width: '16px',
              height: '16px',
              cursor: 'nwse-resize',
              touchAction: 'none',
              background:
                'linear-gradient(135deg, transparent 0 50%, var(--dsw-alias-border-l2, #bbb) 50% 60%, transparent 60% 70%, var(--dsw-alias-border-l2, #bbb) 70% 80%, transparent 80%)',
            },
            onPointerDown: onResizeDown,
            onPointerMove: onResizeMove,
            onPointerUp: onResizeUp,
            role: 'separator',
            tabIndex: 0,
            'aria-label': tr('resizeHandle', 'Resize the panel'),
            onKeyDown: (event) => {
              const dx = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
              const dy = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0;
              if (dx === 0 && dy === 0) return;
              event.preventDefault();
              setSize((current) =>
                fitFloat({
                  w: Math.max(240, (current.w ?? DEFAULT_FLOAT.w) + dx),
                  h: Math.max(160, (current.h ?? DEFAULT_FLOAT.h) + dy),
                  x: current.x,
                  y: current.y,
                }),
              );
            },
            onPointerCancel: onResizeUp,
          }),
        );
      }

      if (variant === 'background') {
        // A background layer is decoration: no chrome, and nothing to click.
        return h('div', { style: { width: '100%', height: '100%' } }, body);
      }

      if (variant === 'inline') {
        // Seamless by design: no chrome, no border, no background, and the height is
        // whatever the document measured for itself (capped, so a very long document
        // scrolls rather than swallowing the transcript). It reads as part of the
        // conversation, not as a window parked in it — even though the fixed host layer,
        // clipped to the transcript's own viewport, is what draws it.
        const height = inlineHeightOf(contentHeight ?? initial.h);
        return h(
          'div',
          {
            style: {
              width: '100%',
              height: `${height}px`,
              minHeight: '0',
              overflow: 'hidden',
              background: 'transparent',
            },
          },
          h('div', { style: { width: '100%', height: '100%' } }, body),
        );
      }

      const height = '100%';
      // A seat that draws its own chrome (the fullscreen layer) asks for the document
      // alone; otherwise the surface shows two title rows, one from each.
      if (bare === true) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height,
              minHeight: '0',
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-base, #fff)',
            },
          },
          h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, body),
        );
      }
      // A docked split is seamless: the surface is meant to be one half of the session
      // view, not a window inside it. No title row, no border, no opaque background —
      // but the collapse and close controls stay, as a faint cluster in the corner.
      if (variant === 'dock') {
        const control = (label, hint, onClick, extra) =>
          h(
            'button',
            Object.assign(
              {
                type: 'button',
                style: Object.assign({}, buttonStyle, { padding: '1px 6px', fontSize: '11px' }),
                onClick,
                title: hint,
                'aria-label': hint,
              },
              extra ?? {},
            ),
            label,
          );
        const controls = [
          props.onToggleCollapse !== undefined
            ? control(
                props.collapsed === true ? '▸' : '▾',
                props.collapsed === true ? tr('expand', 'Show') : tr('collapse', 'Hide'),
                () => props.onToggleCollapse(record.uiId),
                { 'aria-expanded': props.collapsed === true ? 'false' : 'true' },
              )
            : null,
          props.onDismiss !== undefined ? control('✕', tr('close', 'Close'), () => props.onDismiss(record.uiId)) : null,
        ];
        if (props.collapsed === true) {
          // Collapsed: just the controls, on their own line, so the split gives the
          // whole height back to the conversation.
          return h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '2px', padding: '2px 4px' } }, ...controls);
        }
        return h(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              minHeight: '0',
              overflow: 'hidden',
              background: 'transparent',
            },
          },
          h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, body),
          h(
            'div',
            {
              style: {
                position: 'absolute',
                top: '2px',
                right: '4px',
                display: 'flex',
                gap: '2px',
                opacity: 0.35,
                transition: 'opacity .15s ease',
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.opacity = '1';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.opacity = '0.35';
              },
            },
            ...controls,
          ),
        );
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: typeof height === 'number' ? `${height}px` : height,
            minHeight: variant === 'dock' ? `${DOCK_MIN_HEIGHT}px` : undefined,
            border: '1px solid var(--dsw-alias-border-l1, #ddd)',
            borderRadius: '10px',
            overflow: 'hidden',
            background: 'var(--dsw-alias-bg-base, #fff)',
          },
        },
        h(
          'div',
          { style: surfaceChrome },
          h(
            'span',
            { style: titleStyle },
            `${record.title !== undefined && record.title.length > 0 ? record.title : record.uiId} · ${record.placement}`,
          ),
          props.onToggleCollapse !== undefined
            ? h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => props.onToggleCollapse(record.uiId),
                  title: props.collapsed === true ? tr('expand', 'Show') : tr('collapse', 'Hide'),
                  // The glyph alone is the accessible name without this.
                  'aria-label': props.collapsed === true ? tr('expand', 'Show') : tr('collapse', 'Hide'),
                  'aria-expanded': props.collapsed === true ? 'false' : 'true',
                },
                props.collapsed === true ? '▸' : '▾',
              )
            : null,
          props.onDismiss !== undefined
            ? h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => props.onDismiss(record.uiId),
                  title: tr('close', 'Close'),
                  'aria-label': tr('close', 'Close'),
                },
                '✕',
              )
            : null,
        ),
        props.collapsed === true
          ? null
          : h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, body),
      );
    }

    // --------------------------------------------------------------- tool card

    /**
     * Contained rendering. One surface failing must not take its whole seat down,
     * and a seat that renders nothing is invisible — which is exactly how a docked
     * interface disappeared during acceptance. The failure becomes a line the user
     * can report instead of silence.
     */
    // Real React always has Component; resolving it through a fallback keeps the
    // module loadable in a test harness that only fakes createElement.
    const ReactComponent = typeof React.Component === 'function' ? React.Component : function Component() {};

    class HtmlUiBoundary extends ReactComponent {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        logWarn(this.props.ctx, 'dsh-htmlui: a surface failed to render', error);
      }

      render() {
        if (this.state.error !== null) {
          const detail = String((this.state.error && this.state.error.message) || this.state.error);
          return h('div', { style: errorStyle }, `${tr('surfaceError', 'This HTML UI surface failed to render')}: ${detail}`);
        }
        return h(React.Fragment, null, this.props.children);
      }
    }

    /**
     * Which turn made each interface, over the transcript this page has materialized.
     *
     * A turn's own chat nodes are the authority. A Tool row is a `tool-call` Node whose
     * `data.root` is the tool block itself; the block carrying the host's answer is a
     * `tool-result`, and the presentation meta *on that block* — not the result text, which is
     * the human-readable ack (`ui_id=…`) — names the interface and says what the call did.
     * Only a *render* counts: an update, a list, or a close that happens to name the id must
     * not claim it, or the turn that merely mentioned an interface would draw a copy of it.
     *
     * The answer is one index over the whole transcript, because the question is "did any turn
     * *make* this interface?": a per-turn scan cannot tell a template the reader applied from a
     * template a call rendered, and treating the second as the first is what would draw it
     * twice. Every tail asks the same question of the same node set, so the scan is memoized by
     * that set's own array identity.
     */
    let renderCallMemo = { order: undefined, made: new Map() };

    /** Collect one tool block's render call and, recursively, those of its sub-calls. */
    function collectRenderCalls(block, turn, made) {
      if (block === null || typeof block !== 'object') return;
      if (block.kind === 'tool-result') {
        const meta = block.meta;
        if (
          meta !== null &&
          meta !== undefined &&
          typeof meta === 'object' &&
          meta.htmlui === true &&
          meta.op === 'render' &&
          typeof meta.uiId === 'string' &&
          meta.uiId.length > 0
        ) {
          made.set(meta.uiId, turn);
        }
      }
      const subCalls = block.subCalls;
      if (Array.isArray(subCalls)) for (const sub of subCalls) collectRenderCalls(sub, turn, made);
    }

    function renderCallsIn(order, nodes) {
      if (renderCallMemo.order === order) return renderCallMemo.made;
      const made = new Map();
      if (Array.isArray(order) && nodes !== undefined && typeof nodes.get === 'function') {
        for (const key of order) {
          const node = nodes.get(key);
          if (node === null || node === undefined || node.kind !== 'tool-call') continue;
          const location = node.location;
          const turn = location === null || location === undefined || location.turn === undefined ? undefined : location.turn.turn;
          if (!Number.isFinite(turn)) continue;
          collectRenderCalls(node.data === null || node.data === undefined ? undefined : node.data.root, turn, made);
        }
      }
      renderCallMemo = { order, made };
      return made;
    }

    /**
     * The turn an interface made outside any tool call belongs to.
     *
     * A template applied from the drawer is made by the reader, not by a call, so no turn's
     * nodes name it. Its home is where the conversation stood when it was made: the last turn
     * that had already closed. That is the seat the reader is looking at when they press Apply,
     * the interface appears there at once, and — unlike "the newest turn", which is what an
     * earlier revision used — it does not move when the next answer lands. It stays in the
     * transcript and scrolls up with it, like anything else in the conversation.
     *
     * A record older than every loaded turn (the window can open mid-conversation) has no
     * loaded seat of its own, so the first loaded turn is the honest approximation; that keeps
     * it on screen instead of dropping it.
     */
    function turnOwningRecord(createdAt, timeline) {
      if (timeline === null || timeline === undefined) return undefined;
      const order = Array.isArray(timeline.turnOrder) ? timeline.turnOrder : [];
      if (order.length === 0) return undefined;
      // A record with no readable creation time is read as "just now": the newest closed turn
      // is where a reader who just applied something is looking.
      const madeAt = Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY;
      const turns = timeline.turns;
      let owner;
      for (const turn of order) {
        const location = turns !== undefined && typeof turns.get === 'function' ? turns.get(turn) : undefined;
        const end = location === null || location === undefined ? undefined : location.end;
        const closedAt = end !== null && end !== undefined && Number.isFinite(end.time) ? end.time : undefined;
        if (closedAt !== undefined && closedAt <= madeAt) owner = turn;
      }
      return owner === undefined ? order[0] : owner;
    }

    /** Wrap one registered component in that boundary. */
    function guarded(ctx, Component) {
      return function GuardedSurface(props) {
        return h(HtmlUiBoundary, { ctx }, h(Component, props));
      };
    }

    /**
     * The transcript's seat for one inline interface.
     *
     * It holds the space the document occupies and nothing else. The document itself is drawn by
     * the overlay, because a frame living here is destroyed every time the product rebuilds the
     * transcript — a Session switch, or a turn scrolling out of the virtualized window — and the
     * interface would come back empty. The height comes from the frame (`HtmlUiFrame`), so the
     * seat and the document always agree on how much room it takes.
     */
    function InlineSeat(props) {
      useStore();
      const { record } = props;
      const height = state.inlineHeights.get(record.uiId) ?? inlineHeightOf(undefined);
      const bind = useCallback(
        (element) => {
          if (element === null) releaseInlineSeat(record.uiId);
          else claimInlineSeat(record.uiId, element);
        },
        [record.uiId],
      );
      return h('div', {
        ref: bind,
        'data-htmlui-inline-seat': record.uiId,
        style: { width: '100%', height: `${height}px`, minHeight: '0' },
      });
    }

    /**
     * The hosted inline document itself.
     *
     * A fixed wrapper, clipped to the transcript's own viewport, with the frame placed at its
     * seat's offset inside it; the sync loop writes both. It is rendered from the overlay — a
     * frame-wide seat — so leaving the Session hides it rather than unmounting it, which is what
     * keeps the document's runtime state.
     */
    function HtmlUiInlineHost(props) {
      const { record } = props;
      const bind = useCallback(
        (element) => {
          if (element === null) {
            inlineBoxes.delete(record.uiId);
            return;
          }
          inlineBoxes.set(record.uiId, element);
          scheduleInlineSync();
        },
        [record.uiId],
      );
      return h(
        'div',
        {
          ref: bind,
          'data-htmlui-inline-host': record.uiId,
          // Below the background layer (z-index 1) so a dimmed frame dims this too, and below the
          // floats and the fullscreen layer, exactly where the transcript itself sits.
          style: { position: 'fixed', left: '0', top: '0', width: '0', height: '0', display: 'none', overflow: 'hidden', pointerEvents: 'none', zIndex: 0 },
        },
        h(
          'div',
          { style: { position: 'absolute' } },
          h(HtmlUiFrame, { record, theme: state.theme, variant: 'inline', onDismiss: dismissRecord }),
        ),
      );
    }

    /**
     * The in-conversation home for `inline` interfaces.
     *
     * The tool call row is where an inline interface belongs contextually, but a GUI
     * may not show tool rows at all (the first live acceptance run found exactly
     * that), which leaves the surface with no visible seat. This slot is the shipped
     * one for in-flow contributions, and every other feature that appends to a turn
     * uses it.
     *
     * A turn tail renders once per turn, so this seat claims exactly the interfaces that belong
     * to *its* turn and nothing else: the ones a render call in this turn made, and the ones
     * the reader applied while the conversation stood here (`turnOwningRecord`). That is what
     * makes an interface behave like the rest of the transcript — it stays where it was put and
     * scrolls up as the conversation grows — instead of appearing again at the bottom of every
     * new turn, which is what electing a "newest tail" while rendering did.
     *
     * What it claims is a seat, not the document: an inline frame is hosted by the overlay
     * (`HtmlUiInlineHost`), because everything under this tail is destroyed whenever the product
     * rebuilds the transcript — switching Session, or scrolling this turn out of the virtualized
     * window — and a hosted document simply stops being painted instead.
     */
    function HtmlUiInlineTail(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      const seq = Number.isFinite(props.seq) ? props.seq : undefined;
      const turnNumber = props.turn !== undefined && Number.isFinite(props.turn.turn) ? props.turn.turn : undefined;
      const useChatHook = typeof props.useChat === 'function' ? props.useChat : undefined;
      // Subscribe to the identity-stable stores, never to a derived array: a selector that
      // mints a new array on every read re-renders forever, which is what happened the last
      // time this was attempted.
      const order = useChatHook === undefined ? undefined : useChatHook((snapshot) => snapshot.order);
      const nodes = useChatHook === undefined ? undefined : useChatHook((snapshot) => snapshot.nodes);
      const timeline = useChatHook === undefined ? undefined : useChatHook((snapshot) => snapshot.timeline);

      // Without a session, a sequence, or the turn this tail closes there is nothing to decide.
      if (sessionId === undefined || seq === undefined || turnNumber === undefined) return null;

      const made = renderCallsIn(order, nodes);
      const records = recordsIn(sessionId, ['inline']).filter((record) => {
        const maker = made.get(record.uiId);
        // Who owns it is decided by exactly one of the two, so one interface is drawn by one
        // tail: nothing here may be adopted a second time by a turn that did not make it.
        return (maker === undefined ? turnOwningRecord(record.createdAt, timeline) : maker) === turnNumber;
      });
      if (records.length === 0) return null;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0', flexShrink: 0 } },
        ...records.map((record) => h(InlineSeat, { key: record.uiId, record })),
      );
    }

    /**
     * Bring one interface back into view, whatever form it is.
     *
     * The forms differ in where they live, not in what "show it again" means, so the
     * session page offers one control and this decides what that takes: the column for
     * a `dock-right` surface, the window for a minimized `float`, the frame for a
     * `fullscreen`, and the conversation itself for an `inline` one.
     */
    function restoreRecord(record, props) {
      if (record.placement === 'dock-right') {
        openRightPane(record.uiId);
        return;
      }
      if (record.placement === 'float') {
        state.hidden.delete(record.uiId);
        bump();
        return;
      }
      if (record.placement === 'fullscreen') {
        state.fullscreen = record.uiId;
        state.fullscreenDismissed.delete(record.uiId);
        bump();
        return;
      }
      if (record.placement === 'inline' && typeof props?.openView === 'function') {
        // An inline surface lives in the conversation, so showing it is going there.
        props.openView('chat', '');
      }
    }

    /**
     * The session's HTML interfaces, listed where the reader already is.
     *
     * A `background` layer is click-through by design and an `inline` one is seamless,
     * so neither offers a control of its own; without this page a user has no way to
     * remove what a model attached. `conversation.view` is the shipped seat for a
     * session-scoped page like this one, and its label is the row it appears in.
     */
    function HtmlUiManager(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      // Stopping a backend answers here, not in the drawer: this page is where the reader
      // pressed the button, and a message anywhere else reads as nothing having happened.
      const [status, setStatus] = useState(null);
      // A project with a resident backend keeps running after its panel is gone, so this page
      // is the only place left that can end it. It can only say whether one is loaded if the
      // catalogue it holds has the backend field and is recent enough, so the one reading this
      // page needs is asked for once per mount. Per render would be a request per keystroke.
      useEffect(() => {
        if (backendCatalogueStale()) loadTemplates();
      }, []);
      const records = sessionId === undefined ? [] : recordsFor(sessionId);
      // The backend a row belongs to: a record built from a path or the blank canvas names no
      // project, and one whose project declares no backend has nothing to say — both draw none
      // of the marks below rather than a row of empty chips.
      const backendOfRecord = (record) => {
        const backend = record.template === undefined ? undefined : backendInfoOf(templateBySlug(record.template));
        return backend !== undefined && backend.declared === true ? backend : undefined;
      };
      const anyBackend = records.some((record) => backendOfRecord(record) !== undefined);
      const rows = records.map((record) => {
        const backend = backendOfRecord(record);
        return h(
          'div',
          {
            key: record.uiId,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              // 手机优先 / 三行一条: a little more air than before, and a light line under each
              // process, so rows that now take three lines do not read as one block.
              padding: '10px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)',
            },
          },
          // 1 · What it is.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: '0' } },
            h(
              'span',
              { style: Object.assign({}, titleStyle, { flex: '1 1 auto', minWidth: '0' }) },
              // 计算器(jsq): the title a reader recognises, then the project it came from, so
              // two interfaces built from the same project are told apart at a glance.
              `${record.title.length > 0 ? record.title : record.uiId}${record.template !== undefined ? `(${record.template})` : ''}`,
            ),
            state.hidden.has(record.uiId)
              ? h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('managerHidden', 'hidden'))
              : null,
          ),
          // 2 · The process itself — where it sits, which revision, which interface — and then its
          // state pushed to the right edge, where the three marks read as one answer.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: '0' } },
            h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, record.placement),
            h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, `r${record.revision}`),
            h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, record.uiId),
            h('span', { style: { flex: '1 1 auto' } }),
            // The project's backend: the state a reader cannot see unless it is said. 常驻 is the
            // whole reason the control below exists — that state outlives the panel.
            backend === undefined
              ? null
              : h(
                  'span',
                  { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
                  chip(tr('backendBadge', 'Backend'), 'badge'),
                  ...backendChips(backend, false),
                ),
          ),
          // 3 · The controls.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
            backend === undefined
              ? null
              : stopBackendButton(record.template, backend, (result) => setStatus(result.message)),
            // Every form that can be out of sight gets the same control, with the same words.
            // Two forms have none: a background layer is always on screen, and an inline
            // surface lives in the conversation and is never hidden — offering "Show" for it
            // was a button that could not do anything. Both are removed with the control
            // beside this one.
            record.placement === 'background' || record.placement === 'inline'
              ? null
              : h(
                  'button',
                  { type: 'button', style: buttonStyle, onClick: () => restoreRecord(record, props) },
                  tr('managerRestore', 'Show'),
                ),
            h('button', { type: 'button', style: buttonStyle, onClick: () => dismissRecord(record.uiId) }, tr('managerClose', 'Remove')),
          ),
        );
      });
      // Loaded backends this page has no interface for. They are what makes 停止后台 a control that
      // must not be attached to a record: the record can be removed while the process keeps running.
      const orphans = (state.templates.items ?? []).filter((template) => {
        const info = backendInfoOf(template);
        if (info === undefined || info.loaded !== true) return false;
        return records.some((record) => record.template === template.slug) !== true;
      });
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', padding: '10px 12px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${tr('managerTitle', 'HTML interfaces in this session')} (${records.length})`),
          // The same create flow the composer control opens. A reader who cannot find a
          // small control beside the composer should not have to hunt for the way in.
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, buttonStyle, { borderColor: 'transparent', background: 'var(--dsw-alias-bg-accent, #247bbf)', color: '#fff' }),
              onClick: () => {
                state.create.open = true;
                state.create.busy = false;
                state.create.dirInput = undefined;
                bump();
                loadTemplates();
              },
            },
            tr('managerNew', 'New HTML project'),
          ),
          records.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => {
                    for (const record of records) dismissRecord(record.uiId);
                  },
                },
                tr('managerCloseAll', 'Remove all'),
              )
            : null,
        ),
        // The distinction this page exists to make, said once where the two controls sit side by
        // side: 隐藏/移除 acts on an interface, 停止后台 acts on a process, and a resident backend
        // is not touched by the first. Shown only when a listed project actually has a backend —
        // a reader with none has nothing to be warned about.
        anyBackend
          ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '6px' } }, tr('managerBackendHint', 'Hiding or removing an interface does not stop its backend. A resident one keeps running until you press Stop backend.'))
          : null,
        status === null
          ? null
          : h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '6px' } }, String(status)),
        records.length === 0
          ? h('div', { style: emptyStyle }, tr('managerEmpty', 'This session has no HTML interface.'))
          : h('div', null, ...rows),
        // A resident backend outlives the interface that started it, so the interface's row cannot be
        // the only place the reader can stop it: removing a panel here — or closing it from anywhere
        // else — would take the one control with it. Projects whose backend is loaded are therefore
        // listed on their own, whether or not this session still has an interface of theirs.
        orphans.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: '12px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' } },
                h('span', { style: titleStyle }, tr('managerBackends', 'Backend processes')),
                h(
                  'span',
                  { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } },
                  tr('managerBackendsHint', 'still running, with no interface of theirs left in this session'),
                ),
              ),
              h(
                'div',
                null,
                ...orphans.map((template) => {
                  const info = backendInfoOf(template);
                  return h(
                    'div',
                    {
                      key: `backend-${template.slug}`,
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        padding: '10px 12px',
                        borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: '0' } },
                      h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto', minWidth: '0' }) }, templateListItem(template)),
                      h('span', { style: { flex: '1 1 auto' } }),
                      chip(tr('backendBadge', 'Backend'), 'badge'),
                      ...backendChips(info, false),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
                      stopBackendButton(template.slug, info, (result) => setStatus(result.message)),
                      // The other half of "closing an interface does not stop its backend": the process
                      // is still there, so its interface can be brought back from here instead of being
                      // hunted down in the drawer. The project's own declared placement is used, which
                      // is what the reader chose when they imported it.
                      h(
                        'button',
                        {
                          type: 'button',
                          style: buttonStyle,
                          title: tr('managerRestoreUiHint', 'Open this project again in this session'),
                          onClick: () => {
                            applyTemplate(template.slug, sessionId, undefined).then((ok) => {
                              setStatus(ok ? tr('managerRestoreUiDone', 'Interface restored.') : tr('managerRestoreUiFailed', 'Could not restore that interface.'));
                            });
                          },
                        },
                        tr('managerRestoreUi', 'Restore interface'),
                      ),
                    ),
                  );
                }),
              ),
            ),
      );
    }

    /**
     * The tool row's own disclosure. The contract makes `useDisclosure` a required
     * owner prop; the guard keeps a slimmer owner from crashing the card. `useState`
     * runs unconditionally so the hook order never changes.
     */
    function useOptionalDisclosure(props) {
      const [state] = useState(null);
      const factory = props.useDisclosure;
      if (typeof factory !== 'function') return state;
      return factory();
    }

    function HtmlUiToolView(props) {
      useStore();
      const { phase, block } = props;
      const args = argsOf(block);
      const meta = metaOf(block);
      const sessionId = typeof meta?.sessionId === 'string' && meta.sessionId.length > 0 ? meta.sessionId : undefined;
      const record = recordFromMeta(meta, sessionId);
      const disclosure = useOptionalDisclosure(props);

      useEffect(() => {
        const next = recordFromMeta(meta, sessionId);
        if (next === undefined) {
          if (meta !== undefined && meta.htmlui === true && meta.op === 'close' && typeof meta.uiId === 'string') {
            retire(meta.uiId);
          }
          return;
        }
        publish(next);
        // Depend on primitives: the host may hand a fresh block object on every
        // render, and an object dependency would republish on each one.
      }, [meta === undefined ? undefined : meta.uiId, meta === undefined ? undefined : meta.revision, meta === undefined ? undefined : meta.op, sessionId]);

      // A dock-right interface lives in the right column: reveal its tab as soon as the
      // column can be opened. Both halves of that — the tab type and the controller —
      // bind asynchronously, so the effect has to re-run when either arrives. Missing
      // the tab type here is what made a dock-right interface invisible: by then the
      // dock had already let go of it, so nothing drew it at all.
      const rightPaneController = state.rightPane.controller;
      const rightPaneTab = state.rightPane.available;
      useEffect(() => {
        if (record === undefined || record.placement !== 'dock-right') return;
        if (state.rightPane.opened.has(record.uiId)) return;
        openRightPane(record.uiId);
      }, [
        record === undefined ? undefined : record.uiId,
        record === undefined ? undefined : record.placement,
        rightPaneController,
        rightPaneTab,
      ]);

      // An inline interface lives *inside this tool row*, and a collapsed row hides it
      // completely: the caller asks for a panel and sees a one-line tool call. Open
      // the row for it, once, without fighting a user who closed it again (the
      // dependency only re-fires when the row is collapsed and a record is present).
      const expanded = disclosure === null || disclosure === undefined ? undefined : disclosure.expanded;
      useEffect(() => {
        if (disclosure === null || disclosure === undefined) return;
        if (record === undefined || record.placement !== 'inline') return;
        if (disclosure.expanded === true) return;
        if (typeof disclosure.setExpanded !== 'function') return;
        disclosure.setExpanded(true);
      }, [expanded, record === undefined ? undefined : record.uiId, record === undefined ? undefined : record.placement]);

      if (phase === 'preparing') {
        return h(
          'div',
          { style: Object.assign({}, surfaceChrome, { border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: '10px' }) },
          h('span', { style: titleStyle }, 'Preparing HTML interface…'),
        );
      }

      if (record === undefined) {
        const placement = typeof args?.placement === 'string' ? args.placement : 'inline';
        const target = typeof args?.path === 'string' ? args.path : typeof args?.title === 'string' ? args.title : '';
        return h(
          'div',
          { style: Object.assign({}, surfaceChrome, { border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: '10px' }) },
          h('span', { style: titleStyle }, `HTML UI · ${placement}${target.length > 0 ? ` · ${target}` : ''}`),
        );
      }

      if (state.byId.get(record.uiId) === undefined) {
        // The publish happens in the effect above; rendering only reads state.
      }
      const placement = record.placement;

      if (placement === 'inline') {
        if (!isCurrentRevision(record.uiId, record.revision)) {
          const known = state.byId.get(record.uiId);
          return h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 10px',
                border: '1px dashed var(--dsw-alias-border-l1, #ddd)',
                borderRadius: '10px',
                color: 'var(--dsw-alias-label-secondary, #888)',
                fontSize: '12px',
              },
            },
            h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${record.title.length > 0 ? record.title : record.uiId} ${tr('superseded', '· this revision was replaced; the interface is in the newest card below')}`),
            known === undefined
              ? null
              : h('button', { type: 'button', style: buttonStyle, onClick: () => dismissRecord(record.uiId) }, tr('close', 'Close')),
          );
        }
        // The interface itself renders at the end of the turn (see HtmlUiInlineTail):
        // one seat draws it, so a GUI that does show tool rows cannot show it twice.
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              margin: '2px 0',
              padding: '6px 10px',
              border: '1px solid var(--dsw-alias-border-l1, #ddd)',
              borderRadius: '10px',
              color: 'var(--dsw-alias-label-secondary, #888)',
              fontSize: '12px',
            },
          },
          h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${record.title.length > 0 ? record.title : record.uiId} · ${tr('inlineAtTail', 'inline · shown at the end of this turn')}`),
        );
      }

      const openFullscreen = () => {
        state.fullscreen = record.uiId;
        bump();
      };

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            border: '1px solid var(--dsw-alias-border-l1, #ddd)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02))',
          },
        },
        h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${record.title.length > 0 ? record.title : record.uiId} · ${tr('placed', 'placed: ')}${placement}`),
        placement === 'fullscreen'
          ? h('button', { type: 'button', style: buttonStyle, onClick: openFullscreen }, tr('open', 'Open'))
          : null,
        placement === 'dock-right' && rightPaneReady()
          ? h('button', { type: 'button', style: buttonStyle, onClick: () => openRightPane(record.uiId) }, tr('openInRight', 'Open in the right column'))
          : null,
        h('button', { type: 'button', style: buttonStyle, onClick: () => dismissRecord(record.uiId) }, tr('close', 'Close')),
      );
    }

    /** Remove one surface locally and tell the host to drop its record. */
    /** The capability the host handed this page for an interface, taken from its URL. */
    function ticketToken(uiId) {
      const cached = state.tickets.get(uiId);
      if (cached === undefined || typeof cached.url !== 'string') return undefined;
      // Two shapes, because the capability travels differently for a project that serves
      // its own files: the plain document route carries it in the query
      // (`…/ui/<id>?t=…`), while the file route carries it in the *path*
      // (`…/files/<id>/<token>/index.html`) — a relative subresource request has no query
      // string to put it in. Reading only the query is why closing such an interface never
      // worked: no token was found, the close was never sent, and the record outlived the
      // button and came back on every load.
      const fromQuery = /[?&]t=([^&]+)/u.exec(cached.url);
      if (fromQuery !== null) return fromQuery[1];
      const fromPath = /\/files\/[^/]+\/([^/?#]+)\//u.exec(cached.url);
      return fromPath === null ? undefined : fromPath[1];
    }

    function dismissRecord(uiId) {
      // The row disappears at once — a button that waits for a round trip feels broken —
      // but the dismissal is only *kept* once the host confirms the removal. An optimistic
      // mark that outlived a refusal is how an interface came back on the next load while
      // the page insisted it was gone.
      state.dismissed.add(uiId);
      const confirm = (ok) => {
        if (ok) return;
        state.dismissed.delete(uiId);
        state.templates.error = tr('closeFailed', 'The host refused to remove it; it is still attached.');
        bump();
      };
      // The token has to be read before the teardown, which drops the cached ticket.
      const token = ticketToken(uiId);
      retire(uiId);
      const close = (capability) =>
        postJson('/rpc', { uiId, op: 'close', t: capability }).then((result) => {
          const ok = result !== null && result.ok === true;
          if (!ok) logWarn(undefined, `[dsh-htmlui] the host refused to close ${uiId}`, result);
          confirm(ok);
        });
      if (token !== undefined) {
        close(token);
        return;
      }
      // This page never loaded the interface, so it never received a capability for
      // it: ask for a ticket first and close with what comes back. Without this the
      // host refused every close with 403 and the record outlived the button.
      ensureTicket(uiId).then(() => {
        const fresh = ticketToken(uiId);
        if (fresh !== undefined) close(fresh);
        else confirm(false);
      });
    }

    function toggleCollapsed(uiId) {
      state.collapsed.set(uiId, state.collapsed.get(uiId) !== true);
      bump();
    }

    // ------------------------------------------------------------------- docks

    /**
     * Which placements a dock claims.
     *
     * `dock-right` belongs to the right column, but only while that column can actually
     * open a tab: registering the type is not enough, because the interface would then
     * be in no seat at all. Until the controller is bound, the wide dock above the
     * composer keeps claiming it, and only one seat ever claims a record, so it never
     * renders twice.
     */
    function dockPlacements(base) {
      return base.includes('dock-right') && rightPaneReady() ? [] : base;
    }

    function HtmlUiDock(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      const [height, setHeight] = useState(defaultDockHeight);
      useSessionSync(sessionId);

      // Every hook runs before the early returns below. They were once after them,
      // which was invisible while the session never resolved (the dock always left at
      // the first return); the moment records started matching, the hook count changed
      // between renders and React raised error #310 ("rendered more hooks than during
      // the previous render"), which the surface boundary then showed in red.
      const resizeRef = useRef(null);
      const measureRef = useRef(null);
      useEffect(() => {
        const node = measureRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined;
        // The composer's own top edge, for the band a hosted inline document is clipped to: this
        // seat is inside that block, so its top is the end of the transcript's visible area.
        state.composerSeat = node;
        scheduleInlineSync();
        const apply = () => {
          const rect = node.getBoundingClientRect();
          const left = Math.round(rect.left);
          const width = Math.round(rect.width);
          if (width > 0 && (state.column.left !== left || state.column.width !== width)) {
            state.column = { left, width };
            bump();
          }
          scheduleInlineSync();
        };
        apply();
        window.addEventListener('resize', apply);
        return () => {
          window.removeEventListener('resize', apply);
          if (state.composerSeat === node) state.composerSeat = null;
        };
      }, []);
      const onResizeDown = useCallback(
        (event) => {
          if (event.button !== 0) return;
          resizeRef.current = { h: height, y: event.clientY };
          // Without capture the drag only tracks while the pointer stays on the
          // 6px handle, which makes the dock height practically unadjustable.
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* unsupported capture is not fatal */
            }
          }
          event.preventDefault();
        },
        [height],
      );
      const onResizeMove = useCallback((event) => {
        const start = resizeRef.current;
        if (start === null || start === undefined) return;
        const limits = dockLimits();
        const next = Math.min(limits.max, Math.max(limits.min, start.h + (start.y - event.clientY)));
        setHeight(next);
      }, []);
      const onResizeUp = useCallback(() => {
        resizeRef.current = null;
      }, []);

      if (sessionId === undefined) return null;
      const base = Array.isArray(props.placements) ? props.placements : ['dock-right'];
      const placements = dockPlacements(base);
      const records = recordsIn(sessionId, placements);

      // This seat is a full-width child of the conversation column, so it is where the
      // column's own edges are measured for a fullscreen surface. The measurement runs
      // even with nothing to draw: covering the user's sidebar is not acceptable, and
      // reading another plugin's DOM to avoid it is not either.
      const measure = h('div', { key: 'measure', ref: measureRef, style: { width: '100%', height: 0, pointerEvents: 'none' } });
      if (records.length === 0) return h(React.Fragment, null, measure);

      const dismiss = dismissRecord;
      const toggle = toggleCollapsed;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0', flexShrink: 0 } },
        measure,
        h('div', {
          style: { height: '6px', cursor: 'ns-resize', touchAction: 'none', borderRadius: '3px', background: 'transparent' },
          onPointerDown: onResizeDown,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeUp,
          onPointerCancel: onResizeUp,
          title: tr('resizeHandle', 'Resize the panel'),
          // A drag-only handle is unreachable by keyboard; the arrows do the same job.
          role: 'separator',
          tabIndex: 0,
          'aria-label': tr('resizeHandle', 'Resize the panel'),
          'aria-orientation': 'horizontal',
          onKeyDown: (event) => {
            const step = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0;
            if (step === 0) return;
            event.preventDefault();
            const limits = dockLimits();
            setHeight((current) => Math.min(limits.max, Math.max(limits.min, current + step)));
          },
        }),
        ...records.map((record) =>
          h(
            'div',
            {
              key: record.uiId,
              style: {
                // A concrete height, not only a maximum: the frame inside asks for
                // 100%, and a percentage against an indefinite height resolves to
                // auto, so a max-height alone would clip instead of resize.
                height: state.collapsed.get(record.uiId) === true ? 'auto' : `${height}px`,
                display: 'flex',
                flexDirection: 'column',
                minHeight: '0',
                overflow: 'hidden',
              },
            },
            h(HtmlUiFrame, {
              record,
              theme: state.theme,
              variant: 'dock',
              collapsed: state.collapsed.get(record.uiId) === true,
              onToggleCollapse: toggle,
              onDismiss: dismiss,
            }),
          ),
        ),
      );
    }

    // --------------------------------------------------------------- right pane

    /**
     * Body of the right column's `dsh-htmlui-panel` tab: it hosts every
     * dock-right interface of the mounted session. The tab's own navigation
     * parameters are not needed, because the session arrives in the standard
     * props every session-scoped body receives.
     */
    function HtmlUiRightPane(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      // The ✕ on the HTML UI tab belongs to the host and offers no callback, so the tab's
      // own teardown is the only signal there is. That signal used to be useless: a Session
      // switch, or another tab taking the column, unmounted this body too, and an earlier
      // revision that acted on it deleted a session's interfaces for no reason. With
      // `keepMounted: true` the host holds this body for as long as the tab exists — it
      // survives hiding, Session changes and docking — so an unmount now means what it
      // looks like: the reader closed the tab. Riding along with it, this session's
      // dock-right interfaces are closed as well, because their documents went with the
      // body: leaving them listed would show the session page rows whose content is gone.
      // Two teardowns are not the reader's doing and are ignored: the page going away, and
      // the plugin itself letting the tab go.
      useEffect(
        () => () => {
          if (pageUnloading || rightPaneWiring.released) return;
          for (const record of recordsIn(sessionId, ['dock-right'])) dismissRecord(record.uiId);
        },
        [],
      );
      // Nothing to show means showing nothing: an explanatory line in an open column
      // costs the reader half the frame for no content. The column itself is not ours
      // to open or close — it may host other plugins' tabs — so the plugin simply never
      // occupies it without something to put there.
      const records = sessionId === undefined ? [] : recordsIn(sessionId, ['dock-right']);
      if (records.length === 0) return null;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: '0', padding: '6px' } },
        ...records.map((record) =>
          h(
            'div',
            {
              key: record.uiId,
              style: {
                // An expanded surface shares the column's height with its neighbours; a
                // collapsed one takes only its control row. Leaving it at `1 1 auto` kept
                // its share of empty space, which is what "collapsed but still there"
                // looked like.
                flex: state.collapsed.get(record.uiId) === true ? '0 0 auto' : '1 1 auto',
                minHeight: '0',
                display: 'flex',
                flexDirection: 'column',
              },
            },
            // Each object keeps its own collapse and close: the column can hold several
            // independent surfaces, and one of them being in the way is not a reason to
            // close the tab for all of them. They render as a faint cluster in the
            // corner — no title row, so the surface itself stays seamless.
            h(HtmlUiFrame, {
              record,
              theme: state.theme,
              variant: 'dock',
              collapsed: state.collapsed.get(record.uiId) === true,
              onToggleCollapse: toggleCollapsed,
              onDismiss: dismissRecord,
            }),
          ),
        ),
      );
    }

    /**
     * The right column's tab exists only while some session has something for it.
     *
     * Registering the type at boot leaves an "HTML UI" tab in the column of every
     * session forever, which is a page that costs width and holds nothing. The tab is
     * therefore created when the first `dock-right` record appears and torn down when
     * the last one goes; the controller binding stays, because it is what opens the
     * column afterwards and it creates nothing on its own.
     */
    const rightPaneWiring = { ctx: undefined, wired: false, released: false, disposes: [] };

    function wireRightPaneController(ctx, disposers) {
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['sidebarRight'], (scope) => {
        const controller = scope.sidebarRight;
        if (controller === undefined || typeof controller.openTab !== 'function') return;
        state.rightPane.controller = controller;
        bump();
        scope.effect(
          () => () => {
            if (state.rightPane.controller === controller) state.rightPane.controller = undefined;
            bump();
          },
          'dsh-htmlui: right-pane controller',
        );
      });
      disposers.push(() => {
        state.rightPane.controller = undefined;
      });
    }

    /** Register the tab body and its type, once, and keep the disposers. */
    function ensureRightPaneTab() {
      const ctx = rightPaneWiring.ctx;
      if (rightPaneWiring.wired || ctx === undefined) return;
      rightPaneWiring.wired = true;
      rightPaneWiring.released = false;
      const disposes = [];
      // The registration's own disposer is the one that takes it out of the slot tree:
      // keeping only the injection's disposer left the tab registered forever, which is
      // why an empty session still had an HTML UI page in its column.
      disposes.push(
        ctx.slots.inject('sidebar.right.pane.tab', () => {
          // The injection can resolve after a release has already run. Registering then
          // would leave a tab nobody can take away, so a released wiring declines.
          if (!rightPaneWiring.wired) return () => {};
          const unregister = ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            guarded(ctx, (props) => h(HtmlUiRightPane, Object.assign({}, props, { ctx }))),
          );
          if (typeof unregister === 'function') disposes.push(unregister);
          return unregister;
        }),
      );
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], (scope) => {
          try {
            if (!rightPaneWiring.wired) return;
            const tabs = scope.sidebarRightTabs;
            if (tabs === undefined || typeof tabs.register !== 'function') return;
            scope.effect(() => {
              if (!rightPaneWiring.wired) return undefined;
              // The registry owns the registration's lifecycle; this effect owns only
              // the flag other components read, and clears it on teardown so dock-right
              // moves back to its fallback instead of vanishing.
              const unregister = tabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                multiple: false,
                // The column hides its pane, and the pane changes Session, without the
                // reader asking for anything: an unmounted body would destroy every
                // interface's document and reload it on the way back, losing whatever
                // lived in it. Keeping a visited body mounted through hiding, Session
                // changes and docking is what makes dock-right survive.
                keepMounted: true,
                title: () => 'HTML UI',
              });
              if (typeof unregister === 'function') disposes.push(unregister);
              state.rightPane.available = true;
              bump();
              return () => {
                if (typeof unregister === 'function') unregister();
                state.rightPane.available = false;
                bump();
              };
            }, 'dsh-htmlui: right-pane tab type');
          } catch (error) {
            logWarn(ctx, 'dsh-htmlui: right-pane tab type unavailable', error);
          }
        });
      }
      rightPaneWiring.disposes = disposes;
    }

    /** Take the tab back out of the column. */
    function releaseRightPaneTab() {
      if (!rightPaneWiring.wired) {
        state.rightPane.available = false;
        return;
      }
      rightPaneWiring.wired = false;
      // The plugin is taking its tab away, which tears the body down too: not the reader's
      // doing, and not a reason to close their interfaces.
      rightPaneWiring.released = true;
      for (const dispose of rightPaneWiring.disposes) {
        try {
          dispose();
        } catch {
          /* a seat that refuses to leave must not break the store */
        }
      }
      rightPaneWiring.disposes = [];
      state.rightPane.available = false;
    }

    /** Keep the column's tab in step with the records that need it. */
    function syncRightPane() {
      let wanted = false;
      for (const record of state.byId.values()) {
        if (record.placement === 'dock-right') {
          wanted = true;
          break;
        }
      }
      if (wanted) ensureRightPaneTab();
      else releaseRightPaneTab();
    }

    // ------------------------------------------------------------------ overlay

    /**
     * Every overlay surface of one session, in stacking order.
     *
     * The float, background and fullscreen forms live in the frame-wide overlay seat, and so does
     * every hosted `inline` document — that is what lets all of them outlive a Session switch.
     * This builds one session's share; the caller decides whether the group is shown.
     */
    function overlayLayers(records, fullscreenRecord, dismiss) {
      const floats = records.filter((record) => record.placement === 'float');
      const backgrounds = records.filter((record) => record.placement === 'background');

      const leaveFullscreen = (uiId) => {
        state.fullscreen = null;
        state.fullscreenDismissed.add(uiId);
        bump();
      };

      const layers = [];

      for (const record of records) {
        // An interface is hosted once its seat has been on screen — the transcript still decides
        // *where* an inline document belongs, this only takes over *drawing* it. A page load
        // therefore builds the documents of the turns actually rendered, not every old one.
        if (record.placement !== 'inline' || !state.inlineHosted.has(record.uiId)) continue;
        layers.push(h(HtmlUiInlineHost, { key: `inline-${record.uiId}`, record }));
      }

      for (const record of backgrounds) {
        layers.push(
          h(
            'div',
            {
              key: `bg-${record.uiId}`,
              style: {
                position: 'fixed',
                inset: '0',
                // Decoration: the layer does not take clicks.
                pointerEvents: 'none',
                // Dimmed here, deliberately, and this is the whole safety of the mode.
                //
                // `shell.overlay` is documented as a frame-wide layer *above every column*,
                // and its host creates a stacking context, so nothing rendered from it can
                // reach behind the interface: a fully opaque document covers the entire
                // workspace, and because the layer takes no pointer events its own document
                // cannot offer a way out either. Keeping it translucent is what leaves the
                // interface readable and clickable while it is on screen. A document that
                // wants to be dimmer can say so in its own CSS; one that wants to be opaque
                // cannot be, in this mode.
                opacity: 0.25,
                zIndex: 1,
              },
            },
            h(HtmlUiFrame, { record, theme: state.theme, variant: 'background', onDismiss: dismiss }),
          ),
        );
      }

      for (const record of floats) {
        // A minimized window is put away, not deleted, and not *unmounted* either: taking
        // the frame out of the tree destroys its document, so restoring it would reload the
        // interface from scratch and lose everything that lived in it — typed input, scroll
        // position, the whole runtime state — while also paying for the reload. `display:
        // none` keeps the document alive and costs nothing to show again.
        const hidden = state.hidden.has(record.uiId);
        layers.push(
          h(
            'div',
            { key: record.uiId, style: { display: hidden ? 'none' : 'contents' } },
            h(HtmlUiFrame, {
              record,
              theme: state.theme,
              variant: 'float',
              onMinimize: (uiId) => {
                state.hidden.add(uiId);
                bump();
              },
              onDismiss: dismiss,
            }),
          ),
        );
      }

      // Every fullscreen surface stays mounted, and only the active one is shown. Rendering
      // just the active one meant switching away unmounted its document, so coming back
      // reloaded the interface from scratch and lost whatever lived in it — the same loss
      // the floats had, and the same fix: hide it rather than destroy it.
      for (const surface of records.filter((entry) => entry.placement === 'fullscreen')) {
        const active = fullscreenRecord !== undefined && fullscreenRecord.uiId === surface.uiId;
        layers.push(
          h(
            'div',
            {
              key: `fs-${surface.uiId}`,
              style: {
                position: 'fixed',
                top: '0',
                // A fullscreen surface covers the conversation column, not the frame: the
                // sidebar belongs to the user, and covering it hides their sessions. The
                // column's own edges are measured from our seat inside it.
                //
                // 手机: the narrow shell has no persistent sidebar to protect, and the seat we
                // measure from is a column inside it rather than the screen — so measuring still
                // covered a column and the surface came up short of the edges. On a narrow viewport
                // the screen *is* the column, so it is covered whole.
                //
                // Width in viewport units, not percent: a percentage resolves against the containing
                // block, and a shell that wraps this layer in a transformed element makes that
                // element the containing block — which is how a "100%" layer still left a band down
                // the right edge. `vw` always means the viewport. Desktop keeps the measurement.
                left: narrowViewport() !== true && state.column.width > 0 ? `${state.column.left}px` : '0',
                width: narrowViewport() !== true && state.column.width > 0 ? `${state.column.width}px` : '100vw',
                // The width above is only a *request* while this layer is a flex item in the host's
                // layout: flex items shrink, and a shrink back to the container's width is exactly
                // what a measured 361-in-a-393px-viewport was. `flexShrink: 0` refuses to shrink, and
                // the matching min-width is the second lock (a box never shrinks below its min-width).
                flexShrink: 0,
                minWidth: narrowViewport() === true ? '100vw' : undefined,
                height: '100%',
                zIndex: 5,
                display: active ? 'flex' : 'none',
                flexDirection: 'column',
                pointerEvents: 'auto',
                background: 'var(--dsw-alias-bg-base, #fff)',
              },
              // Modal to assistive technology: the layer covers the page, so the
              // page behind it must not stay reachable by a screen reader.
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': surface.title.length > 0 ? surface.title : surface.uiId,
            },
            h(
              'div',
              { style: Object.assign({}, surfaceChrome, { minHeight: '36px', padding: '0 10px' }) },
              h('span', { style: titleStyle }, `${surface.title.length > 0 ? surface.title : surface.uiId} ${tr('fullscreenSuffix', '· fullscreen')}`),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => leaveFullscreen(surface.uiId),
                },
                tr('backToChat', 'Back to chat'),
              ),
              h('button', { type: 'button', style: buttonStyle, onClick: () => dismiss(surface.uiId) }, tr('close', 'Close')),
            ),
            h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, h(HtmlUiFrame, { record: surface, theme: state.theme, variant: 'dock', bare: true })),
          ),
        );
      }

      return layers;
    }

    function HtmlUiOverlay(props) {
      useStore();
      const [, force] = useState(0);
      const viewedRef = useRef(undefined);

      viewedRef.current = resolveViewedSessionId(props.ctx);
      const sessionId = viewedRef.current;

      useEffect(() => {
        if (sessionId === undefined) return undefined;
        let cancelled = false;
        // The same answer every seat asks for, and the same convergence: publishing
        // alone would leave a record the host dropped on screen forever.
        syncSession(sessionId).then((value) => {
          if (cancelled) return undefined;
          return value;
        });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      const themeWatcher = useRef(null);
      useEffect(() => {
        const update = () => {
          const next = readTheme();
          if (next !== state.theme) {
            state.theme = next;
            bump();
          }
        };
        update();
        if (typeof MutationObserver === 'function' && document.body !== null) {
          themeWatcher.current = new MutationObserver(update);
          themeWatcher.current.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class'] });
        }
        return () => {
          if (themeWatcher.current !== null) themeWatcher.current.disconnect();
        };
      }, []);

      useEffect(() => {
        const subscriptions = props.ctx.sessions?.list?.subscribe;
        if (typeof subscriptions !== 'function') return undefined;
        const unsubscribe = subscriptions.call(props.ctx.sessions.list, () => force((n) => n + 1));
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, [props.ctx]);

      // Every hook runs before any early return: a conditional hook would break the
      // order the moment a session gains or loses its first record.
      const sessionRecords = sessionId === undefined ? [] : recordsFor(sessionId);
      const fullscreenId = activeFullscreen(sessionRecords)?.uiId;

      // Escape is the reflex for leaving a fullscreen layer, and the button alone
      // would be the only way out for anyone not using a pointer.
      useEffect(() => {
        if (fullscreenId === undefined) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          // Switch back to the chat and keep this interface closed until the user
          // asks for it again; a newly attached one still opens.
          state.fullscreen = null;
          state.fullscreenDismissed.add(fullscreenId);
          bump();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [fullscreenId]);

      // The hosted inline frames are placed imperatively: a fixed layer does not scroll with the
      // transcript by itself, so every scroll and resize re-places them. The scroll listener is
      // captured, which hears the transcript's own scroller without this seat being inside it.
      useEffect(() => {
        if (typeof window !== 'object' || window === null || typeof window.addEventListener !== 'function') return undefined;
        const place = (event) => {
          // A scroll teaches us which box actually scrolls a seat: the event's target *is* that
          // scroller. The walk up the ancestors finds it as well, but this is the ground truth,
          // and preferring it means a layout the walk misreads corrects itself on first scroll.
          const target = event === null || event === undefined ? undefined : event.target;
          if (
            target !== undefined &&
            target !== null &&
            typeof target.getBoundingClientRect === 'function' &&
            typeof target.contains === 'function'
          ) {
            for (const [uiId, seat] of state.inlineSeats) {
              if (seat.scroller !== target && target.contains(seat.element)) {
                state.inlineSeats.set(uiId, { element: seat.element, scroller: target });
              }
            }
          }
          syncInlineBoxes();
        };
        window.addEventListener('scroll', place, { capture: true, passive: true });
        window.addEventListener('resize', place);
        return () => {
          window.removeEventListener('scroll', place, { capture: true });
          window.removeEventListener('resize', place);
        };
      }, []);

      // Any render of this seat may have moved something a hosted frame is placed against: a
      // height arrived, a turn closed, a record appeared, the theme changed. One coalesced
      // re-placement per frame keeps them aligned without a permanent loop.
      useEffect(() => {
        scheduleInlineSync();
      });

      // One group per session that holds an overlay surface, and only the reader's own is
      // shown. This seat is frame-wide, so it is the one place a document can outlive a
      // Session switch: rendering the viewed session alone — which is what this did before —
      // unmounted every float and fullscreen layer of the session being left, so coming back
      // reloaded those documents and lost whatever lived in them. Hiding a group with
      // `display: none` keeps its documents alive, exactly as a minimized float already was.
      //
      // The order is by session id and every group is keyed by its session, so a switch leaves
      // each group exactly where it was and React reconciles the whole subtree as unchanged.
      const owners = Array.from(state.bySession.keys()).sort();
      const groups = [];

      for (const owner of owners) {
        const records = recordsFor(owner);
        const layers = overlayLayers(records, activeFullscreen(records), dismissRecord);
        if (layers.length === 0) continue;
        groups.push(
          h(
            'div',
            {
              key: owner,
              // Which session's surfaces this group holds, so the page (and anyone reading the
              // DOM while a switch is being diagnosed) can tell two groups apart.
              'data-htmlui-overlay': owner,
              style: { display: owner === sessionId ? 'contents' : 'none' },
            },
            ...layers,
          ),
        );
      }

      // Nothing to show and nothing to keep alive: no session, no surfaces.
      if (groups.length === 0 && sessionId === undefined) return null;

      return h(
        'div',
        { style: { position: 'fixed', inset: '0', pointerEvents: 'none' } },
        ...groups,
        h(HtmlUiCreateDialog, { ctx: props.ctx }),
      );
    }

    /** The placements the create dialog offers, with the label each one shows. */
    const CREATE_PLACEMENTS = [
      { value: 'dock-right', key: 'placementDockRight', fallback: 'Right column (a real split)' },
      { value: 'inline', key: 'placementInline', fallback: 'In the conversation' },
      { value: 'float', key: 'placementFloat', fallback: 'Floating window' },
      { value: 'fullscreen', key: 'placementFullscreen', fallback: 'Fullscreen' },
      { value: 'background', key: 'placementBackground', fallback: 'Background layer' },
    ];

    /**
     * The security levels a project can carry, in the order they are offered.
     *
     * `strict` is what the plugin has always done and stays the default; the rest exist
     * for a project the reader imported themselves, and their hint says exactly what each
     * one opens up. `unsafe` is last and flagged, because it is the only one that lets a
     * document reach this page.
     */
    const SECURITY_CHOICES = [
      {
        value: 'strict',
        labelKey: 'securityStrict',
        label: 'Strict (default)',
        hintKey: 'securityHint_strict',
        hint: 'One document, no external files, no network: what this plugin has always done.',
      },
      {
        value: 'local',
        labelKey: 'securityLocal',
        label: 'Own files only',
        hintKey: 'securityHint_local',
        hint: 'The project’s own folder is served beside the document: app.js, css, images and fonts load from it.',
      },
      {
        value: 'open',
        labelKey: 'securityOpen',
        label: 'Own files + network',
        hintKey: 'securityHint_open',
        hint: 'Also allows https/http/ws: CDN scripts, external stylesheets, API calls and sockets.',
      },
      {
        value: 'unsafe',
        labelKey: 'securityUnsafe',
        label: 'Unrestricted (unsafe)',
        hintKey: 'securityHint_unsafe',
        hint: 'Also drops the sandbox’s origin isolation, so the document can reach this DSH page and everything in it. Only for HTML you wrote yourself.',
      },
    ];
    function raiseFloat(uiId) {
      const current = state.floatZ.get(uiId);
      if (current !== undefined && current === state.floatZTop) return;
      state.floatZTop += 1;
      state.floatZ.set(uiId, state.floatZTop);
      bump();
    }

    /**
     * How one catalogue entry reads in a list.
     *
     * The process name is the human name and leads; the project name is the id and
     * follows in parentheses when the two differ, because `template=` takes the id.
     */
    function templateListItem(template) {
      const slug = String(template.slug ?? '');
      const name = typeof template.name === 'string' && template.name.length > 0 ? template.name : slug;
      // The reader's own format: 项目名称（进程ID）. The id is omitted when it repeats the
      // name, because `red（red）` tells nobody anything.
      return name === slug ? name : `${name}（${slug}）`;
    }

    /**
     * Open the manifest form on one existing project.
     *
     * Two actions ask for this — the pencil beside a project, and picking a different project while
     * an edit is already open — and both have to prefill the form the same way. It is written once
     * because the second caller exists only to keep the form on the project the reader just chose:
     * leaving it on the previous one is how a save lands on a project nobody was looking at.
     */
    function openProjectEditor(template) {
      state.adopt = {
        open: true,
        // Editing, not adopting: the project exists, so the form says so and its button saves
        // instead of creating.
        existing: true,
        source: template.slug,
        slug: template.slug,
        name: typeof template.name === 'string' && template.name.length > 0 ? template.name : template.slug,
        description: typeof template.description === 'string' ? template.description : '',
        placement: typeof template.placement === 'string' && template.placement.length > 0 ? template.placement : 'dock-right',
        security: typeof template.security === 'string' && template.security.length > 0 ? template.security : 'strict',
        // What the project ships and what the reader has already allowed; the form shows the
        // checkbox only for the first, and starts from the second.
        backend: template.backend !== undefined && template.backend.allowed === true,
        backendDeclared: template.backend !== undefined && template.backend.declared === true,
        // The project's effective answer, not the declaration: a reader who already turned 常驻
        // off must not be shown it on again, or the next save would silently turn it back on.
        resident: template.backend !== undefined && template.backend.resident === true,
        busy: false,
      };
      bump();
    }

    /**
     * The user's own way to start an interface: what to start from, and where to put it.
     *
     * Everything here happens without the model — the source is either the blank canvas
     * or a saved template, and the placement is passed straight to the host route that
     * renders it.
     */
    function HtmlUiCreateDialog(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      if (state.create.open !== true) return null;
      const items = state.templates.items;
      const radio = (group, value, label, checked, onPick) =>
        h(
          'label',
          { style: createOptionStyle },
          h('input', { type: 'radio', name: group, value, checked, onChange: onPick }),
          h('span', null, label),
        );
      const close = () => {
        state.create.open = false;
        bump();
      };
      const candidates = Array.isArray(state.templates.candidates) ? state.templates.candidates : [];
      // The manifest form is shared by adopting and editing, so the container that holds
      // it has to open for either — an edit has no candidates to show.
      const adoptOpen = state.adopt !== undefined && state.adopt.open === true;
      const narrow = narrowViewport();
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: '0',
            zIndex: 6,
            display: 'flex',
            // On a phone this is a sheet from the bottom: within thumb reach, full width, and it
            // cannot be mistaken for a card floating in the middle of a 390px screen.
            alignItems: narrow ? 'flex-end' : 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
            padding: narrow ? '0' : '16px',
            // The dim is the original one on desktop; the flat variant exists only on a phone.
            background: narrow ? MOBILE.scrim : 'rgba(0,0,0,0.28)',
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) close();
          },
          role: 'dialog',
          // The marker the injected field-size rule in `apply()` scopes itself to: everything inside
          // this dialog is ours, including the manifest form one level further in.
          id: SHEET_ID,
          'aria-modal': 'true',
          'aria-label': tr('createTitle', 'New HTML interface'),
        },
        h(
          'div',
          {
            style: {
              // Without this a `width: 100%` sheet plus its own padding is wider than the screen,
              // which is what pushed the left edge off it.
              boxSizing: 'border-box',
              width: narrow ? '100%' : 'min(520px, 92vw)',
              maxHeight: narrow ? MOBILE.sheetMaxHeight : '80vh',
              overflow: 'auto',
              // The opaque surface token: `bg-base` is the page behind it and read straight through.
              background: 'var(--dsw-alias-bg-overlay, #fff)',
              color: 'var(--dsw-alias-text-primary, #111)',
              border: '1px solid var(--dsw-alias-border-l1, #ddd)',
              borderRadius: narrow ? MOBILE.sheetRadius : '12px',
              boxShadow: narrow ? 'none' : '0 18px 48px rgba(0,0,0,0.28)',
              padding: narrow ? MOBILE.sheetPadding : '14px 16px',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: narrow ? 'center' : 'baseline', gap: '8px', marginBottom: '4px' } },
            h(
              'div',
              { style: Object.assign({}, titleStyle, narrow ? { fontSize: MOBILE.titleFont, fontWeight: MOBILE.titleWeight } : { fontSize: '14px' }) },
              tr('createTitle', 'New HTML interface'),
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            // The close control is part of the mobile sheet; the desktop dialog closes the way it
            // always did (backdrop click), so it is not added there.
            narrow
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: Object.assign({}, buttonStyle, {
                      // A thumb, not a mouse: every control on the sheet is a little bigger. The close
                      // control squares off the same tap size the other sheet buttons stand at.
                      height: MOBILE.buttonHeight,
                      width: MOBILE.buttonHeight,
                      padding: '0',
                      borderRadius: MOBILE.closeRadius,
                      fontSize: MOBILE.closeFont,
                    }),
                    title: tr('cancel', 'Cancel'),
                    onClick: close,
                  },
                  '✕',
                )
              : null,
          ),
          h(
            'div',
            {
              style: narrow
                ? { fontSize: MOBILE.hintFont, lineHeight: '1.5', opacity: 0.6, marginBottom: '8px' }
                : { fontSize: '11.5px', opacity: 0.65, marginBottom: '10px' },
            },
            tr('createHint', 'Nothing here goes through the model; the interface is created in this session right away.'),
          ),
          h('div', { style: { fontSize: '12px', fontWeight: 600, margin: narrow ? MOBILE.sectionMargin : '6px 0 4px' } }, tr('createSource', 'New HTML project')),
          // Where the list comes from, read from the host on every open. The reader can
          // point it at their own directory; an empty value restores the defaults.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: narrow ? MOBILE.dirRowGap : '6px', marginBottom: '6px' } },
            h('input', {
              type: 'text',
              // The one control the sheet draws smaller on a phone, so the injected rule needs to be
              // able to tell it apart from the rest of the fields.
              'data-dsh-htmlui-dir': '',
              value: state.templates.dirInput !== undefined ? state.templates.dirInput : state.templates.dir ?? '',
              placeholder: tr('createDirPlaceholder', 'No directory chosen yet'),
              onChange: (event) => {
                state.templates.dirInput = event.target.value;
                bump();
              },
              style: {
                boxSizing: 'border-box',
                flex: '1 1 auto',
                minWidth: '0',
                font: 'inherit',
                fontSize: narrow ? MOBILE.inputFont : SHEET_FIELD_FONT,
                // Compact on a phone, exactly as it always was on a desktop.
                height: narrow ? MOBILE.inputHeight : 'auto',
                padding: narrow ? MOBILE.inputPadding : '4px 8px',
                borderRadius: narrow ? MOBILE.inputRadius : '7px',
                border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                background: 'var(--dsw-alias-bg-base, #fff)',
                color: 'inherit',
              },
            }),
            h(
              'button',
              {
                type: 'button',
                // `Object.assign` writes `undefined` just as happily as a value, which would erase
                // the height/padding/fontSize this inherits from `buttonStyle` on desktop. The mobile
                // branch is therefore a whole object, and the desktop branch adds nothing.
                style: Object.assign(
                  {},
                  buttonStyle,
                  { flex: '0 0 auto' },
                  narrow ? { flexShrink: 0, height: MOBILE.buttonHeight, padding: MOBILE.buttonPadding, fontSize: MOBILE.buttonFont } : {},
                ),
                title: tr('createDirBrowseHint', 'Choose the folder with the system file browser'),
                onClick: () => {
                  // The shell exposes a directory picker; typing a path by hand is the
                  // fallback, not the way in.
                  const workspace = props !== undefined && props.ctx !== undefined && typeof props.ctx.get === 'function' ? props.ctx.get('uiWorkspace') : undefined;
                  if (workspace === undefined || typeof workspace.pickDirectory !== 'function') {
                    state.templates.error = tr('createDirNoPicker', 'This build cannot open a folder picker; type the path instead.');
                    bump();
                    return;
                  }
                  workspace.pickDirectory().then(
                    (chosen) => {
                      if (typeof chosen !== 'string' || chosen.length === 0) return;
                      state.templates.dirInput = chosen;
                      bump();
                      saveTemplatesDir(chosen);
                    },
                    () => undefined,
                  );
                },
              },
              tr('createDirBrowse', 'Browse…'),
            ),
            h(
              'button',
              {
                type: 'button',
                // `Object.assign` writes `undefined` just as happily as a value, which would erase
                // the height/padding/fontSize this inherits from `buttonStyle` on desktop. The mobile
                // branch is therefore a whole object, and the desktop branch adds nothing.
                style: Object.assign(
                  {},
                  buttonStyle,
                  { flex: '0 0 auto' },
                  narrow ? { flexShrink: 0, height: MOBILE.buttonHeight, padding: MOBILE.buttonPadding, fontSize: MOBILE.buttonFont } : {},
                ),
                disabled: state.templates.savingDir === true,
                onClick: () => {
                  const value = state.templates.dirInput !== undefined ? state.templates.dirInput : state.templates.dir ?? '';
                  saveTemplatesDir(value);
                },
              },
              state.templates.savingDir === true ? tr('creating', 'Creating…') : tr('createDirSave', 'Use this directory'),
            ),
          ),
          state.templates.dir === undefined
            ? h(
                'div',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '6px' } },
                tr('createDirUnset', 'No directory yet: choose the folder that holds your HTML projects.'),
              )
            : null,
          h(
            'div',
            {
              // Only the project list is capped, and only so the rest of the form stays
              // reachable: a long catalogue used to push 默认生成位置 and the buttons far
              // below the fold, which made the form awkward to finish. The list scrolls
              // in place; everything around it keeps its natural size.
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                marginBottom: '10px',
                maxHeight: '30vh',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
              },
            },
            radio('dsh-create-source', 'blank', tr('newBlank', 'Blank canvas'), state.create.source === 'blank', () => {
              state.create.source = 'blank';
              bump();
            }),
            ...items.map((template) => {
              const backend = backendInfoOf(template);
              const declared = backend !== undefined && backend.declared === true;
              return h(
                'div',
                {
                  key: template.slug,
                  // 手机优先, and laid out as two lines on purpose: the project and its pencil, then
                  // the control on the left with the three marks pushed to the right edge, where they
                  // read as one answer to "what is this project doing right now".
                  style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '0' },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: '0' } },
                  h(
                    'div',
                    { style: { flex: '1 1 auto', minWidth: '0' } },
                    radio(
                      'dsh-create-source',
                      template.slug,
                      // The reader's own name first: the slug is an id, and an id is not what
                      // a person looks for in a list. It stays visible beside it, in
                      // parentheses, because it is what `template=` takes.
                      templateListItem(template),
                      state.create.source === template.slug,
                      () => {
                        state.create.source = template.slug;
                        // Picking a different project is also a statement about which project the
                        // open form is about: leaving the form on the previous one is exactly how a
                        // save lands on a project the reader was not looking at. A half-filled
                        // *adopt* form is not moved — that one is about a folder, not a catalogue
                        // entry.
                        if (state.adopt.open === true && state.adopt.existing === true && state.adopt.slug !== template.slug) {
                          openProjectEditor(template);
                          return;
                        }
                        bump();
                      },
                    ),
                  ),
                  // A pencil on every project: the manifest stays editable, with the same
                  // form that created it, prefilled with what is on disk.
                  h(
                    'button',
                    {
                      type: 'button',
                      style: Object.assign({}, buttonStyle, { flex: '0 0 auto', padding: '2px 7px', lineHeight: 1.1 }),
                      title: tr('editProject', 'Edit this project’s details'),
                      'aria-label': `${tr('editProject', 'Edit this project’s details')}: ${templateListItem(template)}`,
                      onClick: () => {
                        openProjectEditor(template);
                      },
                    },
                    '✎',
                  ),
                ),
                declared
                  ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '3px' } },
                      // This list is the authoritative way to stop a backend: it lists the projects
                      // themselves, so it is still here after the panel — and the manager row — are gone.
                      // The indent lines the button up under the project name rather than under the radio.
                      stopBackendButton(template.slug, backend, (result) => {
                        state.templates.notice = result.message;
                        bump();
                      }, { marginLeft: '10px' }),
                      h('span', { style: { flex: '1 1 auto' } }),
                      ...backendChips(backend, true),
                    )
                  : null,
              );
            }),
          ),
          // Said once under the list rather than on every row: there is exactly one thing to
          // understand here, and it is that 停止后台 is not 取消授权.
          items.some((template) => {
            const info = backendInfoOf(template);
            return info !== undefined && info.declared === true;
          })
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '8px' } }, tr('stopBackendHint', 'Projects with a backend: Stop backend ends the process only — it does not withdraw permission, and opening its panel again loads it again.'))
            : null,
          h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '6px 0 4px' } }, tr('createPlacement', 'Where')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '10px' } },
            ...CREATE_PLACEMENTS.map((entry) =>
              radio(
                'dsh-create-placement',
                entry.value,
                `${tr(entry.key, entry.fallback)} · ${entry.value}`,
                state.create.placement === entry.value,
                () => {
                  state.create.placement = entry.value;
                  bump();
                },
              ),
            ),
          ),
          // A background layer is unlike the other four: it belongs to no view, so it is
          // still on screen after switching to the trajectory or the session page, and it
          // only goes away when it is closed from there. Said here, where the choice is
          // made, because otherwise "it is still there" reads as a stray record that keeps
          // coming back rather than the form doing what it says.
          state.create.placement === 'background'
            ? h(
                'div',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '8px' } },
                tr('placementBackgroundHint', 'Full-screen and always on screen, in every view, at 25% opacity so the interface stays readable. Close it from the session page when you are done.'),
              )
            : null,
          state.templates.error !== null
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #c33)', marginBottom: '8px' } }, String(state.templates.error))
            : null,
          state.templates.notice !== null
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '8px' } }, String(state.templates.notice))
            : null,
          // Files copied into the directory that are not projects yet: a folder without a
          // manifest, or a file whose name cannot be a slug. Asking is the whole point —
          // silently skipping them is what made a copied file look like it never arrived.
          //
          // This container also carries the manifest form, which is why it opens for a
          // form even with no candidates at all: editing a project that is already
          // registered used to show nothing, because the form lived inside the
          // "not registered yet" branch.
          candidates.length > 0 || adoptOpen
            ? h(
                'div',
                { style: { marginBottom: '10px' } },
                candidates.length > 0
                  ? h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '6px 0 4px' } }, `${tr('candidatesTitle', 'Not projects yet')} (${candidates.length})`)
                  : null,
                candidates.length > 0
                  ? h(
                      'div',
                      { style: { fontSize: '11.5px', opacity: 0.72, marginBottom: '4px' } },
                      tr('candidatesHint', 'These are in the directory but carry no project manifest. Adopt one and it becomes a template you can create from.'),
                    )
                  : null,
                ...candidates.map((candidate) =>
                  h(
                    'div',
                    { key: candidate.name, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px' } },
                    h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto', minWidth: '0', fontSize: '12px' }) }, candidate.name),
                    h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, candidate.kind === 'dir' ? tr('candidateDir', 'folder') : tr('candidateFile', 'file')),
                    h(
                      'button',
                      {
                        type: 'button',
                        // `Object.assign` writes `undefined` just as happily as a value, which would erase
                // the height/padding/fontSize this inherits from `buttonStyle` on desktop. The mobile
                // branch is therefore a whole object, and the desktop branch adds nothing.
                style: Object.assign(
                  {},
                  buttonStyle,
                  { flex: '0 0 auto' },
                  narrow ? { flexShrink: 0, height: MOBILE.buttonHeight, padding: MOBILE.buttonPadding, fontSize: MOBILE.buttonFont } : {},
                ),
                        onClick: () => {
                          const stem = candidate.name.replace(/\.html?$/iu, '');
                          state.adopt = {
                            open: true,
                            existing: false,
                            source: candidate.name,
                            slug: slugifyClient(stem),
                            name: stem,
                            description: '',
                            placement: 'dock-right',
                            security: 'strict',
                            // Off until the reader says otherwise, and only offered when the
                            // folder that was copied in actually ships a backend.
                            backend: false,
                            backendDeclared: candidate.server === true,
                            // 采纳新项目时默认常驻：我们手上还没有它的元数据，而这个目录里声明的正是
                            // "我要常驻"，所以先跟着声明走；开关只在勾了后台之后才有意义。
                            resident: true,
                            busy: false,
                          };
                          bump();
                        },
                      },
                      tr('candidateAdopt', 'Adopt'),
                    ),
                  ),
                ),
                // Filling in the manifest, rather than having one written behind the
                // reader's back: the slug is what a template is addressed by, so it is a
                // decision, not a detail.
                state.adopt !== undefined && state.adopt.open === true
                  ? h(
                      'div',
                      {
                        style: {
                          margin: '6px 0 2px',
                          padding: '8px 10px',
                          border: '1px solid var(--dsw-alias-border-l1, #ddd)',
                          borderRadius: '10px',
                          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.05))',
                        },
                      },
                      h(
                        'div',
                        { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } },
                        `${state.adopt.existing === true ? tr('editTitle', 'Edit project details') : tr('adoptTitle', 'Project details for')} ${state.adopt.source}`,
                      ),
                      // The reader's own instruction: nothing is written before they say
                      // so. This line belongs to adopting only — an existing project is
                      // already on disk, and telling its owner otherwise would be a lie.
                      state.adopt.existing === true
                        ? h('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '6px' } }, tr('editHint', 'These details are saved over the project’s manifest.'))
                        : h(
                            'div',
                            { style: { fontSize: '11px', opacity: 0.7, marginBottom: '6px' } },
                            tr('adoptHint', 'Nothing is written yet: fill this in and the project is created with it.'),
                          ),
                      ...[
                        // The reader's order: the human name first, then the id that
                        // `template=` takes, then what it is and where it opens.
                        { key: 'name', label: tr('adoptName', 'Project name'), hint: '' },
                        { key: 'slug', label: tr('adoptSlug', 'Process ID'), hint: tr('adoptSlugHint', 'lowercase letters, digits, dot, dash, underscore') },
                        { key: 'description', label: tr('adoptDescription', 'Details'), hint: '' },
                      ].map((field) =>
                        h(
                          'div',
                          { key: field.key, style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
                          h('span', { style: { flex: '0 0 150px', fontSize: '11.5px' } }, field.label),
                          h('input', {
                            type: 'text',
                            value: state.adopt[field.key],
                            placeholder: field.hint,
                            onChange: (event) => {
                              state.adopt[field.key] = event.target.value;
                              bump();
                            },
                            style: {
                              flex: '1 1 auto',
                              minWidth: '0',
                              font: 'inherit',
                              fontSize: SHEET_FIELD_FONT,
                              padding: '3px 7px',
                              borderRadius: '7px',
                              border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                              background: 'var(--dsw-alias-bg-base, #fff)',
                              color: 'inherit',
                            },
                          }),
                        ),
                      ),
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
                        h('span', { style: { flex: '0 0 150px', fontSize: '11.5px' } }, tr('adoptPlacement', 'Where it opens')),
                        h(
                          'select',
                          {
                            value: state.adopt.placement,
                            onChange: (event) => {
                              state.adopt.placement = event.target.value;
                              bump();
                            },
                            style: {
                              flex: '1 1 auto',
                              minWidth: '0',
                              font: 'inherit',
                              fontSize: SHEET_FIELD_FONT,
                              padding: '3px 7px',
                              borderRadius: '7px',
                              border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                              background: 'var(--dsw-alias-bg-base, #fff)',
                              color: 'inherit',
                            },
                          },
                          ...CREATE_PLACEMENTS.map((entry) => h('option', { key: entry.value, value: entry.value }, `${tr(entry.key, entry.fallback)} · ${entry.value}`)),
                        ),
                      ),
                      // How much this project's documents may do. The default is what the
                      // plugin has always done; a complete web project the reader imported
                      // needs more, so they choose here — per project, with the consequence
                      // spelled out.
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
                        h('span', { style: { flex: '0 0 150px', fontSize: '11.5px' } }, tr('adoptSecurity', 'Security level')),
                        h(
                          'select',
                          {
                            value: state.adopt.security,
                            onChange: (event) => {
                              state.adopt.security = event.target.value;
                              bump();
                            },
                            style: {
                              flex: '1 1 auto',
                              minWidth: '0',
                              font: 'inherit',
                              fontSize: SHEET_FIELD_FONT,
                              padding: '3px 7px',
                              borderRadius: '7px',
                              border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                              background: 'var(--dsw-alias-bg-base, #fff)',
                              color: 'inherit',
                            },
                          },
                          ...SECURITY_CHOICES.map((entry) => h('option', { key: entry.value, value: entry.value }, `${tr(entry.labelKey, entry.label)} · ${entry.value}`)),
                        ),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            fontSize: '11px',
                            marginBottom: '8px',
                            color:
                              state.adopt.security === 'unsafe'
                                ? 'var(--dsw-alias-state-error-primary, #c33)'
                                : 'var(--dsw-alias-label-secondary, #888)',
                          },
                        },
                        (() => {
                          const chosen = SECURITY_CHOICES.find((entry) => entry.value === state.adopt.security) ?? SECURITY_CHOICES[0];
                          return tr(chosen.hintKey, chosen.hint);
                        })(),
                      ),
                      // The reader's own decision about code that runs in this process. It appears
                      // only for a project that ships a backend, and the line under it says plainly
                      // what granting means: this is the one switch in the plugin that hands a
                      // project the same reach the plugin has.
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' } },
                        state.adopt.backendDeclared === true
                          ? h('input', {
                              type: 'checkbox',
                              checked: state.adopt.backend === true,
                              onChange: (event) => {
                                state.adopt.backend = event.target.checked;
                                bump();
                              },
                              style: { marginTop: '2px', flex: '0 0 auto' },
                            })
                          : null,
                        h(
                          'div',
                          { style: { minWidth: '0' } },
                          h(
                            'div',
                            { style: { fontSize: '12px', fontWeight: state.adopt.backend === true ? 600 : 400 } },
                            tr('adoptBackend', 'Run this project’s backend'),
                          ),
                          h(
                            'div',
                            {
                              style: {
                                fontSize: '11px',
                                color:
                                  state.adopt.backend === true
                                    ? 'var(--dsw-alias-state-error-primary, #c33)'
                                    : 'var(--dsw-alias-label-secondary, #888)',
                              },
                            },
                            state.adopt.backendDeclared === true
                              ? tr('adoptBackendHint', 'Its server.js runs inside the DSH process with this plugin’s privileges — as trusted as the plugin itself.')
                              : tr('adoptBackendNone', 'No backend here: a server.js in the project folder, named by “backend” in meta.json, is what offers one.'),
                          ),
                        ),
                      ),
                      // 常驻: a second decision about the same process, so it lives under the first
                      // and appears only once the first is answered. A project with no backend — or
                      // one that has not been allowed to run — has nothing to keep resident, and a
                      // switch here would promise a process that is never going to start.
                      state.adopt.backendDeclared === true && state.adopt.backend === true
                        ? h(
                            'div',
                            { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' } },
                            h('input', {
                              type: 'checkbox',
                              checked: state.adopt.resident === true,
                              onChange: (event) => {
                                state.adopt.resident = event.target.checked;
                                bump();
                              },
                              style: { marginTop: '2px', flex: '0 0 auto' },
                            }),
                            h(
                              'div',
                              { style: { minWidth: '0' } },
                              h(
                                'div',
                                {
                                  style: { fontSize: '12px', fontWeight: state.adopt.resident === true ? 600 : 400 },
                                  // The explanation lives in the tooltip: as a wrapped sentence it
                                  // made the form twice as tall on a phone, and the switch reads on
                                  // its own. Stopping it is still said where the button is.
                                  title: tr(
                                    'residentHint',
                                    'Checked: once loaded it is not unloaded when idle, so it keeps running after the panel closes. To stop it, use Stop backend in its manager row or its project row, or uncheck this switch — either unloads it right away.',
                                  ),
                                },
                                tr('residentSwitch', 'Resident'),
                              ),
                            ),
                          )
                        : null,
                      h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'flex-end', gap: narrow ? MOBILE.footerGap : '6px' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            // The same phone shape as the create dialog's footer pair: on a sheet the two
                            // actions in a row are one control, not two sizes of it. Cancel used to keep
                            // the desktop button next to a thumb-sized confirm.
                            style: Object.assign({}, buttonStyle, narrow ? { height: MOBILE.buttonHeight, padding: MOBILE.footerButtonPadding, fontSize: MOBILE.buttonFont, flex: '1 1 0' } : {}),
                            onClick: () => {
                              state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false };
                              bump();
                            },
                          },
                          tr('cancel', 'Cancel'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: Object.assign({}, buttonStyle, narrow ? { height: MOBILE.buttonHeight, padding: MOBILE.footerButtonPadding, fontSize: MOBILE.buttonFont, flex: '1 1 0' } : {}, { borderColor: 'transparent', background: 'var(--dsw-alias-bg-accent, #247bbf)', color: '#fff' }),
                            disabled: state.adopt.busy === true,
                            onClick: () => {
                              adoptTemplate(
                                state.adopt.source,
                                Object.assign(
                                  {
                                    slug: state.adopt.slug,
                                    name: state.adopt.name,
                                    description: state.adopt.description,
                                    placement: state.adopt.placement,
                                    security: state.adopt.security,
                                  },
                                  // Adopting a folder that ships a `server.js` is also where the
                                  // project's manifest gets its declaration: the file is the
                                  // evidence, and the switch is the reader's answer to it. Editing
                                  // an existing project never rewrites that — the folder owns it.
                                  state.adopt.backendDeclared === true && state.adopt.existing !== true
                                    ? { backend: state.adopt.backend === true }
                                    : {},
                                ),
                                // Only sent when the form offered the choice, so a project with no
                                // backend can never end up allowed by accident.
                                state.adopt.backendDeclared === true ? state.adopt.backend === true : undefined,
                                // 常驻 follows the same rule, and one more: it only means anything for a
                                // backend that may actually run, so a project whose backend is not
                                // declared — the usual case when a folder is adopted before its
                                // server.js is written — sends nothing at all rather than a setting
                                // with nothing behind it.
                                state.adopt.backendDeclared === true && state.adopt.backend === true ? state.adopt.resident === true : undefined,
                              );
                            },
                          },
                          state.adopt.busy === true
                            ? tr('creating', 'Creating…')
                            : state.adopt.existing === true
                              ? tr('editConfirm', 'Save changes')
                              : tr('adoptConfirm', 'Write the manifest'),
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          // The actions stay put while the rest scrolls. Without this the panel's own
          // scrolling carries 取消 and 创建 off the bottom of the screen as soon as the
          // catalogue or the candidate list grows, and the reader has to hunt for the
          // button that finishes what they started.
          h(
            'div',
            {
              style: {
                position: 'sticky',
                bottom: '-14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '6px',
                marginTop: '6px',
                paddingTop: '8px',
                paddingBottom: '14px',
                background: 'var(--dsw-alias-bg-overlay, #fff)',
                borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
              },
            },
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, buttonStyle, { border: 'none', background: 'transparent', opacity: 0.7 }),
                onClick: () => {
                  state.create.open = false;
                  toggleTemplates();
                },
              },
              tr('createMore', 'More template actions'),
            ),
            h(
              'span',
              {
                style: { fontSize: '10.5px', fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-secondary, #888)', opacity: 0.8 },
                title: tr('buildTagHint', 'The browser half this page is running'),
              },
              CLIENT_VERSION,
            ),
            h(
              'div',
              // On a phone the two actions split the row evenly and stand a thumb tall; the desktop
              // keeps the compact pair it always had.
              { style: { display: 'flex', gap: narrow ? MOBILE.footerGap : '6px' } },
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, buttonStyle, narrow ? { height: MOBILE.buttonHeight, padding: MOBILE.footerButtonPadding, fontSize: MOBILE.buttonFont, flex: '1 1 0' } : {}),
                  onClick: close,
                },
                tr('cancel', 'Cancel'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, buttonStyle, narrow ? { height: MOBILE.buttonHeight, padding: MOBILE.footerButtonPadding, fontSize: MOBILE.buttonFont, flex: '1 1 0' } : {}, { borderColor: 'transparent', background: 'var(--dsw-alias-bg-accent, #247bbf)', color: '#fff' }),
                  disabled: state.create.busy === true || sessionId === undefined,
                  onClick: () => {
                    if (sessionId === undefined || state.create.busy === true) return;
                    state.create.busy = true;
                    bump();
                    applyTemplate(state.create.source, sessionId, state.create.placement).then((created) => {
                      state.create.busy = false;
                      if (created === true) {
                        state.create.open = false;
                        // The reader asked for it, so open the column for it — now, and
                        // again shortly after, because the tab type registers
                        // asynchronously and the first attempt can arrive too early.
                        const latest = recordsFor(sessionId);
                        const mine = latest.length > 0 ? latest[latest.length - 1] : undefined;
                        if (mine !== undefined && mine.placement === 'dock-right') {
                          openRightPane(mine.uiId);
                          for (const delay of [150, 500, 1200]) {
                            setTimeout(() => openRightPane(mine.uiId), delay);
                          }
                        }
                      }
                      bump();
                    });
                  },
                },
                state.create.busy === true ? tr('creating', 'Creating…') : tr('create', 'Create'),
              ),
            ),
          ),
        ),
      );
    }

    // ------------------------------------------------------------ template drawer

    /**
     * The catalogue the user can reach without the model: a compact strip of
     * templates, applied straight into the session, plus a way to hand one to the
     * model instead. It renders nothing while it is closed.
     */
    function HtmlUiTemplateDrawer(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      if (state.templates.open !== true) return null;

      const items = state.templates.items;
      const rowStyle = {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        padding: '5px 8px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
      };
      const rows = items.slice(0, 40).map((template) =>
        h(
          'div',
          {
            key: template.slug,
            style: rowStyle,
          },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
              title: tr('applyHint', 'Apply to this session (no model round trip)'),
              onClick: () => applyTemplate(template.slug, sessionId),
            },
            tr('apply', 'Apply'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
              title: tr('toModelHint', 'Put the instruction in the composer instead'),
              onClick: () => askModelForTemplate(template.slug, sessionId, props.ctx),
            },
            tr('toModel', 'Ask the model'),
          ),
          h('span', { style: Object.assign({}, titleStyle, { flex: '0 0 auto' }) }, template.slug),
          h(
            'span',
            { style: { flex: '1 1 auto', minWidth: '0', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            template.description,
          ),
          template.bundled === true ? h('span', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('bundled', 'bundled')) : null,
        ),
      );

      return h(
        'div',
        {
          style: {
            margin: '4px 0',
            border: '1px solid var(--dsw-alias-border-l1, #ddd)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02))',
            overflow: 'hidden',
            // The composer's dock is a flex column that also hosts other entries. An
            // item without this is squashed to its first row when they compete for
            // height, which is what a drawer "flattened to its title bar" was.
            flexShrink: 0,
            minHeight: '54px',
          },
        },
        h(
          'div',
          { style: surfaceChrome },
          h('span', { style: titleStyle }, `${tr('templatesTitle', 'HTML UI templates')} (${items.length})`),
          h('button', { type: 'button', style: buttonStyle, onClick: () => toggleTemplates() }, tr('collapse', 'Hide')),
        ),
        state.templates.error !== null
          ? h('div', { style: { padding: '6px 10px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #c33)' } }, `${tr('catalogueUnavailable', 'Template catalogue unavailable')}: ${state.templates.error}`)
          : null,
        h(
          'div',
          { style: Object.assign({}, rowStyle, { borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)' }) },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
              title: tr('newBlankHint', 'Start an empty interface in the right column (no model round trip)'),
              onClick: () => applyTemplate('blank', sessionId),
            },
            tr('newBlank', 'Blank canvas'),
          ),
          h('span', { style: Object.assign({}, titleStyle, { flex: '0 0 auto' }) }, tr('newTitle', 'New')),
          h(
            'span',
            { style: { flex: '1 1 auto', minWidth: '0', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            tr('newBlankDescription', 'An empty space in the right column, to fill as you like'),
          ),
        ),
        state.templates.loaded !== true
          ? h('div', { style: { padding: '6px 10px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('loading', 'Reading templates…'))
          : items.length === 0
            ? h('div', { style: { padding: '6px 10px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('empty', 'No templates yet: have the model save one with html_ui_template, or drop your own .html into the templates directory.'))
            : h(
                'div',
                {
                  // A drawer that grows with the catalogue pushes the composer off the
                  // screen and stops being a drawer. It scrolls instead, on its own, so
                  // the conversation and the input stay where they were.
                  style: { maxHeight: '38vh', overflowY: 'auto', overscrollBehavior: 'contain' },
                },
                ...rows,
              ),
      );
    }

    /**
     * The user's own way in, beside the composer: it opens the drawer, whose first row
     * is a blank canvas that needs no model and no template.
     *
     * It stays visible even with an empty catalogue, because "start one myself" is the
     * point of it — unlike a control that would only open an empty list.
     */
    function HtmlUiTemplateButton(props) {
      useStore();
      // First activation asks where the templates live, once: the catalogue is a
      // directory, and a reader who has one should not have to be told that a box
      // somewhere can point at it.
      useEffect(() => {
        let live = true;
        loadTemplates().then(
          () => {
            if (!live) return undefined;
            if (state.templates.asked === true || state.create.open === true) return undefined;
            state.create.open = true;
            state.create.dirInput = undefined;
            bump();
            return markTemplatesAsked();
          },
          () => undefined,
        );
        return () => {
          live = false;
        };
      }, []);
      // A phone's composer row has no width to spare, so the entry collapses to its mark there. The
      // action is the same one; only the label is shorter, and the accessible name stays complete.
      const narrow = narrowViewport();
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, buttonStyle, { height: narrow ? MOBILE.entryHeight : '26px', padding: narrow ? MOBILE.entryPadding : '0 8px' }),
          title: tr('templatesTooltip', 'New HTML interface, or reuse a saved template'),
          'aria-label': tr('templatesTooltip', 'New HTML interface, or reuse a saved template'),
          onClick: () => {
            state.create.open = true;
            state.create.busy = false;
            state.create.dirInput = undefined;
            bump();
            // The source list is the catalogue, so ask for it as the dialog opens.
            loadTemplates();
          },
        },
        narrow ? '⟨+⟩' : tr('templatesButton', '⟨+⟩ New HTML'),
      );
    }

    // -------------------------------------------------------------------- apply

    function apply(ctx) {
      const disposers = [];
      state.theme = readTheme();
      // A fresh activation must not inherit a binding from a previous one.
      translateRef = null;
      localeRef = null;

      // Visible text: register this plugin's dictionary with the Client locale
      // service and bind it. The service is optional — `ctx.get("locale")` is the
      // documented optional access — so a deployment without it keeps the English
      // literals, and a refusal of the dictionary never costs us the surfaces.
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          localeRef = locale;
          for (const [language, dictionary] of Object.entries(MESSAGES)) {
            const disposeDictionary = locale.register(LOCALE_NS, language, dictionary);
            if (typeof disposeDictionary === 'function') disposers.push(disposeDictionary);
          }
          const bound = locale.bind(LOCALE_NS);
          if (typeof bound === 'function') translateRef = bound;
        }
      } catch (error) {
        logWarn(ctx, 'dsh-htmlui: the locale service refused this dictionary', error);
      }

      // The shell's own chrome has no stacking level to speak of, and our surfaces are drawn from
      // `shell.overlay` — a layer that is, by contract, above every column. So the scroll-to-bottom
      // button and the sidebar end up *under* an inline document. Lowering our own layer is not
      // available (its container is already in front of the columns, whatever z-index our children
      // carry); lifting the chrome is. One stylesheet, and a surface that needs it is one line here
      // instead of a special case somewhere else.
      try {
        const lift = document.createElement('style');
        lift.id = 'dsh-htmlui-chrome-lift';
        lift.textContent = [
          '/* Chrome the frame-wide htmlui layer would otherwise cover — on mobile only, matching the',
          '   gate the shell itself uses for its mobile navigation, so a desktop layout is untouched. */',
          '/* The `html` prefix is deliberate: the shell declares some of these with `!important` at the',
          '   same specificity (the sidebar is z-index 1300 in that same media query), and between two',
          '   `!important` declarations the higher specificity wins, not the later one. */',
          '@media (max-width: 1023px) and (pointer: coarse) {',
          '  html [class*="toBottom"] { z-index: 24 !important; }',
          '  html [data-mobile-nav="frame"] > :first-child { z-index: 1480 !important; }',
          '  html [class*="rightbarCol"], html [data-mobile-nav="backdrop"] { z-index: 1440 !important; }',
          '}',
        ].join('\n');
        document.head.appendChild(lift);
        disposers.push(() => {
          if (lift.parentNode !== null) lift.parentNode.removeChild(lift);
        });
      } catch (error) {
        logWarn(ctx, 'dsh-htmlui: chrome lift skipped', error);
      }

      // The field sizes inside our own sheet, pinned.
      //
      // An installed plugin (`dsh-web-mobile`) holds every text field on the page at 16px with
      // `!important` whenever it detects iOS WebKit, so Safari cannot enlarge the viewport when a
      // field takes focus; its comment says it means to reach third-party panels, and it leaves
      // `select` out on purpose. The result inside our sheet was a form whose inputs were 16px and
      // whose selects were 12px. An inline style cannot win against `!important`, so the two sizes
      // the sheet was designed with are stated here instead — on the same mobile gate as above,
      // scoped to the sheet's own id, so nothing outside it and no chrome of the shell is touched.
      // `select` is included: inside this dialog every control should be one size.
      try {
        const fields = document.createElement('style');
        fields.id = 'dsh-htmlui-sheet-fields';
        fields.textContent = [
          '@media (max-width: 1023px) and (pointer: coarse) {',
          `  #${SHEET_ID} input,`,
          `  #${SHEET_ID} select,`,
          `  #${SHEET_ID} textarea { font-size: ${SHEET_FIELD_FONT} !important; }`,
          '}',
          // The directory row is the one field the layout breakpoint itself shrinks, so its rule
          // carries the same number the branch above uses rather than the sheet-wide one.
          `@media (max-width: ${MOBILE.maxWidthPx}px) and (pointer: coarse) {`,
          `  #${SHEET_ID} [data-dsh-htmlui-dir] { font-size: ${MOBILE.inputFont} !important; }`,
          '}',
        ].join('\n');
        document.head.appendChild(fields);
        disposers.push(() => {
          if (fields.parentNode !== null) fields.parentNode.removeChild(fields);
        });
      } catch (error) {
        logWarn(ctx, 'dsh-htmlui: the sheet field sizes were not pinned', error);
      }

      disposers.push(
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'html_ui' },
            guarded(ctx, (props) => h(HtmlUiToolView, Object.assign({}, props, { ctx }))),
          ),
        ),
      );

      // One dock, and it is the fallback: `dock-right` lives in the right column while
      // that column can open a tab, and in this wide band above the composer when it
      // cannot. The vertical split seats were removed — a surface that only squeezes
      // the session view reads as a window parked inside the conversation.
      disposers.push(
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'htmlui-dock', order: 40 },
            guarded(ctx, (props) => h(HtmlUiDock, Object.assign({}, props, { ctx, placements: ['dock-right'] }))),
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'htmlui-overlay', order: 30 },
            guarded(ctx, (props) => h(HtmlUiOverlay, Object.assign({}, props, { ctx }))),
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'htmlui-view', order: 60, label: () => tr('managerView', 'HTML manager') },
            guarded(ctx, (props) => h(HtmlUiManager, Object.assign({}, props, { ctx }))),
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'htmlui-inline', order: 45 },
            guarded(ctx, (props) => h(HtmlUiInlineTail, Object.assign({}, props, { ctx }))),
          ),
        ),
      );

      // The template drawer: a catalogue the user reaches without the model.
      disposers.push(
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'htmlui-templates', order: 40 },
            guarded(ctx, (props) => h(HtmlUiTemplateButton, Object.assign({}, props, { ctx }))),
          ),
        ),
      );
      disposers.push(
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'htmlui-templates-dock', order: 41 },
            guarded(ctx, (props) => h(HtmlUiTemplateDrawer, Object.assign({}, props, { ctx }))),
          ),
        ),
      );

      // The right column is optional: wire it in its own guard so a deployment
      // without that column keeps every other surface working.
      try {
        rightPaneWiring.ctx = ctx;
        // A fresh activation owns its own seats: the previous one's tab must go, or a
        // re-activation would leave a registration nobody can dispose.
        releaseRightPaneTab();
        wireRightPaneController(ctx, disposers);
        syncRightPane();
      } catch (error) {
        logWarn(ctx, 'dsh-htmlui: right pane wiring skipped', error);
      }

      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
        ctx.logger.info(CLIENT_ACTIVE_LINE);
      } else {
        console.info(CLIENT_ACTIVE_LINE);
      }

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (error) {
            console.warn('[dsh-htmlui] dispose failed', error);
          }
        }
      };
    }

    return {
      inject: ['slots', 'sessions'],
      apply,
      /**
       * Test surface. The browser half is otherwise reachable only through a live
       * page, so the store, the placement parser, and the record projection are
       * exported for `test/client-half.test.mjs`. They are implementation
       * details: nothing outside this package should call them.
       */
      __internals: {
        FRAME_SANDBOX,
        sandboxFor,
        ROUTE_BASE,
        CLIENT_ACTIVE_LINE,
        TAB_ID,
        TAB_KIND,
        state,
        parseSizeText,
        fitFloat,
        recordFromMeta,
        recordsFor,
        recordsIn,
        publish,
        retire,
        convergeSession,
        syncSession,
        syncRightPane,
        activeFullscreen,
        isCurrentRevision,
        loadTemplates,
        saveTemplatesDir,
        adoptTemplate,
        stopBackend,
        backendInfoOf,
        backendCatalogueStale,
        markTemplatesAsked,
        toggleTemplates,
        applyTemplate,
        askModelForTemplate,
        ensureTicket,
        ticketToken,
        tr,
        MESSAGES,
        LOCALE_NS,
        HtmlUiTemplateDrawer,
        HtmlUiCreateDialog,
        HtmlUiManager,
        HtmlUiTemplateButton,
        HtmlUiInlineTail,
        InlineSeat,
        HtmlUiInlineHost,
        inlineHeightOf,
        claimInlineSeat,
        releaseInlineSeat,
        scrollTranscriptBy,
        transcriptBandBottom,
        HtmlUiBoundary,
        guarded,
        ReactComponent,
        dismissRecord,
        toggleCollapsed,
        openRightPane,
        rightPaneReady,
        dockPlacements,
        useOptionalDisclosure,
        ensureRightPaneTab,
        releaseRightPaneTab,
        raiseFloat,
        HtmlUiRightPane,
        HtmlUiFrame,
        HtmlUiToolView,
        HtmlUiDock,
        HtmlUiOverlay,
        resolveViewedSessionId,
        sessionIdOf,
        resolveSessionId,
        argsOf,
        metaOf,
      },
    };
  },
});
