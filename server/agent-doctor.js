import { existsSync } from "node:fs";
import path from "node:path";
import { buildAgentBootstrapKit } from "./cli-agent-bootstrap.js";
import { searchCodeGraph } from "./code-search.js";
import {
  auditMemoryPrivacy,
  buildMemoryHarness,
  buildMemoryInventory,
  queryMemoryAccessAudit,
  rebuildAllMemoryIndexes
} from "./memory-store.js";

function nowIso() {
  return new Date().toISOString();
}

function doctorStatus(checks = []) {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn" || check.status === "watch")) return "warn";
  return "ready";
}

function check(id, status, summary, refs = [], data = null) {
  return { id, status, summary, refs: refs.filter(Boolean).slice(0, 12), data };
}

export function buildAgentDoctor(projectDir, options = {}) {
  const appRoot = options.appRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const generatedAt = nowIso();
  const started = existsSync(path.join(projectDir, ".project-agent", "state.json"));
  const bootstrap = buildAgentBootstrapKit(projectDir, {
    appRoot,
    bindHost: options.bindHost || "127.0.0.1",
    apiPort: options.apiPort || 4147,
    uiPort: options.uiPort || 5174
  });
  const inventory = buildMemoryInventory(projectDir);
  const indexes = started ? rebuildAllMemoryIndexes(projectDir, { audit: false }) : null;
  const harness = buildMemoryHarness(projectDir, {
    query: options.query || "",
    limit: 6,
    maxReads: 3,
    candidateLimit: 5,
    consolidate: true
  });
  const privacy = auditMemoryPrivacy(projectDir, { limit: 12, audit: false });
  const accessAudit = queryMemoryAccessAudit(projectDir, { limit: 8 });
  const codeSearch = searchCodeGraph(projectDir, {
    query: options.query || "memory harness architecture",
    limit: 5,
    persist: false
  });
  const checks = [
    check(
      "project_started",
      started ? "ready" : "fail",
      started ? "Project state exists and agent tools can operate." : "Project has not been started; call project_start first.",
      [".project-agent/state.json"]
    ),
    check(
      "bootstrap_protocol",
      bootstrap.automation?.manualUserStepsRequired === false && bootstrap.firstCall?.tool === "project_takeover_summary" ? "ready" : "warn",
      "Bootstrap kit exposes a no-manual-JSON first-call protocol.",
      ["/api/agent/bootstrap"],
      { firstCall: bootstrap.firstCall?.tool, automaticHarness: bootstrap.automaticHarness?.tool }
    ),
    check(
      "memory_harness",
      harness.status === "not_started" ? "fail" : harness.automatic ? "ready" : "warn",
      harness.summary || "Automatic memory harness readiness.",
      harness.refs || [],
      { status: harness.status, appliedCalls: (harness.appliedCalls || []).map((call) => call.tool).slice(0, 8) }
    ),
    check(
      "memory_indexes",
      !started ? "fail" : indexes?.status === "fresh" ? "ready" : "warn",
      indexes?.summary || "Memory indexes are not available before project_start.",
      indexes?.refs || [],
      indexes?.indexes || null
    ),
    check(
      "privacy_policy",
      privacy.status === "ok" ? "ready" : privacy.status === "not_started" ? "fail" : "warn",
      privacy.summary,
      privacy.refs || [],
      { totals: privacy.totals, findings: (privacy.findings || []).slice(0, 5) }
    ),
    check(
      "bounded_access_audit",
      accessAudit.status === "not_started" ? "fail" : "ready",
      accessAudit.summary,
      accessAudit.refs || [],
      { totals: accessAudit.totals }
    ),
    check(
      "code_search",
      codeSearch.graph?.nodeCount ? "ready" : "watch",
      codeSearch.summary,
      codeSearch.refs || [],
      { engine: codeSearch.engine, ast: codeSearch.ast, graph: codeSearch.graph }
    )
  ];
  const status = doctorStatus(checks);
  return {
    schemaVersion: "project-agent.agent-doctor.v1",
    ok: status !== "fail",
    status,
    projectDir,
    generatedAt,
    summary: status === "ready"
      ? "Agent doctor passed: bootstrap, harness, indexes, privacy, access audit, and code search are ready."
      : status === "warn"
        ? "Agent doctor found warnings; inspect checks before trusting automated memory/code routing."
        : "Agent doctor found blockers; start or repair the project before handing it to an external agent.",
    providers: (bootstrap.providers || []).map((provider) => ({
      id: provider.id,
      label: provider.label,
      configType: provider.configType,
      serverName: provider.serverName,
      consumes: provider.consumes || []
    })),
    mcp: bootstrap.mcp,
    firstCall: bootstrap.firstCall,
    automaticHarness: bootstrap.automaticHarness,
    toolProtocol: bootstrap.toolProtocol,
    checks,
    artifacts: {
      inventory: {
        status: inventory.status,
        canonicalRecords: inventory.totals?.canonicalRecords || 0,
        lifecycle: inventory.lifecycle || null
      },
      harness: {
        status: harness.status,
        appliedCalls: (harness.appliedCalls || []).map((call) => call.tool),
        nextCalls: (harness.nextCalls || []).map((call) => call.tool)
      },
      privacy: {
        status: privacy.status,
        totals: privacy.totals
      },
      accessAudit: {
        status: accessAudit.status,
        totals: accessAudit.totals
      },
      codeSearch: {
        engine: codeSearch.engine,
        graph: codeSearch.graph,
        resultCount: codeSearch.results?.length || 0
      }
    },
    refs: [
      "/api/agent/bootstrap",
      "/api/memory/harness",
      "/api/memory/privacy",
      "/api/memory/access-audit",
      "/api/code/search",
      ".project-agent/memory/index.md",
      ".project-agent/architecture-map.json"
    ]
  };
}
