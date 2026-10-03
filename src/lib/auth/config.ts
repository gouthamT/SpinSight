/**
 * Single hard-coded user, checked ONLY on the server (route handler + middleware).
 * Values come from environment variables; the literals below are development
 * fallbacks. Set AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET in Vercel before
 * sharing the URL with anyone.
 */
const DEV_USERNAME = "admin";
const DEV_PASSWORD = "spinsight";
const DEV_SECRET = "dev-only-secret-change-me-dev-only-secret-change-me";

export const SESSION_COOKIE = "spinsight_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export function authConfig() {
  const secret = process.env.AUTH_SECRET || DEV_SECRET;
  if (secret === DEV_SECRET && process.env.NODE_ENV === "production") {
    console.warn("[auth] AUTH_SECRET is not set – using the development secret.");
  }
  return {
    username: process.env.AUTH_USERNAME || DEV_USERNAME,
    password: process.env.AUTH_PASSWORD || DEV_PASSWORD,
    secret: new TextEncoder().encode(secret),
  };
}
