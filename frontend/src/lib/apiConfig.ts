// The real (non-dev-panel) API base — Логика Б's signup/login/billing
// screens are meant to be able to go to production (per the plan: "может
// идти в прод без юрлица"), so unlike useDevConfig's hardcoded localhost
// default, this reads a real env var with the same localhost fallback only
// for local dev.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4001';
