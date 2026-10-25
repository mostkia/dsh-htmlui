/*
 * @mostkia/dsh-htmlui — browser half.
 *
 * Renders every attached HTML document in a sandboxed iframe and places it where
 * its record says it belongs:
 *
 *   inline                 the tool card that carried it, inside the transcript
 *   dock-right             the session's right column, as a tab
 *   float                  a draggable, resizable window over the frame
 *   background             a click-through layer over the frame
 *   fullscreen             covers the session; minimize hides it, close asks first
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
    // A layout effect is what lets the seat hand its frame over before React removes it; a host
    // without one (React always has it, a test renderer may not) degrades to a passive effect.
    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : useEffect;

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
    const CLIENT_VERSION = '0.1.5';
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
      /** Ids the host itself has handed this page, i.e. records that really exist right now. */
      liveIds: new Set(),
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
       * The flowing mode's two ends: the frame element itself, and the hidden box it parks in.
       *
       * In flow mode the frame lives inside its transcript seat while the seat exists, and is
       * moved to its hidden home — not removed — when the seat goes away. Both maps are keyed by
       * interface id and pruned with the record.
       */
      inlineFrames: new Map(),
      inlineHomes: new Map(),
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
      /**
       * Projects whose interface the reader closed while the process stayed up.
       *
       * The manager keeps a row per program, and a program with no interface is the state
       * 「关闭UI界面」 leaves behind: the process is still loaded, so the row — and the 「重启UI界面」
       * control on it — has to survive the catalogue refresh that follows the close.
       */
      dismissedTemplates: new Set(),
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
      // The host is the only one who can say a record exists right now, so only what it hands us (or
      // hands back on a later sync) counts as live. A transcript card republishes without this flag,
      // and history must never open the column by itself.
      if (fromHost) state.liveIds.add(uiId);
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
      // The flowing frame is removed by its own cleanup; the maps must not outlive the record, or
      // a later interface would inherit a dead frame under the same id.
      state.inlineFrames.delete(uiId);
      state.inlineHomes.delete(uiId);
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
     * the session's first fullscreen-placed record the user has not minimized away
     * from, so a newly attached interface opens by itself while minimizing the
     * layer keeps the one it just put away put away.
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
      // The column is a per-session thing and `openTab` acts on the session it is mounted for, so a
      // record belonging to another session must not be revealed from here: the call would throw
      // "no tab type is registered" and, at best, open a column nobody asked for. Widening a record
      // happens in the session it lives in; elsewhere the shell hands it its own seat.
      const mounted = controller.mounted;
      const here = mounted !== undefined && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined;
      const owner = state.byId.get(uiId);
      if (typeof here === 'string' && owner !== undefined && typeof owner.sessionId === 'string' && owner.sessionId !== here) {
        return false;
      }
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
        // 管理器现在分区显示：标题要同时罩住「跨会话的后台程序」和「本会话的界面」，
        // 再叫「本会话的 HTML 程序」就名不副实了。
        managerTitle: 'HTML programs',
        // 分区一：后台活着的项目。host 只报告「加载了没有」，不报告属于哪个会话，
        // 所以一个进程不属于本会话也可能出现在这里 —— 这正是「带后台能跨会话」。
        managerGroupCross: 'Backend programs (cross-session)',
        managerGroupCrossHint: 'Their process runs inside the DSH host, not in a conversation: it stays up after this session closes, which is why a program you never opened here can be listed.',
        // 分区二：本会话的界面记录，纯前端页和有界面开着的项目都在这里。
        managerGroupSession: 'Interfaces in this session',
        managerGroupSessionHint: 'Every interface recorded in this session: plain front-end pages, and projects whose backend is running with an interface open.',
        managerGroupSessionEmpty: 'This session has no interface open.',
        // 行的按钮：最小化/最大化是同一个按钮，文案跟着界面自己的隐藏状态走；其余两个
        // 各做一件不可逆的事（关界面 / 结束进程），所以第一次点击只变成一句确认。
        managerMinimize: 'Minimize',
        managerMaximize: 'Maximize',
        managerCloseUi: 'Close UI',
        managerCloseUiHint: 'Destroys this interface; anything it held in memory goes with it. The process keeps running.',
        managerRestartUi: 'Restart UI',
        managerCloseBackend: 'Close backend task',
        managerCloseSession: 'Close session',
        managerConfirmCloseUi: 'Close it? Unsaved runtime state is lost',
        managerConfirmCloseBackend: 'End the process? Its interfaces close too',
        managerConfirmCloseSession: 'Close it? This cannot be undone',
        managerUiClosed: 'UI closed',
        managerUiClosedHint: 'The backend is still loaded; restart the UI to get the interface back.',
        managerUiHiddenHint: 'Hidden by the interface’s own hide control — this is the same state.',
        managerPlacementTitle: 'Show it again as',
        managerHintHide: 'is the same hide the interface’s own control does.',
        managerHintRest: 'Closing the interface throws it away and keeps its process; ending the process takes the interfaces with it.',
        // 界面自身的关闭按钮：和管理器行一样的两步确认。第一次点击只把按钮换成这句话，
        // 第二次才真的执行 —— 关掉之后文档就被销毁了，没有任何办法恢复。
        closeConfirmUi: 'Close it? The interface is destroyed and cannot be recovered',
        closeConfirmUiHint: 'Click again to destroy this interface: the document goes away and unsaved runtime state is lost.',
      managerRestoreUi: 'Restore interface',
      managerRestoreUiHint: 'Render this project again in this session',
      managerRestoreUiDone: 'Interface restored.',
      managerRestoreUiFailed: 'Could not restore that interface.',
        closeFailed: 'The host refused to remove it; it is still attached.',
        managerHidden: 'hidden',
        minimize: 'Minimize',
        managerEmpty: 'This session has no HTML program.',
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
        createFolderTitle: 'Choose the project folder',
        createFolderHint: 'The project list is read from this folder: every sub-folder that carries a meta.json becomes a project.',
        createAddTitle: 'Add a project',
        createAddHint: 'These are in the folder but carry no project manifest yet. Pick one and describe it once.',
        createNoProjects: 'No projects yet: put one in the folder, or start from the blank canvas.',
        createBadgeNew: 'Projects in the folder that have not been added yet',
        createBadgePick: 'Choose the folder your projects live in',
        createBlankPill: 'Always available',
        createBlankPillHint: 'A new interface with nothing in it yet',
        adoptIcon: 'Project icon',
        adoptIconPick: 'Choose an image…',
        adoptIconRemove: 'Remove',
        adoptIconHint: 'Kept in the project folder, so it travels with the project',
        adoptIconTooLarge: 'An icon must weigh at most 64 KiB.',
        adoptIconUnreadable: 'That image could not be read.',
        adoptIconNotSaved: 'The project was saved, but its icon was not.',
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
      residentHint: 'Checked: once loaded it is not unloaded when idle, so it keeps running after the panel closes. To end it, use Close backend task in its manager row, or uncheck this switch — either unloads it right away.',
      backendBadge: 'Backend',
      backendWillIdle: 'Unloads on its own',
      backendPillRunning: 'Running',
      backendPillIdle: 'Not running',
      backendPillRunningHint: 'Its backend is loaded in the host process right now',
      backendPillIdleHint: 'Nothing is loaded until one of its interfaces calls it',
      backendResident: 'Resident',
      backendFollow: 'Follows the panel',
      backendResidentHint: 'Stays up after the panel closes',
      backendFollowHint: 'Unloads a while after the panel closes',
      backendLoaded: 'Loaded',
      backendIdle: 'Not loaded',
      backendAllowed: 'Allowed',
      backendDenied: 'Not allowed',
      // Ending a backend speaks only when nothing visibly happened: a stop that worked needs no
      // sentence — the row disappearing is the whole answer — while a stop that failed, or found
      // nothing running, has to say so. The control itself is the manager row's `Close backend
      // task`; the drawer keeps the marks and the pencil, and nothing that acts on a process.
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
        placementDockRight: 'Right column',
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
        // 管理器现在分区显示：标题要同时罩住「跨会话的后台程序」和「本会话的界面」，
        // 再叫「本会话的 HTML 程序」就名不副实了。
        managerTitle: 'HTML 程序',
        // 分区一：后台活着的项目。宿主只报告「加载了没有」，不报告它属于哪个会话，
        // 所以一个进程没在本会话开界面也可能出现在这里 —— 这正是「带后台能跨会话」的来源。
        managerGroupCross: '跨会话的后台程序',
        managerGroupCrossHint: '它们跑在 DSH 宿主进程里，不属于任何会话：本会话关掉了它还在，所以这里可能出现你从没在本会话打开过的项目。',
        // 分区二：本会话的界面记录，纯前端页和有界面开着的项目都在这里。
        managerGroupSession: '本会话的界面',
        managerGroupSessionHint: '本会话里记录着的每一个界面：无后台的纯前端页，以及后台在跑、界面也开着的项目。',
        managerGroupSessionEmpty: '本会话没有开着的界面。',
        // 一行的按钮：最小化/最大化共用一个位置，文案跟着界面自身的隐藏状态走；另外两个
        // 各自做一件不可逆的事（关界面 / 结束进程），所以第一次点击只变成一句确认。
        managerMinimize: '最小化',
        managerMaximize: '最大化',
        managerCloseUi: '关闭UI界面',
        managerCloseUiHint: '销毁这个界面，它内存里的内容一并丢失；后台进程继续跑。',
        managerRestartUi: '重启UI界面',
        managerCloseBackend: '关闭后台任务',
        managerCloseSession: '关闭会话',
        managerConfirmCloseUi: '确认关闭界面？未保存的运行信息会丢',
        managerConfirmCloseBackend: '确认结束进程？界面一起消失',
        managerConfirmCloseSession: '确认关闭？无法恢复',
        managerUiClosed: '界面已关闭',
        managerUiClosedHint: '后台进程还加载着：点「重启UI界面」就能把界面找回来。',
        managerUiHiddenHint: '这是界面自己的隐藏按钮造成的状态，两边就是同一个状态。',
        managerPlacementTitle: '重新显示为',
        managerHintHide: '和界面自身那个隐藏按钮是同一个状态。',
        managerHintRest: '关闭界面丢掉界面、留下进程；结束进程会把界面一并带走。',
        // 界面自身的关闭按钮：和管理器行一样的两步确认。第一次点击只把按钮换成这句话，
        // 第二次才真的执行 —— 关掉之后文档就被销毁了，没有任何办法恢复。
        closeConfirmUi: '确认关闭？界面会被销毁且无法恢复',
        closeConfirmUiHint: '再点一次就会销毁这个界面：文档消失，没保存的运行期内容一并丢失。',
        managerRestoreUi: '恢复 UI 界面',
        managerRestoreUiHint: '在本会话里重新渲染这个项目',
        managerRestoreUiDone: '界面已恢复。',
        managerRestoreUiFailed: '界面恢复失败。',
        closeFailed: '宿主拒绝移除，这个界面仍然挂着。',
        managerHidden: '已隐藏',
        minimize: '最小化',
        managerEmpty: '本会话没有 HTML 程序。',
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
        createFolderTitle: '选择项目目录',
        createFolderHint: '项目列表就从这个目录读：里面的每个子文件夹只要带 meta.json，就是一个项目。',
        createAddTitle: '添加项目',
        createAddHint: '这些已经在目录里，但还没有项目档案。选一个，填一次资料即可成为项目。',
        createNoProjects: '还没有项目：往目录里放一个，或者从空白画布开始。',
        createBadgeNew: '目录里还有尚未添加的项目',
        createBadgePick: '选择存放项目的文件夹',
        createBlankPill: '始终可用',
        createBlankPillHint: '一个还没有任何内容的新界面',
        adoptIcon: '项目图标',
        adoptIconPick: '选择图片…',
        adoptIconRemove: '移除',
        adoptIconHint: '保存在项目目录里，跟着项目一起走',
        adoptIconTooLarge: '图标文件不能超过 64 KB。',
        adoptIconUnreadable: '这张图片读不出来。',
        adoptIconNotSaved: '项目已保存，但图标没写进去。',
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
        residentHint: '勾上：加载后不参与空闲卸载，关掉面板也会继续跑。想结束它：用管理器行里的「关闭后台任务」，或取消勾选这个开关 —— 两者都会当场卸载。',
        backendBadge: '带后台',
        backendWillIdle: '空闲后自动卸载',
        backendPillRunning: '运行中',
        backendPillIdle: '未运行',
        backendPillRunningHint: '它的后端此刻已加载在宿主进程里',
        backendPillIdleHint: '未加载：等它的某个界面调用时才会起来',
        backendResident: '常驻',
        backendFollow: '跟随面板',
        backendResidentHint: '关掉面板也不会停',
        backendFollowHint: '关掉面板一会儿后会自动卸载',
        backendLoaded: '已加载',
        backendIdle: '未加载',
        backendAllowed: '已授权',
        backendDenied: '未授权',
        // 结束后台只在「看不出发生了什么」时才说话：停成功了不需要句子——行消失就是全部回答；
        // 失败、或者本来就没在跑，才必须说出来。控件本身是管理器行上的「关闭后台任务」，
        // 抽屉只留标记和铅笔，不放任何作用于进程的按钮。
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
        placementDockRight: '右侧折叠栏',
        placementInline: '上下文对话内',
        placementFloat: '浮动拖拽窗口',
        placementFullscreen: '全屏覆盖会话',
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
          // Opening the menu is also where new things in the folder are announced. The badge is a
          // small target on a corner, and a reader who never presses it would believe this menu
          // has no way to add a project at all — so the list comes up with the panel, once per
          // opening, whenever the folder holds something that is not a project yet.
          if (state.create.open === true && state.create.autoShown !== true && state.templates.candidates.length > 0) {
            state.create.autoShown = true;
            state.create.addOpen = true;
          }
          // The same opening is when the tiles take the chosen project's own default — once, so a
          // placement the reader picked by hand is not undone by a later refresh of this list.
          if (state.create.open === true && state.create.placementBound !== true) {
            const chosen = state.templates.items.find((template) => template.slug === state.create.source);
            const preset = presetPlacementOf(chosen);
            if (preset !== undefined) {
              state.create.placement = preset;
              state.create.placementBound = true;
            }
          }
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
        // A stop that worked needs no sentence: the row disappearing is the whole answer, and a line
        // about it is noise to read and dismiss. The two cases where nothing visibly happened still
        // speak up — a backend that was not running, and a stop that failed.
        const message =
          value.stopped === true
            ? ''
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
          // The icon is a file inside the project folder, which the manifest route does not carry:
          // the bytes go to their own route once the project exists — after an adopt, or right
          // away for a project that was already there. Read before the form is cleared.
          const icon =
            state.adopt.iconRemoved === true
              ? postJson('/templates/icon', { slug, remove: true })
              : typeof state.adopt.iconData === 'string' && state.adopt.iconData.length > 0
                ? postJson('/templates/icon', { slug, dataUrl: state.adopt.iconData })
                : Promise.resolve({ ok: true });
          state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false };
          return Promise.all([icon.catch(() => ({ ok: false })), asked])
            .then(([saved, granted]) => {
              if (saved === null || saved.ok !== true) state.templates.notice = tr('adoptIconNotSaved', 'The project was saved, but its icon was not.');
              return granted;
            })
            .then(() => loadTemplates())
            .then(() => true);
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

    /**
     * The delays a reveal is repeated over.
     *
     * The tab type is registered by the first record of its kind (`syncRightPane`) and that
     * registration lands asynchronously, so the *first* ask can arrive before the column knows
     * the type and be dropped in silence. These later asks are the ones that land on a column
     * that has never held this tab before.
     */
    const DOCK_REVEAL_RETRY_MS = [150, 500, 1200];

    /**
     * Bring the surface a render just made into view, when it is a `dock-right` one.
     *
     * Rendering and revealing are two acts, and the host only performs the first: a record placed
     * in the right column *is* drawn there, but the column stays collapsed until somebody opens
     * its tab — so an interface nobody reveals is an interface nobody can see.
     *
     * This is that reveal, and it is deliberately one function rather than a step every caller
     * remembers, because the manager's 重启UI界面 rendered its project and then stopped: the
     * interface really existed and really was invisible, which read as "nothing happened", and
     * the only way back to it was to press some other control until the column came up.
     *
     * @param slug - the project that was rendered. The newest `dock-right` record of that project
     *   is the one revealed, so a restart cannot reveal the surface it just replaced.
     * @param sessionId - the session the render went into.
     * @returns whether there was a dock-right record to reveal.
     */
    function revealDockRight(slug, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      const docked = recordsFor(sessionId).filter((record) => record.placement === 'dock-right');
      if (docked.length === 0) return false;
      // Prefer this project's own surface, but never turn a missing `template` field into "no
      // reveal at all": without a name to match, the newest docked record is the one just made.
      const named =
        typeof slug === 'string' && slug.length > 0 ? docked.filter((record) => record.template === slug) : [];
      const pool = named.length > 0 ? named : docked;
      const mine = pool[pool.length - 1];
      openRightPane(mine.uiId);
      for (const delay of DOCK_REVEAL_RETRY_MS) {
        setTimeout(() => openRightPane(mine.uiId), delay);
      }
      return true;
    }

    /**
     * Render one project into a session *and* reveal the result — the whole of "open this".
     *
     * Every path that puts an interface into a session goes through here: the create dialog, the
     * drawer's direct 应用/空白 buttons, and the manager's 重启UI界面. Keeping the render and its
     * reveal in one function is what stops the two from drifting apart again — which is exactly
     * how the restart path lost the reveal and shipped a button that looked broken.
     */
    function applyTemplateInto(slug, sessionId, placement) {
      return applyTemplate(slug, sessionId, placement).then((ok) => {
        if (ok === true) revealDockRight(slug, sessionId);
        return ok;
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
     * A manager row's own button: the same look, a taller tap target.
     *
     * 手机优先 / 手机: three controls now share one row, so each one is 26px tall instead of 22 and
     * keeps its label on one line — the difference between a row that can be operated with a thumb
     * and one that needs a stylus.
     */
    const rowButtonStyle = Object.assign({}, buttonStyle, { minHeight: '26px', padding: '0 8px', whiteSpace: 'nowrap' });

    /** The placement currently preselected in the restart picker. */
    const rowButtonActiveStyle = {
      borderColor: 'var(--dsw-alias-bg-accent, #247bbf)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
    };

    /**
     * The style of a close button with its confirmation showing.
     *
     * The glyph button is 22px square, which a sentence cannot fit in; the confirmation is the
     * *same button* wearing this instead — its label may wrap onto a second line (and does on a
     * phone), and the accent border is the mark the manager's own confirmation-carrying button
     * already wears, so the two-step reads the same wherever it appears.
     */
    const closeConfirmButtonStyle = Object.assign({}, buttonStyle, {
      height: 'auto',
      minHeight: '22px',
      maxWidth: '100%',
      padding: '3px 8px',
      whiteSpace: 'normal',
      textAlign: 'center',
      borderColor: 'var(--dsw-alias-bg-accent, #247bbf)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
    });

    /**
     * The two window controls a floating form wears: 最小化 and 关闭.
     *
     * These are the *styles and words* shared between a float and a fullscreen layer, and nothing
     * else: each caller writes the button into its own chrome row, so both rows keep the DOM they
     * always had — the same elements, in the same order, inside the same div. That is deliberate.
     * Wrapping them in one component and rendering that wrapper into the row made the fullscreen
     * layer draw through a node it never had, and the layer stopped covering the frame. The look
     * is what should be identical, not the tree: `buttonStyle` above, `closeConfirmButtonStyle`
     * above, the '—' and '✕' glyphs, and the words 最小化/Minimize, 关闭/Close.
     *
     * 最小化 is never confirmed: it hides — the record stays, the document stays mounted, and the
     * surface can be brought back. 关闭 asks first, in the manager's own two-step, because it
     * destroys the document and nothing brings it back.
     *
     * @param onClick - what minimizing does for this surface (hiding a float, leaving a layer).
     * @param hint - the words the control carries, already resolved through `tr`.
     */
    function windowMinimizeButton(onClick, hint) {
      return h(
        'button',
        {
          type: 'button',
          style: buttonStyle,
          onClick,
          title: hint,
          'aria-label': hint,
        },
        // The glyph, where a 22px button has room for it; the word lives in the title and the
        // accessible name, which is where it was already being read from.
        '—',
      );
    }

    /**
     * The close control, in both of its steps, as the float has always drawn it.
     *
     * @param closeConfirm - the `useCloseConfirm` result: `armed` and `ask`.
     */
    function windowCloseButton(closeConfirm) {
      const armed = closeConfirm.armed === true;
      return h(
        'button',
        {
          type: 'button',
          // The confirmation replaces the ✕ in the very same button (the manager's own two-step
          // does that too): a second control appearing beside it would be a different question in
          // a different place.
          style: armed ? closeConfirmButtonStyle : buttonStyle,
          onClick: closeConfirm.ask,
          title: armed
            ? tr('closeConfirmUiHint', 'Click again to destroy this interface: the document goes away and unsaved runtime state is lost.')
            : tr('close', 'Close'),
          'aria-label': armed
            ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered')
            : tr('close', 'Close'),
          // Announced to assistive technology, and readable from the DOM while the confirmation
          // is showing.
          'aria-live': armed ? 'assertive' : undefined,
        },
        armed ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered') : '✕',
      );
    }

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
     * Whether a programme's backend is running right now, as one pill.
     *
     * The colours and the wording are the reader's own: green while it runs, grey when it does not.
     * Kept apart from `backendChips` on purpose — those say how a backend will live (resident or
     * following its panel, allowed or not), while this says whether it is alive at this moment.
     */
    function backendPill(backend) {
      const running = backend !== undefined && backend.loaded === true;
      return h(
        'span',
        {
          style: {
            flex: '0 0 auto',
            // 与左边的单选圈留出距离：紧贴着会显得药丸是名字的一部分。
            marginLeft: '10px',
            fontSize: '11px',
            padding: '1px 5px',
            color: '#fff',
            borderRadius: '25px',
            border: `1px ${running ? '#4CAF50' : '#9E9E9E'} solid`,
            background: running ? '#4CAF50' : '#9E9E9E',
            whiteSpace: 'nowrap',
          },
          title: running
            ? tr('backendPillRunningHint', 'Its backend is loaded in the host process right now')
            : tr('backendPillIdleHint', 'Nothing is loaded until one of its interfaces calls it'),
        },
        running ? tr('backendPillRunning', 'Running') : tr('backendPillIdle', 'Not running'),
      );
    }

    /**
     * The backend state of one project, as chips and nothing else.
     *
     * The sentence that used to sit beside them now lives in the residency chip's tooltip: on a
     * phone the small print wrapped onto a second line, which made every row taller than the
     * control it was explaining, and the chips read on their own anyway.
     *
     * A process that is loaded without residency gets a third mark, because "it is running and I
     * never asked it to stay" is the one state that reads as a bug: a panel that called its backend
     * a minute ago leaves the module loaded until the idle delay expires, and saying so is the
     * difference between "this will tidy itself up" and "something restarted it".
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
        backend.loaded === true && backend.resident !== true
          ? chip(tr('backendWillIdle', 'Unloads on its own'), 'idle')
          : null,
      );
      return marks;
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
     * Whether this browser can move a node without rebuilding it.
     *
     * `Element.moveBefore` moves a node and keeps its state — for an iframe that means its
     * document: its variables, its input, its scroll position. With it, an inline document can sit
     * inside the transcript, where the browser's own scroll chaining and its own scroll feel come
     * for free, and still survive a Session switch, because the frame is *moved* to a hidden box
     * rather than removed and inserted again. Without it the previous arrangement stays: the frame
     * is hosted in a fixed overlay and the bridge forwards the wheel and the finger.
     */
    const FLOW_INLINE =
      typeof Element === 'function' &&
      Element.prototype !== undefined &&
      Element.prototype !== null &&
      typeof Element.prototype.moveBefore === 'function';


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
     * The strip at the top of the page that the Desktop shell owns.
     *
     * Desktop's Windows shell draws its menu and its window buttons as a 40px native title bar
     * *over* the page. A fullscreen layer that starts at viewport 0 puts its own minimize and close
     * controls underneath that bar, where the native buttons take the click: the layer looks
     * impossible to close, and the session underneath cannot be reached either. Starting below the
     * bar is the whole fix. Every other shell — the browser, macOS, Linux — owns no such strip and
     * gets 0, which leaves its layout exactly as it was.
     */
    function desktopTitlebarInset() {
      if (typeof navigator !== 'object' || navigator === null) return 0;
      const agent = String(navigator.userAgent ?? '');
      return agent.includes('dsh-desktop') && /Windows/u.test(agent) ? 40 : 0;
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
     * Write one inline style only when it differs from what is already there.
     *
     * A scroll handler runs on every frame of a wheel or a finger, and most of what this loop
     * would write — the clipped box, the frame's size — is the same as the last frame's. Assigning
     * an identical value still goes through the CSSOM and invalidates style for that element, so
     * the comparison is what keeps a scroll frame down to the one property that really moved.
     */
    function writeStyle(node, name, value) {
      if (node.style[name] !== value) node.style[name] = value;
    }

    /**
     * Keep pull-to-refresh out of the way while a hosted inline document exists.
     *
     * A touch that lands on an iframe is not consumed by the transcript's scroller — the frame has
     * no scroll chain to it, so the bridge forwards the movement and the conversation scrolls from
     * script. The browser then sees a gesture nobody handled and, near the top of the page, turns a
     * downward drag into the refresh pull: dragging over an interface reloads the page, which
     * dragging over the same conversation never would. `overscroll-behavior-y: contain` on the root
     * is the setting Chrome honours for that gesture. It is held only while a hosted document
     * exists, and whatever the app had on the root is put back when the last one is gone.
     */
    let overscrollSaved = null;
    let overscrollHolders = 0;
    function holdOverscroll(on) {
      const root = typeof document === 'object' && document !== null ? document.documentElement : null;
      if (root === null || root === undefined) return;
      if (on === true) {
        // Counted, not a flag: a Session may hold several inline documents, and the root has to
        // keep the setting until the last of them is gone.
        if (overscrollHolders === 0) {
          overscrollSaved = root.style.overscrollBehaviorY;
          root.style.overscrollBehaviorY = 'contain';
        }
        overscrollHolders += 1;
        return;
      }
      if (overscrollHolders === 0) return;
      overscrollHolders -= 1;
      if (overscrollHolders > 0) return;
      root.style.overscrollBehaviorY = overscrollSaved ?? '';
      overscrollSaved = null;
    }

    /**
     * Stop whatever fling a hosted document is running.
     *
     * The fling scrolls the conversation from inside the frame — during a forwarded gesture the
     * transcript has no native scroll of its own — so a thumb landing on the page cannot end it.
     * Only the document can stop it, and only the host knows a touch happened elsewhere.
     */
    function haltInlineFling() {
      // Flow mode keeps its frames in a map, hosted mode in the boxes below; both are inline
      // documents, and only those fling.
      for (const frame of state.inlineFrames.values()) {
        if (frame.contentWindow === null) continue;
        try {
          frame.contentWindow.postMessage({ __dshHtmlUi: 'halt' }, '*');
        } catch {
          /* the frame is mid-navigation */
        }
      }
      for (const wrapper of inlineBoxes.values()) {
        const frame = typeof wrapper.querySelector === 'function' ? wrapper.querySelector('iframe') : null;
        if (frame === null || frame === undefined || frame.contentWindow === null) continue;
        try {
          frame.contentWindow.postMessage({ __dshHtmlUi: 'halt' }, '*');
        } catch {
          /* the frame is mid-navigation */
        }
      }
    }

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
        // The wrapper is fixed and the frame absolute from the moment they are created; writing
        // them again here keeps the placement correct even if that markup ever changes, and costs
        // nothing after the first frame because an identical value is skipped.
        writeStyle(wrapper, 'position', 'fixed');
        writeStyle(wrapper, 'left', `${Math.round(left)}px`);
        writeStyle(wrapper, 'top', `${Math.round(top)}px`);
        writeStyle(wrapper, 'width', `${Math.round(width)}px`);
        writeStyle(wrapper, 'height', `${Math.round(height)}px`);
        writeStyle(wrapper, 'overflow', 'hidden');
        writeStyle(wrapper, 'pointerEvents', 'none');
        writeStyle(inner, 'width', `${Math.round(at.width)}px`);
        writeStyle(inner, 'height', `${Math.round(at.height)}px`);
        // Only the frame's offset inside the clipped box changes while the transcript scrolls —
        // the box itself is the transcript's viewport, which does not move. A translate is
        // written instead of `top`: the compositor moves the layer, where a `top` change would
        // lay the box out again on every frame of every wheel.
        writeStyle(inner, 'transform', `translate3d(${Math.round(at.left - left)}px, ${Math.round(at.top - top)}px, 0)`);
        writeStyle(inner, 'pointerEvents', 'auto');
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
      if (move(scroller)) {
        // Place the frame in the same task as the scroll. The frame is a fixed layer: if it waits
        // for the scroll event that follows, it trails the content by a frame, and a forwarded
        // wheel over a document is precisely where that shows.
        syncInlineBoxes();
        return;
      }
      const page = document.scrollingElement;
      if (page === null || page === undefined || page === scroller) return;
      if (move(page)) syncInlineBoxes();
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
        adoptInlineFrame(uiId);
        return;
      }
      state.inlineSeats.set(uiId, { element, scroller: scrollContainerOf(element) });
      if (!state.inlineHosted.has(uiId)) {
        state.inlineHosted.add(uiId);
        bump();
      }
      // The frame may already exist (coming back to a Session), so it is adopted now; if it does
      // not exist yet, the frame's own mount adopts it once it does. A failed adoption is retried
      // once on the next frame: the seat is connected and the frame is connected, so a failure
      // here is a timing accident, and leaving the seat empty would read as a broken interface.
      if (FLOW_INLINE === true && adoptInlineFrame(uiId) !== true) {
        const retry = () => adoptInlineFrame(uiId);
        if (typeof window === 'object' && window !== null && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(retry);
        else if (typeof setTimeout === 'function') setTimeout(retry, 16);
      }
      scheduleInlineSync();
    }

    /** The seat is gone; the frame parks and is hidden until another one claims it. */
    function releaseInlineSeat(uiId) {
      state.inlineSeats.delete(uiId);
      parkInlineFrame(uiId);
      scheduleInlineSync();
    }

    /**
     * Move a flowing frame into the seat it belongs to.
     *
     * This is the whole of the flow mode: while the seat exists the frame is a descendant of the
     * transcript's scroller, so the browser scrolls it, chains its wheel to the conversation and
     * paints it in the same frame as the text around it. Nothing is forwarded, nothing is placed by
     * script. `moveBefore` is what makes the move safe: it keeps the document instead of loading it
     * again, which is the difference between an interface that comes back as it was and one that
     * comes back empty.
     */
    function adoptInlineFrame(uiId) {
      if (FLOW_INLINE !== true) return false;
      const frame = state.inlineFrames.get(uiId);
      const seat = state.inlineSeats.get(uiId);
      if (frame === undefined || seat === undefined) return false;
      const element = seat.element;
      if (element === null || element === undefined || element.isConnected !== true) return false;
      if (frame.parentElement === element) return true;
      try {
        element.moveBefore(frame, null);
        return true;
      } catch {
        // The frame stays where it was: a parked document is intact, one that was re-inserted is
        // not, so a failed move never escalates into a reload.
        return false;
      }
    }

    /** Return a flowing frame to the hidden box it lives in while its seat is not on screen. */
    function parkInlineFrame(uiId) {
      if (FLOW_INLINE !== true) return false;
      const frame = state.inlineFrames.get(uiId);
      if (frame === undefined) return false;
      const home = state.inlineHomes.get(uiId);
      if (home === null || home === undefined || home.isConnected !== true) return false;
      if (frame.parentElement === home) return true;
      try {
        home.moveBefore(frame, null);
        return true;
      } catch {
        return false;
      }
    }

    // ---------------------------------------------------------------- surfaces

    /**
     * One close button's two-step confirmation, as component-local state.
     *
     * The manager row already asks before an irreversible act, and closing an interface is exactly
     * that act: `dismissRecord` retires the record locally, tells the host to drop it, and destroys
     * the document — there is no way back and nothing left to restore. So a close control that a
     * thumb can land on while scrolling must ask first, in the same words and with the same timer
     * the manager uses (第一次点击变成确认文案，约 3 秒无操作回退), rather than a second
     * interaction invented here.
     *
     * `action` is deliberately re-read on every render instead of captured in a ref: these
     * components render a *list* of records and React reuses the state across items unless a key
     * changes, so a captured callback could be the neighbouring interface's by the time the second
     * press lands.
     */
    function useCloseConfirm(action) {
      const [armed, setArmed] = useState(false);
      useEffect(() => {
        if (armed !== true) return undefined;
        // 3 seconds, then back to the plain ✕: a control left saying 「确认关闭…」 forever is the
        // trap this interaction exists to avoid — and on a close button it is worse, because the
        // next accidental press would then destroy the interface.
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
      }, [armed]);
      const ask = () => {
        if (armed === true) {
          setArmed(false);
          action();
          return;
        }
        setArmed(true);
      };
      return { armed: armed === true, ask };
    }

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
          // Flow mode puts the frame back inside the transcript, where the browser chains the
          // wheel to the conversation by itself. The bridge has to be told, or it would forward
          // what the browser has already scrolled, and the page would move twice.
          frame.contentWindow.postMessage({ __dshHtmlUi: 'hosting', flow: FLOW_INLINE === true && variant === 'inline' }, '*');
          frame.contentWindow.postMessage({ __dshHtmlUi: 'init', nonce: nonceRef.current, theme }, '*');
        } catch {
          /* the frame is mid-navigation */
        }
      }, [theme, variant]);

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

      // The ✕ on the frame asks before it acts: this is the control the reader's thumb finds while
      // scrolling, and what it does — `onDismiss` → `dismissRecord` — destroys the document and
      // takes the record off the host, with nothing left to restore.
      const closeConfirm = useCloseConfirm(() => props.onDismiss?.(record.uiId));
      const dismissHint = closeConfirm.armed ? tr('closeConfirmUiHint', 'Click again to destroy this interface: the document goes away and unsaved runtime state is lost.') : tr('close', 'Close');

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
            // it back, which is the difference between "out of the way" and "gone". Both
            // controls are written out here — as they always were — from the one pair of
            // style/word factories above, so this row and the fullscreen bar wear the same
            // control without either growing a node the other does not have.
            props.onMinimize !== undefined
              ? windowMinimizeButton(() => props.onMinimize(record.uiId), tr('minimize', 'Minimize'))
              : null,
            props.onDismiss !== undefined ? windowCloseButton(closeConfirm) : null,
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
        // Flow mode draws the same box, but the frame inside it is created by script and then
        // moved into its seat in the transcript; this element is only where it parks.
        if (FLOW_INLINE === true) {
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
            h(InlineFlowBody, {
              record,
              url,
              status,
              handshake,
              frameRef,
              onRetry: () => {
                state.tickets.delete(record.uiId);
                setStatus('loading');
                setAttempt((current) => current + 1);
              },
            }),
          );
        }
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
      // A docked surface is seamless: it belongs to the session's right column rather
      // than floating as a window inside the conversation. No title row, no border, no
      // opaque background — but the collapse and close controls stay, as a faint cluster
      // in the corner.
      if (variant === 'dock') {
        const control = (label, hint, onClick, extra, style) =>
          h(
            'button',
            Object.assign(
              {
                type: 'button',
                style: style ?? Object.assign({}, buttonStyle, { padding: '1px 6px', fontSize: '11px' }),
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
          props.onDismiss !== undefined
            ? control(
                closeConfirm.armed ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered') : '✕',
                dismissHint,
                closeConfirm.ask,
                {
                  'aria-label': closeConfirm.armed ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered') : tr('close', 'Close'),
                },
                closeConfirm.armed ? closeConfirmButtonStyle : Object.assign({}, buttonStyle, { padding: '1px 6px', fontSize: '11px' }),
              )
            : null,
        ];
        // The document is hidden, never removed. Collapsing used to return the control row
        // *instead of* this element, which took the `<iframe>` out of the tree: React unmounted
        // it, the browser destroyed the document inside, and expanding mounted a fresh frame that
        // reloaded the interface from scratch — every character typed into it, its scroll position
        // and its whole runtime state gone. `display: none` keeps the same document alive at no
        // cost, which is exactly how a minimized float and an inactive fullscreen layer are kept.
        // Collapsed, the box also shrinks to the control row (`flex: 0 0 auto`): the height is
        // still whatever the seat gives this element, so the row must not stretch to claim it.
        const hiddenBody = h(
          'div',
          {
            // Names the element a regression test asserts on: the point is that it is still
            // *rendered* while collapsed, not that it looks right.
            'data-htmlui-body': record.uiId,
            style: { flex: props.collapsed === true ? '0 0 auto' : '1 1 auto', minHeight: '0', display: props.collapsed === true ? 'none' : 'flex', flexDirection: 'column' },
          },
          body,
        );
        if (props.collapsed === true) {
          // Collapsed: the controls on their own line, so the column gives the whole height back
          // to the conversation. The hidden document above takes no space and stays alive.
          return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } }, hiddenBody, h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '2px', padding: '2px 4px' } }, ...controls));
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
          hiddenBody,
          h(
            'div',
            {
              style: {
                position: 'absolute',
                top: '2px',
                right: '4px',
                display: 'flex',
                gap: '2px',
                // The confirmation is a sentence, not a glyph, so the cluster must be allowed to
                // be as wide as the surface and wrap inside it — a 22px square would clip it.
                maxWidth: 'calc(100% - 8px)',
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
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
                  style: closeConfirm.armed ? closeConfirmButtonStyle : buttonStyle,
                  onClick: closeConfirm.ask,
                  title: dismissHint,
                  'aria-label': closeConfirm.armed ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered') : tr('close', 'Close'),
                },
                closeConfirm.armed ? tr('closeConfirmUi', 'Close it? The interface is destroyed and cannot be recovered') : '✕',
              )
            : null,
        ),
        // Collapsing hides the document instead of dropping it out of the tree: removing it
        // unmounted the frame and destroyed what the interface held. Same reason as the dock above.
        h(
          'div',
          {
            'data-htmlui-body': record.uiId,
            style: { flex: props.collapsed === true ? '0 0 auto' : '1 1 auto', minHeight: '0', display: props.collapsed === true ? 'none' : 'flex', flexDirection: 'column' },
          },
          body,
        ),
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
     * It holds the space the document occupies, and in flow mode it also holds the document: the
     * frame is moved in here while the seat is on screen, so the browser scrolls it with the
     * transcript and chains its wheel there by itself. The height comes from the frame
     * (`HtmlUiFrame`), so the seat and the document always agree on how much room it takes.
     *
     * The layout-effect cleanup is the load-bearing part. React runs a component's layout cleanups
     * before it removes that component's host nodes from the document, so this is the one moment
     * the frame can be moved out while both ends are still connected. Moving it later would mean
     * moving it out of a detached seat — `moveBefore` refuses that, the frame leaves with the seat,
     * and the document is rebuilt on the way back, which is exactly the loss this mode exists to
     * prevent.
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
      useLayoutEffect(
        () => () => {
          // Idempotent with the ref above: whichever runs first parks the frame, and the second
          // finds it already home.
          releaseInlineSeat(record.uiId);
        },
        [record.uiId],
      );
      return h('div', {
        ref: bind,
        'data-htmlui-inline-seat': record.uiId,
        style: { width: '100%', height: `${height}px`, minHeight: '0', overflow: 'hidden' },
      });
    }

    /**
     * The body of an inline document in flow mode.
     *
     * The frame is created here by script, not rendered by React, and that is the whole trick: a
     * node React rendered is a node React removes when the component unmounts, and this frame has
     * to outlive those unmounts. `moveBefore` then carries it between its seat and the hidden box
     * below without the document being loaded again.
     *
     * The seat, not this component, decides where the frame is: the component owns the hidden box
     * it parks in, and `InlineSeat` takes it from there while the turn is on screen.
     */
    function InlineFlowBody(props) {
      const { record, url, status, handshake, frameRef, onRetry } = props;
      const slotRef = useRef(null);
      const handshakeRef = useRef(handshake);
      handshakeRef.current = handshake;

      useEffect(() => {
        const slot = slotRef.current;
        if (slot === null || slot === undefined || url === undefined) return undefined;
        const frame = document.createElement('iframe');
        frame.setAttribute('title', record.title !== undefined && record.title.length > 0 ? record.title : `HTML UI ${record.uiId}`);
        frame.setAttribute('sandbox', sandboxFor(record.security));
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('allow', 'clipboard-write');
        Object.assign(frame.style, frameStyle);
        frame.addEventListener('load', () => handshakeRef.current());
        frame.src = url;
        slot.appendChild(frame);
        // The host's own listener and the height reports find the frame through this ref, exactly
        // as they did when React rendered it.
        frameRef.current = frame;
        state.inlineFrames.set(record.uiId, frame);
        state.inlineHomes.set(record.uiId, slot);
        adoptInlineFrame(record.uiId);
        holdOverscroll(true);
        return () => {
          holdOverscroll(false);
          if (state.inlineFrames.get(record.uiId) === frame) state.inlineFrames.delete(record.uiId);
          if (state.inlineHomes.get(record.uiId) === slot) state.inlineHomes.delete(record.uiId);
          if (frameRef.current === frame) frameRef.current = null;
          frame.remove();
        };
      }, [url, record.uiId, record.title, record.security, frameRef]);

      return h(
        'div',
        { style: { position: 'relative', width: '100%', height: '100%' } },
        h('div', { ref: slotRef, 'data-htmlui-inline-slot': record.uiId, style: { width: '100%', height: '100%' } }),
        url === undefined
          ? h('div', { style: Object.assign({}, emptyStyle, { position: 'absolute', inset: '0' }) }, 'Preparing interface…')
          : null,
        status === 'error'
          ? h(
              'div',
              { style: Object.assign({}, emptyStyle, { position: 'absolute', inset: '0', gap: '8px' }) },
              h('span', null, tr('frameUnavailable', 'This interface could not be loaded')),
              h('button', { type: 'button', style: buttonStyle, onClick: onRetry }, tr('retry', 'Retry')),
            )
          : null,
      );
    }

    /**
     * One inline document's home while it is not in its seat.
     *
     * In hosted mode (no `moveBefore`) this is a fixed overlay clipped to the transcript, positioned
     * by script over the seat; the frame is drawn here for its whole life, which is why nothing can
     * destroy it. In flow mode it is only a hidden box the frame parks in when its seat leaves the
     * screen — the same box, one `display: none` and no placement loop at all.
     */
    function HtmlUiInlineHost(props) {
      const { record } = props;
      const bind = useCallback(
        (element) => {
          if (element === null) {
            inlineBoxes.delete(record.uiId);
            // The gesture a touch over this document produces is only unhandled while the
            // document is here; without it the page keeps the app's own overscroll behaviour.
            if (inlineBoxes.size === 0) holdOverscroll(false);
            return;
          }
          inlineBoxes.set(record.uiId, element);
          holdOverscroll(true);
          scheduleInlineSync();
        },
        [record.uiId],
      );
      if (FLOW_INLINE === true) {
        return h(
          'div',
          {
            'data-htmlui-inline-host': record.uiId,
            'data-htmlui-inline-flow': '',
            style: { position: 'fixed', left: '0', top: '0', width: '0', height: '0', display: 'none', overflow: 'hidden', pointerEvents: 'none', zIndex: 0 },
          },
          h(HtmlUiFrame, { record, theme: state.theme, variant: 'inline', onDismiss: dismissRecord }),
        );
      }
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
     * What it claims is a seat, not the document: everything under this tail is destroyed whenever
     * the product rebuilds the transcript — switching Session, or scrolling this turn out of the
     * virtualized window. With `moveBefore` the frame lives in the seat while the seat exists and
     * is moved to a hidden box when it goes, so the browser's own scrolling applies throughout;
     * without it the frame stays in the overlay and the bridge forwards the wheel and the finger.
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
     * Which placements can be hidden at all.
     *
     * `background` is a click-through layer and `inline` lives in the conversation, so neither
     * has anything a "minimize" could mean; every other form carries a control of its own on the
     * surface itself. The manager offers minimize/maximize exactly for the forms that have one,
     * so its button never disagrees with the surface about whether something can be put away.
     */
    function managerCanHide(record) {
      if (record.placement === 'float' || record.placement === 'fullscreen') return true;
      // dock-right is the right column's tab. With no controller bound the record falls back to
      // the composer dock, which has no hide of its own — so there is nothing to mirror there.
      return record.placement === 'dock-right' && rightPaneReady();
    }

    /**
     * Whether one interface is currently hidden — the *same* state its own hide control writes.
     *
     * Three forms, three stores, one question: a float is minimized through `state.hidden`, a
     * fullscreen one through `state.fullscreenDismissed` (the layer's own minimize) and a
     * right-column one through `state.collapsed` (the frame's own collapse). Reading all three
     * here is what makes the manager's label follow the surface instead of a copy of it that
     * drifts.
     */
    function recordHidden(record) {
      if (record.placement === 'float') return state.hidden.has(record.uiId);
      if (record.placement === 'fullscreen') return state.fullscreenDismissed.has(record.uiId);
      if (record.placement === 'dock-right') return state.collapsed.get(record.uiId) === true;
      return false;
    }

    /**
     * Hide or show one interface, by writing the very state its own control writes.
     *
     * Deliberately not a second mechanism: `restoreRecord` is the one the session page already
     * uses to bring each form back, and the hide branch below mirrors `HtmlUiFrame`'s minimize —
     * so pressing the manager's button leaves both sides in the same place, in both directions.
     */
    /**
     * Expand or collapse the whole right column, when the shell offers it.
     *
     * The column belongs to the shell, not to this plugin: `setExpanded(sessionId, …)` is its own
     * control, so this probes for it rather than assuming. A shell that does not expose it still
     * gets the child-level behaviour, which is all a guest can do on its own.
     */
    function setColumnExpanded(sessionId, expanded) {
      const controller = state.rightPane.controller;
      if (controller === undefined || sessionId === undefined || typeof controller.setExpanded !== 'function') return false;
      try {
        controller.setExpanded(sessionId, expanded === true);
        return true;
      } catch (error) {
        logWarn(undefined, '[dsh-htmlui] right pane refused to change its expansion', error);
        return false;
      }
    }

    function toggleRecord(record, props) {
      const hidden = recordHidden(record);
      if (record.placement === 'dock-right') {
        if (!rightPaneReady()) return;
        // One rule, no special cases: this button belongs to the programme's own content in the
        // column, so minimising collapses that content and maximising expands it. Expanding also
        // asks the column to expand — the call is idempotent, so a column that is already open stays
        // as it is and a collapsed one comes back together with its child.
        if (hidden) {
          // Two things, and both are needed: clearing the child's flag expands the content, and
          // `openRightPane` is the call that actually brings the column up — it is the one
          // `rightPaneReady()` just checked for. `setColumnExpanded` rides along as a best-effort
          // nudge for a collapsed column; where the shell does not expose it, nothing is lost.
          state.collapsed.delete(record.uiId);
          openRightPane(record.uiId);
          setColumnExpanded(record.sessionId, true);
          bump();
          return;
        }
        toggleCollapsed(record.uiId);
        return;
      }
      if (record.placement === 'float') {
        if (hidden) state.hidden.delete(record.uiId);
        else state.hidden.add(record.uiId);
        bump();
        return;
      }
      if (record.placement === 'fullscreen') {
        if (hidden) {
          state.fullscreen = record.uiId;
          state.fullscreenDismissed.delete(record.uiId);
        } else {
          state.fullscreen = null;
          state.fullscreenDismissed.add(record.uiId);
        }
        bump();
        return;
      }
      if (!hidden) restoreRecord(record, props);
    }

    /** 名称（slug）: the project's human name, and the id it is addressed by when they differ. */
    function managerTitleOf(template, record) {
      const slug =
        template !== undefined && typeof template.slug === 'string' && template.slug.length > 0
          ? template.slug
          : typeof record?.template === 'string'
            ? record.template
            : '';
      const name =
        template !== undefined && typeof template.name === 'string' && template.name.length > 0
          ? template.name
          : record !== undefined && typeof record.title === 'string' && record.title.length > 0
            ? record.title
            : slug;
      if (name.length === 0) return '';
      return slug.length === 0 || name === slug ? name : `${name}（${slug}）`;
    }

    /** Whether a project's process is still there, as far as this catalogue reading goes. */
    function managerBackendLive(backend) {
      if (backend === undefined) return false;
      return backend.loaded === true;
    }

    /**
     * Where a restart should put the interface back.
     *
     * The reader's last word on this project wins: where the interface is right now (they are
     * restarting *that*), else the placement the catalogue remembers it was last opened with,
     * else what its manifest declares. The create dialog's own default is the floor, so the
     * picker always opens on a chosen option rather than on none.
     */
    function managerPlacementFor(template, record) {
      const candidates = [record === undefined ? undefined : record.placement, template === undefined ? undefined : template.placementLast, template === undefined ? undefined : template.placement];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return 'dock-right';
    }

    /**
     * One program per row — the whole point of this page.
     *
     * The old model drew an interface row plus a separate "backend processes" section, which
     * meant one project could appear twice with two different sets of controls. Here a session's
     * records are grouped by the project they came from, and a project whose backend is still
     * live keeps its row even with no interface at all: that is exactly the state left behind by
     * 「关闭UI界面」, and it is where 「重启UI界面」 lives.
     */
    function managerRowsFor(sessionId) {
      const records = sessionId === undefined ? [] : recordsFor(sessionId);
      const rows = new Map();
      for (const record of records) {
        // The key is the project id, and never the uiId: several interfaces from one project are
        // one program with one process. A record built from a path or the blank canvas names no
        // project, so it is a program of its own.
        const key = typeof record.template === 'string' && record.template.length > 0 ? record.template : `ui:${record.uiId}`;
        const row = rows.get(key);
        if (row === undefined) rows.set(key, { key, slug: typeof record.template === 'string' ? record.template : '', template: undefined, records: [record] });
        else row.records.push(record);
      }
      const items = Array.isArray(state.templates.items) ? state.templates.items : [];
      for (const template of items) {
        const slug = typeof template.slug === 'string' ? template.slug : '';
        if (slug.length === 0) continue;
        const backend = backendInfoOf(template);
        if (backend === undefined || backend.declared !== true) continue;
        const row = rows.get(slug);
        if (row === undefined) {
          // No interface in this session, so the row exists only because the process does. Two
          // cases, and both are honest: the catalogue says it is loaded right now, or this session
          // closed its interface on purpose (which is remembered until the process is really gone).
          // A project that is merely declared, never opened here and not running, is somebody
          // else's — listing it in every session's manager would be a row this session cannot act on.
          if (!managerBackendLive(backend) && !state.dismissedTemplates.has(slug)) continue;
          rows.set(slug, { key: slug, slug, template, records: [] });
        } else {
          row.template = template;
        }
      }
      return Array.from(rows.values());
    }

    /**
     * Whether one row belongs to the 「跨会话的后台程序」 group rather than 「本会话的界面」.
     *
     * The host reports one session-independent fact about a process — `backend.loaded`, with no
     * sessionId — while an interface record always carries the session it was opened in. A project
     * whose process is loaded therefore *has* to be listable in a session that never opened it: that
     * is the whole meaning of a backend that outlives its panel, and it is where 「关闭后台任务」
     * lives for whoever wants to end it. A live process is the stronger fact, so a project that has
     * one belongs to the cross-session group **even when this session also has its interface open**:
     * it is one row, and the group it is under says what that row really is — a host process first,
     * this session's panel second. That is also what keeps the two groups disjoint by construction.
     *
     * The `records.length` fallback covers the other half of the same fact: a row with no interface
     * left exists only because the process is (or was a moment ago) alive, so it is a process row
     * too. Without it a row the manager itself just closed would vanish from the page for one stale
     * catalogue reading while still being counted in the header.
     */
    function managerRowIsCrossSession(row) {
      const template = row === undefined ? undefined : row.template;
      if (managerBackendLive(template === undefined ? undefined : backendInfoOf(template))) return true;
      return Array.isArray(row?.records) && row.records.length === 0;
    }

    /**
     * One session's manager page as two groups, and never a project in both.
     *
     * Kept beside `managerRowsFor` so the header count, the groups and any test all read one
     * partition instead of three versions of the same rule. The row objects are handed through
     * untouched: the groups decide *where* a row is drawn, never what its buttons do.
     */
    function managerGroupsFor(sessionId) {
      const rows = managerRowsFor(sessionId);
      // The cross-session group is decided first and wins: that is what makes a project with both
      // a live process and an open interface appear exactly once.
      const cross = rows.filter(managerRowIsCrossSession);
      const local = rows.filter((row) => !managerRowIsCrossSession(row));
      return { rows, cross, local, interfaces: local.reduce((total, row) => total + row.records.length, 0) };
    }

    /**
     * One row's two-step confirmation.
     *
     * No modal: the confirmation is the button itself, which is where the reader is already
     * looking and which cannot be missed behind an overlay. Three seconds of no second press
     * restores the original label, because a control left saying 「确认…」 forever is a trap.
     */
    function HtmlUiManagerRow(props) {
      const { row, sessionId, onStatus } = props;
      // Local by design: a confirmation belongs to the row in front of the reader, and it must
      // not survive a re-render of the page or leak into another project's row.
      const [armedState, setArmedState] = useState(null);
      const [pickingState, setPickingState] = useState(false);
      // Which placement a chosen restart actually used. Kept so the last choice stays marked
      // while the host tears the old records down and the new surface comes up.
      const [placementPicked, setPlacementPicked] = useState(null);
      // `armed` and `placementPicking` as props override the row's own state: the three-step
      // machine (idle → 确认 → act) and the placement question are then readable from one shallow
      // render each, with no timer and no second mount. The live page never passes either.
      const controlled = props.armed !== undefined;
      const armed = controlled ? props.armed : armedState;
      const setArmed = controlled ? () => {} : setArmedState;
      const pickingControlled = props.placementPicking !== undefined;
      const placementPicking = pickingControlled ? props.placementPicking : pickingState;
      const setPlacementPicking = pickingControlled ? () => {} : setPickingState;
      useEffect(() => {
        if (controlled || armed === null) return undefined;
        // 3 seconds, then back to the original label: a control left saying 「确认…」 forever is
        // the trap this whole interaction exists to avoid.
        const timer = setTimeout(() => setArmed(null), 3000);
        return () => clearTimeout(timer);
      }, [armed, controlled]);

      const records = row.records;
      const template = row.template;
      const backend = template === undefined ? undefined : backendInfoOf(template);
      const hasBackend = backend !== undefined && backend.declared === true;
      // `open` here means "this program has an interface on screen right now", which is what the
      // interface button's two jobs key off.
      const open = records.length > 0;
      const shown = records.find((record) => !recordHidden(record));
      const hidden = open && shown === undefined;
      // The one interface the hide control acts on: a visible one if there is any, otherwise the
      // first record — a row whose every interface is put away still has something to bring back.
      const hider = shown ?? records[0];
      const canHide = hider !== undefined && managerCanHide(hider);
      const title = managerTitleOf(template, records[0]);
      const armedLabel =
        armed === 'close-ui'
          ? tr('managerConfirmCloseUi', 'Close it? Unsaved runtime state is lost')
          : armed === 'close-backend'
            ? tr('managerConfirmCloseBackend', 'End the process? Its interfaces close too')
            : armed === 'close-session'
              ? tr('managerConfirmCloseSession', 'Close it? This cannot be undone')
              : null;
      const confirmThen = (key, act) => () => {
        if (armed !== key) {
          setArmed(key);
          return;
        }
        setArmed(null);
        act();
      };

      /** Close every interface of this project: the record goes, the process (if any) does not. */
      const closeUi = () => {
        // Remembered, so the row survives the catalogue refresh that follows: the process is still
        // loaded and 「重启UI界面」 is how the reader gets the interface back.
        if (row.slug.length > 0) state.dismissedTemplates.add(row.slug);
        for (const record of records) dismissRecord(record.uiId);
      };
      /** End the process *and* its interfaces: a window onto nothing is a window nobody can reach. */
      const closeBackend = () => {
        // The records go first, and deliberately **not** through `closeUi`: that one remembers the
        // slug so the row survives a closed interface — which is exactly what must not happen here.
        // A process that is gone has no row, and the row is how the reader knows it is gone. (The
        // bug this replaced deleted the memory and then called `closeUi`, which put it straight back.)
        for (const record of records) dismissRecord(record.uiId);
        if (row.slug.length > 0) state.dismissedTemplates.delete(row.slug);
        onStatus(null);
        stopBackend(row.slug).then((result) => {
          if (result !== null && result.message.length > 0) onStatus(result.message);
        });
      };
      const openPicker = () => {
        setPlacementPicking(true);
        // 预选上次用的 placement: reopening a project the way it was is the whole point of a
        // restart, and being asked again with nothing selected is a question with no default.
        setPlacementPicked(managerPlacementFor(template, hider));
      };
      const renderAgain = (chosen) => {
        setPlacementPicking(false);
        setPlacementPicked(chosen);
        // Close whatever is up first, so the chosen placement is the only copy. The render waits
        // for the host to tear the old records down: the host remembers one placement per project,
        // and a render that overtakes the close leaves the old surface drawn where it was.
        for (const record of records) dismissRecord(record.uiId);
        setTimeout(() => {
          // `applyTemplateInto`, not `applyTemplate`: the render alone leaves a dock-right
          // surface collapsed and invisible. This path used to call the render by itself and
          // nothing else, which is why choosing 右侧栏 here looked like nothing happening —
          // see `revealDockRight`.
          applyTemplateInto(row.slug, sessionId, chosen).then((ok) => {
            onStatus(ok ? tr('managerRestoreUiDone', 'Interface restored.') : tr('managerRestoreUiFailed', 'Could not restore that interface.'));
          });
        }, 120);
      };

      const controls = [];
      if (canHide) {
        // One button, two words: 最小化 while the surface is up, 最大化 once it is put away. Both
        // write the state the surface's own control writes, so the two are never out of step.
        controls.push(
          h(
            'button',
            {
              key: 'hide',
              type: 'button',
              style: rowButtonStyle,
              title: hidden ? tr('managerUiHiddenHint', 'Hidden by the interface’s own hide control — this is the same state.') : undefined,
              'aria-label': `${hidden ? tr('managerMaximize', 'Maximize') : tr('managerMinimize', 'Minimize')}: ${title}`,
              onClick: () => toggleRecord(hider, props),
            },
            hidden ? tr('managerMaximize', 'Maximize') : tr('managerMinimize', 'Minimize'),
          ),
        );
      }
      if (hasBackend) {
        // One position, two jobs: with an interface up it closes it; with none it brings one back.
        // The confirm label only ever replaces 关闭UI界面 — 重启UI界面 is not destructive, so it
        // goes straight to asking where.
        const uiLabel = armed === 'close-ui' && open ? armedLabel : open ? tr('managerCloseUi', 'Close UI') : tr('managerRestartUi', 'Restart UI');
        controls.push(
          h(
            'button',
            {
              key: 'ui',
              type: 'button',
              style: rowButtonStyle,
              title: open
                ? tr('managerCloseUiHint', 'Destroys this interface; anything it held in memory goes with it. The process keeps running.')
                : tr('managerUiClosedHint', 'The backend is still loaded; restart the UI to get the interface back.'),
              'aria-label': `${uiLabel}: ${title}`,
              onClick: open ? confirmThen('close-ui', closeUi) : openPicker,
            },
            uiLabel,
          ),
        );
        controls.push(
          h(
            'button',
            {
              key: 'backend',
              type: 'button',
              style: rowButtonStyle,
              'aria-label': `${tr('managerCloseBackend', 'Close backend task')}: ${title}`,
              onClick: confirmThen('close-backend', closeBackend),
            },
            armed === 'close-backend' ? armedLabel : tr('managerCloseBackend', 'Close backend task'),
          ),
        );
      } else {
        // No process to keep alive: closing the interface and closing the session record are one act.
        controls.push(
          h(
            'button',
            {
              key: 'session',
              type: 'button',
              style: rowButtonStyle,
              'aria-label': `${tr('managerCloseSession', 'Close session')}: ${title}`,
              onClick: confirmThen('close-session', closeUi),
            },
            armed === 'close-session' ? armedLabel : tr('managerCloseSession', 'Close session'),
          ),
        );
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            // 手机优先 / 手机: a little more air per program, and a light rule under it so rows that
            // wrap to three lines do not read as one block.
            padding: '10px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: '0' } },
          h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto', minWidth: '0' }) }, title),
          // The state marks: what this program is (带后台 and its residency), what the process is
          // doing (已加载/未加载), and whether an interface is open at all. All of them come from
          // the catalogue's `backend` field — nothing here invents a state of its own.
          hasBackend ? chip(tr('backendBadge', 'Backend'), 'badge') : null,
          hasBackend ? chip(tr('backendAllowed', 'Allowed'), 'allowed') : null,
          ...(backend === undefined ? [] : backendChips(backend, false)),
          open
            ? null
            : h(
                'span',
                {
                  key: 'closed',
                  style: chipStyle,
                  title: tr('managerUiClosedHint', 'The backend is still loaded; restart the UI to get the interface back.'),
                },
                tr('managerUiClosed', 'UI closed'),
              ),
          records.length > 1 ? chip(`×${records.length}`, 'count') : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: '0' } },
          h(
            'span',
            { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } },
            open ? records.map((record) => record.placement).join(' · ') : '—',
          ),
          h(
            'span',
            { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } },
            hidden ? tr('managerHidden', 'hidden') : '',
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          ...controls,
        ),
        // 重启UI界面 asks where before it re-renders: the same choices, and the same words, the
        // create dialog offers — a reader who picked 全屏 once should not have to learn a second
        // vocabulary to get it back.
        placementPicking
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' } },
              h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('managerPlacementTitle', 'Show it again as')),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                ...CREATE_PLACEMENTS.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.value,
                      type: 'button',
                      style: Object.assign({}, rowButtonStyle, entry.value === (placementPicked ?? managerPlacementFor(template, hider)) ? rowButtonActiveStyle : null),
                      onClick: () => renderAgain(entry.value),
                    },
                    tr(entry.key, entry.fallback),
                  ),
                ),
                h('button', { key: 'cancel', type: 'button', style: rowButtonStyle, onClick: () => setPlacementPicking(false) }, tr('cancel', 'Cancel')),
              ),
            )
          : null,
      );
    }

    /**
     * The session's HTML programs, listed where the reader already is.
     *
     * One row per program — interface open or not — because the process behind it is what outlives
     * every panel, and the row is the only place left that can end it. `background` is
     * click-through by design and `inline` is seamless, so without this page a user has no way to
     * remove what a model attached; `conversation.view` is the shipped seat for a session-scoped
     * page like this one, and its label is the row it appears in.
     */
    function HtmlUiManager(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      // Stopping a backend answers here, not in the drawer: this page is where the reader
      // pressed the button, and a message anywhere else reads as nothing having happened.
      const [status, setStatus] = useState(null);
      // A project with a resident backend keeps running after its panel is gone, so this page is the
      // only place left that can end it — and "is it loaded" is a fact only the host has. The
      // catalogue is therefore re-read while this page is open, not once per mount: a panel that
      // started a second ago loaded its backend without telling anyone here, and a control disabled
      // by a stale reading is worse than no control at all. A hidden page asks for nothing: nobody
      // is reading the answer.
      useEffect(() => {
        if (backendCatalogueStale()) loadTemplates();
        const timer = setInterval(() => {
          if (document.hidden !== true) loadTemplates();
        }, 5000);
        return () => clearInterval(timer);
      }, []);
      // Two groups, one partition: 跨会话的后台程序 first, 本会话的界面 second. A project appears in
      // exactly one of them (see `managerRowIsCrossSession`), so nothing is listed twice.
      const groups = managerGroupsFor(sessionId);
      const rows = groups.rows;
      // A section is drawn only when it has something in it: an empty group with a heading and a
      // sentence under it is noise, and the header still counts everything on the page.
      const section = (title, hint, list) =>
        list.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', minWidth: '0' } },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '1px', padding: '2px 2px 6px' } },
                h('span', { style: Object.assign({}, titleStyle, { whiteSpace: 'normal' }) }, `${title} (${list.length})`),
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', lineHeight: '15px' } }, hint),
              ),
              ...list.map((row) => h(HtmlUiManagerRow, { key: row.key, row, sessionId, props, onStatus: setStatus })),
            );
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', padding: '10px 12px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' } },
          h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${tr('managerTitle', 'HTML programs')} (${rows.length})`),
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
                // A fresh opening is a fresh chance to announce what the folder holds, and to let
                // the chosen project's own placement apply again.
                state.create.autoShown = false;
                state.create.placementBound = false;
                bump();
                loadTemplates();
              },
            },
            tr('managerNew', 'New HTML project'),
          ),
        ),
        // Said in the header, not on a row: a stop that worked needs no sentence (the row
        // disappearing is the whole answer) and the two cases where nothing visibly happened —
        // nothing was running, or the stop failed — have to speak up somewhere the reader looks.
        status === null
          ? null
          : h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '6px' } }, String(status)),
        rows.length === 0
          ? h('div', { style: emptyStyle }, tr('managerEmpty', 'This session has no HTML program.'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', minHeight: '0', overflowY: 'auto' } },
              section(
                tr('managerGroupCross', 'Backend programs (cross-session)'),
                tr('managerGroupCrossHint', 'Their process runs inside the DSH host, not in a conversation: it stays up after this session closes, which is why a program you never opened here can be listed.'),
                groups.cross,
              ),
              // 本会话这一区为空、但后台区不为空时要说一句：否则读者只会看到一页「别的会话的程序」，
              // 却不知道本会话为什么什么都没有。
              groups.cross.length > 0 && groups.local.length === 0
                ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', padding: '2px 2px 6px' } }, tr('managerGroupSessionEmpty', 'This session has no interface open.'))
                : null,
              section(
                tr('managerGroupSession', 'Interfaces in this session'),
                tr('managerGroupSessionHint', 'Every interface recorded in this session: plain front-end pages, and projects whose backend is running with an interface open.'),
                groups.local,
              ),
            ),
        groups.interfaces === 0
          ? null
          : h(
              'div',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginTop: '8px' } },
              `${tr('managerMinimize', 'Minimize')} / ${tr('managerMaximize', 'Maximize')} ${tr('managerHintHide', 'is the same hide the interface’s own control does.')} ${tr('managerHintRest', 'Closing the interface throws it away and keeps its process; ending the process takes the interfaces with it.')}`,
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
        // Only a record the host has actually handed this page may open the column. `publish` already
        // refuses the ones the host does not list — history in the transcript — and this effect was
        // ignoring that refusal, because it used the record it had just built from the block instead
        // of asking whether anything live stood behind it. So every recorded right-column card
        // revealed itself on every load, one at a time, always in whichever session was mounted: that
        // is why the sessions which had ever developed a template came back with the column open, and
        // why closing it there never lasted.
        if (state.liveIds.has(record.uiId) !== true) return;
        openRightPane(record.uiId);
      }, [
        record === undefined ? undefined : record.uiId,
        record === undefined ? undefined : record.placement,
        rightPaneController,
        rightPaneTab,
        // A card whose record the host hands over after this effect first ran still has to reveal
        // itself, so the store's own answer is part of the condition (a primitive, so the dep is
        // stable).
        record === undefined ? undefined : state.liveIds.has(record.uiId),
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
      //
      // 那个 ✕ 拦不住：它是宿主的组件（`DockLayout` 的 tab chip），登记的 tab 类型里没有任何
      // 关闭前的钩子（见 `SidebarRightTabDefinition`：全是静态字段），所以误触一次就是上面这条
      // 卸载路径 —— 本会话全部 dock-right 界面一起被销毁。这是宿主的行为，插件不解释、不提示。
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
        // The column can say when the reader closes our tab: that is the signal this plugin used to
        // guess at from a body unmount, and guessing is exactly how interfaces came to outlive the
        // tab that held them. With the hook, closing the tab retires them, deliberately and once.
        if (typeof controller.registerCloseHandler === 'function') {
          try {
            const release = controller.registerCloseHandler(TAB_KIND, (sessionId) => {
              retireDockRightRecords(sessionId);
            });
            if (typeof release === 'function') disposers.push(release);
          } catch (error) {
            logWarn(undefined, '[dsh-htmlui] right pane refused a close handler', error);
          }
        }
        // The decision may already have been taken before the column arrived — at boot the records
        // are known first — so it is taken again now that closing has become possible, and again
        // whenever the column's own view of its tabs changes, which is when a saved layout lands.
        syncRightPane();
        watchRightPaneTabs(controller, disposers);
        // A session's layout keeps our tab after the records that opened it are gone, and the shell
        // restores that layout on every load, so the column opens itself on an empty panel. Closing
        // it needs the column's seat, which binds after plugins are injected: hence the retries, the
        // same ones the reveal path uses for the same reason.
        closeStaleRightPaneTab();
        for (const delay of DOCK_REVEAL_RETRY_MS) {
          setTimeout(() => closeStaleRightPaneTab(), delay);
        }
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
      // why an empty session still had an HTML UI tab in its column.
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

    /**
     * Retire the interfaces a session's tab was holding.
     *
     * The shell tells us before it removes that tab, so the interfaces go with it rather than
     * lingering as records whose surface no longer exists. This replaces the guess the plugin used to
     * make from a body unmount — the same guess that made a stale layout possible in the first place.
     */
    function retireDockRightRecords(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      for (const record of recordsFor(sessionId)) {
        if (record.placement === 'dock-right') dismissRecord(record.uiId);
      }
    }

    /**
     * The tab records the column still holds for a session, from either of its two published views.
     *
     * `tabsIn` is the per-session view and is **empty before the session's store is adopted**, which
     * is exactly how the first attempt at this silently did nothing; `openTabs` is the cross-session
     * view and is populated for saved layouts too, so it is the fallback that makes the check work
     * whenever it happens to run.
     */
    function rightPaneTabsFor(controller, sessionId) {
      const mine = [];
      try {
        for (const tab of controller.tabsIn(sessionId) ?? []) {
          if (tab !== undefined && tab !== null) mine.push(tab);
        }
      } catch {
        /* not readable yet: the cross-session view below may still be */
      }
      try {
        const source = controller.openTabs;
        const all = source !== undefined && typeof source.getSnapshot === 'function' ? source.getSnapshot() : [];
        for (const tab of Array.isArray(all) ? all : []) {
          if (tab === undefined || tab === null) continue;
          if (typeof tab.sessionId === 'string' && tab.sessionId !== sessionId) continue;
          if (!mine.some((seen) => seen.id === tab.id)) mine.push(tab);
        }
      } catch {
        /* nothing readable: leave the column alone rather than guess at it */
      }
      return mine;
    }

    /**
     * Watch the column's own list of open tabs, so a stale one is closed whenever it (re)appears.
     *
     * Closing at boot is not enough by itself: the shell loads a session's saved layout *after* plugins
     * are injected and puts its tab back, which is why this session came up on an empty panel however
     * many times the browser was restarted or its cache cleared. Both of these subscriptions re-run
     * the same check whenever the column's view of its tabs, or of its mounted session, changes.
     */
    function watchRightPaneTabs(controller, disposers) {
      const sources = [];
      if (controller.openTabs !== undefined && typeof controller.openTabs.subscribe === 'function') sources.push(controller.openTabs);
      if (controller.mounted !== undefined && typeof controller.mounted.subscribe === 'function') sources.push(controller.mounted);
      for (const source of sources) {
        try {
          const stop = source.subscribe(() => {
            closeStaleRightPaneTab();
          });
          if (typeof stop === 'function') disposers.push(stop);
        } catch (error) {
          logWarn(undefined, '[dsh-htmlui] right pane refused a tab watch', error);
        }
      }
    }

    /**
     * Close the column's tab when this session's layout still holds it and nothing else does.
     *
     * The column keeps its own layout per session, and a tab in that layout outlives the records that
     * opened it: the shell then restored the column with our tab in it on every load — an empty panel
     * that came back by itself, unbothered by restarts or a cleared browser cache, because the state
     * is the reader's own layout. `tabsIn` is the published way to see it and `close` the published
     * way to take it away; both are feature detected, since a column without them should keep today's
     * behaviour rather than have its internals guessed at.
     */
    function closeStaleRightPaneTab() {
      const controller = state.rightPane.controller;
      if (controller === undefined) return false;
      // Each branch asks only for what it needs: closing a tab needs `close`, and collapsing an empty
      // column needs neither `close` nor anything else that branch would have required.
      if (typeof controller.tabsIn !== 'function') return false;
      const mounted = controller.mounted;
      const sessionId = mounted !== undefined && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      // Only when the tab has no reason to exist: a session with right-column interfaces is using it.
      if (recordsFor(sessionId).some((record) => record.placement === 'dock-right')) return false;
      const held = rightPaneTabsFor(controller, sessionId);
      const mine = held.find((tab) => tab.kind === TAB_KIND || tab.id === TAB_ID);
      if (mine === undefined) {
        // Nothing of ours. And when there is nothing of anyone else's either, the column is an empty
        // shell left standing by a layout that outlived its content: the shell collapses the column
        // only when it *cannot* close the tab, so taking our tab away was half the job — `expanded` is
        // persisted per session and stayed true, which is the pop the reader still saw.
        if (held.length > 0) return false;
        if (typeof controller.isExpanded !== 'function' || typeof controller.toggleExpanded !== 'function') return false;
        if (controller.isExpanded() !== true) return false;
        try {
          controller.toggleExpanded();
          return true;
        } catch (error) {
          logWarn(undefined, '[dsh-htmlui] right pane refused to collapse', error);
          return false;
        }
      }
      const tabId = typeof mine.id === 'string' && mine.id.length > 0 ? mine.id : TAB_ID;
      if (typeof controller.close !== 'function') return false;
      try {
        controller.close(tabId);
        if (state.rightPane.opened !== undefined) state.rightPane.opened.clear();
        return true;
      } catch (error) {
        logWarn(undefined, '[dsh-htmlui] right pane refused to close a stale tab', error);
        return false;
      }
    }

    /** Take the tab back out of the column. */
    function releaseRightPaneTab() {
      // Before the type goes, and even when this page never registered it: the column may still be
      // holding our tab open from an earlier visit, and only the shell can take that away.
      closeStaleRightPaneTab();
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
     * The fullscreen layer's own title row.
     *
     * It is a component rather than a few elements built inline in `overlayLayers` because the ✕
     * here needs the same two-step confirmation as every other close control, and a two-step is
     * state: one instance per record (the layer array is keyed by `uiId`) keeps every interface's
     * question its own instead of sharing one flag across the session's fullscreen surfaces.
     *
     * The bar used to spell its own two controls out — a worded dismiss and a labelled
     * 「关闭」— and that was the last place where the same two acts wore a different shape
     * from the float's '—' and '✕'. Both now come from the factories above — `windowMinimizeButton`
     * and `windowCloseButton` — so the 22px size, the 6px radius, the '—' and '✕', and the words
     * 最小化/关闭 are the float's own. The *tree* did not move with them: this row still writes
     * exactly two buttons after the title, as it always has, because a wrapper here once cost the
     * layer its coverage. The semantics are unchanged: minimizing hides the layer
     * (`state.fullscreenDismissed`) and leaves the record and its document alone, so it stays
     * unconfirmed and stays the safe way out; the ✕ still asks first.
     */
    function HtmlUiFullscreenChrome(props) {
      const { record, onLeave, onDismiss } = props;
      const closeConfirm = useCloseConfirm(onDismiss);
      const title = record.title !== undefined && record.title.length > 0 ? record.title : record.uiId;
      return h(
        'div',
        { style: Object.assign({}, surfaceChrome, { minHeight: '36px', padding: '0 10px' }) },
        h('span', { style: titleStyle }, `${title} ${tr('fullscreenSuffix', '· fullscreen')}`),
        // 全屏的最小化就是浮动窗那个最小化：它只隐藏图层（`state.fullscreenDismissed`），记录和
        // 文档都原样留着，因此它渲染的是同一套样式常量 —— 同样的字形、同样的尺寸、同样的说法，
        // 只是它渲染在这一行里，而不再经过任何包装节点。
        windowMinimizeButton(onLeave, tr('minimize', 'Minimize')),
        windowCloseButton(closeConfirm),
      );
    }

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
      //
      // The layer starts below the Desktop shell's native title bar when there is one: its own
      // minimize and close controls sit at the top edge, and underneath that bar the native window
      // buttons take the click — a fullscreen interface that cannot be closed.
      const titlebarInset = desktopTitlebarInset();
      for (const surface of records.filter((entry) => entry.placement === 'fullscreen')) {
        const active = fullscreenRecord !== undefined && fullscreenRecord.uiId === surface.uiId;
        layers.push(
          h(
            'div',
            {
              key: `fs-${surface.uiId}`,
              style: {
                position: 'fixed',
                top: `${titlebarInset}px`,
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
                height: titlebarInset > 0 ? `calc(100% - ${titlebarInset}px)` : '100%',
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
            h(HtmlUiFullscreenChrome, { record: surface, onLeave: () => leaveFullscreen(surface.uiId), onDismiss: () => dismiss(surface.uiId) }),
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
          // Minimize the layer and keep this interface put away until the user
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
          // Nothing is hosted, so a scroll has nothing to place: the whole handler gets out of
          // the way instead of walking seats that were never claimed.
          if (inlineBoxes.size === 0) return;
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
        // A touch on the page — not on a document — is the reader saying stop; the frame cannot
        // see it, so the host forwards the intent.
        window.addEventListener('touchstart', haltInlineFling, { capture: true, passive: true });
        return () => {
          window.removeEventListener('scroll', place, { capture: true });
          window.removeEventListener('resize', place);
          window.removeEventListener('touchstart', haltInlineFling, { capture: true });
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


    // ------------------------------------------------------------ create dialog

    /**
     * The black-and-white frame the create dialog is drawn in.
     *
     * The plugin's other surfaces follow the shell's own tokens; this one deliberately does not.
     * It is the panel a reader opens to *start* something, and the wireframe it was designed from
     * is monochrome: black rules, white paper, grey chips, one green for a process that is alive.
     */
    const BW = {
      ink: '#111111',
      muted: '#6f6f6f',
      line: '1.5px solid #111111',
      none: '1.5px solid transparent',
      chip: '#c7c7c7',
      green: '#12a150',
    };

    /** The largest icon the host will take; the form refuses earlier so the reason is immediate. */
    const ICON_MAX_BYTES = 64 * 1024;

    /**
     * A sub-dialog's title.
     *
     * Those panels are narrower than the main one and scroll inside themselves, so they carry a
     * title line instead of the legend-on-the-rule the two main boxes use — at their size a legend
     * would sit under the pointer rather than above the content it names.
     */
    const subTitleStyle = { fontSize: '16px', fontWeight: 700, color: BW.ink, margin: '2px 0 10px' };

    /** The dialog's field shape, shared by every input it draws. */
    const bwFieldStyle = {
      boxSizing: 'border-box',
      width: '100%',
      font: 'inherit',
      fontSize: SHEET_FIELD_FONT,
      padding: '7px 10px',
      borderRadius: '8px',
      border: BW.line,
      background: '#ffffff',
      color: BW.ink,
    };

    /** One button of the dialog's footer: filled for the act, outlined for leaving. */
    function bwButtonStyle(primary, narrow) {
      return {
        font: 'inherit',
        fontSize: narrow ? MOBILE.buttonFont : '14px',
        lineHeight: 1.2,
        height: narrow ? MOBILE.buttonHeight : '36px',
        padding: narrow ? '0 16px' : '0 22px',
        borderRadius: '8px',
        border: BW.line,
        background: primary === true ? BW.ink : '#ffffff',
        color: primary === true ? '#ffffff' : BW.ink,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      };
    }

    /**
     * The create dialog's artwork, inlined.
     *
     * The browser half is one module, and these nine images are the ones the panel is drawn with.
     * Inlining them keeps the panel identical on a host that predates the asset route, and keeps
     * the dialog in one file: `assets/icons/*.png` in the repository is the source these were
     * encoded from.
     */
    const ICONS = {
      calculator: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAOxAAADsQBlSsOGwAAB35JREFUeJztmltsVMcZx39z9uyuL9jYxja+BOxgE5NWbkqkJBUhFBFBC0qkRn2rEgJt0gaKeqGqEh6aEKEorSqI06jQi5RIEUqqVBCEeEFNq1ZKVKKkXHqhOI4NNjb4ml2vL7s+e875+uCsL/We5ezVm9b/p505szPz/c7MfN+ZGVjSkpa0pCX9/0olevj6ibPVwcjE/qhlr0dsXzY68LcPzoHyZLxeTSnD6/NeqCguO3L4+R8POpVzBPDz109U22b0g6hprc547+bo3Ht/RikPSss8BIACn6/HV1x6z/HDz8eFoDn90YxO7c+28TGJWIhtZaXuiGGsngwF9js9dwQQNe31WemRg7IJIWqajrY4AsjWnE+k7EEQR1ucASySRCxEsjMS4invAACIbSFi56StvAQAILaZEwh5CwBmIXh1Pe5zp/xklNcAAHxejQN7v8Wjjzw0L9/v83Fg7xML8pNV+gizrLKSElZWraCl6XYAjr99Br/Px9NPfZOWpkZQ0yMhapop1Z8SAK/uocDvzktGoxYRw0ilGQAGhkc49PJRfvL9vWzfvBGPptFQX0dLUyPtXdf42bFXUzYeUgTQvKqObV9yFydd7urhD+9fTKWZGd0YGJyBsG3TBoAZ46fSgAspApiMROgdGHZVNhAaT6WJBRoJBBka+YSy0lIAuntvpG08pAig++YQ3TeH0m7crfw+H89899usvb2RjqvXqFpRwbZNG7Bsm+Nvn0mr7rz3AjHj1zWt4UpnFy+88isOvXyUYCjE9s0b0/YCeQ+grLSEmqpKrnR28dNf/oYpw5hZE4KhEHfdeQdFBQUp15/3bnBgeISDR14hGBqbN+djECbCYSbCYUChVML9nbjKewAwDSGebgzM7nEoTUeEpCHk/RRwK7GnYwERSep//zMAYBYCuIfwmZgCs29VZm2bM9Rnh70gdhQ0L25nQt4CEBFEhNKVFXjW1GLULccqK8L06ygBT9jAOzKBry/AREcfkbEJlJpeCGch3JpC3gEQEfRCH0UbPsfYvWvoqPQzJk6xfiXQQCX3UNUdpPivHxM634HYAi4h5A0AEUFpimUPfpGBLev4t+/TbTFH42c1TJThhmK0hrto/Gory0+fZ+xSFxrTEBIpLwCICL6q5UR2fZmLK/0Iqe0J2kBXmYZ/5700/6MR83fvIkYUpZzNdHzSPxJE07LvJEQE79o6Bnbdz7A/M3VOYfOv1koaanZQ+Ot3MIMTjmUX1Q2KCJ61tfQ+sTFjxs9Vd5WP4L6tqPJix4Vg0QCICEaJTv+u+wl5kgteklF/mZfxH+5o3Hj0mfJ4zxcHgAgWNp1bGwj6k4/fk9XNIhq8D215CVhwALkoAESE4dZK+iqycyAaT0MF6rFN59/a8t/5uQcgwpQXuu6uTCJgTV8GtjZRU3YImOcXcw5AgMF15Ywnds9Z0aTOfV/48I0H5ublHIBtW/S1lOW6WQAsBKuydCdz7M4IgLKSYl7c9zhPPvKVxAVFGC/RmSjP+cHzjCyfZzvNs9Mgp5GgAKM1hbg98WtQhVQqd3Plmh1mhOit+6Br1fW/aGvp2/GDv8MihMJj5e4jnt16PQ/r1a7KPmd0cMa69U61AIW1Va1A7gGICJFi901etEPg8tCnVyKu67W92qrY75QArF1dx+a7W2fSuj7tz2srK3jya/PXgd+eOjsvbXrdBz6nrEFOWY4XvNKQKon9SglASVEha26rWZBf6PfFzZ8nO5feP77EtmaWoZQA/LOzm66+/pn08mXFPPX17fT0D/Hm2b8k/K8ecX+QedDbnPE1AICoHZjpj+vezJERNTGiCw0xLYvgmPOnp1KKwlH353lBiXLDdje3wy5vk4gI0bHxq7F0zr3AsuHI9O6Pi/26NrObNrM7sx0wLTEut1+KJXMaCSqgYmgK4oyeXMkORzoG97Zdj6UzMgImI1P8/p13GZ8MJy6oFEWmRknPKOPNlZloOjmJYAdCp5njXDMCwIianL/S6aqs0jTqLgdob1qR0lleOrIN0wp/+NFrzDk5yfnHkALq+038N0dz3TTWSOBk/54X2+fm5X4/QCl0zUPTuUHEyt2NUHsyMhl6//KzMH/LORGA9O+fOEgpRf2wzYpL/UkfZqYisWyMzr6DI9+Z//YhAQDLNC9ks1NK0/j8+VEKrgduXTgNiQjRvsETPQ/ubSPOqakjgInQ6BEzavRkq2NKKQrQWf/HfrxZWg9EBPPG8J+uHT2xG+J/Kydchh/90XPV/oLC/R6vvh7Iyi6GAKMeQ114uLGR2oqGTHkGsWyivQMnrh07uZtXT485lcutH0qg5Xu+UV72+IMveW+reUzz6WktzvZEeNL4uPdgz9Z9bTi8+ZjyBsCn8tS+9cKWgjvXHNJXlN6nkrkMLYIdMSxrOHgy9N7FZ0e+d6QdFzcl8g1ATN76Nw49oN+xaqdesmy7VlxQjVdfEDiJCBIxxA5HOqxPRk9PXbryWv+ew+3g/nQ1XwHEpNGMt/rpAy2+mqpWVVq8SulaiRJs27ACZiB01fro6qXBA8euMx3eLv5mw5I+Y/oPUPj3jJG6530AAAAASUVORK5CYII=',
      camera: 'data:image/png;base64,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',
      'dock-right': 'data:image/png;base64,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',
      float: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAARRQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////SKzSWAAAAFp0Uk5TAAMVHhQWjtPh0o0C/ogB++TgOR3Z+Ac4QAgJDXe8wL0Pffx7yM4SGdj29+xcPT8+VujmJvnJv8fnLgbihJeWlaPz2xqu/TYMamlZHxPQGKChBCm19PW4KBE7H7eRVQAAAAFiS0dEW3S8lTQAAAAJcEhZcwAADsQAAA7EAZUrDhsAAAFHSURBVFjD7dZ3T4NAHIDhA7SCVkYZLVq1jmLVOqt1U/feu/f9P4hWjQnej9xAEyW8/5AQeELuOA6EUpgkK4x1SdD93bkelTGtVybv78th9vL9OgHIGgeANfIRFBVjw7Toz2+ZBsaqAgJmwaaPoF0wYwHgNFDMlRmAkO24rmMnALxiqVT0EgDs/SSg+wNs+ToIDJaHhtkaKVcgYNRgXn1j4wBQmeBYv9WABCZrb18Gd4redB5jSwEAB+OZ+uwcrfmFxci8RYClBv/Epw1IPIjM0xgHMPdrwPJKk7qSmqtuPLC2vkFdy15j8y+/Bxnw74BgazsMw9bOrijQOX62t58QOPATAYfVIyQCHNdPTt87O0dCwPcyIDWAyFc5AojsC19dXHLsTLUrEpCuOYCbW2Bw7u4fGPbmTo9Pz+DwvrSpPwcftQOUxl4Bobk8ZA0+nbIAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjAtMDUtMjZUMTk6MDU6NDQrMDE6MDCBsX89AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDIwLTA1LTI2VDE5OjA1OjQ0KzAxOjAw8OzHgQAAAEZ0RVh0c29mdHdhcmUASW1hZ2VNYWdpY2sgNi43LjgtOSAyMDE5LTAyLTAxIFExNiBodHRwOi8vd3d3LmltYWdlbWFnaWNrLm9yZ0F74sgAAAAYdEVYdFRodW1iOjpEb2N1bWVudDo6UGFnZXMAMaf/uy8AAAAYdEVYdFRodW1iOjpJbWFnZTo6aGVpZ2h0ADUxMsDQUFEAAAAXdEVYdFRodW1iOjpJbWFnZTo6V2lkdGgANTEyHHwD3AAAABl0RVh0VGh1bWI6Ok1pbWV0eXBlAGltYWdlL3BuZz+yVk4AAAAXdEVYdFRodW1iOjpNVGltZQAxNTkwNTE2MzQ0DUwAFgAAABN0RVh0VGh1bWI6OlNpemUAMy44NktCQvblhYUAAABKdEVYdFRodW1iOjpVUkkAZmlsZTovLy4vdXBsb2Fkcy81Ni9vQXVVbWo1LzIzODUvd2luZG93X3Jlc3RvcmVfaWNvbl8xNDQwMjcucG5nh5OUTgAAAABJRU5ErkJggg==',
      folder: 'data:image/png;base64,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',
      fullscreen: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABABAMAAABYR2ztAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAACFQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////bW9u0wAAAAl0Uk5TAAECaqek36UE0/iVRgAAAAFiS0dECmjQ9FYAAAAJcEhZcwABOvYAATr2ATqxVzoAAABnSURBVEjHY2AYBYMMMCqBgQA6Gw6EXUOBIMQQnQ0HqjPBIAidTWcF6ciOLMOioALZm+1YFATh4w8NBcKuqJGDzgf5XQAffxRAAcGAIhjUgyE9UEUBwYxDMOsNePlAsBAjWAyOgkEAAIx1jun7jgK3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDE4LTAzLTA4VDEwOjAyOjM1KzAxOjAw7o4eQwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAxOC0wMy0wOFQxMDowMjozNSswMTowMJ/Tpv8AAABGdEVYdHNvZnR3YXJlAEltYWdlTWFnaWNrIDYuNy44LTkgMjAxNi0wNi0xNiBRMTYgaHR0cDovL3d3dy5pbWFnZW1hZ2ljay5vcmfmvzS2AAAAGHRFWHRUaHVtYjo6RG9jdW1lbnQ6OlBhZ2VzADGn/7svAAAAGHRFWHRUaHVtYjo6SW1hZ2U6OmhlaWdodAA1MTLA0FBRAAAAF3RFWHRUaHVtYjo6SW1hZ2U6OldpZHRoADUxMhx8A9wAAAAZdEVYdFRodW1iOjpNaW1ldHlwZQBpbWFnZS9wbmc/slZOAAAAF3RFWHRUaHVtYjo6TVRpbWUAMTUyMDQ5OTc1NZp8PXkAAAATdEVYdFRodW1iOjpTaXplADEuODVLQkJzzztCAAAAQXRFWHRUaHVtYjo6VVJJAGZpbGU6Ly8uL3VwbG9hZHMvNTYvVUpnelpYRi8xMzY5Ly1mdWxsc2NyZWVuXzg5ODIyLnBuZ90gZoAAAAAASUVORK5CYII=',
      inline: 'data:image/png;base64,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/P8CzVYhza0+bmR+Gt8r4vJ3ipuY499Ni+c8y7iLre14NnsBurKO5Hlt7C7iIi5iIP4Ps3J17pbhfFsAAAAldEVYdGRhdGU6Y3JlYXRlADIwMTktMDEtMDJUMTU6NDg6MDkrMDE6MDCKWvuRAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDE5LTAxLTAyVDE1OjQ4OjA5KzAxOjAw+wdDLQAAAEZ0RVh0c29mdHdhcmUASW1hZ2VNYWdpY2sgNi43LjgtOSAyMDE2LTA2LTE2IFExNiBodHRwOi8vd3d3LmltYWdlbWFnaWNrLm9yZ+a/NLYAAAAYdEVYdFRodW1iOjpEb2N1bWVudDo6UGFnZXMAMaf/uy8AAAAYdEVYdFRodW1iOjpJbWFnZTo6aGVpZ2h0ADUxMsDQUFEAAAAXdEVYdFRodW1iOjpJbWFnZTo6V2lkdGgANTEyHHwD3AAAABl0RVh0VGh1bWI6Ok1pbWV0eXBlAGltYWdlL3BuZz+yVk4AAAAXdEVYdFRodW1iOjpNVGltZQAxNTQ2NDQwNDg5BAUGwAAAABN0RVh0VGh1bWI6OlNpemUAMjEuNEtCQue7lNYAAABjdEVYdFRodW1iOjpVUkkAZmlsZTovLy4vdXBsb2Fkcy81Ni9XVzJXUEpiLzE3NDQvMzY0MzcyOC1iYWxsb29uLWNoYXQtY29udmVyc2F0aW9uLXNwZWFrLXdvcmRfMTEzNDEzLnBuZ1GHcY0AAAAASUVORK5CYII=',
      notepad: 'data:image/png;base64,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',
      pencil: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAdpQTFRFAAAAAAAEAQABAQACAAABAAACAgACAQAFAQAAAQADAgADAwABCgAAAQACAQACAAACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAAACAQACAQACAQACAQACAQADAQACAQACAQACAQACAQACAQACAQADAQACAQACAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQADAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQACAQABAQACAQACAQACAQACAQADAQACAQACAQACAQACAQACAQACAQAC////XJntZgAAAJx0Uk5TAAAAAAAAAAAAAAAAABUNAUCDhDAjuJMDY+b+Xbv7kgt98Zn5JbD90mxpZ476kTrLswY/9hO2Ak/b2TEJigVt691DC4mQD4bz+OBHDJwZo0oihwp7MypF8mvcAQTRwgu0yS847oLKmp4DLkx4O9XU7D31dgcG4zZ1BsPOetcpc7muXCBTGJQ+DsQ3741J4TwRAVIkj3ABAseVllkXwa8F5gAAAAFiS0dEnQa78rEAAAAJcEhZcwABKCUAASglAevtVZ4AAAJ1SURBVFjD7db5U9NAFMDxNM96F0FFsLRylGKVKErxQA0eCPVArHiUQ/HE+wBE6g3eByreou4f6ybZpm2yyb51xhln9P3E7OT7KdlktlWU//NbE1BDJeBehkWlZYt9pmwJiwKwtHyZW4CKyuXEb8JVkOsjJLrCKUB1TS3BAGZPXAKE6mIEA7DeIQDUxxvYdSsTq1yzulFjgN1TYY0twKy1TfYHrVuvuve3OckAaNlgX2kLsHHTZiIGWrcYwNZtMacAett2IgZ27AzONv7c1V4g7O6gKx2dKSIE9uzdN0eF+sr9UCRoXQoc6I4SIVDaenDuPEhHtEM9RULtYeVIeZiIgaPH6JNK0/2PUUHtyQmZXl3pcz5uLtDfb/WWANWWkEkMgEIwgPH80+z55/8Hs0cCrD9ec4IJg+2a1buBkxyA9adOw5mzubs412v2JjB0vsueC20XVa/+EsDlVG4f9ArrNTSAK5zTgd9fvcb2YdBOxEBhf53d541hPMDrR0ZvogF+P5YvBICwFwDi3h9A9L4ApvcDUL0PgOu9AWTvCWB7LwDdewD4ng9I9FxApucCMj0PgPmNdPHWuH1+0D572+t15wEld+ji3VBBP+rZc4FxenISrfve/YLPp/vyALuJ8LD4nDbun/YTVUgABiZ5fST8CAs87uP1BA880Ry9Ak8nCGlAArDgmbNX4HlSAnjxMt+nsub7Y/7EQQOvXltxODM09cY6/+WArLEUfTuZeDf9nn1NygCgx0mqaerDx7GFwfyiDNDy6fPw9BfHqyUDfNUDQedFUnvAm78f+Dbz3X9m4lFfADd/CkiiZ+QHF2jGz0/RXv+r8ws47fJ/RXeXlgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAxOS0wMy0zMFQwODo1Nzo0MyswMDowMFj0sBMAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMTktMDMtMzBUMDg6NTc6NDMrMDA6MDApqQivAAAARnRFWHRzb2Z0d2FyZQBJbWFnZU1hZ2ljayA2LjcuOC05IDIwMTktMDItMDEgUTE2IGh0dHA6Ly93d3cuaW1hZ2VtYWdpY2sub3JnQXviyAAAABh0RVh0VGh1bWI6OkRvY3VtZW50OjpQYWdlcwAxp/+7LwAAABh0RVh0VGh1bWI6OkltYWdlOjpoZWlnaHQANTEywNBQUQAAABd0RVh0VGh1bWI6OkltYWdlOjpXaWR0aAA1MTIcfAPcAAAAGXRFWHRUaHVtYjo6TWltZXR5cGUAaW1hZ2UvcG5nP7JWTgAAABd0RVh0VGh1bWI6Ok1UaW1lADE1NTM5MzYyNjPLmQHJAAAAE3RFWHRUaHVtYjo6U2l6ZQA4LjM4S0JCY+2XXQAAAEV0RVh0VGh1bWI6OlVSSQBmaWxlOi8vLi91cGxvYWRzLzU2L1JpNkJCUXovMTg2Mi9zaGVldGFuZHBlbmNpbF8xMTgzNjEucG5nUGHjrwAAAABJRU5ErkJggg==',
    };

    /**
     * One asset the dialog draws with: the wireframe's own artwork.
     *
     * The folder, the pencil and the four ways in are line art that cannot be reproduced from a
     * font, and drawing them again as SVG would only approximate the files the panel was designed
     * from. They travel with this module.
     */
    function assetIcon(name, size, extra) {
      return h('img', {
        src: ICONS[name] ?? '',
        alt: '',
        width: size,
        height: size,
        draggable: 'false',
        style: Object.assign({ width: `${size}px`, height: `${size}px`, objectFit: 'contain', flex: '0 0 auto', display: 'block' }, extra ?? {}),
      });
    }
    /** Project icons the plugin ships, which a manifest may name instead of carrying a file. */
    const NAMED_PROJECT_ICONS = ['notepad', 'camera', 'calculator'];

    /** The placements the create dialog offers, in the order the wireframe lays them out. */
    const CREATE_PLACEMENTS = [
      { value: 'dock-right', key: 'placementDockRight', fallback: 'Right column' },
      { value: 'inline', key: 'placementInline', fallback: 'In the conversation' },
      { value: 'fullscreen', key: 'placementFullscreen', fallback: 'Fullscreen' },
      { value: 'float', key: 'placementFloat', fallback: 'Floating window' },
    ];

    /**
     * The placement a project declares, when it is one this dialog can show.
     *
     * `meta.json` has carried a `placement` since the manifest form existed, and until now nothing
     * read it at creation: the reader picked a project and then picked a place, and the project's
     * own answer was only ever a comment. A project that declares something the menu no longer
     * offers — `background` — has no tile to light, so its answer is not applied.
     */
    function presetPlacementOf(template) {
      const value = template !== null && template !== undefined && typeof template.placement === 'string' ? template.placement : '';
      return CREATE_PLACEMENTS.some((entry) => entry.value === value) ? value : undefined;
    }

    /**
     * The glyph a project is recognised by.
     *
     * `meta.json` may carry `icon`: an emoji, or a path to a small image beside the project, which
     * the host reads and hands over as a data URL (a document cannot fetch its own folder). A
     * project without one gets a page, and the blank canvas gets a plus — the same two shapes the
     * rest of the dialog uses.
     */
    function projectGlyph(template, size) {
      const source = typeof template.iconSrc === 'string' ? template.iconSrc : '';
      if (source.length > 0) {
        return h('img', {
          src: source,
          alt: '',
          style: { width: `${size}px`, height: `${size}px`, objectFit: 'contain', flex: '0 0 auto', borderRadius: '6px' },
        });
      }
      const named = typeof template.icon === 'string' ? template.icon.trim() : '';
      if (NAMED_PROJECT_ICONS.includes(named)) return assetIcon(named, size);
      const blank = template.slug === 'blank';
      const emoji = named.length > 0 ? named : blank ? '+' : '📄';
      return h(
        'span',
        {
          style: {
            width: `${size}px`,
            height: `${size}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // The plus is drawn, not emoji: a heavy cross in the same weight as the project icons
            // reads as another project rather than as the way to start one.
            fontSize: blank ? `${Math.round(size * 0.92)}px` : `${Math.round(size * 0.72)}px`,
            fontWeight: blank ? 300 : 400,
            lineHeight: 1,
            flex: '0 0 auto',
            border: blank ? `1.5px dashed ${BW.ink}` : 'none',
            borderRadius: '8px',
            // A character sits on its baseline, and centring the line box leaves a `+` visibly
            // low in the square. Two pixels up is what makes it look centred rather than measured.
            transform: blank ? 'translateY(-2px)' : undefined,
          },
        },
        emoji,
      );
    }

    /** A pill: the process that is alive, and the chips that say how it will live. */
    function bwPill(text, background, title) {
      return h(
        'span',
        {
          title,
          style: {
            fontSize: '12px',
            lineHeight: '18px',
            padding: '0 9px',
            borderRadius: '999px',
            background,
            color: '#ffffff',
            whiteSpace: 'nowrap',
          },
        },
        text,
      );
    }

    /**
     * One project row: what it is, whether its backend is alive, how it lives, and its pencil.
     *
     * The row is the source choice — a reader picks a project by pressing it, the way the
     * wireframe draws it — so the radio it replaced is gone and the state it set is now set by the
     * row itself.
     */
    function createProjectRow(props) {
      const { template, selected, onPick, onEdit, narrow } = props;
      const backend = backendInfoOf(template);
      const declared = backend !== undefined && backend.declared === true;
      const running = backend !== undefined && backend.loaded === true;
      const name = template.slug === 'blank' ? tr('newBlank', 'Blank canvas') : typeof template.name === 'string' && template.name.length > 0 ? template.name : template.slug;
      const chips = [];
      if (declared === true) {
        chips.push(['allowed', backend.allowed === true ? tr('backendAllowed', 'Allowed') : tr('backendDenied', 'Not allowed'), '']);
        chips.push([
          'resident',
          backend.resident === true ? tr('backendResident', 'Resident') : tr('backendFollow', 'Follows the panel'),
          backend.resident === true ? tr('backendResidentHint', 'Stays up after the panel closes') : tr('backendFollowHint', 'Unloads a while after the panel closes'),
        ]);
        chips.push(['loaded', backend.loaded === true ? tr('backendLoaded', 'Loaded') : tr('backendIdle', 'Not loaded'), '']);
      }
      const pencilTitle = tr('editProject', 'Edit this project’s details');
      // Built once: on a wide row these sit in the right-hand column, under the pencil; on a
      // phone they follow the state pill inside the text column.
      const chipsNode =
        chips.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              ...chips.map(([key, label, hint]) =>
                h(
                  'span',
                  {
                    key,
                    title: hint.length > 0 ? hint : undefined,
                    style: { fontSize: '11.5px', lineHeight: '17px', padding: '0 8px', borderRadius: '999px', background: BW.chip, color: '#ffffff', whiteSpace: 'nowrap' },
                  },
                  label,
                ),
              ),
            );
      return h(
        'div',
        {
          key: template.slug,
          'data-source': template.slug,
          role: 'button',
          tabIndex: 0,
          'aria-pressed': selected === true,
          onClick: () => onPick(template),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onPick(template);
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: narrow ? '10px' : '14px',
            padding: narrow ? '8px 10px' : '10px 12px',
            margin: '4px 2px',
            border: selected === true ? BW.line : BW.none,
            borderRadius: '10px',
            cursor: 'pointer',
            background: '#ffffff',
          },
        },
        projectGlyph(template, narrow ? 40 : 50),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '5px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: narrow ? '15px' : '18px', fontWeight: 600, color: BW.ink, wordBreak: 'break-word' } }, name),
            h(
              'span',
              { style: { fontSize: '12.5px', color: BW.muted, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' } },
              `(AID: ${template.slug})`,
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            template.slug === 'blank'
              ? bwPill(tr('createBlankPill', 'Always available'), BW.chip, tr('createBlankPillHint', 'A new interface with nothing in it yet'))
              : bwPill(
                  running ? tr('backendPillRunning', 'Running') : tr('backendPillIdle', 'Not running'),
                  running ? BW.green : BW.chip,
                  running
                    ? tr('backendPillRunningHint', 'Its backend is loaded in the host process right now')
                    : tr('backendPillIdleHint', 'Nothing is loaded until one of its interfaces calls it'),
                ),
            // On a phone the row is too narrow for a second column of chips; they belong under
            // the state they describe, where the eye already is.
            narrow === true ? chipsNode : null,
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flex: '0 0 auto' } },
          // The blank canvas is not a project on disk, so there is no manifest to open on it.
          template.slug === 'blank'
            ? null
            : h(
            'button',
            {
              type: 'button',
              // A language-independent handle: the pencil is an icon, so neither its text nor its
              // label reads the same in two locales.
              'data-edit-project': template.slug,
              title: pencilTitle,
              'aria-label': `${pencilTitle}: ${name}`,
              onClick: (event) => {
                // The pencil is inside the row, and the row is a source choice: editing a project
                // must not silently also pick it in place of the one the reader was on.
                event?.stopPropagation?.();
                onEdit(template);
              },
              style: { padding: '2px', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' },
            },
            assetIcon('pencil', narrow ? 20 : 22),
          ),
          chips.length === 0
            ? null
            : narrow === true
              ? null
              : chipsNode,
        ),
      );
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
     *
     * The frame is the wireframe it was designed from: one black rule around the panel, a list of
     * projects drawn as rows, the four ways in, and the folder that sets where the list comes from.
     * The folder's badge is the one live thing up there: red with a count when the directory holds
     * things that are not projects yet, a plus when no directory has been chosen at all.
     */
    function HtmlUiCreateDialog(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      if (state.create.open !== true) return null;
      const items = Array.isArray(state.templates.items) ? state.templates.items : [];
      // The blank canvas is the way in for a reader whose folder is empty, and the host always
      // lists it first. This keeps that promise when a catalogue arrives without it, so the panel
      // never presents a list with no way to start anything.
      const catalogue = items.some((template) => template.slug === 'blank')
        ? items
        : [{ slug: 'blank', name: tr('newBlank', 'Blank canvas') }, ...items];
      const candidates = Array.isArray(state.templates.candidates) ? state.templates.candidates : [];
      const narrow = narrowViewport();
      const dir = state.templates.dir;
      const adoptOpen = state.adopt !== undefined && state.adopt.open === true;

      const close = () => {
        state.create.open = false;
        state.create.folderOpen = false;
        state.create.addOpen = false;
        state.create.autoShown = false;
        state.create.placementBound = false;
        bump();
      };

      /** The one input the folder's dialog owns; the panel above it only shows the badge. */
      const openFolder = () => {
        state.create.folderOpen = true;
        state.create.dirInput = typeof dir === 'string' ? dir : '';
        bump();
      };

      /** Start the manifest form on something the directory holds but does not describe yet. */
      const startAdopt = (candidate) => {
        const stem = String(candidate.name).replace(/\.html?$/iu, '');
        state.create.addOpen = false;
        state.adopt = {
          open: true,
          existing: false,
          source: candidate.name,
          slug: slugifyClient(stem),
          name: stem,
          description: '',
          placement: 'dock-right',
          security: 'strict',
          // Off until the reader says otherwise, and only offered when the folder that was
          // copied in actually ships a backend.
          backend: false,
          backendDeclared: candidate.server === true,
          // 采纳新项目时默认常驻：我们手上还没有它的元数据，而这个目录里声明的正是
          // "我要常驻"，所以先跟着声明走；开关只在勾了后台之后才有意义。
          resident: true,
          busy: false,
        };
        bump();
      };

      /** What the folder's badge says, and what pressing it does. */
      const badge = (() => {
        if (candidates.length > 0)
          return {
            text: String(candidates.length),
            hint: tr('createBadgeNew', 'Projects in the folder that are not added yet'),
            // Always the list, never a shortcut into the form: adding one thing is still a
            // decision about which one, and the list is where "this is in the folder but is not a
            // project yet" is said in words.
            action: () => {
              state.create.addOpen = true;
              bump();
            },
          };
        if (typeof dir !== 'string' || dir.length === 0) return { text: '+', hint: tr('createBadgePick', 'Choose the folder your projects live in'), action: openFolder };
        return null;
      })();

      const placements = CREATE_PLACEMENTS.map((entry) =>
        h(
          'button',
          {
            key: entry.value,
            type: 'button',
            role: 'radio',
            'aria-checked': state.create.placement === entry.value,
            onClick: () => {
              state.create.placement = entry.value;
              bump();
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: narrow ? '10px' : '14px',
              padding: narrow ? '8px 10px' : '10px 14px',
              border: state.create.placement === entry.value ? BW.line : BW.none,
              borderRadius: '14px',
              background: '#ffffff',
              cursor: 'pointer',
              font: 'inherit',
              textAlign: 'left',
              color: BW.ink,
            },
          },
          assetIcon(entry.value, narrow ? 26 : 30),
          h('span', { style: { fontSize: narrow ? '14px' : '16px', lineHeight: 1.25 } }, tr(entry.key, entry.fallback)),
        ),
      );

      // Two boxes, not one: the legend and the folder stand *on* the panel's top rule, so they
      // cannot live inside the box that scrolls — an `overflow: auto` parent clips exactly the
      // overhang they are drawn with.
      const panelOuterStyle = {
        position: 'relative',
        width: narrow ? '100%' : 'min(760px, 92vw)',
        maxHeight: narrow ? '94vh' : '88vh',
        display: 'flex',
        flexDirection: 'column',
      };
      const panelStyle = {
        boxSizing: 'border-box',
        width: '100%',
        // Sized by the flex parent that carries the max height. The panel itself does not scroll:
        // its body does, and the footer stays on its bottom edge.
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#ffffff',
        color: BW.ink,
        border: BW.line,
        borderRadius: '6px',
      };
      const bodyStyle = {
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'auto',
        padding: narrow ? '18px 12px 14px' : '24px 22px 18px',
      };
      const footerStyle = {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
        padding: narrow ? '10px 12px 12px' : '12px 22px 14px',
        borderTop: '1px solid #e6e6e6',
      };
      const legendStyle = (left) => ({
        position: 'absolute',
        top: '-13px',
        left,
        background: '#ffffff',
        padding: '0 10px',
        fontSize: narrow ? '15px' : '16px',
        fontWeight: 700,
        lineHeight: '26px',
        color: BW.ink,
        whiteSpace: 'nowrap',
      });
      // A sub-dialog is a whole panel of its own: the main panel's flex sizing would stretch it to
      // the width of the one underneath.
      const subPanelStyle = {
        boxSizing: 'border-box',
        width: narrow ? '100%' : 'min(560px, 92vw)',
        maxHeight: '86vh',
        overflow: 'auto',
        background: '#ffffff',
        color: BW.ink,
        border: BW.line,
        borderRadius: '6px',
        padding: narrow ? '22px 14px 14px' : '24px 22px 18px',
      };

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: '0',
            zIndex: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: narrow ? '0' : '26px',
            background: narrow ? MOBILE.scrim : 'rgba(0,0,0,0.34)',
            pointerEvents: 'auto',
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
          { style: panelOuterStyle },
          h('div', { style: legendStyle(narrow ? '14px' : '22px') }, tr('createSource', 'New HTML project')),
          // The folder stands on the panel's own top rule, badge and all — the wireframe puts it
          // at the corner rather than in a row of its own.
          h(
            'div',
            { style: { position: 'absolute', top: '-26px', right: '16px', width: '58px', height: '48px' } },
            h(
              'button',
              {
                type: 'button',
                title: tr('createDirBrowseHint', 'Choose the folder with the system file browser'),
                'aria-label': tr('createFolderTitle', 'Choose the project folder'),
                onClick: openFolder,
                style: { width: '100%', height: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
              },
              assetIcon('folder', 48),
            ),
            badge === null
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    title: badge.hint,
                    'aria-label': badge.hint,
                    onClick: (event) => {
                      event.stopPropagation();
                      badge.action();
                    },
                    style: {
                      position: 'absolute',
                      top: '-4px',
                      right: '-8px',
                      minWidth: '22px',
                      height: '22px',
                      padding: '0 5px',
                      borderRadius: '999px',
                      border: '2px solid #ffffff',
                      background: '#e53935',
                      color: '#ffffff',
                      fontSize: '12px',
                      fontWeight: 700,
                      lineHeight: '18px',
                      cursor: 'pointer',
                    },
                  },
                  badge.text,
                ),
          ),
          // The ruled box: its body scrolls, the footer stays put at its bottom edge.
          h(
            'div',
            { style: panelStyle },
          h(
            'div',
            { style: bodyStyle },
          // The list: the only region that scrolls, so a long catalogue never pushes the ways in
          // and the buttons off the panel.
          h(
            'div',
            {
              style: {
                border: BW.line,
                borderRadius: '4px',
                padding: '6px',
                maxHeight: narrow ? '40vh' : '44vh',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
              },
            },
            catalogue.length === 0
              ? h('div', { style: { padding: '16px 12px', fontSize: '13px', color: BW.muted } }, tr('createNoProjects', 'No projects yet: put one in the folder, or start from the blank canvas.'))
              : catalogue.map((template) =>
                  createProjectRow({
                    template,
                    selected: state.create.source === template.slug,
                    narrow,
                    onPick: (picked) => {
                      state.create.source = picked.slug;
                      // The tiles read the project's own default: `placement` in its manifest is
                      // what the reader chose when they made it, and choosing a project is the
                      // moment that answer applies. Until now it was written down and never read.
                      const preset = presetPlacementOf(picked);
                      if (preset !== undefined) state.create.placement = preset;
                      state.create.placementBound = true;
                      // Picking a different project is also a statement about which project the
                      // open form is about: leaving the form on the previous one is exactly how a
                      // save lands on a project the reader was not looking at. A half-filled
                      // *adopt* form is not moved — that one is about a folder, not a catalogue
                      // entry.
                      if (state.adopt.open === true && state.adopt.existing === true && state.adopt.slug !== picked.slug) {
                        openProjectEditor(picked);
                        return;
                      }
                      bump();
                    },
                    onEdit: (edited) => openProjectEditor(edited),
                  }),
                ),
          ),
          state.templates.error !== null
            ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #c33)', marginTop: '8px' } }, String(state.templates.error))
            : null,
          state.templates.notice !== null
            ? h('div', { style: { fontSize: '12px', color: BW.muted, marginTop: '8px' } }, String(state.templates.notice))
            : null,
          // The four ways in, in their own ruled box with its own legend.
          h(
            'div',
            { style: { position: 'relative', marginTop: '26px', border: BW.line, borderRadius: '4px', padding: narrow ? '16px 10px 10px' : '20px 18px 12px' } },
            h('div', { style: legendStyle(narrow ? '12px' : '18px') }, tr('createPlacement', 'Where')),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: narrow ? '4px 8px' : '8px 20px' } }, ...placements),
          ),
          ),
          // A background layer is unlike the four above: it belongs to no view, so it is still on
          // screen after switching to the trajectory or the session page, and only goes away when
          // it is closed from there. Said where the choice is made, because otherwise "it is
          // still there" reads as a stray record. 该位置已从本菜单移除（入口未完善，功能保留在
          // html_ui 工具与档案中），这一句留在这里是为了它回来时不用重新想一遍。
          h(
            'div',
            { style: footerStyle },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    state.create.open = false;
                    toggleTemplates();
                  },
                  style: { font: 'inherit', fontSize: '13px', color: BW.muted, background: 'transparent', border: 'none', padding: '0', cursor: 'pointer', textDecoration: 'underline' },
                },
                tr('createMore', 'More template actions'),
              ),
              h(
                'span',
                { style: { fontSize: '11px', fontFamily: 'ui-monospace, Consolas, monospace', color: BW.muted }, title: tr('buildTagHint', 'The browser half this page is running') },
                CLIENT_VERSION,
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '10px' } },
              h('button', { type: 'button', style: bwButtonStyle(false, narrow), onClick: close }, tr('cancel', 'Cancel')),
              h(
                'button',
                {
                  type: 'button',
                  style: bwButtonStyle(true, narrow),
                  disabled: state.create.busy === true || sessionId === undefined,
                  onClick: () => {
                    if (sessionId === undefined || state.create.busy === true) return;
                    state.create.busy = true;
                    bump();
                    // The reader asked for it, so the column opens for it — `applyTemplateInto`
                    // renders *and* reveals, now and again shortly after, because the tab type
                    // registers asynchronously and the first attempt can arrive too early.
                    applyTemplateInto(state.create.source, sessionId, state.create.placement).then((created) => {
                      state.create.busy = false;
                      if (created === true) state.create.open = false;
                      bump();
                    });
                  },
                },
                state.create.busy === true ? tr('creating', 'Creating…') : tr('create', 'Create'),
              ),
            ),
          ),
        ),
        ),
        // ---------------------------------------------------------------- folder dialog
        state.create.folderOpen === true
          ? h(
              'div',
              {
                style: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.34)', padding: '20px' },
                onClick: (event) => {
                  if (event.target === event.currentTarget) {
                    state.create.folderOpen = false;
                    bump();
                  }
                },
              },
              h(
                'div',
                { style: subPanelStyle },
                h('div', { style: subTitleStyle }, tr('createFolderTitle', 'Choose the project folder')),
                h(
                  'div',
                  { style: { fontSize: '12.5px', color: BW.muted, marginBottom: '10px', lineHeight: 1.5 } },
                  tr('createFolderHint', 'This is where the project list comes from: every folder in it that carries a meta.json becomes a project.'),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h('input', {
                    type: 'text',
                    'data-dsh-htmlui-dir': '',
                    value: state.create.dirInput !== undefined ? state.create.dirInput : dir ?? '',
                    placeholder: tr('createDirPlaceholder', 'No directory chosen yet'),
                    onChange: (event) => {
                      state.create.dirInput = event.target.value;
                      bump();
                    },
                    style: Object.assign({}, bwFieldStyle, { flex: '1 1 auto', minWidth: '0' }),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: Object.assign({}, bwButtonStyle(false, narrow), { flex: '0 0 auto' }),
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
                            state.create.dirInput = chosen;
                            bump();
                            saveTemplatesDir(chosen);
                          },
                          () => undefined,
                        );
                      },
                    },
                    tr('createDirBrowse', 'Browse…'),
                  ),
                ),
                typeof dir === 'string' && dir.length > 0 ? null : h('div', { style: { fontSize: '12px', color: BW.muted, marginTop: '8px' } }, tr('createDirUnset', 'No directory yet: choose the folder that holds your HTML projects.')),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: bwButtonStyle(false, narrow),
                      onClick: () => {
                        state.create.folderOpen = false;
                        bump();
                      },
                    },
                    tr('cancel', 'Cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: bwButtonStyle(true, narrow),
                      disabled: state.templates.savingDir === true,
                      onClick: () => {
                        const value = state.create.dirInput !== undefined ? state.create.dirInput : dir ?? '';
                        saveTemplatesDir(value);
                        state.create.folderOpen = false;
                        bump();
                      },
                    },
                    state.templates.savingDir === true ? tr('creating', 'Creating…') : tr('createDirSave', 'Use this directory'),
                  ),
                ),
              ),
            )
          : null,
        // ---------------------------------------------------------------- add-project dialog
        state.create.addOpen === true
          ? h(
              'div',
              {
                style: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.34)', padding: '20px' },
                onClick: (event) => {
                  if (event.target === event.currentTarget) {
                    state.create.addOpen = false;
                    bump();
                  }
                },
              },
              h(
                'div',
                { style: subPanelStyle },
                h('div', { style: subTitleStyle }, tr('createAddTitle', 'Add a project')),
                h(
                  'div',
                  { style: { fontSize: '12.5px', color: BW.muted, marginBottom: '10px', lineHeight: 1.5 } },
                  tr('createAddHint', 'These are in the folder but carry no project manifest. Pick one and describe it once.'),
                ),
                ...candidates.map((candidate) =>
                  h(
                    'div',
                    { key: candidate.name, style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderBottom: '1px solid #e6e6e6' } },
                    projectGlyph({ slug: candidate.name, name: candidate.name }, 30),
                    h('span', { style: { flex: '1 1 auto', minWidth: '0', fontSize: '14px', wordBreak: 'break-word' } }, candidate.name),
                    h('span', { style: { fontSize: '11.5px', color: BW.muted } }, candidate.kind === 'dir' ? tr('candidateDir', 'folder') : tr('candidateFile', 'file')),
                    h(
                      'button',
                      { type: 'button', style: Object.assign({}, bwButtonStyle(true, narrow), { height: '30px', padding: '0 14px', fontSize: '13px' }), onClick: () => startAdopt(candidate) },
                      tr('candidateAdopt', 'Adopt'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: bwButtonStyle(false, narrow),
                      onClick: () => {
                        state.create.addOpen = false;
                        bump();
                      },
                    },
                    tr('cancel', 'Cancel'),
                  ),
                ),
              ),
            )
          : null,
        // ---------------------------------------------------------------- manifest form
        adoptOpen === true ? h(HtmlUiManifestPanel, { narrow, props }) : null,
      );
    }

    /**
     * The manifest form, as its own black-and-white panel.
     *
     * It is shared by adopting a folder and editing an existing project, and it sits above the
     * create panel rather than inside it: the list behind stays where it was, and closing the form
     * returns to it instead of to a half-scrolled catalogue.
     */
    function HtmlUiManifestPanel(props) {
      const { narrow } = props;
      const adopt = state.adopt;
      const legendStyle = (left) => ({
        position: 'absolute',
        top: '-13px',
        left,
        background: '#ffffff',
        padding: '0 10px',
        fontSize: narrow ? '15px' : '16px',
        fontWeight: 700,
        lineHeight: '26px',
        color: BW.ink,
        whiteSpace: 'nowrap',
      });
      const fieldRow = (label, control, key) =>
        h(
          'div',
          { key, style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
          h('span', { style: { flex: '0 0 108px', fontSize: '12.5px', color: BW.ink } }, label),
          h('div', { style: { flex: '1 1 auto', minWidth: '0' } }, control),
        );
      const closeForm = () => {
        state.adopt = { open: false, existing: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', security: 'strict', backend: false, backendDeclared: false, resident: false, busy: false };
        bump();
      };
      const chosenSecurity = SECURITY_CHOICES.find((entry) => entry.value === adopt.security) ?? SECURITY_CHOICES[0];
      // ---------------------------------------------------------------- the project's icon
      //
      // A project's icon is a file in its own folder, so the form carries the bytes and the host
      // writes them beside the manifest. What this row shows, in order: a file just picked, the
      // answer to "remove", then whatever the project already declares — a data URL the host read,
      // a shipped icon, or a character.
      const iconFileRef = useRef(null);
      const catalogueEntry = Array.isArray(state.templates.items) ? state.templates.items.find((item) => item.slug === adopt.slug) : undefined;
      const declaredIcon = catalogueEntry !== undefined && typeof catalogueEntry.icon === 'string' ? catalogueEntry.icon.trim() : '';
      const declaredSrc =
        catalogueEntry !== undefined && typeof catalogueEntry.iconSrc === 'string' && catalogueEntry.iconSrc.length > 0
          ? catalogueEntry.iconSrc
          : NAMED_PROJECT_ICONS.includes(declaredIcon)
            ? ICONS[declaredIcon]
            : undefined;
      const pendingSrc =
        typeof adopt.iconData === 'string' && adopt.iconData.length > 0 ? adopt.iconData : adopt.iconRemoved === true ? undefined : declaredSrc;
      const pendingText =
        pendingSrc === undefined && adopt.iconRemoved !== true && declaredIcon.length > 0 && !NAMED_PROJECT_ICONS.includes(declaredIcon) && !/\.(png|jpe?g|gif|webp|svg)$/iu.test(declaredIcon)
          ? declaredIcon
          : '';
      const hasIcon = adopt.iconRemoved !== true && (pendingSrc !== undefined || pendingText.length > 0);
      const pickIcon = (event) => {
        const input = event.target;
        const file = input.files !== null && input.files !== undefined && input.files.length > 0 ? input.files[0] : undefined;
        // Cleared so picking the same file twice still fires a change.
        input.value = '';
        if (file === undefined) return;
        if (file.size > ICON_MAX_BYTES) {
          state.templates.error = tr('adoptIconTooLarge', 'An icon must weigh at most 64 KiB.');
          bump();
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== 'string') return;
          state.adopt.iconData = reader.result;
          state.adopt.iconRemoved = false;
          state.templates.error = null;
          bump();
        };
        reader.onerror = () => {
          state.templates.error = tr('adoptIconUnreadable', 'That image could not be read.');
          bump();
        };
        reader.readAsDataURL(file);
      };
      const iconPicker = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h(
          'div',
          {
            title: tr('adoptIconHint', 'Kept in the project folder, so it travels with the project'),
            style: { width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px dashed ${BW.ink}`, borderRadius: '8px', fontSize: '26px', flex: '0 0 auto' },
          },
          pendingSrc !== undefined
            ? h('img', { src: pendingSrc, alt: '', style: { width: '44px', height: '44px', objectFit: 'contain' } })
            : pendingText.length > 0
              ? pendingText
              : '📄',
        ),
        h('input', { ref: iconFileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', style: { display: 'none' }, onChange: pickIcon }),
        h(
          'button',
          {
            type: 'button',
            style: Object.assign({}, bwButtonStyle(false, narrow), { height: '30px', padding: '0 12px', fontSize: '13px' }),
            onClick: () => {
              if (iconFileRef.current !== null && iconFileRef.current !== undefined) iconFileRef.current.click();
            },
          },
          tr('adoptIconPick', 'Choose an image…'),
        ),
        hasIcon
          ? h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, bwButtonStyle(false, narrow), { height: '30px', padding: '0 12px', fontSize: '13px' }),
                onClick: () => {
                  state.adopt.iconData = undefined;
                  state.adopt.iconRemoved = true;
                  bump();
                },
              },
              tr('adoptIconRemove', 'Remove'),
            )
          : null,
      );
      // 背景层已不再出现在“生成位置”里；一个本来就声明了它的项目，编辑时仍要能看见并保住它，
      // 所以只在这个值确实存在时补一项，而不是重新把它端出来。
      const placements = CREATE_PLACEMENTS.slice();
      if (adopt.placement === 'background') placements.push({ value: 'background', key: 'placementBackground', fallback: 'Background layer' });
      return h(
        'div',
        {
          style: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.34)', padding: narrow ? '0' : '20px' },
          onClick: (event) => {
            if (event.target === event.currentTarget) closeForm();
          },
        },
        h(
          'div',
          {
            style: {
              position: 'relative',
              boxSizing: 'border-box',
              width: narrow ? '100%' : 'min(560px, 92vw)',
              maxHeight: '88vh',
              overflow: 'auto',
              background: '#ffffff',
              color: BW.ink,
              border: BW.line,
              borderRadius: '6px',
              padding: narrow ? '22px 14px 14px' : '26px 24px 18px',
            },
          },
          h('div', { style: subTitleStyle }, `${adopt.existing === true ? tr('editTitle', 'Edit project details') : tr('adoptTitle', 'Project details for')} ${adopt.source}`),
          h(
            'div',
            { style: { fontSize: '12px', color: BW.muted, marginBottom: '12px', lineHeight: 1.5 } },
            adopt.existing === true
              ? tr('editHint', 'These details are saved over the project’s manifest.')
              : tr('adoptHint', 'Nothing is written yet: fill this in and the project is created with it.'),
          ),
          ...['name', 'slug', 'description'].map((key) =>
            fieldRow(
              key === 'name' ? tr('adoptName', 'Project name') : key === 'slug' ? tr('adoptSlug', 'Process ID') : tr('adoptDescription', 'Details'),
              h('input', {
                type: 'text',
                value: adopt[key],
                placeholder: key === 'slug' ? tr('adoptSlugHint', 'lowercase letters, digits, dot, dash, underscore') : '',
                onChange: (event) => {
                  state.adopt[key] = event.target.value;
                  bump();
                },
                style: bwFieldStyle,
              }),
              key,
            ),
          ),
          fieldRow(tr('adoptIcon', 'Project icon'), iconPicker, 'icon'),
          fieldRow(
            tr('adoptPlacement', 'Where it opens'),
            h(
              'select',
              {
                value: adopt.placement,
                onChange: (event) => {
                  state.adopt.placement = event.target.value;
                  bump();
                },
                style: bwFieldStyle,
              },
              ...placements.map((entry) => h('option', { key: entry.value, value: entry.value }, `${tr(entry.key, entry.fallback)} · ${entry.value}`)),
            ),
            'placement',
          ),
          fieldRow(
            tr('adoptSecurity', 'Security level'),
            h(
              'select',
              {
                value: adopt.security,
                onChange: (event) => {
                  state.adopt.security = event.target.value;
                  bump();
                },
                style: bwFieldStyle,
              },
              ...SECURITY_CHOICES.map((entry) => h('option', { key: entry.value, value: entry.value }, `${tr(entry.labelKey, entry.label)} · ${entry.value}`)),
            ),
            'security',
          ),
          h(
            'div',
            { style: { fontSize: '12px', color: adopt.security === 'unsafe' ? 'var(--dsw-alias-state-error-primary, #c33)' : BW.muted, margin: '2px 0 12px' } },
            tr(chosenSecurity.hintKey, chosenSecurity.hint),
          ),
          // The reader's own decision about code that runs in this process. It appears
          // only for a project that ships a backend, and the line under it says plainly
          // what granting means: this is the one switch in the plugin that hands a
          // project the same reach the plugin has.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' } },
            adopt.backendDeclared === true
              ? h('input', {
                  type: 'checkbox',
                  checked: adopt.backend === true,
                  onChange: (event) => {
                    state.adopt.backend = event.target.checked;
                    bump();
                  },
                  style: { marginTop: '3px', flex: '0 0 auto', accentColor: BW.ink },
                })
              : null,
            h(
              'div',
              { style: { minWidth: '0' } },
              h('div', { style: { fontSize: '13px', fontWeight: adopt.backend === true ? 600 : 400 } }, tr('adoptBackend', 'Run this project’s backend')),
              h(
                'div',
                { style: { fontSize: '11.5px', lineHeight: 1.5, color: adopt.backend === true ? 'var(--dsw-alias-state-error-primary, #c33)' : BW.muted } },
                adopt.backendDeclared === true
                  ? tr('adoptBackendHint', 'Its server.js runs inside the DSH process with this plugin’s privileges — as trusted as the plugin itself.')
                  : tr('adoptBackendNone', 'No backend here: a server.js in the project folder, named by “backend” in meta.json, is what offers one.'),
              ),
            ),
          ),
          // 常驻: a second decision about the same process, so it lives under the first
          // and appears only once the first is answered.
          adopt.backendDeclared === true && adopt.backend === true
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' } },
                h('input', {
                  type: 'checkbox',
                  checked: adopt.resident === true,
                  onChange: (event) => {
                    state.adopt.resident = event.target.checked;
                    bump();
                  },
                  style: { marginTop: '3px', flex: '0 0 auto', accentColor: BW.ink },
                }),
                h(
                  'div',
                  { style: { minWidth: '0' } },
                  h(
                    'div',
                    {
                      style: { fontSize: '13px', fontWeight: adopt.resident === true ? 600 : 400 },
                      title: tr(
                        'residentHint',
                        'Checked: once loaded it is not unloaded when idle, so it keeps running after the panel closes. To end it, use Close backend task in its manager row, or uncheck this switch — either unloads it right away.',
                      ),
                    },
                    tr('residentSwitch', 'Resident'),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '14px' } },
            h('button', { type: 'button', style: bwButtonStyle(false, narrow), onClick: closeForm }, tr('cancel', 'Cancel')),
            h(
              'button',
              {
                type: 'button',
                style: bwButtonStyle(true, narrow),
                disabled: adopt.busy === true,
                onClick: () => {
                  adoptTemplate(
                    adopt.source,
                    Object.assign(
                      {
                        slug: adopt.slug,
                        name: adopt.name,
                        description: adopt.description,
                        placement: adopt.placement,
                        security: adopt.security,
                      },
                      // Adopting a folder that ships a `server.js` is also where the
                      // project's manifest gets its declaration: the file is the
                      // evidence, and the switch is the reader's answer to it. Editing
                      // an existing project never rewrites that — the folder owns it.
                      adopt.backendDeclared === true && adopt.existing !== true ? { backend: adopt.backend === true } : {},
                    ),
                    // Only sent when the form offered the choice, so a project with no
                    // backend can never end up allowed by accident.
                    adopt.backendDeclared === true ? adopt.backend === true : undefined,
                    // 常驻 follows the same rule, and one more: it only means anything for a
                    // backend that may actually run.
                    adopt.backendDeclared === true && adopt.backend === true ? adopt.resident === true : undefined,
                  );
                },
              },
              adopt.busy === true ? tr('creating', 'Creating…') : adopt.existing === true ? tr('editConfirm', 'Save changes') : tr('adoptConfirm', 'Write the manifest'),
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
              onClick: () => applyTemplateInto(template.slug, sessionId),
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
              // The copy above promises the right column: the reveal is what makes it true.
              onClick: () => applyTemplateInto('blank', sessionId),
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
            state.create.autoShown = false;
            state.create.placementBound = false;
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
            state.create.autoShown = false;
            state.create.placementBound = false;
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
        // The render-and-reveal pair, exported so a test can drive either half and assert that a
        // restart really does open the column instead of only drawing into it.
        applyTemplateInto,
        revealDockRight,
        askModelForTemplate,
        ensureTicket,
        ticketToken,
        tr,
        MESSAGES,
        LOCALE_NS,
        HtmlUiTemplateDrawer,
        HtmlUiCreateDialog,
        HtmlUiManager,
        // The row is the unit the manager is built from — one program, its marks and its
        // controls — so it is exported on its own: a test can render one row for each state
        // (interface open, closed, hidden) instead of inferring those states from the page.
        HtmlUiManagerRow,
        managerRowsFor,
        // The manager's two groups are the page's structure now, so they are exported the same way
        // the flat row list is: a test can assert the partition (and that no project lands in both)
        // without inferring it from the rendered headings.
        managerGroupsFor,
        managerRowIsCrossSession,
        managerTitleOf,
        managerPlacementFor,
        recordHidden,
        toggleRecord,
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
        // The two-step close and the fullscreen chrome that carries it are exported for the same
        // reason as the rest: the confirmation is the only thing standing between a mis-tap and a
        // destroyed document, so a test has to be able to render it.
        useCloseConfirm,
        HtmlUiFullscreenChrome,
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
