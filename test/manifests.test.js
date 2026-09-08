import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const src = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const toolNames = [...src.matchAll(/addTool\(\{\s*name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);

test('manifest tools match the server', () => {
  assert.deepEqual(read('manifest.json').tools.map((t) => t.name), toolNames);
  assert.ok(toolNames.length >= 1);
});

test('versions, names and markers agree', () => {
  const pkg = read('package.json'); const manifest = read('manifest.json'); const server = read('server.json');
  assert.equal(pkg.version, manifest.version); assert.equal(pkg.version, server.version);
  const npm = server.packages.find((p) => p.registryType === 'npm');
  assert.equal(npm.identifier, pkg.name); assert.equal(npm.version, pkg.version);
  assert.equal(pkg.mcpName, server.name); assert.ok(server.name.startsWith('io.scalably/'));
  assert.equal(pkg.publishConfig.access, 'public');
  assert.deepEqual(Object.keys(pkg.bin), [pkg.name.replace('@scalably-io/', 'scalably-')], 'bin must be scalably-<server>');
  assert.equal(manifest.manifest_version, '0.4'); assert.equal(manifest.server.type, 'node');
  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.ok(server.description.length <= 100, 'registry rejects description > 100 chars');
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.match(range, /^\d/, `${name} must be an exact pin`);
});

test('README has no em dash and documents every tool', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal(readme.includes('—'), false);
  for (const n of toolNames) assert.ok(readme.includes('`' + n + '`'), n);
});

test('credential env vars are sensitive, nothing else is', () => {
  const manifest = read('manifest.json');
  const words = ['CREDENTIAL', 'KEY', 'TOKEN', 'SECRET', 'PASSWORD'];
  const expected = new Set();
  for (const [v, value] of Object.entries(manifest.server.mcp_config.env)) {
    const m = value.match(/^\$\{user_config\.([a-z0-9_]+)\}$/); assert.ok(m, v);
    assert.ok(m[1] in manifest.user_config, m[1]);
    if (words.some((w) => v.toUpperCase().includes(w))) expected.add(m[1]);
  }
  const sensitive = new Set(Object.entries(manifest.user_config).filter(([, c]) => c.sensitive === true).map(([k]) => k));
  assert.deepEqual([...sensitive].sort(), [...expected].sort());
});
