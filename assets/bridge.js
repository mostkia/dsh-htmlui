/*
 * @mostkia/dsh-htmlui — document bridge.
 *
 * Injected by the host half into every HTML interface document, ahead of the
 * author's own markup. It exposes `window.dshHTML`, the only supported way for a
 * document to reach the model:
 *
 *   dshHTML.send(action, data)          -> POST an action; the model receives it
 *   dshHTML.state.get() / .set(value)   -> per-interface scratch state; survives a reload only
 *   dshHTML.store.get(name) / .set(...) -> named slots shared by every panel, kept on disk
 *   dshHTML.app(path, init) / .appUrl() -> this project's own backend, with no model round trip
 *   dshHTML.resize('520x360')           -> ask the host to resize the surface
 *   dshHTML.close()                     -> ask the host to remove the surface
 *   dshHTML.on(type, handler)           -> 'assistant' | 'session' | 'action' | 'store' | 'theme' | 'ready'
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
  /**
   * The shared slots this document declared, as the host sent them: one
   * `{ value, bytes, updatedAt }` per name. Reads are synchronous because the values travel with
   * the document, so the first frame can already show them; writes go back over the action
   * channel. Unlike `state`, a slot belongs to its name — it outlives the panel it was written
   * from, and every other panel that declared the same name sees the same value.
   */
  var slots = config.store !== null && typeof config.store === 'object' ? config.store : {};
  /** The author's script always runs after this one, so `ready` must be replayable. */
  var readyDetail = null;
  /**
   * Set once the touch watcher is installed. A fling scrolls the conversation from here, so the
   * host asks this document to stop it — a thumb on the page never reaches the frame itself.
   */
  var haltFling = function () {};

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
    events.addEventListener('reasoning', function (event) {
      emit('reasoning', JSON.parse(event.data));
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
    events.addEventListener('store', function (event) {
      var payload = JSON.parse(event.data);
      // Keep the local copy of the value layer current before announcing it, so a listener that
      // reads right away sees the value it was told about. A row event carries no body on purpose
      // — a row can be megabytes — so the reader fetches the row it wants.
      var isRows = payload !== null && typeof payload === 'object' && payload.layer === 'rows';
      if (!isRows && payload !== null && typeof payload === 'object' && typeof payload.slot === 'string') {
        if (payload.removed === true) delete slots[payload.slot];
        else slots[payload.slot] = { value: payload.value === undefined ? null : payload.value, bytes: payload.bytes, updatedAt: payload.updatedAt };
      }
      emit('store', payload);
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
      // Say how tall this document is again. The host page attaches its listener at a
      // moment of its own choosing, so the report sent on load can arrive too early to be
      // heard; answering the handshake is what makes the height reliable rather than
      // lucky, and a document that never changes size has no second chance to report.
      measure();
      return;
    }
    if (data.__dshHtmlUi === 'theme') applyTheme(data.theme);
    // A fling belongs to this document because the scroll does, so only this document can stop
    // it — and a thumb landing anywhere else on the page never reaches it. The host watches for
    // that touch and says so here.
    if (data.__dshHtmlUi === 'halt') haltFling();
  });

  /**
   * Hand the wheel to the conversation when nothing here can use it.
   *
   * An inline document used to be a child of the transcript, so the browser's own scroll chaining
   * carried a wheel it could not use up to the conversation. It is hosted outside the transcript
   * now, which means that chain has nowhere to go and a wheel over a document with nothing to
   * scroll would do nothing at all. The decision is made synchronously and without
   * `preventDefault`, on a passive listener: when a scrollable ancestor of the pointer still has
   * room in the wheel's direction the browser scrolls it and nothing is forwarded; otherwise the
   * host scrolls the conversation by the same delta, which is exactly what chaining did.
   *
   * What is handed over is the *sum* of one frame's events, not one message per event. A wheel
   * that reports faster than the display — a high-resolution mouse, or two events in the same
   * frame — used to make the host scroll once per message, each of those a main-thread scroll of
   * the transcript. Summing them first makes the forwarded scroll cost the same as a native one:
   * one scroll per frame. The decision stays per event (`hasRoom` is read against the live
   * scroll position), so a document that can still scroll keeps each of its own ticks.
   */
  function watchWheel() {
    if (typeof document.addEventListener !== 'function') return;

    /** Whether this element can still scroll the way the wheel is pushing. */
    function hasRoom(element, dx, dy) {
      if (element === null || element === undefined) return false;
      var vertical = dy < 0 ? element.scrollTop > 0 : dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : false;
      var horizontal = dx < 0 ? element.scrollLeft > 0 : dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : false;
      return vertical || horizontal;
    }

    var pendingX = 0;
    var pendingY = 0;
    var queued = false;

    function flushWheel() {
      queued = false;
      var dx = pendingX;
      var dy = pendingY;
      pendingX = 0;
      pendingY = 0;
      if (dx !== 0 || dy !== 0) notifyHost('wheel', { deltaX: dx, deltaY: dy });
    }

    function queueWheel() {
      if (queued) return;
      queued = true;
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flushWheel);
      else setTimeout(flushWheel, 16);
    }

    document.addEventListener(
      'wheel',
      function (event) {
        // A pinch gesture zooms; it is not a scroll to forward.
        if (event.ctrlKey === true) return;
        var dx = event.deltaX;
        var dy = event.deltaY;
        var node = event.target;
        while (node !== null && node !== undefined) {
          if (hasRoom(node, dx, dy)) return;
          node = node.parentElement;
        }
        var factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight || 800 : 1;
        pendingX += dx * factor;
        pendingY += dy * factor;
        queueWheel();
      },
      { passive: true },
    );

    /**
     * The same decision for a finger, with two differences from the wheel.
     *
     * A touch the document cannot use does not chain to the page — the gesture ends at the frame,
     * which is the report that dragging over a panel "gets stuck" — so the movement has to be
     * forwarded. And it must be sampled in *screen* coordinates: the hosted frame follows its seat,
     * so while the host is scrolling, one stationary finger reports a different `clientY` inside
     * the frame on every event. That fed the page's own scroll back into the delta and the scroll
     * oscillated; `screenY` is anchored to the screen and does not move. Vertical only, one finger
     * only (a pinch is a zoom), one scroll per animation frame.
     */
    var touchAt = null;
    var touchAxis = null;
    var pendingY = 0;
    var pendingFrame = false;

    /**
     * Momentum, for the gestures the conversation owns.
     *
     * The document cannot chain a finger to the transcript, so the transcript is scrolled from
     * script — and a script-driven scroll stops dead the moment the finger lifts, because the
     * browser never owned that scroll and has no velocity to decay. Without a fling of its own,
     * a forwarded drag reads as "the page sticks to my thumb", which is exactly what it did.
     *
     * The last window of the gesture gives a speed in px/ms; each frame moves the transcript by
     * `speed × dt` while the speed decays per millisecond, so the shape is the same as a native
     * fling and does not depend on the display's frame rate.
     */
    var FLING_MIN_SPEED = 0.05; // px/ms — slower than this is a drift, not a throw
    var FLING_MAX_SPEED = 6; // px/ms — a thumb cannot do better, and a jump that large is an artifact
    var FLING_DECAY_PER_MS = 0.9965;
    var FLING_STOP_SPEED = 0.02;
    var FLING_WINDOW_MS = 120;

    /** The forwarded movement of this gesture, for the speed a release starts from. */
    var samples = [];
    var gestureDy = 0;
    var gestureOnPage = false;
    /** Who owns this gesture, and the box that owns it while the document does. */
    var gestureOwner = null;
    var gestureScroller = null;
    var flingSpeed = 0;
    var flingLast = 0;
    var flingRun = 0;

    function clock() {
      return typeof performance === 'object' && performance !== null && typeof performance.now === 'function' ? performance.now() : Date.now();
    }

    function startFling(speed) {
      flingRun += 1;
      flingSpeed = Math.max(-FLING_MAX_SPEED, Math.min(FLING_MAX_SPEED, speed));
      flingLast = 0;
      flingStep(0, flingRun);
    }

    function flingStep(stamp, run) {
      // A run number instead of cancelAnimationFrame: stopping has to work whether this browser
      // scheduled the next step on a frame or on a timeout, and a stale step does nothing.
      if (run !== flingRun) return;
      var at = typeof stamp === 'number' && stamp > 0 ? stamp : clock();
      var dt = flingLast === 0 ? 16 : at - flingLast;
      if (!(dt > 0)) dt = 16;
      // A backgrounded tab resumes with a huge delta; capping it keeps one frame from throwing
      // the conversation a screen and a half away.
      if (dt > 64) dt = 64;
      flingLast = at;
      var step = flingSpeed * dt;
      flingSpeed *= Math.pow(FLING_DECAY_PER_MS, dt);
      if (Math.abs(flingSpeed) < FLING_STOP_SPEED) flingSpeed = 0;
      if (step !== 0) notifyHost('touch', { deltaX: 0, deltaY: step });
      if (flingSpeed === 0) return;
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function (next) {
          flingStep(next, run);
        });
      } else {
        setTimeout(function () {
          flingStep(0, run);
        }, 16);
      }
    }

    function stopFling() {
      flingRun += 1;
      flingSpeed = 0;
      flingLast = 0;
    }

    haltFling = stopFling;

    /** The speed of the gesture that just ended, in px/ms, positive being the direction it moved. */
    function releasedSpeed() {
      if (samples.length < 2) return 0;
      var first = samples[0];
      var last = samples[samples.length - 1];
      var dt = last.t - first.t;
      if (!(dt > 0)) return 0;
      return (last.y - first.y) / dt;
    }

    /**
     * Whether this box can still scroll the way the finger is pushing.
     *
     * The one-pixel tolerance is not cosmetic: a scroll position can be reported a fraction short
     * of the real end, and without it a document that is already at its edge would be read as
     * still movable — so it would never hand the gesture over, which is the bug this exists for.
     */
    function canScrollVertically(element, dy) {
      if (element === null || element === undefined) return false;
      if (dy > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      if (dy < 0) return element.scrollTop > 0;
      return false;
    }

    function flushTouch() {
      pendingFrame = false;
      var dy = pendingY;
      pendingY = 0;
      if (dy !== 0) notifyHost('touch', { deltaX: 0, deltaY: dy });
    }

    function scheduleTouchFlush() {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flushTouch);
      else setTimeout(flushTouch, 16);
    }

    function forgetTouch() {
      touchAt = null;
      touchAxis = null;
    }

    document.addEventListener(
      'touchstart',
      function (event) {
        // A new touch owns the transcript again: whatever the last throw left running stops here.
        stopFling();
        samples = [];
        gestureDy = 0;
        gestureOnPage = false;
        gestureOwner = null;
        gestureScroller = null;
        var touches = event.touches;
        touchAt = touches !== undefined && touches !== null && touches.length === 1 ? { x: touches[0].screenX, y: touches[0].screenY } : null;
        touchAxis = null;
      },
      { passive: true },
    );

    document.addEventListener(
      'touchmove',
      function (event) {
        if (touchAt === null) return;
        var touches = event.touches;
        if (touches === undefined || touches === null || touches.length !== 1) {
          forgetTouch();
          return;
        }
        var point = touches[0];
        var dx = touchAt.x - point.screenX;
        var dy = touchAt.y - point.screenY;
        touchAt = { x: point.screenX, y: point.screenY };
        // A jump this large is a scroll artifact, not a finger.
        if (dy === 0 || Math.abs(dy) > 80) return;
        // Decide the axis once per gesture: a finger is never perfectly straight, and re-deciding
        // forwarded the sideways part of the wobble as a sideways scroll.
        if (touchAxis === null) {
          if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          touchAxis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
        }
        if (touchAxis !== 'y') return;
        // Who owns this gesture: decided once, and handed over at most once.
        //
        // Re-deciding on every event was tried and dropped. The moment a document reached its
        // edge the gesture changed hands, and the first small movement back gave it straight back
        // again, so the two scrollers fought every wobble — one direction looked fine while the
        // other was taken over by the conversation immediately. What survives from that is the
        // part that was right: a document that has run out of room in the direction the finger is
        // pushing hands the gesture over for good, and never takes it back mid-drag. There is
        // nothing left to fight, and the conversation still picks up where the document stopped.
        if (gestureOwner === null) {
          var probe = event.target;
          gestureScroller = null;
          while (probe !== null && probe !== undefined) {
            if (typeof probe.scrollHeight === 'number' && probe.scrollHeight > probe.clientHeight + 1) {
              gestureScroller = probe;
              break;
            }
            probe = probe.parentElement;
          }
          gestureOwner = gestureScroller === null ? 'page' : 'document';
        }
        if (gestureOwner === 'document') {
          // Still inside the document and still room in this direction: the browser scrolls it,
          // and forwarding as well would scroll both at once.
          if (canScrollVertically(gestureScroller, dy)) return;
          gestureOwner = 'page';
        }
        gestureOnPage = true;
        pendingY += dy;
        // What this gesture has forwarded so far, and when — the release uses the last 120 ms of
        // it as the speed to continue at. Samples older than that are noise from before the throw.
        gestureDy += dy;
        samples.push({ y: gestureDy, t: clock() });
        while (samples.length > 2 && clock() - samples[0].t > FLING_WINDOW_MS) samples.shift();
        if (!pendingFrame) {
          pendingFrame = true;
          scheduleTouchFlush();
        }
      },
      { passive: true },
    );

    document.addEventListener(
      'touchend',
      function () {
        // Everything the browser would have done after a native scroll has to be done here: it
        // never owned this scroll, so it has no velocity to keep it going.
        var speed = gestureOnPage ? releasedSpeed() : 0;
        if (Math.abs(speed) >= FLING_MIN_SPEED) startFling(speed);
        forgetTouch();
        samples = [];
        gestureOnPage = false;
        gestureDy = 0;
        gestureOwner = null;
        gestureScroller = null;
      },
      { passive: true },
    );
    document.addEventListener(
      'touchcancel',
      function () {
        stopFling();
        forgetTouch();
        samples = [];
        gestureOnPage = false;
        gestureDy = 0;
        gestureOwner = null;
        gestureScroller = null;
      },
      { passive: true },
    );
  }

  /** Subscribe to one event type; the single path both `on` and `ready` take. */  function subscribe(type, handler) {
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
  }

  // The theme from the URL is applied at once: if the host's init handshake never
  // arrives, the document still matches the page instead of staying light.
  applyTheme(config.initialTheme);

  window.dshHTML = {
    version: typeof config.pluginVersion === 'string' ? config.pluginVersion : '0.0.0',
    uiId: uiId,
    sessionId: sessionId,
    routeBase: routeBase,
    theme: function () {
      return theme;
    },
    /** Immediate form of `on('ready', …)`, with the same payload. */
    ready: function (handler) {
      return subscribe('ready', handler);
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
    /**
     * The shared store: named slots that outlive this panel.
     *
     * A document reads only the slots it declared in its own `dsh-htmlui` meta
     * (`content="store=notes"`), which is also all it may write. A slot has two layers: a small
     * *value* that travels with the document (so `get` is synchronous and a panel paints its
     * first frame already filled), and *rows* — many records addressed by key, kept in SQLite and
     * fetched when they are wanted, which is where bulk data belongs. Writes answer `{ ok, bytes }`.
     */
    store: {
      /** One slot's value, or `null` when it was never written. */
      get: function (name) {
        var entry = slots[String(name)];
        return entry !== undefined && entry !== null && entry.value !== undefined ? entry.value : null;
      },
      /** Write one slot. Declare it first, or the host refuses with `ok: false`. */
      set: function (name, value) {
        var key = String(name);
        var stored = value === undefined ? null : value;
        return post({ op: 'store', store: 'set', name: key, value: stored }).then(function (result) {
          if (result.ok === true) {
            slots[key] = { value: stored, bytes: result.bytes, updatedAt: result.updatedAt };
          }
          return result;
        });
      },
      /** Forget one slot, everywhere: both its value and its rows. */
      remove: function (name) {
        var key = String(name);
        return post({ op: 'store', store: 'remove', name: key }).then(function (result) {
          if (result.ok === true) delete slots[key];
          return result;
        });
      },
      /** What this document declared, with the current size of its value. */
      list: function () {
        return Object.keys(slots).map(function (name) {
          var entry = slots[name];
          return {
            name: name,
            bytes: entry !== undefined && entry !== null && typeof entry.bytes === 'number' ? entry.bytes : 0,
            updatedAt: entry !== undefined && entry !== null && entry.updatedAt !== undefined ? entry.updatedAt : null,
          };
        });
      },
      /**
       * Hear about a slot *value* written anywhere — another panel, another session. The handler
       * gets `{ slot, layer, uiId, value, bytes, updatedAt, removed }`.
       */
      on: function (handler) {
        return subscribe('store', function (change) {
          if (change !== null && typeof change === 'object' && change.layer === 'rows') return;
          handler(change);
        });
      },
      /**
       * The row layer: many records in one slot, each addressed by a key.
       *
       * Everything here is asynchronous, because a row is fetched rather than inlined — a
       * notebook keeps one row per note, lists them with `keys()` (metadata only: key, title,
       * size, time), and loads a body only when somebody opens it. Rows are stored in SQLite
       * (`store/<slot>.db`); no SQL text crosses this bridge, so the shape of the data is the
       * whole API and a document cannot reach anything outside its own slot.
       */
      rows: {
        /**
         * One page of the index, newest first: `{ ok, total, rows: [{ key, title, bytes, updatedAt }] }`.
         * Page through `total` with `offset`/`limit` (limit is capped at 500).
         */
        keys: function (name, options) {
          var opts = options !== null && typeof options === 'object' ? options : {};
          return post({ op: 'store', store: 'rows', rows: 'keys', name: String(name), offset: opts.offset, limit: opts.limit });
        },
        /** One row with its value: `{ ok, key, row }`, where `row` is `null` when the key is unused. */
        get: function (name, key) {
          return post({ op: 'store', store: 'rows', rows: 'get', name: String(name), key: String(key) });
        },
        /**
         * Write one row. `title` is stored beside the value so a list can show it without
         * fetching bodies; it is also what `search` looks at, together with the value when the
         * value is a string.
         */
        set: function (name, key, value, options) {
          var opts = options !== null && typeof options === 'object' ? options : {};
          return post({
            op: 'store',
            store: 'rows',
            rows: 'set',
            name: String(name),
            key: String(key),
            value: value === undefined ? null : value,
            title: opts.title,
          });
        },
        /** Delete one row: `{ ok, removed }` (`false` when the key was already unused). */
        remove: function (name, key) {
          return post({ op: 'store', store: 'rows', rows: 'remove', name: String(name), key: String(key) });
        },
        /**
         * Substring search over keys, titles, and text — case-insensitive for ASCII, and correct
         * for Chinese at any query length. Answers metadata only: `{ ok, rows }`.
         */
        search: function (name, text, options) {
          var opts = options !== null && typeof options === 'object' ? options : {};
          return post({ op: 'store', store: 'rows', rows: 'search', name: String(name), text: String(text), limit: opts.limit });
        },
        /**
         * Hear about rows written anywhere. The handler gets `{ slot, layer: 'rows', key, uiId,
         * bytes, updatedAt, removed }` — no body, so fetch the row you care about.
         */
        on: function (handler) {
          return subscribe('store', function (change) {
            if (change === null || typeof change !== 'object' || change.layer !== 'rows') return;
            handler(change);
          });
        },
      },
    },
    /**
     * Call this project's own backend, with no model round trip.
     *
     * A project may ship a `server.js` beside its `index.html`; the host runs that file in the
     * same process as the plugin and answers here. The call carries this document's capability
     * token, so the host knows which project is asking and no other project can be reached from
     * here — and the reader has to have allowed that project to run backend code, or the answer is
     * a `403` that says so.
     *
     * Resolves to a response-shaped object rather than a raw `Response`, so a document can read
     * `(await dshHTML.app('status')).json()` on any engine this plugin supports:
     * `{ ok, status, body, text(), json() }`, where `body` is the text exactly as it arrived.
     */
    app: function (path, init) {
      var options = init !== null && typeof init === 'object' ? init : {};
      var url = this.appUrl(path, options.query);
      var failed = function (message) {
        return {
          ok: false,
          status: 0,
          body: '',
          error: message,
          text: function () {
            return '';
          },
          json: function () {
            return null;
          },
        };
      };
      if (url === null) return Promise.resolve(failed('bridge is not configured'));
      var headers = Object.assign({}, options.headers);
      var method = typeof options.method === 'string' ? options.method.toUpperCase() : options.body === undefined ? 'GET' : 'POST';
      var call = { method: method, credentials: 'omit', cache: 'no-store', headers: headers };
      if (options.body !== undefined) {
        if (typeof options.body === 'string') {
          call.body = options.body;
          if (headers['content-type'] === undefined) headers['content-type'] = 'text/plain; charset=utf-8';
        } else {
          call.body = JSON.stringify(options.body);
          if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
        }
      }
      return fetch(url, call)
        .then(function (response) {
          return response.text().then(function (text) {
            return {
              ok: response.ok,
              status: response.status,
              body: text,
              text: function () {
                return text;
              },
              json: function () {
                try {
                  return text.length === 0 ? null : JSON.parse(text);
                } catch (error) {
                  return null;
                }
              },
            };
          });
        })
        .catch(function (error) {
          lastError = String((error && error.message) || error);
          return failed(lastError);
        });
    },
    /** The URL `app()` calls: for an `<img src>`, a stylesheet, or a link the page builds itself. */
    appUrl: function (path, query) {
      if (routeBase.length === 0) return null;
      var clean = String(path === undefined || path === null ? '' : path).replace(/^\/+/, '');
      var url = routeBase + '/app/' + encodeURIComponent(uiId) + '/' + clean + '?t=' + encodeURIComponent(token);
      if (query !== null && typeof query === 'object') {
        Object.keys(query).forEach(function (key) {
          var value = query[key];
          if (value === undefined || value === null) return;
          url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(String(value));
        });
      }
      return url;
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
      return subscribe(type, handler);
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

  /**
   * Report how tall this document actually is.
   *
   * An iframe never grows to its content, so a surface that is meant to read as part
   * of the conversation has to say its own height; otherwise it shows a scrollbar for
   * three lines of content. Changes are coalesced into one frame of animation.
   */
  var lastHeight = 0;
  var measureScheduled = false;

  function measureNow() {
    measureScheduled = false;
    try {
      var root = document.documentElement;
      var body = document.body;
      var height = Math.max(root === null ? 0 : root.scrollHeight, body === null ? 0 : body.scrollHeight);
      if (height > 0 && Math.abs(height - lastHeight) >= 1) {
        lastHeight = height;
        notifyHost('content', { height: height });
      }
    } catch (error) {
      /* measuring must never break the document */
    }
  }

  function measure() {
    if (measureScheduled) return;
    measureScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureNow);
    else setTimeout(measureNow, 16);
  }

  if (typeof ResizeObserver === 'function') {
    try {
      new ResizeObserver(measure).observe(document.documentElement);
    } catch (error) {
      /* an unsupported observer is not fatal */
    }
  }
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);
  measure();
  watchWheel();

  readyDetail = { uiId: uiId, sessionId: sessionId, theme: theme };
  emit('ready', readyDetail);
})();
