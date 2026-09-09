import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('every registered Figma tool returns canonical outcomes', () => {
  const starts = [...source.matchAll(/mcp\.addTool\(\{\s*name:\s*'([^']+)'/g)];
  assert.equal(starts.length, 2);
  for (let index = 0; index < starts.length; index++) {
    const segment = source.slice(
      starts[index].index,
      starts[index + 1]?.index ?? source.length,
    );
    assert.match(segment, /reply\(/, starts[index][1]);
  }
});

test('fetch_frame validates HTTP, content, structure, containment, and transactional write', () => {
  assert.match(source, /if \(!response\.ok\)/);
  assert.match(source, /image\/png/);
  assert.match(source, /inspectPng\(buffer\)/);
  assert.match(source, /resolveContainedOut\(OUTPUT_ROOT/);
  assert.match(source, /writeBundleTransactional\(OUTPUT_ROOT/);
  assert.doesNotMatch(source, /await \(await fetch\(url\)\)\.arrayBuffer/);
});

test('shared Figma source contains no tenant default or workflow-specific command', () => {
  assert.doesNotMatch(source, /G6iiBF0TYDaDiKOLMLDoVw/);
  assert.doesNotMatch(source, /nextCommand/);
  assert.doesNotMatch(source, /target:\s*\{[^}]*url/s);
  assert.doesNotMatch(source, /responseSample/);
});

test('both tools advertise truthful MCP annotations', () => {
  assert.match(
    source,
    /name: 'list_frames'[\s\S]*?readOnlyHint: true[\s\S]*?openWorldHint: true/,
  );
  assert.match(
    source,
    /name: 'fetch_frame'[\s\S]*?readOnlyHint: false[\s\S]*?destructiveHint: false/,
  );
});
