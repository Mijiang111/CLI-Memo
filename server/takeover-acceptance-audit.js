import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAgentContextBundle, readContinuity, verifyAgentContextBundle, verifyStateManifest, writeContinuity } from "./runtime-state.js";

const ACCEPTANCE_FILE = ".project-agent/takeover-acceptance-audit.json";

function nowIso() {
  return new Date().toISOString();
}

function abs(projectDir, relPath) {
  return path.join(projectDir, relPath);
}

function readJson(projectDir, relPath) {
  const file = abs(projectDir, relPath);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(projectDir, relPath) {
  const file = abs(projectDir, relPath);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function evidence(refs = []) {
  return [...new Set(refs.filter(Boolean))].slice(0, 12);
}

function row(id, requirement, status, detail, refs = [], nextAction = "") {
  return {
    id,
    requirement,
    status,
    detail,
    refs: evidence(refs),
    nextAction
  };
}

function statusFromRows(rows) {
  if (rows.some((item) => item.status === "bad")) return "fail";
  if (rows.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function score(rows) {
  return `${rows.filter((item) => item.status === "ok").length}/${rows.length}`;
}

function continuityAuditCanSupportAcceptance(audit = {}) {
  if (audit.canResume) return true;
  const blockers = audit.blockers || [];
  return audit.schemaVersion === "project-agent.continuity-audit.v1" && blockers.length === 1 && blockers[0] === "takeover_acceptance";
}

export function buildTakeoverAcceptanceAudit(projectDir, continuity = readContinuity(projectDir) || {}, options = {}) {
  const bundle = options.bundle || readAgentContextBundle(projectDir) || continuity.agentContextBundle || {};
  const bundleVerification = options.bundleVerification || verifyAgentContextBundle(projectDir, bundle);
  const manifestVerification =
    options.manifestVerification ||
    verifyStateManifest(projectDir, readJson(projectDir, ".project-agent/state-manifest.json") || continuity.stateManifest);
  const memoryGraph = readJson(projectDir, ".project-agent/memory-graph.json") || continuity.memoryGraph || {};
  const processTrace = readJson(projectDir, ".project-agent/process-trace.json") || continuity.processTrace || {};
  const developmentTrail = readJson(projectDir, ".project-agent/development-trail.json") || continuity.developmentTrail || {};
  const architectureMap = readJson(projectDir, ".project-agent/architecture-map.json") || continuity.architectureMap || {};
  const continuityAudit = readJson(projectDir, ".project-agent/continuity-audit.json") || continuity.continuityAudit || {};
  const contextDrill = readJson(projectDir, ".project-agent/context-takeover-drill.json") || {};
  const governanceSpec = readJson(projectDir, ".project-agent/governance-spec.json") || continuity.governanceSpec || {};
  const contextPrompt = readText(projectDir, ".project-agent/context-starter-prompt.md");
  const agents = readText(projectDir, "AGENTS.md");
  const readOrder = bundle.readOrder || [];
  const continuityAuditReady = continuityAuditCanSupportAcceptance(continuityAudit);
  const continuityAuditDetail = continuityAudit.canResume ? continuityAudit.status || "ready" : continuityAuditReady ? `${continuityAudit.status || "pending"}; self-refresh` : continuityAudit.status || "missing";
  const rows = [
    row(
      "memory_visible_knowledge_graph",
      "Project memory must be visible as a durable knowledge graph with provenance.",
      memoryGraph.schemaVersion === "project-agent.memory-graph.v1" && memoryGraph.nodes?.length && memoryGraph.edges?.length && memoryGraph.provenanceCoverage ? "ok" : "bad",
      `${memoryGraph.nodes?.length || 0} node(s), ${memoryGraph.edges?.length || 0} edge(s), provenance ${memoryGraph.provenanceCoverage || "missing"}.`,
      [".project-agent/memory-graph.json", ".project-agent/state.json", "PROJECT.md"],
      "Regenerate insights/continuity until memory-graph.json has nodes, edges, and provenance coverage."
    ),
    row(
      "process_dynamic_previous_current_next",
      "AI development process must expose previous, current, and next steps dynamically.",
      processTrace.schemaVersion === "project-agent.process-trace.v1" && processTrace.previous && processTrace.current && processTrace.next && processTrace.inspectOrder?.length ? "ok" : "bad",
      processTrace.current ? `${processTrace.previous?.title || "missing previous"} -> ${processTrace.current.title} -> ${processTrace.next?.title || "missing next"}; inspect ${processTrace.inspectOrder?.length || 0}.` : "Current process cursor is missing.",
      [".project-agent/process-trace.json", ".project-agent/runtime.json"],
      "Record current/done events and refresh continuity before takeover."
    ),
    row(
      "development_trail_links_steps_to_architecture",
      "Each active development step should connect process state to touched files and impacted folders.",
      developmentTrail.schemaVersion === "project-agent.development-trail.v1" && developmentTrail.current && developmentTrail.steps?.length && developmentTrail.inspectOrder?.length
        ? developmentTrail.status === "linked" ? "ok" : "warn"
        : "bad",
      developmentTrail.summary || "Development trail is missing.",
      [".project-agent/development-trail.json", ".project-agent/process-trace.json", ".project-agent/architecture-map.json"],
      "Record file refs on process events or refresh architecture tracking so steps link to files/folders."
    ),
    row(
      "architecture_visible_managed",
      "Project architecture must be visible as folders, files, changes, impact, and inspect order.",
      architectureMap.schemaVersion === "project-agent.architecture-map.v1" && architectureMap.tree?.length && architectureMap.files?.length && architectureMap.inspectOrder?.length ? "ok" : "bad",
      `${architectureMap.files?.length || 0} file(s), ${architectureMap.recentChanges?.length || 0} recent change(s), inspect ${architectureMap.inspectOrder?.length || 0}.`,
      [".project-agent/architecture-map.json", ".project-agent/development-trail.json"],
      "Run architecture scan/insights and inspect changed folders before editing."
    ),
    row(
      "agent_neutral_handoff",
      "A replacement agent must be able to resume from files without prior chat history.",
      bundleVerification.canResume && continuityAuditReady && contextDrill.canResume ? "ok" : "bad",
      `canResume bundle=${bundleVerification.canResume ? "yes" : "no"} (${bundleVerification.status || "missing"}), continuityAudit=${continuityAuditReady ? "yes" : "no"} (${continuityAuditDetail}), contextDrill=${contextDrill.canResume ? "yes" : "no"} (${contextDrill.status || "missing"}).`,
      [".project-agent/agent-context-bundle.json", ".project-agent/continuity-audit.json", ".project-agent/context-takeover-drill.json", ".project-agent/context-starter-prompt.md"],
      "Run context verification, continuity audit, and bundle-only takeover drill before handing off."
    ),
    row(
      "coherent_state_snapshot",
      "Handoff files must form one coherent, hash-verifiable state snapshot.",
      manifestVerification.ok ? "ok" : "bad",
      manifestVerification.summary || "State manifest verification is missing.",
      [".project-agent/state-manifest.json"],
      "Run `npm run manifest -- --project-dir \"$PROJECT_DIR\" --verify` and refresh stale artifacts."
    ),
    row(
      "read_order_teaches_new_agent",
      "The project must tell any new agent exactly what to read first.",
      readOrder.includes(".project-agent/development-trail.json") && agents.includes("development-trail.json") && contextPrompt.includes("Development trail:") ? "ok" : "bad",
      `${readOrder.length || 0} bundle read-order item(s); AGENTS/context prompt ${agents && contextPrompt ? "present" : "missing"}.`,
      [".project-agent/agent-context-bundle.json", ".project-agent/context-starter-prompt.md", "AGENTS.md"],
      "Update bundle readOrder, AGENTS.md, and context-starter-prompt.md with development-trail instructions."
    ),
    row(
      "governance_matches_user_objective",
      "Governance requirements must explicitly cover visible memory, dynamic process, managed architecture, and agent-neutral handoff.",
      governanceSpec.schemaVersion === "project-agent.governance-spec.v1" && ["memory_visible_knowledge_graph", "process_dynamic_previous_current_next", "architecture_visible_managed", "agent_neutral_handoff"].every((id) => governanceSpec.requirements?.some((item) => item.id === id && item.evidence?.length)) ? "ok" : "bad",
      `${governanceSpec.requirements?.length || 0} governance requirement(s) captured.`,
      [".project-agent/governance-spec.json", ".project-agent/agent-context-bundle.json"],
      "Regenerate governance spec until every user-objective requirement has evidence refs."
    )
  ];
  const status = statusFromRows(rows);
  return {
    schemaVersion: "project-agent.takeover-acceptance-audit.v1",
    generatedAt: nowIso(),
    status,
    canResume: status !== "fail",
    score: score(rows),
    summary:
      status === "pass"
        ? "User objective acceptance audit passed; durable state proves visible memory, dynamic process, managed architecture, and agent-neutral takeover."
        : status === "warn"
          ? "User objective acceptance audit can resume with warnings."
          : "User objective acceptance audit failed; restore bad requirements before claiming takeover readiness.",
    rows,
    blockers: rows.filter((item) => item.status === "bad").map((item) => item.id),
    warnings: rows.filter((item) => item.status === "warn").map((item) => item.id),
    objective: "Visible memory knowledge graph, dynamic AI process, managed project architecture, and crash-proof agent-neutral handoff."
  };
}

export function writeTakeoverAcceptanceAudit(projectDir, audit = buildTakeoverAcceptanceAudit(projectDir)) {
  const file = abs(projectDir, ACCEPTANCE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  return { audit, file };
}

export function refreshTakeoverAcceptanceAudit(projectDir, continuity = readContinuity(projectDir) || {}) {
  let current = writeContinuity(projectDir, continuity);
  let written = writeTakeoverAcceptanceAudit(projectDir, buildTakeoverAcceptanceAudit(projectDir, current));
  current = writeContinuity(projectDir, {
    ...current,
    takeoverAcceptanceAudit: written.audit
  });
  written = writeTakeoverAcceptanceAudit(projectDir, buildTakeoverAcceptanceAudit(projectDir, current));
  current = writeContinuity(projectDir, {
    ...current,
    takeoverAcceptanceAudit: written.audit
  });
  return { audit: written.audit, file: written.file, continuity: current };
}

export function readTakeoverAcceptanceAudit(projectDir) {
  return readJson(projectDir, ACCEPTANCE_FILE);
}
