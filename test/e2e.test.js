import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhE' +
  'UgAAAAEAAAABCAQAAAC1' +
  'HAwCAAAAC0lEQVR42mNk' +
  '+A8AAQUBAScY42YAAAAA' +
  'SUVORK5CYII=',
  'base64',
);

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-figma-request-id': `request-${status}`,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function startMockFigma() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/files/test-file') {
      json(res, 200, {
        name: 'Test Designs',
        version: '42',
        lastModified: '2026-08-30T00:00:00Z',
        editorType: 'figma',
        document: {
          children: [
            {
              name: 'Emails',
              children: [
                {
                  id: '1:2',
                  type: 'FRAME',
                  name: 'Launch Email',
                  absoluteBoundingBox: { width: 1, height: 1 },
                },
              ],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === '/v1/files/rate-file') {
      json(
        res,
        429,
        { err: 'rate limit reached' },
        {
          'retry-after': '17',
          'x-figma-plan-tier': 'pro',
          'x-figma-rate-limit-type': 'high',
        },
      );
      return;
    }
    if (url.pathname === '/v1/files/test-file/nodes') {
      json(res, 200, {
        version: '42',
        lastModified: '2026-08-30T00:00:00Z',
        nodes: {
          '1:2': {
            document: {
              name: 'Launch Email',
              absoluteBoundingBox: { width: 1, height: 1 },
            },
          },
        },
      });
      return;
    }
    if (url.pathname === '/v1/files/bad-file/nodes') {
      json(res, 200, {
        nodes: {
          '1:2': {
            document: {
              name: 'Bad Frame',
              absoluteBoundingBox: { width: 1, height: 1 },
            },
          },
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/files/test-file/images' ||
      url.pathname === '/v1/files/bad-file/images'
    ) {
      json(res, 200, {
        images: { imageRef: 'https://asset.example/fill.png' },
      });
      return;
    }
    if (url.pathname === '/v1/images/test-file') {
      json(res, 200, {
        images: {
          '1:2': `http://localhost:${server.address().port}/cdn/frame.png`,
        },
      });
      return;
    }
    if (url.pathname === '/v1/images/bad-file') {
      json(res, 200, {
        images: {
          '1:2': `http://localhost:${server.address().port}/cdn/error.png?secret=signed`,
        },
      });
      return;
    }
    if (url.pathname === '/cdn/frame.png') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(PNG.length),
        'x-request-id': 'download-request',
      });
      res.end(PNG);
      return;
    }
    if (url.pathname === '/cdn/error.png') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>expired signed secret</html>');
      return;
    }
    json(res, 404, { err: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => {
      resolve({
        server,
        api: `http://localhost:${server.address().port}/v1`,
      });
    });
  });
}

function createMcpClient({ api, outputRoot }) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: packageDir,
    env: {
      ...process.env,
      FIGMA_TOKEN: 'test-token',
      FIGMA_API_BASE_URL: api,
      FIGMA_ALLOW_HTTP_FOR_TESTS: '1',
      FIGMA_OUTPUT_ROOT: outputRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  function request(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    );
    return response;
  }
  return {
    child,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'figma-e2e', version: '1.0.0' },
      });
      assert.equal(response.result?.serverInfo?.version, '1.0.0');
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
    },
    listTools: () => request('tools/list', {}),
    callTool: (name, args) =>
      request('tools/call', { name, arguments: args }),
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function textOf(response) {
  return (
    response.result?.content?.find((item) => item.type === 'text')?.text || ''
  );
}

function envelope(response) {
  return JSON.parse(textOf(response));
}

test('Figma stdio surface is exact and frame artifacts are fully proven', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-e2e-'));
  const outputRoot = path.join(temp, 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const { server, api } = await startMockFigma();
  const client = createMcpClient({ api, outputRoot });
  try {
    await client.initialize();
    const listedTools = await client.listTools();
    assert.deepEqual(
      listedTools.result.tools.map((tool) => tool.name),
      ['list_frames', 'fetch_frame'],
    );
    assert.equal(listedTools.result.tools[0].annotations.readOnlyHint, true);
    assert.equal(listedTools.result.tools[1].annotations.readOnlyHint, true);
    assert.equal(listedTools.result.tools[1].annotations.destructiveHint, true);

    const listed = await client.callTool('list_frames', {
      file_key: 'test-file',
      query: 'launch',
    });
    const listOutcome = envelope(listed);
    assert.equal(listOutcome.status, 'succeeded');
    assert.equal(listOutcome.result.count, 1);
    assert.equal(listOutcome.result.resultComplete, true);
    assert.equal(listOutcome.proof.request.requestId, 'request-200');
    assert.equal(listOutcome.result.file.version, '42');

    // A relative out_dir resolves below the output root (1.0.1); the root is created on demand.
    const relativeFetch = envelope(await client.callTool('fetch_frame', {
      file_key: 'test-file',
      node_id: '1:2',
      out_dir: path.join('relative', 'frame'),
      scale: 1,
    }));
    assert.equal(relativeFetch.status, 'succeeded');
    assert.ok(fs.existsSync(path.join(outputRoot, 'relative', 'frame', 'frame.png')), 'relative out_dir landed below the output root');

    const outDir = path.join(outputRoot, 'figma-work');
    const fetched = await client.callTool('fetch_frame', {
      file_key: 'test-file',
      node_id: '1:2',
      out_dir: outDir,
      scale: 1,
    });
    const success = envelope(fetched);
    assert.equal(success.status, 'succeeded');
    assert.equal(success.proof.artifacts.frame.validPng, true);
    assert.equal(success.proof.artifacts.frame.width, 1);
    assert.match(success.proof.artifacts.frame.sha256, /^[a-f0-9]{64}$/);
    assert.equal(success.proof.artifacts.node.validJson, true);
    assert.equal(success.proof.artifacts.fills.validJson, true);
    assert.equal(success.proof.upstream.download.requestId, 'download-request');
    assert.equal(
      fs.readFileSync(path.join(outDir, 'frame.png')).equals(PNG),
      true,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(outDir, 'fills.json'), 'utf8')),
      { imageRef: 'https://asset.example/fill.png' },
    );
    assert.doesNotMatch(
      JSON.stringify(success),
      /127\.0\.0\.1|cdn\/frame\.png|secret=signed/,
    );

    const badOut = path.join(outputRoot, 'bad-work');
    const bad = await client.callTool('fetch_frame', {
      file_key: 'bad-file',
      node_id: '1:2',
      out_dir: badOut,
      scale: 1,
    });
    assert.equal(bad.result?.isError, true);
    assert.match(textOf(bad), /^FRAME_DOWNLOAD_HTTP_ERROR:/);
    assert.doesNotMatch(textOf(bad), /secret=signed|expired signed secret/);
    assert.equal(fs.existsSync(path.join(badOut, 'frame.png')), false);

    const rateLimited = await client.callTool('list_frames', {
      file_key: 'rate-file',
    });
    assert.equal(rateLimited.result?.isError, true);
    assert.match(textOf(rateLimited), /^FIGMA_RATE_LIMITED:/);
    assert.match(textOf(rateLimited), /17 seconds/);

    const invalidScale = await client.callTool('fetch_frame', {
      file_key: 'test-file',
      node_id: '1:2',
      out_dir: outDir,
      scale: 5,
    });
    assert.ok(invalidScale.error);
    assert.match(invalidScale.error.message, /invalid_arguments/);

    const missingFileKey = await client.callTool('list_frames', {});
    assert.ok(missingFileKey.error);
    assert.match(missingFileKey.error.message, /invalid_arguments/);

    const escaped = await client.callTool('fetch_frame', {
      file_key: 'test-file',
      node_id: '1:2',
      out_dir: path.join(temp, 'escape'),
      scale: 1,
    });
    assert.equal(escaped.result?.isError, true);
    assert.match(textOf(escaped), /^INVALID_OUT_DIR:/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Figma starts without a token and returns a not-configured failure', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-e2e-noauth-'));
  const outputRoot = path.join(temp, 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: packageDir,
    env: {
      ...process.env,
      FIGMA_TOKEN: '',
      FIGMA_API_BASE_URL: 'http://localhost:1/v1',
      FIGMA_ALLOW_HTTP_FOR_TESTS: '1',
      FIGMA_OUTPUT_ROOT: outputRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  function request(method, params) {
    const id = 1;
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }
  try {
    await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'figma-e2e-noauth', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    pending.delete(1);
    const response = await request('tools/call', {
      name: 'list_frames',
      arguments: { file_key: 'test-file' },
    });
    assert.equal(response.result?.isError, true);
    assert.match(textOf(response), /^FIGMA_NOT_CONFIGURED:/);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
