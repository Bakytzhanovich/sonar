// Same-origin by default: requests go to this page's own host and Next
// forwards them to the backend (see next.config.ts rewrites). That is what
// lets the session live in an httpOnly, SameSite=Lax cookie instead of in
// localStorage, where any dependency on the page could read it.
//
// NEXT_PUBLIC_API_BASE_URL still overrides it, for a deployment that has not
// been put behind the proxy yet — but such a deployment cannot use the
// cookie, because the cookie is not sent across origins.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
