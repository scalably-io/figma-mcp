import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactTransactionError,
  inspectPng,
  resolveContainedOut,
  writeAtomic,
  writeBundleTransactional,
} from '../dist/artifacts.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhE' +
  'UgAAAAEAAAABCAQAAAC1' +
  'HAwCAAAAC0lEQVR42mNk' +
  '+A8AAQUBAScY42YAAAAA' +
  'SUVORK5CYII=',
  'base64',
);

test('output directories are root-contained and reject symlink traversal', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-containment-'));
  const root = path.join(temp, 'group');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'link'));
  try {
    assert.equal(
      resolveContainedOut(root, path.join(root, 'figma-work')),
      path.join(root, 'figma-work'),
    );
    assert.throws(
      () => resolveContainedOut(root, outside),
      /must stay below/,
    );
    assert.throws(
      () => resolveContainedOut(root, path.join(root, '..', 'escape')),
      /must stay below/,
    );
    assert.throws(
      () => resolveContainedOut(root, path.join(root, 'link', 'bundle')),
      /regular workspace directory/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('PNG inspection requires signature, IHDR, and non-zero dimensions', () => {
  const valid = inspectPng(PNG);
  assert.equal(valid.signatureValid, true);
  assert.equal(valid.ihdrValid, true);
  assert.equal(valid.chunkStructureValid, true);
  assert.equal(valid.validPng, true);
  assert.equal(valid.width, 1);
  assert.equal(valid.height, 1);
  assert.equal(
    inspectPng(PNG.subarray(0, 8)).validPng,
    false,
    'a signature alone is not a valid artifact',
  );
  assert.equal(
    inspectPng(PNG.subarray(0, 33)).validPng,
    false,
    'an IHDR without image data and IEND is not a valid artifact',
  );
  assert.equal(inspectPng(Buffer.from('<html>403</html>')).validPng, false);
});

test('atomic single-file write returns exact read-back proof', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-artifact-'));
  try {
    const file = path.join(directory, 'frame.png');
    const proof = await writeAtomic(file, PNG);
    assert.equal(proof.exists, true);
    assert.equal(proof.sizeBytes, PNG.length);
    assert.match(proof.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(file).equals(PNG), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bundle transaction replaces only managed files and preserves downstream work', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-bundle-'));
  const root = path.join(temp, 'group');
  const out = path.join(root, 'figma-work');
  fs.mkdirSync(path.join(out, 'clone'), { recursive: true });
  fs.writeFileSync(path.join(out, 'frame.png'), 'old-frame');
  fs.writeFileSync(path.join(out, 'node.json'), '{"old":true}');
  fs.writeFileSync(path.join(out, 'fills.json'), '{"old":true}');
  fs.writeFileSync(path.join(out, 'clone', 'index.html'), 'keep me');
  try {
    const result = await writeBundleTransactional(root, out, {
      frame: PNG,
      node: '{"document":{"name":"Frame"}}',
      fills: '{"imageRef":"https://asset.example/fill"}',
    });
    assert.equal(result.previousBundleReplaced, true);
    assert.equal(result.frame.validPng, true);
    assert.equal(result.node.validJson, true);
    assert.equal(result.fills.validJson, true);
    assert.equal(
      fs.readFileSync(path.join(out, 'clone', 'index.html'), 'utf8'),
      'keep me',
    );
    assert.equal(
      fs.readdirSync(out).some((name) => name.startsWith('.figma-')),
      false,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('bundle transaction fails closed on an existing symlink target', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-symlink-'));
  const root = path.join(temp, 'group');
  const out = path.join(root, 'figma-work');
  const external = path.join(temp, 'external-frame.png');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(external, 'external');
  fs.symlinkSync(external, path.join(out, 'frame.png'));
  try {
    await assert.rejects(
      writeBundleTransactional(root, out, {
        frame: PNG,
        node: '{}',
        fills: '{}',
      }),
      (error) =>
        error instanceof ArtifactTransactionError &&
        error.code === 'INVALID_EXISTING_BUNDLE_TARGET',
    );
    assert.equal(fs.readFileSync(external, 'utf8'), 'external');
    assert.equal(fs.existsSync(path.join(out, 'node.json')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
