import type { NextConfig } from "next";
import path from "node:path";

// Where the backend actually lives. Server-side only — it is deliberately
// NOT NEXT_PUBLIC_*, because the browser must never address the API directly
// any more: it talks to this origin and Next forwards.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4001';

// Security headers on every page. Without them the app could be framed by
// another site and a signed-in customer tricked into clicking "Отключить" or
// "Опубликовать" through an invisible overlay (clickjacking).
//
// Deliberately not a full Content-Security-Policy: Next inlines its own
// bootstrap scripts, and a script-src without per-request nonces would break
// the site. The directives below restrict only what cannot break it.
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Production only: browsers ignore HSTS over plain http, and pinning
  // localhost to https would break development on that machine for a year.
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
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
