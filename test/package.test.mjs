/**
 * Package integrity tests for @mostkia/dsh-htmlui.
 *
 * These are the checks that decide whether this repository can be published and
 * installed as it stands: the manifest the loader and the marketplace read, the
 * files the package promises, the version stated in four places, and the absence
 * of machine-specific strings. All of it is offline and machine independent, and
 * CI runs it, so a packaging regression fails before a release rather than after.
 *
 * Run: node test/package.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** Every text file in the repository, excluding generated and vcs directories. */
function repositoryFiles(directory = root, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'cache' || entry.name === 'tmp') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      repositoryFiles(path, found);
      continue;
    }
    if (/\.(?:png|jpe?g|webp|ico|woff2?)$/iu.test(entry.name)) continue;
    found.push(relative(root, path).replace(/\\/gu, '/'));
  }
  return found;
}

test('the manifest declares what the loader and the marketplace require', () => {
  assert.equal(pkg.name, '@mostkia/dsh-htmlui');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'index.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  // The submission gate rejects a package that only declares dsh.client.
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(root, 'cordis.patch.yml')));
  assert.ok(pkg.meta.title.length > 0, 'the plugin card needs a title');
  assert.ok(pkg.meta.description.length > 0, 'the plugin card needs a description');
  assert.equal(pkg.license, 'MIT');
  assert.ok(existsSync(join(root, 'LICENSE')));
});

test('the bundle patch mounts this exact package', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^- insert:$/mu);
  assert.ok(patch.includes(`name: '${pkg.name}'`), 'the patch row must name the package');
});

test('the compatibility floor includes the DSH 0.1.7 pre-release line', () => {
  // A plain ">=0.1.7" excludes 0.1.7-rc.* from every range, so the install gate
  // refuses a plugin on the very runtime it was developed against. The 0.2 lines
  // need their own branch for the same reason: semver only admits a pre-release
  // when a comparator names that same major.minor.patch.
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.ok(range.includes('0.1.7-0'), `${name} must accept 0.1.7-0, got ${range}`);
    assert.ok(range.includes('>=0.1.7-0 <0.2.0-0'), `${name} must cap the 0.1 line, or a future 1.0 would satisfy it, got ${range}`);
    assert.ok(range.includes('>=0.2.0-rc.1 <0.3.0-0'), `${name} must accept the 0.2 pre-release line, got ${range}`);
    assert.ok(range.includes('<0.3.0-0'), `${name} must cap the 0.2 lines, got ${range}`);
    assert.ok(pkg.peerDependenciesMeta?.[name]?.optional === true, `${name} should stay optional so a slim deployment still installs`);
  }
  // Every package the code registers into or reads a service from is declared, so
  // a reviewer can see the dependency instead of finding it in the source.
  for (const name of ['dsh-client-ui-sidebar-right', 'dsh-client-ui-tool', 'dsh-host-webserver', 'dsh-tools']) {
    assert.ok(`@deepseek-ai/${name}` in pkg.peerDependencies, `@deepseek-ai/${name} must be declared as a peer`);
  }
});

test('every file the package promises exists', () => {
  for (const entry of pkg.files) {
    if (entry.includes('*')) {
      const [directory, pattern] = entry.split('/');
      const suffix = pattern.replace('*', '');
      const matches = readdirSync(join(root, directory)).filter((name) => name.endsWith(suffix));
      assert.ok(matches.length > 0, `"${entry}" matches nothing`);
      continue;
    }
    assert.ok(existsSync(join(root, entry)), `"${entry}" is promised by "files" but missing`);
  }
  assert.ok(!pkg.files.includes('test'), 'tests stay out of the published tarball');
  assert.ok(pkg.files.includes('CHANGELOG.md'));
});

test('the entries the loader resolves on its own exist', () => {
  assert.ok(existsSync(join(root, pkg.exports['./client'])), 'a missing client export is a dead plugin');
  assert.ok(existsSync(join(root, pkg.exports['.'])), 'the host entry must exist');
  assert.ok(existsSync(join(root, 'assets/bridge.js')), 'the served bridge must ship');
  assert.ok(existsSync(join(root, 'SKILL.md')), 'the model-facing reference must ship');
  const icon = join(root, pkg.icon);
  assert.ok(existsSync(icon), 'the icon must exist');
  assert.ok(statSync(icon).size <= 256 * 1024, 'the manifest caps icons at 256 KiB');
  assert.match(read(pkg.icon), /^<svg/u);
});

test('the browser half imports nothing but react', () => {
  const required = [...read('client.js').matchAll(/require\((['"])([^'"]+)\1\)/gu)].map((match) => match[2]);
  assert.deepEqual([...new Set(required)], ['react'], 'a second runtime import would need dsh.client.external');
});

test('the host half carries no runtime harness import', () => {
  const imports = [...read('index.js').matchAll(/^import .*?from '([^']+)';$/gmu)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:'), `the host half must not import ${specifier} at runtime`);
  }
});

test('the version is stated the same way everywhere it is stated', () => {
  assert.match(read('index.js'), new RegExp(`PLUGIN_VERSION = '${pkg.version}'`, 'u'));
  // The client states it through its own constant, which the activation line and the create
  // dialog both read — so the two can never drift apart, and this is what holds the constant to
  // the manifest.
  assert.match(read('client.js'), new RegExp(`const CLIENT_VERSION = '${pkg.version.replace(/\./gu, '\\.')}'`, 'u'));
  assert.match(read('client.js'), /client active \(\$\{CLIENT_VERSION\}\)/u);
  const headings = [...read('CHANGELOG.md').matchAll(/^## (\d+\.\d+\.\d+)/gmu)].map((match) => match[1]);
  assert.equal(headings[0], pkg.version, 'the newest changelog heading must be the packaged version');
});

test('nothing retires interfaces except an explicit click', () => {
  // A guard with a scar behind it: an earlier revision retired a session's dock-right
  // interfaces when their body unmounted and did not remount within 500 ms. Switching
  // sessions unmounts that body, the next session's column can mount later than the
  // delay, and the interfaces were deleted host-side — reloads could not bring them
  // back. "Not on screen right now" is not "closed", and only a click can tell them
  // apart, so neither the state it used nor a timer reaching dismissRecord comes back.
  const client = read('client.js');
  assert.ok(!client.includes('rightPaneBody'), 'the unmount-based retirement must not return');
  assert.ok(!/setTimeout\([\s\S]{0,240}dismissRecord/u.test(client), 'no timer may retire an interface on its own');
});

test('the model-facing reference keeps its frontmatter', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /^---\nname: dsh-htmlui\n/u);
  assert.match(skill, /\ndescription: \S/u);
  assert.match(skill, /\nwhenToUse: \S/u);
});

test('the marketplace entry is ready to copy', () => {
  const entry = read('docs/awesome-dsh-plugin.yml');
  assert.match(entry, /^url: https:\/\/github\.com\/mostkia\/dsh-htmlui$/mu);
  assert.match(entry, /^name: mostkia\/dsh-htmlui$/mu);
  assert.match(entry, /^category: ui$/mu);
  const english = /^ {2}en: (.+)$/mu.exec(entry);
  assert.ok(english !== null, 'description.en is required');
  const description = english[1].trim();
  assert.ok(description.endsWith('.'), 'description.en must end with a period');
  assert.ok(!description.includes(': '), 'a description containing ": " must be quoted in YAML');
  // The install command the marketplace prints must be the one the README shows.
  assert.ok(read('README.md').includes(`dsh plugin --profile web add ${pkg.name}`));
  assert.ok(read('README.zh.md').includes(`dsh plugin --profile web add ${pkg.name}`));
});

test('no tracked text file carries a machine-specific path or an address', () => {
  // Built from strings so that this rule can never match its own source.
  const rules = [
    { name: 'absolute windows path', pattern: new RegExp('(?:^|[^A-Za-z])[A-Za-z]:[\\\\/]', 'u') },
    { name: 'user home path', pattern: new RegExp('/(?:Users|home)/[A-Za-z0-9._-]+/', 'u') },
    { name: 'email address', pattern: new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', 'u') },
  ];
  const offenders = [];
  for (const file of repositoryFiles()) {
    let source;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const rule of rules) {
      for (const line of source.split('\n')) {
        if (rule.pattern.test(line)) offenders.push(`${file} [${rule.name}]: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a published repository must not carry machine-specific strings');
});

test('every text file is valid UTF-8 without replacement characters', () => {
  const bad = [];
  for (const file of repositoryFiles()) {
    const bytes = readFileSync(join(root, file));
    const text = bytes.toString('utf8');
    if (text.includes('\uFFFD')) bad.push(file);
  }
  assert.deepEqual(bad, []);
});
