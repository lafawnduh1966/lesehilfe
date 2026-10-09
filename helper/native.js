// Chrome native messaging framing: each message is a 4-byte little-endian
// length followed by UTF-8 JSON, on stdin (from Chrome) and stdout (to Chrome).
// stdout is reserved for the protocol, so all logging goes to a file.
import fs from 'node:fs';
import path from 'node:path';
import { LESEHILFE_DIR } from './paths.js';

fs.mkdirSync(LESEHILFE_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LESEHILFE_DIR, 'helper.log'), { flags: 'a' });

export function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(' ');
  logStream.write(`${new Date().toISOString()} ${line}\n`);
}

// Dependencies must never write to stdout.
console.log = console.info = console.warn = console.error = console.debug = log;

const MAX_OUTGOING = 1024 * 1024; // Chrome's limit for host → extension messages.

export function send(message) {
  let json = JSON.stringify(message);
  if (Buffer.byteLength(json) > MAX_OUTGOING) {
    json = JSON.stringify({ ...message, result: undefined, error: 'Response too large' });
  }
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

export function onMessage(handler) {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      try {
        handler(JSON.parse(body));
      } catch (e) {
        log('bad message', e);
      }
    }
  });
}
