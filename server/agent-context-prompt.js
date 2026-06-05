import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildTakeoverSummary, readAgentContextBundle, readTakeoverSummary, verifyAgentContextBundle } from "./runtime-state.js";

function compact(value, max = 600) {
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
  const refs = cursor.refs?.length ? `\n- refs: ${cursor.refs.slice(0, 8).join(", ")}` : "";
  return `- [${cursor.phase || "event"}/${cursor.status || "unknown"}] ${cursor.title}\n- detail: ${compact(cursor.detail, 500)}${refs}`;
}

function renderTakeoverSummaryPrompt(summary = {}, verification = {}) {
  const goal = summary.activeGoal || {};
  const current = summary.currentState || {};
  const next = summary.nextStep || {};
  const takeover = summary.takeover || {};
  const budgetLines = Object.entries(summary.budgets || {}).map(([name, budget]) => {
    const status = budget?.status || "unknown";
    const tokens = budget?.actual?.estimatedTokens ?? budget?.estimatedTokens ?? 0;
    const maxTokens = budget?.limits?.maxTokens ?? budget?.maxTokens ?? 0;
    const source = budget?.sourceRef || "source ref missing";
    return `- ${name}: ${status}, ${tokens}/${maxTokens} token estimate, source \`${source}\``;
  });
  return [
    "# Takeover Starter Prompt",
    "",
    "You are taking over this project from `.project-agent/takeover-summary.json`. Do not read full `agent-context-bundle.json` or `continuity.json` first; use the on-demand reads below when detail is needed.",
    "",
    "## Takeover Gate",
    "",
    `- status: ${takeover.status || "unknown"}`,
    `- can take over: ${takeover.canTakeOver ? "yes" : "no"}`,
    `- summary: ${takeover.summary || verification.summary || "No takeover summary."}`,
    takeover.blockers?.length ? `- blockers: ${takeover.blockers.join(", ")}` : "- blockers: none",
    takeover.warnings?.length ? `- warnings: ${takeover.warnings.join(", ")}` : "- warnings: none",
    "",
    "## Mission",
    "",
    goal.objective || "Continue the active project goal from durable project files.",
    "",
    "## Current State",
    "",
    current.title
      ? `- [${current.phase || "event"}/${current.status || "unknown"}] ${current.title}\n- detail: ${compact(current.detail, 420)}`
      : "- No current state is available; inspect `.project-agent/process-trace.json#current`.",
    current.refs?.length ? `- refs: ${current.refs.slice(0, 8).join(", ")}` : "",
    "",
    "## Next Step",
    "",
    next.command ? `- command: \`${next.command}\`` : "- command: inspect the takeover packet and process trace before editing",
    next.expected?.title ? `- expected: [${next.expected.phase}/${next.expected.status}] ${next.expected.title}` : "",
    "",
    "## Risks",
    "",
    listLines((summary.risks || []).slice(0, 6), (risk) => `- [${risk.tone || "watch"}] ${risk.id}: ${risk.summary}${risk.refs?.length ? ` refs=${risk.refs.slice(0, 5).join(", ")}` : ""}`),
    "",
    "## Memory Budget",
    "",
    budgetLines.length ? budgetLines.join("\n") : "- no budget report",
    "",
    "## On-Demand Reads",
    "",
    listLines((summary.onDemandReads || []).slice(0, 8), (item) => `- ${item.label}: \`${item.command}\``),
    "",
    "## Source Refs",
    "",
    listLines((summary.sourceRefs || []).slice(0, 10), (item) => `- \`${item.path}\`: ${item.reason || "source"}`),
    "",
    "## First Actions",
    "",
    "1. Verify `takeover.status` and resolve blockers before editing.",
    "2. Resume from the current state, not from prior chat.",
    "3. Use the on-demand `jq` reads for missing detail.",
    "4. Record a fresh current event before the next tool call, then record done/failed/blocked afterward.",
    ""
  ].filter((line) => line !== undefined && line !== null).join("\n");
}

export function renderAgentContextPrompt(bundle, verification = verifyAgentContextBundle("", bundle)) {
  const quick = bundle?.quickStart || {};
  const goal = quick.activeGoal || {};
  const interrupted = quick.interruptedWork || { count: 0, items: [] };
  const runbook = bundle?.governance?.runbook || {};
  const objectiveCoverage = bundle?.validation?.objectiveCoverage || {};
  const takeoverAcceptance = bundle?.validation?.takeoverAcceptanceAudit || {};
  const disclosureGate = bundle?.validation?.disclosureGate || {};
  const promptPacking = disclosureGate.packing || {};
  const preEditRisk = bundle?.validation?.preEditRisk || {};
  const freshnessGate = bundle?.validation?.freshnessGate || {};
  const runtimeEval = bundle?.validation?.runtimeEval || {};
  const phaseLedger = bundle?.validation?.phaseLedger || {};
  const checkpointLedger = bundle?.validation?.checkpointLedger || {};
  const decisionLedger = bundle?.validation?.decisionLedger || {};
  const temporalProvenance = bundle?.validation?.temporalProvenance || {};
  const stateBoundary = bundle?.validation?.stateBoundary || {};
  const codeGraph = bundle?.architecture?.codeGraph || bundle?.architecture?.map?.codeGraph || bundle?.architecture?.trace?.codeGraph || {};
  const hookIngressAudit = bundle?.validation?.hookIngressAudit || {};
  const provenanceLedger = bundle?.validation?.provenanceLedger || {};
  const attentionPack = bundle?.validation?.attentionPack || {};
  const handoffLifecycle = bundle?.handoff?.lifecycle || {};
  const developmentTrail = bundle?.process?.developmentTrail || {};
  const changedFiles = bundle?.architecture?.changedFiles || [];
  const folders = bundle?.architecture?.impact?.topFolders || bundle?.architecture?.impact?.folders || [];
  return [
    "# Bundle-Only Next Agent Starter Prompt",
    "",
    "You are taking over this project from `.project-agent/agent-context-bundle.json`. Do not rely on prior chat history. Treat the bundle verification result as the first gate before editing.",
    "",
    "## Bundle Gate",
    "",
    `- status: ${verification.status || "unknown"}`,
    `- can resume: ${verification.canResume ? "yes" : "no"}`,
    `- summary: ${verification.summary || "No verification summary."}`,
    verification.blockers?.length ? `- blockers: ${verification.blockers.join(", ")}` : "- blockers: none",
    verification.warnings?.length ? `- warnings: ${verification.warnings.join(", ")}` : "- warnings: none",
    "",
    "## Attention Pack",
    "",
    `- status: ${attentionPack.status || "unknown"}`,
    `- estimated tokens: ${attentionPack.budget?.estimatedTokens || 0} / ${attentionPack.budget?.budgetTokens || 0}`,
    `- summary: ${attentionPack.summary || "No top-of-mind attention pack is embedded."}`,
    `- next action: ${attentionPack.nextAction || "Start from the bundle, then verify source refs before editing."}`,
    "Top items:",
    listLines((attentionPack.items || []).slice(0, 8), (item) => `- #${item.rank || "?"} [${item.kind || "item"}] ${item.label}: ${item.text}${item.refs?.length ? ` refs=${item.refs.slice(0, 3).join(", ")}` : ""}`),
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
    listLines((checkpointLedger.resumable || []).slice(0, 6), (item) => `- [${item.status || "checkpoint"}] ${item.title || item.checkpointId}: ${item.nextAction || "review"}${item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : ""}`),
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
    "## Temporal Provenance",
    "",
    `- status: ${temporalProvenance.status || "unknown"}`,
    `- facts: ${temporalProvenance.factCount || 0}`,
    `- valid/watch/stale/invalid: ${temporalProvenance.validCount || 0}/${temporalProvenance.watchCount || 0}/${temporalProvenance.staleCount || 0}/${temporalProvenance.invalidCount || 0}`,
    `- contradictions: ${temporalProvenance.contradictionCount || 0}`,
    `- summary: ${temporalProvenance.summary || "No temporal provenance audit is embedded."}`,
    `- next action: ${temporalProvenance.nextAction || "Verify fact source refs, source hashes, and validity windows before trusting memory."}`,
    "Temporal checks:",
    listLines((temporalProvenance.checks || []).slice(0, 6), (item) => `- [${item.status}] ${item.id || item.label}: ${item.detail || item.label}${item.refs?.length ? ` refs=${item.refs.slice(0, 3).join(", ")}` : ""}`),
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
    listLines((stateBoundary.checks || []).slice(0, 6), (item) => `- [${item.status}] ${item.id || item.label}: ${item.detail || item.label}${item.refs?.length ? ` refs=${item.refs.slice(0, 3).join(", ")}` : ""}`),
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
    disclosureGate.blockers?.length ? `- blockers: ${disclosureGate.blockers.join(", ")}` : "- blockers: none",
    disclosureGate.warnings?.length ? `- warnings: ${disclosureGate.warnings.join(", ")}` : "- warnings: none",
    "",
    "## Pre-Edit Risk",
    "",
    `- status: ${preEditRisk.status || "unknown"}`,
    `- score: ${preEditRisk.score || "0/0"}`,
    `- summary: ${preEditRisk.summary || "No pre-edit risk summary is embedded."}`,
    `- test gap: ${preEditRisk.testGap?.status || "unknown"}`,
    "First checks:",
    listLines((preEditRisk.firstChecks || []).slice(0, 5), (item, index) => `${index + 1}. ${item.action}${item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : ""}`),
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
    "## Mission",
    "",
    goal.objective || "Continue the active project goal from the bundle.",
    "",
    "## Handoff Lifecycle",
    "",
    `- status: ${handoffLifecycle.status || "unknown"}`,
    `- summary: ${handoffLifecycle.summary || "No typed handoff lifecycle is embedded."}`,
    handoffLifecycle.expiresAt ? `- expires at: ${handoffLifecycle.expiresAt}` : "- expires at: unknown",
    `- next action: ${handoffLifecycle.nextAction || "Run bundle verification before editing."}`,
    "",
    "## Objective Coverage",
    "",
    `- status: ${objectiveCoverage.status || "unknown"}`,
    `- score: ${objectiveCoverage.score || "0/0"}`,
    `- summary: ${objectiveCoverage.summary || "No objective coverage map is embedded."}`,
    objectiveCoverage.blockers?.length ? `- blockers: ${objectiveCoverage.blockers.join(", ")}` : "- blockers: none",
    objectiveCoverage.warnings?.length ? `- warnings: ${objectiveCoverage.warnings.join(", ")}` : "- warnings: none",
    "",
    "Core requirements:",
    listLines((objectiveCoverage.requirements || []).slice(0, 6), (item) => `- [${item.status}] ${item.id}: ${item.label || item.statement || item.nextAction}${item.evidence?.length ? ` refs=${item.evidence.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Takeover Acceptance",
    "",
    `- status: ${takeoverAcceptance.status || "unknown"}`,
    `- score: ${takeoverAcceptance.score || "0/0"}`,
    `- can resume: ${takeoverAcceptance.canResume ? "yes" : "no"}`,
    `- summary: ${takeoverAcceptance.summary || "No user-objective acceptance audit is embedded."}`,
    takeoverAcceptance.blockers?.length ? `- blockers: ${takeoverAcceptance.blockers.join(", ")}` : "- blockers: none",
    takeoverAcceptance.warnings?.length ? `- warnings: ${takeoverAcceptance.warnings.join(", ")}` : "- warnings: none",
    "",
    "Acceptance rows:",
    listLines((takeoverAcceptance.rows || []).slice(0, 8), (item) => `- [${item.status}] ${item.id}: ${item.detail || item.requirement}${item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Mandatory Read Order",
    "",
    listLines(bundle?.readOrder, (ref, index) => `${index + 1}. Read \`${ref}\``),
    "",
    "## First Actions",
    "",
    "1. Run `npm run context -- --project-dir \"$PROJECT_DIR\" --verify` before trusting the handoff.",
    "2. If verification is blocked, restore the failed bundle checks before editing project files.",
    "3. Read attentionPack first; use its source refs as the top-of-mind route through the full bundle.",
    "4. Check the freshness gate; if it is stale or expired, refresh process/architecture/handoff artifacts first.",
    "5. Inspect disclosureGate.packing; omitted refs are outside the bounded prompt, not proof that the source is irrelevant.",
    "6. Inspect phaseLedger and runtimeEval; if links are flat/missing or eval has blockers, repair trace/evidence gaps before claiming completion.",
    "7. Inspect checkpointLedger; resolve pending writes or failed checkpoints before retrying or continuing work.",
    "8. Inspect decisionLedger; re-check watch/invalid decisions against their source refs before relying on project rules.",
    "9. Inspect codeGraph; if changedImpact has dependents, read those files before editing imported modules.",
    "10. Inspect hookIngressAudit; trust external hook events only after checking redactions and type normalization.",
    "11. Inspect stateBoundary; use raw events and durable sources as authority, and treat derived indexes/prompts as navigational aids.",
    "12. Inspect provenanceLedger; use sourceRefs and hashes before trusting remembered facts.",
    "13. Resume from the current cursor below, not from memory of the previous chat.",
    "14. Record a fresh `current` event before the next tool call, then record `done`, `failed`, or `blocked` afterward.",
    "15. Inspect changed files, impacted folders, and dependency impact before modifying code.",
    "",
    "## Current Cursor",
    "",
    renderCursor(quick.currentCursor),
    "",
    "## Previous Cursor",
    "",
    renderCursor(quick.previousCursor),
    "",
    "## Next Expected",
    "",
    renderCursor(quick.nextExpected),
    "",
    "## Next Command",
    "",
    quick.nextCommand ? `\`${quick.nextCommand}\`` : "- none",
    "",
    "## Memory Snapshot",
    "",
    `- graph nodes: ${bundle?.memory?.graph?.nodes?.length || 0}`,
    `- graph edges: ${bundle?.memory?.graph?.edges?.length || 0}`,
    `- provenance: ${bundle?.memory?.graph?.provenanceCoverage || "unknown"}`,
    "",
    "## Process Snapshot",
    "",
    `- trace schema: ${bundle?.process?.trace?.schemaVersion || "missing"}`,
    `- workstream: ${quick.workstream?.label || quick.workstream?.id || "unknown"}`,
    `- recent events: ${bundle?.process?.recentEvents?.length || 0}`,
    `- development trail: ${developmentTrail.status || "missing"} ${developmentTrail.fileCoverage || "0/0"}`,
    "",
    "Development trail:",
    listLines((developmentTrail.steps || []).slice(0, 6), (step) => `- [${step.label || step.phase}/${step.status || "unknown"}] ${step.title || step.id} risk=${step.risk || "unknown"} files=${(step.files || []).slice(0, 4).map((file) => file.path).join(", ") || "none"} folders=${(step.folders || []).slice(0, 3).map((folder) => folder.folder).join(", ") || "none"} next=${step.nextAction || "review"}`),
    "",
    "## Architecture Snapshot",
    "",
    `- map schema: ${bundle?.architecture?.map?.schemaVersion || "missing"}`,
    `- files: ${bundle?.architecture?.map?.files?.length || 0}`,
    `- changed files: ${changedFiles.length}`,
    "",
    "Changed files:",
    listLines(changedFiles.slice(0, 12), (file) => `- [${file.status || "changed"}] ${file.path}${file.summary ? ` ${file.summary}` : ""}`),
    "",
    "Impacted folders:",
    listLines(folders.slice(0, 8), (folder) => `- ${folder.folder}: ${folder.summary || `${folder.files || 0} file(s)`}${folder.latestFile ? ` latest=${folder.latestFile}` : ""}`),
    "",
    "## Interrupted Work",
    "",
    `- status: ${interrupted.status || "unknown"}`,
    `- count: ${interrupted.count || 0}`,
    interrupted.nextAction ? `- next action: ${interrupted.nextAction}` : "",
    listLines((interrupted.items || []).slice(0, 6), (item) => `- ${item.agentId || "unknown-agent"}: [${item.phase}/${item.status}] ${item.title}${item.refs?.length ? ` refs=${item.refs.slice(0, 4).join(", ")}` : ""}`),
    "",
    "## Runbook State",
    "",
    `- status: ${runbook.status || "unknown"}`,
    runbook.currentState ? `- current state: ${runbook.currentState}` : "",
    runbook.nextState ? `- next state: ${runbook.nextState}` : "",
    runbook.activeStepId ? `- active step: ${runbook.activeStepId}` : "",
    runbook.nextCommand ? `- runbook next command: \`${runbook.nextCommand}\`` : "",
    ""
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

export function buildAgentContextPrompt(projectDir, options = {}) {
  const bundle = options.bundle || readAgentContextBundle(projectDir);
  const verification = options.verification || verifyAgentContextBundle(projectDir, bundle);
  const summary = options.summary || readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, undefined, { bundle, verification });
  const markdown = renderTakeoverSummaryPrompt(summary || {}, verification);
  const file = options.writeFile ? writeAgentContextPromptFile(projectDir, markdown) : undefined;
  return { markdown, file, takeoverSummary: summary, agentContextBundle: bundle, verification };
}

export function writeAgentContextPromptFile(projectDir, markdown) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "context-starter-prompt.md");
  writeFileSync(file, markdown, "utf8");
  return file;
}
