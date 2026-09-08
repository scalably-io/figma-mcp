import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

test('every addTool block declares annotations with title and readOnlyHint', () => {
  const blocks = src.split(/addTool\(\{/).slice(1);
  assert.ok(blocks.length >= 1);
  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('execute:'));
    const name = head.match(/name:\s*'([a-z0-9_]+)'/)?.[1] ?? '?';
    assert.match(head, /annotations:\s*\{/, `${name}: annotations missing`);
    assert.match(head, /title:\s*'/, `${name}: title missing`);
    assert.match(head, /readOnlyHint:\s*(true|false)/, `${name}: readOnlyHint must be explicit`);
  }
});
