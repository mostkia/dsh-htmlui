/*
 * @mostkia/dsh-htmlui — document bridge.
 *
 * Injected by the host half into every HTML interface document, ahead of the
 * author's own markup. It exposes `window.dshHTML`, the only supported way for a
 * document to reach the model:
 *
 *   dshHTML.send(action, data)          -> POST an action; the model receives it
 *   dshHTML.state.get() / .set(value)   -> server-side state, survives reload
 *   dshHTML.resize('520x360')           -> ask the host to resize the surface
 *   dshHTML.close()                     -> ask the host to remove the surface
 *   dshHTML.on(type, handler)           -> 'assistant' | 'session' | 'action' | 'theme' | 'ready'
 *   dshHTML.stream()                    -> open the SSE stream explicitly
 *
 * The document runs in an opaque-origin sandbox: it has no cookies, no storage,
 * and no access to the host page. Everything it needs travels through here.
 */
(function () {
  'use strict';

  if (window.dshHTML !== undefined) return;

  var config = window.__DSH_HTMLUI__ !== null && typeof window.__DSH_HTMLUI__ === 'object' ? window.__DSH_HTMLUI__ : {};
  var routeBase = typeof config.routeBase === 'string' && config.routeBase.length > 0 ? config.routeBase : '';
  var uiId = typeof config.uiId === 'string' ? config.uiId : '';
  var sessionId = typeof config.sessionId === 'string' ? config.sessionId : '';
  var token = typeof config.token === 'string' ? config.token : '';

  var listeners = Object.create(null);
  var source = null;
  var nonce = null;
  var theme = config.initialTheme === 'dark' ? 'dark' : 'light';
  var lastError = null;
  /** The author's script always runs after this one, so `ready` must be replayable. */
  var readyDetail = null;

  function emit(type, detail) {
    var bucket = listeners[type];
    if (bucket !== undefined) {
      for (var i = 0; i < bucket.length; i += 1) {
        try {
          bucket[i](detail);
        } catch (error) {
          console.warn('[dshHTML] listener failed for "' + type + '"', error);
        }
      }
    }
    try {
      document.dispatchEvent(new CustomEvent('dsh-htmlui:' + type, { detail: detail }));
    } catch (error) {
      /* CustomEvent unavailable: listeners above still ran */
    }
  }

  function applyTheme(next) {
    if (next !== 'dark' && next !== 'light') return;
    if (next === theme) return;
    theme = next;
    document.documentElement.setAttribute('data-dsh-htmlui-theme', theme);
    emit('theme', { theme: theme });
  }

  document.documentElement.setAttribute('data-dsh-htmlui-theme', theme);

  function post(body) {
    if (routeBase.length === 0) {
      return Promise.resolve({ ok: false, error: 'bridge is not configured' });
    }
    return fetch(routeBase + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ t: token, uiId: uiId }, body)),
      credentials: 'omit',
      cache: 'no-store',
    })
      .then(function (response) {
        return response.json().catch(function () {
          return { ok: false, error: 'invalid response (' + response.status + ')' };
        });
      })
      .catch(function (error) {
        lastError = String((error && error.message) || error);
        return { ok: false, error: lastError };
      });
  }

  /** Tell the host page about a local intent it can apply without a round trip. */
  function notifyHost(kind, payload) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage(Object.assign({ __dshHtmlUi: kind, nonce: nonce, uiId: uiId }, payload), '*');
    } catch (error) {
      /* the host page may be gone */
    }
  }

  function stream() {    if (source !== null || typeof EventSource !== 'function' || routeBase.length === 0) return source;
    var url = routeBase + '/events?uiId=' + encodeURIComponent(uiId) + '&t=' + encodeURIComponent(token);
    var events = new EventSource(url, { withCredentials: false });
    events.addEventListener('hello', function (event) {
      emit('ready', JSON.parse(event.data));
    });
    events.addEventListener('assistant', function (event) {
      emit('assistant', JSON.parse(event.data));
    });
    events.addEventListener('session', function (event) {
      emit('session', JSON.parse(event.data));
    });
    events.addEventListener('action', function (event) {
      emit('action', JSON.parse(event.data));
    });
    events.addEventListener('ui', function (event) {
      emit('ui', JSON.parse(event.data));
    });
    events.onerror = function () {
      emit('error', { error: 'stream disconnected; the browser will retry' });
    };
    source = events;
    return source;
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data === null || typeof data !== 'object' || data.__dshHtmlUi === undefined) return;
    if (data.__dshHtmlUi === 'init') {
      nonce = typeof data.nonce === 'string' ? data.nonce : null;
      applyTheme(data.theme);
      if (event.source !== null && typeof event.source.postMessage === 'function') {
        try {
          event.source.postMessage({ __dshHtmlUi: 'ready', nonce: nonce, uiId: uiId }, '*');
        } catch (error) {
          /* the host page may be gone */
        }
      }
      return;
    }
    if (data.__dshHtmlUi === 'theme') applyTheme(data.theme);
  });

  window.dshHTML = {
    version: typeof config.pluginVersion === 'string' ? config.pluginVersion : '0.0.0',
    uiId: uiId,
    sessionId: sessionId,
    routeBase: routeBase,
    theme: function () {
      return theme;
    },
    ready: function (handler) {
      if (typeof handler === 'function') {
        stream();
        handler({ uiId: uiId, sessionId: sessionId });
      }
      return undefined;
    },
    stream: stream,
    send: function (action, data, options) {
      // `op` is what the host dispatches on: without it every interaction would be
      // refused as an unsupported operation.
      var body =
        typeof action === 'object' && action !== null
          ? Object.assign({ op: 'action' }, action)
          : { op: 'action', action: action, data: data };
      if (options !== null && typeof options === 'object' && options.steer === true) body.steer = true;
      if (body.action === undefined || body.action === null || String(body.action).length === 0) {
        return Promise.resolve({ ok: false, error: 'an action name is required' });
      }
      return post(body).then(function (result) {
        if (result.ok !== true) console.warn('[dshHTML] send failed', result);
        return result;
      });
    },
    state: {
      get: function () {
        return config.state === undefined ? null : config.state;
      },
      set: function (value) {
        return post({ op: 'state', value: value === undefined ? null : value });
      },
    },
    resize: function (size) {
      return post({ op: 'resize', size: size }).then(function (result) {
        notifyHost('resize', { size: size });
        return result;
      });
    },
    close: function () {
      return post({ op: 'close' }).then(function (result) {
        notifyHost('close', {});
        return result;
      });
    },
    on: function (type, handler) {
      if (typeof type !== 'string' || typeof handler !== 'function') return function () {};
      // The document's own script runs after the bridge, so a `ready` handler
      // registered then would never see the event that already fired.
      if (type === 'ready' && readyDetail !== null) {
        try {
          handler(readyDetail);
        } catch (error) {
          console.warn('[dshHTML] listener failed for "ready"', error);
        }
        return function () {};
      }
      stream();
      if (listeners[type] === undefined) listeners[type] = [];
      listeners[type].push(handler);
      return function () {
        var bucket = listeners[type];
        if (bucket === undefined) return;
        var index = bucket.indexOf(handler);
        if (index >= 0) bucket.splice(index, 1);
      };
    },
    off: function (type, handler) {
      var bucket = listeners[type];
      if (bucket === undefined) return;
      var index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
    lastError: function () {
      return lastError;
    },
  };

  readyDetail = { uiId: uiId, sessionId: sessionId, theme: theme };
  emit('ready', readyDetail);
})();
