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
 *   dock-right             not implemented yet; falls back to the dock above the composer
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
      collapsed: new Map(),
      fullscreen: null,
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

    function publish(record) {
      if (record === null || typeof record !== 'object') return;
      const uiId = String(record.uiId ?? '');
      if (uiId.length === 0) return;
      const previous = state.byId.get(uiId);
      state.byId.set(uiId, Object.assign({}, previous, record, { uiId }));
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
      removeFromSession(sessionId ?? record?.sessionId, uiId);
      if (state.fullscreen === uiId) state.fullscreen = null;
      bump();
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
      const cached = state.tickets.get(uiId);
      if (cached !== undefined && cached.theme === theme) return Promise.resolve(cached.url);
      return postJson('/ui/ticket', { uiId, theme }).then((value) => {
        if (value === null || value.ok !== true || typeof value.url !== 'string') return undefined;
        state.tickets.set(uiId, { url: value.url, theme });
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

    // ---------------------------------------------------------------- surfaces

    function HtmlUiFrame(props) {
      const { record, theme, variant } = props;
      const [url, setUrl] = useState(undefined);
      const [status, setStatus] = useState('loading');
      const frameRef = useRef(null);
      const nonceRef = useRef(newNonce());
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

      useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        ensureTicket(record.uiId, theme).then((next) => {
          if (cancelled) return;
          if (typeof next !== 'string') {
            setStatus('error');
            return;
          }
          setUrl(next);
        });
        return () => {
          cancelled = true;
        };
      }, [record.uiId, record.revision, record.placement, theme]);

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
          return h('div', { style: emptyStyle }, 'HTML UI unavailable — the document could not be loaded.');
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
      }, [url, status, record.uiId, record.title, handshake]);

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
              ? h('button', { type: 'button', style: buttonStyle, onClick: () => props.onDismiss(record.uiId), title: 'Remove' }, '✕')
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
            onPointerCancel: onResizeUp,
          }),
        );
      }

      const height = variant === 'inline' ? Math.min(INLINE_MAX_HEIGHT, initial.h ?? 420) : '100%';
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
                { type: 'button', style: buttonStyle, onClick: () => props.onToggleCollapse(record.uiId), title: 'Collapse' },
                props.collapsed === true ? '▸' : '▾',
              )
            : null,
          props.onDismiss !== undefined
            ? h('button', { type: 'button', style: buttonStyle, onClick: () => props.onDismiss(record.uiId), title: 'Remove' }, '✕')
            : null,
        ),
        props.collapsed === true
          ? null
          : h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, body),
      );
    }

    // --------------------------------------------------------------- tool card

    function HtmlUiToolView(props) {
      useStore();
      const { phase, block } = props;
      const args = argsOf(block);
      const meta = metaOf(block);
      const sessionId = typeof meta?.sessionId === 'string' && meta.sessionId.length > 0 ? meta.sessionId : undefined;

      useEffect(() => {
        const next = recordFromMeta(meta, sessionId);
        if (next === undefined) {
          if (meta !== undefined && meta.htmlui === true && meta.op === 'close' && typeof meta.uiId === 'string') {
            retire(meta.uiId);
          }
          return;
        }
        publish(next);
      }, [meta, sessionId]);

      if (phase === 'preparing') {
        return h(
          'div',
          { style: Object.assign({}, surfaceChrome, { border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: '10px' }) },
          h('span', { style: titleStyle }, 'Preparing HTML interface…'),
        );
      }

      const record = recordFromMeta(meta, sessionId);
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
        return h(
          'div',
          { style: { margin: '2px 0' } },
          h(HtmlUiFrame, {
            record,
            theme: state.theme,
            variant: 'inline',
            onDismiss: (uiId) => {
              retire(uiId);
              postJson('/rpc', { uiId, op: 'close' });
            },
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
        h('span', { style: Object.assign({}, titleStyle, { flex: '1 1 auto' }) }, `${record.title.length > 0 ? record.title : record.uiId} · 已投放到 ${placement}`),
        placement === 'fullscreen'
          ? h('button', { type: 'button', style: buttonStyle, onClick: openFullscreen }, '打开')
          : null,
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            onClick: () => {
              retire(record.uiId);
              postJson('/rpc', { uiId: record.uiId, op: 'close' });
            },
          },
          '关闭',
        ),
      );
    }

    // ------------------------------------------------------------------- docks

    function HtmlUiDock(props) {
      useStore();
      const sessionId = sessionIdOf(props);
      const [height, setHeight] = useState(360);

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

      if (sessionId === undefined) return null;
      const records = recordsIn(sessionId, ['dock-top', 'dock-bottom', 'panel', 'dock-right']);
      if (records.length === 0) return null;

      const resizeRef = useRef(null);
      const onResizeDown = useCallback(
        (event) => {
          if (event.button !== 0) return;
          resizeRef.current = { h: height, y: event.clientY };
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

      const dismiss = (uiId) => {
        retire(uiId);
        postJson('/rpc', { uiId, op: 'close' });
      };
      const toggle = (uiId) => {
        state.collapsed.set(uiId, state.collapsed.get(uiId) !== true);
        bump();
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0' } },
        h('div', {
          style: { height: '6px', cursor: 'ns-resize', touchAction: 'none', borderRadius: '3px', background: 'transparent' },
          onPointerDown: onResizeDown,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeUp,
          onPointerCancel: onResizeUp,
          title: 'Drag to resize',
        }),
        ...records.map((record) =>
          h(
            'div',
            {
              key: record.uiId,
              style: {
                maxHeight: state.collapsed.get(record.uiId) === true ? 'auto' : `${height}px`,
                display: 'flex',
                flexDirection: 'column',
                minHeight: '0',
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

      if (sessionId === undefined) return null;
      const records = recordsFor(sessionId);
      if (records.length === 0) return null;

      const floats = records.filter((record) => record.placement === 'float');
      const backgrounds = records.filter((record) => record.placement === 'background');
      const fullscreenRecord =
        state.fullscreen !== null
          ? records.find((record) => record.uiId === state.fullscreen)
          : records.find((record) => record.placement === 'fullscreen');

      const dismiss = (uiId) => {
        retire(uiId);
        postJson('/rpc', { uiId, op: 'close' });
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
            h(HtmlUiFrame, { record, theme: state.theme, variant: 'background', onDismiss: undefined }),
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
            },
            h(
              'div',
              { style: Object.assign({}, surfaceChrome, { minHeight: '36px', padding: '0 10px' }) },
              h('span', { style: titleStyle }, `${fullscreenRecord.title.length > 0 ? fullscreenRecord.title : fullscreenRecord.uiId} · 全覆盖模式`),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  onClick: () => {
                    state.fullscreen = null;
                    bump();
                  },
                },
                '切回聊天',
              ),
              h('button', { type: 'button', style: buttonStyle, onClick: () => dismiss(fullscreenRecord.uiId) }, '关闭'),
            ),
            h('div', { style: { flex: '1 1 auto', minHeight: '0' } }, h(HtmlUiFrame, { record: fullscreenRecord, theme: state.theme, variant: 'dock' })),
          ),
        );
      }

      return h('div', { style: { position: 'fixed', inset: '0', pointerEvents: 'none' } }, ...layers);
    }

    // -------------------------------------------------------------------- apply

    function apply(ctx) {
      const disposers = [];
      state.theme = readTheme();

      disposers.push(
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'html_ui' }, (props) => h(HtmlUiToolView, Object.assign({}, props, { ctx }))),
        ),
      );

      disposers.push(
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'htmlui-dock', order: 40 }, (props) => h(HtmlUiDock, Object.assign({}, props, { ctx }))),
        ),
      );

      disposers.push(
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'htmlui-overlay', order: 30 }, (props) => h(HtmlUiOverlay, Object.assign({}, props, { ctx }))),
        ),
      );

      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
        ctx.logger.info('[dsh-htmlui] client active');
      } else {
        console.info('[dsh-htmlui] client active');
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

    return { inject: ['slots', 'sessions'], apply };
  },
});
