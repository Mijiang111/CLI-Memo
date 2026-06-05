import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildRecoveryBrief, renderRecoveryMarkdown, writeRecoveryFile } from "./recovery.js";
import { attachTakeoverDrill, renderTakeoverDrillMarkdown } from "./takeover-drill.js";

function compact(value, max = 700) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function eventLine(event) {
  if (!event) return "- none";
  const bits = [event.phase, event.status, event.workstream?.label, event.source, event.tool].filter(Boolean).join("/");
  return `- [${bits || "event"}] ${event.title}: ${compact(event.detail, 260)}`;
}

function fileLine(file) {
  const stats = file.summary || `+${file.additions || 0}/-${file.deletions || 0}`;
  return `- [${file.status || "changed"}] ${file.path}${stats ? ` ${stats}` : ""}`;
}

function folderLine(folder) {
  const statuses = [
    folder.added ? `${folder.added} added` : "",
    folder.modified ? `${folder.modified} modified` : "",
    folder.deleted ? `${folder.deleted} deleted` : ""
  ].filter(Boolean).join(", ");
  return `- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${statuses ? ` (${statuses})` : ""}${folder.latestFile ? `, latest ${folder.latestFile}` : ""}`;
}

function agentLine(agent) {
  if (!agent) return "- none";
  const bits = [agent.effectiveStatus || agent.status || "active", agent.role, agent.goalId].filter(Boolean).join("/");
  const age = Number.isFinite(agent.ageSeconds) ? ` age=${agent.ageSeconds}s` : "";
  return `- [${bits}] ${agent.id}${age}${agent.note ? `: ${compact(agent.note, 180)}` : ""}`;
}

function kernelLines(kernel = {}) {
  const rows = [
    ["philosophy", kernel.philosophy],
    ["strategy", kernel.strategy],
    ["architecture", kernel.architecture],
    ["product", kernel.product],
    ["quality", kernel.quality]
  ];
  const lines = [];
  for (const [label, items] of rows) {
    for (const item of (items || []).slice(0, 2)) lines.push(`- ${label}: ${item}`);
  }
  return lines.join("\n") || "- none";
}

function workstreamLines(workstreams = {}) {
  const active = workstreams.active || workstreams.workstream;
  const next = workstreams.next;
  const lanes = workstreams.lanes || [];
  const lines = [];
  if (active) lines.push(`- active: ${active.label} - ${active.description}`);
  if (next) lines.push(`- next: ${next.label}`);
  for (const lane of lanes.filter((item) => item.count || item.status === "current").slice(0, 6)) {
    lines.push(`- ${lane.label}: ${lane.status}, ${lane.count || 0} event(s)${lane.latestTitle ? `, latest ${lane.latestTitle}` : ""}`);
  }
  return lines.join("\n") || "- none";
}

function readinessLines(readiness = {}) {
  const checks = readiness.checks || [];
  const lines = [
    `- status: ${readiness.status || "unknown"}`,
    `- can take over: ${readiness.canTakeOver ? "yes" : "no"}`,
    readiness.score ? `- score: ${readiness.score}` : "",
    readiness.summary ? `- summary: ${readiness.summary}` : ""
  ].filter(Boolean);
  for (const check of checks.slice(0, 9)) {
    lines.push(`- [${check.status}] ${check.label}: ${check.detail}`);
  }
  return lines.join("\n") || "- none";
}

function startProtocolLines(protocol = {}) {
  const lines = [];
  if (protocol.status) lines.push(`- status: ${protocol.status}`);
  if (protocol.resumeFrom?.objective) lines.push(`- objective: ${protocol.resumeFrom.objective}`);
  if (protocol.resumeFrom?.workstream?.label) lines.push(`- workstream: ${protocol.resumeFrom.workstream.label}`);
  if (protocol.readFirst?.length) {
    lines.push("");
    lines.push("Read first:");
    for (const item of protocol.readFirst.slice(0, 6)) {
      lines.push(`- ${item.path}: ${item.why}`);
    }
  }
  if (protocol.firstActions?.length) {
    lines.push("");
    lines.push("First actions:");
    for (const item of protocol.firstActions.slice(0, 5)) {
      lines.push(`- ${item.action} ${item.why}`);
    }
  }
  if (protocol.guardrails?.length) {
    lines.push("");
    lines.push("Guardrails:");
    for (const item of protocol.guardrails.slice(0, 5)) lines.push(`- ${item}`);
  }
  return lines.join("\n") || "- none";
}

function governanceLines(governance = {}) {
  const lines = [
    `- status: ${governance.status || "unknown"}`,
    governance.score ? `- score: ${governance.score}` : "",
    governance.summary ? `- summary: ${governance.summary}` : ""
  ].filter(Boolean);
  for (const domain of (governance.domains || []).slice(0, 4)) {
    lines.push(`- [${domain.status}] ${domain.label}: ${domain.detail}${domain.nextAction ? ` Next: ${domain.nextAction}` : ""}`);
  }
  if (governance.operatingContract?.length) {
    lines.push("");
    lines.push("Operating contract:");
    for (const item of governance.operatingContract.slice(0, 4)) lines.push(`- ${item}`);
  }
  return lines.join("\n") || "- none";
}

function continuityContractLines(contract = {}) {
  const lines = [
    `- status: ${contract.status || "unknown"}`,
    contract.contractId ? `- contract id: ${contract.contractId}` : "",
    contract.resume?.current?.title ? `- resume from: [${contract.resume.current.phase}/${contract.resume.current.status}] ${contract.resume.current.title}` : "",
    contract.resume?.nextAction ? `- next action: ${contract.resume.nextAction}` : ""
  ].filter(Boolean);
  if (contract.capabilities?.length) {
    lines.push("");
    lines.push("Capabilities:");
    for (const item of contract.capabilities.slice(0, 4)) lines.push(`- [${item.status}] ${item.label}: ${item.summary}`);
  }
  if (contract.proofChecklist?.length) {
    lines.push("");
    lines.push("Proof checklist:");
    for (const item of contract.proofChecklist.slice(0, 5)) lines.push(`- ${item.id}: ${item.statement}`);
  }
  return lines.join("\n") || "- none";
}

function graphTraceLines(trace = {}) {
  const lines = [
    `- status: ${trace.status || "unknown"}`,
    `- nodes: ${trace.nodeCount || 0}`,
    `- edges: ${trace.edgeCount || 0}`,
    `- provenance coverage: ${trace.provenanceCoverage || "0/0"}`,
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.coreNodes?.length) {
    lines.push("");
    lines.push("Core nodes:");
    for (const node of trace.coreNodes.slice(0, 6)) {
      lines.push(`- [${node.status}] ${node.id}: ${node.label}${node.refs?.length ? ` refs=${node.refs.slice(0, 3).join(", ")}` : ""}`);
    }
  }
  if (trace.keyRelations?.length) {
    lines.push("");
    lines.push("Key relations:");
    for (const edge of trace.keyRelations.slice(0, 6)) lines.push(`- ${edge.source} -${edge.label}-> ${edge.target}`);
  }
  return lines.join("\n") || "- none";
}

function memoryGraphLines(graph = {}) {
  const lines = [
    "- file: .project-agent/memory-graph.json",
    `- source: ${graph.source || "unknown"}`,
    `- nodes: ${graph.nodeCount || graph.nodes?.length || 0}`,
    `- edges: ${graph.edgeCount || graph.edges?.length || 0}`,
    `- provenance coverage: ${graph.provenanceCoverage || "0/0"}`,
    graph.nextAction ? `- next action: ${graph.nextAction}` : ""
  ].filter(Boolean);
  if (graph.provenanceRefs?.length) {
    lines.push("");
    lines.push("Provenance refs:");
    for (const ref of graph.provenanceRefs.slice(0, 6)) lines.push(`- ${ref}`);
  }
  return lines.join("\n") || "- none";
}

function takeoverPacketLines(packet = {}) {
  const lines = [
    "- file: .project-agent/takeover-packet.json",
    packet.schemaVersion ? `- schema: ${packet.schemaVersion}` : "",
    `- status: ${packet.status || "unknown"}`,
    `- can resume: ${packet.canResume ? "yes" : "no"}`,
    packet.cursor?.title ? `- cursor: [${packet.cursor.phase}/${packet.cursor.status}] ${packet.cursor.title}` : "",
    packet.nextCommand ? `- next command: ${packet.nextCommand}` : "",
    packet.summary ? `- summary: ${packet.summary}` : ""
  ].filter(Boolean);
  if (packet.firstActions?.length) {
    lines.push("");
    lines.push("First actions:");
    for (const item of packet.firstActions.slice(0, 5)) lines.push(`- ${item.action} ${item.why}`);
  }
  if (packet.firstRead?.length) {
    lines.push("");
    lines.push("Read order:");
    for (const item of packet.firstRead.slice(0, 6)) lines.push(`- ${item.path}: ${item.why || "read"}`);
  }
  return lines.join("\n") || "- none";
}

function architectureMapLines(map = {}) {
  const totals = map.totals || {};
  const lines = [
    "- file: .project-agent/architecture-map.json",
    map.schemaVersion ? `- schema: ${map.schemaVersion}` : "",
    `- root: ${map.root || "."}`,
    `- files: ${totals.files || map.files?.length || 0}`,
    `- directories: ${totals.directories || 0}`,
    `- changed: ${totals.changed || 0} (${totals.added || 0} added, ${totals.modified || 0} modified, ${totals.deleted || 0} deleted)`,
    map.nextAction ? `- next action: ${map.nextAction}` : ""
  ].filter(Boolean);
  if (map.modules?.length) {
    lines.push("");
    lines.push("Modules:");
    for (const module of map.modules.slice(0, 6)) lines.push(`- ${module.kind}: ${module.count || 0}`);
  }
  if (map.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of map.inspectOrder.slice(0, 6)) {
      lines.push(`- [${item.type || "file"}/${item.status || "changed"}] ${item.path}: ${item.reason || "inspect"}`);
    }
  }
  if (map.recentChanges?.length) {
    lines.push("");
    lines.push("Recent changes:");
    for (const file of map.recentChanges.slice(0, 6)) lines.push(`- [${file.status || "changed"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`);
  }
  return lines.join("\n") || "- none";
}

function architectureTraceLines(trace = {}) {
  const totals = trace.totals || {};
  const lines = [
    `- status: ${trace.status || "unknown"}`,
    `- files: ${totals.files || 0}`,
    `- changed: ${totals.changed || 0} (${totals.added || 0} added, ${totals.modified || 0} modified, ${totals.deleted || 0} deleted)`,
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.topFolders?.length) {
    lines.push("");
    lines.push("Top folders:");
    for (const folder of trace.topFolders.slice(0, 5)) lines.push(`- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${folder.latestFile ? ` latest=${folder.latestFile}` : ""}`);
  }
  if (trace.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trace.inspectOrder.slice(0, 6)) lines.push(`- [${item.type}/${item.status || "changed"}] ${item.path}: ${item.reason || "inspect"}`);
  }
  return lines.join("\n") || "- none";
}

function processTraceLines(trace = {}) {
  const lines = [
    "- file: .project-agent/process-trace.json",
    trace.schemaVersion ? `- schema: ${trace.schemaVersion}` : "",
    `- status: ${trace.status || "unknown"}`,
    `- events: ${trace.eventCount || 0}`,
    trace.activeWorkstream?.label ? `- active workstream: ${trace.activeWorkstream.label}` : "",
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.current) lines.push(`- current: [${trace.current.phase}/${trace.current.status}] ${trace.current.title}: ${compact(trace.current.detail, 220)}`);
  if (trace.previous) lines.push(`- previous: [${trace.previous.phase}/${trace.previous.status}] ${trace.previous.title}: ${compact(trace.previous.detail, 180)}`);
  if (trace.next) lines.push(`- next: [${trace.next.phase}/${trace.next.status}] ${trace.next.title}: ${compact(trace.next.detail, 180)}`);
  if (trace.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trace.inspectOrder.slice(0, 6)) lines.push(`- [${item.phase}/${item.status}] ${item.title}${item.workstream?.label ? ` (${item.workstream.label})` : ""}`);
  }
  if (trace.filesTouched?.length) {
    lines.push("");
    lines.push("Files touched:");
    for (const file of trace.filesTouched.slice(0, 6)) lines.push(`- [${file.status || "file"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`);
  }
  return lines.join("\n") || "- none";
}

function developmentTrailLines(trail = {}) {
  const lines = [
    "- file: .project-agent/development-trail.json",
    trail.schemaVersion ? `- schema: ${trail.schemaVersion}` : "",
    `- status: ${trail.status || "unknown"}`,
    trail.fileCoverage ? `- linked steps: ${trail.fileCoverage}` : "",
    trail.current?.title ? `- current: [${trail.current.phase}/${trail.current.status}] ${trail.current.title}` : "",
    trail.nextAction ? `- next action: ${trail.nextAction}` : ""
  ].filter(Boolean);
  for (const step of (trail.steps || []).slice(0, 5)) {
    const files = (step.files || []).slice(0, 3).map((file) => file.path).join(", ") || "none";
    const folders = (step.folders || []).slice(0, 3).map((folder) => folder.folder).join(", ") || "none";
    lines.push(`- [${step.label || step.phase}/${step.status || "unknown"}] ${step.title || step.id}; risk=${step.risk || "unknown"}; files=${files}; folders=${folders}`);
  }
  if (trail.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trail.inspectOrder.slice(0, 6)) lines.push(`- [${item.type}/${item.status || "inspect"}] ${item.title || item.path || item.id}: ${item.reason || "inspect"}`);
  }
  return lines.join("\n") || "- none";
}

function interruptedWorkLines(interrupted = {}) {
  const lines = [
    `- status: ${interrupted.status || "unknown"}`,
    `- count: ${interrupted.count || 0}`,
    interrupted.nextAction ? `- next action: ${interrupted.nextAction}` : ""
  ].filter(Boolean);
  for (const item of (interrupted.items || []).slice(0, 5)) {
    const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 3).join(", ")}` : "";
    lines.push(`- [${item.leaseStatus || "unknown"}] ${item.agentId}: ${item.phase}/${item.status} ${item.title}${refs}`);
  }
  return lines.join("\n") || "- none";
}

function agentRunbookLines(runbook = {}) {
  const lines = [
    `- status: ${runbook.status || "unknown"}`,
    runbook.currentState ? `- current state: ${runbook.currentState}` : "",
    runbook.nextState ? `- next state: ${runbook.nextState}` : "",
    runbook.activeStepId ? `- active step: ${runbook.activeStepId}` : "",
    runbook.nextCommand ? `- next command: ${runbook.nextCommand}` : "",
    runbook.blockingReason ? `- blocking reason: ${runbook.blockingReason}` : "",
    `- can take over: ${runbook.canTakeOver ? "yes" : "no"}`
  ].filter(Boolean);
  for (const step of (runbook.steps || []).slice(0, 5)) {
    const refs = step.refs?.length ? ` refs=${step.refs.slice(0, 3).join(", ")}` : "";
    lines.push(`- [${step.status || "pending"}] ${step.id}: ${step.label}${step.required ? " [required]" : ""}`);
    if (step.command) lines.push(`  command: ${step.command}`);
    if (step.success) lines.push(`  success: ${step.success}${refs}`);
  }
  if (runbook.proofGates?.length) {
    lines.push("");
    lines.push("Proof gates:");
    for (const gate of runbook.proofGates.slice(0, 4)) lines.push(`- [${gate.status || "unknown"}] ${gate.id}: ${gate.check}`);
  }
  return lines.join("\n") || "- none";
}

export function renderResumeMarkdown({ recovery }) {
  const continuity = recovery.continuity || {};
  const cursor = continuity.processCursor;
  const goal = continuity.activeGoal;
  return [
    "# Next Agent Resume Packet",
    "",
    "You are taking over a project after a prior agent/session may have stopped mid-work.",
    "Do not rely on chat history. Use the project state files below as the source of truth.",
    "",
    "## Required First Steps",
    "",
    "1. Read `.project-agent/takeover-summary.json`.",
    "2. Read `.project-agent/context-starter-prompt.md`.",
    "3. Read `.project-agent/takeover-packet.json` for first actions.",
    "4. Read `.project-agent/process-trace.json#current` and `.project-agent/architecture-map.json#recentChanges`.",
    "5. Read `.project-agent/agent-context-bundle.json#quickStart` only if the summary needs bundle detail.",
    "6. Read `.project-agent/continuity-contract.json` and `.project-agent/state-manifest.json`.",
    "7. Read this file: `.project-agent/resume.md`.",
    "8. Read `.project-agent/recovery.md` if the prior session may have stopped mid-work.",
    "9. Inspect changed files before editing.",
    "10. Continue from the current cursor; record new events before and after tool calls.",
    "",
    "## Current Objective",
    "",
    goal ? `- ${goal.objective}\n- goal id: ${goal.id}\n- status: ${goal.status}` : "- No active goal found.",
    "",
    "## Project Kernel",
    "",
    kernelLines(continuity.kernelSummary),
    "",
    "## Project Governance Matrix",
    "",
    governanceLines(continuity.governance),
    "",
    "## Agent-Neutral Continuity Contract",
    "",
    continuityContractLines(continuity.continuityContract),
    "",
    "## Memory Graph Trace",
    "",
    graphTraceLines(continuity.graphTrace),
    "",
    "## Memory Graph Snapshot",
    "",
    memoryGraphLines(continuity.memoryGraph),
    "",
    "## Takeover Readiness",
    "",
    readinessLines(continuity.takeoverReadiness),
    "",
    "## Interrupted Work",
    "",
    interruptedWorkLines(continuity.interruptedWork || continuity.continuityContract?.agentState?.interruptedWork),
    "",
    "## Takeover Drill",
    "",
    renderTakeoverDrillMarkdown(continuity.takeoverDrill),
    "",
    "## Next Agent Takeover Packet",
    "",
    takeoverPacketLines(continuity.takeoverPacket || continuity.takeoverDrill?.nextAgentBrief),
    "",
    "## New Agent Start Protocol",
    "",
    startProtocolLines(continuity.startProtocol),
    "",
    "## Agent Runbook",
    "",
    agentRunbookLines(continuity.agentRunbook || continuity.continuityContract?.agentRunbook),
    "",
    "## Current Cursor",
    "",
    eventLine(cursor),
    "",
    "## Process Trace Snapshot",
    "",
    processTraceLines(continuity.processTrace),
    "",
    "## Development Trail",
    "",
    developmentTrailLines(continuity.developmentTrail),
    "",
    "## Workstream Cursor",
    "",
    workstreamLines(continuity.workstreams),
    "",
    "## Previous Event",
    "",
    eventLine(continuity.previousEvent),
    "",
    "## Expected Next Event",
    "",
    eventLine(continuity.nextEvent),
    "",
    "## Agent Leases",
    "",
    (continuity.agentLeases || []).slice(0, 8).map(agentLine).join("\n") || "- none",
    "",
    "## Handoff Snapshot",
    "",
    continuity.handoffSnapshot
      ? `- status: ${continuity.handoffSnapshot.status}\n- reason: ${continuity.handoffSnapshot.reason || "unknown"}\n- updated: ${continuity.handoffSnapshot.updatedAt || "unknown"}`
      : "- none",
    "",
    "## Changed Files To Inspect",
    "",
    (continuity.changedFiles || []).slice(0, 8).map(fileLine).join("\n") || "- none",
    "",
    "## Architecture Map Snapshot",
    "",
    architectureMapLines(continuity.architectureMap),
    "",
    "## Architecture Impact",
    "",
    (continuity.architectureImpact?.topFolders || continuity.architectureImpact?.folders || []).slice(0, 6).map(folderLine).join("\n") || "- none",
    "",
    "## Architecture Trace",
    "",
    architectureTraceLines(continuity.architectureTrace),
    "",
    "## Recent Runtime Events",
    "",
    (continuity.recentEvents || []).slice(0, 8).map(eventLine).join("\n") || "- none",
    "",
    "## Read-First Files",
    "",
    (continuity.stateRefs || []).map((ref) => `- ${ref}`).join("\n") || "- none",
    "",
    "## Operating Rules",
    "",
    "- Before running a tool or editing a file, write a `current` event via `/api/events` or `npm run event`.",
    "- After the tool completes, write a `done` or `failed` event.",
    "- Save evidence before claiming completion.",
    "- Regenerate `.project-agent/recovery.md` or `.project-agent/resume.md` before handoff.",
    "",
    "## Full Recovery Brief",
    "",
    "See `.project-agent/recovery.md` for full details.",
    ""
  ].join("\n");
}

export async function buildResumePacket(projectDir, options = {}) {
  const recovery = await buildRecoveryBrief(projectDir, {
    ...options,
    writeFile: options.writeRecovery !== false,
    expectedFiles: [...(options.expectedFiles || []), ...(options.writeFile ? [".project-agent/resume.md"] : [])]
  });
  let markdown = renderResumeMarkdown({ recovery });
  let file;
  if (options.writeFile) {
    file = writeResumeFile(projectDir, markdown);
    recovery.continuity = attachTakeoverDrill(projectDir, recovery.continuity, {
      expectedFiles: options.expectedFiles || []
    });
    recovery.insights.continuity = recovery.continuity;
    if (recovery.file) {
      recovery.markdown = renderRecoveryMarkdown({ insights: recovery.insights });
      writeRecoveryFile(projectDir, recovery.markdown);
    }
    markdown = renderResumeMarkdown({ recovery });
    file = writeResumeFile(projectDir, markdown);
  }
  return { markdown, recovery: recovery.markdown, recoveryFile: recovery.file, continuity: recovery.continuity, file };
}

export function writeResumeFile(projectDir, markdown) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "resume.md");
  writeFileSync(file, markdown, "utf8");
  return file;
}
