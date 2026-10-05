/**
 * Shared test harness for the host half.
 *
 * The host half is plain Node, so it runs against a fake Cordis context, a fake
 * WebServer, and fake request/response pairs: no harness, no profile, no browser.
 * Every path it touches lives under a throwaway directory, so a developer
 * machine's real plugin data is never read or written.
 *
 * `test/host-half.test.mjs` keeps its own copy of these fixtures, tailored to the
 * assertions it makes there; new suites should start from this module.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal Cordis context stand-in: inject, effect, on, get, logger. */
export function createContext(services) {
  const disposed = [];
  const listeners = new Map();

  /** Run one registration factory eagerly; collect whatever disposer it yields. */
  function runEffect(factory) {
    if (typeof factory !== 'function') return undefined;
    if (factory.constructor.name === 'GeneratorFunction') {
      const iterator = factory();
      for (const disposer of iterator) {
        if (typeof disposer === 'function') disposed.push(disposer);
      }
      return () => {};
    }
    const result = factory();
    if (typeof result === 'function') disposed.push(result);
    return result;
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (key) => services[key],
    inject(keys, callback) {
      const scope = {
        logger: ctx.logger,
        get: (key) => (keys.includes(key) ? services[key] : undefined),
        reflect: { get: (key) => (keys.includes(key) ? services[key] : undefined) },
        effect: runEffect,
        on: ctx.on,
      };
      // An injected Cordis scope exposes each requested service as a property.
      for (const key of keys) {
        if (services[key] !== undefined) scope[key] = services[key];
      }
      callback(scope);
    },
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return () => {};
    },
    effect: runEffect,
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args);
    },
  };
  return { ctx, disposed, listeners };
}

export function createFakeServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
}

export function createFakeSessionController() {
  const prompts = [];
  return {
    prompts,
    async prompt(request) {
      prompts.push(request);
      return { accepted: true };
    },
  };
}

/**
 * Build one fake request/response exchange. `callRoute` awaits the end; a stream
 * route never ends, so its caller inspects the recorded chunks instead.
 */
export function createExchange({ method = 'GET', url = '/', headers = {}, body = undefined }) {
  const chunks = [];
  const listeners = new Map();
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    ended: false,
    writeHead(status, headers_) {
      this.statusCode = status;
      this.headers = headers_ ?? {};
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.ended = true;
      if (typeof this.onEnd === 'function') this.onEnd();
    },
    flushHeaders() {},
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return res;
    },
    once(name, handler) {
      return res.on(name, handler);
    },
  };
  const req = {
    method,
    url,
    headers,
    on(name, handler) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
      return req;
    },
    destroy() {
      res.ended = true;
    },
  };
  return {
    req,
    res,
    chunks,
    text: () => chunks.join(''),
    /** Fire one lifecycle event at both ends, as node would on socket close. */
    emit(name) {
      for (const handler of listeners.get(name) ?? []) handler();
    },
    /** Feed the body after the handler has subscribed. */
    start() {
      queueMicrotask(() => {
        if (body !== undefined) {
          for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body, 'utf8'));
        }
        for (const handler of listeners.get('end') ?? []) handler();
      });
    },
  };
}

/** Drive one route handler with a fake request/response pair and read the answer. */
export function callRoute(route, options) {
  const exchange = createExchange(options ?? {});
  return new Promise((resolve) => {
    exchange.res.onEnd = () =>
      resolve({ status: exchange.res.statusCode, headers: exchange.res.headers, text: exchange.text() });
    route.handler(exchange.req, exchange.res);
    exchange.start();
  });
}

/** Open a response that stays open (an SSE stream) and return its live recorder. */
export function startRoute(route, options) {
  const exchange = createExchange(options ?? {});
  route.handler(exchange.req, exchange.res);
  exchange.start();
  return exchange;
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Apply the host half against a fresh fake context and a throwaway data root.
 * @param options.entry - module to activate; defaults to this repository's source.
 * @returns the context pieces, the route helpers, and a disposer.
 */
export async function createHarness({ config = {}, services = {}, entry = '../index.js' } = {}) {
  const { apply } = await import(entry);
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-htmlui-robust-'));
  const previousRoot = process.env.DSH_HTMLUI_ROOT;
  process.env.DSH_HTMLUI_ROOT = join(scratch, 'data');

  const server = createFakeServer();
  const sessionController = createFakeSessionController();
  const tools = {
    registered: [],
    register(definition) {
      this.registered.push(definition);
      return () => {};
    },
    get(name) {
      return this.registered.find((definition) => definition.name === name);
    },
  };
  const systemPrompt = {
    sections: [],
    section(section) {
      this.sections.push(section);
      return () => {};
    },
    getSectionOrder() {
      return 10;
    },
  };
  const suite = createContext({ webServer: server, tools, systemPrompt, sessionController, ...services });
  apply(suite.ctx, config);

  return {
    scratch,
    root: join(scratch, 'data'),
    ctx: suite.ctx,
    server,
    tools,
    systemPrompt,
    sessionController,
    get route() {
      return server.routes[0];
    },
    call: (options) => callRoute(server.routes[0], options),
    start: (options) => startRoute(server.routes[0], options),
    tool: (name) => {
      const found = tools.registered.find((definition) => definition.name === name);
      if (found === undefined) throw new Error(`tool ${name} is not registered`);
      return found;
    },
    exec: (sessionId = 'session-test') => ({ agent: { session: { id: sessionId, header: { cwd: scratch } } } }),
    dispose() {
      for (const disposer of suite.disposed) {
        try {
          disposer();
        } catch {
          /* cleanup is best effort */
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.DSH_HTMLUI_ROOT;
      else process.env.DSH_HTMLUI_ROOT = previousRoot;
    },
  };
}
