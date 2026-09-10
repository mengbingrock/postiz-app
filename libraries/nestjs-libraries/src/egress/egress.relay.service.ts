import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

type Connector = {
  organizationId: string;
  deviceId: string;
  socket: WebSocket;
  connectedAt: Date;
  streams: Map<number, net.Socket>;
};

type Lease = {
  id: string;
  organizationId: string;
  deviceId: string;
  proxyPort: number;
  createdAt: Date;
  expiresAt: Date;
  timer: NodeJS.Timeout;
  // When the RedNote probe last succeeded on this lease; a fresh probe is
  // skipped for a while so back-to-back operations do not re-probe through a
  // connector that is already saturated by a headless browser.
  probedAt?: Date;
};

const REDNOTE_PROBE_TTL_MS = 5 * 60_000;
// Home uplinks are slow (~3 Mbps measured) and a busy browser can queue a new
// CONNECT behind megabytes of assets, so give stream setup and the probe
// generous budgets.
const STREAM_OPEN_TIMEOUT_MS = 30_000;
const PROBE_SOCKET_TIMEOUT_MS = 45_000;

type ProxyEndpoint = {
  port: number;
  server: net.Server;
};

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_PROXY_PORT = 18443;

// Xiaohongshu / RedNote properties the headless browser talks to: the web
// and creator SPAs, their API hosts (edith/ark/ros-upload…) and the xhscdn
// image/video CDN. Keep in sync with the Python connector's allowlist.
const REDNOTE_HOST_SUFFIXES = [
  'xiaohongshu.com',
  'xhscdn.com',
  'rednotecdn.com', // static/avatar/image CDN used by the overseas edge
  'rednote.com',
  'rnote.com', // INTL API/telemetry hosts (t2., apm-fe.)
  'rednote.life', // INTL risk-control (redtrust) endpoints
  'xhslink.com',
  'xhs.cn',
];

const hostMatchesSuffix = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

const allowedHost = (host: string) => {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    hostMatchesSuffix(normalized, 'chineseinla.com') ||
    normalized === 'c3.nychinaren.com' ||
    normalized === 'api.ipify.org' ||
    REDNOTE_HOST_SUFFIXES.some((suffix) =>
      hostMatchesSuffix(normalized, suffix)
    )
  );
};

const validChineseInLALoginDocument = (html: string) =>
  /<input\b[^>]*\bname\s*=\s*["']username["'][^>]*>/i.test(html) &&
  /<input\b[^>]*\bname\s*=\s*["']password["'][^>]*>/i.test(html);

// robots.txt is ~500 bytes; the SPA pages exceed the probe's 64 KB cap.
const validRedNoteDocument = (body: string) =>
  /user-agent|xiaohongshu|rednote/i.test(body);

const chineseInLAProxyConfigured = (
  value = process.env.CHINESEINLA_PROXY
) => Boolean(value?.trim());

const redNoteProxyConfigured = (value = process.env.REDNOTE_PROXY) =>
  Boolean(value?.trim());

// Optional pin so publishes (which carry no device choice) never fall through
// to whichever connector happens to be first when several are online.
const redNoteProxyDevice = (value = process.env.REDNOTE_PROXY_DEVICE) =>
  value?.trim() || undefined;

@Injectable()
export class EgressRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(EgressRelayService.name);
  private readonly connectors = new Map<string, Map<string, Connector>>();
  private readonly proxyPort = Number(
    process.env.POSTIZ_EGRESS_PROXY_PORT || DEFAULT_PROXY_PORT
  );
  private proxyServer?: net.Server;
  private readonly proxyEndpoints = new Map<string, ProxyEndpoint>();
  private readonly startingProxyEndpoints = new Map<
    string,
    Promise<ProxyEndpoint>
  >();
  private readonly activeLeases = new Map<string, Lease>();
  private nextStreamId = 1;

  startProxyServer() {
    if (this.proxyServer) return;
    if (
      !Number.isInteger(this.proxyPort) ||
      this.proxyPort < 1024 ||
      this.proxyPort > 65535
    ) {
      throw new Error(
        'POSTIZ_EGRESS_PROXY_PORT must be between 1024 and 65535.'
      );
    }

    // Keep the configured port as a compatibility endpoint during rollout.
    // Tenant-aware browsers receive a dedicated loopback port from startLease.
    // The compatibility endpoint is usable only when exactly one lease exists.
    this.proxyServer = net.createServer((socket) =>
      this.acceptProxySocket(socket)
    );
    this.proxyServer.on('error', (error) =>
      this.logger.error(`Local egress proxy failed: ${error.message}`)
    );
    this.proxyServer.listen(this.proxyPort, '127.0.0.1', () =>
      this.logger.log(
        `Local egress proxy listening on 127.0.0.1:${this.proxyPort}`
      )
    );
  }

  attachConnector(organizationId: string, deviceId: string, socket: WebSocket) {
    const devices =
      this.connectors.get(organizationId) || new Map<string, Connector>();
    const previous = devices.get(deviceId);
    if (previous && previous.socket !== socket)
      previous.socket.close(4001, 'Replaced by a newer connection');

    const connector: Connector = {
      organizationId,
      deviceId,
      socket,
      connectedAt: new Date(),
      streams: new Map(),
    };
    devices.set(deviceId, connector);
    this.connectors.set(organizationId, devices);

    socket.on('message', (data: WebSocket.Data, isBinary: boolean) =>
      this.connectorMessage(connector, data, isBinary)
    );
    socket.on('close', () => this.detachConnector(connector));
    socket.on('error', (error) =>
      this.logger.warn(`Egress connector ${deviceId}: ${error.message}`)
    );
    socket.send(
      JSON.stringify({
        type: 'hello',
        status: 'connected',
        proxyPort: this.proxyPort,
      })
    );
    this.logger.log(`Egress connector online: ${organizationId}/${deviceId}`);
  }

  async startLease(
    organizationId: string,
    requestedDeviceId?: string,
    ttlMinutes = 30
  ) {
    this.expireLeaseIfNeeded(organizationId);
    const devices = this.connectors.get(organizationId);
    const currentLease = this.activeLeases.get(organizationId);
    const connector = requestedDeviceId
      ? devices?.get(requestedDeviceId)
      : currentLease
      ? devices?.get(currentLease.deviceId)
      : devices?.values().next().value;
    if (!connector || connector.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        'No online local Postiz MCP connector is available for this organization.'
      );
    }
    const boundedTTL = Math.min(60, Math.max(5, Math.floor(ttlMinutes || 30)));
    const expiresAt = new Date(Date.now() + boundedTTL * 60_000);
    if (currentLease?.deviceId === connector.deviceId) {
      clearTimeout(currentLease.timer);
      currentLease.expiresAt = expiresAt;
      currentLease.timer = setTimeout(
        () => this.stopLease(organizationId, 'expired'),
        boundedTTL * 60_000
      );
      connector.socket.send(
        JSON.stringify({
          type: 'lease_start',
          leaseId: currentLease.id,
          expiresAt: expiresAt.toISOString(),
        })
      );
      return this.status(organizationId);
    }
    if (currentLease)
      this.stopLease(organizationId, 'renewed');
    const endpoint = await this.ensureProxyEndpoint(organizationId);
    const lease: Lease = {
      id: randomUUID(),
      organizationId,
      deviceId: connector.deviceId,
      proxyPort: endpoint.port,
      createdAt: new Date(),
      expiresAt,
      timer: setTimeout(
        () => this.stopLease(organizationId, 'expired'),
        boundedTTL * 60_000
      ),
    };
    this.activeLeases.set(organizationId, lease);
    connector.socket.send(
      JSON.stringify({
        type: 'lease_start',
        leaseId: lease.id,
        expiresAt: expiresAt.toISOString(),
      })
    );
    return this.status(organizationId);
  }

  stopLease(organizationId: string, reason = 'stopped') {
    const lease = this.activeLeases.get(organizationId);
    if (!lease) {
      return this.status(organizationId);
    }
    clearTimeout(lease.timer);
    this.activeLeases.delete(organizationId);
    const connector = this.connectors.get(organizationId)?.get(lease.deviceId);
    if (connector?.socket.readyState === WebSocket.OPEN) {
      connector.socket.send(
        JSON.stringify({ type: 'lease_stop', leaseId: lease.id, reason })
      );
      for (const stream of connector.streams.values()) stream.destroy();
      connector.streams.clear();
    }
    return this.status(organizationId);
  }

  status(organizationId: string) {
    this.expireLeaseIfNeeded(organizationId);
    const devices = [...(this.connectors.get(organizationId)?.values() || [])]
      .filter((connector) => connector.socket.readyState === WebSocket.OPEN)
      .map((connector) => ({
        deviceId: connector.deviceId,
        connectedAt: connector.connectedAt.toISOString(),
      }));
    const activeLease = this.activeLeases.get(organizationId);
    const lease = activeLease
      ? {
          id: activeLease.id,
          deviceId: activeLease.deviceId,
          createdAt: activeLease.createdAt.toISOString(),
          expiresAt: activeLease.expiresAt.toISOString(),
          proxyUrl: `http://127.0.0.1:${activeLease.proxyPort}`,
        }
      : null;
    return { connectorOnline: devices.length > 0, devices, lease };
  }

  async testLease(organizationId: string) {
    const lease = this.activeLeases.get(organizationId);
    if (!lease) {
      throw new Error('Start an egress proxy lease before testing it.');
    }
    const ip = (
      await this.httpsGetThroughProxy(
        organizationId,
        'api.ipify.org',
        '/'
      )
    ).trim();
    if (!net.isIP(ip))
      throw new Error(
        'The local egress connector returned an invalid public IP.'
      );
    return {
      ok: true,
      egressIp: ip,
      proxyUrl: `http://127.0.0.1:${lease.proxyPort}`,
    };
  }

  async ensureChineseInLALease(
    organizationId: string,
    requestedDeviceId?: string,
    ttlMinutes = 10
  ) {
    await this.startLease(organizationId, requestedDeviceId, ttlMinutes);
    try {
      const html = await this.httpsGetThroughProxy(
        organizationId,
        'www.chineseinla.com',
        '/f/page_login.html'
      );
      if (!validChineseInLALoginDocument(html)) {
        throw new Error(
          'ChineseInLA returned a page without its expected login form.'
        );
      }
      return { ok: true, ...this.status(organizationId) };
    } catch (error) {
      this.stopLease(organizationId, 'chineseinla_probe_failed');
      const reason =
        error instanceof Error ? error.message : 'Unknown proxy failure.';
      throw new Error(
        `The local egress connector could not reach the ChineseInLA login page. ${reason}`
      );
    }
  }

  async ensureRedNoteLease(
    organizationId: string,
    requestedDeviceId?: string,
    ttlMinutes = 10
  ) {
    await this.startLease(
      organizationId,
      requestedDeviceId || redNoteProxyDevice(),
      ttlMinutes
    );
    const lease = this.activeLeases.get(organizationId);
    if (
      lease?.probedAt &&
      Date.now() - lease.probedAt.getTime() < REDNOTE_PROBE_TTL_MS
    ) {
      return { ok: true, ...this.status(organizationId) };
    }
    try {
      const body = await this.httpsGetThroughProxy(
        organizationId,
        'www.xiaohongshu.com',
        '/robots.txt'
      );
      if (!validRedNoteDocument(body)) {
        throw new Error(
          'Xiaohongshu returned an unexpected page through the local route.'
        );
      }
      if (lease) lease.probedAt = new Date();
      return { ok: true, ...this.status(organizationId) };
    } catch (error) {
      this.stopLease(organizationId, 'rednote_probe_failed');
      const reason =
        error instanceof Error ? error.message : 'Unknown proxy failure.';
      throw new Error(
        `The local egress connector could not reach Xiaohongshu. ${reason}`
      );
    }
  }

  async withChineseInLALease<T>(
    organizationId: string,
    operation: () => Promise<T>,
    requestedDeviceId?: string,
    ttlMinutes = 10
  ) {
    await this.ensureChineseInLALease(
      organizationId,
      requestedDeviceId,
      ttlMinutes
    );
    try {
      return await operation();
    } finally {
      this.stopLease(organizationId, 'chineseinla_operation_finished');
    }
  }

  onModuleDestroy() {
    for (const lease of this.activeLeases.values()) clearTimeout(lease.timer);
    for (const devices of this.connectors.values()) {
      for (const connector of devices.values())
        connector.socket.close(1001, 'Backend shutting down');
    }
    this.proxyServer?.close();
    for (const endpoint of this.proxyEndpoints.values()) endpoint.server.close();
  }

  private expireLeaseIfNeeded(organizationId?: string) {
    const leases = organizationId
      ? [this.activeLeases.get(organizationId)].filter(
          (lease): lease is Lease => Boolean(lease)
        )
      : [...this.activeLeases.values()];
    for (const lease of leases) {
      if (lease.expiresAt.getTime() <= Date.now()) {
        this.stopLease(lease.organizationId, 'expired');
      }
    }
  }

  private detachConnector(connector: Connector) {
    for (const stream of connector.streams.values()) stream.destroy();
    connector.streams.clear();
    const devices = this.connectors.get(connector.organizationId);
    if (devices?.get(connector.deviceId) === connector)
      devices.delete(connector.deviceId);
    if (devices?.size === 0) this.connectors.delete(connector.organizationId);
    const lease = this.activeLeases.get(connector.organizationId);
    if (lease?.deviceId === connector.deviceId) {
      this.stopLease(connector.organizationId, 'connector_disconnected');
    }
    this.logger.log(
      `Egress connector offline: ${connector.organizationId}/${connector.deviceId}`
    );
  }

  private connectorMessage(
    connector: Connector,
    data: WebSocket.Data,
    isBinary: boolean
  ) {
    if (isBinary) {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (frame.length < 4 || frame.length > MAX_FRAME_BYTES + 4) return;
      const streamId = frame.readUInt32BE(0);
      connector.streams.get(streamId)?.write(frame.subarray(4));
      return;
    }

    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const streamId = Number(message.streamId);
    const stream = connector.streams.get(streamId);
    if (message.type === 'opened' && stream) {
      stream.emit('postiz-egress-opened');
    } else if (
      (message.type === 'error' || message.type === 'close') &&
      stream
    ) {
      if (message.type === 'error')
        stream.emit(
          'postiz-egress-error',
          String(message.message || 'Local connector failed')
        );
      else stream.destroy();
    }
  }

  private async ensureProxyEndpoint(organizationId: string) {
    const existing = this.proxyEndpoints.get(organizationId);
    if (existing) return existing;
    const pending = this.startingProxyEndpoints.get(organizationId);
    if (pending) return pending;

    const starting = new Promise<ProxyEndpoint>((resolve, reject) => {
      const server = net.createServer((socket) =>
        this.acceptProxySocket(socket, organizationId)
      );
      const fail = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        server.on('error', (error) =>
          this.logger.error(
            `Organization egress proxy ${organizationId} failed: ${error.message}`
          )
        );
        const address = server.address();
        if (!address || typeof address === 'string') {
          fail(new Error('Unable to allocate an organization proxy port.'));
          return;
        }
        const endpoint = { port: address.port, server };
        this.proxyEndpoints.set(organizationId, endpoint);
        this.logger.log(
          `Organization egress proxy ready: ${organizationId} on 127.0.0.1:${endpoint.port}`
        );
        resolve(endpoint);
      });
    });
    this.startingProxyEndpoints.set(organizationId, starting);
    try {
      return await starting;
    } finally {
      if (this.startingProxyEndpoints.get(organizationId) === starting) {
        this.startingProxyEndpoints.delete(organizationId);
      }
    }
  }

  private acceptProxySocket(socket: net.Socket, organizationId?: string) {
    socket.setTimeout(20_000, () => socket.destroy());
    let header = Buffer.alloc(0);
    const readHeader = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_HEADER_BYTES) {
        socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
        return;
      }
      const boundary = header.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.off('data', readHeader);
      const firstLine =
        header.subarray(0, boundary).toString('ascii').split('\r\n')[0] || '';
      const match = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]$/i.exec(firstLine);
      if (!match) {
        socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
        return;
      }
      const host = match[1];
      const port = Number(match[2]);
      if (!allowedHost(host) || port !== 443) {
        // Logged so a missing first-party host shows up in the backend log
        // instead of as a silent broken page in the browser.
        this.logger.warn(`Egress proxy refused ${host}:${port}`);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      this.openStream(
        socket,
        organizationId,
        host,
        port,
        header.subarray(boundary + 4)
      );
    };
    socket.on('data', readHeader);
  }

  private openStream(
    socket: net.Socket,
    organizationId: string | undefined,
    host: string,
    port: number,
    initialData: Buffer
  ) {
    this.expireLeaseIfNeeded(organizationId);
    // The fixed legacy endpoint cannot safely select between tenants. It is
    // retained only for one-lease rolling upgrades; all newly configured
    // ChineseInLA browsers use an organization-specific endpoint.
    const lease = organizationId
      ? this.activeLeases.get(organizationId)
      : this.activeLeases.size === 1
      ? this.activeLeases.values().next().value
      : undefined;
    const connector = lease
      ? this.connectors.get(lease.organizationId)?.get(lease.deviceId)
      : undefined;
    if (
      !lease ||
      !connector ||
      connector.socket.readyState !== WebSocket.OPEN
    ) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }

    const streamId = this.nextStreamId++ >>> 0 || this.nextStreamId++ >>> 0;
    connector.streams.set(streamId, socket);
    const cleanup = () => {
      if (
        connector.streams.delete(streamId) &&
        connector.socket.readyState === WebSocket.OPEN
      ) {
        connector.socket.send(JSON.stringify({ type: 'close', streamId }));
      }
    };
    socket.once('close', cleanup);
    socket.once('error', cleanup);

    const timeout = setTimeout(() => {
      if (
        connector.streams.delete(streamId) &&
        connector.socket.readyState === WebSocket.OPEN
      ) {
        connector.socket.send(JSON.stringify({ type: 'close', streamId }));
      }
      socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
    }, STREAM_OPEN_TIMEOUT_MS);

    socket.once('postiz-egress-error', (message: string) => {
      clearTimeout(timeout);
      connector.streams.delete(streamId);
      socket.end(
        `HTTP/1.1 502 Bad Gateway\r\nX-Postiz-Egress-Error: ${message.replace(
          /[\r\n]/g,
          ' '
        )}\r\n\r\n`
      );
    });
    socket.once('postiz-egress-opened', () => {
      clearTimeout(timeout);
      socket.setTimeout(0);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const relay = (chunk: Buffer) => {
        if (
          chunk.length > MAX_FRAME_BYTES ||
          connector.socket.readyState !== WebSocket.OPEN
        ) {
          socket.destroy();
          return;
        }
        const frame = Buffer.allocUnsafe(chunk.length + 4);
        frame.writeUInt32BE(streamId, 0);
        chunk.copy(frame, 4);
        connector.socket.send(frame, { binary: true });
      };
      socket.on('data', relay);
      if (initialData.length) relay(initialData);
    });
    connector.socket.send(
      JSON.stringify({ type: 'open', streamId, host, port })
    );
  }

  private httpsGetThroughProxy(
    organizationId: string,
    host: string,
    path: string
  ) {
    return new Promise<string>((resolve, reject) => {
      const endpoint = this.proxyEndpoints.get(organizationId);
      if (!endpoint) {
        reject(new Error('Organization egress proxy is not initialized.'));
        return;
      }
      const socket = net.connect(endpoint.port, '127.0.0.1');
      let proxyHeader = Buffer.alloc(0);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(PROBE_SOCKET_TIMEOUT_MS, () =>
        fail(new Error('Egress test timed out.'))
      );
      socket.once('error', fail);
      socket.once('connect', () =>
        socket.write(
          `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`
        )
      );
      const readProxyHeader = (chunk: Buffer) => {
        proxyHeader = Buffer.concat([proxyHeader, chunk]);
        const boundary = proxyHeader.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        socket.off('data', readProxyHeader);
        if (
          !/^HTTP\/1\.[01] 200 /i.test(
            proxyHeader.toString('ascii', 0, boundary)
          )
        ) {
          fail(
            new Error(
              'The local egress connector could not establish a proxy stream.'
            )
          );
          return;
        }
        const remaining = proxyHeader.subarray(boundary + 4);
        if (remaining.length) socket.unshift(remaining);
        const secure = tls.connect({ socket, servername: host });
        let response = Buffer.alloc(0);
        secure.once('secureConnect', () =>
          secure.write(
            `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
          )
        );
        secure.on('data', (data) => {
          response = Buffer.concat([response, data]);
          if (response.length > 64 * 1024)
            secure.destroy(new Error('Egress test response was too large.'));
        });
        secure.once('error', reject);
        secure.once('end', () => {
          const boundary = response.indexOf('\r\n\r\n');
          if (
            boundary < 0 ||
            !/^HTTP\/1\.[01] 200 /i.test(
              response.toString('ascii', 0, boundary)
            )
          ) {
            reject(
              new Error('Egress test endpoint returned an invalid response.')
            );
            return;
          }
          resolve(response.subarray(boundary + 4).toString('utf8'));
        });
      };
      socket.on('data', readProxyHeader);
    });
  }
}

export {
  allowedHost,
  chineseInLAProxyConfigured,
  redNoteProxyConfigured,
  redNoteProxyDevice,
  validChineseInLALoginDocument,
  validRedNoteDocument,
};
