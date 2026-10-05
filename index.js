/**
 * @mostkia/dsh-htmlui — host half.
 *
 * The plugin lets the model author HTML/CSS/JS and hang it on the conversation:
 * inline in the transcript, docked beside or below the composer, floating over
 * the frame, or taking the whole session view. The browser half renders each
 * document in a sandboxed iframe; this half owns storage, the model tools, and
 * the HTTP carrier the document talks to.
 *
 * Carrier (all routes live under `/plugins/@mostkia/dsh-htmlui`):
 *   POST /ui/ticket      web page -> short-lived document URL (loopback origin only)
 *   POST /ui/list        session -> UI records, so a reloaded page rebuilds its layout
 *   POST /templates      the template catalogue, for the page's drawer
 *   POST /templates/render  apply one template to a session, with no model round trip
 *   GET  /ui/<id>        the composed HTML document (sandboxed iframe target, token in query)
 *   GET  /assets/bridge.js  the injected bridge script
 *   POST /rpc            document -> plugin: action / state / resize / close  (token)
 *   GET  /events         document <- plugin: SSE stream for the owning session (token)
 *
 * Zero runtime harness imports, deliberately: an external plugin's node half must
 * not depend on the harness module graph at runtime. Services are reached through
 * `ctx.inject` + `ctx.get`, and every path derives from `$DSH_HOME` or the OS home
 * directory, so nothing here is machine specific.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-htmlui';

/** Package name doubles as the route prefix and the client module id. */
const PKG = '@mostkia/dsh-htmlui';
const ROUTE_PREFIX = `/plugins/${PKG}`;
const BRIDGE_FILE = 'bridge.js';
const PLUGIN_VERSION = '0.1.1';

const PLACEMENTS = [
  'inline',
  'dock-right',
  'dock-top',
  'dock-bottom',
  'float',
  'background',
  'fullscreen',
  'panel',
];

const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_UI_PER_SESSION = 24;
const MAX_TEMPLATES = 200;
const MAX_STATE_BYTES = 64 * 1024;
// Every carrier route shares this cap. State is the largest legitimate payload
// (MAX_STATE_BYTES); anything above this is a body nobody asked for.
const MAX_BODY_BYTES = 256 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const ACTION_BUCKET = { capacity: 8, refillMs: 1_500 };

const UI_ID_RE = /^ui-[0-9a-f]{8,32}$/;
const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SESSION_ID_MAX = 200;

const DEFAULT_ACTION_PROMPT = [
  'The user just interacted with the HTML UI above.',
  'Continue from that interaction: update the interface (html_ui op=update or op=render) or answer the user.',
].join(' ');

// ---------------------------------------------------------------- small utils

function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

let tempCounter = 0;

/** A temp name no other writer in this process, or another process, can take. */
function tempPathFor(path) {
  tempCounter = (tempCounter + 1) % 1_000_000;
  return `${path}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
}

function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = tempPathFor(path);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function writeTextAtomic(path, text) {
  ensureDir(dirname(path));
  const tmp = tempPathFor(path);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function readTextCapped(path, limit) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > limit) throw new Error(`file is larger than ${limit} bytes`);
  return readFileSync(path, 'utf8');
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Drop `undefined` members so a projection stays lossless JSON.
 * The tool registry rejects a presentation projection that carries any
 * non-serializable member, and an optional field that was not set is exactly that.
 */
function lossless(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member;
  }
  return out;
}

/** Resolve a caller-supplied path against the session workspace, staying generic. */
function resolveInputPath(value, cwd) {
  const raw = expandHome(String(value ?? '').trim());
  if (raw.length === 0) throw new Error('empty path');
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd ?? process.cwd(), raw);
}

/**
 * A document path must name a document. The plugin only ever renders HTML, so
 * anything else is a mistake worth reporting rather than a file to copy into the
 * data root and hand to a browser.
 */
function resolveHtmlInputPath(value, cwd) {
  const path = resolveInputPath(value, cwd);
  if (!/\.(?:html?|xhtml)$/iu.test(path)) {
    throw new Error(`not an HTML document: ${path} (expected .html, .htm, or .xhtml)`);
  }
  return path;
}

/** `520x360`, `520x360+80+60`, `80%x50%` or `{w,h,x,y}` all normalize to numbers. */
function normalizeSize(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    if (value.w !== undefined || value.width !== undefined) out.w = clampInt(value.w ?? value.width, 80, 100_000, undefined);
    if (value.h !== undefined || value.height !== undefined) out.h = clampInt(value.h ?? value.height, 80, 100_000, undefined);
    if (value.x !== undefined || value.left !== undefined) out.x = clampInt(value.x ?? value.left, -100_000, 100_000, undefined);
    if (value.y !== undefined || value.top !== undefined) out.y = clampInt(value.y ?? value.top, -100_000, 100_000, undefined);
    return Object.keys(out).length === 0 ? undefined : out;
  }
  const text = String(value).trim().toLowerCase().replace(/\s+/gu, '');
  const match = /^(\d{2,6})?(?:x(\d{2,6}))?(?:\+(-?\d{1,6}))?(?:\+(-?\d{1,6}))?$/u.exec(text);
  if (match === null || match[0].length === 0) return undefined;
  const out = {};
  if (match[1] !== undefined) out.w = clampInt(match[1], 80, 100_000, undefined);
  if (match[2] !== undefined) out.h = clampInt(match[2], 80, 100_000, undefined);
  if (match[3] !== undefined) out.x = clampInt(match[3], -100_000, 100_000, undefined);
  if (match[4] !== undefined) out.y = clampInt(match[4], -100_000, 100_000, undefined);
  return Object.keys(out).length === 0 ? undefined : out;
}

function formatSize(size) {
  if (size === undefined) return '';
  const parts = [];
  if (size.w !== undefined) parts.push(String(size.w));
  if (size.h !== undefined) parts.push(`x${size.h}`);
  if (size.x !== undefined || size.y !== undefined) parts.push(`+${size.x ?? 0}+${size.y ?? 0}`);
  return parts.join('');
}

function normalizePlacement(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PLACEMENTS.includes(text) ? text : undefined;
}

function slugify(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, 64);
  return TEMPLATE_SLUG_RE.test(text) ? text : undefined;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function escapeForInlineScript(json) {
  return JSON.stringify(json).replace(/</gu, '\\u003c').replace(/\u2028|\u2029/gu, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

// --------------------------------------------------------------- document ops

/**
 * Insert head/body fragments into an authored document without restructuring it.
 * A document that is only a fragment gets the fragments prepended instead.
 */
function injectIntoDocument(doc, headHtml, bodyHtml) {
  let out = String(doc ?? '');
  const headMatch = /<head\b[^>]*>/iu.exec(out);
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length;
    out = `${out.slice(0, at)}${headHtml}${out.slice(at)}`;
  } else {
    const htmlMatch = /<html\b[^>]*>/iu.exec(out);
    if (htmlMatch !== null) {
      const at = htmlMatch.index + htmlMatch[0].length;
      out = `${out.slice(0, at)}<head>${headHtml}</head>${out.slice(at)}`;
    } else {
      const doctype = /^\s*<!doctype[^>]*>/iu.exec(out);
      const at = doctype === null ? 0 : doctype[0].length;
      out = `${out.slice(0, at)}${headHtml}${out.slice(at)}`;
    }
  }
  if (typeof bodyHtml === 'string' && bodyHtml.length > 0) {
    const closeBody = /<\/body\s*>/iu.exec(out);
    if (closeBody !== null) out = `${out.slice(0, closeBody.index)}${bodyHtml}${out.slice(closeBody.index)}`;
    else out = `${out}${bodyHtml}`;
  }
  return out;
}

/** Merge optional inline CSS/JS into the authored single-file document. */
function mergeInlineParts(html, css, js) {
  let out = String(html ?? '');
  if (typeof css === 'string' && css.trim().length > 0) {
    out = injectIntoDocument(out, `<style data-dsh-htmlui>\n${css}\n</style>\n`, '');
  }
  if (typeof js === 'string' && js.trim().length > 0) {
    out = injectIntoDocument(out, '', `<script data-dsh-htmlui>\n${js}\n</script>\n`);
  }
  return out;
}

/**
 * Read the placement a document declares for itself.
 *
 * A document is the best place to say where it belongs, and a template should
 * carry that with it. Two forms are accepted, the head-scoped one first:
 *
 *   <meta name="dsh-htmlui" content="placement=dock-top; size=520x360; title=Orders">
 *   <html data-dsh-htmlui-placement="float" data-dsh-htmlui-size="520x360">
 *
 * A tool argument always wins over a declaration, and an unusable value is
 * ignored rather than fatal.
 */
function readDocumentDeclaration(source) {
  const text = String(source ?? '');
  const declared = {};
  const meta = /<meta\b[^>]*\bname\s*=\s*["']dsh-htmlui["'][^>]*>/iu.exec(text);
  const content = meta === null ? null : /\bcontent\s*=\s*["']([^"']*)["']/iu.exec(meta[0]);
  if (content !== null) {
    for (const part of content[1].split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (key.length > 0 && value.length > 0) declared[key] = value;
    }
  }
  for (const [key, attribute] of [
    ['placement', 'data-dsh-htmlui-placement'],
    ['size', 'data-dsh-htmlui-size'],
    ['title', 'data-dsh-htmlui-title'],
  ]) {
    if (declared[key] !== undefined) continue;
    const match = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']*)["']`, 'iu').exec(text);
    if (match !== null && match[1].trim().length > 0) declared[key] = match[1].trim();
  }
  return declared;
}

const THEME_STYLE = [
  '<style data-dsh-htmlui-theme>',
  ':root{color-scheme:light;--dsh-htmlui-theme:light;--dsh-htmlui-bg:#ffffff;--dsh-htmlui-fg:#1a1a1a;',
  '--dsh-htmlui-muted:#6b6b6b;--dsh-htmlui-border:#e2e2e2;--dsh-htmlui-accent:#247bbf;}',
  'html[data-dsh-htmlui-theme="dark"]{color-scheme:dark;--dsh-htmlui-theme:dark;--dsh-htmlui-bg:#1b1b1e;',
  '--dsh-htmlui-fg:#f2f2f2;--dsh-htmlui-muted:#a0a0a6;--dsh-htmlui-border:#333338;--dsh-htmlui-accent:#6cb2e8;}',
  '</style>',
].join('');

/**
 * Compose the document actually served to the iframe: theme variables, the
 * runtime config, and the bridge script, ahead of anything the author wrote.
 *
 * A document that declares no doctype is served in quirks mode, where the box
 * model differs from what any modern stylesheet assumes (`width` includes
 * padding, and so on). A fragment authored as inline `html` is the common case,
 * so one is added when the author wrote none — the authored document itself is
 * never rewritten on disk.
 */
function composeDocument(source, config) {
  const script = `<script>window.__DSH_HTMLUI__=${escapeForInlineScript(config)};</script>`;
  const bridge = `<script src="${ROUTE_PREFIX}/assets/${BRIDGE_FILE}"></script>`;
  const text = String(source ?? '');
  const composed = injectIntoDocument(text, `${THEME_STYLE}\n${script}\n${bridge}\n`, '');
  return /^\s*<!doctype\b/iu.test(composed) ? composed : `<!doctype html>\n${composed}`;
}

// --------------------------------------------------------------------- store

function createStore(root) {
  const uiRoot = join(root, 'ui');
  const templateRoot = join(root, 'templates');
  const stateRoot = join(root, 'state');
  /** Templates shipped with the package are readable even before anything is saved. */
  const bundledTemplateRoot = fileURLToPath(new URL('./templates/', import.meta.url));
  ensureDir(uiRoot);
  ensureDir(templateRoot);
  ensureDir(stateRoot);

  function secret() {
    const path = join(root, 'secret');
    // An existing key is never rewritten, whatever its shape: rotating it would
    // silently invalidate the capability of every open interface.
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing.length > 0) return existing;
    }
    const next = randomUUID().replace(/-/gu, '') + randomUUID().replace(/-/gu, '');
    ensureDir(root);
    writeFileSync(path, next, { encoding: 'utf8', mode: 0o600 });
    return next;
  }

  function uiPath(id) {
    if (!UI_ID_RE.test(String(id ?? ''))) throw new Error(`invalid ui id: ${id}`);
    return join(uiRoot, id);
  }

  function readUi(id) {
    const dir = uiPath(id);
    const meta = readJson(join(dir, 'meta.json'), undefined);
    if (meta === undefined) return undefined;
    const documentPath = join(dir, 'index.html');
    return {
      meta,
      documentPath,
      source: existsSync(documentPath) ? readFileSync(documentPath, 'utf8') : '',
    };
  }

  /**
   * Persist a record. `source` is optional: a metadata-only change (a resize) must
   * not rewrite the document, which can be a megabyte.
   */
  function writeUi(meta, source) {
    const dir = ensureDir(uiPath(meta.id));
    if (source !== undefined) writeTextAtomic(join(dir, 'index.html'), source);
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    return meta;
  }

  function removeUi(id) {
    const dir = uiPath(id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  function listUis(sessionId) {
    const out = [];
    for (const entry of readdirSync(uiRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UI_ID_RE.test(entry.name)) continue;
      const meta = readJson(join(uiRoot, entry.name, 'meta.json'), undefined);
      if (meta === undefined) continue;
      if (sessionId !== undefined && meta.sessionId !== sessionId) continue;
      out.push(meta);
    }
    out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return out;
  }

  function templatePath(slug) {
    if (!TEMPLATE_SLUG_RE.test(String(slug ?? ''))) throw new Error(`invalid template name: ${slug}`);
    return join(templateRoot, slug);
  }

  function readTemplate(slug) {
    const dir = templatePath(slug);
    const meta = readJson(join(dir, 'meta.json'), undefined);
    const documentPath = join(dir, 'index.html');
    if (meta !== undefined && existsSync(documentPath)) {
      return { meta, documentPath, source: readFileSync(documentPath, 'utf8') };
    }
    const bare = readBareTemplate(templateRoot, slug);
    if (bare !== undefined) return bare;
    return readBundledTemplate(slug);
  }

  /**
   * Read a hand-written template: an `.html` file dropped straight into the
   * templates directory. This is the whole point of "reuse it yourself later" —
   * copy a document in, address it by its file name, no manifest to write.
   */
  function readBareTemplate(root, slug) {
    if (!TEMPLATE_SLUG_RE.test(String(slug ?? ''))) return undefined;
    const documentPath = join(root, `${slug}.html`);
    if (!existsSync(documentPath)) return undefined;
    return {
      meta: { slug, name: slug, description: '', bare: true },
      documentPath,
      source: readFileSync(documentPath, 'utf8'),
    };
  }

  /** Read one template shipped inside the package (read-only fallback). */
  function readBundledTemplate(slug) {
    if (!TEMPLATE_SLUG_RE.test(String(slug ?? ''))) return undefined;
    const dir = join(bundledTemplateRoot, slug);
    const meta = readJson(join(dir, 'meta.json'), undefined);
    const documentPath = join(dir, 'index.html');
    if (meta !== undefined && existsSync(documentPath)) {
      return { meta: { ...meta, bundled: true }, documentPath, source: readFileSync(documentPath, 'utf8') };
    }
    return readBareTemplate(bundledTemplateRoot, slug);
  }

  function writeTemplate(meta, source) {
    const dir = ensureDir(templatePath(meta.slug));
    writeTextAtomic(join(dir, 'index.html'), source);
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    return meta;
  }

  function removeTemplate(slug) {
    // Remove whatever is in force for this name: the managed template first,
    // then the hand-written file it may be covering.
    const dir = templatePath(slug);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      return true;
    }
    const bare = join(templateRoot, `${slug}.html`);
    if (existsSync(bare)) {
      rmSync(bare, { force: true });
      return true;
    }
    return false;
  }

  function listTemplates() {
    const out = [];
    const seen = new Set();
    const collect = (root, bundled) => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!TEMPLATE_SLUG_RE.test(entry.name) || seen.has(entry.name)) continue;
          const meta = readJson(join(root, entry.name, 'meta.json'), undefined);
          if (meta === undefined) continue;
          out.push(bundled ? { ...meta, bundled: true } : meta);
          seen.add(entry.name);
          continue;
        }
        const match = /^([a-z0-9][a-z0-9._-]{0,63})\.html$/u.exec(entry.name);
        if (match === null || seen.has(match[1])) continue;
        out.push({
          slug: match[1],
          name: match[1],
          description: '',
          bytes: entry.isFile() ? (() => { try { return statSync(join(root, entry.name)).size; } catch { return 0; } })() : 0,
          bare: true,
          ...(bundled ? { bundled: true } : {}),
        });
        seen.add(match[1]);
      }
    };
    collect(templateRoot, false);
    collect(bundledTemplateRoot, true);
    out.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
    return out;
  }

  function statePath(sessionId) {
    const key = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, SESSION_ID_MAX);
    if (key.length === 0) throw new Error('missing session id');
    return join(stateRoot, `${key}.json`);
  }

  function readState(sessionId) {
    const all = readJson(statePath(sessionId), {});
    return all !== null && typeof all === 'object' && !Array.isArray(all) ? all : {};
  }

  function writeState(sessionId, uiId, value) {
    const all = readState(sessionId);
    all[uiId] = value;
    writeJsonAtomic(statePath(sessionId), all);
    return value;
  }

  return {
    root,
    uiRoot,
    templateRoot,
    stateRoot,
    secret,
    readUi,
    writeUi,
    removeUi,
    listUis,
    readTemplate,
    writeTemplate,
    removeTemplate,
    listTemplates,
    readState,
    writeState,
    uiPath,
  };
}

// --------------------------------------------------------------- SSE hub

function createHub(logger) {
  const clients = new Set();

  function write(client, event, payload) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch (error) {
      logger?.warn?.(`dsh-htmlui: sse write failed: ${error?.message ?? error}`);
      return false;
    }
  }

  return {
    add(client) {
      clients.add(client);
      write(client, 'hello', {
        uiId: client.uiId,
        sessionId: client.sessionId,
        pluginVersion: PLUGIN_VERSION,
      });
    },
    remove(client) {
      clients.delete(client);
    },
    /** Push one event to every stream owned by the session. */
    push(sessionId, event, payload) {
      if (sessionId === undefined) return;
      for (const client of [...clients]) {
        if (client.sessionId !== sessionId) continue;
        if (!write(client, event, payload)) {
          clients.delete(client);
          try {
            client.res.end();
          } catch {
            /* already closed */
          }
        }
      }
    },
    closeAll() {
      for (const client of [...clients]) {
        clients.delete(client);
        try {
          client.res.end();
        } catch {
          /* already closed */
        }
      }
    },
    size() {
      return clients.size;
    },
  };
}

// ------------------------------------------------------------ HTTP utilities

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  };
}

function sendJson(res, status, body, extra) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...corsHeaders(),
    ...(extra ?? {}),
  });
  res.end(payload);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'content-type': type ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function requestMethod(req) {
  return String(req.method ?? 'GET').toUpperCase();
}

/**
 * Browser-origin policy. The web server ships no origin policy of its own, so
 * this route owner supplies one. Only loopback hosts are trusted by default: a
 * DNS-rebound page carries its own host name, so the Host header must be loopback
 * too, and a page whose Origin is a foreign host is refused whatever its Host
 * says.
 *
 * `allowedOrigins` is the operator's explicit escape hatch for a deliberately
 * exposed deployment (`webServer.host: 0.0.0.0`, a LAN address, a reverse proxy):
 * an origin listed there is trusted whatever the Host header says, because the
 * operator made that decision. Nothing is trusted implicitly.
 *
 * `capability` is one of:
 *   true   the request already carries a valid capability token;
 *   false  no token is involved on this route;
 *   'defer' the route handler validates a token from its payload before acting.
 *
 * An opaque origin (`null`, a sandboxed iframe) is accepted only where a token
 * proves the caller owns the document.
 */
function originDecision(req, capability, allowedOrigins) {
  const origin = req.headers.origin;
  const host = String(req.headers.host ?? '');
  const hostName = host.split(':')[0];
  const loopback = (name) =>
    name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]' || name.endsWith('.localhost');
  if (origin === undefined || origin === '') return { ok: true, opaque: false };
  if (origin === 'null') {
    if (capability === true) return { ok: true, opaque: true };
    if (capability === 'defer') return { ok: true, opaque: true };
    return { ok: false, code: 403, message: 'opaque origin requires a capability token' };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: 403, message: 'unparsable origin' };
  }
  if (allowedOrigins !== undefined && allowedOrigins.size > 0 && allowedOrigins.has(parsed.origin)) {
    return { ok: true, opaque: false, explicit: true };
  }
  if (!loopback(parsed.hostname) || !loopback(hostName)) {
    return { ok: false, code: 403, message: 'origin not allowed' };
  }
  if (parsed.host !== host) return { ok: false, code: 403, message: 'origin does not match host' };
  return { ok: true, opaque: false };
}

/** Normalize configured origins to the exact strings the browser will send. */
function normalizeOrigins(value) {
  const out = new Set();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    try {
      out.add(new URL(entry.trim()).origin);
    } catch {
      // An unusable entry is ignored rather than failing activation; the default
      // posture (loopback only) stays in force for it.
    }
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        rejectPromise(new Error(`request body larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
  });
}

async function readJsonBody(req, limit) {
  const text = await readBody(req, limit);
  if (text.trim().length === 0) return {};
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be a JSON object');
  }
  return value;
}

// ------------------------------------------------------------------- plugin

/**
 * @param {object} ctx - Cordis context of the plugin row.
 * @param {object} [config] - optional row config (`root`, `maxInlineBytes`, `actionPrompt`).
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {};
  const root = (() => {
    const configured = expandHome(settings.root);
    if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim());
    const fromEnv = expandHome(process.env.DSH_HTMLUI_ROOT);
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
    const home = expandHome(process.env.DSH_HOME);
    const base = typeof home === 'string' && home.trim().length > 0 ? resolve(home.trim()) : join(homedir(), '.dsh');
    return join(base, 'htmlui');
  })();
  const maxInlineBytes = clampInt(settings.maxInlineBytes, 1024, MAX_DOCUMENT_BYTES, DEFAULT_MAX_INLINE_BYTES);
  const allowedOrigins = normalizeOrigins(settings.allowedOrigins);
  const actionPrompt =
    typeof settings.actionPrompt === 'string' && settings.actionPrompt.trim().length > 0
      ? settings.actionPrompt.trim()
      : DEFAULT_ACTION_PROMPT;

  const store = createStore(root);
  const hub = createHub(ctx.logger);
  const logger = ctx.logger;

  /** Per-UI token buckets keep a runaway document from flooding the model. */
  const buckets = new Map();
  function takeToken(uiId) {
    const now = Date.now();
    const bucket = buckets.get(uiId) ?? { tokens: ACTION_BUCKET.capacity, at: now };
    const refill = Math.floor((now - bucket.at) / ACTION_BUCKET.refillMs);
    if (refill > 0) {
      bucket.tokens = Math.min(ACTION_BUCKET.capacity, bucket.tokens + refill);
      bucket.at = now;
    }
    if (bucket.tokens <= 0) {
      buckets.set(uiId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    buckets.set(uiId, bucket);
    return true;
  }

  function tokenFor(uiId) {
    return createHmac('sha256', store.secret()).update(`ui:${uiId}`).digest('base64url').slice(0, 32);
  }

  function tokenMatches(uiId, token) {
    if (!UI_ID_RE.test(String(uiId ?? ''))) return false;
    return safeEqual(tokenFor(uiId), token);
  }

  /**
   * The document URL carries the revision, so an `op=update` produces a different
   * URL and the browser actually reloads the frame. Without it React keeps the
   * same `src` and the interface would show the previous document until a manual
   * refresh — which is the whole point of updating it in place.
   */
  function documentUrl(uiId, theme, revision) {
    const suffix = theme === 'dark' || theme === 'light' ? `&theme=${theme}` : '';
    const rev = Number.isFinite(revision) ? `&r=${revision}` : '';
    return `${ROUTE_PREFIX}/ui/${uiId}?t=${tokenFor(uiId)}${rev}${suffix}`;
  }

  function recordSummary(meta) {
    const size = formatSize(meta.size);
    return `${meta.id} ${meta.placement ?? 'inline'}${size.length > 0 ? ` ${size}` : ''} ${meta.title ?? ''}`.trim();
  }

  /**
   * Token-free address of a document, safe for anything durable. The capability
   * token is minted per request by {@link documentUrl} and handed out only by the
   * ticket route, so it never reaches a tool result, a session log, a list
   * response, or a stream frame.
   */
  function recordPath(meta) {
    return `${ROUTE_PREFIX}/ui/${meta.id}?r=${meta.revision ?? 1}`;
  }

  /** Public (browser-facing) projection of one UI record. */
  function publicRecord(meta) {
    return {
      uiId: meta.id,
      sessionId: meta.sessionId,
      title: meta.title ?? '',
      placement: meta.placement ?? 'inline',
      size: meta.size,
      sizeText: formatSize(meta.size),
      path: meta.path ?? `${ROUTE_PREFIX}/ui/${meta.id}`,
      url: recordPath(meta),
      revision: meta.revision ?? 1,
      bytes: meta.bytes ?? 0,
      origin: meta.origin ?? 'inline',
      template: meta.template,
      createdAt: meta.createdAt ?? 0,
      updatedAt: meta.updatedAt ?? 0,
    };
  }

  function createUi(input) {
    const id = `ui-${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
    const now = Date.now();
    const meta = {
      id,
      sessionId: input.sessionId,
      title: input.title ?? '',
      placement: input.placement ?? 'inline',
      size: input.size,
      path: `${ROUTE_PREFIX}/ui/${id}`,
      origin: input.origin ?? 'inline',
      template: input.template,
      sourcePath: input.sourcePath,
      revision: 1,
      bytes: byteLength(input.source),
      createdAt: now,
      updatedAt: now,
    };
    store.writeUi(meta, input.source);
    hub.push(meta.sessionId, 'ui', { action: 'open', ui: publicRecord(meta) });
    return meta;
  }

  function updateUi(id, input) {
    const current = store.readUi(id);
    if (current === undefined) throw new Error(`unknown ui id: ${id}`);
    const meta = {
      ...current.meta,
      title: input.title ?? current.meta.title,
      placement: input.placement ?? current.meta.placement,
      size: input.size ?? current.meta.size,
      template: input.template ?? current.meta.template,
      sourcePath: input.sourcePath ?? current.meta.sourcePath,
      revision: (current.meta.revision ?? 1) + 1,
      bytes: byteLength(input.source),
      updatedAt: Date.now(),
    };
    store.writeUi(meta, input.source);
    hub.push(meta.sessionId, 'ui', { action: 'update', ui: publicRecord(meta) });
    return meta;
  }

  function closeUi(id) {
    const current = store.readUi(id);
    if (current === undefined) return undefined;
    store.removeUi(id);
    hub.push(current.meta.sessionId, 'ui', { action: 'close', ui: publicRecord(current.meta) });
    return current.meta;
  }

  /**
   * Resolve an interface the calling session owns. A model that guesses another
   * session's id must not be able to rewrite or remove that session's surfaces,
   * so ownership is checked on every mutating tool path.
   */
  function readOwnedUi(id, sessionId) {
    const key = String(id ?? '');
    let current;
    try {
      current = key.length > 0 ? store.readUi(key) : undefined;
    } catch {
      // An id that is not an id is simply not a record: caller-supplied input must
      // not steer control flow through an exception.
      current = undefined;
    }
    if (current === undefined) return { error: `unknown ui id: ${key}`, hint: 'call html_ui op=list' };
    if (sessionId === undefined) return { error: 'no session in tool context', hint: 'this tool must run inside a session' };
    if (current.meta.sessionId !== sessionId) {
      return { error: 'that interface belongs to another session', hint: 'call html_ui op=list for this session' };
    }
    return { record: current };
  }

  function resolveSessionId(explicit, exec) {
    const fromArg = typeof explicit === 'string' && explicit.trim().length > 0 ? explicit.trim() : undefined;
    if (fromArg !== undefined) return fromArg;
    const agent = exec?.agent;
    const id = agent?.session?.id;
    return id === undefined || id === null ? undefined : String(id);
  }

  function readSourceInput(args, cwd) {
    const templateName = typeof args.template === 'string' ? slugify(args.template) : undefined;
    if (args.template !== undefined && templateName === undefined) throw new Error('invalid template name');
    if (templateName !== undefined) {
      const template = store.readTemplate(templateName);
      if (template === undefined) throw new Error(`unknown template: ${templateName}`);
      const variables =
        args.variables !== null && typeof args.variables === 'object' && !Array.isArray(args.variables)
          ? args.variables
          : {};
      let source = template.source;
      for (const [key, value] of Object.entries(variables)) {
        source = source.split(`{{${key}}}`).join(String(value));
      }
      return { source, origin: 'template', template: templateName };
    }
    if (typeof args.path === 'string' && args.path.trim().length > 0) {
      const path = resolveHtmlInputPath(args.path, cwd);
      const source = readTextCapped(path, MAX_DOCUMENT_BYTES);
      return { source: mergeInlineParts(source, args.css, args.js), origin: 'file', sourcePath: path };
    }
    if (typeof args.html === 'string' && args.html.trim().length > 0) {
      if (byteLength(args.html) > maxInlineBytes) {
        throw new Error(`inline html exceeds maxInlineBytes (${maxInlineBytes}); write it to a file and pass path`);
      }
      for (const part of [args.css, args.js]) {
        if (typeof part === 'string' && byteLength(part) > maxInlineBytes) {
          throw new Error(`inline css/js exceeds maxInlineBytes (${maxInlineBytes}); write it to a file and pass path`);
        }
      }
      return { source: mergeInlineParts(args.html, args.css, args.js), origin: 'inline' };
    }
    return undefined;
  }

  // ---------------------------------------------------------------- tool defs

  const uiOutputSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      op: { type: 'string' },
      uiId: { type: 'string' },
      title: { type: 'string' },
      placement: { type: 'string' },
      size: { type: 'string' },
      sessionId: { type: 'string' },
      url: { type: 'string' },
      bytes: { type: 'number' },
      revision: { type: 'number' },
      count: { type: 'number' },
      summary: { type: 'string' },
      error: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['ok', 'op'],
    additionalProperties: false,
  };

  function renderTemplateAck(value) {
    if (value.ok !== true) {
      return ['[html-ui-template]', 'status=failed', `op=${value.op}`, `error=${value.error ?? 'unknown'}`, value.hint ?? '']
        .filter((line) => line.length > 0)
        .join('\n');
    }
    const lines = ['[html-ui-template]', 'status=ok', `op=${value.op}`];
    if (value.name !== undefined) lines.push(`name=${value.name}`);
    if (value.bytes !== undefined) lines.push(`bytes=${value.bytes}`);
    if (value.count !== undefined) lines.push(`count=${value.count}`);
    if (value.summary !== undefined) lines.push(`list=${value.summary}`);
    lines.push('next=html_ui op=render template=<name>');
    return lines.join('\n');
  }

  function renderAck(value) {
    if (value.ok !== true) {
      return [`[html-ui]`, `status=failed`, `op=${value.op}`, `error=${value.error ?? 'unknown'}`, value.hint ?? '']
        .filter((line) => line.length > 0)
        .join('\n');
    }
    const lines = ['[html-ui]', 'status=ok', `op=${value.op}`];
    if (value.uiId !== undefined) lines.push(`ui_id=${value.uiId}`);
    if (value.title !== undefined && value.title.length > 0) lines.push(`title=${JSON.stringify(value.title)}`);
    if (value.placement !== undefined) lines.push(`placement=${value.placement}`);
    if (value.size !== undefined && value.size.length > 0) lines.push(`size=${value.size}`);
    if (value.bytes !== undefined) lines.push(`bytes=${value.bytes}`);
    if (value.revision !== undefined) lines.push(`revision=${value.revision}`);
    if (value.count !== undefined) lines.push(`count=${value.count}`);
    if (value.summary !== undefined && value.summary.length > 0) lines.push(`list=${value.summary}`);
    if (value.op === 'close') lines.push('next=the interface was removed from the conversation');
    else if (value.op === 'list') lines.push('next=use html_ui op=update with an existing ui_id, or op=render for a new one');
    else lines.push(`next=update it later with html_ui op=update id=${value.uiId ?? '<id>'}`);
    lines.push('notes=interactions inside the document reach you as a user message; local-only interactions need no round trip');
    return lines.join('\n');
  }

  /**
   * Browser-facing projection of one tool result. It must always be lossless
   * JSON — including for `list` and `close`, which carry no document — because
   * the registry rejects both a non-serializable member and a bare `undefined`.
   */
  const uiMeta = (value) =>
    lossless({
      htmlui: value.ok === true,
      op: value.op,
      uiId: value.uiId,
      sessionId: value.sessionId,
      title: value.title ?? '',
      placement: value.placement ?? 'inline',
      size: value.size ?? '',
      url: value.url,
      revision: value.revision ?? 1,
      bytes: value.bytes ?? 0,
      summary: value.summary,
      count: value.count,
    });

  const htmlUiTool = {
    name: 'html_ui',
    description:
      'Render, update, or close an HTML interface attached to this conversation. The HTML is authored by you and runs in a sandboxed iframe: it can call DSH through the injected window.dshHTML bridge (actions, state, events). Placement decides where it lives: inline (in the transcript), dock-top/dock-bottom (full-width above/below the composer), dock-right (session side panel), float (draggable window), background (click-through layer), fullscreen (takes the session view, with a built-in switch back to the chat), panel (resident dock that updates in place). Prefer writing large documents to a file and passing path; inline html is capped.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['render', 'update', 'close', 'list'],
          description: 'render creates a new interface, update replaces an existing one, close removes it, list reports the session interfaces.',
        },
        id: { type: 'string', description: 'Existing ui id, required by update and close.' },
        title: { type: 'string', description: 'Short human title shown by the host chrome and used by the model loop.' },
        html: { type: 'string', description: 'Inline HTML document or fragment. Keep it small; large documents belong in a file.' },
        path: { type: 'string', description: 'Path to an HTML document (.html, .htm, or .xhtml; workspace relative or absolute). Preferred for real interfaces.' },
        css: { type: 'string', description: 'Extra CSS merged into the document when html or path is used.' },
        js: { type: 'string', description: 'Extra script merged into the document when html or path is used.' },
        placement: {
          type: 'string',
          enum: PLACEMENTS,
          description:
            'Where the interface lives. Defaults to what the document declares for itself (a dsh-htmlui meta tag or data-dsh-htmlui-placement attribute), otherwise inline.',
        },
        size: { type: 'string', description: 'Optional geometry, e.g. "520x360" or "520x360+80+60" for a float window.' },
        template: { type: 'string', description: 'Template name to instantiate instead of html/path.' },
        variables: {
          type: 'object',
          additionalProperties: true,
          description: 'Placeholder values for {{name}} tokens when rendering from a template.',
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: uiOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderAck(value) }],
      presentationMeta: (_args, value) => uiMeta(value),
    },
    async execute(args, exec) {
      const op = String(args?.op ?? '');
      const cwd = exec?.agent?.session?.header?.cwd;
      try {
        if (op === 'list') {
          const sessionId = resolveSessionId(undefined, exec);
          const all = sessionId === undefined ? store.listUis() : store.listUis(sessionId);
          // A session holds at most MAX_UI_PER_SESSION, and the model needs every id
          // to be able to close one; truncation is stated rather than silent.
          const shown = all.slice(0, MAX_UI_PER_SESSION);
          const summary = `${shown.map(recordSummary).join(' | ')}${
            all.length > shown.length ? ` …(+${all.length - shown.length} more)` : ''
          }`;
          return { ok: true, op, count: all.length, summary, sessionId: sessionId ?? '' };
        }
        if (op === 'close') {
          const id = String(args?.id ?? '');
          if (id.length === 0) return { ok: false, op, error: 'id is required', hint: 'call html_ui op=list' };
          const sessionId = resolveSessionId(undefined, exec);
          const owned = readOwnedUi(id, sessionId);
          if (owned.error !== undefined) return { ok: false, op, error: owned.error, hint: owned.hint };
          const closed = closeUi(id);
          if (closed === undefined) return { ok: false, op, error: `unknown ui id: ${id}`, hint: 'call html_ui op=list' };
          return { ok: true, op, uiId: id, title: closed.title ?? '', placement: closed.placement ?? '' };
        }
        if (op !== 'render' && op !== 'update') {
          return { ok: false, op: op.length > 0 ? op : 'unknown', error: 'unsupported op', hint: 'use render, update, close, or list' };
        }
        const sessionId = resolveSessionId(undefined, exec);
        if (sessionId === undefined) {
          return { ok: false, op, error: 'no session in tool context', hint: 'this tool must run inside a session' };
        }
        let own = sessionId;
        if (op === 'update') {
          const owned = readOwnedUi(String(args?.id ?? ''), sessionId);
          if (owned.error !== undefined) return { ok: false, op, error: owned.error, hint: owned.hint };
          own = owned.record.meta.sessionId;
        }
        const count = store.listUis(own).length;
        if (op === 'render' && count >= MAX_UI_PER_SESSION) {
          return {
            ok: false,
            op,
            error: `this session already holds ${count} interfaces`,
            hint: 'close one with html_ui op=close, or update an existing ui id',
          };
        }
        const source = readSourceInput(args ?? {}, cwd);
        if (source === undefined) {
          return { ok: false, op, error: 'nothing to render', hint: 'pass html, path, or template' };
        }
        // The cap applies to what gets stored, not only to what was read: a file at
        // the limit plus a large inline css and js would otherwise exceed it.
        if (byteLength(source.source) > MAX_DOCUMENT_BYTES) {
          return {
            ok: false,
            op,
            error: `composed document is larger than ${MAX_DOCUMENT_BYTES} bytes`,
            hint: 'trim the inline css/js, or keep the document in the file you pass as path',
          };
        }
        // A document may declare its own placement, size, and title; an explicit
        // tool argument always wins, and an unusable value falls back to the
        // default rather than failing the call.
        const declared = readDocumentDeclaration(source.source);
        const input = {
          sessionId: own,
          title:
            typeof args?.title === 'string' && args.title.length > 0
              ? args.title.slice(0, 200)
              : typeof declared.title === 'string'
                ? declared.title.slice(0, 200)
                : undefined,
          placement: normalizePlacement(args?.placement) ?? normalizePlacement(declared.placement),
          size: normalizeSize(args?.size) ?? normalizeSize(declared.size),
          origin: source.origin,
          template: source.template,
          sourcePath: source.sourcePath,
          source: source.source,
        };
        const meta = op === 'update' ? updateUi(String(args.id), input) : createUi(input);
        return {
          ok: true,
          op,
          uiId: meta.id,
          title: meta.title ?? '',
          placement: meta.placement ?? 'inline',
          size: formatSize(meta.size),
          sessionId: meta.sessionId,
          url: publicRecord(meta).url,
          bytes: meta.bytes,
          revision: meta.revision,
        };
      } catch (error) {
        const message = String(error?.message ?? error);
        return {
          ok: false,
          op: op.length > 0 ? op : 'unknown',
          error: message,
          hint: /maxInlineBytes/u.test(message) ? 'write the document to a file and call html_ui with path' : undefined,
        };
      }
    },
  };

  const templateTool = {
    name: 'html_ui_template',
    description:
      'Save, list, remove, or reuse reusable HTML UI templates. A template is a full HTML document stored under the plugin data root, so it survives sessions and can be instantiated later with html_ui op=render template=<name>. Use save with ui_id to freeze a working interface.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['save', 'list', 'show', 'remove'] },
        name: { type: 'string', description: 'Template name (lowercase letters, digits, dot, dash, underscore).' },
        ui_id: { type: 'string', description: 'Existing interface to freeze when saving. Accepted as `id` too, since the html_ui tool names it that way.' },
        html: { type: 'string', description: 'Inline HTML to save when no ui_id is given.' },
        path: { type: 'string', description: 'HTML document to save when no ui_id is given (.html, .htm, or .xhtml).' },
        description: { type: 'string', description: 'Optional note describing the template.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          op: { type: 'string' },
          name: { type: 'string' },
          count: { type: 'number' },
          summary: { type: 'string' },
          bytes: { type: 'number' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok', 'op'],
        additionalProperties: false,
      },
      // The harness uses this return value as the result's content blocks, so it must
      // be an array of blocks — not a string. Returning a string made every call to
      // this tool fail with "content.some is not a function", which no test caught
      // because they call `execute` and never `render`.
      render: (_args, value) => [{ type: 'text', text: renderTemplateAck(value) }],
      presentationMeta: (_args, value) =>
        lossless({
          htmlui: value.ok === true,
          op: `template-${value.op}`,
          template: value.name,
          count: value.count,
          bytes: value.bytes,
        }),
    },
    async execute(args, exec) {
      const op = String(args?.op ?? '');
      const cwd = exec?.agent?.session?.header?.cwd;
      try {
        if (op === 'list') {
          const all = store.listTemplates();
          const shown = all.slice(0, 40);
          const names = shown.map((t) => `${t.slug}${t.description !== undefined && t.description !== '' ? `(${t.description})` : ''}`);
          return {
            ok: true,
            op,
            count: all.length,
            summary: `${names.join(' | ')}${all.length > shown.length ? ` …(+${all.length - shown.length} more)` : ''}`,
          };
        }
        if (op === 'show') {
          const slug = slugify(args?.name);
          if (slug === undefined) return { ok: false, op, error: 'invalid template name' };
          const template = store.readTemplate(slug);
          if (template === undefined) return { ok: false, op, error: `unknown template: ${slug}`, hint: 'call op=list' };
          return {
            ok: true,
            op,
            name: slug,
            // The file is the truth; a stored byte count is only a cache.
            bytes: byteLength(template.source),
            summary: String(template.meta.description ?? '').slice(0, 400),
          };
        }
        if (op === 'remove') {
          const slug = slugify(args?.name);
          if (slug === undefined) return { ok: false, op, error: 'invalid template name' };
          const removed = store.removeTemplate(slug);
          if (!removed) return { ok: false, op, error: `unknown template: ${slug}` };
          return { ok: true, op, name: slug };
        }
        if (op !== 'save') {
          return { ok: false, op: op.length > 0 ? op : 'unknown', error: 'unsupported op', hint: 'use save, list, show, or remove' };
        }
        const slug = slugify(args?.name);
        if (slug === undefined) {
          return { ok: false, op, error: 'a valid name is required', hint: 'lowercase letters, digits, dot, dash, underscore' };
        }
        if (store.listTemplates().length >= MAX_TEMPLATES && store.readTemplate(slug) === undefined) {
          return { ok: false, op, error: `template store holds ${MAX_TEMPLATES} entries`, hint: 'remove one first' };
        }
        let source;
        // `id` is accepted as well: the html_ui tool names this field that way, and
        // a model carrying the name across is not making a mistake worth failing.
        const sourceUiId = typeof args?.ui_id === 'string' && args.ui_id.length > 0
          ? args.ui_id
          : typeof args?.id === 'string' && args.id.length > 0
            ? args.id
            : undefined;
        if (sourceUiId !== undefined) {
          const owned = readOwnedUi(sourceUiId, resolveSessionId(undefined, exec));
          if (owned.error !== undefined) return { ok: false, op, error: owned.error, hint: owned.hint };
          source = owned.record.source;
        } else if (typeof args?.path === 'string' && args.path.trim().length > 0) {
          source = readTextCapped(resolveHtmlInputPath(args.path, cwd), MAX_DOCUMENT_BYTES);
        } else if (typeof args?.html === 'string' && args.html.trim().length > 0) {
          if (byteLength(args.html) > maxInlineBytes) {
            return { ok: false, op, error: `inline html exceeds maxInlineBytes (${maxInlineBytes})`, hint: 'write the file and pass path' };
          }
          source = args.html;
        } else {
          return { ok: false, op, error: 'nothing to save', hint: 'pass ui_id, html, or path' };
        }
        store.writeTemplate(
          {
            slug,
            name: slug,
            description: typeof args?.description === 'string' ? args.description.slice(0, 400) : '',
            bytes: byteLength(source),
            updatedAt: Date.now(),
          },
          source,
        );
        return { ok: true, op, name: slug, bytes: byteLength(source) };
      } catch (error) {
        return { ok: false, op: op.length > 0 ? op : 'unknown', error: String(error?.message ?? error) };
      }
    },
  };

  // ------------------------------------------------------------------ routes

  function handleTicket(req, res) {
    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite === 'cross-site') {
      sendJson(res, 403, { ok: false, error: 'cross-site ticket request' });
      return;
    }
    readJsonBody(req, MAX_BODY_BYTES)
      .then((body) => {
        const uiId = String(body.uiId ?? '');
        const current = UI_ID_RE.test(uiId) ? store.readUi(uiId) : undefined;
        if (current === undefined) {
          sendJson(res, 404, { ok: false, error: `unknown ui id: ${uiId}` });
          return;
        }
        // Minting is rate limited per document. The carrier trusts the loopback
        // boundary (see Security in the README): it cannot tell the page from any
        // other local caller, so it bounds what one caller can do instead.
        if (!takeToken(uiId)) {
          sendJson(res, 429, { ok: false, error: 'rate limited', hint: 'too many ticket requests for this interface' });
          return;
        }
        const theme = body.theme === 'dark' ? 'dark' : body.theme === 'light' ? 'light' : undefined;
        sendJson(res, 200, { ok: true, ui: publicRecord(current.meta), url: documentUrl(uiId, theme, current.meta.revision) });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
  }

  function handleList(req, res) {
    readJsonBody(req, MAX_BODY_BYTES)
      .then((body) => {
        // The page always knows which session it is showing; an unscoped list would
        // hand one caller every session's records. The model's own cross-session
        // view is the html_ui op=list tool, not this route.
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (sessionId.length === 0) {
          sendJson(res, 400, { ok: false, error: 'a sessionId is required' });
          return;
        }
        const all = store.listUis(sessionId).slice(0, MAX_UI_PER_SESSION);
        sendJson(res, 200, { ok: true, count: all.length, uis: all.map(publicRecord) });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
  }

  /**
   * The template catalogue, for the page rather than the model: the drawer in the
   * composer lists these, and applying one creates an interface with no model
   * round trip at all.
   */
  function handleTemplates(req, res) {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(() => {
        const all = store.listTemplates();
        sendJson(res, 200, {
          ok: true,
          count: all.length,
          templates: all.map((template) => ({
            slug: String(template.slug ?? ''),
            name: String(template.name ?? template.slug ?? ''),
            description: String(template.description ?? ''),
            bundled: template.bundled === true,
            bytes: Number.isFinite(template.bytes) ? template.bytes : 0,
          })),
        });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
  }

  /** Apply one template to a session straight from the page. */
  function handleTemplateRender(req, res) {
    readJsonBody(req, MAX_BODY_BYTES)
      .then((body) => {
        const slug = slugify(body.template);
        const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined;
        if (slug === undefined) {
          sendJson(res, 400, { ok: false, error: 'a valid template name is required' });
          return;
        }
        if (sessionId === undefined) {
          sendJson(res, 400, { ok: false, error: 'a sessionId is required' });
          return;
        }
        if (store.listUis(sessionId).length >= MAX_UI_PER_SESSION) {
          sendJson(res, 409, { ok: false, error: `this session already holds ${MAX_UI_PER_SESSION} interfaces` });
          return;
        }
        const template = store.readTemplate(slug);
        if (template === undefined) {
          sendJson(res, 404, { ok: false, error: `unknown template: ${slug}` });
          return;
        }
        const variables = body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {};
        let source = template.source;
        for (const [key, value] of Object.entries(variables)) {
          source = source.split(`{{${key}}}`).join(String(value));
        }
        const declared = readDocumentDeclaration(source);
        const meta = createUi({
          sessionId,
          title:
            typeof body.title === 'string' && body.title.length > 0
              ? body.title.slice(0, 200)
              : typeof declared.title === 'string'
                ? declared.title.slice(0, 200)
                : String(template.meta.name ?? slug),
          placement: normalizePlacement(body.placement) ?? normalizePlacement(declared.placement),
          size: normalizeSize(body.size) ?? normalizeSize(declared.size),
          origin: 'template',
          template: slug,
          source,
        });
        sendJson(res, 200, { ok: true, ui: publicRecord(meta) });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
  }

  function handleDocument(req, res, url) {
    const pathname = url.pathname.slice(`${ROUTE_PREFIX}/ui/`.length);
    const uiId = pathname.split('/')[0];
    const token = url.searchParams.get('t') ?? '';
    if (!tokenMatches(uiId, token)) {
      sendText(res, 403, 'forbidden');
      return;
    }
    const current = store.readUi(uiId);
    if (current === undefined) {
      sendText(res, 404, 'not found');
      return;
    }
    const state = store.readState(current.meta.sessionId ?? '');
    const config = {
      pluginVersion: PLUGIN_VERSION,
      uiId,
      sessionId: current.meta.sessionId ?? '',
      title: current.meta.title ?? '',
      placement: current.meta.placement ?? 'inline',
      size: formatSize(current.meta.size),
      token,
      routeBase: ROUTE_PREFIX,
      initialTheme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light',
      state: state[uiId] ?? null,
    };
    const html = composeDocument(current.source, config);
    const host = String(req.headers.host ?? '');
    // A sandboxed frame without `allow-same-origin` has an *opaque* origin, and an
    // opaque origin matches no URL: `'self'` would allow nothing, which would block
    // the injected bridge script (`window.dshHTML` would simply not exist) and could
    // make the frame refuse to display at all. Every same-origin allowance therefore
    // names this request's own host explicitly.
    const selfOrigin = host.length > 0 ? `http://${host} https://${host}` : '';
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'unsafe-inline' 'unsafe-eval' blob: ${selfOrigin}`.trim(),
        `style-src 'unsafe-inline' ${selfOrigin}`.trim(),
        `img-src ${selfOrigin} data: blob: https: http:`.trim(),
        `media-src ${selfOrigin} data: blob: https: http:`.trim(),
        `font-src ${selfOrigin} data:`.trim(),
        `connect-src ${selfOrigin}`.trim(),
        `frame-ancestors ${selfOrigin}`.trim(),
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  }

  function handleAsset(req, res, url) {
    const file = url.pathname.slice(`${ROUTE_PREFIX}/assets/`.length);
    if (file !== BRIDGE_FILE) {
      sendText(res, 404, 'not found');
      return;
    }
    let source;
    try {
      source = readFileSync(fileURLToPath(new URL(`./assets/${BRIDGE_FILE}`, import.meta.url)), 'utf8');
    } catch (error) {
      logger?.warn?.(`dsh-htmlui: bridge asset unavailable: ${error?.message ?? error}`);
      sendText(res, 500, 'bridge unavailable');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': Buffer.byteLength(source),
      'access-control-allow-origin': '*',
    });
    res.end(source);
  }

  function handleEvents(req, res, url) {
    const uiId = url.searchParams.get('uiId') ?? '';
    const token = url.searchParams.get('t') ?? '';
    if (!tokenMatches(uiId, token)) {
      sendText(res, 403, 'forbidden');
      return;
    }
    const current = store.readUi(uiId);
    if (current === undefined) {
      sendText(res, 404, 'not found');
      return;
    }
    const sessionId = current.meta.sessionId ?? '';
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(),
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const client = { res, uiId, sessionId, timer: undefined };
    client.timer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        hub.remove(client);
        clearInterval(client.timer);
      }
    }, SSE_HEARTBEAT_MS);
    if (typeof client.timer.unref === 'function') client.timer.unref();
    const cleanup = () => {
      clearInterval(client.timer);
      hub.remove(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    hub.add(client);
  }

  function handleRpc(req, res) {
    readJsonBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const uiId = String(body.uiId ?? '');
        const token = typeof body.t === 'string' ? body.t : '';
        if (!tokenMatches(uiId, token)) {
          sendJson(res, 403, { ok: false, error: 'invalid capability token' });
          return;
        }
        const current = store.readUi(uiId);
        if (current === undefined) {
          sendJson(res, 404, { ok: false, error: `unknown ui id: ${uiId}` });
          return;
        }
        const sessionId = current.meta.sessionId ?? '';
        const op = String(body.op ?? '');
        if (op === 'state') {
          const value = body.value ?? null;
          const encoded = JSON.stringify(value ?? null);
          if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) {
            sendJson(res, 413, { ok: false, error: `state larger than ${MAX_STATE_BYTES} bytes` });
            return;
          }
          store.writeState(sessionId, uiId, value);
          sendJson(res, 200, { ok: true, op });
          return;
        }
        if (op === 'resize') {
          const size = normalizeSize(body.size);
          // A no-op resize must cost nothing: no write, no broadcast, no bucket.
          const unchanged = size === undefined || formatSize(size) === formatSize(current.meta.size);
          if (!unchanged) {
            if (!takeToken(uiId)) {
              sendJson(res, 429, { ok: false, error: 'rate limited', hint: 'this document is resizing too quickly' });
              return;
            }
            const meta = { ...current.meta, size, updatedAt: Date.now() };
            // Metadata only: resizing must never rewrite the document.
            store.writeUi(meta, undefined);
            hub.push(sessionId, 'ui', { action: 'update', ui: publicRecord(meta) });
          }
          sendJson(res, 200, { ok: true, op, size: formatSize(size) });
          return;
        }
        if (op === 'close') {
          closeUi(uiId);
          sendJson(res, 200, { ok: true, op });
          return;
        }
        if (op !== 'action') {
          sendJson(res, 400, { ok: false, error: `unsupported op: ${op}` });
          return;
        }
        const action = typeof body.action === 'string' && body.action.trim().length > 0 ? body.action.trim().slice(0, 200) : 'action';
        if (!takeToken(uiId)) {
          sendJson(res, 429, { ok: false, error: 'rate limited', hint: 'this document is sending actions too quickly' });
          return;
        }
        const data = body.data ?? null;
        let payloadText = '';
        try {
          payloadText = JSON.stringify(data ?? null) ?? 'null';
        } catch {
          payloadText = '"<unserializable>"';
        }
        if (payloadText.length > 8_000) payloadText = `${payloadText.slice(0, 8_000)}…`;
        const header = [
          `[html-ui:action] ui=${uiId} action=${JSON.stringify(action)}`,
          current.meta.title !== undefined && current.meta.title !== '' ? `title=${JSON.stringify(current.meta.title)}` : '',
          `placement=${current.meta.placement ?? 'inline'}`,
          `payload=${payloadText}`,
        ]
          .filter((line) => line.length > 0)
          .join('\n');
        const text = `${header}\n${actionPrompt}`;
        const actionId = randomUUID();
        const sessionController = ctx.get('sessionController');
        if (sessionController === undefined || typeof sessionController.prompt !== 'function') {
          sendJson(res, 503, { ok: false, error: 'session service unavailable', hint: 'the host exposes no session prompt API' });
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        if (typeof timer.unref === 'function') timer.unref();
        try {
          await sessionController.prompt(
            {
              requestId: actionId,
              sessionId,
              mode: body.steer === true ? 'steer' : 'queue',
              content: [{ type: 'text', text }],
            },
            controller.signal,
          );
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
          return;
        } finally {
          clearTimeout(timer);
        }
        hub.push(sessionId, 'action', { uiId, action, actionId, data: body.data ?? null });
        sendJson(res, 200, { ok: true, op: 'action', actionId, sessionId });
      })
      .catch((error) => sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }));
  }

  /**
   * Route every carrier request through one containment boundary: a route owner
   * shares the web server with the rest of the application, so a bug here must
   * not throw into the carrier or leave a request unanswered.
   */
  function createHandler() {
    return function handler(req, res) {
      try {
        dispatch(req, res);
      } catch (error) {
        logger?.warn?.(`dsh-htmlui: carrier request failed: ${error?.message ?? error}`);
        try {
          if (res.headersSent === true) res.end();
          else sendJson(res, 500, { ok: false, error: 'internal error' });
        } catch {
          /* the socket is already gone */
        }
      }
    };
  }

  function dispatch(req, res) {
    {
      const method = requestMethod(req);
      if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      let url;
      try {
        url = new URL(String(req.url ?? '/'), 'http://localhost');
      } catch {
        sendText(res, 400, 'bad request');
        return;
      }
      const path = url.pathname;
      if (path === ROUTE_PREFIX || path === `${ROUTE_PREFIX}/`) {
        sendJson(res, 200, { ok: true, plugin: PKG, version: PLUGIN_VERSION, placements: PLACEMENTS });
        return;
      }
      const isDocument = path.startsWith(`${ROUTE_PREFIX}/ui/`) && path !== `${ROUTE_PREFIX}/ui/ticket` && path !== `${ROUTE_PREFIX}/ui/list`;
      const token = isDocument ? url.searchParams.get('t') ?? '' : '';
      const uiIdFromPath = isDocument ? path.slice(`${ROUTE_PREFIX}/ui/`.length).split('/')[0] : '';
      const carrierDefers = path === `${ROUTE_PREFIX}/rpc` || path === `${ROUTE_PREFIX}/events`;
      const capability = isDocument ? tokenMatches(uiIdFromPath, token) : carrierDefers ? 'defer' : false;
      const decision = originDecision(req, capability, allowedOrigins);
      if (!decision.ok) {
        sendJson(res, decision.code, { ok: false, error: decision.message });
        return;
      }
      if (path === `${ROUTE_PREFIX}/health`) {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        // The one route an operator can curl to confirm which generation is live.
        sendJson(res, 200, {
          ok: true,
          plugin: PKG,
          version: PLUGIN_VERSION,
          placements: PLACEMENTS,
          storage: { configured: typeof settings.root === 'string' && settings.root.trim().length > 0 },
          trust: { allowedOrigins: allowedOrigins.size, loopbackOnly: allowedOrigins.size === 0 },
          counts: { uis: store.listUis().length, templates: store.listTemplates().length, sseClients: hub.size() },
        });
        return;
      }
      if (path === `${ROUTE_PREFIX}/templates`) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleTemplates(req, res);
      }
      if (path === `${ROUTE_PREFIX}/templates/render`) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleTemplateRender(req, res);
      }
      if (path === `${ROUTE_PREFIX}/ui/ticket`) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleTicket(req, res);
      }
      if (path === `${ROUTE_PREFIX}/ui/list`) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleList(req, res);
      }
      if (isDocument) {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleDocument(req, res, url);
      }
      if (path === `${ROUTE_PREFIX}/assets/${BRIDGE_FILE}`) {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleAsset(req, res, url);
      }
      if (path === `${ROUTE_PREFIX}/events`) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleEvents(req, res, url);
      }
      if (path === `${ROUTE_PREFIX}/rpc`) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return handleRpc(req, res);
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  // ---------------------------------------------------------------- wiring

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.reflect?.get?.('webServer') ?? scope.get?.('webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    scope.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler() }),
      'dsh-htmlui: http carrier',
    );
    logger?.info?.(`dsh-htmlui: http carrier at ${ROUTE_PREFIX} (data root: ${root})`);
  });

  ctx.inject(['tools'], (scope) => {
    scope.effect(function* registerTools() {
      yield scope.tools.register(htmlUiTool);
      yield scope.tools.register(templateTool);
    }, 'dsh-htmlui: model tools');
  });

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(
      () =>
        scope.systemPrompt.section({
          name: 'htmlui:contract',
          order: scope.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
          text: [
            '## HTML UI (`html_ui`)',
            'When a request needs a real interactive surface — a dashboard, a form, a tool with its own layout, an app-like flow — author HTML/CSS/JS and attach it with the `html_ui` tool instead of describing it in prose.',
            'Rules:',
            '- Prefer `path`: write the document with the file tools, then attach it with `html_ui op=render path=...`. Inline `html` is capped and stays in the conversation context.',
            '- Pick placement deliberately: `inline` (part of the transcript), `dock-top`/`dock-bottom` (full width around the composer), `dock-right` (session side panel), `float` (draggable window; give `size`), `fullscreen` (the interface takes the session view and offers a switch back to chat), `panel` (resident and updated in place), `background` (click-through layer).',
            '- Inside the document, `window.dshHTML` is available: `send(action, data)`, `state.get()/set(value)`, `close()`, `on("assistant"|"session"|"action"|"theme", handler)`. Only interactions that truly need the model should call `send`; keep selection, validation, filtering, and scoring local.',
            '- Re-read `html_ui` results: `ui_id` identifies the interface, and `html_ui op=update id=<ui_id>` replaces it in place. Each `send` arrives as a user message carrying `[html-ui:action]`.',
            '- Never ask for passwords, API keys, tokens, or recovery codes inside an interface, and never render secrets into it.',
            'Reusable documents can be frozen with `html_ui_template op=save` and instantiated later with `html_ui op=render template=<name>`.',
            'Reference: the `dsh-htmlui` SKILL.md shipped with this plugin.',
          ].join('\n'),
        }),
      'dsh-htmlui: prompt contract',
    );
  });

  ctx.on('agent/assistant-stream', (payload) => {
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined) return;
    const frame = payload?.frame;
    if (frame === undefined || frame === null) return;
    if (frame.type === 'chunk') {
      const chunk = frame.chunk ?? {};
      // StreamChunk is a tagged union: `text` exists on text deltas AND on
      // reasoning deltas, so the tag decides what an interface receives.
      if (typeof chunk.text === 'string' && chunk.text.length > 0) {
        if (chunk.type === 'reasoning-delta') {
          hub.push(String(sessionId), 'reasoning', { text: chunk.text.slice(0, 8_000) });
          return;
        }
        if (chunk.type === 'text-delta') {
          hub.push(String(sessionId), 'assistant', { type: 'text', text: chunk.text.slice(0, 8_000) });
          return;
        }
      }
      if (chunk.type === 'tool-call-delta') {
        hub.push(String(sessionId), 'assistant', {
          type: 'tool',
          id: typeof chunk.id === 'string' ? chunk.id : undefined,
          name: typeof chunk.name === 'string' ? chunk.name : undefined,
        });
      }
      return;
    }
    hub.push(String(sessionId), 'assistant', { type: frame.type, turn: frame.turn, step: frame.step });
  });

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (sessionId === undefined || event === undefined) return;
    hub.push(String(sessionId), 'session', {
      seq: typeof event.seq === 'number' ? event.seq : undefined,
      kind: typeof event.kind === 'string' ? event.kind : typeof event.type === 'string' ? event.type : 'event',
    });
  });

  ctx.effect(() => () => hub.closeAll(), 'dsh-htmlui: sse cleanup');

  logger?.info?.(`dsh-htmlui ${PLUGIN_VERSION}: ready (root: ${root}, max inline: ${maxInlineBytes} bytes)`);

  return () => hub.closeAll();
}
