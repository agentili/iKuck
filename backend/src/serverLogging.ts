import type { FastifyLoggerOptions, FastifyRequest } from 'fastify';

export const serializeRequestWithoutQuery = (request: FastifyRequest) => {
  const route = request.routeOptions.url;
  const isS2sRoute = route === '/v1/s2s' || route?.startsWith('/v1/s2s/') === true;
  return {
    method: request.method,
    url: route === undefined || route === '*' ? '[unmatched]' : route,
    ...(isS2sRoute ? {} : {
      remoteAddress: request.ip,
      remotePort: request.raw.socket.remotePort,
    }),
  };
};

export const shouldDisableRequestLogging = (request: FastifyRequest) => {
  const route = request.routeOptions.url;
  return route === undefined || route === '*';
};

export const createServerLoggerOptions = (level: string, stream?: FastifyLoggerOptions['stream']) => ({
  level,
  redact: ['req.headers.cookie', 'req.headers.authorization'],
  serializers: { req: serializeRequestWithoutQuery },
  ...(stream === undefined ? {} : { stream }),
});
