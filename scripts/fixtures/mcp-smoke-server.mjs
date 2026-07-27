#!/usr/bin/env node

import { createInterface } from 'node:readline';

const marker = process.env.MCP_SMOKE_MARKER || 'MCP_SMOKE_MARKER_MISSING';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'blackbox-scheduler-smoke', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [{
        name: 'emit_marker',
        description: 'Return the server-only marker for the Black Box scheduled MCP smoke test.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    });
  } else if (message.method === 'tools/call') {
    respond(message.id, {
      content: [{ type: 'text', text: marker }],
      isError: false,
    });
  } else if (message.id !== undefined && !String(message.method || '').startsWith('notifications/')) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    })}\n`);
  }
});
