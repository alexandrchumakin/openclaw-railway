const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isBlockedHostname,
  isPrivateIp,
  isPublicHttpUrl,
} = require('../search-proxy');


test('blocks loopback, link-local, and private network addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});


test('blocks local and cloud metadata hostnames', () => {
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('service.internal'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});


test('rejects non-HTTP fetch URLs before browser navigation', async () => {
  assert.equal(await isPublicHttpUrl('file:///etc/passwd'), false);
  assert.equal(await isPublicHttpUrl('data:text/plain,hello'), false);
  assert.equal(await isPublicHttpUrl('http://127.0.0.1/private'), false);
});
