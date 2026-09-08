import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Literals are split so this file does not match itself or the private scanner.
const FORBIDDEN = [
  '/' + 'workspace' + '/', '/opt/' + 'scalably', '/opt/' + 'tools', 'TOOLS_' + 'ROOT', 'tool-outcome' + '/v1', 'mcp__' + 'scalably',
  String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`, '[A-Za-z0-9]{30,}', 'gserviceaccount' + String.raw`\.com`,
].map((p) => new RegExp(p));
const SUFFIXES = new Set(['.md', '.ts', '.js', '.mjs', '.json', '.txt', '.yml', '.yaml', '']);
// Skipped, not failed, outside a git checkout (e.g. a bootstrap.mjs smoke copy with .git removed);
// every real clone, CI checkout and the repo itself has .git, so the check still runs there.
const hasGit = fs.existsSync(path.join(root, '.git'));
const files = hasGit ? execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean)
  .filter((f) => SUFFIXES.has(path.extname(f)) && !f.startsWith('package-lock')) : [];

test('tracked files carry no private patterns', { skip: !hasGit }, () => {
  assert.ok(files.some((f) => f === 'server.json'));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('fileSha256') || line.includes('"integrity"')) return;
      for (const re of FORBIDDEN) { const m = line.match(re); assert.equal(m, null, `${f}:${i + 1} matches ${re}: ${m?.[0]?.slice(0, 60)}`); }
    });
  }
});
