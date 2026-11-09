const transport = await import('../dist/push/transport.js');

if (typeof transport.createPushTransport !== 'function') {
  throw new TypeError('Push transport did not expose createPushTransport.');
}
