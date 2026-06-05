import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attachTakeoverDrill } from "./takeover-drill.js";
import { readContinuity, verifyStateManifest, writeStateManifest } from "./runtime-state.js";

const AUDIT_FILE = ".project-agent/continuity-audit.json";
const REQUIRED_FILES = [
  ".project-agent/governance-spec.json",
  ".project-agent/continuity-contract.json",
  ".project-agent/agent-runbook.json",
  ".project-agent/memory-graph.json",
  ".project-agent/process-trace.json",
  ".project-agent/development-trail.json",
  ".project-agent/architecture-map.json",
  ".project-agent/takeover-packet.json",
  ".project-agent/state-manifest.json",
  ".project-agent/takeover-acceptance-audit.json",
  ".project-agent/next-agent-prompt.md",
  ".project-agent/continuity.json",
  ".project-agent/resume.md",
  ".project-agent/recovery.md"
];

function nowIso() {
  return new Date().toISOString();
}

function absolute(projectDir, relPath) {
  return path.join(projectDir, relPath);
}

function readJson(projectDir, relPath) {
  const file = absolute(projectDir, relPath);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(projectDir, relPath) {
  const file = absolute(projectDir, relPath);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function check(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail,
    refs: refs.filter(Boolean).slice(0, 10)
  };
}

function statusFromChecks(checks) {
  if (checks.some((item) => item.status === "bad")) return "fail";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function score(checks) {
  return `${checks.filter((item) => item.status === "ok").length}/${checks.length}`;
}

function architectureInspectCount(map = {}) {
  return (
    map.inspectOrder?.length ||
    map.trace?.inspectOrder?.length ||
    map.readFirst?.length ||
    0
  );
}

function fileChecks(projectDir, expectedFiles = []) {
  const expected = new Set(expectedFiles);
  return REQUIRED_FILES.map((relPath) => {
    const file = absolute(projectDir, relPath);
    const exists = existsSync(file) || expected.has(relPath);
    return check(
      `file_${relPath.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}`,
      relPath,
      exists ? "ok" : "bad",
      existsSync(file) ? "Readable handoff artifact exists." : expected.has(relPath) ? "Artifact is part of the current write plan." : "Required handoff artifact is missing.",
      [relPath]
    );
  });
}

export function buildContinuityAudit(projectDir, continuity = readContinuity(projectDir), options = {}) {
  const packet = attachTakeoverDrill(projectDir, continuity || {}, options);
  const expected = new Set(options.expectedFiles || []);
  const governanceSpec = readJson(projectDir, ".project-agent/governance-spec.json") || packet.governanceSpec || {};
  const contract = readJson(projectDir, ".project-agent/continuity-contract.json") || packet.continuityContract || {};
  const runbook = readJson(projectDir, ".project-agent/agent-runbook.json") || packet.agentRunbook || {};
  const memoryGraph = readJson(projectDir, ".project-agent/memory-graph.json") || packet.memoryGraph || {};
  const processTrace = readJson(projectDir, ".project-agent/process-trace.json") || packet.processTrace || {};
  const developmentTrail = readJson(projectDir, ".project-agent/development-trail.json") || packet.developmentTrail || {};
  const architectureMap = readJson(projectDir, ".project-agent/architecture-map.json") || packet.architectureMap || {};
  const takeoverPacket = readJson(projectDir, ".project-agent/takeover-packet.json") || packet.takeoverPacket || packet.takeoverDrill?.nextAgentBrief || {};
  const takeoverAcceptanceAudit = readJson(projectDir, ".project-agent/takeover-acceptance-audit.json") || packet.takeoverAcceptanceAudit || {};
  const stateManifest = readJson(projectDir, ".project-agent/state-manifest.json") || packet.stateManifest || {};
  const stateManifestVerification = verifyStateManifest(projectDir, stateManifest);
  const starterPrompt = readText(projectDir, ".project-agent/next-agent-prompt.md");
  const resume = readText(projectDir, ".project-agent/resume.md");
  const recovery = readText(projectDir, ".project-agent/recovery.md");
  const drill = packet.takeoverDrill || {};
  const checks = [
    ...fileChecks(projectDir, [...(options.expectedFiles || []), ...(options.writeFile ? [AUDIT_FILE] : [])]),
    check(
      "governance_spec",
      "Governance Spec",
      governanceSpec.schemaVersion === "project-agent.governance-spec.v1" && governanceSpec.requirements?.length ? "ok" : "bad",
      governanceSpec.requirements?.length ? `${governanceSpec.requirements.length} requirement(s), ${governanceSpec.status || "unknown"} status.` : "Missing product-level governance requirements.",
      [".project-agent/governance-spec.json"]
    ),
    check(
      "contract_schema",
      "Continuity Contract Schema",
      contract.schemaVersion === "project-agent.continuity-contract.v1" ? "ok" : "bad",
      contract.schemaVersion || "Missing contract schema.",
      [".project-agent/continuity-contract.json"]
    ),
    check(
      "runbook_executable",
      "Executable Runbook",
      runbook.schemaVersion === "project-agent.runbook.v1" && runbook.activeStepId && runbook.nextCommand ? "ok" : "bad",
      runbook.activeStepId ? `${runbook.activeStepId}; nextCommand ${runbook.nextCommand ? "present" : "missing"}.` : "Runbook active step is missing.",
      [".project-agent/agent-runbook.json"]
    ),
    check(
      "memory_graph",
      "Memory Graph",
      memoryGraph.schemaVersion === "project-agent.memory-graph.v1" && memoryGraph.nodes?.length && memoryGraph.edges?.length ? "ok" : "bad",
      `${memoryGraph.nodes?.length || 0} node(s), ${memoryGraph.edges?.length || 0} edge(s), provenance ${memoryGraph.provenanceCoverage || "unknown"}.`,
      [".project-agent/memory-graph.json"]
    ),
    check(
      "process_trace",
      "Process Trace",
      processTrace.schemaVersion === "project-agent.process-trace.v1" && processTrace.current && processTrace.previous && processTrace.next && processTrace.inspectOrder?.length ? "ok" : "bad",
      processTrace.current ? `${processTrace.current.phase}/${processTrace.current.status}: ${processTrace.current.title}; inspect ${processTrace.inspectOrder?.length || 0}.` : "Process cursor is missing.",
      [".project-agent/process-trace.json"]
    ),
    check(
      "development_trail",
      "Development Trail",
      developmentTrail.schemaVersion === "project-agent.development-trail.v1" && developmentTrail.current && developmentTrail.inspectOrder?.length ? (developmentTrail.status === "linked" ? "ok" : "warn") : "bad",
      developmentTrail.summary || "Process-to-architecture development trail is missing.",
      [".project-agent/development-trail.json"]
    ),
    check(
      "architecture_map",
      "Architecture Map",
      architectureMap.schemaVersion === "project-agent.architecture-map.v1" && architectureMap.tree?.length
        ? architectureInspectCount(architectureMap)
          ? "ok"
          : "warn"
        : "bad",
      `${architectureMap.files?.length || 0} file(s), ${architectureInspectCount(architectureMap)} inspect item(s).`,
      [".project-agent/architecture-map.json"]
    ),
    check(
      "takeover_packet",
      "Takeover Packet",
      takeoverPacket.schemaVersion === "project-agent.takeover-packet.v1" && takeoverPacket.cursor && takeoverPacket.nextCommand && takeoverPacket.firstRead?.length && takeoverPacket.firstActions?.length ? "ok" : "bad",
      takeoverPacket.cursor ? `${takeoverPacket.cursor.phase}/${takeoverPacket.cursor.status}: ${takeoverPacket.cursor.title}; ${takeoverPacket.firstActions?.length || 0} action(s).` : "Takeover packet cursor is missing.",
      [".project-agent/takeover-packet.json"]
    ),
    check(
      "state_manifest",
      "State Manifest",
      stateManifest.schemaVersion === "project-agent.state-manifest.v1" && stateManifest.aggregateHash && stateManifest.files?.length && stateManifestVerification.ok ? "ok" : "bad",
      stateManifestVerification.summary || (stateManifest.aggregateHash ? `${stateManifest.fileCount || 0} file(s), hash ${String(stateManifest.aggregateHash).slice(0, 12)}.` : "Missing state manifest aggregate hash."),
      [".project-agent/state-manifest.json"]
    ),
    check(
      "starter_prompt",
      "Starter Prompt",
      starterPrompt.includes("Next Agent Starter Prompt") && starterPrompt.includes("## Mandatory Read Order") && starterPrompt.includes("## Next Command") ? "ok" : "bad",
      starterPrompt ? "Prompt includes mission, read order, cursor, actions, and next command." : "Starter prompt is missing.",
      [".project-agent/next-agent-prompt.md"]
    ),
    check(
      "human_briefs",
      "Human Recovery Briefs",
      resume.includes("Next Agent Resume Packet") && recovery.includes("Project Recovery Brief") ? "ok" : "bad",
      `resume ${resume ? "present" : "missing"}, recovery ${recovery ? "present" : "missing"}.`,
      [".project-agent/resume.md", ".project-agent/recovery.md"]
    ),
    check(
      "takeover_drill",
      "Takeover Drill",
      drill.canResume ? (drill.status === "warn" ? "warn" : "ok") : "bad",
      drill.summary || "Takeover drill has not run.",
      [".project-agent/takeover-packet.json", ".project-agent/continuity.json"]
    ),
    check(
      "takeover_acceptance",
      "Takeover Acceptance",
      takeoverAcceptanceAudit.schemaVersion === "project-agent.takeover-acceptance-audit.v1" && takeoverAcceptanceAudit.canResume ? (takeoverAcceptanceAudit.status === "warn" ? "warn" : "ok") : expected.has(".project-agent/takeover-acceptance-audit.json") ? "warn" : "bad",
      takeoverAcceptanceAudit.summary || (expected.has(".project-agent/takeover-acceptance-audit.json") ? "User-objective acceptance audit is part of the current write plan." : "User-objective takeover acceptance audit is missing."),
      [".project-agent/takeover-acceptance-audit.json"]
    )
  ];
  const status = statusFromChecks(checks);
  return {
    schemaVersion: "project-agent.continuity-audit.v1",
    generatedAt: nowIso(),
    status,
    canResume: status !== "fail",
    score: score(checks),
    summary:
      status === "pass"
        ? "Continuity audit passed; a replacement agent can start from durable state."
        : status === "warn"
          ? "Continuity audit can resume with warnings."
          : "Continuity audit failed; restore bad handoff artifacts before resuming.",
    checks,
    sourceFiles: REQUIRED_FILES,
    stateManifestVerification,
    nextCommand: takeoverPacket.nextCommand || runbook.nextCommand || null,
    cursor: takeoverPacket.cursor || processTrace.current || null,
    warnings: checks.filter((item) => item.status === "warn").map((item) => item.id),
    blockers: checks.filter((item) => item.status === "bad").map((item) => item.id)
  };
}

export function writeContinuityAudit(projectDir, audit) {
  const file = absolute(projectDir, AUDIT_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  writeStateManifest(projectDir);
  return file;
}

export function readContinuityAudit(projectDir) {
  return readJson(projectDir, AUDIT_FILE);
}
