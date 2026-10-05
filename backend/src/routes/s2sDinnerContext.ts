import type { FastifyPluginAsync } from 'fastify';
import type { S2sDinnerContextService } from '../s2s/dinnerContext.js';

export const registerS2sDinnerContextRoutes = (service: S2sDinnerContextService): FastifyPluginAsync => async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'Authorization');
    let deadlineResponseSent = false;
    const sendDeadlineResponse = () => {
      if (deadlineResponseSent || reply.sent || reply.raw.headersSent) return;
      deadlineResponseSent = true;
      reply.header('cache-control', 'no-store').header('vary', 'Authorization').header('connection', 'close');
      reply.raw.once('finish', () => { if (!request.raw.complete) request.raw.destroy(); });
      reply.code(503).send({ code: 'service_unavailable' });
    };
    const disconnectController = new AbortController();
    const abortOnDisconnect = () => {
      if (reply.raw.writableFinished) return;
      disconnectController.abort();
      service.abortRequest(request.raw);
    };
    request.raw.once('aborted', abortOnDisconnect);
    reply.raw.once('close', abortOnDisconnect);
    if (request.raw.destroyed || reply.raw.destroyed) abortOnDisconnect();
    const preflight = await service.beginRequest(request.ip, request.raw, sendDeadlineResponse, disconnectController.signal);
    if (disconnectController.signal.aborted || deadlineResponseSent || reply.sent) {
      service.abortRequest(request.raw);
      return reply;
    }
    if ('result' in preflight) {
      if (preflight.result.retryAfter !== undefined) reply.header('retry-after', String(preflight.result.retryAfter));
      return reply.code(preflight.result.status).send(preflight.result.body);
    }
  });
  app.addHook('onResponse', async (request) => service.finishRequest(request.raw));
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/dinner-context',
    handler: async (request, reply) => {
      if (reply.sent) return reply;
      reply.header('cache-control', 'no-store').header('vary', 'Authorization');
      if (request.method !== 'GET') return reply.code(405).send({ code: 'method_not_allowed' });
      const authorizationFieldCount = request.raw.rawHeaders.reduce((count, value, index) => count + (index % 2 === 0 && value.toLowerCase() === 'authorization' ? 1 : 0), 0);
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const hasSelector = Object.keys(headers).some((name) => ['x-house-id', 'x-user-id', 'x-scope', 'x-account-id'].includes(name.toLowerCase()));
      const hasQuery = Object.keys(request.query as object).length > 0;
      const authorization = headers.authorization;
      const contentLength = headers['content-length'];
      const hasFramedBody = headers['transfer-encoding'] !== undefined
        || contentLength !== undefined && Number(Array.isArray(contentLength) ? contentLength[0] : contentLength) > 0;
      const hasBody = request.body !== undefined || hasFramedBody;
      const result = await service.read(typeof authorization === 'string' ? authorization : undefined, headers.cookie !== undefined, hasSelector, hasQuery, hasBody, request.ip, authorizationFieldCount > 1, service.getRequestBudget(request.raw));
      if (reply.sent) return reply;
      if (result.retryAfter !== undefined) reply.header('retry-after', String(result.retryAfter));
      return reply.code(result.status).send(result.body);
    },
  });
};
