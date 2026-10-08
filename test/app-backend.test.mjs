/**
 * Project backend tests for @mostkia/dsh-htmlui.
 *
 * A project may ship a `server.js` beside its `index.html`; the host runs it in-process and its own
 * documents call it with no model round trip. These tests are the whole contract: who may call it,
 * who may not, what happens when it throws or never answers, that it keeps state between calls and
 * reloads when the file changes, and that one project can never reach another's backend.
 *
 * Every activation gets its own throwaway root and its own project directory, so nothing here
 * touches a real plugin data directory. The project's manifest and the reader's allowance are
 * written as files, which is also how the plugin reads them.
 *
 * Run: node --test test/app-backend.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarness } from './harness.mjs';

const PREFIX = '/plugins/@mostkia/dsh-htmlui';
const CALL_HEADERS = { host: '127.0.0.1:3080', origin: 'null' };
const PAGE_HEADERS = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };

/**
 * One activation with one or more projects under its own directory.
 *
 * `projects` maps a folder name to `{ meta, files }`. The allowance is written into the plugin's
 * settings exactly where the plugin keeps it, so a test proves the two-key rule rather than
 * asserting it in the abstract.
 */
async function activation({ projects, config = {}, allowed = [] }) {
  const harness = await createHarness({ config });
  const dir = join(harness.scratch, 'projects');
  for (const [name, project] of Object.entries(projects)) {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'index.html'), project.html ?? `<p>${name}</p>`, 'utf8');
    if (project.meta !== undefined) writeFileSync(join(folder, 'meta.json'), JSON.stringify(project.meta), 'utf8');
    for (const [file, source] of Object.entries(project.files ?? {})) writeFileSync(join(folder, file), source, 'utf8');
  }
  writeFileSync(join(harness.root, 'settings.json'), JSON.stringify({ templatesDir: dir, backendProjects: allowed }), 'utf8');
  return { harness, dir };
}

const exec = (harness, sessionId = 'session-app') => ({ agent: { session: { id: sessionId, header: { cwd: harness.scratch } } } });

/** Render one project into a session, the way the drawer does. */
async function render(harness, slug, sessionId = 'session-app') {
  const rendered = await harness.tool('html_ui').execute({ op: 'render', template: slug }, exec(harness, sessionId));
  assert.equal(rendered.ok, true, `rendering ${slug} must succeed: ${JSON.stringify(rendered)}`);
  return rendered;
}

/** The document's capability, minted through the ticket route rather than by hand. */
async function ticketFor(harness, uiId) {
  const entry = await harness.call({
    method: 'POST',
    url: `${PREFIX}/ui/ticket`,
    headers: PAGE_HEADERS,
    body: JSON.stringify({ uiId }),
  });
  return /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];
}

/** One backend call from a document: opaque origin, capability in the query. */
function call(harness, uiId, path, { token, method = 'GET', body } = {}) {
  const url = `${PREFIX}/app/${uiId}/${path}${token === undefined ? '' : `?t=${encodeURIComponent(token)}`}`;
  return harness.call({ method, url, headers: CALL_HEADERS, body });
}

const allow = (harness, slug, allowed) =>
  harness.call({
    method: 'POST',
    url: `${PREFIX}/templates/backend`,
    headers: PAGE_HEADERS,
    body: JSON.stringify({ slug, allowed }),
  });

const COUNTER = [
  'let calls = 0;',
  'module.exports = {',
  '  handle: async (request) => {',
  '    calls += 1;',
  '    return { calls, path: request.path, method: request.method, slug: request.slug, body: request.body };',
  '  },',
  '};',
].join('\n');

test('a backend answers its own document, and needs both the declaration and the allowance', async () => {
  const { harness } = await activation({
    projects: { panel: { meta: { slug: 'panel', name: 'panel', backend: true }, files: { 'server.js': COUNTER } } },
    allowed: ['panel'],
  });
  try {
    const rendered = await render(harness, 'panel');
    const token = await ticketFor(harness, rendered.uiId);

    const answered = await call(harness, rendered.uiId, 'status', { token });
    assert.equal(answered.status, 200);
    assert.deepEqual(JSON.parse(answered.text), { calls: 1, path: 'status', method: 'GET', slug: 'panel', body: '' });

    // The catalogue tells the page both facts, which is what the switch in the form is built from.
    const catalogue = JSON.parse((await harness.call({ method: 'POST', url: `${PREFIX}/templates`, headers: PAGE_HEADERS, body: '{}' })).text);
    const entry = catalogue.templates.find((template) => template.slug === 'panel');
    assert.equal(entry.backend.declared, true, 'the project ships one');
    assert.equal(entry.backend.allowed, true, 'and the reader has allowed it');

    // A document without a capability never reaches a backend, whatever it asks for.
    const anonymous = await call(harness, rendered.uiId, 'status');
    assert.equal(anonymous.status, 403);
    // A forged capability gets the same answer as none at all.
    const forged = await call(harness, rendered.uiId, 'status', { token: 'not-the-token' });
    assert.equal(forged.status, 403);

    // Revoking takes effect on the next call, not on the next activation.
    const revoked = JSON.parse((await allow(harness, 'panel', false)).text);
    assert.equal(revoked.allowed, false);
    const denied = await call(harness, rendered.uiId, 'status', { token });
    assert.equal(denied.status, 403);
    assert.match(JSON.parse(denied.text).error, /not allowed/u);

    // And granting it again brings the same project back.
    await allow(harness, 'panel', true);
    const again = await call(harness, rendered.uiId, 'status', { token });
    assert.equal(again.status, 200);
  } finally {
    harness.dispose();
  }
});

test('a project with no declaration is refused even when the allowance is there', async () => {
  const { harness } = await activation({
    projects: { plain: { meta: { slug: 'plain', name: 'plain' }, files: { 'server.js': COUNTER } } },
    allowed: ['plain'],
  });
  try {
    const rendered = await render(harness, 'plain');
    const token = await ticketFor(harness, rendered.uiId);
    const refused = await call(harness, rendered.uiId, 'status', { token });
    assert.equal(refused.status, 404, 'the manifest is the declaration, and there is none');
    assert.match(JSON.parse(refused.text).error, /no project backend/u);
  } finally {
    harness.dispose();
  }
});

test('a backend keeps state between calls and reloads when its file changes', async () => {
  const { harness, dir } = await activation({
    projects: { panel: { meta: { slug: 'panel', name: 'panel', backend: true }, files: { 'server.js': COUNTER } } },
    allowed: ['panel'],
  });
  try {
    const rendered = await render(harness, 'panel');
    const token = await ticketFor(harness, rendered.uiId);
    assert.equal(JSON.parse((await call(harness, rendered.uiId, 'one', { token })).text).calls, 1);
    // Same module, second call: this is what makes a polling cache possible.
    assert.equal(JSON.parse((await call(harness, rendered.uiId, 'two', { token })).text).calls, 2);

    // An edit is picked up by the next call — no cold start, no refresh.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dir, 'panel', 'server.js'), 'let calls = 100;\n' + COUNTER.split('\n').slice(1).join('\n'), 'utf8');
    const reloaded = JSON.parse((await call(harness, rendered.uiId, 'three', { token })).text);
    assert.equal(reloaded.calls, 101, 'the edited file is the one that answers');
    assert.equal(reloaded.path, 'three');
  } finally {
    harness.dispose();
  }
});

test('a backend that throws, or never answers, becomes an answer instead of a stall', async () => {
  const { harness } = await activation({
    config: { appTimeoutMs: 200 },
    projects: {
      panel: {
        meta: { slug: 'panel', name: 'panel', backend: true },
        files: {
          'server.js': [
            'module.exports = {',
            "  handle: async (request) => {",
            "    if (request.path === 'boom') throw new Error('backend exploded');",
            "    if (request.path === 'slow') return new Promise(() => {});",
            "    return { ok: true };",
            '  },',
            '};',
          ].join('\n'),
        },
      },
    },
    allowed: ['panel'],
  });
  try {
    const rendered = await render(harness, 'panel');
    const token = await ticketFor(harness, rendered.uiId);

    const thrown = await call(harness, rendered.uiId, 'boom', { token });
    assert.equal(thrown.status, 500);
    assert.equal(JSON.parse(thrown.text).error, 'the backend threw');
    assert.match(JSON.parse(thrown.text).detail, /backend exploded/u);

    const stalled = await call(harness, rendered.uiId, 'slow', { token });
    assert.equal(stalled.status, 504, 'the call is answered, not left hanging');
    assert.match(JSON.parse(stalled.text).error, /did not answer in time/u);

    // A backend that failed stays usable: the failure was answered, not fatal.
    const fine = await call(harness, rendered.uiId, 'ok', { token });
    assert.equal(fine.status, 200);
    assert.deepEqual(JSON.parse(fine.text), { ok: true });
  } finally {
    harness.dispose();
  }
});

test('a document reaches its own project and no other', async () => {
  const { harness } = await activation({
    projects: {
      one: { meta: { slug: 'one', name: 'one', backend: true }, files: { 'server.js': "module.exports = { handle: async () => ({ who: 'one' }) };\n" } },
      two: { meta: { slug: 'two', name: 'two', backend: true }, files: { 'server.js': "module.exports = { handle: async () => ({ who: 'two' }) };\n" } },
    },
    allowed: ['one', 'two'],
  });
  try {
    const first = await render(harness, 'one');
    const second = await render(harness, 'two');
    const firstToken = await ticketFor(harness, first.uiId);
    const secondToken = await ticketFor(harness, second.uiId);

    assert.deepEqual(JSON.parse((await call(harness, first.uiId, 'who', { token: firstToken })).text), { who: 'one' });
    assert.deepEqual(JSON.parse((await call(harness, second.uiId, 'who', { token: secondToken })).text), { who: 'two' });

    // The UI id is the only thing that names a project, and the capability has to match it: a
    // document cannot point the route at its neighbour.
    const neighbour = await call(harness, second.uiId, 'who', { token: firstToken });
    assert.equal(neighbour.status, 403);
  } finally {
    harness.dispose();
  }
});

test('the health route reports what a backend has been asked to do', async () => {
  const { harness } = await activation({
    projects: { panel: { meta: { slug: 'panel', name: 'panel', backend: true }, files: { 'server.js': COUNTER } } },
    allowed: ['panel'],
  });
  try {
    const rendered = await render(harness, 'panel');
    const token = await ticketFor(harness, rendered.uiId);
    await call(harness, rendered.uiId, 'status', { token });
    const health = JSON.parse((await harness.call({ url: `${PREFIX}/health`, headers: PAGE_HEADERS })).text);
    assert.equal(health.backends.length, 1, 'a loaded backend is visible to the operator');
    assert.equal(health.backends[0].slug, 'panel');
    assert.equal(health.backends[0].calls, 1);
    assert.equal(health.backends[0].failures, 0);
  } finally {
    harness.dispose();
  }
});

test('a backend may answer text, and a POST body arrives as it was sent', async () => {
  const { harness } = await activation({
    projects: {
      panel: {
        meta: { slug: 'panel', name: 'panel', backend: true },
        files: {
          'server.js': [
            'module.exports = {',
            "  handle: async (request) => {",
            "    if (request.path === 'text') return 'plain answer';",
            "    if (request.path === 'typed') return { status: 201, body: { seen: request.json() } };",
            '    return request.body;',
            '  },',
            '};',
          ].join('\n'),
        },
      },
    },
    allowed: ['panel'],
  });
  try {
    const rendered = await render(harness, 'panel');
    const token = await ticketFor(harness, rendered.uiId);

    const text = await call(harness, rendered.uiId, 'text', { token });
    assert.equal(text.status, 200);
    assert.equal(text.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(text.text, 'plain answer');

    const posted = await call(harness, rendered.uiId, 'echo', { token, method: 'POST', body: 'hello backend' });
    assert.equal(posted.status, 200);
    assert.equal(posted.text, 'hello backend', 'the body reaches the handler unchanged');

    const typed = await call(harness, rendered.uiId, 'typed', { token, method: 'POST', body: JSON.stringify({ a: 1 }) });
    assert.equal(typed.status, 201);
    assert.deepEqual(JSON.parse(typed.text), { seen: { a: 1 } });
  } finally {
    harness.dispose();
  }
});
