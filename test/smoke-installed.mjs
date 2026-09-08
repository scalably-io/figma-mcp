import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tarball = fs.readdirSync(root).filter((f) => f.endsWith('.tgz')).sort().at(-1);
const bin = Object.keys(pkg.bin)[0];
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('## Tools')[1].split('\n## ')[0];
const expected = readme.split('\n').filter((l) => l.startsWith('| `')).map((l) => l.split('`')[1]).sort();
const tmp = fs.mkdtempSync('/tmp/smoke-');
execFileSync('npm', ['init', '-y'], { cwd: tmp, stdio: 'ignore' });
execFileSync('npm', ['install', '--no-audit', '--no-fund', path.join(root, tarball)], { cwd: tmp, stdio: 'ignore' });
const child = spawn(path.join(tmp, 'node_modules', '.bin', bin), [], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (c) => { out += c; });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
await new Promise((r) => setTimeout(r, 4000));
child.kill('SIGTERM');
const list = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
const names = list.result.tools.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) { console.error({ names, expected }); process.exit(1); }
console.log(`OK clean install: ${pkg.name} from ${tarball} lists ${names.length} tools`);
