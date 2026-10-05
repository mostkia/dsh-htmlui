/**
 * Adversarial input tests for @mostkia/dsh-htmlui's host half.
 *
 * Everything else in this suite feeds the plugin what it expects. These tests
 * feed it what a broken document, a hostile page, or a clumsy model would: wrong
 * types, malformed bodies, ids that are not ids, paths that climb, payloads over
 * the cap, and prototype-polluting keys. The contract is narrow and absolute:
 * the carrier answers with a status instead of throwing, the tools answer with
 * `ok: false` instead of throwing, nothing reaches outside the data root, and no
 * request goes unanswered.
 *
 * Run: node test/robustness.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHarness, tick } from './harness.mjs';

const harness = await createHarness();

process.on('unhandledRejection', (reason) => {
  throw new Error(`an unhandled rejection escaped the plugin: ${reason}`);
});

const LOOPBACK = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };
const FRAME = { host: '127.0.0.1:3080', origin: 'null' };

/** Mint a document and its capability, so hostile calls have a real target. */
async function fixture(sessionId = 'session-hard') {
  const created = await harness.tool('html_ui').execute({ op: 'render', html: '<p>target</p>', title: 'Target' }, harness.exec(sessionId));
  const entry = await harness.call({
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/ui/ticket',
    headers: LOOPBACK,
    body: JSON.stringify({ uiId: created.uiId }),
  });
  const capability = /t=([A-Za-z0-9_-]+)/u.exec(JSON.parse(entry.text).url)[1];
  return { created, capability };
}

test('the carrier answers malformed requests instead of failing', async () => {
  const cases = [
    { name: 'unparsable body', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: FRAME, body: 'not json' }, status: 400 },
    { name: 'array body', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: FRAME, body: '[1,2]' }, status: 400 },
    { name: 'null body', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: FRAME, body: 'null' }, status: 400 },
    { name: 'empty body', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: FRAME, body: '' }, status: 403 },
    { name: 'unknown op', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: FRAME, body: JSON.stringify({ op: 'exfiltrate' }) }, status: 403 },
    { name: 'wrong method', options: { method: 'PUT', url: '/plugins/@mostkia/dsh-htmlui/rpc', headers: LOOPBACK }, status: 405 },
    { name: 'unknown path', options: { url: '/plugins/@mostkia/dsh-htmlui/nope', headers: LOOPBACK }, status: 404 },
    { name: 'ticket without an id', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/ui/ticket', headers: LOOPBACK, body: '{}' }, status: 404 },
    // A hostile object id makes `String()` unable to convert it: the containment
    // boundary turns that into a plain 400 rather than a 500.
    { name: 'ticket with an object id', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/ui/ticket', headers: LOOPBACK, body: JSON.stringify({ uiId: { toString: 'no' } }) }, status: 400 },
    // The page always knows its session, and an unscoped list would hand one caller
    // every session's records.
    { name: 'list without a session', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/ui/list', headers: LOOPBACK, body: '{}' }, status: 400 },
    { name: 'health by POST', options: { method: 'POST', url: '/plugins/@mostkia/dsh-htmlui/health', headers: LOOPBACK }, status: 405 },
  ];
  for (const entry of cases) {
    const response = await harness.call(entry.options);
    assert.equal(response.status, entry.status, `${entry.name} should answer ${entry.status}`);
    assert.match(response.headers['content-type'] ?? '', /application\/json/u, `${entry.name} should answer JSON`);
    assert.ok(!response.text.includes('at Object.'), `${entry.name} must not leak a stack`);
  }
});

test('the document route refuses ids and tokens that are not a pair', async () => {
  const { created, capability } = await fixture();
  const cases = [
    { name: 'no token', url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}` },
    { name: 'wrong token', url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}?t=deadbeefdeadbeefdeadbeefdeadbeef` },
    { name: 'token of another shape', url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}?t=` },
    { name: 'token for a different id', url: `/plugins/@mostkia/dsh-htmlui/ui/ui-00000000?t=${capability}` },
    { name: 'traversal id', url: '/plugins/@mostkia/dsh-htmlui/ui/..%2f..%2findex.js?t=x' },
    { name: 'absolute id', url: '/plugins/@mostkia/dsh-htmlui/ui/C:%5CWindows%5Cwin.ini?t=x' },
  ];
  for (const entry of cases) {
    const response = await harness.call({ url: entry.url, headers: { host: '127.0.0.1:3080' } });
    assert.equal(response.status, 403, `${entry.name} must be refused`);
  }
  const served = await harness.call({ url: `/plugins/@mostkia/dsh-htmlui/ui/${created.uiId}?t=${capability}`, headers: { host: '127.0.0.1:3080' } });
  assert.equal(served.status, 200);
});

test('the asset route serves the bridge and nothing else', async () => {
  for (const probe of ['../index.js', '..%2findex.js', 'secret.txt', 'bridge.js.bak', '']) {
    const response = await harness.call({
      url: `/plugins/@mostkia/dsh-htmlui/assets/${probe}`,
      headers: { host: '127.0.0.1:3080' },
    });
    assert.equal(response.status, 404, `assets/${probe} must not be served`);
  }
  const bridge = await harness.call({ url: '/plugins/@mostkia/dsh-htmlui/assets/bridge.js', headers: { host: '127.0.0.1:3080' } });
  assert.equal(bridge.status, 200);
});

test('a state payload over the cap is refused, and a polluting key is harmless', async () => {
  const { created, capability } = await fixture();
  const big = await harness.call({
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: FRAME,
    body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'state', value: { blob: 'x'.repeat(80_000) } }),
  });
  assert.equal(big.status, 413);

  const polluting = await harness.call({
    method: 'POST',
    url: '/plugins/@mostkia/dsh-htmlui/rpc',
    headers: FRAME,
    body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'state', value: JSON.parse('{"__proto__":{"polluted":true}}') }),
  });
  assert.equal(polluting.status, 200);
  assert.equal({}.polluted, undefined, 'a state write must not reach Object.prototype');
  assert.equal(Object.prototype.polluted, undefined);
});

test('a frame that asks for nonsense sizes still gets a document', async () => {
  const { created, capability } = await fixture();
  for (const size of ['xx', '', 42, [], { w: 'tall' }, '999999999x999999999', '-5x-5']) {
    const response = await harness.call({
      method: 'POST',
      url: '/plugins/@mostkia/dsh-htmlui/rpc',
      headers: FRAME,
      body: JSON.stringify({ t: capability, uiId: created.uiId, op: 'resize', size }),
    });
    assert.equal(response.status, 200, `size ${JSON.stringify(size)} should be answered`);
    const meta = JSON.parse((await harness.call({ url: '/plugins/@mostkia/dsh-htmlui/ui/list', headers: LOOPBACK, method: 'POST', body: JSON.stringify({ sessionId: 'session-hard' }) })).text);
    assert.equal(meta.ok, true);
  }
});

test('a stream that stops accepting writes is released, not buffered forever', async () => {
  const { created, capability } = await fixture();
  const stream = harness.start({
    url: `/plugins/@mostkia/dsh-htmlui/events?uiId=${created.uiId}&t=${capability}`,
    headers: FRAME,
  });
  await tick();
  assert.equal(stream.res.statusCode, 200);
  // A socket that refuses a write makes the hub drop the client on its next push.
  stream.res.write = () => {
    throw new Error('socket is gone');
  };
  harness.ctx.emit('agent/assistant-stream', {
    agent: { session: { id: 'session-hard' } },
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'after the socket died' } },
  });
  await tick();
  const health = JSON.parse((await harness.call({ url: '/plugins/@mostkia/dsh-htmlui/health', headers: LOOPBACK })).text);
  assert.equal(health.counts.sseClients, 0, 'the dead stream must leave the hub');
});

test('the tools refuse hostile arguments without throwing', async () => {
  const ui = harness.tool('html_ui');
  const templates = harness.tool('html_ui_template');
  const cases = [
    [ui, {}, 'unsupported op'],
    [ui, { op: 42 }, 'unsupported op'],
    [ui, { op: 'render', html: 42 }, 'nothing to render'],
    [ui, { op: 'render', path: 42 }, 'nothing to render'],
    [ui, { op: 'render', template: '../../etc/passwd' }, 'unknown template: etc-passwd'],
    [ui, { op: 'update' }, 'unknown ui id'],
    [ui, { op: 'update', id: 42 }, 'unknown ui id'],
    [ui, { op: 'close' }, 'id is required'],
    // `variables` is only meaningful with `template`; a wrong type there is
    // ignored rather than fatal, so the failure comes from the name.
    [ui, { op: 'render', template: 'x', variables: 'not an object' }, 'unknown template: x'],
    [ui, { op: 'render', css: '#x{}' }, 'nothing to render'],
    [templates, { op: 'show', name: 'nope' }, 'unknown template'],
    // A numeric name is stringified into a slug, then reported as missing.
    [templates, { op: 'remove', name: 42 }, 'unknown template: 42'],
    [templates, { op: 'save', name: 'ok', ui_id: 'ui-00000000' }, 'unknown ui id'],
  ];
  for (const [definition, args, expected] of cases) {
    const value = await definition.execute(args, harness.exec());
    assert.equal(value.ok, false, `${JSON.stringify(args)} should fail`);
    assert.match(String(value.error), new RegExp(expected, 'u'), `${JSON.stringify(args)} → ${value.error}`);
    // The model-facing projection must stay valid even on the failure path.
    const projection = definition.output.presentationMeta(args, value);
    assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
  }
});

test('a path that names a directory, a missing file, or a non-document is refused', async () => {
  const directory = join(harness.scratch, 'a-directory');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(harness.scratch, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
  const cases = [
    ['a-directory', /not an HTML document|EISDIR|not a file/u],
    ['missing.html', /ENOENT|no such file/u],
    ['binary.bin', /not an HTML document/u],
  ];
  for (const [path, expected] of cases) {
    const value = await harness.tool('html_ui').execute({ op: 'render', path }, harness.exec());
    assert.equal(value.ok, false, `${path} should fail`);
    assert.match(String(value.error), expected);
  }
});

test('a traversal-shaped template name is normalized into the store, never out of it', async () => {
  const templates = harness.tool('html_ui_template');
  const saved = await templates.execute({ op: 'save', name: '../../escape', html: '<p>escaped</p>' }, harness.exec());
  assert.equal(saved.ok, true);
  assert.match(saved.name, /^[a-z0-9][a-z0-9._-]*$/u, 'the stored name is a slug');
  assert.ok(existsSync(join(harness.root, 'templates', saved.name, 'index.html')), 'it lands inside the template store');
  // Nothing appears where the traversal pointed.
  assert.ok(!existsSync(join(harness.scratch, 'escape')));
  assert.ok(!existsSync(join(harness.root, '..', 'escape')));

  // A name longer than the slug budget is truncated rather than refused, and the
  // answer names what was actually stored so the caller can see the difference.
  const long = 'y'.repeat(300);
  const truncated = await templates.execute({ op: 'save', name: long, html: '<p>long</p>' }, harness.exec());
  assert.equal(truncated.ok, true);
  assert.equal(truncated.name.length, 64);
  assert.ok(existsSync(join(harness.root, 'templates', truncated.name, 'index.html')));
});

test('nothing hostile ever lands outside the data root', async () => {
  const root = harness.root;
  assert.ok(existsSync(join(root, 'ui')), 'the store keeps its own layout');
  const entries = readdirSync(root).sort();
  assert.deepEqual(entries, ['secret', 'state', 'templates', 'ui'], 'the store holds only what it owns');
  // Every recorded document is a directory the plugin created, with the two files
  // it writes and nothing else.
  for (const id of readdirSync(join(root, 'ui'))) {
    assert.match(id, /^ui-[0-9a-f]{8}$/u, `${id} must be a minted id`);
    const files = readdirSync(join(root, 'ui', id)).sort();
    assert.deepEqual(files, ['index.html', 'meta.json'], `${id} holds only its document and record`);
  }
});
