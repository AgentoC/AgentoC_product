#!/usr/bin/env node

// Run-scoped stdio endpoint for the machine-local Codex app-server broker.
// It intentionally forwards JSONL frames without interpreting provider data;
// runner-sidecar remains the sole owner of Run lifecycle and approvals.

import { connect } from 'node:net';
import { createInterface } from 'node:readline';

function readSocketPath() {
  const index = process.argv.indexOf('--socket');
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const socketPath = readSocketPath();
if (!socketPath) {
  console.error('Codex app-server proxy socket is required');
  process.exit(1);
}

const socket = connect(socketPath);
let buffer = '';
let connected = false;

socket.on('connect', () => {
  connected = true;
});
socket.on('error', (error) => {
  if (!connected) console.error(`Codex app-server broker connection failed: ${error?.message || error}`);
  process.exitCode = 1;
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) process.stdout.write(`${line}\n`);
  }
});
socket.on('end', () => process.exit(process.exitCode || 0));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!socket.destroyed && socket.writable) socket.write(`${line}\n`);
});
input.on('close', () => {
  // The sidecar normally terminates this process after turn completion. If it
  // closes stdin first, end only this client connection; the broker survives.
  if (!socket.destroyed) socket.end();
});

