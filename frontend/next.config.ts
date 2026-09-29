import type { NextConfig } from "next";
import path from "node:path";

// Where the backend actually lives. Server-side only — it is deliberately
// NOT NEXT_PUBLIC_*, because the browser must never address the API directly
// any more: it talks to this origin and Next forwards.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4001';

const nextConfig: NextConfig = {
  // Proxying the API through the frontend is what makes the session cookie
  // possible. Same origin means the cookie can be SameSite=Lax — the browser
  // simply will not attach it to a request started by another site, which is
  // CSRF closed without a token dance. Addressing the backend directly from
  // the browser would force SameSite=None, reopening exactly that hole.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      // The mock Instagram webhook keeps its own path.
      { source: '/webhooks/:path*', destination: `${API_ORIGIN}/webhooks/:path*` },
    ];
  },
  turbopack: {
    // The repository root, stated rather than guessed. It used to be pinned
    // to frontend/ precisely to stop Turbopack inferring this from the
    // backend's package-lock.json — the problem then was the guessing, and an
    // explicit value settles it either way.
    //
    // It has to reach the parent now because the live caption preview imports
    // the renderer's own chunking and emphasis rules from ../src rather than
    // reimplementing them, and Turbopack will not resolve a module outside
    // its root. tsconfig `paths` alone is not enough — it satisfies the
    // typechecker and never reaches the bundler — and `resolveAlias` matches
    // whole specifiers rather than prefixes, so it cannot stand in either.
    root: path.join(__dirname, '..'),
  },
};

export default nextConfig;
