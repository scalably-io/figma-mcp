import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const BUNDLE_FILES = ['frame.png', 'node.json', 'fills.json'] as const;

export class ArtifactTransactionError extends Error {
  readonly code: string;
  readonly changed: false | 'unknown';

  constructor(
    code: string,
    message: string,
    changed: false | 'unknown' = false,
  ) {
    super(message);
    this.name = 'ArtifactTransactionError';
    this.code = code;
    this.changed = changed;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function regularRoot(root: string): { input: string; real: string } {
  const input = path.resolve(root);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(input);
  } catch {
    throw new Error(`Figma output root does not exist: ${input}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'Figma output root must be a regular non-symlink directory.',
    );
  }
  return { input, real: fs.realpathSync(input) };
}

export function resolveContainedOut(root: string, requested: string): string {
  if (!path.isAbsolute(requested)) {
    throw new Error('out_dir must be an absolute path.');
  }
  const resolvedRoot = regularRoot(root);
  const resolved = path.resolve(requested);
  if (
    !inside(resolvedRoot.input, resolved) ||
    resolved === resolvedRoot.input
  ) {
    throw new Error(
      `out_dir must stay below ${resolvedRoot.input} (got ${resolved})`,
    );
  }

  const relative = path.relative(resolvedRoot.input, resolved);
  let cursor = resolvedRoot.input;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'An existing out_dir component is not a regular workspace directory.',
      );
    }
  }

  if (fs.existsSync(resolved)) {
    if (!inside(resolvedRoot.real, fs.realpathSync(resolved))) {
      throw new Error('Existing out_dir resolves outside the configured root.');
    }
  }
  return resolved;
}

export function inspectPng(buffer: Buffer) {
  const signatureValid =
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  const ihdrValid =
    signatureValid &&
    buffer.length >= 33 &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR';
  const width = ihdrValid ? buffer.readUInt32BE(16) : 0;
  const height = ihdrValid ? buffer.readUInt32BE(20) : 0;
  const dimensionsValid = width > 0 && height > 0;
  let chunkStructureValid = false;
  if (ihdrValid) {
    let offset = 8;
    let chunkIndex = 0;
    let sawImageData = false;
    let sawEnd = false;
    while (offset + 12 <= buffer.length) {
      const dataLength = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      const next = offset + 12 + dataLength;
      if (next > buffer.length) break;
      if (chunkIndex === 0 && (type !== 'IHDR' || dataLength !== 13)) break;
      if (type === 'IDAT') sawImageData = true;
      if (type === 'IEND') {
        sawEnd = dataLength === 0;
        offset = next;
        break;
      }
      offset = next;
      chunkIndex += 1;
    }
    chunkStructureValid = sawImageData && sawEnd && offset === buffer.length;
  }
  return {
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    signatureValid,
    ihdrValid,
    chunkStructureValid,
    dimensionsValid,
    validPng:
      signatureValid && ihdrValid && chunkStructureValid && dimensionsValid,
    width,
    height,
    pixelCount: dimensionsValid ? width * height : 0,
  };
}

export function inspectJson(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    sizeBytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
  };
}

export async function writeAtomic(filePath: string, body: Buffer | string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(tempPath, body, { flag: 'wx', mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return fileProof(filePath);
}

/**
 * Transactionally replace only the three managed bundle files. Unrelated files
 * and downstream directories in out_dir are preserved. A failed commit is
 * rolled back; an unprovable rollback is surfaced as changed="unknown".
 */
export async function writeBundleTransactional(
  root: string,
  requestedOut: string,
  files: { frame: Buffer; node: string; fills: string },
) {
  let out: string;
  try {
    out = resolveContainedOut(root, requestedOut);
    await mkdir(out, { recursive: true, mode: 0o700 });
    // Re-resolve after mkdir to catch an existing or raced symlink component.
    resolveContainedOut(root, out);

    for (const name of BUNDLE_FILES) {
      const target = path.join(out, name);
      if (!fs.existsSync(target)) continue;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ArtifactTransactionError(
          'INVALID_EXISTING_BUNDLE_TARGET',
          `${name} must be a regular non-symlink file before replacement.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof ArtifactTransactionError) throw error;
    throw new ArtifactTransactionError(
      'BUNDLE_WRITE_FAILED',
      'The Figma bundle directory could not be prepared; no managed file replacement was attempted.',
    );
  }

  let stage: string;
  let backup: string;
  try {
    stage = await mkdtemp(path.join(out, '.figma-stage-'));
    backup = await mkdtemp(path.join(out, '.figma-backup-'));
  } catch {
    let cleanupFailed = false;
    if (stage!) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    throw new ArtifactTransactionError(
      cleanupFailed ? 'BUNDLE_CLEANUP_UNPROVEN' : 'BUNDLE_WRITE_FAILED',
      cleanupFailed
        ? `Figma bundle staging failed and temporary cleanup could not be proven in ${out}.`
        : 'The Figma bundle staging directories could not be created.',
      cleanupFailed ? 'unknown' : false,
    );
  }
  const backedUp: string[] = [];
  const installed: string[] = [];
  let committed = false;
  let cleanupUnproven = false;
  const cleanupWarnings: string[] = [];

  try {
    await Promise.all([
      writeAtomic(path.join(stage, 'frame.png'), files.frame),
      writeAtomic(path.join(stage, 'node.json'), files.node),
      writeAtomic(path.join(stage, 'fills.json'), files.fills),
    ]);
    await validateBundle(stage);

    for (const name of BUNDLE_FILES) {
      const target = path.join(out, name);
      if (!fs.existsSync(target)) continue;
      await rename(target, path.join(backup, name));
      backedUp.push(name);
    }
    for (const name of BUNDLE_FILES) {
      await rename(path.join(stage, name), path.join(out, name));
      installed.push(name);
    }
    committed = true;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const name of [...installed].reverse()) {
      try {
        await rm(path.join(out, name), { force: true });
      } catch {
        rollbackErrors.push(`remove-new-${name}`);
      }
    }
    for (const name of [...backedUp].reverse()) {
      try {
        await rename(path.join(backup, name), path.join(out, name));
      } catch {
        rollbackErrors.push(`restore-old-${name}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new ArtifactTransactionError(
        'BUNDLE_ROLLBACK_UNPROVEN',
        `The Figma bundle update failed and rollback could not be proven (${rollbackErrors.join(', ')}). Inspect ${out} before retrying.`,
        'unknown',
      );
    }
    if (error instanceof ArtifactTransactionError) throw error;
    throw new ArtifactTransactionError(
      'BUNDLE_WRITE_FAILED',
      'The Figma bundle could not be written; the previous managed files were restored.',
    );
  } finally {
    for (const [label, directory] of [
      ['staging', stage],
      ['backup', backup],
    ] as const) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        if (committed) cleanupWarnings.push(`${label} cleanup failed`);
        else cleanupUnproven = true;
      }
    }
  }

  if (cleanupUnproven) {
    throw new ArtifactTransactionError(
      'BUNDLE_CLEANUP_UNPROVEN',
      `The managed Figma files were rolled back, but temporary cleanup in ${out} could not be proven.`,
      'unknown',
    );
  }

  let proof: Awaited<ReturnType<typeof validateBundle>>;
  try {
    proof = await validateBundle(out);
  } catch {
    throw new ArtifactTransactionError(
      'BUNDLE_READBACK_UNPROVEN',
      `The Figma bundle was committed but final read-back could not be proven. Inspect ${out} before retrying.`,
      'unknown',
    );
  }
  return {
    out,
    ...proof,
    previousBundleReplaced: backedUp.length > 0,
    cleanupWarnings,
  };
}

async function validateBundle(directory: string) {
  const framePath = path.join(directory, 'frame.png');
  const nodePath = path.join(directory, 'node.json');
  const fillsPath = path.join(directory, 'fills.json');
  const [frameBody, nodeBody, fillsBody] = await Promise.all([
    readFile(framePath),
    readFile(nodePath, 'utf8'),
    readFile(fillsPath, 'utf8'),
  ]);
  const frameInspection = inspectPng(frameBody);
  if (!frameInspection.validPng) {
    throw new ArtifactTransactionError(
      'INVALID_STAGED_FRAME',
      'The staged frame is not a valid PNG with an IHDR and non-zero dimensions.',
    );
  }
  try {
    JSON.parse(nodeBody);
    JSON.parse(fillsBody);
  } catch {
    throw new ArtifactTransactionError(
      'INVALID_STAGED_JSON',
      'The staged Figma node or fills artifact is not valid JSON.',
    );
  }
  const [frame, node, fills] = await Promise.all([
    fileProof(framePath),
    fileProof(nodePath),
    fileProof(fillsPath),
  ]);
  return {
    frame: { ...frame, ...frameInspection },
    node: { ...node, validJson: true },
    fills: { ...fills, validJson: true },
  };
}

async function fileProof(filePath: string) {
  const readBack = await readFile(filePath);
  return {
    path: filePath,
    sizeBytes: readBack.length,
    sha256: crypto.createHash('sha256').update(readBack).digest('hex'),
    exists: true,
  };
}
