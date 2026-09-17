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
  // Without this, Turbopack walks up and finds the backend's
  // package-lock.json in the parent Sonar/ folder and guesses that's the
  // project root instead of frontend/ itself.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
