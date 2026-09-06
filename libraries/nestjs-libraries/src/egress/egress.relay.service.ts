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
  createdAt: Date;
  expiresAt: Date;
  timer: NodeJS.Timeout;
};

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_PROXY_PORT = 18443;

const allowedHost = (host: string) => {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'chineseinla.com' ||
    normalized.endsWith('.chineseinla.com') ||
    normalized === 'api.ipify.org'
  );
};

const validChineseInLALoginDocument = (html: string) =>
  /<input\b[^>]*\bname\s*=\s*["']username["'][^>]*>/i.test(html) &&
  /<input\b[^>]*\bname\s*=\s*["']password["'][^>]*>/i.test(html);

@Injectable()
export class EgressRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(EgressRelayService.name);
  private readonly connectors = new Map<string, Map<string, Connector>>();
  private readonly proxyPort = Number(
    process.env.POSTIZ_EGRESS_PROXY_PORT || DEFAULT_PROXY_PORT
  );
  private proxyServer?: net.Server;
  private activeLease?: Lease;
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

  startLease(
    organizationId: string,
    requestedDeviceId?: string,
    ttlMinutes = 30
  ) {
    this.expireLeaseIfNeeded();
    const devices = this.connectors.get(organizationId);
    const connector = requestedDeviceId
      ? devices?.get(requestedDeviceId)
      : devices?.values().next().value;
    if (!connector || connector.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        'No online local Postiz MCP connector is available for this organization.'
      );
    }
    if (
      this.activeLease &&
      this.activeLease.organizationId !== organizationId
    ) {
      throw new Error(
        'The server egress proxy is currently leased by another organization.'
      );
    }

    const boundedTTL = Math.min(60, Math.max(5, Math.floor(ttlMinutes || 30)));
    if (this.activeLease) this.stopLease(organizationId, 'renewed');
    const expiresAt = new Date(Date.now() + boundedTTL * 60_000);
    const lease: Lease = {
      id: randomUUID(),
      organizationId,
      deviceId: connector.deviceId,
      createdAt: new Date(),
      expiresAt,
      timer: setTimeout(
        () => this.stopLease(organizationId, 'expired'),
        boundedTTL * 60_000
      ),
    };
    this.activeLease = lease;
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
    if (
      !this.activeLease ||
      this.activeLease.organizationId !== organizationId
    ) {
      return this.status(organizationId);
    }
    const lease = this.activeLease;
    clearTimeout(lease.timer);
    this.activeLease = undefined;
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
    this.expireLeaseIfNeeded();
    const devices = [...(this.connectors.get(organizationId)?.values() || [])]
      .filter((connector) => connector.socket.readyState === WebSocket.OPEN)
      .map((connector) => ({
        deviceId: connector.deviceId,
        connectedAt: connector.connectedAt.toISOString(),
      }));
    const lease =
      this.activeLease?.organizationId === organizationId
        ? {
            id: this.activeLease.id,
            deviceId: this.activeLease.deviceId,
            createdAt: this.activeLease.createdAt.toISOString(),
            expiresAt: this.activeLease.expiresAt.toISOString(),
            proxyUrl: `http://127.0.0.1:${this.proxyPort}`,
          }
        : null;
    return { connectorOnline: devices.length > 0, devices, lease };
  }

  async testLease(organizationId: string) {
    if (
      !this.activeLease ||
      this.activeLease.organizationId !== organizationId
    ) {
      throw new Error('Start an egress proxy lease before testing it.');
    }
    const ip = (await this.httpsGetThroughProxy('api.ipify.org', '/')).trim();
    if (!net.isIP(ip))
      throw new Error(
        'The local egress connector returned an invalid public IP.'
      );
    return {
      ok: true,
      egressIp: ip,
      proxyUrl: `http://127.0.0.1:${this.proxyPort}`,
    };
  }

  async ensureChineseInLALease(
    organizationId: string,
    requestedDeviceId?: string,
    ttlMinutes = 10
  ) {
    this.startLease(organizationId, requestedDeviceId, ttlMinutes);
    try {
      const html = await this.httpsGetThroughProxy(
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
    if (this.activeLease) clearTimeout(this.activeLease.timer);
    for (const devices of this.connectors.values()) {
      for (const connector of devices.values())
        connector.socket.close(1001, 'Backend shutting down');
    }
    this.proxyServer?.close();
  }

  private expireLeaseIfNeeded() {
    if (
      this.activeLease &&
      this.activeLease.expiresAt.getTime() <= Date.now()
    ) {
      this.stopLease(this.activeLease.organizationId, 'expired');
    }
  }

  private detachConnector(connector: Connector) {
    for (const stream of connector.streams.values()) stream.destroy();
    connector.streams.clear();
    const devices = this.connectors.get(connector.organizationId);
    if (devices?.get(connector.deviceId) === connector)
      devices.delete(connector.deviceId);
    if (devices?.size === 0) this.connectors.delete(connector.organizationId);
    if (
      this.activeLease?.organizationId === connector.organizationId &&
      this.activeLease.deviceId === connector.deviceId
    ) {
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

  private acceptProxySocket(socket: net.Socket) {
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
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      this.openStream(socket, host, port, header.subarray(boundary + 4));
    };
    socket.on('data', readHeader);
  }

  private openStream(
    socket: net.Socket,
    host: string,
    port: number,
    initialData: Buffer
  ) {
    this.expireLeaseIfNeeded();
    const lease = this.activeLease;
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
    }, 10_000);

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

  private httpsGetThroughProxy(host: string, path: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = net.connect(this.proxyPort, '127.0.0.1');
      let proxyHeader = Buffer.alloc(0);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(15_000, () =>
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

export { allowedHost, validChineseInLALoginDocument };
