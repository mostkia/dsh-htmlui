/*
 * @mostkia/dsh-htmlui — browser half.
 *
 * Renders every attached HTML document in a sandboxed iframe and places it where
 * its record says it belongs:
 *
 *   inline                 the tool card that carried it, inside the transcript
 *   dock-top / dock-bottom the full-width dock above the composer
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
    /** Printed once on activation: the installed half can be confirmed from the console. */
    const CLIENT_ACTIVE_LINE = '[dsh-htmlui] client active (0.1.1)';
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
    const DOCK_MAX_HEIGHT = 720;
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
      collapsed: new Map(),
      fullscreen: null,
      /** Interfaces the user switched away from, so auto-open does not fight them. */
      fullscreenDismissed: new Set(),
      /** Right-sidebar availability: the native split needs the column's tab service. */
      rightPane: { available: false, controller: undefined, opened: new Set() },
      /** The template drawer: what the catalogue holds and whether it is showing. */
      templates: { open: false, loaded: false, items: [], error: null },
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

    function publish(record) {
      if (record === null || typeof record !== 'object') return;
      const uiId = String(record.uiId ?? '');
      if (uiId.length === 0) return;
      // A surface the user closed stays closed. Otherwise the next `/ui/list`
      // convergence (or any seat's sync) would bring it straight back, which is
      // exactly what "the close button does nothing" looks like.
      if (state.dismissed.has(uiId)) return;
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
        publish(record);
      }
      for (const known of recordsFor(sessionId)) {
        if (!seen.has(known.uiId)) retire(known.uiId, sessionId);
      }
      // A dismissal ends when the host stops listing the id: from then on a record
      // with that id is a new interface the user has not closed.
      for (const uiId of state.dismissed) {
        if (!seen.has(uiId)) forgetDismissal(uiId);
      }
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
      const promise = postJson('/ui/list', { sessionId }).then((value) => {
        if (value !== null && value.ok === true) convergeSession(sessionId, value.uis);
        return value;
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
        if (value.ui !== undefined) publish(value.ui);
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
        rightPaneEmpty: 'This session has no right-column interface.',
        templatesButton: '⟨/⟩ Templates',
        templatesTooltip: 'HTML UI templates',
        templatesTitle: 'HTML UI templates',
        apply: 'Apply',
        applyHint: 'Apply to this session (no model round trip)',
        toModel: 'Ask the model',
        toModelHint: 'Put the instruction in the composer instead',
        collapse: 'Hide',
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
        rightPaneEmpty: '这个会话还没有右侧栏界面。',
        templatesButton: '⟨/⟩ 模板',
        templatesTooltip: 'HTML UI 模板',
        templatesTitle: 'HTML UI 模板',
        apply: '套用',
        applyHint: '套用到当前会话（不经过模型）',
        toModel: '交给模型',
        toModelHint: '把指令放进输入框，交给模型',
        collapse: '收起',
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

    /**
     * Resolve one message. The locale lookup returns the key itself for an unknown
     * entry, which is the signal to keep the literal.
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
      if (params !== undefined) {
        for (const [name, replacement] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(replacement));
        }
      }
      return text;
    }

    // ---------------------------------------------------------------- templates

    /** Load the catalogue the host keeps, so the drawer can offer it. */
    function loadTemplates() {
      return postJson('/templates', {}).then((value) => {
        if (value !== null && value.ok === true && Array.isArray(value.templates)) {
          state.templates.items = value.templates;
          state.templates.error = null;
        } else {
          state.templates.error = (value !== null && value.error) || 'unavailable';
        }
        state.templates.loaded = true;
        bump();
        return state.templates.items;
      });
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
     */
    function applyTemplate(slug, sessionId) {
      if (typeof slug !== 'string' || slug.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
        return Promise.resolve(false);
      }
      return postJson('/templates/render', { template: slug, sessionId }).then((value) => {
        if (value !== null && value.ok === true && value.ui !== undefined) {
          publish(value.ui);
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
      const frameRef = useRef(null);
      const nonceRef = useRef(newNonce());
      const urlRef = useRef(undefined);
      const initial = props.initialSize ?? parseSizeText(record.sizeText) ?? {};
      const [size, setSize] = useState(() => {
        if (variant === 'float') {
          return {
            w: initial.w ?? DEFAULT_FLOAT.w,
            h: initial.h ?? DEFAULT_FLOAT.h,
            x: initial.x ?? DEFAULT_FLOAT.x,
            y: initial.y ?? DEFAULT_FLOAT.y,
          };
        }
        return { w: initial.w, h: initial.h };
      });

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
        }
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [record.uiId, props.onDismiss]);

      const dragRef = useRef(null);
      const onPointerDown = useCallback(
        (event) => {
          if (variant !== 'float' || event.button !== 0) return;
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
            },
          },
          h(
            'div',
            {
              style: Object.assign({}, surfaceChrome, { cursor: 'grab', touchAction: 'none' }),
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp,
            },
            h('span', { style: titleStyle }, `${record.title !== undefined && record.title.length > 0 ? record.title : record.uiId} · float`),
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

      const height = variant === 'inline' ? Math.min(INLINE_MAX_HEIGHT, initial.h ?? 420) : '100%';
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
              height: typeof height === 'number' ? `${height}px` : height,
              minHeight: '0',
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-base, #fff)',
            },
          },
          h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, body),
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

      // A dock-right interface lives in the right column: reveal its tab as soon as
      // the column can be opened. The controller binds asynchronously, so this
      // retries whenever it arrives rather than giving up on the first render.
      const rightPaneController = state.rightPane.controller;
      useEffect(() => {
        if (record === undefined || record.placement !== 'dock-right') return;
        if (state.rightPane.opened.has(record.uiId)) return;
        openRightPane(record.uiId);
      }, [record === undefined ? undefined : record.uiId, record === undefined ? undefined : record.placement, rightPaneController]);

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
        return h(
          'div',
          { style: { margin: '2px 0' } },
          h(HtmlUiFrame, {
            record,
            theme: state.theme,
            variant: 'inline',
            onDismiss: (uiId) => dismissRecord(uiId),
          }),
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
     * Which placements one dock claims. dock-right belongs to the right column only
     * while that column can actually open a tab: the type registering is not enough,
     * because the interface would then be in no seat at all. Until the controller is
     * bound, the composer dock keeps claiming it, and only that dock claims it so a
     * record never renders twice.
     */
    function dockPlacements(base) {
      return base.includes('dock-top') && !rightPaneReady() ? [...base, 'dock-right'] : base;
    }

    function HtmlUiDock(props) {
      useStore();
      const sessionId = resolveSessionId(props);
      const [height, setHeight] = useState(360);
      useSessionSync(sessionId);

      // Every hook runs before the early returns below. They were once after them,
      // which was invisible while the session never resolved (the dock always left at
      // the first return); the moment records started matching, the hook count changed
      // between renders and React raised error #310 ("rendered more hooks than during
      // the previous render"), which the surface boundary then showed in red.
      const resizeRef = useRef(null);
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
        const next = Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, start.h + (start.y - event.clientY)));
        setHeight(next);
      }, []);
      const onResizeUp = useCallback(() => {
        resizeRef.current = null;
      }, []);

      if (sessionId === undefined) return null;
      const base = Array.isArray(props.placements) ? props.placements : ['dock-top', 'panel'];
      const placements = dockPlacements(base);
      const records = recordsIn(sessionId, placements);
      if (records.length === 0) return null;

      const dismiss = dismissRecord;
      const toggle = toggleCollapsed;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0' } },
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
            setHeight((current) => Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, current + step)));
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
      if (sessionId === undefined) return null;
      const records = recordsIn(sessionId, ['dock-right']);
      if (records.length === 0) {
        return h('div', { style: emptyStyle }, tr('rightPaneEmpty', 'This session has no right-column interface.'));
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: '0', padding: '6px' } },
        ...records.map((record) =>
          h(
            'div',
            {
              key: record.uiId,
              style: { flex: '1 1 auto', minHeight: '0', display: 'flex', flexDirection: 'column' },
            },
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
     * Wire the right column: stage one registers the tab type, stage two the body.
     * Every step is contained — a column that exposes no tab service (or refuses
     * the definition) leaves dock-right on its composer-dock fallback instead of
     * taking the whole browser half down with it.
     */
    function wireRightPane(ctx, disposers) {
      disposers.push(
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            guarded(ctx, (props) => h(HtmlUiRightPane, Object.assign({}, props, { ctx }))),
          ),
        ),
      );
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['sidebarRightTabs'], (scope) => {
        try {
          const tabs = scope.sidebarRightTabs;
          if (tabs === undefined || typeof tabs.register !== 'function') return;
          scope.effect(() => {
            // The registry owns the registration's lifecycle; this effect owns
            // only the flag other components read, and clears it on teardown so
            // dock-right moves back to its fallback instead of vanishing.
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              multiple: false,
              title: () => 'HTML UI',
            });
            state.rightPane.available = true;
            bump();
            return () => {
              state.rightPane.available = false;
              bump();
            };
          }, 'dsh-htmlui: right-pane tab type');
        } catch (error) {
          logWarn(ctx, 'dsh-htmlui: right-pane tab type unavailable', error);
        }
      });
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
        postJson('/ui/list', { sessionId }).then((value) => {
          if (cancelled) return;
          if (value !== null && value.ok === true && Array.isArray(value.uis)) {
            for (const record of value.uis) publish(record);
          }
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
      if (records.length === 0) return null;

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
        layers.push(h(HtmlUiFrame, { key: record.uiId, record, theme: state.theme, variant: 'float', onDismiss: dismiss }));
      }

      if (fullscreenRecord !== undefined) {
        layers.push(
          h(
            'div',
            {
              key: `fs-${fullscreenRecord.uiId}`,
              style: {
                position: 'fixed',
                inset: '0',
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

      return h('div', { style: { position: 'fixed', inset: '0', pointerEvents: 'none' } }, ...layers);
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
      const rows = items.slice(0, 40).map((template) =>
        h(
          'div',
          {
            key: template.slug,
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: '8px',
              padding: '5px 8px',
              borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
            },
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
        state.templates.loaded !== true
          ? h('div', { style: { padding: '6px 10px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('loading', 'Reading templates…'))
          : items.length === 0
            ? h('div', { style: { padding: '6px 10px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #888)' } }, tr('empty', 'No templates yet: have the model save one with html_ui_template, or drop your own .html into the templates directory.'))
            : h('div', null, ...rows),
      );
    }

    /** The one control that opens the drawer, beside the composer. */
    function HtmlUiTemplateButton(props) {
      useStore();
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, buttonStyle, { height: '26px' }),
          title: tr('templatesTooltip', 'HTML UI templates'),
          onClick: () => toggleTemplates(),
        },
        tr('templatesButton', '⟨/⟩ Templates'),
      );
    }

    // -------------------------------------------------------------------- apply

    function apply(ctx) {
      const disposers = [];
      state.theme = readTheme();
      // A fresh activation must not inherit a binding from a previous one.
      translateRef = null;

      // Visible text: register this plugin's dictionary with the Client locale
      // service and bind it. The service is optional — `ctx.get("locale")` is the
      // documented optional access — so a deployment without it keeps the English
      // literals, and a refusal of the dictionary never costs us the surfaces.
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
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

      disposers.push(
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'htmlui-dock', order: 40 },
            guarded(ctx, (props) => h(HtmlUiDock, Object.assign({}, props, { ctx, placements: ['dock-top', 'panel'] }))),
          ),
        ),
      );

      // The seat below the composer card is what makes dock-bottom a real split
      // rather than a second stack above the input.
      disposers.push(
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'htmlui-dock-bottom', order: 40 },
            guarded(ctx, (props) => h(HtmlUiDock, Object.assign({}, props, { ctx, placements: ['dock-bottom'] }))),
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
        wireRightPane(ctx, disposers);
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
        activeFullscreen,
        isCurrentRevision,
        loadTemplates,
        toggleTemplates,
        applyTemplate,
        askModelForTemplate,
        ensureTicket,
        ticketToken,
        tr,
        MESSAGES,
        LOCALE_NS,
        HtmlUiTemplateDrawer,
        HtmlUiTemplateButton,
        HtmlUiBoundary,
        guarded,
        ReactComponent,
        dismissRecord,
        toggleCollapsed,
        openRightPane,
        rightPaneReady,
        dockPlacements,
        useOptionalDisclosure,
        wireRightPane,
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
