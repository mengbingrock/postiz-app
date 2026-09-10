import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedHost,
  chineseInLAProxyConfigured,
  EgressRelayService,
  redNoteProxyConfigured,
  redNoteProxyDevice,
  validChineseInLALoginDocument,
} from './egress.relay.service';

test('Postiz egress destination allowlist permits only expected hosts', () => {
  for (const host of [
    'chineseinla.com',
    'www.chineseinla.com',
    'WWW.CHINESEINLA.COM.',
    'c3.nychinaren.com',
    'C3.NYCHINAREN.COM.',
    'api.ipify.org',
    'xiaohongshu.com',
    'www.xiaohongshu.com',
    'creator.xiaohongshu.com',
    'edith.xiaohongshu.com',
    'sns-img-qc.xhscdn.com',
    'sns-web-i10.rednotecdn.com',
    'fe-platform-s10.rednotecdn.com',
    'creator.rednote.com',
    't2.rnote.com',
    'redtrust.devops.rednote.life',
    'xhslink.com',
  ]) {
    assert.equal(allowedHost(host), true, host);
  }

  for (const host of [
    'chineseinla.com.attacker.example',
    'notchineseinla.com',
    'nychinaren.com',
    'evil.nychinaren.com',
    'c3.nychinaren.com.attacker.example',
    'ipify.org',
    'xiaohongshu.com.attacker.example',
    'notxiaohongshu.com',
    'xhscdn.com.evil.example',
    'localhost',
    '127.0.0.1',
  ]) {
    assert.equal(allowedHost(host), false, host);
  }
});

test('RedNote proxy routing is enabled only by REDNOTE_PROXY', () => {
  assert.equal(redNoteProxyConfigured(undefined), false);
  assert.equal(redNoteProxyConfigured('  '), false);
  assert.equal(redNoteProxyConfigured('local'), true);
  assert.equal(redNoteProxyDevice(undefined), undefined);
  assert.equal(redNoteProxyDevice(' '), undefined);
  assert.equal(redNoteProxyDevice(' martin-mac '), 'martin-mac');
});

test('RedNote lease falls back to the pinned REDNOTE_PROXY_DEVICE', async () => {
  const previous = process.env.REDNOTE_PROXY_DEVICE;
  process.env.REDNOTE_PROXY_DEVICE = 'martin-mac';
  try {
    const relay = new EgressRelayService();
    const devices: Array<string | undefined> = [];
    relay.startLease = async (_organizationId, deviceId) => {
      devices.push(deviceId);
      return { connectorOnline: true, devices: [], lease: null };
    };
    relay.status = () => ({ connectorOnline: true, devices: [], lease: null });
    (relay as any).httpsGetThroughProxy = async () => 'User-agent: *\n';

    await relay.ensureRedNoteLease('org');
    await relay.ensureRedNoteLease('org', 'carl-air');
    assert.deepEqual(devices, ['martin-mac', 'carl-air']);
  } finally {
    if (previous === undefined) delete process.env.REDNOTE_PROXY_DEVICE;
    else process.env.REDNOTE_PROXY_DEVICE = previous;
  }
});

test('RedNote lease probes Xiaohongshu through the tenant proxy', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = async (organizationId, deviceId, ttl) => {
    events.push(`start:${organizationId}:${deviceId}:${ttl}`);
    return { connectorOnline: true, devices: [], lease: null };
  };
  relay.status = (organizationId) => {
    events.push(`status:${organizationId}`);
    return { connectorOnline: true, devices: [], lease: null };
  };
  (relay as any).httpsGetThroughProxy = async (
    organizationId: string,
    host: string,
    path: string
  ) => {
    events.push(`probe:${organizationId}:${host}:${path}`);
    return 'User-agent: Googlebot\nDisallow: /\n';
  };

  const result = await relay.ensureRedNoteLease('org', 'mac', 15);

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    'start:org:mac:15',
    'probe:org:www.xiaohongshu.com:/robots.txt',
    'status:org',
  ]);
});

test('RedNote lease is stopped when its probe fails', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = async () =>
    ({}) as Awaited<ReturnType<EgressRelayService['startLease']>>;
  relay.stopLease = (organizationId, reason) => {
    events.push(`stop:${organizationId}:${reason}`);
    return { connectorOnline: false, devices: [], lease: null };
  };
  (relay as any).httpsGetThroughProxy = async () => {
    throw new Error('ERR_TUNNEL_CONNECTION_FAILED');
  };

  await assert.rejects(
    relay.ensureRedNoteLease('org', 'mac', 10),
    /could not reach Xiaohongshu/
  );
  assert.deepEqual(events, ['stop:org:rednote_probe_failed']);
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

test('ChineseInLA local egress is required only when a proxy is configured', () => {
  assert.equal(chineseInLAProxyConfigured(undefined), false);
  assert.equal(chineseInLAProxyConfigured('   '), false);
  assert.equal(
    chineseInLAProxyConfigured('http://127.0.0.1:18443'),
    true
  );
});

test('ChineseInLA lease starts before the login-page probe', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = async (organizationId, deviceId, ttlMinutes) => {
    events.push(`start:${organizationId}:${deviceId}:${ttlMinutes}`);
    return {} as Awaited<ReturnType<EgressRelayService['startLease']>>;
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
  (relay as any).httpsGetThroughProxy = async (
    organizationId: string,
    host: string,
    path: string
  ) => {
    events.push(`probe:${organizationId}:${host}:${path}`);
    return '<input name="username"><input name="password">';
  };

  const result = await relay.ensureChineseInLALease('org', 'mac', 10);

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    'start:org:mac:10',
    'probe:org:www.chineseinla.com:/f/page_login.html',
    'status:org',
  ]);
});

test('ChineseInLA lease is stopped when its probe fails', async () => {
  const relay = new EgressRelayService();
  const events: string[] = [];
  relay.startLease = async () =>
    ({}) as Awaited<ReturnType<EgressRelayService['startLease']>>;
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

test('organization leases coexist on isolated proxy ports', () => {
  const relay = new EgressRelayService();
  const future = new Date(Date.now() + 60_000);
  const leases = (relay as any).activeLeases as Map<string, any>;
  leases.set('org-a', {
    id: 'lease-a',
    organizationId: 'org-a',
    deviceId: 'mac-a',
    proxyPort: 31001,
    createdAt: new Date(),
    expiresAt: future,
    timer: setTimeout(() => undefined, 60_000),
  });
  leases.set('org-b', {
    id: 'lease-b',
    organizationId: 'org-b',
    deviceId: 'mac-b',
    proxyPort: 31002,
    createdAt: new Date(),
    expiresAt: future,
    timer: setTimeout(() => undefined, 60_000),
  });

  assert.equal(relay.status('org-a').lease?.proxyUrl, 'http://127.0.0.1:31001');
  assert.equal(relay.status('org-b').lease?.proxyUrl, 'http://127.0.0.1:31002');
  relay.stopLease('org-a');
  assert.equal(relay.status('org-a').lease, null);
  assert.equal(relay.status('org-b').lease?.id, 'lease-b');
  relay.stopLease('org-b');
});

test('renewing an organization lease does not interrupt active streams', async () => {
  const relay = new EgressRelayService();
  const sent: string[] = [];
  const destroyed: string[] = [];
  const socket = {
    readyState: 1,
    send: (message: string) => sent.push(message),
  };
  const stream = { destroy: () => destroyed.push('destroyed') };
  (relay as any).connectors.set(
    'org',
    new Map([
      [
        'mac',
        {
          organizationId: 'org',
          deviceId: 'mac',
          socket,
          connectedAt: new Date(),
          streams: new Map([[1, stream]]),
        },
      ],
    ])
  );
  (relay as any).proxyEndpoints.set('org', { port: 31001, server: {} });

  const first = await relay.startLease('org', 'mac', 5);
  const renewed = await relay.startLease('org', 'mac', 10);

  assert.equal(renewed.lease?.id, first.lease?.id);
  assert.equal(destroyed.length, 0);
  assert.equal(sent.length, 2);
  relay.stopLease('org');
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
