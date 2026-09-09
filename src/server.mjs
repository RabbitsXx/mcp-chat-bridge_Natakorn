// mcp-chat-bridge (REST mode) — expose any MCP stdio server as REST + OpenAPI
// for Custom GPT Actions / ChatGPT plugin mode.
//
// Run:    node src/server.mjs          (env: BRIDGE_TOKEN, FS_COMMAND, ROOTS, PORT)
//         GET  /healthz                -> ok
//         GET  /tools                  -> tool list (schemas)
//         GET  /openapi.json           -> OpenAPI spec to paste into GPT Actions
//         POST /call/<tool>            -> { arguments: {...} }  (Authorization: Bearer <TOKEN>)
//
// ⚠️ Security: binds to 127.0.0.1 only. Never expose directly to the internet
//    without a strong BRIDGE_TOKEN and a trusted tunnel.

import http from 'node:http';
import { spawn } from 'node:child_process';

// ---------- config ----------
const PORT = Number(process.env.PORT || 8792);
const TOKEN = process.env.BRIDGE_TOKEN || ''; // empty = refuse to start (safety)
const HOST = '127.0.0.1';
const BODY_LIMIT = 5 * 1024 * 1024; // 5MB

// Command that launches the MCP stdio server. Default: official filesystem server.
const MCP_COMMAND = process.env.MCP_COMMAND || 'npx -y @modelcontextprotocol/server-filesystem';
const ROOTS = (process.env.ROOTS || process.cwd()).split(/\s+/).filter(Boolean);

function parseCommand(command) {
  // Supports quotes:  npx -y pkg "arg with spaces"
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ''));
}

const [FS_BIN, ...FS_ARGS_BASE] = parseCommand(MCP_COMMAND);
const FS_ARGS = [...FS_ARGS_BASE, ...ROOTS];

if (!TOKEN) {
  console.error('[bridge] FATAL: BRIDGE_TOKEN must be set before running (generate one: openssl rand -hex 32)');
  process.exit(1);
}

// ---------- MCP stdio client ----------
let proc = null;
let raw = '';
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}
let toolsCache = null;
let ready = null;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function mcpCall(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP call ${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    log('[mcp] starting:', FS_BIN, FS_ARGS.join(' '));
    // On Windows, launchers like npx/npm are .cmd shims and need shell mode.
    proc = spawn(FS_BIN, FS_ARGS, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    raw = '';
    proc.stdout.on('data', (d) => {
      raw += d.toString('utf8');
      let i;
      while ((i = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, i);
        raw = raw.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${p.method} error: ${JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
      }
    });
    proc.on('exit', (code) => {
      log('[mcp] stdio server exited (code', code, ') — will restart on next request');
      proc = null;
      toolsCache = null;
      ready = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP server closed')); }
      pending.clear();
    });
    proc.on('error', (e) => { proc = null; reject(e); });
    resolve();
  });
}

async function ensureReady() {
  if (!ready) {
    ready = (async () => {
      if (!proc || proc.exitCode !== null) await startServer();
      const init = await mcpCall('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-chat-bridge', version: '1.0.0' },
      }, 15000);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
      const listed = await mcpCall('tools/list', {}, 15000);
      toolsCache = (listed.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      }));
      log(`[mcp] handshake ok (${init.serverInfo?.name || '?'}) — ${toolsCache.length} tools`);
    })();
    ready.catch(() => { ready = null; });
  }
  await ready;
}

async function callTool(name, args) {
  await ensureReady();
  if (!toolsCache.some((t) => t.name === name)) {
    throw new Error(`Unknown tool "${name}" — see GET /tools`);
  }
  const res = await mcpCall('tools/call', { name, arguments: args || {} }, 90000);
  if (res.isError) {
    throw new Error(textOf(res) || 'tool returned isError=true');
  }
  return { ok: true, tool: name, output: textOf(res), raw: res };
}

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// ---------- HTTP server ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

const authOk = (req) => req.headers['authorization'] === `Bearer ${TOKEN}`;

function schemaFor(tools) {
  const paths = {};
  for (const t of tools) {
    paths[`/call/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.name.replaceAll('_', ' '),
        description:
          (t.description || '').slice(0, 500) +
          `\n\nCall: POST /call/${t.name} with JSON: {"arguments": {...}}`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { arguments: t.inputSchema || { type: 'object' } },
                required: ['arguments'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'MCP Chat Bridge (local PC)',
      version: '1.0.0',
      description: `Access a local MCP stdio server over REST. Every call needs header: Authorization: Bearer <TOKEN>. Allowed directories: ${ROOTS.join(', ') || '(command default)'}`,
    },
    servers: [],
    paths,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body exceeds 5MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    // schema-only routes (no auth)
    if (req.method === 'GET' && url.pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      await ensureReady();
      sendJson(res, 200, schemaFor(toolsCache));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/tools') {
      await ensureReady();
      sendJson(res, 200, { tools: toolsCache });
      return;
    }

    // authenticated routes
    if (!authOk(req)) {
      sendJson(res, 401, { error: 'unauthorized — send header Authorization: Bearer <TOKEN>' });
      return;
    }

    const m = url.pathname.match(/^\/call\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const args = body.arguments ?? {};
      log(`[call] ${m[1]} args=`, JSON.stringify(args).slice(0, 200));
      const result = await callTool(m[1], args);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, { service: 'mcp-chat-bridge', endpoints: ['/healthz', '/tools', '/openapi.json', 'POST /call/<tool>'] });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    log('[error]', e.message);
    sendJson(res, 200, { ok: false, tool: '', error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`[bridge] listening on http://${HOST}:${PORT} (auth enabled)`);
});

process.on('uncaughtException', (e) => log('[fatal]', e));
