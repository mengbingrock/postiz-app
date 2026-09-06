import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedHost,
  EgressRelayService,
  validChineseInLALoginDocument,
} from './egress.relay.service';

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

test('ChineseInLA egress probe requires both credential fields', () => {
  assert.equal(
    validChineseInLALoginDocument(
      '<form><input name="username"><input type="password" name="password"></form>'
    ),
    true
  );
  assert.equal(
    validChineseInLALoginDocument(
      "<INPUT autocomplete='username' NAME='username'><INPUT NAME='password'>"
    ),
    true
  );
  assert.equal(
    validChineseInLALoginDocument(
      '<html><h1>This site can’t be reached</h1><div>ERR_TUNNEL_CONNECTION_FAILED</div></html>'
    ),
    false
  );
  assert.equal(
    validChineseInLALoginDocument('<input name="username">'),
    false
  );
});

test('ChineseInLA lease starts before the login-page probe', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = (organizationId, deviceId, ttlMinutes) => {
    events.push(`start:${organizationId}:${deviceId}:${ttlMinutes}`);
    return {} as ReturnType<EgressRelayService['status']>;
  };
  relay.status = (organizationId) => {
    events.push(`status:${organizationId}`);
    return {
      connectorOnline: true,
      devices: [{ deviceId: 'mac', connectedAt: new Date().toISOString() }],
      lease: {
        id: 'lease',
        deviceId: 'mac',
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        proxyUrl: 'http://127.0.0.1:18443',
      },
    };
  };
  (relay as any).httpsGetThroughProxy = async (host: string, path: string) => {
    events.push(`probe:${host}:${path}`);
    return '<input name="username"><input name="password">';
  };

  const result = await relay.ensureChineseInLALease('org', 'mac', 10);

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    'start:org:mac:10',
    'probe:www.chineseinla.com:/f/page_login.html',
    'status:org',
  ]);
});

test('ChineseInLA lease is stopped when its probe fails', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = () => ({}) as ReturnType<EgressRelayService['status']>;
  relay.stopLease = (organizationId, reason) => {
    events.push(`stop:${organizationId}:${reason}`);
    return {
      connectorOnline: false,
      devices: [],
      lease: null,
    };
  };
  (relay as any).httpsGetThroughProxy = async () =>
    '<html>ERR_TUNNEL_CONNECTION_FAILED</html>';

  await assert.rejects(
    relay.ensureChineseInLALease('org', 'mac', 10),
    /could not reach the ChineseInLA login page/
  );
  assert.deepEqual(events, ['stop:org:chineseinla_probe_failed']);
});

test('ChineseInLA lease remains active until the wrapped operation finishes', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.ensureChineseInLALease = async () => {
    events.push('ensure');
    return { ok: true } as Awaited<
      ReturnType<EgressRelayService['ensureChineseInLALease']>
    >;
  };
  relay.stopLease = (_organizationId, reason) => {
    events.push(`stop:${reason}`);
    return { connectorOnline: false, devices: [], lease: null };
  };

  const result = await relay.withChineseInLALease('org', async () => {
    events.push('authenticate');
    return 'connected';
  });

  assert.equal(result, 'connected');
  assert.deepEqual(events, [
    'ensure',
    'authenticate',
    'stop:chineseinla_operation_finished',
  ]);
});

test('ChineseInLA lease is stopped when the wrapped operation fails', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.ensureChineseInLALease = async () =>
    ({ ok: true } as Awaited<
      ReturnType<EgressRelayService['ensureChineseInLALease']>
    >);
  relay.stopLease = (_organizationId, reason) => {
    events.push(`stop:${reason}`);
    return { connectorOnline: false, devices: [], lease: null };
  };

  await assert.rejects(
    relay.withChineseInLALease('org', async () => {
      throw new Error('authentication failed');
    }),
    /authentication failed/
  );
  assert.deepEqual(events, ['stop:chineseinla_operation_finished']);
});
