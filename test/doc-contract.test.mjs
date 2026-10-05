/**
 * Documentation contract tests for @mostkia/dsh-htmlui.
 *
 * The plugin's real interface has three audiences: the model reads SKILL.md and
 * the prompt contract in `index.js`, the user reads the two READMEs, and every
 * authored document calls the bridge API. This suite fails when one of them
 * drifts from what the code actually accepts, which is the failure that never
 * throws — it just quietly teaches the wrong thing.
 *
 * Run: node test/doc-contract.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL(rel, `file:///${root.replace(/\\/gu, '/')}/`), 'utf8');

/** The placement list the host dispatches on. */
function placements() {
  const block = /const PLACEMENTS = \[([\s\S]*?)\];/u.exec(read('index.js'));
  assert.ok(block !== null, 'the placement list must stay declared in index.js');
  const list = [...block[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(list.length >= 7, 'every requested form must stay declared');
  return list;
}

/** Every enum the tool schemas publish literally, plus the referenced placement list. */
function schemaEnums() {
  const source = read('index.js');
  const enums = [...source.matchAll(/enum: \[([^\]]*)\]/gu)].map((match) =>
    [...match[1].matchAll(/'([^']+)'/gu)].map((inner) => inner[1]),
  );
  assert.ok(enums.length >= 2, 'both operation enums are published literally');
  assert.match(source, /enum: PLACEMENTS,/u, 'the placement schema publishes the declared list');
  return enums;
}

test('every placement is documented for the model and for the user', () => {
  const list = placements();
  const skill = read('SKILL.md');
  for (const placement of list) {
    assert.ok(skill.includes(`\`${placement}\``), `SKILL.md must document ${placement}`);
  }
  for (const file of ['README.md', 'README.zh.md']) {
    // A placement may share a row with another (`dock-top` / `dock-bottom`).
    const rows = list.filter((placement) =>
      read(file)
        .split('\n')
        .some((line) => line.startsWith('|') && line.includes(`\`${placement}\``)),
    );
    assert.deepEqual([...rows].sort(), [...list].sort(), `${file} must table every placement`);
  }
});

test('the prompt contract the model reads every turn names every placement', () => {
  const contract = /name: 'htmlui:contract',[\s\S]*?\.join\('\\n'\),/u.exec(read('index.js'));
  assert.ok(contract !== null, 'the prompt contract must stay in index.js');
  for (const placement of placements()) {
    assert.ok(contract[0].includes(placement), `the prompt contract must name ${placement}`);
  }
  // It also states the two local-first rules an interface depends on.
  assert.match(contract[0], /dshHTML/u);
  assert.match(contract[0], /passwords/u);
});

test('every tool operation is documented in the skill', () => {
  const skill = read('SKILL.md');
  for (const values of schemaEnums()) {
    for (const value of values) {
      assert.ok(skill.includes(value), `SKILL.md must document "${value}"`);
    }
  }
});

test('the bridge surface the skill promises exists in the bridge', () => {
  const skill = read('SKILL.md');
  const bridge = read('assets/bridge.js');
  for (const member of ['send', 'state', 'resize', 'close', 'on', 'stream', 'theme']) {
    assert.ok(skill.includes(`dshHTML.${member}`), `SKILL.md must document dshHTML.${member}`);
    assert.ok(new RegExp(`\\b${member}[:(]`, 'u').test(bridge), `the bridge must implement ${member}`);
  }
});

test('both READMEs promise the same install command and the same placements', () => {
  const list = placements();
  const english = read('README.md');
  const chinese = read('README.zh.md');
  for (const source of [english, chinese]) {
    assert.ok(source.includes('dsh plugin --profile web add @mostkia/dsh-htmlui'), 'the documented install command');
    assert.ok(source.includes('github:mostkia/dsh-htmlui'), 'and the GitHub fallback');
    for (const placement of list) {
      assert.ok(source.includes(placement), `${placement} must appear`);
    }
  }
});

test('the skill stays loadable and keeps its routing text', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /^---\n/u);
  assert.match(skill, /\nname: dsh-htmlui\n/u);
  assert.match(skill, /\nwhenToUse: /u);
  // The two tools the skill announces are the two the host registers.
  const source = read('index.js');
  for (const toolName of ['html_ui', 'html_ui_template']) {
    assert.ok(skill.includes(toolName), `SKILL.md must name ${toolName}`);
    assert.ok(new RegExp(`name: '${toolName}'`, 'u').test(source), `${toolName} must be registered`);
  }
});
