import { existsSync } from "node:fs";
import path from "node:path";
import { readContinuity, readContinuityContract, readGovernanceSpec, writeContinuity } from "./runtime-state.js";

const REQUIRED_READ_FIRST = new Set([".project-agent/agent-context-bundle.json", ".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", ".project-agent/agent-runbook.json", ".project-agent/memory-graph.json", ".project-agent/process-trace.json", ".project-agent/development-trail.json", ".project-agent/architecture-map.json", ".project-agent/takeover-packet.json", ".project-agent/continuity-audit.json", ".project-agent/state-manifest.json", ".project-agent/continuity.json", ".project-agent/state.json", "AGENTS.md", "PROJECT.md"]);
const EXTERNAL_REF_PATTERNS = [/^https?:\/\//i, /^wss?:\/\//i, /^\/api\//, /^npm\s+/, /^node\s+/, /^takeoverReadiness$/];

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function compact(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function normalizeRef(value) {
  return toPosix(String(value || "").trim().replace(/^\.\//, ""));
}

function isExternalRef(value) {
  const ref = String(value || "").trim();
  return !ref || EXTERNAL_REF_PATTERNS.some((pattern) => pattern.test(ref));
}

function isFileLikeRef(value) {
  const ref = String(value || "").trim();
  if (isExternalRef(ref)) return false;
  if (path.isAbsolute(ref)) return true;
  if (ref.startsWith(".project-agent/") || ref.startsWith("docs/") || ref.startsWith("src/") || ref.startsWith("server/")) return true;
  if (ref.includes("/")) return true;
  return /\.[a-z0-9]+$/i.test(ref);
}

function pathState(projectDir, ref, expectedFiles) {
  const normalized = normalizeRef(ref);
  if (expectedFiles.has(normalized)) {
    return { ref, normalized, exists: true, expected: true };
  }
  const absolute = path.isAbsolute(ref) ? ref : path.join(projectDir, ref);
  return { ref, normalized, exists: existsSync(absolute), expected: false };
}

function check(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: asArray(refs).filter(Boolean).slice(0, 8)
  };
}

function drillStatus(checks) {
  if (checks.some((item) => item.status === "bad")) return "fail";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function score(checks) {
  return `${checks.filter((item) => item.status === "ok").length}/${checks.length}`;
}

function hasAction(actions, pattern) {
  return actions.some((item) => pattern.test(`${item.action || ""} ${item.why || ""}`));
}

function readFirstPath(item) {
  return item?.path || item;
}

function kernelItemCount(kernel = {}) {
  return ["philosophy", "strategy", "architecture", "product", "quality"].reduce((sum, key) => {
    return sum + asArray(kernel[key]).length;
  }, 0);
}

function actionSummary(actions) {
  const hasResume = hasAction(actions, /resume from the current cursor/i);
  const hasEvent = hasAction(actions, /record a current event/i);
  return { hasResume, hasEvent };
}

function summarizeReadFirst(projectDir, readFirst, expectedFiles) {
  const files = readFirst
    .map((item) => (typeof item === "string" ? item : item?.path))
    .filter(isFileLikeRef)
    .map((ref) => pathState(projectDir, ref, expectedFiles));
  const missing = files.filter((item) => !item.exists);
  const missingRequired = missing.filter((item) => REQUIRED_READ_FIRST.has(item.normalized));
  return { files, missing, missingRequired };
}

function summarizeChangedFiles(projectDir, changedFiles, expectedFiles) {
  const tracked = changedFiles
    .filter((file) => file?.path && isFileLikeRef(file.path))
    .map((file) => ({
      ...file,
      pathState: pathState(projectDir, file.path, expectedFiles)
    }));
  const missing = tracked.filter((file) => file.status !== "deleted" && !file.pathState.exists);
  return { tracked, missing };
}

function summarizeCursorRefs(projectDir, cursor, expectedFiles) {
  const refs = asArray(cursor?.refs)
    .filter(isFileLikeRef)
    .map((ref) => pathState(projectDir, ref, expectedFiles));
  const missing = refs.filter((ref) => !ref.exists);
  return { refs, missing };
}

function statusForWarnable(missing, fallbackWarn = false) {
  if (missing.length) return "warn";
  return fallbackWarn ? "warn" : "ok";
}

export function runTakeoverDrill(projectDir, continuity = readContinuity(projectDir), options = {}) {
  const generatedAt = nowIso();
  const expectedFiles = new Set(asArray(options.expectedFiles).map(normalizeRef));
  const existingGovernanceSpec = continuity?.governanceSpec || readGovernanceSpec(projectDir);
  const existingContract = continuity?.continuityContract || readContinuityContract(projectDir);
  const packet = { ...(continuity || {}), ...(existingGovernanceSpec ? { governanceSpec: existingGovernanceSpec } : {}), ...(existingContract ? { continuityContract: existingContract } : {}) };
  const startProtocol = packet.startProtocol || {};
  const governanceSpecReadFirst = {
    path: ".project-agent/governance-spec.json",
    why: "Product-level AI-native development requirements; read this before interpreting state.",
    lookFor: "requirements, acceptance, operatingRules, influences, readFirst"
  };
  const contextBundleReadFirst = {
    path: ".project-agent/agent-context-bundle.json",
    why: "Single-file takeover index tying memory, process, architecture, governance, audit, and validation together.",
    lookFor: "quickStart, governance, memory.graph, process.trace, architecture.map, validation.stateManifestVerification, validation.freshnessGate"
  };
  const contractReadFirst = {
    path: ".project-agent/continuity-contract.json",
    why: "Agent-neutral takeover contract; start here before parsing the full state.",
    lookFor: "contractId, status, resume, capabilities, inspectOrder, proofChecklist"
  };
  const runbookReadFirst = {
    path: ".project-agent/agent-runbook.json",
    why: "Executable takeover runbook with command templates and proof gates.",
    lookFor: "currentState, nextState, stateMachine, steps, proofGates"
  };
  const memoryGraphReadFirst = {
    path: ".project-agent/memory-graph.json",
    why: "Durable memory knowledge graph with nodes, edges, and provenance.",
    lookFor: "nodes, edges, provenanceRefs, source, nodeCount, edgeCount"
  };
  const processTraceReadFirst = {
    path: ".project-agent/process-trace.json",
    why: "Durable previous/current/next process trace and event inspect order.",
    lookFor: "current, previous, next, phases, events, inspectOrder, filesTouched"
  };
  const developmentTrailReadFirst = {
    path: ".project-agent/development-trail.json",
    why: "Durable process-to-architecture trail with touched files, impacted folders, takeover risk, and inspect order.",
    lookFor: "steps, current, files, folders, risk, inspectOrder, nextAction"
  };
  const architectureMapReadFirst = {
    path: ".project-agent/architecture-map.json",
    why: "Durable architecture tree, changed folders, files, and inspect order.",
    lookFor: "tree, files, recentChanges, impact, trace, inspectOrder"
  };
  const stateManifestReadFirst = {
    path: ".project-agent/state-manifest.json",
    why: "Hash manifest proving the handoff files belong to one readable state snapshot.",
    lookFor: "aggregateHash, files, sha256, schemaVersion, missing"
  };
  const rawReadFirst = asArray(startProtocol.readFirst);
  const requiredReadFirst = [contextBundleReadFirst, governanceSpecReadFirst, contractReadFirst, runbookReadFirst, memoryGraphReadFirst, processTraceReadFirst, developmentTrailReadFirst, architectureMapReadFirst, stateManifestReadFirst];
  const readFirst = [
    ...requiredReadFirst,
    ...rawReadFirst.filter((item) => !requiredReadFirst.some((required) => readFirstPath(item) === required.path))
  ];
  const firstActions = asArray(startProtocol.firstActions);
  const changedFiles = asArray(packet.changedFiles);
  const activeWorkstream = packet.workstreams?.active || packet.workstreams?.workstream || packet.workstream;
  const impactedFolders = asArray(packet.architectureImpact?.topFolders || packet.architectureImpact?.folders);
  const takeoverPacketPathRef = ".project-agent/takeover-packet.json";
  const continuityAuditPathRef = ".project-agent/continuity-audit.json";
  const stateRefs = [...new Set([contextBundleReadFirst.path, governanceSpecReadFirst.path, contractReadFirst.path, runbookReadFirst.path, memoryGraphReadFirst.path, processTraceReadFirst.path, developmentTrailReadFirst.path, architectureMapReadFirst.path, takeoverPacketPathRef, continuityAuditPathRef, stateManifestReadFirst.path, ...asArray(packet.stateRefs)])];
  const readiness = packet.takeoverReadiness;
  const continuityFile = pathState(projectDir, ".project-agent/continuity.json", expectedFiles);
  const readFirstSummary = summarizeReadFirst(projectDir, readFirst, expectedFiles);
  const changedSummary = summarizeChangedFiles(projectDir, changedFiles, expectedFiles);
  const cursorSummary = summarizeCursorRefs(projectDir, packet.processCursor, expectedFiles);
  const actions = actionSummary(firstActions);
  const staleAgents = asArray(packet.agentLeases).filter((agent) => agent?.effectiveStatus === "stale");
  const interruptedWork = packet.interruptedWork || packet.continuityContract?.agentState?.interruptedWork || { count: 0, items: [] };
  const kernelCount = kernelItemCount(packet.kernelSummary);
  const snapshotStatus = packet.handoffSnapshot?.status;

  const checks = [
    check(
      "continuity_file",
      "Continuity File",
      continuityFile.exists ? "ok" : "bad",
      continuityFile.exists
        ? `${continuityFile.normalized} is readable${continuityFile.expected ? " in the current write plan" : ""}.`
        : "A new agent has no machine-readable continuity packet.",
      [continuityFile.normalized]
    ),
    check(
      "active_goal",
      "Active Goal",
      packet.activeGoal?.objective ? "ok" : "bad",
      packet.activeGoal?.objective ? `${packet.activeGoal.status || "active"}: ${packet.activeGoal.objective}` : "No active goal is present.",
      packet.activeGoal?.id ? [packet.activeGoal.id] : []
    ),
    check(
      "current_cursor",
      "Current Cursor",
      packet.processCursor?.title ? "ok" : "bad",
      packet.processCursor?.title
        ? `${packet.processCursor.phase || "event"}/${packet.processCursor.status || "unknown"}: ${packet.processCursor.title}`
        : "No process cursor is present.",
      [packet.processCursor?.id, ...asArray(packet.processCursor?.refs)]
    ),
    check(
      "start_protocol",
      "Start Protocol",
      readFirst.length && firstActions.length ? "ok" : "bad",
      readFirst.length && firstActions.length
        ? `${readFirst.length} read-first item(s), ${firstActions.length} first action(s).`
        : "Start protocol is missing read-first files or first actions.",
      readFirst.map((item) => item.path || item).slice(0, 6)
    ),
    check(
      "read_first_files",
      "Read-First Files",
      readFirstSummary.missingRequired.length ? "bad" : statusForWarnable(readFirstSummary.missing),
      readFirstSummary.missing.length
        ? `${readFirstSummary.files.length - readFirstSummary.missing.length}/${readFirstSummary.files.length} read-first file(s) readable; missing ${readFirstSummary.missing.map((item) => item.normalized).slice(0, 3).join(", ")}.`
        : `${readFirstSummary.files.length} read-first file(s) readable.`,
      readFirstSummary.missing.length ? readFirstSummary.missing.map((item) => item.normalized) : readFirstSummary.files.map((item) => item.normalized)
    ),
    check(
      "first_actions",
      "First Actions",
      actions.hasResume && actions.hasEvent ? "ok" : "bad",
      actions.hasResume && actions.hasEvent
        ? "Protocol tells the new agent to resume from cursor and record runtime events."
        : "Protocol must include cursor resume and current-event recording actions.",
      firstActions.map((item) => item.action).filter(Boolean)
    ),
    check(
      "takeover_readiness",
      "Takeover Readiness",
      readiness?.canTakeOver ? (readiness.tone === "warn" ? "warn" : "ok") : "bad",
      readiness ? `${readiness.status || "unknown"}: ${readiness.summary || "no summary"}` : "No takeover readiness object is present.",
      asArray(readiness?.readFirst)
    ),
    check(
      "handoff_snapshot",
      "Handoff Snapshot",
      snapshotStatus === "done" ? "ok" : snapshotStatus === "failed" ? "bad" : "warn",
      packet.handoffSnapshot
        ? `${packet.handoffSnapshot.status}${packet.handoffSnapshot.reason ? `, ${packet.handoffSnapshot.reason}` : ""}`
        : "No handoff snapshot is recorded yet.",
      [packet.handoffSnapshot?.resumeFile, packet.handoffSnapshot?.recoveryFile]
    ),
    check(
      "changed_files",
      "Changed Files",
      changedSummary.missing.length ? "bad" : changedFiles.length ? "ok" : "warn",
      changedFiles.length
        ? changedSummary.missing.length
          ? `${changedSummary.missing.length} tracked changed file(s) are missing on disk.`
          : `${changedFiles.length} changed file(s) can be inspected.`
        : "No changed files are captured.",
      changedSummary.missing.length ? changedSummary.missing.map((file) => file.path) : changedFiles.map((file) => file.path).slice(0, 8)
    ),
    check(
      "cursor_refs",
      "Cursor References",
      cursorSummary.missing.length ? "warn" : cursorSummary.refs.length ? "ok" : "warn",
      cursorSummary.missing.length
        ? `${cursorSummary.missing.length} cursor ref(s) are not readable.`
        : cursorSummary.refs.length
          ? `${cursorSummary.refs.length} cursor ref(s) are readable.`
          : "Cursor has no file refs to inspect.",
      cursorSummary.missing.length ? cursorSummary.missing.map((ref) => ref.normalized) : cursorSummary.refs.map((ref) => ref.normalized)
    ),
    check(
      "architecture_impact",
      "Architecture Impact",
      impactedFolders.length ? "ok" : "warn",
      impactedFolders.length ? `${impactedFolders.length} impacted folder(s); top ${impactedFolders[0].folder}.` : "No impacted folders are captured.",
      impactedFolders.map((folder) => folder.latestFile).filter(Boolean).slice(0, 6)
    ),
    check(
      "workstream",
      "Workstream",
      activeWorkstream?.id ? "ok" : "warn",
      activeWorkstream?.id ? `${activeWorkstream.label || activeWorkstream.id}: ${activeWorkstream.description || ""}` : "No active workstream is classified.",
      [activeWorkstream?.id]
    ),
    check(
      "kernel_summary",
      "Project Kernel",
      kernelCount ? "ok" : "warn",
      kernelCount ? `${kernelCount} kernel statement(s) available.` : "Project philosophy/architecture/quality summary is missing.",
      asArray(packet.kernelSummary?.sourceRefs)
    ),
    check(
      "agent_leases",
      "Agent Leases",
      staleAgents.length ? "warn" : "ok",
      staleAgents.length ? `${staleAgents.length} stale active agent(s) found; treat as possible crash.` : `${asArray(packet.agentLeases).length} agent lease(s) known.`,
      staleAgents.map((agent) => agent.id)
    ),
    check(
      "interrupted_work",
      "Interrupted Work",
      interruptedWork.count ? "warn" : "ok",
      interruptedWork.count
        ? `${interruptedWork.count} stale current operation(s) must be resolved before unrelated edits.`
        : "No stale current work detected.",
      asArray(interruptedWork.items).flatMap((item) => [item.id, ...asArray(item.refs).slice(0, 2)]).slice(0, 8)
    ),
    check(
      "state_refs",
      "State References",
      stateRefs.length ? "ok" : "bad",
      stateRefs.length ? `${stateRefs.length} durable state reference(s) listed.` : "No durable state references are listed.",
      stateRefs.slice(0, 8)
    )
  ];

  const status = drillStatus(checks);
  const canResume = status !== "fail";
  const firstRead = readFirst.map((item) => {
    const ref = item.path || item;
    const fileState = isFileLikeRef(ref) ? pathState(projectDir, ref, expectedFiles) : null;
    return {
      path: ref,
      why: item.why,
      lookFor: item.lookFor,
      exists: fileState ? fileState.exists : undefined,
      expected: fileState ? fileState.expected : undefined
    };
  });

  return {
    generatedAt,
    status,
    canResume,
    score: score(checks),
    summary:
      status === "pass"
        ? "Cold-start takeover drill passed."
        : status === "warn"
          ? "Cold-start takeover drill can resume with warnings."
          : "Cold-start takeover drill failed; restore required state before resuming.",
    checks,
    nextAgentBrief: {
      schemaVersion: "project-agent.takeover-packet.v1",
      packetFile: takeoverPacketPathRef,
      generatedAt,
      status,
      canResume,
      score: score(checks),
      summary:
        status === "pass"
          ? "Cold-start takeover drill passed."
          : status === "warn"
            ? "Cold-start takeover drill can resume with warnings."
            : "Cold-start takeover drill failed; restore required state before resuming.",
      objective: packet.activeGoal?.objective || null,
      goalId: packet.activeGoal?.id || null,
      cursor: packet.processCursor || null,
      workstream: activeWorkstream || null,
      nextCommand: packet.agentRunbook?.nextCommand || packet.continuityContract?.agentRunbook?.nextCommand || null,
      firstRead: firstRead.slice(0, 10),
      firstActions: firstActions.slice(0, 6),
      guardrails: asArray(startProtocol.guardrails).slice(0, 8),
      interruptedWork,
      agentRunbook: packet.agentRunbook || packet.continuityContract?.agentRunbook || null,
      changedFiles: changedFiles.slice(0, 8),
      impactedFolders: impactedFolders.slice(0, 6),
      expectedFiles: [...expectedFiles]
    }
  };
}

export function attachTakeoverDrill(projectDir, continuity = readContinuity(projectDir), options = {}) {
  const drill = runTakeoverDrill(projectDir, continuity, options);
  const existingContract = continuity?.continuityContract || readContinuityContract(projectDir);
  const next = {
    ...(continuity || {}),
    ...(existingContract ? { continuityContract: existingContract } : {}),
    takeoverDrill: drill,
    takeoverPacket: drill.nextAgentBrief
  };
  delete next.generatedAt;
  return writeContinuity(projectDir, next);
}

export function renderTakeoverDrillMarkdown(drill = {}) {
  const lines = [
    `- status: ${drill.status || "unknown"}`,
    `- can resume: ${drill.canResume ? "yes" : "no"}`,
    drill.score ? `- score: ${drill.score}` : "",
    drill.summary ? `- summary: ${drill.summary}` : ""
  ].filter(Boolean);
  for (const item of asArray(drill.checks).slice(0, 12)) {
    const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : "";
    lines.push(`- [${item.status}] ${item.label}: ${item.detail}${refs}`);
  }
  if (drill.nextAgentBrief?.firstRead?.length) {
    lines.push("");
    lines.push("Next agent read order:");
    for (const item of drill.nextAgentBrief.firstRead.slice(0, 6)) {
      const state = item.exists ? (item.expected ? "planned" : "readable") : "missing";
      lines.push(`- [${state}] ${item.path}${item.why ? `: ${item.why}` : ""}`);
    }
  }
  return lines.join("\n") || "- none";
}
