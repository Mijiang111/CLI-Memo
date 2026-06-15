import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SANDBOX_SCHEMA = "project-agent.sandbox-guidance.v1";
const SENSITIVE_ENV_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|COOKIE|AUTH|PRIVATE)(_|$)|^(OPENAI|ANTHROPIC|GITHUB|GH|AWS|AZURE|GOOGLE|NPM)_.*(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH|PRIVATE)$/i;
const DANGEROUS_SCRIPT_PATTERN = /\b(rm\s+-rf|sudo|chmod\s+-R|chown\s+-R|curl\b[^|]*\|\s*(sh|bash)|wget\b[^|]*\|\s*(sh|bash)|dd\s+if=|mkfs|diskutil|killall|pkill)\b/i;
const SERVER_SCRIPT_PATTERN = /\b(vite|server\/index\.js|vite preview|express|concurrently)\b/i;
const AGENT_SCRIPT_PATTERN = /\b(project-mcp|agent-|mcp|takeover|context|manifest|event-cli|session-log)\b/i;

function nowIso() {
  return new Date().toISOString();
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function fileHealth(absPath) {
  const stats = safeCall(() => statSync(absPath), null);
  return {
    path: absPath,
    exists: Boolean(stats),
    type: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : "missing",
    readable: Boolean(stats)
  };
}

function readPackageJson(appRoot) {
  const packagePath = path.join(appRoot, "package.json");
  if (!existsSync(packagePath)) {
    return { path: packagePath, scripts: {}, status: "missing" };
  }
  const parsed = safeCall(() => JSON.parse(readFileSync(packagePath, "utf8")), null);
  if (!parsed) return { path: packagePath, scripts: {}, status: "invalid" };
  return { path: packagePath, scripts: parsed.scripts || {}, status: "ok" };
}

function classifyScript(name, command) {
  const text = `${name} ${command || ""}`;
  const flags = [];
  if (DANGEROUS_SCRIPT_PATTERN.test(text)) flags.push("dangerous_shell_pattern");
  if (SERVER_SCRIPT_PATTERN.test(text)) flags.push("starts_local_process");
  if (AGENT_SCRIPT_PATTERN.test(text)) flags.push("agent_state_tooling");
  const status = flags.includes("dangerous_shell_pattern") ? "blocked" : flags.length ? "watch" : "ok";
  return {
    name,
    command,
    status,
    flags,
    permission: flags.includes("starts_local_process")
      ? "process_spawn"
      : flags.includes("agent_state_tooling")
        ? "state_tooling"
        : "local_script"
  };
}

function summarizeScripts(appRoot) {
  const packageJson = readPackageJson(appRoot);
  const entries = Object.entries(packageJson.scripts || {}).map(([name, command]) => classifyScript(name, command));
  return {
    path: path.relative(appRoot, packageJson.path).split(path.sep).join("/"),
    status: packageJson.status,
    count: entries.length,
    watch: entries.filter((item) => item.status === "watch").length,
    blocked: entries.filter((item) => item.status === "blocked").length,
    entries: entries.slice(0, 24)
  };
}

function summarizeSensitiveEnv(env = process.env) {
  const names = Object.keys(env || {})
    .filter((name) => SENSITIVE_ENV_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    count: names.length,
    names: names.slice(0, 12),
    omitted: Math.max(0, names.length - 12),
    valuesExposed: false,
    policy: "names_only"
  };
}

function check(id, status, label, detail, refs = []) {
  return { id, status, label, detail, refs };
}

function statusFromChecks(checks) {
  if (checks.some((item) => item.status === "blocked")) return "blocked";
  if (checks.some((item) => item.status === "watch")) return "watch";
  return "ok";
}

export function buildSandboxGuidance({
  appRoot,
  projectDir,
  bindHost = "127.0.0.1",
  apiPort = 4147,
  uiPort = 5174,
  env = process.env,
  authBoundary = null
} = {}) {
  const absAppRoot = path.resolve(appRoot || ".");
  const absProjectDir = path.resolve(projectDir || absAppRoot);
  const stateDir = path.join(absProjectDir, ".project-agent");
  const localOnly = authBoundary ? Boolean(authBoundary.effective?.localOnly) : bindHost === "127.0.0.1" || bindHost === "localhost";
  const authMode = authBoundary?.auth?.mode || "not_enabled";
  const remoteAccess = authBoundary?.effective?.remoteAccess || (localOnly ? "disabled_by_bind_host" : "requires_auth_before_use");
  const effectiveBindHost = authBoundary?.effective?.bindHost || bindHost;
  const scripts = summarizeScripts(absAppRoot);
  const sensitiveEnv = summarizeSensitiveEnv(env);
  const checks = [
    check(
      "local_api_bind",
      localOnly || authBoundary?.auth?.enabled ? "ok" : "blocked",
      "Local API bind",
      localOnly ? `API/UI remain on ${effectiveBindHost}.` : `Non-local bind host ${effectiveBindHost} requires auth.`,
      ["/api/health", "vite.config.js"]
    ),
    check(
      "auth_scope",
      authBoundary?.status === "blocked" ? "blocked" : "ok",
      "Auth scope",
      authBoundary?.auth?.enabled
        ? "Bearer-token auth is enabled for intentional non-local access."
        : localOnly
          ? "Auth is intentionally not enabled for trusted local-only use."
          : "Non-local access requires explicit auth before use.",
      ["/api/health"]
    ),
    ...(authBoundary
      ? [
          check(
            "auth_readiness",
            authBoundary.status === "blocked" ? "blocked" : authBoundary.auth?.enabled ? "watch" : "ok",
            "Auth readiness",
            authBoundary.nextAction,
            ["/api/security/auth"]
          )
        ]
      : []),
    check(
      "project_boundary",
      existsSync(absProjectDir) ? "ok" : "blocked",
      "Project boundary",
      existsSync(absProjectDir) ? "Project root exists and defines the read/write boundary." : "Project root is missing.",
      [absProjectDir]
    ),
    check(
      "state_import_scope",
      "ok",
      "State import scope",
      "Import accepts only .project-agent paths and rejects traversal/internal backup paths.",
      ["server/state-transfer.js", "/api/state/import"]
    ),
    check(
      "write_confirmation",
      "ok",
      "Write confirmation",
      "Destructive or durable writes use dry-run/explicit execution gates.",
      ["/api/state/import", "/api/memory/forget", "/api/memory/consolidate"]
    ),
    check(
      "memory_harness",
      "ok",
      "Memory harness",
      "Takeover/bootstrap can auto-run memory search/read and non-mutating consolidation discovery.",
      ["/api/memory/harness", "project_memory_harness"]
    ),
    check(
      "terminal_shell",
      "watch",
      "Terminal shell",
      "Terminal commands inherit the user's local shell permissions in the project directory.",
      ["/terminal", "server/terminal-session.js"]
    ),
    check(
      "launcher_process",
      "watch",
      "Launcher process",
      "Launch execution can spawn, stop, restart, and inspect a separate local npm run dev process.",
      ["/api/projects/launch", "/api/projects/stop", "/api/projects/restart", "/api/projects/logs", "server/project-launcher.js"]
    ),
    check(
      "sensitive_env_names",
      sensitiveEnv.count ? "watch" : "ok",
      "Sensitive env",
      sensitiveEnv.count ? `${sensitiveEnv.count} sensitive-looking env name(s) are present; values are never returned.` : "No sensitive-looking env names detected.",
      ["process.env"]
    ),
    check(
      "package_scripts",
      scripts.blocked ? "blocked" : scripts.watch ? "watch" : "ok",
      "Package scripts",
      scripts.blocked
        ? `${scripts.blocked} script(s) match blocked shell patterns.`
        : scripts.watch
          ? `${scripts.watch} script(s) start local processes or agent tooling.`
          : "Package scripts have no elevated shell patterns.",
      ["package.json#scripts"]
    )
  ];
  const status = statusFromChecks(checks);
  const blocked = checks.filter((item) => item.status === "blocked").length;
  const watch = checks.filter((item) => item.status === "watch").length;
  const ok = checks.filter((item) => item.status === "ok").length;

  return {
    schemaVersion: SANDBOX_SCHEMA,
    status,
    checkedAt: nowIso(),
    posture: {
      boundary: localOnly ? "local_only" : "non_local",
      localOnly,
      remoteAccess,
      auth: authMode,
      bindHost: effectiveBindHost,
      apiPort,
      uiPort,
      summary: localOnly
        ? "Trusted local-only development boundary with explicit dry-run/confirmation gates."
        : authBoundary?.auth?.enabled
          ? "Intentional non-local boundary with bearer-token auth and explicit confirmation gates."
          : "Remote/shared boundary is not ready until auth and permissions are configured."
    },
    auth: authBoundary ? {
      schemaVersion: authBoundary.schemaVersion,
      status: authBoundary.status,
      requested: authBoundary.requested,
      effective: authBoundary.effective,
      auth: authBoundary.auth,
      summary: authBoundary.summary,
      nextAction: authBoundary.nextAction
    } : null,
    project: {
      name: path.basename(absProjectDir),
      projectDir: absProjectDir,
      appRoot: absAppRoot,
      initialized: existsSync(path.join(stateDir, "state.json")),
      root: fileHealth(absProjectDir),
      stateDir: fileHealth(stateDir)
    },
    permissions: {
      readScopes: [
        { id: "project_context", path: absProjectDir, access: "read", purpose: "context_search_and_exact_refs" },
        { id: "project_agent_state", path: stateDir, access: "read", purpose: "memory_health_handoff_and_state_export" }
      ],
      writeScopes: [
        { id: "runtime_events", path: path.join(stateDir, "runtime.json"), access: "append_or_replace", gate: "api_or_terminal_event" },
        { id: "canonical_memory", path: path.join(stateDir, "memory"), access: "write", gate: "memory_add_consolidate_or_forget" },
        { id: "state_import", path: stateDir, access: "write", gate: "dry_run_plus_overwrite_confirmation" },
        { id: "launcher_registry", path: path.join(stateDir, "project-launcher.json"), access: "write", gate: "register_project" },
        { id: "launcher_logs", path: path.join(stateDir, "launcher-logs"), access: "append_or_trim", gate: "launch_stop_restart_lifecycle" }
      ],
      executionScopes: [
        { id: "terminal", command: "user_shell", cwd: absProjectDir, gate: "interactive_terminal" },
        { id: "launcher", command: "npm run dev", cwd: absAppRoot, gate: "launch_plan_then_execute" },
        { id: "mcp", command: "npm run mcp", cwd: absAppRoot, gate: "local_stdio_agent" }
      ],
      networkScopes: [
        { id: "api", url: `http://${bindHost}:${apiPort}`, access: "local_http" },
        { id: "ui", url: `http://${bindHost}:${uiPort}`, access: "local_http" },
        { id: "events", url: `ws://${bindHost}:${apiPort}/events`, access: "local_websocket" }
      ]
    },
    policy: {
      allowedAutomations: [
        "project_takeover_summary_memory_harness",
        "project_memory_search_read",
        "project_memory_consolidate_dry_run",
        "project_context_search_exact_ref_read",
        "project_health_and_launcher_plan",
        "project_launcher_status_and_logs"
      ],
      requiresConfirmation: [
        "state_import_execute_overwrite",
        "memory_forget_execute",
        "memory_consolidate_execute",
        "launcher_execute_spawn_process",
        "launcher_execute_stop_or_restart_process"
      ],
      blockedByDefault: [
        "remote_bind_without_auth",
        "state_import_outside_project_agent",
        "path_traversal",
        "raw_secret_value_export",
        "package_script_dangerous_shell_pattern"
      ]
    },
    secrets: {
      sensitiveEnv,
      rawEnvReturned: false
    },
    scripts,
    checks,
    summary: {
      ok,
      watch,
      blocked,
      total: checks.length
    },
    nextAction: blocked
      ? "Resolve blocked sandbox checks before remote/shared use."
      : watch
        ? "Review watch items before executing shell, launch, import, or memory write actions."
        : "Sandbox and permission posture is ready for local-only use."
  };
}
