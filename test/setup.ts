import { createRequire } from 'node:module';

// Why some test failed on almost every full run, a different one each time.
//
// supertest starts a server per request with app.listen(0) — the IPv6
// wildcard, dual-stack — and then connects to 127.0.0.1:<port>. On macOS the
// kernel hands out that port checking only IPv6 sockets, so it can be a
// number some other program already holds on 127.0.0.1: VS Code, a language
// server, Postman, anything with a local port. The IPv4 request then reaches
// THAT program instead of the test's app: 401 with a valid key, 403, an empty
// body, "socket hang up". About one request in a thousand; a full run makes
// a couple of thousand.
//
// Connecting over IPv6 loopback instead goes to the socket the kernel just
// reserved for us — the one family it did check.
const require = createRequire(import.meta.url);
const Test = require('supertest/lib/test.js') as {
  prototype: { serverAddress(app: unknown, path: string): string };
};
const serverAddress = Test.prototype.serverAddress;
Test.prototype.serverAddress = function (app, path) {
  return serverAddress.call(this, app, path).replace('://127.0.0.1:', '://[::1]:');
};
