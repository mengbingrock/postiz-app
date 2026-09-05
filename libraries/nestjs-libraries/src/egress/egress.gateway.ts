import { INestApplication, Logger } from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { EgressRelayService } from './egress.relay.service';

const rejectUpgrade = (socket: any, status: number, message: string) => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export const startEgressGateway = async (
  app: INestApplication,
  resolveAuth: (token: string) => Promise<any>,
  relay: EgressRelayService
) => {
  const logger = new Logger('EgressGateway');
  const httpServer = app.getHttpServer();
  const webSockets = new WebSocket.Server({
    noServer: true,
    maxPayload: 1024 * 1024 + 4,
  });

  httpServer.on(
    'upgrade',
    async (request: IncomingMessage, socket: any, head: Buffer) => {
      try {
        const path = new URL(request.url || '/', 'http://localhost').pathname;
        if (path !== '/egress/connect' && path !== '/api/egress/connect')
          return;

        const authorization = request.headers.authorization || '';
        const token = authorization.replace(/^Bearer\s+/i, '').trim();
        if (!token) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const organization = await resolveAuth(token).catch(() => null);
        if (!organization?.id) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const deviceId = String(
          request.headers['x-postiz-device-id'] || ''
        ).trim();
        if (!/^[A-Za-z0-9._-]{6,128}$/.test(deviceId)) {
          rejectUpgrade(socket, 400, 'Invalid Device ID');
          return;
        }

        webSockets.handleUpgrade(request, socket, head, (webSocket) =>
          relay.attachConnector(organization.id, deviceId, webSocket)
        );
      } catch (error) {
        logger.warn(
          `Egress connector upgrade failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
        if (!socket.destroyed)
          rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    }
  );

  relay.startProxyServer();
  logger.log('Egress connector gateway available at /egress/connect');
};
