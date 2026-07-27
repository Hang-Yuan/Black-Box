#!/usr/bin/env node

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const marker = process.env.MCP_SMOKE_MARKER;
const readyFile = process.env.MCP_HTTP_READY_FILE;
const logFile = process.env.MCP_HTTP_LOG_FILE;
const requireAuth = process.env.MCP_HTTP_REQUIRE_AUTH === '1';
if (!marker || !readyFile) throw new Error('MCP_SMOKE_MARKER and MCP_HTTP_READY_FILE are required');

function log(method) {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${method}\n`, 'utf8');
}

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

const server = createServer((request, response) => {
  if (request.url === '/.well-known/oauth-protected-resource/mcp') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    json(response, 200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
    return;
  }
  if (request.url === '/.well-known/oauth-authorization-server') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    json(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }
  if (request.url !== '/mcp' || request.method !== 'POST') {
    json(response, 404, { error: 'not found' });
    return;
  }
  if (requireAuth && request.headers.authorization !== 'Bearer isolated-smoke-token') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    json(response, 401, { error: 'authentication required' }, {
      'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    });
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      json(response, 400, { error: 'invalid JSON' });
      return;
    }
    log(typeof message.method === 'string' ? message.method : 'unknown');
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      json(response, 200, rpcResult(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'blackbox-http-smoke', version: '1.0.0' },
        instructions: 'Use emit_marker when asked for the isolated scheduler marker.',
      }));
      return;
    }
    if (message.method === 'tools/list') {
      json(response, 200, rpcResult(message.id, {
        tools: [{
          name: 'emit_marker',
          description: 'Returns the isolated acceptance marker.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      }));
      return;
    }
    if (message.method === 'tools/call' && message.params?.name === 'emit_marker') {
      json(response, 200, rpcResult(message.id, {
        content: [{ type: 'text', text: marker }],
        isError: false,
      }));
      return;
    }
    if (message.method === 'ping') {
      json(response, 200, rpcResult(message.id, {}));
      return;
    }
    json(response, 200, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32601, message: 'Method not found' },
    });
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(readyFile, `${JSON.stringify({
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
  })}\n`, 'utf8');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
