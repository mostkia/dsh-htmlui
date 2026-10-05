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
     * The client's activation marker.
     *
     * The build tag is not decoration: during acceptance it was repeatedly unclear
     * whether a page was running the current browser half, and each wrong guess cost a
     * round. The tag is logged *and* shown in the create dialog, so the answer is one
     * glance instead of one assumption.
     */
    const CLIENT_BUILD = 'adopt-form-2';
    const CLIENT_ACTIVE_LINE = `[dsh-htmlui] client active (0.1.1 · ${CLIENT_BUILD})`;
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
    const INLINE_MAX_HEIGHT = 560;
    const DOCK_MIN_HEIGHT = 140;

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
      /** The newest turn tail seen per session, where inline interfaces render. */
      tailSeq: new Map(),
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
      templates: { open: false, loaded: false, items: [], candidates: [], error: null, dir: undefined, configured: false, asked: true, savingDir: false, adopting: '', notice: null },
      /** The user's own create flow: what to start from, and where it should go. */
      create: { open: false, source: 'blank', placement: 'dock-right', busy: false, dirInput: undefined },
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
        managerClose: 'Remove',
        managerRestore: 'Show',
        managerHidden: 'hidden',
        minimize: 'Hide the window',
        managerCloseAll: 'Remove all',
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
        adoptSlug: 'Project name',
        adoptSlugHint: 'lowercase letters, digits, dot, dash, underscore',
        adoptName: 'Process name',
        adoptDescription: 'Details',
        adoptPlacement: 'Where it opens',
        adoptHint: 'Nothing is written yet: fill this in and the project is created with it.',
        adoptConfirm: 'Write the manifest',
        adopted: 'It is a project now.',
        createPlacement: 'Where',
        placementDockRight: 'Right column (a real split)',
        placementInline: 'In the conversation',
        placementFloat: 'Floating window',
        placementFullscreen: 'Fullscreen',
        placementBackground: 'Background layer',
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
        managerView: 'HTML管理',
        managerTitle: '本会话的 HTML 界面',
        managerClose: '关闭',
        managerRestore: '恢复显示',
        managerHidden: '已隐藏',
        minimize: '隐藏窗口',
        managerCloseAll: '全部关闭',
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
        adoptSlug: '项目名称',
        adoptSlugHint: '仅支持小写英文数字或._-',
        adoptName: '进程名称',
        adoptDescription: '详细描述',
        adoptPlacement: '默认生成位置',
        adoptHint: '此时还没有写入任何东西：填完后点下面的按钮，才会带着这些信息创建项目。',
        adoptConfirm: '写入清单',
        adopted: '已成为项目。',
        createPlacement: '生成位置',
        placementDockRight: '右侧栏（真正的左右分屏）',
        placementInline: '对话流内',
        placementFloat: '浮动窗',
        placementFullscreen: '全屏',
        placementBackground: '背景层',
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
        bump();
        return state.templates.items;
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
    function adoptTemplate(name, manifest) {
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
          state.templates.notice = tr('adopted', 'It is a project now.');
          state.adopt = { open: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', busy: false };
          return loadTemplates().then(() => true);
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
          return {
            w: remembered?.w ?? initial.w ?? DEFAULT_FLOAT.w,
            h: remembered?.h ?? initial.h ?? DEFAULT_FLOAT.h,
            x: remembered?.x ?? initial.x ?? DEFAULT_FLOAT.x,
            y: remembered?.y ?? initial.y ?? DEFAULT_FLOAT.y,
          };
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
          if (data.nonce !== nonceRef.current) return;
          if (data.__dshHtmlUi === 'ready') setStatus('ready');
          if (data.__dshHtmlUi === 'close') props.onDismiss?.(record.uiId);
          if (data.__dshHtmlUi === 'resize') {
            const next = parseSizeText(data.size);
            if (next !== undefined) setSize((current) => Object.assign({}, current, next));
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
      }, [record.uiId, props.onDismiss]);

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
          setSize((current) => Object.assign({}, current, { x, y }));
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
        setSize((current) => Object.assign({}, current, { w, h }));
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
          sandbox: FRAME_SANDBOX,
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
              setSize((current) => ({
                w: Math.max(240, (current.w ?? DEFAULT_FLOAT.w) + dx),
                h: Math.max(160, (current.h ?? DEFAULT_FLOAT.h) + dy),
                x: current.x,
                y: current.y,
              }));
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
        // conversation, not as a window parked in it.
        const measured = contentHeight ?? initial.h;
        const height =
          measured !== undefined && Number.isFinite(measured)
            ? Math.min(INLINE_MAX_HEIGHT, Math.max(60, measured))
            : 220;
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

    /** Wrap one registered component in that boundary. */
    function guarded(ctx, Component) {
      return function GuardedSurface(props) {
        return h(HtmlUiBoundary, { ctx }, h(Component, props));
      };
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
     * It renders the session's inline interfaces in the *newest* turn's tail only:
     * a turn tail renders once per turn, so rendering them in every tail would stack
     * a copy per turn, and scoping them to the turn that created them would need the
     * record to carry that turn. "The current interfaces appear at the end of the
     * conversation" needs neither.
     */
    function HtmlUiInlineTail(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      const seq = Number.isFinite(props.seq) ? props.seq : undefined;
      if (sessionId === undefined || seq === undefined) return null;

      const newest = state.tailSeq.get(sessionId);
      if (newest === undefined || seq > newest) {
        // Rendering is not the place to notify, but this is the one chance to learn
        // which tail is last; the re-render it triggers is what settles the choice.
        state.tailSeq.set(sessionId, seq);
      }
      if (state.tailSeq.get(sessionId) !== seq) return null;

      const records = recordsIn(sessionId, ['inline']);
      if (records.length === 0) return null;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0', flexShrink: 0 } },
        ...records.map((record) =>
          h(
            'div',
            { key: record.uiId, style: { display: 'flex', flexDirection: 'column', minHeight: '0' } },
            h(HtmlUiFrame, { record, theme: state.theme, variant: 'inline', onDismiss: dismissRecord }),
          ),
        ),
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
      const records = sessionId === undefined ? [] : recordsFor(sessionId);
      const rows = records.map((record) =>
        h(
          'div',
          {
            key: record.uiId,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '7px 10px',
              borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
            },
          },
          h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto', minWidth: '0' }) }, record.title.length > 0 ? record.title : record.uiId),
          h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, record.placement),
          h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, `r${record.revision}${record.sizeText !== undefined && record.sizeText.length > 0 ? ` · ${record.sizeText}` : ''}`),
          h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, record.uiId),
          state.hidden.has(record.uiId)
            ? h('span', { style: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('managerHidden', 'hidden'))
            : null,
          // Every form that can be out of sight gets the same control, with the same
          // words. A background layer is always on screen, so it has none.
          record.placement === 'background'
            ? null
            : h(
                'button',
                { type: 'button', style: buttonStyle, onClick: () => restoreRecord(record, props) },
                tr('managerRestore', 'Show'),
              ),
          h('button', { type: 'button', style: buttonStyle, onClick: () => dismissRecord(record.uiId) }, tr('managerClose', 'Remove')),
        ),
      );
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
        records.length === 0
          ? h('div', { style: emptyStyle }, tr('managerEmpty', 'This session has no HTML interface.'))
          : h('div', null, ...rows),
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
      const match = /[?&]t=([^&]+)/u.exec(cached.url);
      return match === null ? undefined : match[1];
    }

    function dismissRecord(uiId) {
      state.dismissed.add(uiId);
      // The token has to be read before the teardown, which drops the cached ticket.
      const token = ticketToken(uiId);
      retire(uiId);
      const close = (capability) =>
        postJson('/rpc', { uiId, op: 'close', t: capability }).then((result) => {
          if (result !== null && result.ok === false) {
            logWarn(undefined, `[dsh-htmlui] the host refused to close ${uiId}`, result);
          }
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
        const apply = () => {
          const rect = node.getBoundingClientRect();
          const left = Math.round(rect.left);
          const width = Math.round(rect.width);
          if (width > 0 && (state.column.left !== left || state.column.width !== width)) {
            state.column = { left, width };
            bump();
          }
        };
        apply();
        window.addEventListener('resize', apply);
        return () => window.removeEventListener('resize', apply);
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
    /** Whether the column's body is on screen, and the pending close it may owe. */
    const rightPaneBody = { mounted: 0, timer: null };

    function HtmlUiRightPane(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      useSessionSync(sessionId);
      // Closing this tab is how a reader says they are done with these interfaces. The
      // records have to go with it, or the session page keeps listing surfaces nothing
      // can show — an interface with no seat, which reads as a ghost.
      //
      // The check is delayed and counts mounts, because hiding the column unmounts this
      // body too, and only a body that never comes back was really closed. A session
      // switch remounts it at once, so switching sessions cannot delete anything.
      useEffect(() => {
        rightPaneBody.mounted += 1;
        if (rightPaneBody.timer !== null) {
          clearTimeout(rightPaneBody.timer);
          rightPaneBody.timer = null;
        }
        return () => {
          rightPaneBody.mounted -= 1;
          if (rightPaneBody.mounted > 0 || rightPaneBody.timer !== null) return;
          rightPaneBody.timer = setTimeout(() => {
            rightPaneBody.timer = null;
            if (rightPaneBody.mounted > 0) return;
            for (const record of recordsIn(sessionId, ['dock-right'])) dismissRecord(record.uiId);
          }, 500);
        };
      }, [sessionId]);
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
    const rightPaneWiring = { ctx: undefined, wired: false, disposes: [] };

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

      if (sessionId === undefined) return null;
      const records = sessionRecords;

      const floats = records.filter((record) => record.placement === 'float');
      const backgrounds = records.filter((record) => record.placement === 'background');
      const fullscreenRecord = activeFullscreen(records);

      const dismiss = dismissRecord;

      const leaveFullscreen = (uiId) => {
        state.fullscreen = null;
        state.fullscreenDismissed.add(uiId);
        bump();
      };

      const layers = [];

      for (const record of backgrounds) {
        layers.push(
          h(
            'div',
            {
              key: `bg-${record.uiId}`,
              style: {
                position: 'fixed',
                inset: '0',
                pointerEvents: 'none',
                opacity: 0.35,
                zIndex: 1,
              },
            },
            h(HtmlUiFrame, { record, theme: state.theme, variant: 'background', onDismiss: dismiss }),
          ),
        );
      }

      for (const record of floats) {
        // A minimized window is put away, not deleted: the record stays listed, and the
        // session page's restore control brings the same window back where it was.
        if (state.hidden.has(record.uiId)) continue;
        layers.push(
          h(HtmlUiFrame, {
            key: record.uiId,
            record,
            theme: state.theme,
            variant: 'float',
            onMinimize: (uiId) => {
              state.hidden.add(uiId);
              bump();
            },
            onDismiss: dismiss,
          }),
        );
      }

      if (fullscreenRecord !== undefined) {
        layers.push(
          h(
            'div',
            {
              key: `fs-${fullscreenRecord.uiId}`,
              style: {
                position: 'fixed',
                top: '0',
                // A fullscreen surface covers the conversation column, not the frame: the
                // sidebar belongs to the user, and covering it hides their sessions. The
                // column's own edges are measured from our seat inside it.
                left: state.column.width > 0 ? `${state.column.left}px` : '0',
                width: state.column.width > 0 ? `${state.column.width}px` : '100%',
                height: '100%',
                zIndex: 5,
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: 'auto',
                background: 'var(--dsw-alias-bg-base, #fff)',
              },
              // Modal to assistive technology: the layer covers the page, so the
              // page behind it must not stay reachable by a screen reader.
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': fullscreenRecord.title.length > 0 ? fullscreenRecord.title : fullscreenRecord.uiId,
            },
            h(
              'div',
              { style: Object.assign({}, surfaceChrome, { minHeight: '36px', padding: '0 10px' }) },
              h('span', { style: titleStyle }, `${fullscreenRecord.title.length > 0 ? fullscreenRecord.title : fullscreenRecord.uiId} ${tr('fullscreenSuffix', '· fullscreen')}`),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => leaveFullscreen(fullscreenRecord.uiId),
                },
                tr('backToChat', 'Back to chat'),
              ),
              h('button', { type: 'button', style: buttonStyle, onClick: () => dismiss(fullscreenRecord.uiId) }, tr('close', 'Close')),
            ),
            h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, h(HtmlUiFrame, { record: fullscreenRecord, theme: state.theme, variant: 'dock', bare: true })),
          ),
        );
      }

      return h(
        'div',
        { style: { position: 'fixed', inset: '0', pointerEvents: 'none' } },
        ...layers,
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

    /** Bring one float to the front of the floating stack. */
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
      const description = typeof template.description === 'string' && template.description.length > 0 ? template.description : '';
      const id = name === slug ? '' : ` (${slug})`;
      return `${name}${id}${description.length > 0 ? ` — ${description}` : ''}`;
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
            pointerEvents: 'auto',
            background: 'rgba(0,0,0,0.28)',
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) close();
          },
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr('createTitle', 'New HTML interface'),
        },
        h(
          'div',
          {
            style: {
              width: 'min(520px, 92vw)',
              maxHeight: '80vh',
              overflow: 'auto',
              background: 'var(--dsw-alias-bg-overlay, #fff)',
              color: 'var(--dsw-alias-text-primary, #111)',
              border: '1px solid var(--dsw-alias-border-l1, #ddd)',
              borderRadius: '12px',
              boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
              padding: '14px 16px',
            },
          },
          h('div', { style: Object.assign({}, titleStyle, { fontSize: '14px', marginBottom: '4px' }) }, tr('createTitle', 'New HTML interface')),
          h(
            'div',
            { style: { fontSize: '11.5px', opacity: 0.65, marginBottom: '10px' } },
            tr('createHint', 'Nothing here goes through the model; the interface is created in this session right away.'),
          ),
          h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '6px 0 4px' } }, tr('createSource', 'New HTML project')),
          // Where the list comes from, read from the host on every open. The reader can
          // point it at their own directory; an empty value restores the defaults.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
            h('input', {
              type: 'text',
              value: state.templates.dirInput !== undefined ? state.templates.dirInput : state.templates.dir ?? '',
              placeholder: tr('createDirPlaceholder', 'No directory chosen yet'),
              onChange: (event) => {
                state.templates.dirInput = event.target.value;
                bump();
              },
              style: {
                flex: '1 1 auto',
                minWidth: '0',
                font: 'inherit',
                fontSize: '12px',
                padding: '4px 8px',
                borderRadius: '7px',
                border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                background: 'var(--dsw-alias-bg-base, #fff)',
                color: 'inherit',
              },
            }),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
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
                style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
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
            { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '10px' } },
            radio('dsh-create-source', 'blank', tr('newBlank', 'Blank canvas'), state.create.source === 'blank', () => {
              state.create.source = 'blank';
              bump();
            }),
            ...items.map((template) =>
              radio(
                'dsh-create-source',
                template.slug,
                // The reader's own name first: the slug is an id, and an id is not what a
                // person looks for in a list. It stays visible beside it, in parentheses,
                // because it is what `template=` takes.
                templateListItem(template),
                state.create.source === template.slug,
                () => {
                  state.create.source = template.slug;
                  bump();
                },
              ),
            ),
          ),
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
          state.templates.error !== null
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #c33)', marginBottom: '8px' } }, String(state.templates.error))
            : null,
          state.templates.notice !== null
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '8px' } }, String(state.templates.notice))
            : null,
          // Files copied into the directory that are not projects yet: a folder without a
          // manifest, or a file whose name cannot be a slug. Asking is the whole point —
          // silently skipping them is what made a copied file look like it never arrived.
          candidates.length > 0
            ? h(
                'div',
                { style: { marginBottom: '10px' } },
                h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '6px 0 4px' } }, `${tr('candidatesTitle', 'Not projects yet')} (${candidates.length})`),
                h(
                  'div',
                  { style: { fontSize: '11.5px', opacity: 0.72, marginBottom: '4px' } },
                  tr('candidatesHint', 'These are in the directory but carry no project manifest. Adopt one and it becomes a template you can create from.'),
                ),
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
                        style: Object.assign({}, buttonStyle, { flex: '0 0 auto' }),
                        onClick: () => {
                          const stem = candidate.name.replace(/\.html?$/iu, '');
                          state.adopt = {
                            open: true,
                            source: candidate.name,
                            slug: slugifyClient(stem),
                            name: stem,
                            description: '',
                            placement: 'dock-right',
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
                      h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, `${tr('adoptTitle', 'Project details for')} ${state.adopt.source}`),
                      // The reader's own instruction: nothing is written before they say
                      // so. The files are not touched, no manifest exists yet, and the
                      // project only comes into being on the confirm button below.
                      h(
                        'div',
                        { style: { fontSize: '11px', opacity: 0.7, marginBottom: '6px' } },
                        tr('adoptHint', 'Nothing is written yet: fill this in and the project is created with it.'),
                      ),
                      ...[
                        { key: 'slug', label: tr('adoptSlug', 'Project name'), hint: tr('adoptSlugHint', 'lowercase letters, digits, dot, dash, underscore') },
                        { key: 'name', label: tr('adoptName', 'Process name'), hint: '' },
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
                              fontSize: '12px',
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
                              fontSize: '12px',
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
                      h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: buttonStyle,
                            onClick: () => {
                              state.adopt = { open: false, source: '', slug: '', name: '', description: '', placement: 'dock-right', busy: false };
                              bump();
                            },
                          },
                          tr('cancel', 'Cancel'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: Object.assign({}, buttonStyle, { borderColor: 'transparent', background: 'var(--dsw-alias-bg-accent, #247bbf)', color: '#fff' }),
                            disabled: state.adopt.busy === true,
                            onClick: () => {
                              adoptTemplate(state.adopt.source, {
                                slug: state.adopt.slug,
                                name: state.adopt.name,
                                description: state.adopt.description,
                                placement: state.adopt.placement,
                              });
                            },
                          },
                          state.adopt.busy === true ? tr('creating', 'Creating…') : tr('adoptConfirm', 'Write the manifest'),
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } },
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
              CLIENT_BUILD,
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              h('button', { type: 'button', style: buttonStyle, onClick: close }, tr('cancel', 'Cancel')),
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, buttonStyle, { borderColor: 'transparent', background: 'var(--dsw-alias-bg-accent, #247bbf)', color: '#fff' }),
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
            : h('div', null, ...rows),
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
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, buttonStyle, { height: '26px' }),
          title: tr('templatesTooltip', 'New HTML interface, or reuse a saved template'),
          onClick: () => {
            state.create.open = true;
            state.create.busy = false;
            state.create.dirInput = undefined;
            bump();
            // The source list is the catalogue, so ask for it as the dialog opens.
            loadTemplates();
          },
        },
        tr('templatesButton', '⟨+⟩ New HTML'),
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
        ROUTE_BASE,
        CLIENT_ACTIVE_LINE,
        TAB_ID,
        TAB_KIND,
        state,
        parseSizeText,
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
