/**
 * Packed-artifact test for @mostkia/dsh-htmlui.
 *
 * The repository working is not the same claim as the published package working.
 * This suite packs what npm would ship, extracts it, and activates the host half
 * from that extraction, so a missing `files` entry — a bridge that 404s, a
 * template that vanished, a skill the model can no longer read — fails here
 * instead of on someone's machine.
 *
 * It is skipped, with the reason, when the environment cannot run `npm pack` or
 * `tar` (a sandbox without subprocesses): the check is about the artifact, not
 * about the environment, and a silent pass would be worse than a loud skip.
 *
 * Run: node test/packed.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHarness } from './harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-htmlui-packed-'));

/**
 * Locate npm's CLI script. Running it with this node avoids a shell entirely,
 * which matters on Windows: spawning `npm.cmd` fails, and `cmd.exe /c` mangles
 * quoted paths.
 */
function npmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Pack and extract; either the artifact, or the reason it could not be built. */
function prepare() {
  const cli = npmCli();
  if (cli === undefined) return { skip: 'npm CLI script not found next to this node' };
  const pack = spawnSync(
    process.execPath,
    [cli, 'pack', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache')],
    { cwd: root, stdio: 'ignore' },
  );
  if (pack.error !== undefined || pack.status !== 0) {
    return { skip: `npm pack unavailable (${pack.error?.code ?? pack.status})` };
  }
  const tarball = readdirSync(scratch).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) return { skip: 'npm pack produced no tarball' };
  const extracted = join(scratch, 'extracted');
  mkdirSync(extracted, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', join(scratch, tarball), '-C', extracted], { stdio: 'ignore' });
  if (untar.error !== undefined || untar.status !== 0) {
    return { skip: `tar unavailable (${untar.error?.code ?? untar.status})` };
  }
  const packageDir = join(extracted, 'package');
  if (!existsSync(join(packageDir, 'index.js'))) return { skip: 'the tarball has no index.js' };
  return { tarball, packageDir, skip: null };
}

const prepared = prepare();
const skip = prepared.skip ?? false;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test('the tarball ships everything the plugin reads at runtime', { skip }, () => {
  const shipped = readFileSync(join(prepared.packageDir, 'package.json'), 'utf8');
  const manifest = JSON.parse(shipped);
  assert.equal(manifest.name, '@mostkia/dsh-htmlui');
  for (const required of [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'SKILL.md',
    'README.md',
    'README.zh.md',
    'CHANGELOG.md',
    'LICENSE',
    'assets/bridge.js',
    'templates/starter/index.html',
    'templates/starter/meta.json',
    'locale/en.json',
    'locale/zh.json',
  ]) {
    assert.ok(existsSync(join(prepared.packageDir, required)), `${required} must ship`);
  }
  // Tests and operator docs stay out of the tarball.
  assert.ok(!existsSync(join(prepared.packageDir, 'test')), 'tests must not ship');
  assert.ok(!existsSync(join(prepared.packageDir, 'docs')), 'docs must not ship');
});

test('the packed host half activates and serves from its own files', { skip }, async () => {
  const harness = await createHarness({ entry: pathToFileURL(join(prepared.packageDir, 'index.js')).href });
  try {
    assert.equal(harness.server.routes.length, 1, 'the carrier registers');
    assert.deepEqual(
      harness.tools.registered.map((definition) => definition.name).sort(),
      ['html_ui', 'html_ui_template'],
      'both tools register',
    );

    const health = await harness.call({
      url: '/plugins/@mostkia/dsh-htmlui/health',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    });
    assert.equal(health.status, 200);
    const packedVersion = JSON.parse(readFileSync(join(prepared.packageDir, 'package.json'), 'utf8')).version;
    assert.equal(JSON.parse(health.text).version, packedVersion);

    // The bridge asset is read from disk relative to the module, so a packaging
    // mistake shows up as a 500 here rather than a blank frame on a user's page.
    const bridge = await harness.call({
      url: '/plugins/@mostkia/dsh-htmlui/assets/bridge.js',
      headers: { host: '127.0.0.1:3080' },
    });
    assert.equal(bridge.status, 200);
    assert.equal(bridge.text, readFileSync(join(prepared.packageDir, 'assets/bridge.js'), 'utf8'));

    // The shipped template comes from the tarball, not from the repository.
    const rendered = await harness.tool('html_ui').execute(
      { op: 'render', template: 'starter', variables: { title: '打包自检' } },
      harness.exec('session-packed'),
    );
    assert.equal(rendered.ok, true, rendered.error ?? 'the starter template must render');
    assert.equal(rendered.placement, 'dock-top');
    const listed = await harness.tool('html_ui_template').execute({ op: 'list' }, harness.exec('session-packed'));
    assert.ok(listed.summary.includes('starter'));
  } finally {
    harness.dispose();
  }
});
