import { createRequire } from 'node:module';
import type { Server } from 'node:http';

// Why some test failed on most full runs, a different one each time, with
// "socket hang up", a 401 for a valid key, or an empty body.
//
// supertest starts a server per request with app.listen(0) — the wildcard
// address — and connects to 127.0.0.1:<port>. A wildcard bind can be handed a
// port number that another process on this machine holds on a SPECIFIC
// address (VS Code, a language server, the Next dev server's workers), and a
// connection to that address then reaches the other process, not the test's
// app. Connecting over IPv6 instead only narrowed it.
//
// The fix is to bind exactly the address the request goes to: the kernel will
// not hand out a port already bound there. Binding a host is asynchronous,
// though, and supertest asks for the port synchronously — so the server is
// started here, and the request waits for it to be listening before it is
// sent, with its real port.
const require = createRequire(import.meta.url);
interface TestLike {
  _server?: Server;
  _listening?: Promise<void>;
  _path?: string;
  url: string;
}
const Test = require('supertest/lib/test.js') as {
  prototype: TestLike & {
    serverAddress(app: Server, path: string): string;
    end(fn?: unknown): unknown;
  };
};

Test.prototype.serverAddress = function (this: TestLike, app: Server, path: string) {
  const bound = app.address();
  if (bound && typeof bound === 'object') return `http://127.0.0.1:${bound.port}${path}`;
  this._server = app;
  this._path = path;
  this._listening = new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', () => resolve());
  });
  // Replaced in end(), once the port is known.
  return `http://127.0.0.1:0${path}`;
};

const end = Test.prototype.end;
Test.prototype.end = function (this: TestLike, fn?: unknown) {
  if (!this._listening) return end.call(this, fn);
  const listening = this._listening;
  this._listening = undefined;
  listening.then(
    () => {
      const address = this._server!.address();
      if (address && typeof address === 'object') this.url = `http://127.0.0.1:${address.port}${this._path}`;
      end.call(this, fn);
    },
    (err: unknown) => {
      if (typeof fn === 'function') (fn as (e: unknown) => void)(err);
    }
  );
  return this;
};
