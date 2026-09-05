import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedHost } from './egress.relay.service';

test('Postiz egress destination allowlist permits only expected hosts', () => {
  for (const host of [
    'chineseinla.com',
    'www.chineseinla.com',
    'WWW.CHINESEINLA.COM.',
    'api.ipify.org',
  ]) {
    assert.equal(allowedHost(host), true, host);
  }

  for (const host of [
    'chineseinla.com.attacker.example',
    'notchineseinla.com',
    'ipify.org',
    'localhost',
    '127.0.0.1',
  ]) {
    assert.equal(allowedHost(host), false, host);
  }
});
