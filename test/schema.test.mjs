/**
 * Harness-schema tests for @mostkia/dsh-htmlui.
 *
 * The other suites run against a fake context, which never validates a schema.
 * The real loader does: it asserts every tool's parameter schema against the
 * subset the harness supports, validates call arguments against it, and validates
 * the canonical result against the declared output schema. A schema keyword the
 * harness does not support therefore fails activation in a way no fake-context
 * test can see.
 *
 * This suite imports the real `@deepseek-ai/dsh-tools` when one is available and
 * runs the harness's own validators over the schemas this plugin declares. It
 * skips, with the reason, when no harness package can be located — the check is
 * about the contract, and a silent pass would be worse than a loud skip.
 *
 * Run: node test/schema.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createHarness } from './harness.mjs';

/** Locate a harness package without hardcoding anyone's installation. */
function findHarness(name) {
  const roots = [];
  if (process.env.DSH_PROFILE_DIR !== undefined) roots.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'));
  if (process.env.DSH_HOME !== undefined) {
    roots.push(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'web', 'node_modules'));
  }
  roots.push(join(process.cwd(), 'node_modules'));
  for (const root of roots) {
    const candidate = join(root, '@deepseek-ai', name, 'lib', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const toolsPath = findHarness('dsh-tools');
const skip =
  toolsPath === undefined
    ? 'no @deepseek-ai/dsh-tools found; set DSH_PROFILE_DIR to validate against the real one'
    : false;

const harness = await createHarness();

test('every declared schema is inside the subset the harness enforces', { skip }, async () => {
  const { assertObjectJsonSchema, assertSupportedJsonSchema } = await import(pathToFileURL(toolsPath).href);
  for (const definition of harness.tools.registered) {
    // A parameter schema must be an object root in the supported subset.
    assert.doesNotThrow(
      () => assertObjectJsonSchema(definition.parameters),
      `${definition.name} parameters must be a supported object schema`,
    );
    // The canonical result contract is validated the same way.
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(definition.output.schema),
      `${definition.name} output schema must be supported`,
    );
  }
});

test('the args schema accepts a real call and refuses an unknown property', { skip }, async () => {
  const { validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href);
  const ui = harness.tool('html_ui');
  assert.deepEqual(validateJsonSchemaValue(ui.parameters, { op: 'render', html: '<p>x</p>', placement: 'float' }), []);
  assert.deepEqual(validateJsonSchemaValue(ui.parameters, { op: 'list' }), []);
  // additionalProperties:false means a typo is a rejected call, not a silent no-op.
  assert.ok(validateJsonSchemaValue(ui.parameters, { op: 'render', html: '<p>x</p>', placemnt: 'float' }).length > 0);
  assert.ok(validateJsonSchemaValue(ui.parameters, { op: 'teleport' }).length > 0);
  assert.ok(validateJsonSchemaValue(ui.parameters, {}).length > 0);
});

test('a real tool result satisfies the schema the plugin declared', { skip }, async () => {
  const { validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href);
  const ui = harness.tool('html_ui');
  const rendered = await ui.execute(
    { op: 'render', html: '<p>schema</p>', title: 'Schema', placement: 'float', size: '520x360' },
    harness.exec('session-schema'),
  );
  assert.deepEqual(validateJsonSchemaValue(ui.output.schema, rendered), [], 'the canonical value must satisfy the declared schema');
  const listed = await ui.execute({ op: 'list' }, harness.exec('session-schema'));
  assert.deepEqual(validateJsonSchemaValue(ui.output.schema, listed), []);
  const closed = await ui.execute({ op: 'close', id: rendered.uiId }, harness.exec('session-schema'));
  assert.deepEqual(validateJsonSchemaValue(ui.output.schema, closed), []);
  const failed = await ui.execute({ op: 'close', id: 'ui-00000000' }, harness.exec('session-schema'));
  assert.deepEqual(validateJsonSchemaValue(ui.output.schema, failed), [], 'the failure path is a valid value too');

  const templates = harness.tool('html_ui_template');
  for (const value of [
    await templates.execute({ op: 'list' }, harness.exec('session-schema')),
    await templates.execute({ op: 'save', name: 'schema-check', html: '<p>x</p>' }, harness.exec('session-schema')),
    await templates.execute({ op: 'remove', name: 'schema-check' }, harness.exec('session-schema')),
    await templates.execute({ op: 'remove', name: 'schema-check' }, harness.exec('session-schema')),
  ]) {
    assert.deepEqual(validateJsonSchemaValue(templates.output.schema, value), []);
  }
});

test('the declared schema is not vacuous', { skip }, async () => {
  const { validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href);
  const ui = harness.tool('html_ui');
  // If the schema accepted anything, the checks above would prove nothing.
  assert.ok(validateJsonSchemaValue(ui.output.schema, { ok: 'yes', op: 42 }).length > 0, 'wrong types must be refused');
  assert.ok(validateJsonSchemaValue(ui.output.schema, { ok: true }).length > 0, 'a missing required field must be refused');
  assert.ok(validateJsonSchemaValue(ui.output.schema, { ok: true, op: 'render', extra: 1 }).length > 0, 'an undeclared field must be refused');
});

test('every tool the harness sees has a description and a name', { skip }, () => {
  for (const definition of harness.tools.registered) {
    assert.match(definition.name, /^[a-z][a-z0-9_]*$/u);
    assert.ok(definition.description.length > 40, `${definition.name} needs a description a model can act on`);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.output.presentationMeta, 'function');
  }
});
