import { createHash, timingSafeEqual } from "node:crypto";

const AUTH_SCHEMA = "project-agent.auth-boundary.v1";
const DEFAULT_BIND_HOST = "127.0.0.1";
const MIN_TOKEN_LENGTH = 16;

function truthy(value) {
  return ["1", "true", "yes", "on", "remote"].includes(String(value || "").trim().toLowerCase());
}

function cleanBindHost(value) {
  const clean = String(value || "").trim();
  return clean || DEFAULT_BIND_HOST;
}

function isLocalBindHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(cleanBindHost(host));
}

function tokenFingerprint(token) {
  if (!token) return null;
  return `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

function timingSafeMatches(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function statusFromChecks(checks) {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "watch")) return "watch";
  return "ok";
}

function check(id, status, label, detail) {
  return { id, status, label, detail };
}

export function resolveAuthBoundary({ env = process.env } = {}) {
  const requestedBindHost = cleanBindHost(env.PROJECT_AGENT_BIND_HOST || env.BIND_HOST || DEFAULT_BIND_HOST);
  const remoteOptIn = truthy(env.PROJECT_AGENT_REMOTE || env.PROJECT_AGENT_ALLOW_REMOTE);
  const token = String(env.PROJECT_AGENT_AUTH_TOKEN || env.PROJECT_AGENT_TOKEN || "").trim();
  const tokenConfigured = token.length >= MIN_TOKEN_LENGTH;
  const weakToken = Boolean(token && !tokenConfigured);
  const requestedNonLocal = !isLocalBindHost(requestedBindHost);
  const canEnableRemote = requestedNonLocal && remoteOptIn && tokenConfigured;
  const effectiveBindHost = canEnableRemote ? requestedBindHost : DEFAULT_BIND_HOST;
  const authRequired = canEnableRemote;
  const checks = [
    check(
      "bind_request",
      requestedNonLocal ? "watch" : "ok",
      "Bind request",
      requestedNonLocal ? `Requested non-local bind host ${requestedBindHost}.` : `Requested local bind host ${requestedBindHost}.`
    ),
    check(
      "remote_opt_in",
      requestedNonLocal && !remoteOptIn ? "blocked" : "ok",
      "Remote opt-in",
      requestedNonLocal ? (remoteOptIn ? "Remote/shared mode was explicitly enabled." : "Non-local bind is ignored until PROJECT_AGENT_REMOTE=1 is set.") : "Remote/shared mode is not requested."
    ),
    check(
      "auth_token",
      requestedNonLocal && !tokenConfigured ? "blocked" : weakToken ? "blocked" : tokenConfigured ? "ok" : "ok",
      "Auth token",
      requestedNonLocal
        ? tokenConfigured
          ? "A bearer token is configured for non-local access."
          : `PROJECT_AGENT_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters for non-local access.`
        : tokenConfigured
          ? "Token is configured but not required while bound locally."
          : "No token is required for local-only access."
    ),
    check(
      "effective_bind",
      canEnableRemote || !requestedNonLocal ? "ok" : "blocked",
      "Effective bind",
      canEnableRemote
        ? `Server may bind to ${requestedBindHost} with bearer-token auth.`
        : requestedNonLocal
          ? `Server will stay on ${DEFAULT_BIND_HOST} until remote opt-in and auth are ready.`
          : `Server will bind to ${DEFAULT_BIND_HOST}.`
    )
  ];
  const status = statusFromChecks(checks);
  const result = {
    schemaVersion: AUTH_SCHEMA,
    status,
    requested: {
      bindHost: requestedBindHost,
      nonLocal: requestedNonLocal,
      remoteOptIn,
      tokenConfigured,
      tokenFingerprint: tokenFingerprint(token),
      tokenMinLength: MIN_TOKEN_LENGTH
    },
    effective: {
      bindHost: effectiveBindHost,
      localOnly: isLocalBindHost(effectiveBindHost),
      boundary: isLocalBindHost(effectiveBindHost) ? "local_only" : "non_local",
      remoteAccess: authRequired ? "enabled_with_bearer_token" : requestedNonLocal ? "blocked_by_auth_guard" : "disabled_by_bind_host"
    },
    auth: {
      required: authRequired,
      enabled: authRequired,
      mode: authRequired ? "bearer_token" : requestedNonLocal ? "required_missing" : "not_enabled",
      acceptedHeaders: authRequired ? ["Authorization: Bearer <token>", "X-Project-Agent-Token"] : [],
      acceptedQuery: authRequired ? ["authToken"] : [],
      valuesExposed: false
    },
    checks,
    summary: {
      ok: checks.filter((item) => item.status === "ok").length,
      watch: checks.filter((item) => item.status === "watch").length,
      blocked: checks.filter((item) => item.status === "blocked").length,
      total: checks.length
    },
    nextAction: status === "blocked"
      ? "Keep local-only bind until PROJECT_AGENT_REMOTE=1 and PROJECT_AGENT_AUTH_TOKEN are configured."
      : authRequired
        ? "Send a bearer token with HTTP requests and WebSocket connections."
        : "Local-only access is active; no auth token is required."
  };
  Object.defineProperty(result, "token", {
    value: token,
    enumerable: false
  });
  return result;
}

export function publicAuthBoundary(boundary) {
  if (!boundary) return resolveAuthBoundary();
  return JSON.parse(JSON.stringify(boundary));
}

export function extractAuthToken(req) {
  const authorization = req.headers?.authorization || "";
  const bearer = String(authorization).match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const headerToken = req.headers?.["x-project-agent-token"];
  if (headerToken) return String(Array.isArray(headerToken) ? headerToken[0] : headerToken).trim();
  const url = new URL(req.url || "/", "http://127.0.0.1");
  return String(url.searchParams.get("authToken") || "").trim();
}

export function validateAuthRequest(req, boundary) {
  if (!boundary?.auth?.required) return { ok: true, required: false };
  const token = extractAuthToken(req);
  const ok = timingSafeMatches(token, boundary.token);
  return {
    ok,
    required: true,
    status: ok ? "ok" : "unauthorized"
  };
}
