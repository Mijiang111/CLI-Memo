import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildResumePacket } from "./resume.js";
import { buildContinuityAudit, writeContinuityAudit } from "./continuity-audit.js";

function compact(value, max = 700) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function listLines(items, render, empty = "- none") {
  const values = (items || []).filter(Boolean);
  if (!values.length) return empty;
  return values.map(render).join("\n");
}

function renderCursor(cursor = {}) {
  if (!cursor?.title) return "- none";
  const refs = cursor.refs?.length ? `\n- refs: ${cursor.refs.slice(0, 6).join(", ")}` : "";
  return `- [${cursor.phase || "event"}/${cursor.status || "unknown"}] ${cursor.title}\n- detail: ${compact(cursor.detail, 500)}${refs}`;
}

function renderPrompt({ continuity }) {
  const packet = continuity.takeoverPacket || continuity.takeoverDrill?.nextAgentBrief || {};
  const runbook = continuity.agentRunbook || continuity.continuityContract?.agentRunbook || packet.agentRunbook || {};
  const goal = continuity.activeGoal || {};
  const interrupted = continuity.interruptedWork || continuity.continuityContract?.agentState?.interruptedWork || packet.interruptedWork || {};
  const changedFiles = continuity.changedFiles || packet.changedFiles || [];
  const folders = continuity.architectureImpact?.topFolders || continuity.architectureImpact?.folders || packet.impactedFolders || [];
  const disclosureGate = continuity.agentContextBundle?.validation?.disclosureGate || {};
  const promptPacking = disclosureGate.packing || {};
  const preEditRisk = continuity.preEditRisk || continuity.agentContextBundle?.validation?.preEditRisk || {};
  const freshnessGate = continuity.freshnessGate || continuity.agentContextBundle?.validation?.freshnessGate || continuity.continuityContract?.freshnessGate || {};
  const runtimeEval = continuity.runtimeEval || continuity.agentContextBundle?.validation?.runtimeEval || continuity.continuityContract?.runtimeEval || {};
  const phaseLedger = continuity.phaseLedger || continuity.agentContextBundle?.validation?.phaseLedger || continuity.continuityContract?.phaseLedger || {};
  const checkpointLedger = continuity.checkpointLedger || continuity.agentContextBundle?.validation?.checkpointLedger || continuity.continuityContract?.checkpointLedger || {};
  const decisionLedger = continuity.decisionLedger || continuity.agentContextBundle?.validation?.decisionLedger || continuity.continuityContract?.decisionLedger || {};
  const stateBoundary = continuity.stateBoundary || continuity.agentContextBundle?.validation?.stateBoundary || continuity.continuityContract?.stateBoundary || {};
  const codeGraph = continuity.codeGraph || continuity.architectureTrace?.codeGraph || continuity.architectureMap?.codeGraph || continuity.agentContextBundle?.architecture?.codeGraph || {};
  const hookIngressAudit = continuity.hookIngressAudit || continuity.agentContextBundle?.validation?.hookIngressAudit || continuity.continuityContract?.hookIngressAudit || {};
  const provenanceLedger = continuity.agentContextBundle?.validation?.provenanceLedger || {};
  const attentionPack = continuity.agentContextBundle?.validation?.attentionPack || {};
  const handoffLifecycle = continuity.handoffLifecycle || continuity.agentContextBundle?.handoff?.lifecycle || continuity.continuityContract?.handoffLifecycle || {};
  return [
    "# Next Agent Starter Prompt",
    "",
    "You are taking over this project after a prior agent may have stopped mid-work. Do not rely on previous chat history. Treat repository files under `.project-agent/` as the source of truth.",
    "",
    "## Mission",
    "",
    goal.objective || packet.objective || "Continue the active project goal.",
    "",
    "## Mandatory Read Order",
    "",
    listLines(packet.firstRead || continuity.startProtocol?.readFirst || continuity.stateRefs, (item, index) => {
      const ref = typeof item === "string" ? item : item.path;
      const why = typeof item === "string" ? "" : item.why || item.lookFor || "";
      return `${index + 1}. Read \`${ref}\`${why ? ` - ${why}` : ""}`;
    }),
    "",
    "## Current Cursor",
    "",
    renderCursor(packet.cursor || continuity.processCursor || continuity.processTrace?.current),
    "",
    "## Required First Actions",
    "",
    listLines(packet.firstActions || continuity.startProtocol?.firstActions, (item, index) => `${index + 1}. ${item.action}${item.why ? `\n   - why: ${item.why}` : ""}${item.refs?.length ? `\n   - refs: ${item.refs.slice(0, 6).join(", ")}` : ""}`),
    "",
    "## Next Command",
    "",
    packet.nextCommand || runbook.nextCommand ? `\`${packet.nextCommand || runbook.nextCommand}\`` : "- none",
    "",
    "## Handoff Lifecycle",
    "",
    `- status: ${handoffLifecycle.status || "unknown"}`,
    `- summary: ${handoffLifecycle.summary || "No typed handoff lifecycle is embedded."}`,
    handoffLifecycle.expiresAt ? `- expires at: ${handoffLifecycle.expiresAt}` : "- expires at: unknown",
    `- next action: ${handoffLifecycle.nextAction || "Run bundle verification before editing."}`,
    "",
    "## Attention Pack",
    "",
    `- status: ${attentionPack.status || "unknown"}`,
    `- estimated tokens: ${attentionPack.budget?.estimatedTokens || 0} / ${attentionPack.budget?.budgetTokens || 0}`,
    `- summary: ${attentionPack.summary || "No top-of-mind attention pack is embedded."}`,
    `- next action: ${attentionPack.nextAction || "Start from the bundle, then verify source refs before editing."}`,
    "Top items:",
    listLines((attentionPack.items || []).slice(0, 8), (item) => `- #${item.rank || "?"} [${item.kind || "item"}] ${item.label}: ${item.text}${item.refs?.length ? `\n   - refs: ${item.refs.slice(0, 3).join(", ")}` : ""}`),
    "",
    "## Freshness Gate",
    "",
    `- status: ${freshnessGate.status || "unknown"}`,
    `- valid until: ${freshnessGate.validity?.validUntil || "unknown"}`,
    `- git: ${freshnessGate.git?.status || "unknown"}${freshnessGate.git?.repo?.head ? ` ${freshnessGate.git.repo.head}` : ""}${freshnessGate.git?.repo?.branch ? ` on ${freshnessGate.git.repo.branch}` : ""}`,
    `- dirty tree: ${freshnessGate.git?.dirty?.entries || 0} change(s), ${freshnessGate.git?.dirty?.untracked || 0} untracked`,
    `- summary: ${freshnessGate.summary || "No temporal freshness gate is embedded."}`,
    freshnessGate.staleChecks?.length ? `- stale checks: ${freshnessGate.staleChecks.join(", ")}` : "- stale checks: none",
    `- next action: ${freshnessGate.nextAction || "Record a fresh current event before editing."}`,
    "",
    "## Runtime Eval",
    "",
    `- status: ${runtimeEval.status || "unknown"}`,
    `- score: ${runtimeEval.score || "0/0"}`,
    `- quality: ${runtimeEval.quality || 0}`,
    `- spans: ${runtimeEval.trace?.spanCount || 0}`,
    `- summary: ${runtimeEval.summary || "No runtime trace evaluation is embedded."}`,
    runtimeEval.blockers?.length ? `- blockers: ${runtimeEval.blockers.join(", ")}` : "- blockers: none",
    runtimeEval.warnings?.length ? `- warnings: ${runtimeEval.warnings.join(", ")}` : "- warnings: none",
    "",
    "## Phase Ledger",
    "",
    `- status: ${phaseLedger.status || "unknown"}`,
    `- spans: ${phaseLedger.spanCount || 0}`,
    `- linked spans: ${phaseLedger.linkedCount || 0}`,
    `- run groups: ${phaseLedger.runCount || 0}`,
    `- dangling parents: ${phaseLedger.danglingParents?.length || 0}`,
    `- summary: ${phaseLedger.summary || "No phase ledger is embedded."}`,
    `- next action: ${phaseLedger.nextAction || "Record parentId and runId around related tool calls."}`,
    "",
    "## Checkpoint Ledger",
    "",
    `- status: ${checkpointLedger.status || "unknown"}`,
    `- checkpoints: ${checkpointLedger.checkpointCount || 0}`,
    `- resumable/pending/failed: ${checkpointLedger.resumableCount || 0}/${checkpointLedger.pendingCount || 0}/${checkpointLedger.failedCount || 0}`,
    `- runs: ${checkpointLedger.runCount || 0}`,
    `- summary: ${checkpointLedger.summary || "No checkpoint ledger is embedded."}`,
    `- next action: ${checkpointLedger.nextAction || "Inspect resumable checkpoints before retrying or continuing work."}`,
    "Resume points:",
    listLines((checkpointLedger.resumable || []).slice(0, 6), (item) => `- [${item.status || "checkpoint"}] ${item.title || item.checkpointId}: ${item.nextAction || "review"}${item.refs?.length ? `\n   - refs: ${item.refs.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Decision Ledger",
    "",
    `- status: ${decisionLedger.status || "unknown"}`,
    `- decisions: ${decisionLedger.decisionCount || 0}`,
    `- valid/watch/invalid: ${decisionLedger.validCount || 0}/${decisionLedger.watchCount || 0}/${decisionLedger.invalidCount || 0}`,
    `- changed sources: ${decisionLedger.changedSourceCount || 0}`,
    `- summary: ${decisionLedger.summary || "No temporal decision ledger is embedded."}`,
    `- next action: ${decisionLedger.nextAction || "Verify decision source refs and validity windows before trusting project rules."}`,
    "",
    "## Hook Ingress",
    "",
    `- status: ${hookIngressAudit.status || "unknown"}`,
    `- accepted events: ${hookIngressAudit.acceptedEvents || 0}`,
    `- rejected events: ${hookIngressAudit.rejectedEvents || 0}`,
    `- backpressure: ${hookIngressAudit.backpressure?.status || "unknown"} (${hookIngressAudit.saturatedAttempts || 0} saturated)`,
    `- sanitized events: ${hookIngressAudit.sanitizedEvents || 0}`,
    `- unknown types: ${hookIngressAudit.unknownTypeEvents || 0}`,
    `- summary: ${hookIngressAudit.summary || "No sanitized hook ingress audit is embedded."}`,
    `- next action: ${hookIngressAudit.nextAction || "Use /api/hooks or npm run event for external tool events."}`,
    "",
    "## State Boundary",
    "",
    `- status: ${stateBoundary.status || "unknown"}`,
    `- source refs: ${stateBoundary.totals?.sourceRefs || 0}`,
    `- derived indexes: ${stateBoundary.totals?.derivedIndexes || 0}`,
    `- disclosure outputs: ${stateBoundary.totals?.disclosureOutputs || 0}`,
    `- summary: ${stateBoundary.summary || "No source/index/disclosure boundary audit is embedded."}`,
    `- next action: ${stateBoundary.nextAction || "Treat raw events and durable sources as authority; treat indexes and prompts as derived."}`,
    "Boundary checks:",
    listLines((stateBoundary.checks || []).slice(0, 6), (item) => `- [${item.status}] ${item.id || item.label}: ${item.detail || item.label}${item.refs?.length ? `\n   - refs: ${item.refs.slice(0, 3).join(", ")}` : ""}`),
    "",
    "## Provenance Ledger",
    "",
    `- status: ${provenanceLedger.status || "unknown"}`,
    `- hashed coverage: ${provenanceLedger.coverage?.hashedCoverage || "0/0"}`,
    `- claims: ${provenanceLedger.coverage?.sourcedClaims || 0} / ${provenanceLedger.coverage?.claims || 0}`,
    `- summary: ${provenanceLedger.summary || "No source provenance ledger is embedded."}`,
    provenanceLedger.blockers?.length ? `- blockers: ${provenanceLedger.blockers.join(", ")}` : "- blockers: none",
    provenanceLedger.warnings?.length ? `- warnings: ${provenanceLedger.warnings.join(", ")}` : "- warnings: none",
    "",
    "## Disclosure Gate",
    "",
    `- status: ${disclosureGate.status || "unknown"}`,
    `- can publish: ${disclosureGate.canPublish === undefined ? "unknown" : disclosureGate.canPublish ? "yes" : "no"}`,
    `- estimated tokens: ${disclosureGate.budget?.estimatedTokens || 0} / ${disclosureGate.budget?.budgetTokens || 0}`,
    `- packed files: ${promptPacking.totals?.includedFiles || 0} / ${promptPacking.limits?.maxFiles || 0}`,
    `- packed bytes: ${promptPacking.totals?.includedBytes || 0} / ${promptPacking.limits?.maxBytes || 0}`,
    `- omitted refs: ${promptPacking.totals?.omittedRefs || 0}`,
    `- secret-like findings: ${disclosureGate.scan?.findings?.length || 0}`,
    `- summary: ${disclosureGate.summary || "No disclosure gate is embedded."}`,
    listLines((promptPacking.omittedRefs || []).slice(0, 5), (item) => `- omitted ${item.ref}: ${item.reason || "packing limit"}`, "- omitted refs: none"),
    "",
    "## Pre-Edit Risk",
    "",
    `- status: ${preEditRisk.status || "unknown"}`,
    `- score: ${preEditRisk.score || "0/0"}`,
    `- summary: ${preEditRisk.summary || "No pre-edit risk summary is embedded."}`,
    `- test gap: ${preEditRisk.testGap?.status || "unknown"}`,
    "First checks:",
    listLines((preEditRisk.firstChecks || []).slice(0, 5), (item, index) => `${index + 1}. ${item.action}${item.refs?.length ? `\n   - refs: ${item.refs.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Code Graph",
    "",
    `- status: ${codeGraph.status || "unknown"}`,
    `- nodes: ${codeGraph.nodeCount || 0}`,
    `- edges: ${codeGraph.edgeCount || 0}`,
    `- local/package/unresolved: ${codeGraph.localEdgeCount || 0}/${codeGraph.packageEdgeCount || 0}/${codeGraph.unresolvedEdgeCount || 0}`,
    `- changed impact: ${codeGraph.changedImpact?.length || 0}`,
    `- summary: ${codeGraph.summary || "No code dependency graph is embedded."}`,
    `- next action: ${codeGraph.nextAction || "Inspect dependency graph before editing imported files."}`,
    "Dependency impact:",
    listLines((codeGraph.changedImpact || []).slice(0, 6), (item) => `- ${item.path}: dependents=${(item.dependents || []).slice(0, 3).join(", ") || "none"} dependencies=${(item.dependencies || []).slice(0, 3).join(", ") || "none"}`),
    "",
    "## Interrupted Work",
    "",
    `- status: ${interrupted.status || "unknown"}`,
    `- count: ${interrupted.count || 0}`,
    interrupted.nextAction ? `- next action: ${interrupted.nextAction}` : "",
    listLines((interrupted.items || []).slice(0, 6), (item) => `- ${item.agentId || "unknown-agent"}: [${item.phase}/${item.status}] ${item.title}${item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Files And Folders To Inspect Before Editing",
    "",
    "Changed files:",
    listLines(changedFiles.slice(0, 12), (file) => `- [${file.status || "changed"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`),
    "",
    "Impacted folders:",
    listLines(folders.slice(0, 8), (folder) => `- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${folder.latestFile ? ` latest=${folder.latestFile}` : ""}`),
    "",
    "## Runbook State",
    "",
    `- status: ${runbook.status || "unknown"}`,
    runbook.currentState ? `- current state: ${runbook.currentState}` : "",
    runbook.nextState ? `- next state: ${runbook.nextState}` : "",
    runbook.activeStepId ? `- active step: ${runbook.activeStepId}` : "",
    runbook.blockingReason ? `- blocking reason: ${runbook.blockingReason}` : "",
    "",
    "## Guardrails",
    "",
    listLines(packet.guardrails || continuity.startProtocol?.guardrails, (item) => `- ${item}`),
    "",
    "## Operating Rule",
    "",
    "Before the next tool call, read attentionPack, check disclosureGate.packing, freshnessGate, phaseLedger, checkpointLedger, decisionLedger, stateBoundary, codeGraph, runtimeEval, hookIngressAudit, and provenanceLedger, then record a fresh `current` event. After the tool call, record `done`, `failed`, or `blocked` with parentId/runId when it belongs to the same operation. Refresh resume/recovery before handing off again.",
    ""
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

export async function buildNextAgentPrompt(projectDir, options = {}) {
  const resume = await buildResumePacket(projectDir, {
    ...options,
    writeFile: options.writeResume !== false,
    writeRecovery: options.writeRecovery !== false,
    expectedFiles: [...(options.expectedFiles || []), ...(options.writeFile ? [".project-agent/next-agent-prompt.md"] : [])]
  });
  const markdown = renderPrompt({ continuity: resume.continuity || {} });
  const file = options.writeFile ? writeNextAgentPromptFile(projectDir, markdown) : undefined;
  const continuityAudit = options.writeFile
      ? buildContinuityAudit(projectDir, resume.continuity || {}, {
        expectedFiles: [...(options.expectedFiles || []), ".project-agent/next-agent-prompt.md", ".project-agent/continuity-audit.json", ".project-agent/state-manifest.json"]
      })
    : undefined;
  const continuityAuditFile = continuityAudit ? writeContinuityAudit(projectDir, continuityAudit) : undefined;
  return {
    markdown,
    file,
    continuityAudit,
    continuityAuditFile,
    continuity: resume.continuity,
    resumeFile: resume.file,
    recoveryFile: resume.recoveryFile
  };
}

export function writeNextAgentPromptFile(projectDir, markdown) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "next-agent-prompt.md");
  writeFileSync(file, markdown, "utf8");
  return file;
}
