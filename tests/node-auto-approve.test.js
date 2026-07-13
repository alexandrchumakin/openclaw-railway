const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'node-auto-approve.js'),
  'utf8',
);

test('connects with the gateway protocol required by pinned OpenClaw', () => {
  assert.match(source, /const GATEWAY_PROTOCOL = 4;/);
  assert.match(source, /minProtocol: GATEWAY_PROTOCOL/);
  assert.match(source, /maxProtocol: GATEWAY_PROTOCOL/);
  assert.doesNotMatch(source, /(?:min|max)Protocol: 3/);
});
