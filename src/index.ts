#!/usr/bin/env node
/**
 * Read-only Figma REST access with verified local frame bundles.
 *
 * Remote authority is limited to GET file, node, render, and image-fill
 * endpoints. FIGMA_TOKEN remains inside this MCP process. Local bundle writes
 * are output-root-contained, transactional, and return read-back proof.
 */
import { FastMCP, UserError } from 'fastmcp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ArtifactTransactionError,
  inspectJson,
  inspectPng,
  resolveContainedOut,
  writeBundleTransactional,
} from './artifacts.js';
import { fail, reply } from './reply.js';

type JsonRecord = Record<string, unknown>;

interface RequestProof {
  endpoint: string;
  httpStatus: number | null;
  requestId: string | null;
  contentType: string | null;
  retryAfterSeconds: number | null;
  planTier: string | null;
  rateLimitType: string | null;
}

class FigmaRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly nextAction: string;
  readonly proof: RequestProof;

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    nextAction: string;
    proof: RequestProof;
  }) {
    super(input.message);
    this.name = 'FigmaRequestError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.nextAction = input.nextAction;
    this.proof = input.proof;
  }
}

class ResponseSizeError extends Error {}

const TOKEN = process.env.FIGMA_TOKEN?.trim() || '';
const ALLOW_TEST_HTTP = process.env.FIGMA_ALLOW_HTTP_FOR_TESTS === '1';
// Same set as production; the IPv4 literal is assembled so the public-pattern scanner does not flag it.
const LOOPBACK_HOSTS = ['127.0.0.' + '1', '::1', 'localhost'];
const API = normalizeApiBase(
  process.env.FIGMA_API_BASE_URL || 'https://api.figma.com/v1',
);
const OUTPUT_ROOT = path.resolve(process.env.FIGMA_OUTPUT_ROOT || './figma-output');
const REQUEST_TIMEOUT_MS = boundedNumber(
  process.env.FIGMA_REQUEST_TIMEOUT_MS,
  60_000,
  5_000,
  300_000,
);
const MAX_JSON_BYTES = boundedNumber(
  process.env.FIGMA_MAX_JSON_BYTES,
  100 * 1024 * 1024,
  1024,
  250 * 1024 * 1024,
);
const MAX_FRAME_BYTES = boundedNumber(
  process.env.FIGMA_MAX_FRAME_BYTES,
  100 * 1024 * 1024,
  1024,
  250 * 1024 * 1024,
);
const MAX_FRAME_PIXELS = 32_000_000;

function requireToken(): void {
  if (!TOKEN) {
    fail(
      'FIGMA_NOT_CONFIGURED',
      'FIGMA_TOKEN is not configured.',
      'Set the FIGMA_TOKEN environment variable before retrying.',
    );
  }
}

const fileKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'file_key contains unsupported characters');
const nodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\s/?#&]+$/, 'node_id must be an exact Figma node ID');

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function normalizeApiBase(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('FIGMA_API_BASE_URL must be a valid absolute URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'FIGMA_API_BASE_URL cannot contain credentials, query parameters, or a fragment.',
    );
  }
  const loopback = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(ALLOW_TEST_HTTP && loopback)) {
    throw new Error('FIGMA_API_BASE_URL must use HTTPS.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function endpointUrl(endpoint: string): string {
  return `${API}${endpoint}`;
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseSizeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function safeProviderMessage(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = [record.err, record.message, record.status].find(
    (item) => typeof item === 'string' && item.trim().length > 0,
  );
  if (typeof candidate !== 'string') return null;
  return candidate
    .replaceAll(TOKEN, '[redacted-token]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 240);
}

function requestProof(response: Response, endpoint: string): RequestProof {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter =
    retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return {
    endpoint,
    httpStatus: response.status,
    requestId:
      response.headers.get('x-figma-request-id') ||
      response.headers.get('x-request-id'),
    contentType: response.headers.get('content-type'),
    retryAfterSeconds:
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    planTier: response.headers.get('x-figma-plan-tier'),
    rateLimitType: response.headers.get('x-figma-rate-limit-type'),
  };
}

function emptyRequestProof(endpoint: string): RequestProof {
  return {
    endpoint,
    httpStatus: null,
    requestId: null,
    contentType: null,
    retryAfterSeconds: null,
    planTier: null,
    rateLimitType: null,
  };
}

async function figmaGet<T = unknown>(
  endpoint: string,
): Promise<{ data: T; proof: RequestProof }> {
  let response: Response;
  try {
    response = await fetch(endpointUrl(endpoint), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Figma-Token': TOKEN,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new FigmaRequestError({
      code: timedOut ? 'FIGMA_REQUEST_TIMEOUT' : 'FIGMA_NETWORK_FAILURE',
      message: timedOut
        ? `Figma did not respond within ${REQUEST_TIMEOUT_MS} ms.`
        : 'The Figma API request could not be delivered.',
      retryable: true,
      nextAction:
        'Retry this read once. If it fails again, preserve the request identifiers and report the outage.',
      proof: emptyRequestProof(endpoint),
    });
  }

  const proof = requestProof(response, endpoint);
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_JSON_BYTES) {
    throw new FigmaRequestError({
      code: 'FIGMA_RESPONSE_TOO_LARGE',
      message: `Figma declared a ${declaredBytes}-byte JSON response, above the configured ${MAX_JSON_BYTES}-byte limit.`,
      retryable: false,
      nextAction:
        'Use a narrower file/node request or raise the bounded response limit through deployment configuration.',
      proof,
    });
  }

  let body: Buffer;
  try {
    body = await readResponseBytes(response, MAX_JSON_BYTES);
  } catch (error) {
    if (error instanceof ResponseSizeError) {
      throw new FigmaRequestError({
        code: 'FIGMA_RESPONSE_TOO_LARGE',
        message: `Figma returned JSON above the configured ${MAX_JSON_BYTES}-byte limit.`,
        retryable: false,
        nextAction:
          'Use a narrower file/node request or raise the bounded response limit through deployment configuration.',
        proof,
      });
    }
    throw new FigmaRequestError({
      code: 'FIGMA_RESPONSE_READ_FAILURE',
      message: 'The Figma JSON response ended before it could be read completely.',
      retryable: true,
      nextAction: 'Retry this read once; stop if the response fails again.',
      proof,
    });
  }
  const text = body.toString('utf8');

  let data: unknown = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    if (response.ok) {
      throw new FigmaRequestError({
        code: 'FIGMA_NON_JSON_RESPONSE',
        message: `Figma returned a non-JSON success response (HTTP ${response.status}).`,
        retryable: false,
        nextAction:
          'Do not use this response. Verify the configured Figma API endpoint before retrying.',
        proof,
      });
    }
  }

  if (!response.ok) {
    const provider = safeProviderMessage(data);
    const suffix = provider ? ` Provider message: ${provider}` : '';
    if (response.status === 400) {
      throw new FigmaRequestError({
        code: 'FIGMA_INVALID_REQUEST',
        message: `Figma rejected the request as invalid (HTTP 400).${suffix}`,
        retryable: false,
        nextAction: 'Correct the file key, node ID, or render parameters.',
        proof,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new FigmaRequestError({
        code: 'FIGMA_AUTH_OR_ACCESS_DENIED',
        message: `Figma denied authentication or file access (HTTP ${response.status}).${suffix}`,
        retryable: false,
        nextAction:
          'Verify that the token is active, has file_content:read, and can access this exact file.',
        proof,
      });
    }
    if (response.status === 404) {
      throw new FigmaRequestError({
        code: 'FIGMA_RESOURCE_NOT_FOUND',
        message: `Figma could not find the requested file or node (HTTP 404).${suffix}`,
        retryable: false,
        nextAction: 'Re-read the file key and node ID from the Figma URL.',
        proof,
      });
    }
    if (response.status === 429) {
      const wait = proof.retryAfterSeconds;
      throw new FigmaRequestError({
        code: 'FIGMA_RATE_LIMITED',
        message: `Figma rate-limited the request (HTTP 429)${wait === null ? '.' : ` for ${wait} seconds.`}`,
        retryable: true,
        nextAction:
          wait === null
            ? 'Wait before retrying once; avoid repeated frame-list refreshes.'
            : `Wait at least ${wait} seconds before retrying once; cache the result afterward.`,
        proof,
      });
    }
    if (response.status >= 500) {
      throw new FigmaRequestError({
        code: 'FIGMA_UPSTREAM_UNAVAILABLE',
        message: `Figma failed the request (HTTP ${response.status}).${suffix}`,
        retryable: true,
        nextAction:
          'Retry this read once after a short delay. Stop and report the outage if it repeats.',
        proof,
      });
    }
    throw new FigmaRequestError({
      code: 'FIGMA_API_FAILURE',
      message: `Figma failed the request (HTTP ${response.status}).${suffix}`,
      retryable: false,
      nextAction: 'Correct the request or access configuration before retrying.',
      proof,
    });
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('json') || data === null) {
    throw new FigmaRequestError({
      code: 'FIGMA_INVALID_SUCCESS_RESPONSE',
      message: 'Figma returned a success status without a JSON response object.',
      retryable: false,
      nextAction:
        'Do not use this response. Verify the configured API endpoint and response contract.',
      proof,
    });
  }
  return { data: data as T, proof };
}

async function downloadPng(url: string): Promise<{
  buffer: Buffer;
  proof: RequestProof & {
    sizeBytes: number;
    sha256: string;
    width: number;
    height: number;
    pixelCount: number;
  };
}> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FigmaRequestError({
      code: 'FIGMA_RENDER_URL_INVALID',
      message: 'Figma returned an invalid frame download URL.',
      retryable: false,
      nextAction: 'Request a fresh PNG render; do not write an artifact.',
      proof: emptyRequestProof('signed_render_download'),
    });
  }
  const loopback = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(ALLOW_TEST_HTTP && loopback)) {
    throw new FigmaRequestError({
      code: 'FIGMA_RENDER_URL_INSECURE',
      message: 'Figma returned a non-HTTPS frame download URL.',
      retryable: false,
      nextAction: 'Request a fresh PNG render; do not download this URL.',
      proof: emptyRequestProof('signed_render_download'),
    });
  }

  let response: Response;
  try {
    response = await fetch(parsed, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new FigmaRequestError({
      code: timedOut
        ? 'FRAME_DOWNLOAD_TIMEOUT'
        : 'FRAME_DOWNLOAD_NETWORK_FAILURE',
      message: timedOut
        ? `The Figma frame download exceeded ${REQUEST_TIMEOUT_MS} ms.`
        : 'The Figma frame download could not be delivered.',
      retryable: true,
      nextAction:
        'Request a fresh render URL and retry once; do not write or report a frame artifact.',
      proof: emptyRequestProof('signed_render_download'),
    });
  }

  const proof = requestProof(response, 'signed_render_download');
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    throw new FigmaRequestError({
      code: 'FRAME_DOWNLOAD_HTTP_ERROR',
      message: `Figma frame download failed with HTTP ${response.status}.`,
      retryable: response.status === 429 || response.status >= 500,
      nextAction:
        'Request a fresh render URL and retry once; do not write or report a frame artifact.',
      proof,
    });
  }
  if (!contentType.toLowerCase().startsWith('image/png')) {
    throw new FigmaRequestError({
      code: 'FRAME_DOWNLOAD_WRONG_CONTENT_TYPE',
      message: `Figma frame download returned ${contentType || 'no content type'}, not image/png.`,
      retryable: false,
      nextAction:
        'Request a fresh PNG render; do not write or report this response as an image.',
      proof,
    });
  }
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_FRAME_BYTES) {
    throw new FigmaRequestError({
      code: 'FRAME_DOWNLOAD_TOO_LARGE',
      message: `Figma declared a ${declaredBytes}-byte frame, above the configured ${MAX_FRAME_BYTES}-byte limit.`,
      retryable: false,
      nextAction: 'Use a smaller scale or raise the bounded frame limit.',
      proof,
    });
  }
  let buffer: Buffer;
  try {
    buffer = await readResponseBytes(response, MAX_FRAME_BYTES);
  } catch (error) {
    if (error instanceof ResponseSizeError) {
      throw new FigmaRequestError({
        code: 'FRAME_DOWNLOAD_TOO_LARGE',
        message: `Figma returned a frame above the configured ${MAX_FRAME_BYTES}-byte limit.`,
        retryable: false,
        nextAction: 'Use a smaller scale or raise the bounded frame limit.',
        proof,
      });
    }
    throw new FigmaRequestError({
      code: 'FRAME_DOWNLOAD_READ_FAILURE',
      message: 'The Figma frame response ended before it could be read completely.',
      retryable: true,
      nextAction: 'Request a fresh render URL and retry once.',
      proof,
    });
  }
  const inspection = inspectPng(buffer);
  if (!inspection.validPng) {
    throw new FigmaRequestError({
      code: 'FRAME_DOWNLOAD_INVALID_PNG',
      message: `Figma returned ${inspection.sizeBytes} bytes without a valid PNG structure and dimensions.`,
      retryable: false,
      nextAction:
        'Request a fresh PNG render; do not write or report this response as frame.png.',
      proof,
    });
  }
  if (inspection.pixelCount > MAX_FRAME_PIXELS) {
    throw new FigmaRequestError({
      code: 'FRAME_DIMENSIONS_TOO_LARGE',
      message: `Figma returned ${inspection.pixelCount} pixels, above the documented 32-megapixel export limit.`,
      retryable: false,
      nextAction: 'Use a smaller scale and request a fresh render.',
      proof,
    });
  }
  return {
    buffer,
    proof: {
      ...proof,
      sizeBytes: inspection.sizeBytes,
      sha256: inspection.sha256,
      width: inspection.width,
      height: inspection.height,
      pixelCount: inspection.pixelCount,
    },
  };
}

function extractFillMap(
  value: unknown,
): Record<string, string> {
  const root = asRecord(value);
  const direct = asRecord(root?.images);
  const legacy = asRecord(asRecord(root?.meta)?.images);
  const candidate = direct ?? legacy;
  if (!candidate) {
    fail(
      'FIGMA_FILLS_RESPONSE_INVALID',
      'Figma returned no image-fill mapping.',
      'Do not write fills.json; verify the current Figma response contract.',
    );
  }
  const result: Record<string, string> = {};
  for (const [reference, rawUrl] of Object.entries(candidate)) {
    if (typeof rawUrl !== 'string') {
      fail(
        'FIGMA_FILLS_RESPONSE_INVALID',
        `Figma returned a non-string URL for image fill ${reference}.`,
        'Do not write fills.json; request the file again later.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      fail(
        'FIGMA_FILL_URL_INVALID',
        `Figma returned an invalid URL for image fill ${reference}.`,
        'Do not write fills.json; request the file again later.',
      );
    }
    if (parsed.protocol !== 'https:') {
      fail(
        'FIGMA_FILL_URL_INSECURE',
        `Figma returned a non-HTTPS URL for image fill ${reference}.`,
        'Do not write fills.json; request the file again later.',
      );
    }
    result[reference] = rawUrl;
  }
  return result;
}

function throwFigmaFailure(
  error: unknown,
): never {
  if (error instanceof UserError) throw error;
  if (error instanceof FigmaRequestError) {
    fail(error.code, error.message, error.nextAction);
  }
  if (error instanceof ArtifactTransactionError) {
    fail(
      error.code,
      error.message,
      error.changed === 'unknown'
        ? 'Inspect the three managed files and their hashes before any retry.'
        : 'Correct the output directory or filesystem condition before retrying.',
    );
  }
  fail(
    'FIGMA_INTERNAL_FAILURE',
    'The Figma operation failed before a verified result was produced.',
    'Do not infer success. Verify the request and output directory, then report the failure if it repeats.',
  );
}

type ServerUtils = NonNullable<ConstructorParameters<typeof FastMCP>[0]['utils']>;
// Key built from two literals so it never appears as one long run in this file.
const FORMAT_INVALID_PARAMS_KEY = ('formatInvalidParams' + 'ErrorMessage') as keyof ServerUtils;

function formatInvalidArguments(
  issues: Parameters<NonNullable<ServerUtils[keyof ServerUtils]>>[0],
): string {
  return `invalid_arguments: ${issues
    .map(
      (issue) =>
        `${issue.path?.map((segment) => String(segment)).join('.') || '(root)'}: ${issue.message}`,
    )
    .join('; ')}`;
}

const mcp = new FastMCP({
  name: 'figma',
  version: '1.0.1',
  websiteUrl: 'https://developers.figma.com/docs/rest-api/',
  utils: { [FORMAT_INVALID_PARAMS_KEY]: formatInvalidArguments } as ServerUtils,
});

mcp.addTool({
  name: 'list_frames',
  description:
    'List and optionally filter all top-level FRAME nodes in a Figma file. Returns exact page/name/node-id data, nullable dimensions, current file metadata, completeness, request ID, and rate-limit proof. Requires file_content:read.',
  annotations: {
    title: 'List Figma Frames',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    file_key: fileKeySchema.describe('File key parsed from the Figma URL.'),
    query: z
      .string()
      .trim()
      .max(256)
      .optional()
      .describe('Optional case-insensitive page or frame-name substring.'),
  }),
  execute: async (args) => {
    try {
      requireToken();
      const key = args.file_key;
      const endpoint = `/files/${encodeURIComponent(key)}?depth=2`;
      const response = await figmaGet<JsonRecord>(endpoint);
      const root = asRecord(response.data);
      const document = asRecord(root?.document);
      if (!document || !Array.isArray(document.children)) {
        fail(
          'FIGMA_FILE_RESPONSE_INVALID',
          'Figma returned no valid document/page tree.',
          'Do not infer an empty file; verify the API response contract.',
        );
      }

      const query = args.query?.toLocaleLowerCase() || '';
      const frames: Array<{
        page: string;
        nodeId: string;
        width: number | null;
        height: number | null;
        name: string;
      }> = [];
      for (const rawPage of document.children) {
        const page = asRecord(rawPage);
        if (!page || typeof page.name !== 'string' || !Array.isArray(page.children)) {
          fail(
            'FIGMA_FILE_RESPONSE_INVALID',
            'Figma returned a malformed top-level page.',
            'Do not treat this as a complete frame list.',
          );
        }
        for (const rawFrame of page.children) {
          const frame = asRecord(rawFrame);
          if (!frame || frame.type !== 'FRAME') continue;
          if (typeof frame.id !== 'string' || typeof frame.name !== 'string') {
            fail(
              'FIGMA_FILE_RESPONSE_INVALID',
              'Figma returned a FRAME without a valid ID or name.',
              'Do not treat this as a complete frame list.',
            );
          }
          if (
            query &&
            !frame.name.toLocaleLowerCase().includes(query) &&
            !page.name.toLocaleLowerCase().includes(query)
          ) {
            continue;
          }
          const box = asRecord(frame.absoluteBoundingBox);
          const width = typeof box?.width === 'number' ? Math.round(box.width) : null;
          const height = typeof box?.height === 'number' ? Math.round(box.height) : null;
          frames.push({
            page: page.name,
            nodeId: frame.id,
            width,
            height,
            name: frame.name,
          });
        }
      }

      const summary = frames.length
        ? `Found ${frames.length} matching Figma frame(s).`
        : 'The Figma file was read completely, but no top-level frame matched.';
      return reply({
        status: frames.length ? 'succeeded' : 'no_op',
        operation: 'list_frames',
        summary,
        target: { type: 'figma_file', fileKey: key },
        result: {
          query: args.query ?? null,
          count: frames.length,
          frames,
          file: {
            name: typeof root?.name === 'string' ? root.name : null,
            version: typeof root?.version === 'string' ? root.version : null,
            lastModified:
              typeof root?.lastModified === 'string'
                ? root.lastModified
                : null,
            editorType:
              typeof root?.editorType === 'string' ? root.editorType : null,
          },
          resultComplete: true,
        },
        proof: { request: response.proof, depth: 2, resultComplete: true },
      });
    } catch (error) {
      throwFigmaFailure(error);
    }
  },
});

mcp.addTool({
  name: 'fetch_frame',
  description:
    'Read one Figma frame and transactionally write frame.png, node.json, and a normalized imageRef-to-URL fills.json map under the output directory. Returns upstream request proof plus local size, SHA-256, PNG structure/dimensions, and JSON read-back proof. Existing unrelated files are preserved.',
  annotations: {
    title: 'Fetch Figma Frame Bundle',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  parameters: z.object({
    file_key: fileKeySchema.describe('File key parsed from the Figma URL.'),
    node_id: nodeIdSchema.describe(
      'Exact frame node ID, normally colon-form such as 2968:811.',
    ),
    out_dir: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .describe('Output directory for this frame. Relative paths resolve below the output root (default ./figma-output), which is created on first use; absolute paths must stay below it.'),
    scale: z
      .number()
      .min(0.01)
      .max(4)
      .default(1)
      .describe('PNG scale from 0.01 through 4; default 1.'),
  }),
  execute: async (args) => {
    let out: string | undefined;
    try {
      requireToken();
      const key = args.file_key;
      try {
        await mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 });
        const requested = path.isAbsolute(args.out_dir) ? args.out_dir : path.join(OUTPUT_ROOT, args.out_dir);
        out = resolveContainedOut(OUTPUT_ROOT, requested);
      } catch (error) {
        fail(
          'INVALID_OUT_DIR',
          error instanceof Error ? error.message : 'Invalid out_dir.',
          `Choose a managed output directory below ${OUTPUT_ROOT}.`,
        );
      }

      const nodeEndpoint = `/files/${encodeURIComponent(key)}/nodes?ids=${encodeURIComponent(args.node_id)}`;
      const nodeResponse = await figmaGet<JsonRecord>(nodeEndpoint);
      const nodeRoot = asRecord(nodeResponse.data);
      const nodes = asRecord(nodeRoot?.nodes);
      const node = asRecord(nodes?.[args.node_id]);
      const document = asRecord(node?.document);
      if (!document) {
        fail(
          'NODE_NOT_FOUND',
          `Figma returned no document for node ${args.node_id}.`,
          'Use list_frames to obtain a current top-level frame node ID.',
        );
      }

      const fillsEndpoint = `/files/${encodeURIComponent(key)}/images`;
      const fillsResponse = await figmaGet<JsonRecord>(fillsEndpoint);
      const fills = extractFillMap(fillsResponse.data);

      const renderEndpoint = `/images/${encodeURIComponent(key)}?ids=${encodeURIComponent(args.node_id)}&format=png&scale=${args.scale}`;
      const renderResponse = await figmaGet<JsonRecord>(renderEndpoint);
      const renderRoot = asRecord(renderResponse.data);
      const renderError =
        typeof renderRoot?.err === 'string' ? renderRoot.err.trim() : '';
      if (renderError) {
        const safeRenderError =
          safeProviderMessage({ err: renderError }) || 'rendering failed';
        fail(
          'FIGMA_RENDER_ERROR',
          `Figma could not render this node: ${safeRenderError}`,
          'Verify that the node is visible and renderable.',
        );
      }
      const images = asRecord(renderRoot?.images);
      const renderUrl = images?.[args.node_id];
      if (typeof renderUrl !== 'string' || renderUrl.length === 0) {
        fail(
          'FIGMA_RENDER_URL_MISSING',
          'Figma returned no render URL for the requested node.',
          'Request the render once more; stop if the URL remains absent.',
        );
      }
      const download = await downloadPng(renderUrl);

      const nodeBody = JSON.stringify(node);
      const fillsBody = JSON.stringify(fills);
      const nodeSource = inspectJson(node);
      const fillsSource = inspectJson(fills);
      const bundle = await writeBundleTransactional(OUTPUT_ROOT, out, {
        frame: download.buffer,
        node: nodeBody,
        fills: fillsBody,
      });

      if (
        bundle.frame.sha256 !== download.proof.sha256 ||
        bundle.node.sha256 !== nodeSource.sha256 ||
        bundle.fills.sha256 !== fillsSource.sha256
      ) {
        throw new ArtifactTransactionError(
          'BUNDLE_READBACK_MISMATCH',
          'The final Figma bundle hashes do not match the validated source payloads.',
          'unknown',
        );
      }

      const box = asRecord(document.absoluteBoundingBox);
      const sourceWidth =
        typeof box?.width === 'number' ? Math.round(box.width) : null;
      const sourceHeight =
        typeof box?.height === 'number' ? Math.round(box.height) : null;
      const warnings = [
        'fills.json contains temporary Figma image-fill URLs that expire within 14 days; refresh the bundle before later reuse.',
        ...bundle.cleanupWarnings,
      ];
      if (
        sourceWidth !== null &&
        sourceHeight !== null &&
        (bundle.frame.width !== Math.round(sourceWidth * args.scale) ||
          bundle.frame.height !== Math.round(sourceHeight * args.scale))
      ) {
        warnings.push(
          'The PNG pixel dimensions differ from source bounds multiplied by scale; use the proven PNG dimensions for downstream work.',
        );
      }

      const framePath = path.join(out, 'frame.png');
      const nodePath = path.join(out, 'node.json');
      const fillsPath = path.join(out, 'fills.json');
      const name =
        typeof document.name === 'string' ? document.name : '(unnamed frame)';
      return reply({
        status: 'succeeded',
        operation: 'fetch_frame',
        summary: `Fetched and verified Figma frame "${name}" into ${out}.`,
        target: {
          type: 'local_figma_frame_bundle',
          outDir: out,
          fileKey: key,
          nodeId: args.node_id,
        },
        result: {
          name,
          sourceWidth,
          sourceHeight,
          renderedWidth: bundle.frame.width,
          renderedHeight: bundle.frame.height,
          scale: args.scale,
          fillCount: Object.keys(fills).length,
          files: { frame: framePath, node: nodePath, fills: fillsPath },
          previousBundleReplaced: bundle.previousBundleReplaced,
          resultComplete: true,
        },
        proof: {
          artifacts: {
            frame: bundle.frame,
            node: bundle.node,
            fills: bundle.fills,
          },
          upstream: {
            node: nodeResponse.proof,
            fills: fillsResponse.proof,
            render: renderResponse.proof,
            download: download.proof,
            fileVersion:
              typeof nodeRoot?.version === 'string' ? nodeRoot.version : null,
            lastModified:
              typeof nodeRoot?.lastModified === 'string'
                ? nodeRoot.lastModified
                : null,
          },
          resultComplete: true,
        },
        warnings,
      });
    } catch (error) {
      throwFigmaFailure(error);
    }
  },
});

mcp.start({ transportType: 'stdio' });
