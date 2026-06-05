import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildArchitecture } from "./architecture.js";
import { buildInsights } from "./insights.js";
import { readState, runJson, summarizeState } from "./project-agent.js";
import { readRuntime, summarizeAgentLeases, writeContinuity } from "./runtime-state.js";
import { attachTakeoverDrill, renderTakeoverDrillMarkdown } from "./takeover-drill.js";

function line(value, fallback = "unknown") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function mdList(items, render, empty = "- none") {
  const values = (items || []).filter(Boolean);
  if (!values.length) return empty;
  return values.map(render).join("\n");
}

function renderEvent(event) {
  if (!event) return "- none";
  const bits = [event.phase, event.status, event.workstream?.label, event.source, event.tool].filter(Boolean).join("/");
  const refs = event.refs?.length ? ` refs=${event.refs.slice(0, 4).join(", ")}` : "";
  return `- [${bits || "event"}] ${line(event.title, "Event")}: ${line(event.detail, "")}${refs}`;
}

function renderFile(file) {
  const stats = file.summary || (Number.isFinite(file.additions) || Number.isFinite(file.deletions) ? `+${file.additions || 0}/-${file.deletions || 0}` : "");
  const hash = file.hash ? ` hash=${file.hash}` : "";
  return `- [${file.status || "changed"}] ${file.path}${stats ? ` ${stats}` : ""}${hash}`;
}

function renderFolderImpact(folder) {
  const statuses = [
    folder.added ? `${folder.added} added` : "",
    folder.modified ? `${folder.modified} modified` : "",
    folder.deleted ? `${folder.deleted} deleted` : ""
  ].filter(Boolean).join(", ");
  const kinds = folder.kinds?.length ? ` kinds=${folder.kinds.join(",")}` : "";
  return `- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${statuses ? ` (${statuses})` : ""}${kinds}${folder.latestFile ? ` latest=${folder.latestFile}` : ""}`;
}

function renderTarget(target) {
  return `- [${target.verified ? "verified" : "open"}] ${target.id}: ${target.label}`;
}

function renderAgent(agent) {
  const bits = [agent.effectiveStatus || agent.status || "active", agent.role, agent.goalId].filter(Boolean).join("/");
  const age = Number.isFinite(agent.ageSeconds) ? ` age=${agent.ageSeconds}s` : "";
  return `- [${bits}] ${agent.id}${age}${agent.note ? `: ${line(agent.note, "")}` : ""}`;
}

function renderKernel(kernel = {}) {
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

function renderWorkstreams(workstreams = {}) {
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

function renderReadiness(readiness = {}) {
  const checks = readiness.checks || [];
  const lines = [
    `- status: ${readiness.status || "unknown"}`,
    `- can take over: ${readiness.canTakeOver ? "yes" : "no"}`,
    readiness.score ? `- score: ${readiness.score}` : "",
    readiness.summary ? `- summary: ${readiness.summary}` : ""
  ].filter(Boolean);
  for (const check of checks.slice(0, 9)) {
    const refs = check.refs?.length ? ` refs=${check.refs.slice(0, 4).join(", ")}` : "";
    lines.push(`- [${check.status}] ${check.label}: ${check.detail}${refs}`);
  }
  return lines.join("\n") || "- none";
}

function renderStartProtocol(protocol = {}) {
  const lines = [];
  if (protocol.status) lines.push(`- status: ${protocol.status}`);
  if (protocol.resumeFrom?.objective) lines.push(`- objective: ${protocol.resumeFrom.objective}`);
  if (protocol.resumeFrom?.workstream?.label) lines.push(`- workstream: ${protocol.resumeFrom.workstream.label}`);
  if (protocol.readFirst?.length) {
    lines.push("");
    lines.push("Read first:");
    for (const item of protocol.readFirst.slice(0, 8)) {
      lines.push(`- ${item.path}: ${item.why} Look for: ${item.lookFor}`);
    }
  }
  if (protocol.firstActions?.length) {
    lines.push("");
    lines.push("First actions:");
    for (const item of protocol.firstActions.slice(0, 6)) {
      const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- ${item.action} ${item.why}${refs}`);
    }
  }
  if (protocol.guardrails?.length) {
    lines.push("");
    lines.push("Guardrails:");
    for (const item of protocol.guardrails.slice(0, 6)) lines.push(`- ${item}`);
  }
  return lines.join("\n") || "- none";
}

function renderGovernance(governance = {}) {
  const lines = [
    `- status: ${governance.status || "unknown"}`,
    governance.score ? `- score: ${governance.score}` : "",
    governance.summary ? `- summary: ${governance.summary}` : ""
  ].filter(Boolean);
  for (const domain of (governance.domains || []).slice(0, 6)) {
    const refs = domain.refs?.length ? ` refs=${domain.refs.slice(0, 4).join(", ")}` : "";
    lines.push(`- [${domain.status}] ${domain.label}: ${domain.detail}${domain.nextAction ? ` Next: ${domain.nextAction}` : ""}${refs}`);
  }
  if (governance.operatingContract?.length) {
    lines.push("");
    lines.push("Operating contract:");
    for (const item of governance.operatingContract.slice(0, 6)) lines.push(`- ${item}`);
  }
  return lines.join("\n") || "- none";
}

function renderContinuityContract(contract = {}) {
  const lines = [
    `- status: ${contract.status || "unknown"}`,
    contract.contractId ? `- contract id: ${contract.contractId}` : "",
    contract.resume?.objective ? `- objective: ${contract.resume.objective}` : "",
    contract.resume?.current?.title ? `- resume from: [${contract.resume.current.phase}/${contract.resume.current.status}] ${contract.resume.current.title}` : "",
    contract.resume?.nextAction ? `- next action: ${contract.resume.nextAction}` : ""
  ].filter(Boolean);
  if (contract.capabilities?.length) {
    lines.push("");
    lines.push("Capabilities:");
    for (const item of contract.capabilities.slice(0, 6)) {
      const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- [${item.status}] ${item.label}: ${item.summary}${refs}`);
    }
  }
  if (contract.proofChecklist?.length) {
    lines.push("");
    lines.push("Proof checklist:");
    for (const item of contract.proofChecklist.slice(0, 6)) lines.push(`- ${item.id}: ${item.statement}`);
  }
  return lines.join("\n") || "- none";
}

function renderGraphTrace(trace = {}) {
  const lines = [
    `- status: ${trace.status || "unknown"}`,
    `- source: ${trace.source || "project-agent"}`,
    `- nodes: ${trace.nodeCount || 0}`,
    `- edges: ${trace.edgeCount || 0}`,
    `- provenance coverage: ${trace.provenanceCoverage || "0/0"}`,
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.coreNodes?.length) {
    lines.push("");
    lines.push("Core nodes:");
    for (const node of trace.coreNodes.slice(0, 8)) {
      const refs = node.refs?.length ? ` refs=${node.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- [${node.status}] ${node.id}: ${node.label}${node.meta ? ` (${node.meta})` : ""}${refs}`);
    }
  }
  if (trace.keyRelations?.length) {
    lines.push("");
    lines.push("Key relations:");
    for (const edge of trace.keyRelations.slice(0, 10)) {
      const refs = edge.refs?.length ? ` refs=${edge.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- ${edge.source} -${edge.label}-> ${edge.target}${refs}`);
    }
  }
  return lines.join("\n") || "- none";
}

function renderMemoryGraphSnapshot(graph = {}) {
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
    for (const ref of graph.provenanceRefs.slice(0, 8)) lines.push(`- ${ref}`);
  }
  return lines.join("\n") || "- none";
}

function renderTakeoverPacketSnapshot(packet = {}) {
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
    for (const item of packet.firstActions.slice(0, 6)) lines.push(`- ${item.action} ${item.why}`);
  }
  if (packet.firstRead?.length) {
    lines.push("");
    lines.push("Read order:");
    for (const item of packet.firstRead.slice(0, 8)) lines.push(`- ${item.path}: ${item.why || "read"}`);
  }
  return lines.join("\n") || "- none";
}

function renderArchitectureMapSnapshot(map = {}) {
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
    for (const module of map.modules.slice(0, 8)) lines.push(`- ${module.kind}: ${module.count || 0}`);
  }
  if (map.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of map.inspectOrder.slice(0, 8)) {
      lines.push(`- [${item.type || "file"}/${item.status || "changed"}] ${item.path}: ${item.reason || "inspect"}`);
    }
  }
  if (map.recentChanges?.length) {
    lines.push("");
    lines.push("Recent changes:");
    for (const file of map.recentChanges.slice(0, 8)) lines.push(`- [${file.status || "changed"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`);
  }
  return lines.join("\n") || "- none";
}

function renderArchitectureTrace(trace = {}) {
  const totals = trace.totals || {};
  const lines = [
    `- status: ${trace.status || "unknown"}`,
    `- files: ${totals.files || 0}`,
    `- directories: ${totals.directories || 0}`,
    `- changed: ${totals.changed || 0} (${totals.added || 0} added, ${totals.modified || 0} modified, ${totals.deleted || 0} deleted)`,
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.topFolders?.length) {
    lines.push("");
    lines.push("Top folders:");
    for (const folder of trace.topFolders.slice(0, 8)) {
      const refs = folder.refs?.length ? ` refs=${folder.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${folder.latestFile ? ` latest=${folder.latestFile}` : ""}${refs}`);
    }
  }
  if (trace.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trace.inspectOrder.slice(0, 10)) {
      const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 3).join(", ")}` : "";
      lines.push(`- [${item.type}/${item.status || "changed"}] ${item.path}: ${item.reason || "inspect"}${refs}`);
    }
  }
  return lines.join("\n") || "- none";
}

function renderProcessTrace(trace = {}) {
  const lines = [
    "- file: .project-agent/process-trace.json",
    trace.schemaVersion ? `- schema: ${trace.schemaVersion}` : "",
    `- status: ${trace.status || "unknown"}`,
    `- events: ${trace.eventCount || 0}`,
    trace.activeWorkstream?.label ? `- active workstream: ${trace.activeWorkstream.label}` : "",
    trace.nextAction ? `- next action: ${trace.nextAction}` : ""
  ].filter(Boolean);
  if (trace.current) lines.push(`- current: [${trace.current.phase}/${trace.current.status}] ${trace.current.title}: ${line(trace.current.detail, "")}`);
  if (trace.previous) lines.push(`- previous: [${trace.previous.phase}/${trace.previous.status}] ${trace.previous.title}: ${line(trace.previous.detail, "")}`);
  if (trace.next) lines.push(`- next: [${trace.next.phase}/${trace.next.status}] ${trace.next.title}: ${line(trace.next.detail, "")}`);
  if (trace.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trace.inspectOrder.slice(0, 10)) {
      const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : "";
      lines.push(`- [${item.phase}/${item.status}] ${item.title}${item.workstream?.label ? ` (${item.workstream.label})` : ""}${refs}`);
    }
  }
  if (trace.filesTouched?.length) {
    lines.push("");
    lines.push("Files touched:");
    for (const file of trace.filesTouched.slice(0, 8)) lines.push(`- [${file.status || "file"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`);
  }
  return lines.join("\n") || "- none";
}

function renderDevelopmentTrail(trail = {}) {
  const lines = [
    "- file: .project-agent/development-trail.json",
    trail.schemaVersion ? `- schema: ${trail.schemaVersion}` : "",
    `- status: ${trail.status || "unknown"}`,
    trail.fileCoverage ? `- linked steps: ${trail.fileCoverage}` : "",
    trail.current?.title ? `- current: [${trail.current.phase}/${trail.current.status}] ${trail.current.title}` : "",
    trail.nextAction ? `- next action: ${trail.nextAction}` : ""
  ].filter(Boolean);
  for (const step of (trail.steps || []).slice(0, 6)) {
    const files = (step.files || []).slice(0, 4).map((file) => file.path).join(", ") || "none";
    const folders = (step.folders || []).slice(0, 3).map((folder) => folder.folder).join(", ") || "none";
    lines.push(`- [${step.label || step.phase}/${step.status || "unknown"}] ${step.title || step.id}; risk=${step.risk || "unknown"}; files=${files}; folders=${folders}`);
  }
  if (trail.inspectOrder?.length) {
    lines.push("");
    lines.push("Inspect order:");
    for (const item of trail.inspectOrder.slice(0, 8)) lines.push(`- [${item.type}/${item.status || "inspect"}] ${item.title || item.path || item.id}: ${item.reason || "inspect"}`);
  }
  return lines.join("\n") || "- none";
}

function renderInterruptedWork(interrupted = {}) {
  const lines = [
    `- status: ${interrupted.status || "unknown"}`,
    `- count: ${interrupted.count || 0}`,
    interrupted.nextAction ? `- next action: ${interrupted.nextAction}` : ""
  ].filter(Boolean);
  for (const item of (interrupted.items || []).slice(0, 6)) {
    const refs = item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : "";
    lines.push(`- [${item.leaseStatus || "unknown"}] ${item.agentId}: ${item.phase}/${item.status} ${item.title}${refs}`);
  }
  return lines.join("\n") || "- none";
}

function renderAgentRunbook(runbook = {}) {
  const lines = [
    `- status: ${runbook.status || "unknown"}`,
    runbook.currentState ? `- current state: ${runbook.currentState}` : "",
    runbook.nextState ? `- next state: ${runbook.nextState}` : "",
    runbook.activeStepId ? `- active step: ${runbook.activeStepId}` : "",
    runbook.nextCommand ? `- next command: ${runbook.nextCommand}` : "",
    runbook.blockingReason ? `- blocking reason: ${runbook.blockingReason}` : "",
    `- can take over: ${runbook.canTakeOver ? "yes" : "no"}`
  ].filter(Boolean);
  for (const step of (runbook.steps || []).slice(0, 7)) {
    const refs = step.refs?.length ? ` refs=${step.refs.slice(0, 4).join(", ")}` : "";
    lines.push(`- [${step.status || "pending"}] ${step.id}: ${step.label}${step.required ? " [required]" : ""}`);
    if (step.command) lines.push(`  command: ${step.command}`);
    if (step.success) lines.push(`  success: ${step.success}${refs}`);
  }
  if (runbook.proofGates?.length) {
    lines.push("");
    lines.push("Proof gates:");
    for (const gate of runbook.proofGates.slice(0, 6)) lines.push(`- [${gate.status || "unknown"}] ${gate.id}: ${gate.check}`);
  }
  return lines.join("\n") || "- none";
}

export function renderRecoveryMarkdown({ insights }) {
  const continuity = insights.continuity || {};
  const goal = continuity.activeGoal;
  const graph = insights.knowledgeGraph || {};
  return [
    "# Project Recovery Brief",
    "",
    `Generated: ${insights.generatedAt || continuity.generatedAt || new Date().toISOString()}`,
    `Project: ${continuity.project || insights.provenance?.sourceOfTruth || "project"}`,
    `Role: ${continuity.role || "unknown"}`,
    "",
    "## Start Here",
    "",
    "1. Read `.project-agent/takeover-summary.json`.",
    "2. Read `.project-agent/context-starter-prompt.md`.",
    "3. Read `.project-agent/takeover-packet.json` for first actions.",
    "4. Read `.project-agent/process-trace.json#current` and `.project-agent/architecture-map.json#recentChanges`.",
    "5. Read `.project-agent/agent-context-bundle.json#quickStart` only if the summary needs bundle detail.",
    "6. Read `.project-agent/continuity-contract.json` and `.project-agent/state-manifest.json`.",
    "7. Read `.project-agent/recovery.md`.",
    "8. Inspect changed files before editing.",
    "9. Resume from `Current Cursor`; do not rely on chat history.",
    "",
    "## Active Goal",
    "",
    goal
      ? `- id: ${goal.id}\n- status: ${goal.status}\n- objective: ${goal.objective}`
      : "- none",
    "",
    "## Project Kernel",
    "",
    renderKernel(continuity.kernelSummary),
    "",
    "## Project Governance Matrix",
    "",
    renderGovernance(continuity.governance || insights.governance),
    "",
    "## Agent-Neutral Continuity Contract",
    "",
    renderContinuityContract(continuity.continuityContract || insights.continuityContract),
    "",
    "## Memory Graph Trace",
    "",
    renderGraphTrace(continuity.graphTrace || insights.graphTrace),
    "",
    "## Memory Graph Snapshot",
    "",
    renderMemoryGraphSnapshot(continuity.memoryGraph),
    "",
    "## Takeover Readiness",
    "",
    renderReadiness(continuity.takeoverReadiness),
    "",
    "## Interrupted Work",
    "",
    renderInterruptedWork(continuity.interruptedWork || continuity.continuityContract?.agentState?.interruptedWork),
    "",
    "## Takeover Drill",
    "",
    renderTakeoverDrillMarkdown(continuity.takeoverDrill),
    "",
    "## Next Agent Takeover Packet",
    "",
    renderTakeoverPacketSnapshot(continuity.takeoverPacket || continuity.takeoverDrill?.nextAgentBrief),
    "",
    "## New Agent Start Protocol",
    "",
    renderStartProtocol(continuity.startProtocol),
    "",
    "## Agent Runbook",
    "",
    renderAgentRunbook(continuity.agentRunbook || continuity.continuityContract?.agentRunbook),
    "",
    "## Acceptance Targets",
    "",
    mdList(insights.targets, renderTarget),
    "",
    "## Current Cursor",
    "",
    renderEvent(continuity.processCursor),
    "",
    "## Process Trace Snapshot",
    "",
    renderProcessTrace(continuity.processTrace || insights.processTrace),
    "",
    "## Development Trail",
    "",
    renderDevelopmentTrail(continuity.developmentTrail || insights.developmentTrail),
    "",
    "## Workstream Cursor",
    "",
    renderWorkstreams(continuity.workstreams),
    "",
    "## Previous / Next",
    "",
    "Previous:",
    renderEvent(continuity.previousEvent),
    "",
    "Next:",
    renderEvent(continuity.nextEvent),
    "",
    "## Agent Leases",
    "",
    mdList(continuity.agentLeases?.slice(0, 8), renderAgent),
    "",
    "## Handoff Snapshot",
    "",
    continuity.handoffSnapshot
      ? `- status: ${continuity.handoffSnapshot.status}\n- reason: ${continuity.handoffSnapshot.reason || "unknown"}\n- updated: ${continuity.handoffSnapshot.updatedAt || "unknown"}`
      : "- none",
    "",
    "## Recent Events",
    "",
    mdList(continuity.recentEvents?.slice(0, 10), renderEvent),
    "",
    "## Changed Files",
    "",
    mdList(continuity.changedFiles?.slice(0, 12), renderFile),
    "",
    "## Architecture Map Snapshot",
    "",
    renderArchitectureMapSnapshot(continuity.architectureMap),
    "",
    "## Architecture Impact",
    "",
    mdList((continuity.architectureImpact?.topFolders || continuity.architectureImpact?.folders || []).slice(0, 8), renderFolderImpact),
    "",
    "## Architecture Trace",
    "",
    renderArchitectureTrace(continuity.architectureTrace || insights.architectureTrace),
    "",
    "## Architecture",
    "",
    `- files: ${continuity.architectureTotals?.files ?? "unknown"}`,
    `- directories: ${continuity.architectureTotals?.directories ?? "unknown"}`,
    `- recent changed: ${continuity.changedFiles?.length || 0}`,
    "",
    "## Memory Graph",
    "",
    `- nodes: ${graph.nodes?.length || 0}`,
    `- edges: ${graph.edges?.length || 0}`,
    `- source: ${graph.source || "project-agent"}`,
    "",
    "## Read-First Files",
    "",
    mdList(continuity.stateRefs, (ref) => `- ${ref}`),
    "",
    "## Next Agent Instructions",
    "",
    mdList(continuity.nextAgentInstructions, (item) => `- ${item}`),
    ""
  ].join("\n");
}

export async function buildRecoveryBrief(projectDir, options = {}) {
  const rawState = readState(projectDir);
  const summary = summarizeState(rawState);
  const architecture = buildArchitecture(projectDir, { persist: options.persistArchitecture !== false });
  const runtime = readRuntime(projectDir);
  let packet = null;
  if (summary.initialized) {
    const role = options.role || "coding_agent";
    const goal = options.goal || summary.activeGoal?.id;
    const args = ["kernel", "--role", role, "--format", "json"];
    if (goal) args.push("--goal", goal);
    packet = await runJson(projectDir, args);
  }
  const insights = await buildInsights({
    projectDir,
    rawState,
    summary,
    packet,
    architecture,
    runtimeEvents: runtime.events || [],
    hookIngresses: runtime.hookIngresses || [],
    agentLeases: summarizeAgentLeases(runtime),
    handoffSnapshot: options.handoffSnapshot || runtime.handoffSnapshot || null,
    terminalSnapshot: options.terminalSnapshot || { backend: "recovery" },
    agentmemoryUrl: options.agentmemoryUrl,
    agentmemorySecret: options.agentmemorySecret
  });
  insights.continuity = writeContinuity(projectDir, insights.continuity);
  insights.continuity = attachTakeoverDrill(projectDir, insights.continuity, {
    expectedFiles: [...(options.expectedFiles || []), ...(options.writeFile ? [".project-agent/recovery.md"] : [])]
  });
  let markdown = renderRecoveryMarkdown({ insights });
  let file;
  if (options.writeFile) {
    file = writeRecoveryFile(projectDir, markdown);
    insights.continuity = attachTakeoverDrill(projectDir, insights.continuity, {
      expectedFiles: options.expectedFiles || []
    });
    markdown = renderRecoveryMarkdown({ insights });
    file = writeRecoveryFile(projectDir, markdown);
  }
  return { markdown, insights, continuity: insights.continuity, file };
}

export function writeRecoveryFile(projectDir, markdown) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "recovery.md");
  writeFileSync(file, markdown, "utf8");
  return file;
}

export function recoveryFileExists(projectDir) {
  return existsSync(path.join(projectDir, ".project-agent", "recovery.md"));
}
