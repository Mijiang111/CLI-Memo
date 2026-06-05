import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const RUNTIME_FILE = "runtime.json";
const CONTINUITY_FILE = "continuity.json";
const CONTRACT_FILE = "continuity-contract.json";
const AGENT_RUNBOOK_FILE = "agent-runbook.json";
const MEMORY_GRAPH_FILE = "memory-graph.json";
const PROCESS_TRACE_FILE = "process-trace.json";
const DEVELOPMENT_TRAIL_FILE = "development-trail.json";
const ARCHITECTURE_MAP_FILE = "architecture-map.json";
const TAKEOVER_PACKET_FILE = "takeover-packet.json";
const CONTINUITY_AUDIT_FILE = "continuity-audit.json";
const TAKEOVER_ACCEPTANCE_AUDIT_FILE = "takeover-acceptance-audit.json";
const GOVERNANCE_SPEC_FILE = "governance-spec.json";
const STATE_MANIFEST_FILE = "state-manifest.json";
const AGENT_CONTEXT_BUNDLE_FILE = "agent-context-bundle.json";
const TAKEOVER_SUMMARY_FILE = "takeover-summary.json";
const MAX_EVENTS = 120;
const MAX_AGENTS = 30;
const MAX_HOOK_INGRESSES = 80;
const DEFAULT_LEASE_SECONDS = 90;
const VALID_PHASES = new Set(["observe", "plan", "execute", "evidence", "audit", "handoff"]);
const VALID_STATUSES = new Set(["pending", "current", "done", "failed", "blocked"]);
const VALID_AGENT_STATUSES = new Set(["active", "idle", "done", "failed", "handoff"]);
const VALID_WORKSTREAMS = new Set(["discussion", "strategy", "architecture", "implementation", "qa_testing", "governance"]);
const HOOK_EVENT_TYPES = new Set([
  "observation",
  "agent_note",
  "tool_start",
  "tool_done",
  "tool_error",
  "command_start",
  "command_done",
  "command_error",
  "file_change",
  "evidence",
  "audit",
  "handoff"
]);
const HOOK_TYPE_ALIASES = {
  tool: "tool_start",
  tool_use: "tool_start",
  tool_call: "tool_start",
  tool_result: "tool_done",
  tool_output: "tool_done",
  tool_failed: "tool_error",
  error: "tool_error",
  command: "command_start",
  command_running: "command_start",
  command_finished: "command_done",
  command_failed: "command_error",
  file: "file_change",
  file_modified: "file_change",
  message: "agent_note",
  note: "agent_note"
};
const HOOK_MAX_BATCH_EVENTS = 25;
const DISCLOSURE_TOKEN_BUDGET = 12000;
const DISCLOSURE_MAX_FILES = 24;
const DISCLOSURE_MAX_BYTES = 180000;
const DISCLOSURE_MAX_LOGICAL_REFS = 48;
const DISCLOSURE_MAX_OMITTED_REFS = 18;
const DISCLOSURE_SECRET_RULES = [
  { id: "private_key", label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "openai_key", label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: "github_token", label: "GitHub-style token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { id: "aws_access_key", label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "jwt", label: "JWT-like token", pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  {
    id: "secret_assignment",
    label: "secret-like assignment",
    pattern: /\b(password|passwd|pwd|api[_-]?key|secret|token|auth[_-]?token|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?([^"'\s,;}{\]]{8,})/gi
  }
];
const DISCLOSURE_SAFE_VALUES = new Set(["redacted", "placeholder", "example", "change_me", "changeme", "undefined", "null", "none"]);
const SECRET_KEY_RE = /password|passwd|pwd|api[_-]?key|secret|token|auth[_-]?token|access[_-]?token|private[_-]?key/i;
const ATTENTION_PACK_TOKEN_BUDGET = 1800;
const TAKEOVER_SUMMARY_TOKEN_BUDGET = 1800;
const TAKEOVER_SUMMARY_BYTE_BUDGET = 14000;
const SECTION_BUDGETS = {
  memory: { maxTokens: 1800, maxBytes: 18000, sourceRef: ".project-agent/memory-graph.json", jq: "{nodeCount,edgeCount,provenanceCoverage,nodes:.nodes[0:12],edges:.edges[0:16],provenanceRefs:.provenanceRefs[0:12]}" },
  process: { maxTokens: 1800, maxBytes: 18000, sourceRef: ".project-agent/process-trace.json", jq: "{current,previous,next,phases:.phases[0:8],recentEvents:.events[0:8],inspectOrder:.inspectOrder[0:12]}" },
  architecture: { maxTokens: 2200, maxBytes: 24000, sourceRef: ".project-agent/architecture-map.json", jq: "{totals,impact,recentChanges:.recentChanges[0:12],inspectOrder:.inspectOrder[0:16],codeGraph:{status,nodeCount,edgeCount,hotspots:.hotspots[0:8],changedImpact:.changedImpact[0:8]}}" },
  handoff: { maxTokens: 1600, maxBytes: 16000, sourceRef: ".project-agent/takeover-packet.json", jq: "{status,canResume,objective,cursor,nextCommand,firstActions:.firstActions[0:5],firstRead:.firstRead[0:8],guardrails:.guardrails[0:8]}" }
};
const DISCLOSURE_IGNORED_KEYS = new Set([
  "agentContextBundleVerification",
  "disclosureGate",
  "freshnessGate",
  "contentHash",
  "expectedContentHash",
  "sha256",
  "aggregateHash",
  "generatedAt",
  "checkedAt"
]);

function nowIso() {
  return new Date().toISOString();
}

function stateDir(projectDir) {
  return path.join(projectDir, ".project-agent");
}

function runtimePath(projectDir) {
  return path.join(stateDir(projectDir), RUNTIME_FILE);
}

function continuityPath(projectDir) {
  return path.join(stateDir(projectDir), CONTINUITY_FILE);
}

function contractPath(projectDir) {
  return path.join(stateDir(projectDir), CONTRACT_FILE);
}

function agentRunbookPath(projectDir) {
  return path.join(stateDir(projectDir), AGENT_RUNBOOK_FILE);
}

function memoryGraphPath(projectDir) {
  return path.join(stateDir(projectDir), MEMORY_GRAPH_FILE);
}

function processTracePath(projectDir) {
  return path.join(stateDir(projectDir), PROCESS_TRACE_FILE);
}

function developmentTrailPath(projectDir) {
  return path.join(stateDir(projectDir), DEVELOPMENT_TRAIL_FILE);
}

function architectureMapPath(projectDir) {
  return path.join(stateDir(projectDir), ARCHITECTURE_MAP_FILE);
}

function takeoverPacketPath(projectDir) {
  return path.join(stateDir(projectDir), TAKEOVER_PACKET_FILE);
}

function continuityAuditPath(projectDir) {
  return path.join(stateDir(projectDir), CONTINUITY_AUDIT_FILE);
}

function takeoverAcceptanceAuditPath(projectDir) {
  return path.join(stateDir(projectDir), TAKEOVER_ACCEPTANCE_AUDIT_FILE);
}

function governanceSpecPath(projectDir) {
  return path.join(stateDir(projectDir), GOVERNANCE_SPEC_FILE);
}

function stateManifestPath(projectDir) {
  return path.join(stateDir(projectDir), STATE_MANIFEST_FILE);
}

function agentContextBundlePath(projectDir) {
  return path.join(stateDir(projectDir), AGENT_CONTEXT_BUNDLE_FILE);
}

function takeoverSummaryPath(projectDir) {
  return path.join(stateDir(projectDir), TAKEOVER_SUMMARY_FILE);
}

const MANIFEST_FILES = [
  TAKEOVER_SUMMARY_FILE,
  AGENT_CONTEXT_BUNDLE_FILE,
  GOVERNANCE_SPEC_FILE,
  CONTRACT_FILE,
  AGENT_RUNBOOK_FILE,
  MEMORY_GRAPH_FILE,
  PROCESS_TRACE_FILE,
  DEVELOPMENT_TRAIL_FILE,
  ARCHITECTURE_MAP_FILE,
  TAKEOVER_PACKET_FILE,
  CONTINUITY_AUDIT_FILE,
  TAKEOVER_ACCEPTANCE_AUDIT_FILE,
  "codex-takeover-smoke.json",
  "next-agent-prompt.md",
  CONTINUITY_FILE,
  "resume.md",
  "recovery.md",
  "state.json",
  RUNTIME_FILE
];
const VOLATILE_MANIFEST_PATHS = new Set([
  `.project-agent/${RUNTIME_FILE}`,
  `.project-agent/${STATE_MANIFEST_FILE}`,
  `.project-agent/${AGENT_CONTEXT_BUNDLE_FILE}`,
  `.project-agent/${TAKEOVER_SUMMARY_FILE}`,
  `.project-agent/${TAKEOVER_ACCEPTANCE_AUDIT_FILE}`,
  ".project-agent/codex-takeover-smoke.json"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSchemaVersion(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed?.schemaVersion || null;
  } catch {
    return null;
  }
}

function bundleContentHash(bundle) {
  const { contentHash, validation, ...rest } = bundle || {};
  const { agentContextBundleVerification, ...stableValidation } = validation || {};
  const hashable = {
    ...rest,
    ...(validation ? { validation: stableValidation } : {})
  };
  return sha256(JSON.stringify(hashable));
}

function bundleCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail,
    refs: refs.filter(Boolean)
  };
}

function sanitizeDisclosurePayload(value, key = "") {
  const keyName = String(key || "");
  const lowerKey = keyName.toLowerCase();
  if (DISCLOSURE_IGNORED_KEYS.has(keyName) || lowerKey.includes("hash")) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeDisclosurePayload(item)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeDisclosurePayload(entryValue, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined);
    return Object.fromEntries(entries);
  }
  return value;
}

function collectDisclosureText(value, lines = []) {
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    return lines;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDisclosureText(item, lines));
    return lines;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectDisclosureText(item, lines));
  }
  return lines;
}

function estimateDisclosureTokens(text) {
  const clean = String(text || "").trim();
  if (!clean) return 0;
  const wordEstimate = clean.split(/\s+/).filter(Boolean).length * 1.35;
  const charEstimate = clean.length / 4;
  return Math.ceil(Math.max(wordEstimate, charEstimate));
}

function redactedSecretSample(rule, match) {
  if (rule.id === "secret_assignment") return `${match[1]}=<redacted>`;
  if (rule.id === "private_key") return "<private-key-block>";
  if (rule.id === "jwt") return "<jwt-like-token>";
  if (rule.id === "aws_access_key") return "<aws-access-key>";
  if (rule.id === "github_token") return "<github-token>";
  if (rule.id === "openai_key") return "<api-key>";
  return "<secret-like-value>";
}

function scanSecretLikeText(text) {
  const findings = [];
  for (const rule of DISCLOSURE_SECRET_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    while ((match = pattern.exec(text)) && findings.length < 8) {
      if (rule.id === "secret_assignment") {
        const value = String(match[2] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!value || DISCLOSURE_SAFE_VALUES.has(value) || value.startsWith("redacted")) continue;
      }
      findings.push({
        rule: rule.id,
        label: rule.label,
        sample: redactedSecretSample(rule, match)
      });
    }
    if (findings.length >= 8) break;
  }
  return findings;
}

function normalizeRef(ref) {
  const value = String(ref || "").trim();
  if (!value) return "";
  if (value.startsWith("/")) return value;
  if (value.startsWith(".project-agent/")) return value;
  if (value.startsWith("project-agent/")) return `.${value}`;
  return value.replace(/^\.\//, "");
}

function disclosureFilePath(ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) return "";
  return normalized.split("#")[0];
}

function disclosureRefLooksFile(ref) {
  const normalized = disclosureFilePath(ref);
  return Boolean(normalized && (normalized.includes("/") || /\.[a-z0-9]+$/i.test(normalized)));
}

function collectPromptPackingRefs(bundle = {}) {
  const refs = new Map();
  const add = (ref, reason = "ref") => {
    const normalized = normalizeRef(ref);
    if (!normalized) return;
    const existing = refs.get(normalized) || { ref: normalized, reasons: [] };
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    refs.set(normalized, existing);
  };
  (bundle.readOrder || []).forEach((ref) => add(ref, "read_order"));
  (bundle.validation?.sourceFiles || []).forEach((file) => add(file.path, "source_file"));
  (bundle.architecture?.changedFiles || []).forEach((file) => add(file.path, "changed_file"));
  (bundle.architecture?.codeGraph?.changedImpact || []).forEach((item) => {
    add(item.path, "dependency_impact");
    (item.dependents || []).forEach((ref) => add(ref, "dependent"));
    (item.dependencies || []).forEach((ref) => add(ref, "dependency"));
  });
  (bundle.validation?.attentionPack?.readFirst || []).forEach((item) => add(item.path || item.ref, "attention_read_first"));
  (bundle.validation?.attentionPack?.items || []).forEach((item) => (item.refs || []).forEach((ref) => add(ref, `attention:${item.id || item.kind || "item"}`)));
  (bundle.validation?.provenanceLedger?.sources || []).forEach((source) => add(source.ref || source.path, "provenance_source"));
  (bundle.validation?.provenanceLedger?.claims || []).forEach((claim) => (claim.sourceRefs || []).forEach((ref) => add(ref, `claim:${claim.id || "source"}`)));
  (bundle.quickStart?.currentCursor?.refs || []).forEach((ref) => add(ref, "current_cursor"));
  (bundle.quickStart?.previousCursor?.refs || []).forEach((ref) => add(ref, "previous_cursor"));
  (bundle.quickStart?.nextExpected?.refs || []).forEach((ref) => add(ref, "next_expected"));
  return [...refs.values()];
}

function buildPromptPackingGate(bundle = {}, options = {}) {
  const maxFiles = Number(options.maxFiles || DISCLOSURE_MAX_FILES);
  const maxBytes = Number(options.maxBytes || DISCLOSURE_MAX_BYTES);
  const maxLogicalRefs = Number(options.maxLogicalRefs || DISCLOSURE_MAX_LOGICAL_REFS);
  const maxOmittedRefs = Number(options.maxOmittedRefs || DISCLOSURE_MAX_OMITTED_REFS);
  const sourceFiles = bundle.validation?.sourceFiles || [];
  const sourceByPath = new Map(sourceFiles.map((file) => [normalizeRef(file.path), file]));
  const refs = collectPromptPackingRefs(bundle);
  const recordsByPath = new Map();
  for (const refRecord of refs) {
    const filePath = disclosureFilePath(refRecord.ref);
    if (!disclosureRefLooksFile(refRecord.ref) || !filePath) continue;
    const sourceFile = sourceByPath.get(filePath);
    const existing = recordsByPath.get(filePath) || {
      path: filePath,
      bytes: Number(sourceFile?.bytes || 0),
      exists: sourceFile?.exists !== false,
      sha256: sourceFile?.sha256 || null,
      schemaVersion: sourceFile?.schemaVersion || null,
      volatile: Boolean(sourceFile?.volatile),
      refs: [],
      reasons: []
    };
    existing.refs.push(refRecord.ref);
    for (const reason of refRecord.reasons || []) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    }
    recordsByPath.set(filePath, existing);
  }
  for (const sourceFile of sourceFiles) {
    const filePath = normalizeRef(sourceFile.path);
    if (!filePath || recordsByPath.has(filePath)) continue;
    recordsByPath.set(filePath, {
      path: filePath,
      bytes: Number(sourceFile.bytes || 0),
      exists: sourceFile.exists !== false,
      sha256: sourceFile.sha256 || null,
      schemaVersion: sourceFile.schemaVersion || null,
      volatile: Boolean(sourceFile.volatile),
      refs: [filePath],
      reasons: ["source_file"]
    });
  }
  const fileRecords = [...recordsByPath.values()].sort((a, b) => {
    const aRead = a.reasons.includes("read_order") ? 0 : 1;
    const bRead = b.reasons.includes("read_order") ? 0 : 1;
    if (aRead !== bRead) return aRead - bRead;
    return a.path.localeCompare(b.path);
  });
  const includedFiles = [];
  const omittedFiles = [];
  let includedBytes = 0;
  for (const record of fileRecords) {
    const wouldExceedFiles = includedFiles.length >= maxFiles;
    const wouldExceedBytes = record.bytes && includedBytes + record.bytes > maxBytes;
    if (wouldExceedFiles || wouldExceedBytes) {
      omittedFiles.push({
        path: record.path,
        bytes: record.bytes,
        reason: wouldExceedFiles ? "max_files" : "max_bytes",
        refs: record.refs.slice(0, 4)
      });
      continue;
    }
    includedFiles.push({
      path: record.path,
      bytes: record.bytes,
      exists: record.exists,
      sha256: record.sha256,
      schemaVersion: record.schemaVersion,
      reasons: record.reasons.slice(0, 4)
    });
    includedBytes += record.bytes;
  }
  const logicalRefs = refs
    .filter((record) => !disclosureRefLooksFile(record.ref))
    .map((record) => ({ ref: record.ref, reasons: record.reasons.slice(0, 4) }));
  const includedRefs = logicalRefs.slice(0, maxLogicalRefs);
  const omittedLogicalRefs = logicalRefs.slice(maxLogicalRefs).map((record) => ({
    ref: record.ref,
    reason: "max_logical_refs"
  }));
  const omittedRefs = [
    ...omittedFiles.map((file) => ({ ref: file.path, reason: file.reason, bytes: file.bytes })),
    ...omittedLogicalRefs
  ].slice(0, maxOmittedRefs);
  const totalBytes = fileRecords.reduce((sum, file) => sum + (file.bytes || 0), 0);
  const warnings = [
    omittedFiles.some((file) => file.reason === "max_files") ? "max_files" : "",
    omittedFiles.some((file) => file.reason === "max_bytes") ? "max_bytes" : "",
    omittedLogicalRefs.length ? "max_logical_refs" : ""
  ].filter(Boolean);
  const status = warnings.length ? "warn" : "ok";
  return {
    schemaVersion: "project-agent.prompt-packing-gate.v1",
    status,
    summary: warnings.length
      ? `Prompt packing omitted ${omittedFiles.length + omittedLogicalRefs.length} ref(s) to stay within file/byte limits.`
      : `Prompt packing includes ${includedFiles.length} file ref(s), ${includedBytes} byte(s), and ${includedRefs.length} logical ref(s).`,
    limits: {
      maxFiles,
      maxBytes,
      maxLogicalRefs,
      maxOmittedRefs
    },
    totals: {
      files: fileRecords.length,
      bytes: totalBytes,
      logicalRefs: logicalRefs.length,
      includedFiles: includedFiles.length,
      includedBytes,
      omittedFiles: omittedFiles.length,
      omittedBytes: omittedFiles.reduce((sum, file) => sum + (file.bytes || 0), 0),
      includedRefs: includedRefs.length,
      omittedRefs: omittedFiles.length + omittedLogicalRefs.length,
      byteUtilization: maxBytes ? Number((includedBytes / maxBytes).toFixed(2)) : 0,
      fileUtilization: maxFiles ? Number((includedFiles.length / maxFiles).toFixed(2)) : 0
    },
    includedFiles: includedFiles.slice(0, maxFiles),
    omittedFiles: omittedFiles.slice(0, maxOmittedRefs),
    includedRefs,
    omittedRefs,
    warnings,
    refs: [".project-agent/agent-context-bundle.json", ".project-agent/next-agent-prompt.md", ...includedFiles.slice(0, 8).map((file) => file.path)]
  };
}

function sourceRecordForRef(ref, manifestByPath, architectureByPath) {
  const normalized = normalizeRef(ref);
  const manifestRecord = manifestByPath.get(normalized);
  const architectureRecord = architectureByPath.get(normalized);
  return {
    ref: normalized,
    kind: manifestRecord ? "manifest_file" : architectureRecord ? "architecture_file" : /\.[a-z0-9]+$/i.test(normalized) ? "file_ref" : "logical_ref",
    hash: manifestRecord?.sha256 || architectureRecord?.hash || architectureRecord?.previousHash || null,
    schemaVersion: manifestRecord?.schemaVersion || null,
    observedAt: manifestRecord?.mtimeMs ? new Date(manifestRecord.mtimeMs).toISOString() : architectureRecord?.modifiedAt || null,
    exists: manifestRecord ? manifestRecord.exists !== false : undefined,
    volatile: Boolean(manifestRecord?.volatile)
  };
}

function provenanceClaim(id, label, status, summary, refs = [], options = {}) {
  return {
    id,
    label,
    status,
    summary: compact(summary, 240),
    sourceRefs: [...new Set((refs || []).map(normalizeRef).filter(Boolean))].slice(0, 10),
    observedAt: options.observedAt || null,
    validFrom: options.validFrom || options.observedAt || null,
    validUntil: options.validUntil || null
  };
}

function attentionItem(id, kind, priority, label, text, refs = [], options = {}) {
  return {
    id,
    kind,
    priority,
    label,
    text: compact(text, options.max || 260),
    refs: [...new Set((refs || []).map(normalizeRef).filter(Boolean))].slice(0, 8),
    sourceHashes: [],
    action: options.action ? compact(options.action, 220) : undefined
  };
}

function buildAttentionPack(bundle = {}, options = {}) {
  const budgetTokens = Number(options.budgetTokens || ATTENTION_PACK_TOKEN_BUDGET);
  const quick = bundle.quickStart || {};
  const goal = quick.activeGoal || {};
  const current = quick.currentCursor || bundle.process?.trace?.current || {};
  const nextExpected = quick.nextExpected || bundle.process?.trace?.next || {};
  const lifecycle = bundle.handoff?.lifecycle || {};
  const freshness = bundle.validation?.freshnessGate || {};
  const gitFreshness = freshness.git || {};
  const runtimeEval = bundle.validation?.runtimeEval || {};
  const phaseLedger = bundle.validation?.phaseLedger || {};
  const checkpointLedger = bundle.validation?.checkpointLedger || {};
  const decisionLedger = bundle.validation?.decisionLedger || {};
  const temporalProvenance = bundle.validation?.temporalProvenance || {};
  const provenance = bundle.validation?.provenanceLedger || {};
  const hookIngressAudit = bundle.validation?.hookIngressAudit || {};
  const stateBoundary = bundle.validation?.stateBoundary || {};
  const preEditRisk = bundle.validation?.preEditRisk || {};
  const codeGraph = bundle.architecture?.codeGraph || bundle.architecture?.map?.codeGraph || bundle.architecture?.trace?.codeGraph || {};
  const objectiveCoverage = bundle.validation?.objectiveCoverage || {};
  const takeoverAcceptance = bundle.validation?.takeoverAcceptanceAudit || {};
  const changedFiles = bundle.architecture?.changedFiles || [];
  const folders = bundle.architecture?.impact?.topFolders || bundle.architecture?.impact?.folders || [];
  const firstRiskCheck = preEditRisk.firstChecks?.[0];
  const firstAcceptanceGap = (takeoverAcceptance.rows || []).find((row) => row.status !== "ok");
  const firstObjectiveGap = (objectiveCoverage.requirements || []).find((item) => item.status !== "ok");
  const sourceFilesByRef = new Map((bundle.validation?.sourceFiles || []).filter((file) => file?.path).map((file) => [normalizeRef(file.path), file]));
  const ledgerSourcesByRef = new Map((provenance.sources || []).filter((source) => source?.ref).map((source) => [normalizeRef(source.ref), source]));
  const sourceHashesForRefs = (refs = []) => [...new Set(refs.map(normalizeRef).filter(Boolean))]
    .map((ref) => {
      const ledgerSource = ledgerSourcesByRef.get(ref);
      const fileSource = sourceFilesByRef.get(ref);
      const hash = ledgerSource?.hash || fileSource?.sha256 || null;
      if (!hash) return null;
      return {
        ref,
        hash,
        schemaVersion: ledgerSource?.schemaVersion || fileSource?.schemaVersion || null,
        volatile: Boolean(ledgerSource?.volatile || fileSource?.volatile)
      };
    })
    .filter(Boolean)
    .slice(0, 6);
  const items = [
    attentionItem(
      "mission",
      "mission",
      100,
      "Mission",
      goal.objective || bundle.purpose || "Continue the active project goal from durable bundle state.",
      [".project-agent/governance-spec.json", ".project-agent/agent-context-bundle.json"]
    ),
    attentionItem(
      "current_cursor",
      "cursor",
      98,
      "Current Cursor",
      current.title
        ? `[${current.phase || "event"}/${current.status || "unknown"}] ${current.title}. ${current.detail || ""}`
        : "No current process cursor is available; verify process trace before editing.",
      [".project-agent/process-trace.json", ".project-agent/runtime.json", ...(current.refs || [])],
      { action: current.title ? "Resume from this cursor after running bundle verification." : "Restore the process current cursor before editing." }
    ),
    attentionItem(
      "next_command",
      "next_action",
      96,
      "Next Command",
      quick.nextCommand || "No next command is embedded; inspect takeover packet and runbook before editing.",
      [".project-agent/takeover-packet.json", ".project-agent/agent-runbook.json"],
      { action: quick.nextCommand || "Rebuild takeover packet/runbook next command." }
    ),
    attentionItem(
      "handoff_lifecycle",
      "handoff",
      lifecycle.status === "expired" ? 95 : 88,
      "Handoff Lifecycle",
      lifecycle.summary || `Handoff lifecycle status is ${lifecycle.status || "unknown"}.`,
      lifecycle.refs || [".project-agent/continuity.json", ".project-agent/agent-context-bundle.json"],
      { action: lifecycle.nextAction || "Check handoff lifecycle before accepting the bundle." }
    ),
    attentionItem(
      "freshness_gate",
      "freshness",
      ["expired", "stale"].includes(freshness.status) ? 94 : 84,
      "Freshness Gate",
      `${freshness.status || "unknown"} freshness. git=${gitFreshness.status || "unknown"}${gitFreshness.dirty?.entries ? ` dirty=${gitFreshness.dirty.entries}` : ""}. ${freshness.summary || "No temporal freshness summary is embedded."}`,
      [...(freshness.refs || [".project-agent/process-trace.json", ".project-agent/architecture-map.json", ".project-agent/state-manifest.json"]), ...(gitFreshness.refs || [])],
      { action: freshness.nextAction || "Record a fresh current event before editing." }
    ),
    attentionItem(
      "runtime_eval",
      "runtime_eval",
      runtimeEval.status === "fail" ? 93 : 82,
      "Runtime Eval",
      `${runtimeEval.status || "unknown"} runtime eval, score ${runtimeEval.score || "0/0"}. ${runtimeEval.summary || "No runtime trace evaluation is embedded."}`,
      runtimeEval.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/development-trail.json"],
      { action: runtimeEval.nextAction || "Keep runtime spans linked to evidence." }
    ),
    attentionItem(
      "phase_ledger",
      "runtime_eval",
      phaseLedger.status === "watch" || phaseLedger.status === "missing" ? 92 : phaseLedger.status === "flat" ? 86 : 83,
      "Phase Ledger",
      `${phaseLedger.status || "unknown"} phase ledger, ${phaseLedger.linkedCount || 0}/${phaseLedger.spanCount || 0} linked span(s), ${phaseLedger.runCount || 0} run group(s). ${phaseLedger.summary || "No phase ledger is embedded."}`,
      phaseLedger.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"],
      { action: phaseLedger.nextAction || "Check parent/child span links before replaying tool work." }
    ),
    attentionItem(
      "checkpoint_ledger",
      "runtime_eval",
      checkpointLedger.status === "blocked" ? 92 : checkpointLedger.pendingCount ? 88 : checkpointLedger.status === "watch" ? 84 : 81,
      "Checkpoint Ledger",
      `${checkpointLedger.status || "unknown"} checkpoint ledger, ${checkpointLedger.resumableCount || 0}/${checkpointLedger.checkpointCount || 0} resumable checkpoint(s), ${checkpointLedger.pendingCount || 0} pending. ${checkpointLedger.summary || "No checkpoint ledger is embedded."}`,
      checkpointLedger.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"],
      { action: checkpointLedger.nextAction || "Inspect resumable checkpoints before retrying or continuing work." }
    ),
    attentionItem(
      "decision_ledger",
      "provenance",
      decisionLedger.status === "blocked" ? 92 : decisionLedger.status === "watch" ? 87 : 82,
      "Decision Ledger",
      `${decisionLedger.status || "unknown"} decision ledger, ${decisionLedger.validCount || 0}/${decisionLedger.decisionCount || 0} valid decision(s). ${decisionLedger.summary || "No temporal decision ledger is embedded."}`,
      decisionLedger.refs || [".project-agent/state.json", ".project-agent/governance-spec.json", "docs/research/agent-governance-landscape.md"],
      { action: decisionLedger.nextAction || "Review sourceRefs and validity windows before trusting project decisions." }
    ),
    attentionItem(
      "temporal_provenance",
      "provenance",
      temporalProvenance.status === "blocked" ? 93 : temporalProvenance.status === "watch" ? 88 : 83,
      "Temporal Provenance",
      `${temporalProvenance.status || "unknown"} temporal provenance, ${temporalProvenance.validCount || 0}/${temporalProvenance.factCount || 0} valid fact(s), stale ${temporalProvenance.staleCount || 0}, contradictions ${temporalProvenance.contradictionCount || 0}. ${temporalProvenance.summary || "No temporal provenance audit is embedded."}`,
      temporalProvenance.refs || [".project-agent/continuity.json#temporalProvenance", ".project-agent/memory-graph.json", ".project-agent/continuity.json#decisionLedger"],
      { action: temporalProvenance.nextAction || "Check fact validity windows, source hashes, and stale sources before trusting memory." }
    ),
    attentionItem(
      "hook_ingress",
      "runtime_eval",
      hookIngressAudit.status === "blocked" ? 92 : hookIngressAudit.status === "watch" ? 84 : 80,
      "Hook Ingress",
      `${hookIngressAudit.status || "unknown"} hook ingress, accepted ${hookIngressAudit.acceptedEvents || 0}. ${hookIngressAudit.summary || "No hook ingress audit is embedded."}`,
      hookIngressAudit.refs || ["/api/hooks", "/api/events", ".project-agent/runtime.json"],
      { action: hookIngressAudit.nextAction || "Use sanitized hook ingress for external agent/tool events." }
    ),
    attentionItem(
      "state_boundary",
      "provenance",
      stateBoundary.status === "blocked" ? 93 : stateBoundary.status === "watch" ? 88 : 82,
      "State Boundary",
      `${stateBoundary.status || "unknown"} state boundary, ${stateBoundary.totals?.sourceRefs || 0} source ref(s), ${stateBoundary.totals?.derivedIndexes || 0} derived index(es), ${stateBoundary.totals?.disclosureOutputs || 0} disclosure output(s). ${stateBoundary.summary || "No source/index/disclosure boundary audit is embedded."}`,
      stateBoundary.refs || [".project-agent/continuity.json#stateBoundary", ".project-agent/agent-context-bundle.json"],
      { action: stateBoundary.nextAction || "Use raw events and durable sources as authority before trusting generated indexes or prompts." }
    ),
    attentionItem(
      "provenance_ledger",
      "provenance",
      provenance.status === "blocked" ? 92 : 80,
      "Provenance Ledger",
      `${provenance.status || "unknown"} provenance, hashed coverage ${provenance.coverage?.hashedCoverage || "0/0"}. ${provenance.summary || "No source provenance ledger is embedded."}`,
      provenance.refs || [".project-agent/agent-context-bundle.json", ".project-agent/state-manifest.json"],
      { action: provenance.nextAction || "Check sourceRefs and hashes before trusting remembered facts." }
    ),
    attentionItem(
      "pre_edit_risk",
      "risk",
      ["blocked", "high"].includes(preEditRisk.status) ? 91 : 79,
      "Pre-Edit Risk",
      `${preEditRisk.status || "unknown"} pre-edit risk, score ${preEditRisk.score || "0/0"}. ${preEditRisk.summary || "No pre-edit risk summary is embedded."}`,
      preEditRisk.refs || firstRiskCheck?.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"],
      { action: firstRiskCheck?.action || preEditRisk.nextAction || "Inspect risky files before editing." }
    ),
    attentionItem(
      "code_graph",
      "source",
      (codeGraph.changedImpact || []).some((item) => item.dependents?.length) ? 86 : codeGraph.nodeCount ? 77 : 61,
      "Code Graph",
      codeGraph.nodeCount
        ? `${codeGraph.status || "unknown"} code graph, ${codeGraph.nodeCount || 0} node(s), ${codeGraph.localEdgeCount || 0} local edge(s), ${codeGraph.packageEdgeCount || 0} package edge(s). ${(codeGraph.changedImpact || []).slice(0, 3).map((item) => `${item.path}: ${(item.dependents || []).length} dependent(s)`).join("; ") || codeGraph.summary || ""}`
        : "No code dependency graph is embedded.",
      codeGraph.refs || [".project-agent/architecture-map.json"],
      { action: codeGraph.nextAction || "Inspect dependency impact before editing imported files." }
    ),
    attentionItem(
      "changed_files",
      "changed_file",
      changedFiles.length ? 78 : 62,
      "Changed Files",
      changedFiles.length
        ? changedFiles.slice(0, 6).map((file) => `${file.status || "changed"} ${file.path}`).join("; ")
        : "No changed files are listed in the bundle architecture delta.",
      [".project-agent/architecture-map.json", ...changedFiles.slice(0, 6).map((file) => file.path)],
      { action: "Open these files before broad edits." }
    ),
    attentionItem(
      "objective_coverage",
      "acceptance",
      objectiveCoverage.status === "blocked" ? 90 : 76,
      "Objective Coverage",
      `${objectiveCoverage.status || "unknown"} objective coverage, score ${objectiveCoverage.score || "0/0"}. ${firstObjectiveGap?.nextAction || objectiveCoverage.summary || "No objective coverage map is embedded."}`,
      [".project-agent/governance-spec.json", ".project-agent/agent-context-bundle.json", ...(firstObjectiveGap?.evidence || [])],
      { action: firstObjectiveGap?.nextAction || "Keep acceptance tied to the user objective." }
    ),
    attentionItem(
      "takeover_acceptance",
      "acceptance",
      takeoverAcceptance.status === "fail" ? 89 : 74,
      "Takeover Acceptance",
      `${takeoverAcceptance.status || "unknown"} takeover acceptance, score ${takeoverAcceptance.score || "0/0"}. ${firstAcceptanceGap?.detail || takeoverAcceptance.summary || "No takeover acceptance audit is embedded."}`,
      [".project-agent/takeover-acceptance-audit.json", ...(firstAcceptanceGap?.refs || [])],
      { action: firstAcceptanceGap?.nextAction || "Re-run acceptance audit before handoff claims." }
    ),
    attentionItem(
      "read_first",
      "source",
      72,
      "Read First",
      (bundle.readOrder || []).slice(0, 5).join(" -> ") || "No read order is embedded.",
      (bundle.readOrder || []).slice(0, 5),
      { action: "Use this order before relying on prior chat context." }
    )
  ].filter((item) => item.text);
  if (nextExpected.title) {
    items.push(attentionItem(
      "next_expected",
      "cursor",
      70,
      "Next Expected",
      `[${nextExpected.phase || "event"}/${nextExpected.status || "unknown"}] ${nextExpected.title}. ${nextExpected.detail || ""}`,
      [".project-agent/process-trace.json", ...(nextExpected.refs || [])]
    ));
  }
  if (folders.length) {
    items.push(attentionItem(
      "impacted_folders",
      "source",
      68,
      "Impacted Folders",
      folders.slice(0, 5).map((folder) => `${folder.folder || "."}: ${folder.summary || `${folder.files || 0} file(s)`}`).join("; "),
      [".project-agent/architecture-map.json"]
    ));
  }
  const ranked = items
    .sort((a, b) => b.priority - a.priority)
    .map((item, index) => ({ ...item, rank: index + 1, sourceHashes: sourceHashesForRefs(item.refs) }));
  const renderLines = (visibleItems) => [
    `Attention Pack: ${goal.objective || "Continue active goal."}`,
    `Current: ${current.title || "No current cursor."}`,
    `Next: ${quick.nextCommand || "No next command."}`,
    ...visibleItems.map((item) => `${item.rank}. [${item.kind}] ${item.label}: ${item.text}${item.action ? ` Next: ${item.action}` : ""}`)
  ];
  let packedItems = ranked.slice(0, 12);
  let lines = renderLines(packedItems);
  let estimatedTokens = estimateDisclosureTokens(lines.join("\n"));
  while (estimatedTokens > budgetTokens && packedItems.length > 8) {
    packedItems = packedItems.slice(0, -1);
    lines = renderLines(packedItems);
    estimatedTokens = estimateDisclosureTokens(lines.join("\n"));
  }
  const warnings = [
    !goal.objective ? "missing_mission" : "",
    !current.title ? "missing_current_cursor" : "",
    !quick.nextCommand ? "missing_next_command" : "",
    ["expired", "stale"].includes(freshness.status) ? "freshness_needs_refresh" : "",
    runtimeEval.status === "fail" ? "runtime_eval_failed" : "",
    checkpointLedger.status === "blocked" ? "checkpoint_ledger_blocked" : checkpointLedger.pendingCount ? "checkpoint_pending_writes" : "",
    (codeGraph.changedImpact || []).some((item) => item.dependents?.length) ? "dependency_impact_watch" : "",
    provenance.status === "blocked" ? "provenance_blocked" : "",
    ["blocked", "high"].includes(preEditRisk.status) ? "pre_edit_risk_high" : ""
  ].filter(Boolean);
  const blockers = warnings.filter((warning) => ["missing_current_cursor", "missing_next_command"].includes(warning));
  if (estimatedTokens > budgetTokens) warnings.push("token_budget");
  const status = blockers.length
    ? "blocked"
    : estimatedTokens > budgetTokens
      ? "over_budget"
      : warnings.length
        ? "watch"
        : "ready";
  const refs = [...new Set([
    ".project-agent/agent-context-bundle.json",
    ...packedItems.flatMap((item) => item.refs || []),
    ...(bundle.readOrder || []).slice(0, 4)
  ].map(normalizeRef).filter(Boolean))].slice(0, 16);
  return {
    schemaVersion: "project-agent.attention-pack.v1",
    generatedAt: nowIso(),
    status,
    summary:
      status === "ready"
        ? `Top-of-mind pack fits ${budgetTokens} tokens and covers ${packedItems.length} priority item(s).`
        : status === "over_budget"
          ? `Top-of-mind pack exceeds ${budgetTokens} tokens after trimming.`
          : status === "blocked"
            ? `Top-of-mind pack is missing ${blockers.length} critical handoff item(s).`
            : `Top-of-mind pack is usable with ${warnings.length} warning(s).`,
    budget: {
      estimatedTokens,
      budgetTokens,
      tokenUtilization: budgetTokens ? Number((estimatedTokens / budgetTokens).toFixed(2)) : 0,
      items: packedItems.length
    },
    items: packedItems,
    readFirst: refs.slice(0, 10).map((ref) => ({
      ref,
      reason: ref === ".project-agent/agent-context-bundle.json" ? "bundle index" : "top-of-mind source"
    })),
    prompt: {
      lines,
      markdown: lines.map((line) => `- ${line}`).join("\n")
    },
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    refs,
    nextAction:
      blockers.length
        ? "Restore current cursor and next command before handing off."
        : "Start from this pack, then verify its refs before editing."
  };
}

function buildProvenanceLedger(bundle = {}) {
  const manifest = bundle.validation?.stateManifest || {};
  const manifestFiles = Array.isArray(bundle.validation?.sourceFiles) ? bundle.validation.sourceFiles : manifest.files || [];
  const manifestByPath = new Map((manifestFiles || []).filter((file) => file?.path).map((file) => [normalizeRef(file.path), file]));
  const architectureByPath = new Map((bundle.architecture?.changedFiles || []).filter((file) => file?.path).map((file) => [normalizeRef(file.path), file]));
  const freshness = bundle.validation?.freshnessGate || {};
  const runtimeEval = bundle.validation?.runtimeEval || {};
  const phaseLedger = bundle.validation?.phaseLedger || {};
  const checkpointLedger = bundle.validation?.checkpointLedger || {};
  const decisionLedger = bundle.validation?.decisionLedger || {};
  const temporalProvenance = bundle.validation?.temporalProvenance || {};
  const hookIngressAudit = bundle.validation?.hookIngressAudit || {};
  const stateBoundary = bundle.validation?.stateBoundary || {};
  const preEditRisk = bundle.validation?.preEditRisk || {};
  const codeGraph = bundle.architecture?.codeGraph || bundle.architecture?.map?.codeGraph || bundle.architecture?.trace?.codeGraph || {};
  const lifecycle = bundle.handoff?.lifecycle || {};
  const objectiveCoverage = bundle.validation?.objectiveCoverage || {};
  const takeoverAcceptance = bundle.validation?.takeoverAcceptanceAudit || {};
  const memoryGraph = bundle.memory?.graph || {};
  const memoryNodeCount = memoryGraph.nodeCount || memoryGraph.nodes?.length || 0;
  const memoryEdgeCount = memoryGraph.edgeCount || memoryGraph.edges?.length || 0;
  const architectureMap = bundle.architecture?.map || {};
  const architectureFileCount = architectureMap.totals?.files || architectureMap.files?.length || 0;
  const architectureChangedCount = bundle.architecture?.changedFiles?.length || architectureMap.recentChanges?.length || architectureMap.totals?.changed || 0;
  const claims = [
    provenanceClaim(
      "memory_graph",
      "Memory Graph",
      memoryNodeCount && (memoryEdgeCount || bundle.memory?.budget?.sourceRef) ? "ok" : "warn",
      `${memoryNodeCount} node(s), ${memoryEdgeCount} edge(s), provenance ${memoryGraph.provenanceCoverage || "unknown"}.`,
      [".project-agent/memory-graph.json", ".project-agent/state.json", ...(memoryGraph.provenanceRefs || []).slice(0, 6)]
    ),
    provenanceClaim(
      "process_trace",
      "Process Trace",
      bundle.process?.trace?.current ? "ok" : "bad",
      bundle.process?.trace?.current ? `${bundle.process.trace.current.phase}/${bundle.process.trace.current.status}: ${bundle.process.trace.current.title}` : "No process current cursor.",
      [".project-agent/process-trace.json", ".project-agent/runtime.json", bundle.process?.trace?.current?.id, ...(bundle.process?.trace?.current?.refs || [])],
      { observedAt: bundle.process?.trace?.current?.at || null }
    ),
    provenanceClaim(
      "architecture_map",
      "Architecture Map",
      architectureFileCount ? "ok" : "bad",
      `${architectureFileCount} architecture file(s), ${architectureChangedCount} changed file(s).`,
      [".project-agent/architecture-map.json", ...(bundle.architecture?.changedFiles || []).slice(0, 8).map((file) => file.path)],
      { observedAt: architectureMap.scannedAt || bundle.architecture?.trace?.scannedAt || null }
    ),
    provenanceClaim(
      "code_graph",
      "Code Graph",
      codeGraph.nodeCount ? (codeGraph.localEdgeCount || codeGraph.packageEdgeCount ? "ok" : "warn") : "warn",
      codeGraph.nodeCount
        ? `${codeGraph.nodeCount || 0} code node(s), ${codeGraph.localEdgeCount || 0} local edge(s), ${codeGraph.packageEdgeCount || 0} package edge(s), ${(codeGraph.changedImpact || []).length} changed impact row(s).`
        : "No code dependency graph summary.",
      [".project-agent/architecture-map.json", ...(codeGraph.changedImpact || []).flatMap((item) => [item.path, ...(item.dependents || []), ...(item.dependencies || [])]).slice(0, 8)],
      { observedAt: codeGraph.scannedAt || bundle.architecture?.map?.scannedAt || null }
    ),
    provenanceClaim(
      "state_manifest",
      "State Manifest",
      bundle.validation?.stateManifestVerification?.ok ? "ok" : "bad",
      bundle.validation?.stateManifestVerification?.summary || `${manifest.fileCount || 0} manifest source file(s).`,
      [".project-agent/state-manifest.json", ...(manifestFiles || []).slice(0, 8).map((file) => file.path)],
      { observedAt: manifest.generatedAt || null }
    ),
    provenanceClaim(
      "freshness_gate",
      "Freshness Gate",
      ["stale", "expired"].includes(freshness.status) ? "warn" : freshness.status ? "ok" : "warn",
      freshness.git?.status
        ? `${freshness.summary || "No freshness gate summary."} Git ${freshness.git.status}${freshness.git.dirty?.entries ? ` with ${freshness.git.dirty.entries} dirty change(s)` : ""}.`
        : freshness.summary || "No freshness gate summary.",
      [...(freshness.refs || [".project-agent/agent-context-bundle.json", ".project-agent/process-trace.json"]), ...(freshness.git?.refs || [])],
      {
        observedAt: freshness.validity?.observedAt || freshness.observedAt || null,
        validFrom: freshness.validity?.validFrom || null,
        validUntil: freshness.validity?.validUntil || null
      }
    ),
    provenanceClaim(
      "runtime_eval",
      "Runtime Eval",
      runtimeEval.status === "fail" ? "warn" : runtimeEval.status ? "ok" : "warn",
      runtimeEval.summary || "No runtime eval summary.",
      runtimeEval.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/development-trail.json"],
      { observedAt: runtimeEval.trace?.latestAt || null }
    ),
    provenanceClaim(
      "phase_ledger",
      "Phase Ledger",
      phaseLedger.status === "linked" ? "ok" : phaseLedger.status ? "warn" : "warn",
      phaseLedger.summary || "No phase ledger summary.",
      phaseLedger.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"],
      { observedAt: phaseLedger.latestAt || null }
    ),
    provenanceClaim(
      "checkpoint_ledger",
      "Checkpoint Ledger",
      checkpointLedger.status === "ready" ? "ok" : checkpointLedger.status ? "warn" : "warn",
      checkpointLedger.summary || "No checkpoint ledger summary.",
      checkpointLedger.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json#checkpointLedger"],
      { observedAt: checkpointLedger.latestAt || null }
    ),
    provenanceClaim(
      "decision_ledger",
      "Decision Ledger",
      decisionLedger.status === "traceable" ? "ok" : decisionLedger.status ? "warn" : "warn",
      decisionLedger.summary || "No decision ledger summary.",
      decisionLedger.refs || [".project-agent/state.json", ".project-agent/governance-spec.json", "docs/research/agent-governance-landscape.md"],
      { observedAt: decisionLedger.decisions?.[0]?.observedAt || null }
    ),
    provenanceClaim(
      "temporal_provenance",
      "Temporal Provenance",
      temporalProvenance.status === "traceable" ? "ok" : temporalProvenance.status ? "warn" : "warn",
      temporalProvenance.summary || "No temporal provenance audit summary.",
      temporalProvenance.refs || [".project-agent/continuity.json#temporalProvenance", ".project-agent/memory-graph.json", ".project-agent/continuity.json#decisionLedger"],
      {
        observedAt: temporalProvenance.facts?.[0]?.observedAt || null,
        validFrom: temporalProvenance.facts?.[0]?.validFrom || null,
        validUntil: temporalProvenance.facts?.[0]?.validUntil || null
      }
    ),
    provenanceClaim(
      "hook_ingress",
      "Hook Ingress",
      hookIngressAudit.status === "blocked" ? "warn" : hookIngressAudit.status ? "ok" : "warn",
      hookIngressAudit.summary || "No hook ingress audit summary.",
      hookIngressAudit.refs || ["/api/hooks", "/api/events", ".project-agent/runtime.json"],
      { observedAt: hookIngressAudit.latestAt || null }
    ),
    provenanceClaim(
      "state_boundary",
      "State Boundary",
      stateBoundary.status === "blocked" ? "warn" : stateBoundary.status ? "ok" : "warn",
      stateBoundary.summary || "No source/index/disclosure boundary summary.",
      stateBoundary.refs || [".project-agent/continuity.json#stateBoundary", ".project-agent/continuity-contract.json", ".project-agent/agent-context-bundle.json"]
    ),
    provenanceClaim(
      "pre_edit_risk",
      "Pre-Edit Risk",
      preEditRisk.status === "blocked" ? "warn" : preEditRisk.status ? "ok" : "warn",
      preEditRisk.summary || "No pre-edit risk summary.",
      preEditRisk.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"]
    ),
    provenanceClaim(
      "handoff_lifecycle",
      "Handoff Lifecycle",
      lifecycle.status === "expired" ? "warn" : lifecycle.status ? "ok" : "warn",
      lifecycle.summary || "No handoff lifecycle summary.",
      lifecycle.refs || [".project-agent/continuity.json", ".project-agent/agent-context-bundle.json"],
      { observedAt: lifecycle.acceptedAt || lifecycle.openedAt || null, validUntil: lifecycle.expiresAt || null }
    ),
    provenanceClaim(
      "objective_coverage",
      "Objective Coverage",
      objectiveCoverage.status === "blocked" ? "warn" : objectiveCoverage.status ? "ok" : "warn",
      objectiveCoverage.summary || "No objective coverage summary.",
      [".project-agent/governance-spec.json", ".project-agent/agent-context-bundle.json", ...(objectiveCoverage.proofSources || []).flatMap((item) => item.evidence || []).slice(0, 6)]
    ),
    provenanceClaim(
      "takeover_acceptance",
      "Takeover Acceptance",
      takeoverAcceptance.status === "pass" ? "ok" : takeoverAcceptance.status ? "warn" : "warn",
      takeoverAcceptance.summary || "No takeover acceptance audit summary.",
      [".project-agent/takeover-acceptance-audit.json", ...(takeoverAcceptance.rows || []).flatMap((row) => row.refs || []).slice(0, 6)]
    )
  ];
  const sourcesByRef = new Map();
  for (const claim of claims) {
    for (const ref of claim.sourceRefs || []) {
      if (!sourcesByRef.has(ref)) sourcesByRef.set(ref, sourceRecordForRef(ref, manifestByPath, architectureByPath));
    }
  }
  const sources = [...sourcesByRef.values()];
  const hashedSources = sources.filter((source) => source.hash);
  const missingManifestRefs = sources.filter((source) => source.kind === "manifest_file" && source.exists === false).map((source) => source.ref);
  const unsourcedClaims = claims.filter((claim) => !claim.sourceRefs?.length).map((claim) => claim.id);
  const warnClaims = claims.filter((claim) => claim.status === "warn").map((claim) => claim.id);
  const badClaims = claims.filter((claim) => claim.status === "bad").map((claim) => claim.id);
  const status = badClaims.length || missingManifestRefs.length
    ? "blocked"
    : unsourcedClaims.length || warnClaims.length
      ? "watch"
      : "traceable";
  return {
    schemaVersion: "project-agent.provenance-ledger.v1",
    status,
    summary:
      status === "traceable"
        ? "Core takeover claims are backed by source refs and manifest/file hashes."
        : status === "watch"
          ? `Provenance is usable with ${warnClaims.length + unsourcedClaims.length} warning(s).`
          : `Provenance is blocked by ${badClaims.length + missingManifestRefs.length} source issue(s).`,
    coverage: {
      claims: claims.length,
      sourcedClaims: claims.filter((claim) => claim.sourceRefs?.length).length,
      sources: sources.length,
      hashedSources: hashedSources.length,
      hashedCoverage: sources.length ? `${hashedSources.length}/${sources.length}` : "0/0",
      manifestFiles: manifestFiles.length,
      aggregateHash: manifest.aggregateHash || null
    },
    claims,
    sources: sources.slice(0, 40),
    warnings: [...new Set([...warnClaims, ...unsourcedClaims])],
    blockers: [...new Set([...badClaims, ...missingManifestRefs])],
    refs: [".project-agent/agent-context-bundle.json", ".project-agent/state-manifest.json", ".project-agent/memory-graph.json", ".project-agent/process-trace.json"],
    nextAction:
      status === "traceable"
        ? "Use sourceRefs and hashes before trusting a remembered fact or handoff claim."
        : "Refresh state manifest and add source refs for warning claims before broad edits."
  };
}

export function buildDisclosureGate(bundle, options = {}) {
  const payload = sanitizeDisclosurePayload(bundle || {}) || {};
  const payloadText = JSON.stringify(payload);
  const readableText = collectDisclosureText(payload).join("\n");
  const estimatedTokens = estimateDisclosureTokens(payloadText);
  const budgetTokens = Number(options.budgetTokens || DISCLOSURE_TOKEN_BUDGET);
  const tokenUtilization = budgetTokens ? Number((estimatedTokens / budgetTokens).toFixed(2)) : 0;
  const secretFindings = scanSecretLikeText(readableText);
  const packing = buildPromptPackingGate(bundle, options);
  const warnings = [];
  const blockers = [];
  if (estimatedTokens > budgetTokens) warnings.push("token_budget");
  for (const warning of packing.warnings || []) warnings.push(`packing_${warning}`);
  if (secretFindings.length) blockers.push("secret_like_content");
  const status = blockers.length ? "bad" : warnings.length ? "warn" : "ok";
  return {
    schemaVersion: "project-agent.disclosure-gate.v1",
    status,
    canPublish: blockers.length === 0,
    summary: blockers.length
      ? `${secretFindings.length} secret-like finding(s) must be removed before publishing the handoff bundle.`
      : estimatedTokens > budgetTokens
        ? `Estimated ${estimatedTokens} token(s) exceeds the ${budgetTokens} token disclosure budget.`
        : packing.warnings?.length
          ? packing.summary
          : `Handoff disclosure is within the ${budgetTokens} token budget, file/byte limits, and has no secret-like findings.`,
    payloadHash: sha256(payloadText),
    budget: {
      estimatedTokens,
      budgetTokens,
      tokenUtilization,
      characters: payloadText.length,
      readableCharacters: readableText.length,
      maxFiles: packing.limits.maxFiles,
      maxBytes: packing.limits.maxBytes,
      includedFiles: packing.totals.includedFiles,
      includedBytes: packing.totals.includedBytes
    },
    scope: {
      readOrderCount: bundle?.readOrder?.length || 0,
      sourceFileCount: bundle?.validation?.sourceFiles?.length || 0,
      changedFileCount: bundle?.architecture?.changedFiles?.length || 0,
      includedFileCount: packing.totals.includedFiles,
      omittedFileCount: packing.totals.omittedFiles,
      omittedRefCount: packing.totals.omittedRefs,
      totalBytes: packing.totals.bytes,
      includedBytes: packing.totals.includedBytes,
      omittedBytes: packing.totals.omittedBytes
    },
    packing,
    scan: {
      rules: DISCLOSURE_SECRET_RULES.map((rule) => rule.id),
      findings: secretFindings
    },
    blockers,
    warnings,
    refs: [".project-agent/agent-context-bundle.json", ".project-agent/next-agent-prompt.md"]
  };
}

function jsonText(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value ?? ""));
  }
}

function sectionBudget(section, value, budget = {}) {
  const text = jsonText(value);
  const bytes = Buffer.byteLength(text, "utf8");
  const estimatedTokens = estimateDisclosureTokens(text);
  const maxBytes = Number(budget.maxBytes || 0);
  const maxTokens = Number(budget.maxTokens || 0);
  const overBytes = Boolean(maxBytes && bytes > maxBytes);
  const overTokens = Boolean(maxTokens && estimatedTokens > maxTokens);
  return {
    schemaVersion: "project-agent.memory-budget.v1",
    section,
    status: overBytes || overTokens ? "summary_only" : "inline",
    sourceRef: budget.sourceRef || null,
    contentHash: sha256(text),
    limits: { maxBytes, maxTokens },
    actual: {
      bytes,
      estimatedTokens,
      byteUtilization: maxBytes ? Number((bytes / maxBytes).toFixed(2)) : 0,
      tokenUtilization: maxTokens ? Number((estimatedTokens / maxTokens).toFixed(2)) : 0
    },
    omitted: overBytes || overTokens ? { reason: overBytes ? "max_bytes" : "max_tokens", bytes, estimatedTokens } : null,
    read: budget.sourceRef
      ? {
          command: `jq '${budget.jq || "."}' ${budget.sourceRef}`,
          api: `/api/context-read?ref=${encodeURIComponent(budget.sourceRef)}`
        }
      : null
  };
}

function eventSummary(event = {}) {
  if (!event) return null;
  return {
    id: event.id || null,
    at: event.at || event.startedAt || null,
    phase: event.phase || "event",
    status: event.status || "unknown",
    title: event.title || null,
    detail: compact(event.detail || event.summary || "", 280),
    refs: (event.refs || []).slice(0, 8),
    files: (event.files || []).slice(0, 6).map((file) => ({
      path: file.path,
      status: file.status,
      kind: file.kind,
      summary: file.summary
    }))
  };
}

function memoryGraphSummary(graph = {}, budget = null) {
  if (!graph) return null;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  return {
    schemaVersion: "project-agent.memory-graph-summary.v1",
    status: nodes.length ? "available" : "missing",
    nodeCount: graph.nodeCount || nodes.length || 0,
    edgeCount: graph.edgeCount || edges.length || 0,
    provenanceCoverage: graph.provenanceCoverage || "unknown",
    summary: graph.summary || `${graph.nodeCount || nodes.length || 0} node(s), ${graph.edgeCount || edges.length || 0} edge(s).`,
    nodes: nodes.slice(0, 12).map((node) => ({
      id: node.id,
      label: node.label || node.title || node.id,
      kind: node.kind || node.type,
      status: node.status,
      detail: compact(node.detail || node.summary || node.description || "", 220),
      provenance: (node.provenance || node.refs || []).slice?.(0, 4) || []
    })),
    edges: edges.slice(0, 16).map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label || edge.relation || edge.type,
      refs: (edge.refs || edge.provenance || []).slice?.(0, 4) || []
    })),
    provenanceRefs: (graph.provenanceRefs || []).slice(0, 12),
    sourceRef: ".project-agent/memory-graph.json",
    budget
  };
}

function processTraceSummary(trace = {}, recentEvents = [], budget = null) {
  if (!trace) return null;
  return {
    schemaVersion: "project-agent.process-trace-summary.v1",
    status: trace.current ? "available" : "missing",
    current: eventSummary(trace.current),
    previous: eventSummary(trace.previous),
    next: eventSummary(trace.next),
    workstream: trace.workstream || null,
    phaseCount: trace.phases?.length || 0,
    eventCount: trace.events?.length || recentEvents.length || 0,
    phases: (trace.phases || []).slice(0, 8).map((phase) => ({
      id: phase.id,
      phase: phase.phase || phase.label,
      status: phase.status,
      title: phase.title,
      refs: (phase.refs || []).slice?.(0, 4) || []
    })),
    recentEvents: (trace.events || recentEvents || []).slice(0, 8).map(eventSummary).filter(Boolean),
    inspectOrder: (trace.inspectOrder || []).slice(0, 12),
    sourceRef: ".project-agent/process-trace.json",
    budget
  };
}

function developmentTrailSummary(trail = {}, budget = null) {
  if (!trail) return null;
  return {
    schemaVersion: "project-agent.development-trail-summary.v1",
    status: trail.status || "unknown",
    summary: trail.summary || null,
    current: trail.current || null,
    fileCoverage: trail.fileCoverage || null,
    steps: (trail.steps || []).slice(0, 8).map((step) => ({
      id: step.id,
      label: step.label || step.phase,
      status: step.status,
      title: step.title,
      risk: step.risk,
      files: (step.files || []).slice(0, 6).map((file) => ({ path: file.path, status: file.status, kind: file.kind })),
      folders: (step.folders || []).slice(0, 4).map((folder) => ({ folder: folder.folder, summary: folder.summary })),
      nextAction: step.nextAction
    })),
    inspectOrder: (trail.inspectOrder || []).slice(0, 12),
    sourceRef: ".project-agent/development-trail.json",
    budget
  };
}

function codeGraphSummary(graph = {}, budget = null) {
  if (!graph) return null;
  return {
    schemaVersion: "project-agent.code-graph-summary.v1",
    status: graph.status || "unknown",
    nodeCount: graph.nodeCount || graph.nodes?.length || 0,
    edgeCount: graph.edgeCount || graph.edges?.length || 0,
    localEdgeCount: graph.localEdgeCount || 0,
    packageEdgeCount: graph.packageEdgeCount || 0,
    unresolvedEdgeCount: graph.unresolvedEdgeCount || 0,
    summary: graph.summary || null,
    hotspots: (graph.hotspots || []).slice(0, 8),
    changedImpact: (graph.changedImpact || []).slice(0, 8).map((item) => ({
      path: item.path,
      dependents: (item.dependents || []).slice(0, 6),
      dependencies: (item.dependencies || []).slice(0, 6),
      nextAction: item.nextAction
    })),
    warnings: (graph.warnings || []).slice(0, 8),
    sourceRef: ".project-agent/architecture-map.json#codeGraph",
    budget
  };
}

function architectureMapSummary(map = {}, budget = null) {
  if (!map) return null;
  const files = map.files || [];
  const recentChanges = map.recentChanges || map.changes || [];
  return {
    schemaVersion: "project-agent.architecture-map-summary.v1",
    status: files.length || map.totals?.files ? "available" : "missing",
    scannedAt: map.scannedAt || null,
    totals: map.totals || { files: files.length, directories: map.tree?.length || 0, changed: recentChanges.length },
    modules: (map.modules || []).slice(0, 12),
    recentChanges: recentChanges.slice(0, 12).map((change) => ({
      path: change.path,
      status: change.status,
      kind: change.kind,
      summary: change.summary,
      modifiedAt: change.modifiedAt,
      additions: change.additions || 0,
      deletions: change.deletions || 0,
      hash: change.hash || change.previousHash || null
    })),
    impact: map.impact
      ? {
          totals: map.impact.totals || {},
          topFolders: (map.impact.topFolders || map.impact.folders || []).slice(0, 6)
        }
      : null,
    inspectOrder: (map.inspectOrder || []).slice(0, 16),
    codeGraph: codeGraphSummary(map.codeGraph),
    sourceRef: ".project-agent/architecture-map.json",
    budget
  };
}

function takeoverPacketSummary(packet = {}, budget = null) {
  if (!packet) return null;
  return {
    schemaVersion: "project-agent.takeover-packet-summary.v1",
    status: packet.status || (packet.canResume === false ? "blocked" : "ready"),
    canResume: packet.canResume !== false,
    objective: packet.objective || null,
    cursor: eventSummary(packet.cursor),
    nextCommand: packet.nextCommand || null,
    summary: packet.summary || null,
    firstActions: (packet.firstActions || []).slice(0, 5).map((item) => ({
      action: item.action,
      command: item.command,
      refs: (item.refs || []).slice(0, 6)
    })),
    firstRead: (packet.firstRead || packet.readFirst || []).slice(0, 8),
    guardrails: (packet.guardrails || []).slice(0, 8),
    interruptedWork: packet.interruptedWork
      ? { count: packet.interruptedWork.count || 0, items: (packet.interruptedWork.items || []).slice(0, 4) }
      : null,
    sourceRef: ".project-agent/takeover-packet.json",
    budget
  };
}

function budgetedMemorySection(memoryGraph, graphTrace) {
  const full = { graph: memoryGraph || null, graphTrace: graphTrace || null };
  const budget = sectionBudget("memory", full, SECTION_BUDGETS.memory);
  if (budget.status === "inline") return { budget, graph: memoryGraph || null, graphTrace: graphTrace || null };
  return {
    budget,
    graph: memoryGraphSummary(memoryGraph, budget),
    graphTrace: graphTrace ? { summary: graphTrace.summary || null, refs: graphTrace.refs || [] } : null
  };
}

function budgetedProcessSection({ trace, recentEvents, workstreams, developmentTrail, agentLeases }) {
  const full = { trace: trace || null, recentEvents: recentEvents || [], workstreams: workstreams || null, developmentTrail: developmentTrail || null, agentLeases: agentLeases || [] };
  const budget = sectionBudget("process", full, SECTION_BUDGETS.process);
  if (budget.status === "inline") return { budget, ...full };
  return {
    budget,
    trace: processTraceSummary(trace, recentEvents, budget),
    recentEvents: (recentEvents || []).slice(0, 8).map(eventSummary).filter(Boolean),
    workstreams: workstreams
      ? {
          active: workstreams.active || workstreams.workstream || null,
          count: workstreams.items?.length || workstreams.workstreams?.length || 0,
          sourceRef: ".project-agent/process-trace.json#workstreams"
        }
      : null,
    developmentTrail: developmentTrailSummary(developmentTrail, budget),
    agentLeases: (agentLeases || []).slice(0, 8)
  };
}

function budgetedArchitectureSection({ map, trace, codeGraph, impact, changedFiles }) {
  const full = { map: map || null, trace: trace || null, codeGraph: codeGraph || null, impact: impact || null, changedFiles: changedFiles || [] };
  const budget = sectionBudget("architecture", full, SECTION_BUDGETS.architecture);
  if (budget.status === "inline") return { budget, ...full };
  return {
    budget,
    map: architectureMapSummary(map, budget),
    trace: trace ? { status: trace.status || null, summary: trace.summary || null, inspectOrder: (trace.inspectOrder || []).slice(0, 16), sourceRef: ".project-agent/continuity.json#architectureTrace" } : null,
    codeGraph: codeGraphSummary(codeGraph || map?.codeGraph, budget),
    impact: impact || map?.impact ? { ...(impact || map.impact), folders: (impact?.folders || map?.impact?.folders || []).slice(0, 8), topFolders: (impact?.topFolders || map?.impact?.topFolders || []).slice(0, 5) } : null,
    changedFiles: (changedFiles || map?.recentChanges || map?.changes || []).slice(0, 12).map((file) => ({
      path: file.path,
      status: file.status,
      kind: file.kind,
      summary: file.summary,
      hash: file.hash || file.previousHash || null
    }))
  };
}

function budgetedHandoffSection({ lifecycle, takeoverPacket, startProtocol, nextAgentInstructions }) {
  const full = { lifecycle: lifecycle || null, takeoverPacket: takeoverPacket || null, startProtocol: startProtocol || null, nextAgentInstructions: nextAgentInstructions || [] };
  const budget = sectionBudget("handoff", full, SECTION_BUDGETS.handoff);
  const refs = {
    nextAgentPrompt: ".project-agent/next-agent-prompt.md",
    contextStarterPrompt: ".project-agent/context-starter-prompt.md",
    contextTakeoverDrill: ".project-agent/context-takeover-drill.json",
    resumeBrief: ".project-agent/resume.md",
    recoveryBrief: ".project-agent/recovery.md"
  };
  if (budget.status === "inline") return { budget, ...full, ...refs };
  return {
    budget,
    lifecycle: lifecycle
      ? {
          schemaVersion: lifecycle.schemaVersion,
          status: lifecycle.status,
          summary: lifecycle.summary,
          openedAt: lifecycle.openedAt,
          acceptedAt: lifecycle.acceptedAt,
          expiresAt: lifecycle.expiresAt,
          nextAction: lifecycle.nextAction,
          refs: (lifecycle.refs || []).slice(0, 8)
        }
      : null,
    takeoverPacket: takeoverPacketSummary(takeoverPacket, budget),
    startProtocol: startProtocol
      ? {
          status: startProtocol.status,
          summary: startProtocol.summary,
          readFirst: (startProtocol.readFirst || []).slice(0, 8),
          firstActions: (startProtocol.firstActions || []).slice(0, 5)
        }
      : null,
    nextAgentInstructions: (nextAgentInstructions || []).slice(0, 6),
    ...refs
  };
}

function handoffReadinessStatus({ acceptanceAudit, lifecycle, verification, interruptedWork, freshnessGate }) {
  const blockers = [
    verification && verification.canResume === false ? "bundle_verification" : "",
    acceptanceAudit && acceptanceAudit.canResume === false ? "takeover_acceptance" : ""
  ].filter(Boolean);
  const warnings = [
    lifecycle?.status === "expired" ? "handoff_expired" : "",
    interruptedWork?.count ? "interrupted_work" : "",
    freshnessGate && ["stale", "expired"].includes(freshnessGate.status) ? "freshness" : "",
    acceptanceAudit && acceptanceAudit.status && acceptanceAudit.status !== "pass" ? "acceptance_warning" : "",
    verification?.warnings?.length ? "bundle_warnings" : ""
  ].filter(Boolean);
  return {
    canTakeOver: blockers.length === 0,
    status: blockers.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready",
    blockers,
    warnings
  };
}

export function buildTakeoverSummary(projectDir, continuity = readContinuity(projectDir) || {}, options = {}) {
  const bundle = options.bundle || readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity);
  const quick = bundle.quickStart || {};
  const current = quick.currentCursor || continuity.processCursor || continuity.processTrace?.current || null;
  const nextExpected = quick.nextExpected || continuity.nextEvent || continuity.processTrace?.next || null;
  const acceptanceAudit = bundle.validation?.takeoverAcceptanceAudit || continuity.takeoverAcceptanceAudit || readTakeoverAcceptanceAudit(projectDir) || null;
  const verification = options.verification || verifyAgentContextBundle(projectDir, bundle);
  const lifecycle = bundle.handoff?.lifecycle || continuity.handoffLifecycle || continuity.continuityContract?.handoffLifecycle || null;
  const freshnessGate = bundle.validation?.freshnessGate || continuity.freshnessGate || continuity.continuityContract?.freshnessGate || null;
  const preEditRisk = bundle.validation?.preEditRisk || continuity.preEditRisk || null;
  const interruptedWork = quick.interruptedWork || continuity.interruptedWork || { count: 0, items: [] };
  const rawNextCommand = quick.nextCommand || continuity.agentRunbook?.nextCommand || continuity.continuityAudit?.nextCommand || null;
  const nextCommand = /^cat\s+\.project-agent\/(continuity|agent-context-bundle)\.json\b/.test(String(rawNextCommand || "").trim())
    ? "jq '{activeGoal,currentState,nextStep,takeover,risks,budgets,onDemandReads}' .project-agent/takeover-summary.json"
    : rawNextCommand;
  const budgets = {
    memory: bundle.memory?.budget || sectionBudget("memory", bundle.memory || null, SECTION_BUDGETS.memory),
    process: bundle.process?.budget || sectionBudget("process", bundle.process || null, SECTION_BUDGETS.process),
    architecture: bundle.architecture?.budget || sectionBudget("architecture", bundle.architecture || null, SECTION_BUDGETS.architecture),
    handoff: bundle.handoff?.budget || sectionBudget("handoff", bundle.handoff || null, SECTION_BUDGETS.handoff)
  };
  const summaryBudgets = Object.fromEntries(Object.entries(budgets).map(([name, budget]) => [
    name,
    {
      status: budget?.status || "unknown",
      sourceRef: budget?.sourceRef || null,
      contentHash: budget?.contentHash ? String(budget.contentHash).slice(0, 16) : null,
      maxBytes: budget?.limits?.maxBytes || 0,
      maxTokens: budget?.limits?.maxTokens || 0,
      bytes: budget?.actual?.bytes || 0,
      estimatedTokens: budget?.actual?.estimatedTokens || 0,
      omittedReason: budget?.omitted?.reason || null
    }
  ]));
  const readiness = handoffReadinessStatus({ acceptanceAudit, lifecycle, verification, interruptedWork, freshnessGate });
  const riskItems = [
    interruptedWork?.count ? {
      id: "interrupted_work",
      tone: "warn",
      summary: `${interruptedWork.count} interrupted item(s) must be resolved first.`,
      refs: (interruptedWork.items || []).flatMap((item) => [item.id, ...(item.refs || [])]).slice(0, 8)
    } : null,
    preEditRisk ? {
      id: "pre_edit_risk",
      tone: ["blocked", "high"].includes(preEditRisk.status) ? "warn" : "ok",
      summary: preEditRisk.summary || preEditRisk.nextAction || `pre-edit risk ${preEditRisk.status}`,
      refs: preEditRisk.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"]
    } : null,
    freshnessGate && ["stale", "expired"].includes(freshnessGate.status) ? {
      id: "freshness",
      tone: "warn",
      summary: freshnessGate.summary || `freshness ${freshnessGate.status}`,
      refs: freshnessGate.refs || [".project-agent/state-manifest.json"]
    } : null,
    verification.warnings?.length ? {
      id: "bundle_warnings",
      tone: "warn",
      summary: `${verification.warnings.length} bundle warning(s): ${verification.warnings.slice(0, 5).join(", ")}`,
      refs: [".project-agent/agent-context-bundle.json"]
    } : null
  ].filter(Boolean).slice(0, 6);
  const sourceRefs = [
    { path: ".project-agent/takeover-summary.json", reason: "default cold-start entry" },
    { path: ".project-agent/takeover-packet.json", reason: "first actions and guardrails", jq: "{cursor,nextCommand,firstActions,firstRead,guardrails}" },
    { path: ".project-agent/process-trace.json", reason: "current process cursor", jq: "{current,previous,next,inspectOrder}" },
    { path: ".project-agent/architecture-map.json", reason: "changed files and impacted folders", jq: "{totals,impact,recentChanges:.recentChanges[0:12],inspectOrder:.inspectOrder[0:16]}" },
    { path: ".project-agent/memory-graph.json", reason: "memory graph details on demand", jq: "{nodeCount,edgeCount,provenanceCoverage,nodes:.nodes[0:12],edges:.edges[0:16]}" },
    { path: ".project-agent/continuity-contract.json", reason: "agent-neutral contract", jq: "{status,agentState,inspectOrder,proofChecklist,freshnessGate,handoffLifecycle}" },
    { path: ".project-agent/agent-context-bundle.json", reason: "budgeted index; read fields only", jq: "{quickStart,validation:{agentContextBundleVerification,attentionPack,preEditRisk,freshnessGate},memory:{budget},process:{budget},architecture:{budget},handoff:{budget}}" }
  ];
  const onDemandReads = sourceRefs
    .filter((ref) => ref.jq)
    .map((ref) => ({
      label: ref.reason,
      ref: ref.path,
      command: `jq '${ref.jq}' ${ref.path}`
    }));
  const summary = {
    schemaVersion: "project-agent.takeover-summary.v1",
    generatedAt: nowIso(),
    project: path.basename(projectDir),
    purpose: "Small default takeover packet; read this first and use source refs for detail.",
    defaultReadOrder: [
      ".project-agent/takeover-summary.json",
      ".project-agent/context-starter-prompt.md",
      ".project-agent/takeover-packet.json",
      ".project-agent/process-trace.json#current",
      ".project-agent/architecture-map.json#recentChanges",
      ".project-agent/agent-context-bundle.json#quickStart"
    ],
    activeGoal: quick.activeGoal || continuity.activeGoal || null,
    currentState: current
      ? {
          phase: current.phase || "event",
          status: current.status || "unknown",
          title: current.title || null,
          detail: compact(current.detail || "", 420),
          refs: (current.refs || []).slice(0, 8)
        }
      : null,
    nextStep: {
      command: nextCommand,
      expected: nextExpected ? eventSummary(nextExpected) : null
    },
    takeover: {
      ...readiness,
      summary: readiness.canTakeOver
        ? readiness.warnings.length
          ? "A new agent can take over after checking listed warnings."
          : "A new agent can take over from the summary and source refs."
        : "A new agent should resolve blockers before editing."
    },
    risks: riskItems,
    budgets: summaryBudgets,
    retrieval: {
      mode: "grep-first",
      summary: "Search local project text first, return snippets and refs, then read exact refs on demand.",
      cli: "npm run grep-context -- --project-dir \"$PROJECT_DIR\" --query \"<task or active goal>\" --limit 8",
      readCli: "npm run grep-context -- --project-dir \"$PROJECT_DIR\" --read \"<ref>\" --max-bytes 6000",
      api: "/api/context-search?query=<task>",
      readApi: "/api/context-read?ref=<ref>&maxBytes=6000",
      rules: [
        "Do not load full agent-context-bundle.json or continuity.json by default.",
        "Use grep hits as candidate refs before opening larger source files.",
        "Treat embedding/vector/LLM retrieval as optional enhancement, not default takeover path."
      ]
    },
    sourceRefs: sourceRefs.map(({ jq, ...ref }) => ref),
    onDemandReads,
    hashes: {
      bundle: bundle.contentHash || bundleContentHash(bundle),
      memory: budgets.memory?.contentHash || null,
      process: budgets.process?.contentHash || null,
      architecture: budgets.architecture?.contentHash || null,
      handoff: budgets.handoff?.contentHash || null
    },
    validation: {
      bundleVerification: {
        status: verification.status,
        canResume: verification.canResume,
        summary: verification.summary,
        blockers: (verification.blockers || []).slice(0, 6),
        warnings: (verification.warnings || []).slice(0, 4)
      },
      acceptance: acceptanceAudit
        ? {
            status: acceptanceAudit.status,
            canResume: acceptanceAudit.canResume,
            score: acceptanceAudit.score,
            summary: acceptanceAudit.summary,
            warnings: (acceptanceAudit.warnings || []).slice(0, 4),
            blockers: (acceptanceAudit.blockers || []).slice(0, 6)
          }
        : null
    }
  };
  const text = jsonText(summary);
  const bytes = Buffer.byteLength(text, "utf8");
  const estimatedTokens = estimateDisclosureTokens(text);
  return {
    ...summary,
    budget: {
      status: bytes > TAKEOVER_SUMMARY_BYTE_BUDGET || estimatedTokens > TAKEOVER_SUMMARY_TOKEN_BUDGET ? "over_budget" : "ok",
      maxBytes: TAKEOVER_SUMMARY_BYTE_BUDGET,
      maxTokens: TAKEOVER_SUMMARY_TOKEN_BUDGET,
      bytes,
      estimatedTokens
    }
  };
}

export function writeTakeoverSummary(projectDir, summary = buildTakeoverSummary(projectDir)) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(takeoverSummaryPath(projectDir), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export function buildAgentContextBundle(projectDir, continuity = readContinuity(projectDir) || {}, options = {}) {
  const stateManifest = options.stateManifest || readStateManifest(projectDir) || continuity.stateManifest || null;
  const stateManifestVerification = options.stateManifestVerification || verifyStateManifest(projectDir, stateManifest);
  const takeoverPacket = continuity.takeoverPacket || continuity.takeoverDrill?.nextAgentBrief || readTakeoverPacket(projectDir) || null;
  const memoryGraph = continuity.memoryGraph || readMemoryGraph(projectDir) || null;
  const processTrace = continuity.processTrace || readProcessTrace(projectDir) || null;
  const developmentTrail = continuity.developmentTrail || readDevelopmentTrail(projectDir) || null;
  const architectureMap = continuity.architectureMap || readArchitectureMap(projectDir) || null;
  const codeGraph = continuity.codeGraph || continuity.architectureTrace?.codeGraph || continuity.architectureMap?.codeGraph || architectureMap?.codeGraph || null;
  const baseBundle = {
    schemaVersion: "project-agent.context-bundle.v1",
    generatedAt: nowIso(),
    projectDir,
    purpose: "Budgeted, agent-neutral takeover index. Start with takeover-summary.json; read full source files only on demand.",
    readOrder: [
      ".project-agent/takeover-summary.json",
      ".project-agent/context-starter-prompt.md",
      ".project-agent/takeover-packet.json",
      ".project-agent/process-trace.json#current",
      ".project-agent/architecture-map.json#recentChanges",
      ".project-agent/agent-context-bundle.json#quickStart",
      ".project-agent/continuity-contract.json",
      ".project-agent/agent-runbook.json",
      ".project-agent/state-manifest.json",
      ".project-agent/agent-context-bundle.json",
      ".project-agent/continuity.json#current"
    ],
    quickStart: {
      activeGoal: continuity.activeGoal || null,
      currentCursor: continuity.processCursor || continuity.processTrace?.current || takeoverPacket?.cursor || null,
      previousCursor: continuity.previousEvent || continuity.processTrace?.previous || null,
      nextExpected: continuity.nextEvent || continuity.processTrace?.next || null,
      workstream: continuity.workstreams?.active || continuity.processTrace?.workstream || continuity.processCursor?.workstream || null,
      nextCommand: takeoverPacket?.nextCommand || continuity.agentRunbook?.nextCommand || continuity.continuityAudit?.nextCommand || null,
      interruptedWork: continuity.interruptedWork || continuity.continuityContract?.agentState?.interruptedWork || takeoverPacket?.interruptedWork || { count: 0, items: [] }
    },
    governance: {
      spec: continuity.governanceSpec || readGovernanceSpec(projectDir) || null,
      contract: continuity.continuityContract || readContinuityContract(projectDir) || null,
      runbook: continuity.agentRunbook || readAgentRunbook(projectDir) || null,
      takeoverReadiness: continuity.takeoverReadiness || null,
      continuityAudit: continuity.continuityAudit || readContinuityAudit(projectDir) || null
    },
    memory: budgetedMemorySection(memoryGraph, continuity.graphTrace || null),
    process: budgetedProcessSection({
      trace: processTrace,
      recentEvents: continuity.recentEvents || [],
      workstreams: continuity.workstreams || null,
      developmentTrail,
      agentLeases: continuity.agentLeases || []
    }),
    architecture: budgetedArchitectureSection({
      map: architectureMap,
      trace: continuity.architectureTrace || null,
      codeGraph,
      impact: continuity.architectureImpact || null,
      changedFiles: continuity.changedFiles || []
    }),
    validation: {
      stateManifest,
      stateManifestVerification,
      freshnessGate: continuity.freshnessGate || continuity.continuityContract?.freshnessGate || null,
      phaseLedger: continuity.phaseLedger || continuity.continuityContract?.phaseLedger || null,
      checkpointLedger: continuity.checkpointLedger || continuity.continuityContract?.checkpointLedger || null,
      decisionLedger: continuity.decisionLedger || continuity.continuityContract?.decisionLedger || null,
      temporalProvenance: continuity.temporalProvenance || continuity.continuityContract?.temporalProvenance || null,
      stateBoundary: continuity.stateBoundary || continuity.continuityContract?.stateBoundary || null,
      runtimeEval: continuity.runtimeEval || continuity.continuityContract?.runtimeEval || null,
      hookIngressAudit: continuity.hookIngressAudit || continuity.continuityContract?.hookIngressAudit || null,
      objectiveCoverage: continuity.objectiveCoverage || null,
      takeoverAcceptanceAudit: continuity.takeoverAcceptanceAudit || readTakeoverAcceptanceAudit(projectDir) || null,
      sourceFiles: stateManifest?.files?.map((file) => ({
        path: file.path,
        sha256: file.sha256 || null,
        schemaVersion: file.schemaVersion || null,
        bytes: file.bytes || 0,
        mtimeMs: file.mtimeMs || null,
        volatile: Boolean(file.volatile),
        exists: file.exists !== false
      })) || []
    },
    handoff: budgetedHandoffSection({
      lifecycle: continuity.handoffLifecycle || continuity.continuityContract?.handoffLifecycle || null,
      takeoverPacket,
      startProtocol: continuity.startProtocol || null,
      nextAgentInstructions: continuity.nextAgentInstructions || []
    })
  };
  const baseValidation = {
    ...baseBundle.validation,
    preEditRisk: continuity.preEditRisk || null
  };
  const provenanceBaseBundle = {
    ...baseBundle,
    validation: baseValidation
  };
  const provenanceLedger = buildProvenanceLedger(provenanceBaseBundle);
  const attentionPack = buildAttentionPack({ ...baseBundle, validation: { ...baseValidation, provenanceLedger } });
  const bundle = {
    ...baseBundle,
    validation: {
      ...baseValidation,
      provenanceLedger,
      attentionPack,
      disclosureGate: buildDisclosureGate({ ...baseBundle, validation: { ...baseValidation, provenanceLedger, attentionPack } })
    }
  };
  return { ...bundle, contentHash: bundleContentHash(bundle) };
}

export function writeAgentContextBundle(projectDir, bundle = buildAgentContextBundle(projectDir)) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  const bundleWithProvenance = {
    ...bundle,
    validation: {
      ...(bundle.validation || {}),
      provenanceLedger: buildProvenanceLedger(bundle)
    }
  };
  const bundleWithAttention = {
    ...bundleWithProvenance,
    validation: {
      ...(bundleWithProvenance.validation || {}),
      attentionPack: buildAttentionPack(bundleWithProvenance)
    }
  };
  const refreshedBundle = {
    ...bundleWithAttention,
    validation: {
      ...(bundleWithAttention.validation || {}),
      disclosureGate: buildDisclosureGate(bundleWithAttention)
    }
  };
  const withVerification = {
    ...refreshedBundle,
    validation: {
      ...(refreshedBundle.validation || {}),
      agentContextBundleVerification: verifyAgentContextBundle(projectDir, refreshedBundle)
    }
  };
  const finalBundle = { ...withVerification, contentHash: bundleContentHash(withVerification) };
  finalBundle.validation.agentContextBundleVerification = verifyAgentContextBundle(projectDir, finalBundle);
  writeFileSync(agentContextBundlePath(projectDir), `${JSON.stringify(finalBundle, null, 2)}\n`, "utf8");
  return finalBundle;
}

export function verifyAgentContextBundle(projectDir, bundle = readAgentContextBundle(projectDir)) {
  if (!bundle || bundle.schemaVersion !== "project-agent.context-bundle.v1") {
    return {
      schemaVersion: "project-agent.context-bundle-verification.v1",
      checkedAt: nowIso(),
      status: "bad",
      canResume: false,
      summary: "No readable agent context bundle is available.",
      checks: [],
      blockers: ["bundle_schema"],
      warnings: []
    };
  }

  const expectedHash = bundleContentHash(bundle);
  const sourceFiles = Array.isArray(bundle.validation?.sourceFiles) ? bundle.validation.sourceFiles : [];
  const latestTakeoverAcceptanceAudit = readTakeoverAcceptanceAudit(projectDir) || bundle.validation?.takeoverAcceptanceAudit || null;
  const recordedDisclosureGate = bundle.validation?.disclosureGate || null;
  const currentDisclosureGate = buildDisclosureGate(bundle);
  const preEditRisk = bundle.validation?.preEditRisk || null;
  const preEditRiskStatus = !preEditRisk || preEditRisk.schemaVersion !== "project-agent.pre-edit-risk.v1"
    ? "warn"
    : ["blocked", "high"].includes(preEditRisk.status)
      ? "warn"
      : "ok";
  const freshnessGate = bundle.validation?.freshnessGate || null;
  const freshnessGateStatus = !freshnessGate || freshnessGate.schemaVersion !== "project-agent.freshness-gate.v1"
    ? "warn"
    : ["expired", "stale"].includes(freshnessGate.status)
      ? "warn"
      : "ok";
  const runtimeEval = bundle.validation?.runtimeEval || null;
  const runtimeEvalStatus = !runtimeEval || runtimeEval.schemaVersion !== "project-agent.runtime-eval.v1"
    ? "warn"
    : runtimeEval.status === "fail"
      ? "warn"
      : "ok";
  const phaseLedger = bundle.validation?.phaseLedger || null;
  const phaseLedgerStatus = !phaseLedger || phaseLedger.schemaVersion !== "project-agent.phase-ledger.v1"
    ? "warn"
    : phaseLedger.status === "missing" || phaseLedger.blockers?.length
      ? "warn"
      : "ok";
  const checkpointLedger = bundle.validation?.checkpointLedger || null;
  const checkpointLedgerStatus = !checkpointLedger || checkpointLedger.schemaVersion !== "project-agent.checkpoint-ledger.v1"
    ? "warn"
    : checkpointLedger.status === "blocked" || checkpointLedger.blockers?.length
      ? "warn"
      : "ok";
  const decisionLedger = bundle.validation?.decisionLedger || null;
  const decisionLedgerStatus = !decisionLedger || decisionLedger.schemaVersion !== "project-agent.decision-ledger.v1"
    ? "warn"
    : decisionLedger.status === "blocked" || decisionLedger.blockers?.length
      ? "warn"
      : "ok";
  const temporalProvenance = bundle.validation?.temporalProvenance || null;
  const temporalProvenanceStatus = !temporalProvenance || temporalProvenance.schemaVersion !== "project-agent.temporal-provenance-audit.v1"
    ? "warn"
    : temporalProvenance.status === "blocked" || temporalProvenance.blockers?.length
      ? "warn"
      : "ok";
  const stateBoundary = bundle.validation?.stateBoundary || null;
  const stateBoundaryStatus = !stateBoundary || stateBoundary.schemaVersion !== "project-agent.state-boundary-audit.v1"
    ? "warn"
    : stateBoundary.status === "blocked"
      ? "bad"
      : stateBoundary.status === "watch"
        ? "warn"
        : "ok";
  const codeGraph = bundle.architecture?.codeGraph || bundle.architecture?.map?.codeGraph || bundle.architecture?.trace?.codeGraph || null;
  const codeGraphStatus = !codeGraph || !["project-agent.code-graph.v1", "project-agent.code-graph-summary.v1"].includes(codeGraph.schemaVersion)
    ? "warn"
    : codeGraph.nodeCount
      ? "ok"
      : "warn";
  const hookIngressAudit = bundle.validation?.hookIngressAudit || null;
  const hookIngressStatus = !hookIngressAudit || hookIngressAudit.schemaVersion !== "project-agent.hook-ingress-audit.v1"
    ? "warn"
    : hookIngressAudit.status === "blocked"
      ? "warn"
      : "ok";
  const provenanceLedger = bundle.validation?.provenanceLedger || null;
  const provenanceLedgerStatus = !provenanceLedger || provenanceLedger.schemaVersion !== "project-agent.provenance-ledger.v1"
    ? "warn"
    : provenanceLedger.status === "blocked"
      ? "warn"
      : "ok";
  const attentionPack = bundle.validation?.attentionPack || null;
  const attentionPackStatus = !attentionPack || attentionPack.schemaVersion !== "project-agent.attention-pack.v1"
    ? "warn"
    : ["blocked", "over_budget"].includes(attentionPack.status)
      ? "warn"
      : "ok";
  const handoffLifecycle = bundle.handoff?.lifecycle || null;
  const handoffLifecycleStatus = !handoffLifecycle || handoffLifecycle.schemaVersion !== "project-agent.handoff-lifecycle.v1"
    ? "warn"
    : handoffLifecycle.status === "expired"
      ? "warn"
      : "ok";
  const disclosureGateStatus = currentDisclosureGate.status === "bad"
    ? "bad"
    : !recordedDisclosureGate || recordedDisclosureGate.payloadHash !== currentDisclosureGate.payloadHash || currentDisclosureGate.status === "warn"
      ? "warn"
      : "ok";
  const promptPacking = currentDisclosureGate.packing || recordedDisclosureGate?.packing || null;
  const promptPackingStatus = !promptPacking || promptPacking.schemaVersion !== "project-agent.prompt-packing-gate.v1"
    ? "bad"
    : promptPacking.status === "warn"
      ? "warn"
      : "ok";
  const missingSourceFiles = sourceFiles
    .filter((file) => file.exists !== false)
    .filter((file) => !existsSync(path.isAbsolute(file.path) ? file.path : path.join(projectDir, file.path)))
    .map((file) => file.path);
  const memoryGraph = bundle.memory?.graph || null;
  const memoryNodeCount = memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0;
  const memoryEdgeCount = memoryGraph?.edgeCount || memoryGraph?.edges?.length || 0;
  const processTrace = bundle.process?.trace || null;
  const processHasCurrent = Boolean(processTrace?.current || bundle.quickStart?.currentCursor);
  const processHasNext = Boolean(processTrace?.next || bundle.quickStart?.nextExpected);
  const developmentTrail = bundle.process?.developmentTrail || null;
  const architectureMap = bundle.architecture?.map || null;
  const architectureFileCount = architectureMap?.totals?.files || architectureMap?.files?.length || 0;
  const architectureChangedCount = bundle.architecture?.changedFiles?.length || architectureMap?.recentChanges?.length || architectureMap?.totals?.changed || 0;
  const checks = [
    bundleCheck(
      "bundle_hash",
      "Bundle Hash",
      bundle.contentHash === expectedHash ? "ok" : "bad",
      bundle.contentHash === expectedHash
        ? `contentHash matches ${String(bundle.contentHash).slice(0, 12)}.`
        : `contentHash mismatch: recorded ${bundle.contentHash || "none"}, current ${expectedHash}.`,
      [".project-agent/agent-context-bundle.json"]
    ),
    bundleCheck(
      "read_order",
      "Read Order",
      bundle.readOrder?.[0] === ".project-agent/takeover-summary.json" && bundle.readOrder?.some((ref) => String(ref).startsWith(".project-agent/agent-context-bundle.json")) ? "ok" : "bad",
      bundle.readOrder?.length ? `${bundle.readOrder.length} read-order item(s); first ${bundle.readOrder[0]}.` : "No read order in bundle.",
      bundle.readOrder || []
    ),
    bundleCheck(
      "quick_start",
      "Quick Start",
      bundle.quickStart?.activeGoal && bundle.quickStart?.currentCursor && bundle.quickStart?.nextCommand ? "ok" : "bad",
      bundle.quickStart?.currentCursor
        ? `${bundle.quickStart.currentCursor.phase || "event"}/${bundle.quickStart.currentCursor.status || "unknown"}: ${bundle.quickStart.currentCursor.title || "cursor"}; next command ${bundle.quickStart.nextCommand ? "present" : "missing"}.`
        : "No current cursor in quickStart.",
      [bundle.quickStart?.activeGoal?.id, bundle.quickStart?.currentCursor?.id]
    ),
    bundleCheck(
      "memory_graph",
      "Memory Graph",
      ["project-agent.memory-graph.v1", "project-agent.memory-graph-summary.v1"].includes(memoryGraph?.schemaVersion) && memoryNodeCount && (memoryEdgeCount || bundle.memory?.budget?.sourceRef) ? "ok" : "bad",
      `${memoryNodeCount} node(s), ${memoryEdgeCount} edge(s), ${bundle.memory?.budget?.status || "no"} budget.`,
      [".project-agent/memory-graph.json", bundle.memory?.budget?.contentHash]
    ),
    bundleCheck(
      "process_trace",
      "Process Trace",
      ["project-agent.process-trace.v1", "project-agent.process-trace-summary.v1"].includes(processTrace?.schemaVersion) && processHasCurrent && processHasNext ? "ok" : "bad",
      processTrace?.current ? `${processTrace.current.phase}/${processTrace.current.status}: ${processTrace.current.title}` : "No process current cursor.",
      [".project-agent/process-trace.json"]
    ),
    bundleCheck(
      "development_trail",
      "Development Trail",
      ["project-agent.development-trail.v1", "project-agent.development-trail-summary.v1"].includes(developmentTrail?.schemaVersion) && (developmentTrail.current || developmentTrail.steps?.length || developmentTrail.inspectOrder?.length) ? (developmentTrail.status === "linked" || developmentTrail.schemaVersion.endsWith("summary.v1") ? "ok" : "warn") : "bad",
      developmentTrail?.summary || "No process-to-file development trail is available.",
      [".project-agent/development-trail.json", ".project-agent/process-trace.json", ".project-agent/architecture-map.json"]
    ),
    bundleCheck(
      "architecture_map",
      "Architecture Map",
      ["project-agent.architecture-map.v1", "project-agent.architecture-map-summary.v1"].includes(architectureMap?.schemaVersion) && architectureFileCount ? "ok" : "bad",
      `${architectureFileCount} file(s), ${architectureChangedCount} changed file(s), ${bundle.architecture?.budget?.status || "no"} budget.`,
      [".project-agent/architecture-map.json", bundle.architecture?.budget?.contentHash]
    ),
    bundleCheck(
      "code_graph",
      "Code Graph",
      codeGraphStatus,
      codeGraph?.summary || `${codeGraph?.nodeCount || 0} code node(s), ${codeGraph?.edgeCount || 0} dependency edge(s).`,
      [".project-agent/architecture-map.json", ...(codeGraph?.changedImpact || []).flatMap((item) => [item.path, ...(item.dependents || []), ...(item.dependencies || [])])]
    ),
    bundleCheck(
      "governance",
      "Governance",
      bundle.governance?.spec?.schemaVersion === "project-agent.governance-spec.v1" && bundle.governance?.contract?.schemaVersion === "project-agent.continuity-contract.v1" && bundle.governance?.runbook?.schemaVersion === "project-agent.runbook.v1" ? "ok" : "bad",
      "Governance spec, continuity contract, and agent runbook are embedded.",
      [".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", ".project-agent/agent-runbook.json"]
    ),
    bundleCheck(
      "manifest_verification",
      "Manifest Verification",
      bundle.validation?.stateManifestVerification?.ok ? "ok" : "bad",
      bundle.validation?.stateManifestVerification?.summary || "No state manifest verification in bundle.",
      [".project-agent/state-manifest.json"]
    ),
    bundleCheck(
      "disclosure_gate",
      "Disclosure Gate",
      disclosureGateStatus,
      currentDisclosureGate.summary,
      currentDisclosureGate.refs
    ),
    bundleCheck(
      "prompt_packing_gate",
      "Prompt Packing Gate",
      promptPackingStatus,
      promptPacking?.summary || "No prompt packing limits are embedded.",
      promptPacking?.refs || [".project-agent/agent-context-bundle.json", ".project-agent/next-agent-prompt.md"]
    ),
    bundleCheck(
      "pre_edit_risk",
      "Pre-Edit Risk",
      preEditRiskStatus,
      preEditRisk?.summary || "No pre-edit risk summary is embedded.",
      preEditRisk?.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"]
    ),
    bundleCheck(
      "freshness_gate",
      "Freshness Gate",
      freshnessGateStatus,
      freshnessGate?.summary || "No temporal freshness gate is embedded.",
      freshnessGate?.refs || [".project-agent/process-trace.json", ".project-agent/architecture-map.json", ".project-agent/state-manifest.json"]
    ),
    bundleCheck(
      "runtime_eval",
      "Runtime Eval",
      runtimeEvalStatus,
      runtimeEval?.summary || "No runtime trace evaluation is embedded.",
      runtimeEval?.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/development-trail.json"]
    ),
    bundleCheck(
      "phase_ledger",
      "Phase Ledger",
      phaseLedgerStatus,
      phaseLedger?.summary || "No phase ledger is embedded.",
      phaseLedger?.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"]
    ),
    bundleCheck(
      "checkpoint_ledger",
      "Checkpoint Ledger",
      checkpointLedgerStatus,
      checkpointLedger?.summary || "No checkpoint ledger is embedded.",
      checkpointLedger?.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json#checkpointLedger"]
    ),
    bundleCheck(
      "decision_ledger",
      "Decision Ledger",
      decisionLedgerStatus,
      decisionLedger?.summary || "No temporal decision ledger is embedded.",
      decisionLedger?.refs || [".project-agent/state.json", ".project-agent/governance-spec.json", "docs/research/agent-governance-landscape.md"]
    ),
    bundleCheck(
      "temporal_provenance",
      "Temporal Provenance",
      temporalProvenanceStatus,
      temporalProvenance?.summary || "No temporal provenance audit is embedded.",
      temporalProvenance?.refs || [".project-agent/continuity.json#temporalProvenance", ".project-agent/memory-graph.json", ".project-agent/continuity.json#decisionLedger"]
    ),
    bundleCheck(
      "state_boundary",
      "State Boundary",
      stateBoundaryStatus,
      stateBoundary?.summary || "No source/index/disclosure boundary audit is embedded.",
      stateBoundary?.refs || [".project-agent/continuity.json#stateBoundary", ".project-agent/agent-context-bundle.json"]
    ),
    bundleCheck(
      "hook_ingress",
      "Hook Ingress",
      hookIngressStatus,
      hookIngressAudit?.summary || "No sanitized hook ingress audit is embedded.",
      hookIngressAudit?.refs || ["/api/hooks", "/api/events", ".project-agent/runtime.json"]
    ),
    bundleCheck(
      "provenance_ledger",
      "Provenance Ledger",
      provenanceLedgerStatus,
      provenanceLedger?.summary || "No source provenance ledger is embedded.",
      provenanceLedger?.refs || [".project-agent/agent-context-bundle.json", ".project-agent/state-manifest.json"]
    ),
    bundleCheck(
      "attention_pack",
      "Attention Pack",
      attentionPackStatus,
      attentionPack?.summary || "No top-of-mind attention pack is embedded.",
      attentionPack?.refs || [".project-agent/agent-context-bundle.json", ".project-agent/process-trace.json"]
    ),
    bundleCheck(
      "handoff_lifecycle",
      "Handoff Lifecycle",
      handoffLifecycleStatus,
      handoffLifecycle?.summary || "No typed handoff lifecycle is embedded.",
      handoffLifecycle?.refs || [".project-agent/continuity.json", ".project-agent/agent-context-bundle.json"]
    ),
    bundleCheck(
      "objective_coverage",
      "Objective Coverage",
      bundle.validation?.objectiveCoverage?.schemaVersion === "project-agent.objective-coverage.v1" && bundle.validation.objectiveCoverage.requirements?.length >= 4 ? (bundle.validation.objectiveCoverage.status === "blocked" ? "warn" : bundle.validation.objectiveCoverage.status === "watch" ? "warn" : "ok") : "warn",
      bundle.validation?.objectiveCoverage?.summary || "No objective coverage map in bundle.",
      [".project-agent/agent-context-bundle.json", ".project-agent/governance-spec.json"]
    ),
    bundleCheck(
      "takeover_acceptance_audit",
      "Takeover Acceptance Audit",
      latestTakeoverAcceptanceAudit?.schemaVersion === "project-agent.takeover-acceptance-audit.v1" && latestTakeoverAcceptanceAudit.status === "pass" ? "ok" : "warn",
      latestTakeoverAcceptanceAudit?.summary || "No user-objective acceptance audit is available.",
      [".project-agent/takeover-acceptance-audit.json"]
    ),
    bundleCheck(
      "source_files",
      "Source Files",
      missingSourceFiles.length ? "warn" : "ok",
      missingSourceFiles.length ? `${missingSourceFiles.length} source file(s) from the bundle are missing now.` : `${sourceFiles.length} source file(s) declared by the bundle are readable or intentionally absent.`,
      missingSourceFiles.length ? missingSourceFiles.slice(0, 8) : sourceFiles.slice(0, 8).map((file) => file.path)
    )
  ];
  const blockers = checks.filter((check) => check.status === "bad").map((check) => check.id);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.id);
  return {
    schemaVersion: "project-agent.context-bundle-verification.v1",
    checkedAt: nowIso(),
    status: blockers.length ? "bad" : warnings.length ? "warn" : "ok",
    canResume: blockers.length === 0,
    summary: blockers.length
      ? `Bundle takeover blocked by ${blockers.length} failed check(s).`
      : warnings.length
        ? `Bundle takeover can resume with ${warnings.length} warning(s).`
        : "Bundle contains enough portable state for a cold-start agent takeover.",
    contentHash: bundle.contentHash || null,
    expectedContentHash: expectedHash,
    checks,
    blockers,
    warnings
  };
}

export function buildStateManifest(projectDir) {
  const files = MANIFEST_FILES.map((name) => {
    const relPath = `.project-agent/${name}`;
    const file = path.join(stateDir(projectDir), name);
    if (!existsSync(file)) {
      return {
        path: relPath,
        exists: false
      };
    }
    const content = readFileSync(file);
    const stat = statSync(file);
    return {
      path: relPath,
      exists: true,
      volatile: VOLATILE_MANIFEST_PATHS.has(relPath),
      bytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: sha256(content),
      schemaVersion: name.endsWith(".json") ? jsonSchemaVersion(content.toString("utf8")) : null
    };
  });
  const present = files.filter((file) => file.exists);
  const stable = present.filter((file) => !file.volatile);
  return {
    schemaVersion: "project-agent.state-manifest.v1",
    generatedAt: nowIso(),
    fileCount: present.length,
    missing: files.filter((file) => !file.exists).map((file) => file.path),
    aggregateHash: sha256(stable.map((file) => `${file.path}:${file.sha256}`).join("\n")),
    files
  };
}

export function writeStateManifest(projectDir, manifest = buildStateManifest(projectDir)) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(stateManifestPath(projectDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function verifyStateManifest(projectDir, manifest = readStateManifest(projectDir)) {
  if (!manifest?.files?.length || manifest.schemaVersion !== "project-agent.state-manifest.v1") {
    return {
      schemaVersion: "project-agent.state-manifest-verification.v1",
      checkedAt: nowIso(),
      status: "bad",
      ok: false,
      summary: "No readable state manifest is available.",
      aggregateHash: null,
      recordedHash: manifest?.aggregateHash || null,
      files: [],
      missing: [],
      mismatched: [],
      unexpected: []
    };
  }
  const files = manifest.files.map((recorded) => {
    const file = path.join(projectDir, recorded.path);
    if (!existsSync(file)) {
      const expectedMissing = recorded.exists === false || !recorded.sha256;
      return {
        path: recorded.path,
        status: expectedMissing ? "ok_missing" : "missing",
        recordedSha256: recorded.sha256 || null,
        currentSha256: null,
        schemaVersion: recorded.schemaVersion || null
      };
    }
    const content = readFileSync(file);
    const stat = statSync(file);
    const currentSha256 = sha256(content);
    const volatile = recorded.volatile || VOLATILE_MANIFEST_PATHS.has(recorded.path);
    const matches = recorded.sha256 === currentSha256;
    return {
      path: recorded.path,
      status: matches ? "ok" : volatile ? "ok_volatile" : "mismatch",
      volatile,
      recordedSha256: recorded.sha256 || null,
      currentSha256,
      recordedBytes: recorded.bytes || 0,
      currentBytes: stat.size,
      schemaVersion: recorded.schemaVersion || null,
      currentSchemaVersion: recorded.path.endsWith(".json") ? jsonSchemaVersion(content.toString("utf8")) : null
    };
  });
  const present = files.filter((file) => file.currentSha256 && !file.volatile);
  const aggregateHash = sha256(present.map((file) => `${file.path}:${file.currentSha256}`).join("\n"));
  const missing = files.filter((file) => file.status === "missing").map((file) => file.path);
  const mismatched = files.filter((file) => file.status === "mismatch").map((file) => file.path);
  const ok = !missing.length && !mismatched.length && aggregateHash === manifest.aggregateHash;
  return {
    schemaVersion: "project-agent.state-manifest-verification.v1",
    checkedAt: nowIso(),
    status: ok ? "ok" : "bad",
    ok,
    summary: ok ? "State manifest matches current handoff files." : `${missing.length} missing, ${mismatched.length} mismatched.`,
    aggregateHash,
    recordedHash: manifest.aggregateHash || null,
    files,
    missing,
    mismatched,
    unexpected: []
  };
}

function defaultRuntime() {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    events: [],
    agents: [],
    hookIngresses: [],
    handoffSnapshot: null,
    architectureSnapshot: null,
    architectureChanges: []
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function compact(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function redactSecretLikeText(text, findings = []) {
  let output = String(text || "");
  for (const rule of DISCLOSURE_SECRET_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    output = output.replace(pattern, (...args) => {
      const match = args.slice(0, -2);
      if (rule.id === "secret_assignment") {
        const value = String(match[2] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!value || DISCLOSURE_SAFE_VALUES.has(value) || value.startsWith("redacted")) return match[0];
      }
      const sample = redactedSecretSample(rule, match);
      if (findings.length < 12) {
        findings.push({
          rule: rule.id,
          label: rule.label,
          sample
        });
      }
      return sample;
    });
  }
  return output;
}

function sanitizeHookValue(value, findings = [], key = "", depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(key)) {
      findings.push({ rule: "secret_key", label: `secret-like key ${key}`, sample: `${key}=<redacted>` });
      return "<redacted>";
    }
    return redactSecretLikeText(value, findings);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeHookValue(item, findings, key, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    if (depth > 5) return compact(JSON.stringify(value), 500);
    const entries = Object.entries(value).slice(0, 80).map(([entryKey, entryValue]) => [
      entryKey,
      SECRET_KEY_RE.test(entryKey)
        ? sanitizeHookValue(String(entryValue || ""), findings, entryKey, depth + 1)
        : sanitizeHookValue(entryValue, findings, entryKey, depth + 1)
    ]).filter(([, entryValue]) => entryValue !== undefined);
    return Object.fromEntries(entries);
  }
  return compact(value, 500);
}

function hookPayloadItems(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.hooks)) return payload.hooks;
  if (payload.event) return [payload.event];
  if (payload.hook) return [payload.hook];
  return [payload];
}

function normalizeHookType(rawType) {
  const raw = String(rawType || "observation").trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");
  if (HOOK_EVENT_TYPES.has(normalized)) return { type: normalized, rawType: raw, status: "known", warning: null };
  if (HOOK_TYPE_ALIASES[normalized]) return { type: HOOK_TYPE_ALIASES[normalized], rawType: raw, status: "aliased", warning: `type_alias:${normalized}` };
  if (/^x\.[a-z0-9._-]+$/.test(normalized)) return { type: normalized, rawType: raw, status: "extension", warning: null };
  return { type: "observation", rawType: raw, status: "unknown", warning: `unknown_type:${raw}` };
}

function hookTypeDefaults(type) {
  if (type === "tool_start") return { phase: "execute", status: "current", title: "Hook tool running" };
  if (type === "tool_done") return { phase: "execute", status: "done", title: "Hook tool completed" };
  if (type === "tool_error") return { phase: "execute", status: "failed", title: "Hook tool failed" };
  if (type === "command_start") return { phase: "execute", status: "current", title: "Hook command running" };
  if (type === "command_done") return { phase: "execute", status: "done", title: "Hook command completed" };
  if (type === "command_error") return { phase: "execute", status: "failed", title: "Hook command failed" };
  if (type === "file_change") return { phase: "execute", status: "done", title: "Hook file change" };
  if (type === "evidence") return { phase: "evidence", status: "done", title: "Hook evidence" };
  if (type === "audit") return { phase: "audit", status: "done", title: "Hook audit" };
  if (type === "handoff") return { phase: "handoff", status: "current", title: "Hook handoff" };
  if (type === "agent_note") return { phase: "plan", status: "done", title: "Hook agent note" };
  return { phase: "observe", status: "done", title: "Hook observation" };
}

function hookText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hookText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.message === "string") return value.message;
  if (typeof value.summary === "string") return value.summary;
  if (typeof value.input === "string") return value.input;
  if (typeof value.output === "string") return value.output;
  if (typeof value.error === "string") return value.error;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeFileRef(file) {
  if (typeof file === "string") return { path: file };
  if (!file || typeof file !== "object") return null;
  if (!file.path) return null;
  return {
    path: String(file.path),
    status: file.status ? String(file.status) : undefined,
    kind: file.kind ? String(file.kind) : undefined,
    summary: file.summary ? String(file.summary) : undefined,
    additions: Number.isFinite(Number(file.additions)) ? Number(file.additions) : undefined,
    deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : undefined,
    hash: file.hash ? String(file.hash) : undefined
  };
}

function normalizeAgentHeartbeat(agent = {}) {
  const id = compact(agent.agentId || agent.id || "local-agent", 120);
  const lastSeenAt = agent.lastSeenAt || agent.at || nowIso();
  const leaseSeconds = Number.isFinite(Number(agent.leaseSeconds)) ? Math.max(1, Number(agent.leaseSeconds)) : DEFAULT_LEASE_SECONDS;
  return {
    id,
    role: agent.role ? compact(agent.role, 80) : undefined,
    goalId: agent.goalId ? compact(agent.goalId, 120) : undefined,
    status: VALID_AGENT_STATUSES.has(agent.status) ? agent.status : "active",
    note: agent.note ? compact(agent.note, 500) : undefined,
    source: agent.source ? compact(agent.source, 120) : undefined,
    pid: agent.pid ? compact(agent.pid, 80) : undefined,
    host: agent.host ? compact(agent.host, 120) : undefined,
    leaseSeconds,
    startedAt: agent.startedAt || lastSeenAt,
    lastSeenAt
  };
}

function normalizeOptionalRuntimeId(value, max = 160) {
  if (value === undefined || value === null || value === "") return undefined;
  return compact(String(value), max);
}

function normalizeRuntimeCost(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Number.isFinite(Number(value))) return Number(value);
  if (typeof value === "string") return compact(value, 160);
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .flatMap(([key, entry]) => {
          if (entry === undefined || entry === null || entry === "") return [];
          if (Number.isFinite(Number(entry))) return [[compact(key, 80), Number(entry)]];
          return [[compact(key, 80), typeof entry === "object" ? compact(JSON.stringify(entry), 240) : entry]];
        })
    );
  }
  return undefined;
}

function normalizeRuntimeError(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return compact(value, 700);
  if (typeof value === "object") {
    return compact(value.message || value.error || value.detail || JSON.stringify(value), 700);
  }
  return compact(String(value), 700);
}

function normalizeArtifactRef(value) {
  if (!value) return null;
  if (typeof value === "string") return compact(value, 240);
  if (typeof value !== "object") return null;
  return compact(value.ref || value.path || value.url || value.href || value.id || "", 240) || null;
}

export function normalizeRuntimeEvent(event = {}) {
  const phase = VALID_PHASES.has(event.phase) ? event.phase : "observe";
  const status = VALID_STATUSES.has(event.status) ? event.status : "done";
  const files = asArray(event.files).map(normalizeFileRef).filter(Boolean);
  const refs = [...asArray(event.refs), ...files.map((file) => file.path)]
    .filter(Boolean)
    .map((item) => String(item));
  const startedAt = event.startedAt || event.startTime || undefined;
  const endedAt = event.endedAt || event.endTime || undefined;
  const durationMs = Number.isFinite(Number(event.durationMs)) ? Math.max(0, Number(event.durationMs)) : undefined;
  const artifactRefs = [...new Set([
    ...asArray(event.artifactRefs || event.artifacts || event.outputs).map(normalizeArtifactRef),
    ...asArray(event.outputFiles).map(normalizeArtifactRef)
  ].filter(Boolean))].slice(0, 20);
  return {
    id: event.id || `evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
    at: event.at || nowIso(),
    spanId: normalizeOptionalRuntimeId(event.spanId),
    parentId: normalizeOptionalRuntimeId(event.parentId || event.parentEventId || event.parentSpanId),
    parentEventId: normalizeOptionalRuntimeId(event.parentEventId || event.parentId || event.parentSpanId),
    runId: normalizeOptionalRuntimeId(event.runId || event.run || event.sessionId),
    startedAt: startedAt ? compact(startedAt, 80) : undefined,
    endedAt: endedAt ? compact(endedAt, 80) : undefined,
    durationMs,
    phase,
    title: compact(event.title || "Event", 120),
    status,
    detail: compact(event.detail || "", 1000),
    refs: [...new Set(refs)].slice(0, 20),
    artifactRefs,
    files,
    workstream: VALID_WORKSTREAMS.has(event.workstream) ? event.workstream : undefined,
    agentId: event.agentId ? String(event.agentId) : undefined,
    goalId: event.goalId ? String(event.goalId) : undefined,
    tool: event.tool ? String(event.tool) : undefined,
    source: event.source ? String(event.source) : undefined,
    cost: normalizeRuntimeCost(event.cost),
    error: normalizeRuntimeError(event.error),
    data: event.data && typeof event.data === "object" ? event.data : undefined
  };
}

function buildHookRuntimeEvent(rawEvent = {}, index = 0, options = {}) {
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    return {
      accepted: false,
      entry: {
        index,
        status: "rejected",
        blockers: ["invalid_payload"],
        warnings: [],
        summary: "Hook payload item must be an object."
      }
    };
  }
  const findings = [];
  const event = sanitizeHookValue(rawEvent, findings);
  const rawType = event.type || event.eventType || event.event || event.kind || options.type || "observation";
  const hookType = normalizeHookType(rawType);
  const defaults = hookTypeDefaults(hookType.type);
  const warnings = [hookType.warning].filter(Boolean);
  const phase = VALID_PHASES.has(event.phase) ? event.phase : defaults.phase;
  const status = VALID_STATUSES.has(event.status) ? event.status : defaults.status;
  const workstream = VALID_WORKSTREAMS.has(event.workstream) ? event.workstream : undefined;
  if (event.phase && event.phase !== phase) warnings.push(`phase_normalized:${event.phase}`);
  if (event.status && event.status !== status) warnings.push(`status_normalized:${event.status}`);
  if (event.workstream && event.workstream !== workstream) warnings.push(`workstream_normalized:${event.workstream}`);
  if (findings.length) warnings.push("secret_like_content_redacted");
  const detail = hookText(event.detail || event.message || event.summary || event.input || event.output || event.error || event.data || event.payload);
  const files = asArray(event.files || event.changedFiles || event.file)
    .map(normalizeFileRef)
    .filter(Boolean)
    .slice(0, 20);
  const refs = [...asArray(event.refs || event.references || event.ref), ...files.map((file) => file.path)]
    .filter(Boolean)
    .map((item) => String(item))
    .slice(0, 30);
  const source = event.source || options.source || "hook-ingress";
  const tool = event.tool || event.toolName || event.name || (hookType.type.includes("command") ? "command" : undefined);
  const parentId = event.parentId || event.parentEventId || event.parentSpanId;
  const runId = event.runId || event.run || event.sessionId || options.runId;
  const normalized = normalizeRuntimeEvent({
    id: event.id || `hook_${Date.now().toString(36)}_${index}_${sha256(JSON.stringify(event)).slice(0, 8)}`,
    at: event.at || event.timestamp || event.createdAt || nowIso(),
    spanId: event.spanId,
    parentId,
    runId,
    startedAt: event.startedAt || event.startTime,
    endedAt: event.endedAt || event.endTime,
    durationMs: event.durationMs,
    phase,
    status,
    workstream,
    title: event.title || (tool ? `${defaults.title}: ${tool}` : defaults.title),
    detail,
    refs,
    artifactRefs: event.artifactRefs || event.artifacts || event.outputs || event.outputFiles,
    files,
    agentId: event.agentId || event.agent || options.agentId,
    goalId: event.goalId || event.goal || options.goalId,
    tool,
    source,
    cost: event.cost,
    error: event.error,
    data: {
      ...(event.data && typeof event.data === "object" ? event.data : {}),
      ingress: {
        schemaVersion: "project-agent.hook-ingress-event.v1",
        type: hookType.type,
        rawType: hookType.rawType,
        typeStatus: hookType.status,
        parentId: parentId || null,
        runId: runId || null,
        durationMs: Number.isFinite(Number(event.durationMs)) ? Math.max(0, Number(event.durationMs)) : null,
        source,
        acceptedAt: nowIso(),
        redactedFindings: findings.length,
        warnings: [...new Set(warnings)],
        sanitized: findings.length > 0
      }
    }
  });
  return {
    accepted: true,
    event: normalized,
    entry: {
      index,
      status: "accepted",
      eventId: normalized.id,
      type: hookType.type,
      rawType: hookType.rawType,
      typeStatus: hookType.status,
      phase: normalized.phase,
      eventStatus: normalized.status,
      title: normalized.title,
      source,
      redactedFindings: findings,
      warnings: [...new Set(warnings)],
      blockers: []
    }
  };
}

export function buildHookIngress(payload = {}, options = {}) {
  const maxEvents = Number.isFinite(Number(options.maxEvents)) ? Math.max(0, Number(options.maxEvents)) : HOOK_MAX_BATCH_EVENTS;
  const items = hookPayloadItems(payload);
  const entries = [];
  const acceptedEvents = [];
  for (const [index, item] of items.entries()) {
    if (index >= maxEvents) {
      entries.push({
        index,
        status: "rejected",
        blockers: ["batch_limit"],
        warnings: [],
        summary: `Hook batch is capped at ${maxEvents} event(s).`
      });
      continue;
    }
    const result = buildHookRuntimeEvent(item, index, options);
    entries.push(result.entry);
    if (result.accepted) acceptedEvents.push(result.event);
  }
  const rejected = entries.filter((entry) => entry.status === "rejected");
  const warnings = [...new Set(entries.flatMap((entry) => entry.warnings || []))];
  const blockers = [...new Set(rejected.flatMap((entry) => entry.blockers || []))];
  const status = acceptedEvents.length && rejected.length ? "partial" : acceptedEvents.length ? (warnings.length ? "watch" : "accepted") : "rejected";
  const batchLimitRejected = rejected.filter((entry) => entry.blockers?.includes("batch_limit"));
  const saturationRatio = maxEvents ? Number((items.length / maxEvents).toFixed(2)) : items.length ? 1 : 0;
  const pressureStatus = !items.length
    ? "idle"
    : maxEvents === 0 || (!acceptedEvents.length && batchLimitRejected.length)
      ? "saturated"
      : batchLimitRejected.length
        ? "throttled"
        : saturationRatio >= 0.8
          ? "watch"
          : "ok";
  const httpStatus = pressureStatus === "saturated" ? 429 : acceptedEvents.length ? 202 : 400;
  return {
    schemaVersion: "project-agent.hook-ingress.v1",
    receivedAt: nowIso(),
    status,
    accepted: acceptedEvents.length,
    rejected: rejected.length,
    totalItems: items.length,
    maxEvents,
    httpStatus,
    retryAfterMs: pressureStatus === "saturated" || pressureStatus === "throttled" ? 1000 : 0,
    pressure: {
      schemaVersion: "project-agent.hook-backpressure.v1",
      status: pressureStatus,
      batchSize: items.length,
      accepted: acceptedEvents.length,
      rejected: rejected.length,
      maxEvents,
      saturationRatio,
      httpStatus,
      retryAfterMs: pressureStatus === "saturated" || pressureStatus === "throttled" ? 1000 : 0,
      reason: pressureStatus === "saturated"
        ? "hook queue saturated; retry later"
        : pressureStatus === "throttled"
          ? "hook batch exceeded maxEvents; accepted prefix and rejected overflow"
          : "hook ingress is within capacity"
    },
    summary: acceptedEvents.length
      ? `Accepted ${acceptedEvents.length} hook event(s) through sanitized ingress${rejected.length ? `; rejected ${rejected.length}.` : "."}`
      : pressureStatus === "saturated"
        ? `Hook ingress saturated; rejected ${rejected.length || items.length} event(s) with 429.`
        : `Rejected ${rejected.length || items.length} hook event(s).`,
    events: acceptedEvents,
    entries,
    warnings,
    blockers
  };
}

function compactHookIngressAttempt(ingress = {}) {
  return {
    id: `ingress_${Date.now().toString(36)}_${sha256(JSON.stringify({
      at: ingress.receivedAt,
      accepted: ingress.accepted,
      rejected: ingress.rejected,
      totalItems: ingress.totalItems,
      status: ingress.status,
      blockers: ingress.blockers
    })).slice(0, 8)}`,
    at: ingress.receivedAt || nowIso(),
    status: ingress.status || "unknown",
    accepted: ingress.accepted || 0,
    rejected: ingress.rejected || 0,
    totalItems: ingress.totalItems || 0,
    maxEvents: ingress.maxEvents || 0,
    httpStatus: ingress.httpStatus || 0,
    retryAfterMs: ingress.retryAfterMs || 0,
    pressure: ingress.pressure || null,
    warnings: (ingress.warnings || []).slice(0, 8),
    blockers: (ingress.blockers || []).slice(0, 8),
    entries: (ingress.entries || []).slice(0, 8).map((entry) => ({
      index: entry.index,
      status: entry.status,
      type: entry.type,
      typeStatus: entry.typeStatus,
      eventId: entry.eventId,
      blockers: entry.blockers || [],
      warnings: entry.warnings || []
    }))
  };
}

export function readRuntime(projectDir) {
  const file = runtimePath(projectDir);
  if (!existsSync(file)) return defaultRuntime();
  try {
    return { ...defaultRuntime(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return defaultRuntime();
  }
}

export function writeRuntime(projectDir, runtime) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  const next = {
    ...runtime,
    updatedAt: nowIso(),
    events: (runtime.events || []).slice(0, MAX_EVENTS),
    agents: (runtime.agents || []).slice(0, MAX_AGENTS),
    hookIngresses: (runtime.hookIngresses || []).slice(0, MAX_HOOK_INGRESSES),
    architectureChanges: (runtime.architectureChanges || []).slice(0, 80)
  };
  writeFileSync(runtimePath(projectDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function recordEvent(projectDir, event) {
  const runtime = readRuntime(projectDir);
  const normalized = normalizeRuntimeEvent(event);
  runtime.events = [normalized, ...(runtime.events || [])].slice(0, MAX_EVENTS);
  return writeRuntime(projectDir, runtime);
}

export function recordEvents(projectDir, events) {
  const runtime = readRuntime(projectDir);
  const existingIds = new Set((runtime.events || []).map((event) => event.id).filter(Boolean));
  const normalized = asArray(events)
    .map(normalizeRuntimeEvent)
    .filter((event) => {
      if (existingIds.has(event.id)) return false;
      existingIds.add(event.id);
      return true;
    });
  runtime.events = [...normalized, ...(runtime.events || [])].slice(0, MAX_EVENTS);
  return writeRuntime(projectDir, runtime);
}

export function ingestHookEvents(projectDir, payload = {}, options = {}) {
  const ingress = buildHookIngress(payload, options);
  const runtime = readRuntime(projectDir);
  const existingIds = new Set((runtime.events || []).map((event) => event.id).filter(Boolean));
  const normalized = asArray(ingress.events)
    .map(normalizeRuntimeEvent)
    .filter((event) => {
      if (existingIds.has(event.id)) return false;
      existingIds.add(event.id);
      return true;
    });
  runtime.events = [...normalized, ...(runtime.events || [])].slice(0, MAX_EVENTS);
  runtime.hookIngresses = [compactHookIngressAttempt(ingress), ...(runtime.hookIngresses || [])].slice(0, MAX_HOOK_INGRESSES);
  const writtenRuntime = writeRuntime(projectDir, runtime);
  const acceptedIds = new Set((ingress.events || []).map((event) => event.id));
  return {
    ...ingress,
    events: (writtenRuntime.events || []).filter((event) => acceptedIds.has(event.id)),
    total: writtenRuntime.events?.length || 0
  };
}

export function recordAgentHeartbeat(projectDir, agent) {
  const runtime = readRuntime(projectDir);
  const normalized = normalizeAgentHeartbeat(agent);
  const existing = (runtime.agents || []).find((item) => item.id === normalized.id);
  runtime.agents = [
    {
      ...existing,
      ...normalized,
      startedAt: existing?.startedAt || normalized.startedAt
    },
    ...(runtime.agents || []).filter((item) => item.id !== normalized.id)
  ].slice(0, MAX_AGENTS);
  return writeRuntime(projectDir, runtime);
}

export function summarizeAgentLeases(runtime, now = Date.now()) {
  return (runtime?.agents || []).map((agent) => {
    const lastSeenMs = Date.parse(agent.lastSeenAt || "");
    const leaseSeconds = Number.isFinite(Number(agent.leaseSeconds)) ? Number(agent.leaseSeconds) : DEFAULT_LEASE_SECONDS;
    const ageMs = Number.isFinite(lastSeenMs) ? now - lastSeenMs : Infinity;
    const stale = agent.status === "active" && ageMs > leaseSeconds * 1000;
    return {
      ...agent,
      leaseSeconds,
      stale,
      ageSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
      effectiveStatus: stale ? "stale" : agent.status || "active"
    };
  });
}

export function writeContinuity(projectDir, packet) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  const next = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    ...packet
  };
  writeFileSync(continuityPath(projectDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (next.continuityContract) {
    writeFileSync(contractPath(projectDir), `${JSON.stringify(next.continuityContract, null, 2)}\n`, "utf8");
  }
  if (next.agentRunbook) {
    writeFileSync(agentRunbookPath(projectDir), `${JSON.stringify(next.agentRunbook, null, 2)}\n`, "utf8");
  }
  if (next.memoryGraph) {
    writeFileSync(memoryGraphPath(projectDir), `${JSON.stringify(next.memoryGraph, null, 2)}\n`, "utf8");
  }
  if (next.processTrace) {
    writeFileSync(processTracePath(projectDir), `${JSON.stringify(next.processTrace, null, 2)}\n`, "utf8");
  }
  if (next.developmentTrail) {
    writeFileSync(developmentTrailPath(projectDir), `${JSON.stringify(next.developmentTrail, null, 2)}\n`, "utf8");
  }
  if (next.architectureMap) {
    writeFileSync(architectureMapPath(projectDir), `${JSON.stringify(next.architectureMap, null, 2)}\n`, "utf8");
  }
  const takeoverPacket = next.takeoverPacket || next.takeoverDrill?.nextAgentBrief;
  if (takeoverPacket) {
    writeFileSync(takeoverPacketPath(projectDir), `${JSON.stringify(takeoverPacket, null, 2)}\n`, "utf8");
  }
  if (next.continuityAudit) {
    writeFileSync(continuityAuditPath(projectDir), `${JSON.stringify(next.continuityAudit, null, 2)}\n`, "utf8");
  }
  if (next.takeoverAcceptanceAudit) {
    writeFileSync(takeoverAcceptanceAuditPath(projectDir), `${JSON.stringify(next.takeoverAcceptanceAudit, null, 2)}\n`, "utf8");
  }
  if (next.governanceSpec) {
    writeFileSync(governanceSpecPath(projectDir), `${JSON.stringify(next.governanceSpec, null, 2)}\n`, "utf8");
  }
  next.stateManifest = writeStateManifest(projectDir);
  next.agentContextBundle = writeAgentContextBundle(projectDir, buildAgentContextBundle(projectDir, next, {
    stateManifest: next.stateManifest,
    stateManifestVerification: verifyStateManifest(projectDir, next.stateManifest)
  }));
  next.takeoverSummary = writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, next, {
    bundle: next.agentContextBundle,
    verification: verifyAgentContextBundle(projectDir, next.agentContextBundle)
  }));
  return next;
}

export function readContinuity(projectDir) {
  const file = continuityPath(projectDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readContinuityContract(projectDir) {
  const file = contractPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.continuityContract || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.continuityContract || null;
  }
}

export function readAgentRunbook(projectDir) {
  const file = agentRunbookPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.agentRunbook || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.agentRunbook || null;
  }
}

export function readMemoryGraph(projectDir) {
  const file = memoryGraphPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.memoryGraph || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.memoryGraph || null;
  }
}

export function readProcessTrace(projectDir) {
  const file = processTracePath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.processTrace || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.processTrace || null;
  }
}

export function readDevelopmentTrail(projectDir) {
  const file = developmentTrailPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.developmentTrail || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.developmentTrail || null;
  }
}

export function readArchitectureMap(projectDir) {
  const file = architectureMapPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.architectureMap || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.architectureMap || null;
  }
}

export function readTakeoverPacket(projectDir) {
  const file = takeoverPacketPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.takeoverPacket || readContinuity(projectDir)?.takeoverDrill?.nextAgentBrief || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.takeoverPacket || readContinuity(projectDir)?.takeoverDrill?.nextAgentBrief || null;
  }
}

export function readContinuityAudit(projectDir) {
  const file = continuityAuditPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.continuityAudit || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.continuityAudit || null;
  }
}

export function readTakeoverAcceptanceAudit(projectDir) {
  const file = takeoverAcceptanceAuditPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.takeoverAcceptanceAudit || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.takeoverAcceptanceAudit || null;
  }
}

export function readGovernanceSpec(projectDir) {
  const file = governanceSpecPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.governanceSpec || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.governanceSpec || null;
  }
}

export function readStateManifest(projectDir) {
  const file = stateManifestPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.stateManifest || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.stateManifest || null;
  }
}

export function readAgentContextBundle(projectDir) {
  const file = agentContextBundlePath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.agentContextBundle || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.agentContextBundle || null;
  }
}

export function readTakeoverSummary(projectDir) {
  const file = takeoverSummaryPath(projectDir);
  if (!existsSync(file)) return readContinuity(projectDir)?.takeoverSummary || null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return readContinuity(projectDir)?.takeoverSummary || null;
  }
}
