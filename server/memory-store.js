import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const MEMORY_TYPES = ["episode", "fact", "decision", "procedure", "evidence", "risk"];
const CONSOLIDATION_MODES = ["dryRun", "manual", "goal", "session", "project"];
const MEMORY_FILES = {
  episode: "episodes.jsonl",
  fact: "facts.jsonl",
  decision: "decisions.jsonl",
  procedure: "procedures.jsonl",
  evidence: "evidence.jsonl",
  risk: "risks.jsonl"
};
const CANONICAL_FILES = [
  "index.md",
  "episodes.jsonl",
  "facts.jsonl",
  "decisions.jsonl",
  "procedures.jsonl",
  "evidence.jsonl",
  "risks.jsonl",
  "audit.jsonl",
  "retention.json"
];
const MEMORY_SEARCH_INDEX_REF = ".project-agent/indexes/memory-bm25.json";
const MEMORY_ENTITY_INDEX_REF = ".project-agent/indexes/memory-entities.json";
const MEMORY_VECTOR_INDEX_REF = ".project-agent/indexes/memory-vectors.json";
const MEMORY_GAP_BENCHMARK_REF = "docs/research/memory-gap-deep-benchmark.md";
const DOGFOOD_SEED_CONCEPT = "dogfood-seed";
const LIFECYCLE_REFRESH_TARGETS = [
  ".project-agent/memory/index.md",
  MEMORY_SEARCH_INDEX_REF,
  MEMORY_ENTITY_INDEX_REF,
  MEMORY_VECTOR_INDEX_REF,
  ".project-agent/takeover-summary.json",
  ".project-agent/takeover-packet.json",
  ".project-agent/process-trace.json",
  ".project-agent/architecture-map.json",
  ".project-agent/memory-graph.json",
  ".project-agent/agent-context-bundle.json",
  ".project-agent/state-manifest.json"
];
const BM25_PARAMS = { k1: 1.2, b: 0.75 };
const VECTOR_PARAMS = {
  dimensions: 192,
  maxFeatures: 1200,
  minSimilarity: 0.08,
  embeddingProvider: "none",
  featureModel: "lexical-hash-v1"
};
const ENTITY_TERM_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "after",
  "before",
  "over",
  "under",
  "should",
  "would",
  "could",
  "project",
  "agent",
  "memory",
  "record",
  "records",
  "runtime",
  "event",
  "events",
  "canonical"
]);
const DERIVED_STATE_FILES = new Set([
  "agent-context-bundle.json",
  "architecture-map.json",
  "codex-takeover-smoke.json",
  "continuity-audit.json",
  "continuity-detail.json",
  "continuity.json",
  "context-starter-prompt.md",
  "context-takeover-drill.json",
  "development-trail.json",
  "memory-graph.json",
  "next-agent-prompt.md",
  "process-trace.json",
  "recovery.md",
  "resume.md",
  "state-manifest.json",
  "takeover-acceptance-audit.json",
  "takeover-packet.json",
  "takeover-summary.json"
]);
const SOURCE_STATE_FILES = new Set(["state.json", "governance-spec.json", "agent-runbook.json", "continuity-contract.json"]);
const VOLATILE_STATE_FILES = new Set(["runtime.json"]);
const SECRET_RULES = [
  { id: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { id: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "jwt", pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  {
    id: "secret_assignment",
    pattern: /\b(password|passwd|pwd|api[_-]?key|secret|token|auth[_-]?token|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?([^"'\s,;}{\]]{8,})/gi
  }
];
const SAFE_SECRET_VALUES = new Set(["redacted", "placeholder", "example", "change_me", "changeme", "undefined", "null", "none"]);

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function stateDir(projectDir) {
  return path.join(projectDir, ".project-agent");
}

function memoryDir(projectDir) {
  return path.join(stateDir(projectDir), "memory");
}

function indexesDir(projectDir) {
  return path.join(stateDir(projectDir), "indexes");
}

function memorySearchIndexFile(projectDir) {
  return path.join(indexesDir(projectDir), "memory-bm25.json");
}

function memoryEntityIndexFile(projectDir) {
  return path.join(indexesDir(projectDir), "memory-entities.json");
}

function memoryVectorIndexFile(projectDir) {
  return path.join(indexesDir(projectDir), "memory-vectors.json");
}

function projectRelative(projectDir, absPath) {
  return path.relative(projectDir, absPath).split(path.sep).join("/");
}

function memoryFile(projectDir, type) {
  return path.join(memoryDir(projectDir), MEMORY_FILES[type]);
}

function normalizeType(type) {
  const clean = String(type || "").toLowerCase().replace(/s$/, "");
  if (clean === "event") return "episode";
  if (clean === "finding") return "fact";
  if (MEMORY_TYPES.includes(clean)) return clean;
  const error = new Error(`Unsupported memory type: ${type}`);
  error.status = 400;
  throw error;
}

function tokenize(query) {
  return [...new Set(String(query || "").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [])]
    .filter((term) => term.length > 1)
    .slice(0, 24);
}

function tokenizeForIndex(value) {
  return (String(value || "").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [])
    .filter((term) => term.length > 1)
    .slice(0, 1200);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix = "mem") {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function defaultRetentionPolicy() {
  return {
    schemaVersion: "project-agent.memory-retention.v1",
    updatedAt: nowIso(),
    limits: {
      maxRuntimeEvents: 120,
      maxTerminalOutputBytes: 20000,
      allowRawArchitectureText: false,
      generatedBundleMaxBytes: 180000
    },
    ttlDaysByType: {
      episode: 90,
      evidence: 180,
      risk: 180,
      fact: null,
      decision: null,
      procedure: null
    },
    staleIndexPolicy: "rebuild_from_canonical_files"
  };
}

function defaultIndexMarkdown(projectName) {
  return [
    "# Project Memory Index",
    "",
    `Project: ${projectName || "unknown"}`,
    "",
    "Canonical memory lives in this folder. JSONL files are source of truth; generated handoff files and indexes are rebuildable.",
    "",
    "- `episodes.jsonl`: run/session history",
    "- `facts.jsonl`: durable project facts",
    "- `decisions.jsonl`: decisions and rationale",
    "- `procedures.jsonl`: repeatable workflows and fixes",
    "- `evidence.jsonl`: tests, commands, screenshots, reports",
    "- `risks.jsonl`: known hazards, blockers, stale assumptions",
    "- `audit.jsonl`: append-only memory lifecycle log",
    "- `retention.json`: inspectable retention policy",
    ""
  ].join("\n");
}

function scanSecretLikeText(text) {
  const findings = [];
  for (const rule of SECRET_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match;
    while ((match = pattern.exec(text)) && findings.length < 12) {
      if (rule.id === "secret_assignment") {
        const value = String(match[2] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!value || SAFE_SECRET_VALUES.has(value) || value.startsWith("redacted")) continue;
      }
      findings.push({ rule: rule.id });
    }
    if (findings.length >= 12) break;
  }
  return findings;
}

function redactSecretLikeText(text) {
  let redacted = String(text || "");
  const findings = [];
  for (const rule of SECRET_RULES) {
    redacted = redacted.replace(rule.pattern, (...args) => {
      const match = args[0];
      if (rule.id === "secret_assignment") {
        const key = args[1];
        const value = String(args[2] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!value || SAFE_SECRET_VALUES.has(value) || value.startsWith("redacted")) return match;
        findings.push({ rule: rule.id });
        return `${key}=<redacted>`;
      }
      findings.push({ rule: rule.id });
      return `<redacted:${rule.id}>`;
    });
  }
  return { text: redacted, findings };
}

function readJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonlFile(filePath, type = null) {
  if (!existsSync(filePath)) return { records: [], errors: [] };
  const raw = readFileSync(filePath, "utf8");
  const records = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (type) {
        const validation = validateMemoryRecord(record, { expectedType: type, strict: false });
        if (!validation.ok) errors.push({ line: index + 1, errors: validation.errors, ref: `${projectRefForFile(filePath)}:${index + 1}` });
      }
      records.push(record);
    } catch (error) {
      errors.push({ line: index + 1, errors: [error.message || String(error)], ref: `${projectRefForFile(filePath)}:${index + 1}` });
    }
  });
  return { records, errors };
}

function projectRefForFile(filePath) {
  const marker = `${path.sep}.project-agent${path.sep}`;
  const index = filePath.indexOf(marker);
  if (index === -1) return filePath;
  return `.project-agent/${filePath.slice(index + marker.length).split(path.sep).join("/")}`;
}

function writeJsonlFile(filePath, records) {
  atomicWrite(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`);
}

function appendJsonl(filePath, record) {
  const existing = readJsonlFile(filePath).records;
  writeJsonlFile(filePath, [...existing, record]);
}

function appendAudit(projectDir, action, payload = {}) {
  const audit = {
    id: stableId("aud"),
    schemaVersion: "project-agent.memory-audit.v1",
    action,
    createdAt: nowIso(),
    ...payload
  };
  appendJsonl(path.join(memoryDir(projectDir), "audit.jsonl"), audit);
  return audit;
}

function validateMemoryRecord(record, options = {}) {
  const errors = [];
  let type = "";
  try {
    type = normalizeType(record?.type || options.expectedType || "");
  } catch {
    errors.push("type is invalid");
  }
  if (!record || typeof record !== "object") errors.push("record must be an object");
  if (!record?.id || typeof record.id !== "string") errors.push("id is required");
  if (!MEMORY_TYPES.includes(type)) errors.push("type is invalid");
  if (!record?.title || typeof record.title !== "string") errors.push("title is required");
  if (!record?.content || typeof record.content !== "string") errors.push("content is required");
  if (!Array.isArray(record?.sourceRefs) || !record.sourceRefs.length) errors.push("sourceRefs must include at least one ref");
  if (record?.confidence !== undefined && (Number(record.confidence) < 0 || Number(record.confidence) > 1)) errors.push("confidence must be between 0 and 1");
  if (record?.importance !== undefined && (Number(record.importance) < 0 || Number(record.importance) > 10)) errors.push("importance must be between 0 and 10");
  if (options.expectedType && type !== options.expectedType) errors.push(`type must match ${options.expectedType}`);
  return { ok: !errors.length, errors };
}

function normalizeRefs(refs = []) {
  return [...new Set((refs || []).map((ref) => String(ref || "").trim().replace(/^\.\//, "")).filter(Boolean))]
    .map((ref) => (ref.startsWith(".project-agent/") || ref.startsWith("/") ? ref : ref));
}

function canonicalRef(record) {
  const type = normalizeType(record.type);
  return `.project-agent/memory/${MEMORY_FILES[type]}#${record.id}`;
}

function buildIndex(projectDir) {
  const records = readAllMemory(projectDir).records;
  const counts = Object.fromEntries(MEMORY_TYPES.map((type) => [type, records.filter((record) => normalizeType(record.type) === type).length]));
  const lines = [
    "# Project Memory Index",
    "",
    `Updated: ${nowIso()}`,
    "",
    "## Counts",
    "",
    ...MEMORY_TYPES.map((type) => `- ${type}: ${counts[type] || 0}`),
    "",
    "## Latest",
    "",
    ...records
      .filter((record) => record.isLatest !== false)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
      .slice(0, 24)
      .map((record) => `- ${record.type}: ${record.title} (${canonicalRef(record)})`)
  ];
  atomicWrite(path.join(memoryDir(projectDir), "index.md"), `${lines.join("\n")}\n`);
  return { counts, records: records.length };
}

function refreshMemoryDerivedState(projectDir, input = {}) {
  const index = buildIndex(projectDir);
  const bm25 = rebuildMemorySearchIndex(projectDir, { audit: false });
  const entity = rebuildMemoryEntityIndex(projectDir, { audit: false });
  const vector = rebuildMemoryVectorIndex(projectDir, { audit: false });
  return {
    required: input.required !== false,
    reason: input.reason || "canonical_memory_mutation",
    memoryIndex: index,
    optionalIndexes: {
      bm25: bm25.index || bm25,
      entity: entity.index || entity,
      vector: vector.index || vector
    },
    targets: LIFECYCLE_REFRESH_TARGETS
  };
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeIdSelector(input = {}) {
  return [
    ...normalizeArray(input.id),
    ...normalizeArray(input.ids),
    ...normalizeArray(input.ref),
    ...normalizeArray(input.refs)
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => (item.includes("#") ? item.split("#").pop() : item));
}

function requireSingleMemorySelector(input = {}) {
  const ids = normalizeIdSelector(input);
  if (!ids.length) {
    const error = new Error("Memory id or canonical ref is required.");
    error.status = 400;
    throw error;
  }
  if (ids.length > 1) {
    const error = new Error("Exactly one memory id or canonical ref is required.");
    error.status = 400;
    throw error;
  }
  return ids[0];
}

function findMemoryRecordBySelector(projectDir, input = {}) {
  const id = requireSingleMemorySelector(input);
  const all = readAllMemory(projectDir);
  const record = all.records.find((item) => item.id === id);
  if (!record) {
    const error = new Error(`Memory record not found: ${id}`);
    error.status = 404;
    throw error;
  }
  return { id, record, all };
}

function normalizeMatchText(value) {
  return String(value || "").trim().replace(/^\.\//, "");
}

function refMatches(candidate, target) {
  const left = normalizeMatchText(candidate);
  const right = normalizeMatchText(target);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function normalizeSearchText(value) {
  return String(value || "").trim().replace(/^\.\//, "").toLowerCase();
}

function refPath(value) {
  return String(value || "")
    .replace(/^\.\//, "")
    .split("#")[0]
    .replace(/:\d+(?:-\d+)?$/, "");
}

function refExtension(value) {
  return path.extname(refPath(value)).replace(/^\./, "").toLowerCase();
}

function memoryRecordRefs(record = {}) {
  return [record.ref, ...(record.files || []), ...(record.sourceRefs || [])].filter(Boolean);
}

function normalizeFileType(value) {
  const clean = String(value || "").trim().replace(/^\./, "").toLowerCase();
  return clean || "";
}

function normalizeSourceQuality(value) {
  const clean = String(value || "").trim().toLowerCase();
  return ["strong", "watch", "weak"].includes(clean) ? clean : "";
}

function normalizeSearchFilters(input = {}) {
  const filters = {
    type: input.type ? normalizeType(input.type) : "",
    file: normalizeMatchText(input.file || ""),
    folder: normalizeMatchText(input.folder || input.path || ""),
    sourceRef: normalizeMatchText(input.sourceRef || ""),
    concept: String(input.concept || "").trim().toLowerCase(),
    goalId: String(input.goalId || "").trim(),
    fileType: normalizeFileType(input.fileType || input.ext || input.extension || ""),
    minConfidence: input.minConfidence === undefined || input.minConfidence === "" ? null : Math.max(0, Math.min(1, Number(input.minConfidence))),
    sourceQuality: normalizeSourceQuality(input.sourceQuality),
    latestOnly: input.latestOnly === true || input.latestOnly === "true"
  };
  if (filters.minConfidence !== null && !Number.isFinite(filters.minConfidence)) filters.minConfidence = null;
  return filters;
}

function visibleSearchFilters(filters = {}) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) =>
    Array.isArray(value) ? value.length : value !== "" && value !== null && value !== false && value !== undefined
  ));
}

function refInFolder(ref, folder) {
  if (!folder || folder === ".") return true;
  const cleanRef = normalizeSearchText(refPath(ref));
  const cleanFolder = normalizeSearchText(folder).replace(/\/+$/, "");
  return cleanRef === cleanFolder || cleanRef.startsWith(`${cleanFolder}/`) || cleanRef.includes(`/${cleanFolder}/`);
}

function stateRefPriority(ref) {
  const clean = refPath(ref);
  const name = path.posix.basename(clean);
  if (clean === ".project-agent/takeover-summary.json") return 12;
  if (clean === ".project-agent/process-trace.json") return 11;
  if (clean === ".project-agent/architecture-map.json") return 10;
  if (clean === ".project-agent/runtime.json") return 9;
  if (clean === ".project-agent/state.json") return 8;
  if (clean === ".project-agent/agent-runbook.json" || clean === ".project-agent/continuity-contract.json") return 7;
  if (SOURCE_STATE_FILES.has(name)) return 7;
  if (DERIVED_STATE_FILES.has(name)) return 3;
  if (clean.startsWith(".project-agent/memory/")) return 4;
  if (clean.startsWith("docs/")) return 5;
  return 2;
}

function sourceQualityForRecord(record = {}) {
  const sourceRefs = record.sourceRefs || [];
  const refs = memoryRecordRefs(record);
  const confidence = Number(record.confidence ?? 0);
  const directRefs = sourceRefs.filter((ref) => {
    const clean = refPath(ref);
    const name = path.posix.basename(clean);
    return clean && !DERIVED_STATE_FILES.has(name);
  });
  const derivedOnly = sourceRefs.length > 0 && !directRefs.length;
  const reasons = [];
  if (!sourceRefs.length) reasons.push("missing_source_refs");
  if (derivedOnly) reasons.push("derived_only_refs");
  if (confidence < 0.55) reasons.push("low_confidence");
  if (record.redaction?.status === "redacted") reasons.push("redacted");
  if (record.isLatest === false) reasons.push("superseded");
  if (directRefs.length) reasons.push("direct_source_refs");
  if ((record.files || []).length) reasons.push("file_refs");
  const score = Math.max(0, Math.min(16,
    Math.round(confidence * 8) +
    (directRefs.length ? 4 : 0) +
    ((record.files || []).length ? 2 : 0) +
    (record.isLatest === false ? -4 : 1) +
    (record.redaction?.status === "redacted" ? -4 : 0)
  ));
  const status = reasons.includes("missing_source_refs") || reasons.includes("low_confidence") || reasons.includes("redacted")
    ? "weak"
    : derivedOnly || confidence < 0.72
      ? "watch"
      : "strong";
  return {
    status,
    score,
    confidence,
    sourceRefCount: sourceRefs.length,
    fileRefCount: refs.length,
    reasons: [...new Set(reasons)]
  };
}

function dogfoodSeedDefinitions(projectDir) {
  if (!existsSync(path.join(projectDir, MEMORY_GAP_BENCHMARK_REF))) return [];
  const baseRefs = [MEMORY_GAP_BENCHMARK_REF, "docs/product/roadmap.md", "docs/product/memory-implementation-steps.md"];
  const common = {
    sourceRefs: baseRefs,
    files: ["server/memory-store.js", "server/project-mcp.js", "src/App.jsx"],
    concepts: [DOGFOOD_SEED_CONCEPT, "p0-lifecycle", "canonical-memory"],
    confidence: 0.92,
    importance: 9
  };
  return [
    {
      ...common,
      id: "mem_dogfood_grep_first_source_truth",
      type: "decision",
      title: "Grep-first canonical memory is the source of truth",
      content: "Deep benchmark confirms CLI Memo already has a strong grep-first canonical memory control plane. Durable JSONL memory remains source of truth; BM25, entity, and vector files are rebuildable caches."
    },
    {
      ...common,
      id: "mem_dogfood_lifecycle_p0_order",
      type: "decision",
      title: "Memory lifecycle P0 comes before semantic and AST upgrades",
      content: "Roadmap execution should land dogfood seed, update, supersede, and retention audit/sweep before Consolidation V2, optional semantic embeddings, and tree-sitter/AST code memory."
    },
    {
      ...common,
      id: "mem_dogfood_agent_harness_protocol",
      type: "procedure",
      title: "Agents should route memory through the harness automatically",
      content: "Incoming agents should start with project_takeover_summary and then rely on project_memory_harness for automatic search/read routing, lifecycle status, and governed next calls instead of asking users to manually choose memory refs."
    },
    {
      ...common,
      id: "mem_dogfood_lexical_vector_risk",
      type: "risk",
      title: "Vector cache is lexical, not semantic",
      content: "The optional vector cache uses lexical-vector-lite with embeddingProvider none. It can improve deterministic discovery, but it must not be treated as semantic retrieval until provider-backed embeddings are added."
    },
    {
      ...common,
      id: "mem_dogfood_generated_state_rebuildable",
      type: "fact",
      title: "Generated state and memory indexes are rebuildable",
      content: "Generated handoff state, memory index markdown, BM25/entity/vector caches, and state manifests are derived surfaces. Canonical JSONL memory plus source project files should drive rebuilds and retention sweeps."
    }
  ];
}

function dogfoodSeedPlan(projectDir) {
  const definitions = dogfoodSeedDefinitions(projectDir);
  if (!definitions.length) {
    return {
      schemaVersion: "project-agent.memory-dogfood-seed-status.v1",
      status: "unavailable",
      expected: 0,
      present: 0,
      missing: 0,
      summary: `${MEMORY_GAP_BENCHMARK_REF} is not present, so project dogfood memory is not seedable.`,
      refs: [MEMORY_GAP_BENCHMARK_REF]
    };
  }
  const existing = readAllMemory(projectDir).records;
  const existingIds = new Set(existing.map((record) => record.id));
  const existingDogfood = existing.filter((record) => (record.concepts || []).includes(DOGFOOD_SEED_CONCEPT) || definitions.some((definition) => definition.id === record.id));
  const missing = definitions.filter((definition) => !existingIds.has(definition.id));
  const status = missing.length === 0 ? "seeded" : existingDogfood.length ? "incomplete" : "empty";
  return {
    schemaVersion: "project-agent.memory-dogfood-seed-status.v1",
    status,
    expected: definitions.length,
    present: definitions.length - missing.length,
    missing: missing.length,
    summary: missing.length
      ? `${missing.length}/${definitions.length} dogfood memory seed record(s) are missing.`
      : `${definitions.length} dogfood memory seed record(s) are present.`,
    records: definitions.map((definition) => ({
      id: definition.id,
      type: definition.type,
      title: definition.title,
      present: existingIds.has(definition.id),
      ref: existing.find((record) => record.id === definition.id)?.ref || null
    })),
    refs: [MEMORY_GAP_BENCHMARK_REF, ".project-agent/memory/index.md"]
  };
}

function searchRankingContext(projectDir, input = {}) {
  const architecture = readJsonFile(path.join(stateDir(projectDir), "architecture-map.json"), {});
  const changes = architecture?.recentChanges || architecture?.changes || [];
  const changedFiles = new Set(changes.map((item) => normalizeSearchText(item.path || item.file || item.ref || "")).filter(Boolean));
  const activeGoal = input.goalId || activeGoalId(projectDir);
  return { activeGoal, changedFiles };
}

function recordMatchesSearchFilters(record = {}, filters = {}, quality = sourceQualityForRecord(record)) {
  const refs = memoryRecordRefs(record);
  if (filters.type && normalizeType(record.type) !== filters.type) return false;
  if (filters.file && !refs.some((ref) => refMatches(ref, filters.file))) return false;
  if (filters.folder && !refs.some((ref) => refInFolder(ref, filters.folder))) return false;
  if (filters.sourceRef && !(record.sourceRefs || []).some((ref) => refMatches(ref, filters.sourceRef))) return false;
  if (filters.concept && !(record.concepts || []).some((concept) => String(concept || "").toLowerCase() === filters.concept)) return false;
  if (filters.goalId && record.scope?.goalId !== filters.goalId) return false;
  if (filters.fileType && !refs.some((ref) => refExtension(ref) === filters.fileType)) return false;
  if (filters.minConfidence !== null && Number(record.confidence ?? 0) < filters.minConfidence) return false;
  if (filters.sourceQuality && quality.status !== filters.sourceQuality) return false;
  if (filters.latestOnly && record.isLatest === false) return false;
  return true;
}

function canonicalMemoryDigest(projectDir, all = readAllMemory(projectDir)) {
  const records = (all.records || []).map((record) => ({
    id: record.id,
    type: record.type,
    title: record.title,
    content: record.content,
    scope: record.scope || {},
    sourceRefs: record.sourceRefs || [],
    files: record.files || [],
    concepts: record.concepts || [],
    confidence: record.confidence,
    importance: record.importance,
    updatedAt: record.updatedAt,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    isLatest: record.isLatest !== false,
    redaction: record.redaction || null
  })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    hash: sha256(JSON.stringify(records)),
    records: records.length,
    errors: all.errors || []
  };
}

function termFrequencies(terms = []) {
  const frequencies = {};
  for (const term of terms) frequencies[term] = (frequencies[term] || 0) + 1;
  return frequencies;
}

function memoryIndexDocument(record = {}) {
  const refs = memoryRecordRefs(record);
  const text = [
    record.type,
    record.title,
    record.content,
    ...(record.concepts || []),
    ...refs
  ].filter(Boolean).join(" ");
  const terms = tokenizeForIndex(text);
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    ref: record.ref,
    refs: refs.slice(0, 12),
    length: terms.length,
    termFrequencies: termFrequencies(terms),
    updatedAt: record.updatedAt || record.createdAt || null
  };
}

function buildMemorySearchIndexPayload(projectDir, all = readAllMemory(projectDir)) {
  const digest = canonicalMemoryDigest(projectDir, all);
  const documents = (all.records || []).map(memoryIndexDocument);
  const documentFrequency = {};
  for (const doc of documents) {
    for (const term of Object.keys(doc.termFrequencies || {})) documentFrequency[term] = (documentFrequency[term] || 0) + 1;
  }
  const documentCount = documents.length;
  const idf = {};
  for (const [term, frequency] of Object.entries(documentFrequency)) {
    idf[term] = Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
  }
  const avgDocLength = documentCount
    ? documents.reduce((sum, doc) => sum + Number(doc.length || 0), 0) / documentCount
    : 0;
  return {
    schemaVersion: "project-agent.memory-search-index.v1",
    engine: "bm25-lite",
    ref: MEMORY_SEARCH_INDEX_REF,
    generatedAt: nowIso(),
    canonicalHash: digest.hash,
    sourceRecords: digest.records,
    sourceErrors: digest.errors.length,
    params: BM25_PARAMS,
    statistics: {
      documentCount,
      avgDocLength: Number(avgDocLength.toFixed(2)),
      termCount: Object.keys(idf).length
    },
    documents,
    idf
  };
}

function normalizeEntityLabel(value) {
  return String(value || "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function entityKey(kind, value) {
  const label = normalizeEntityLabel(value);
  return label ? `${kind}:${label}` : "";
}

function significantEntityTerms(value, limit = 28) {
  const terms = tokenizeForIndex(value)
    .map((term) => normalizeEntityLabel(term))
    .filter((term) => term.length >= 3)
    .filter((term) => !ENTITY_TERM_STOPWORDS.has(term))
    .filter((term) => !/^\d+$/.test(term));
  return [...new Set(terms)].slice(0, limit);
}

function refFolderEntity(ref = "") {
  const clean = normalizeEntityLabel(ref).split("#")[0];
  if (!clean || !clean.includes("/")) return "";
  const dir = path.posix.dirname(clean);
  return dir && dir !== "." ? dir : "";
}

function entityCandidatesForRecord(record = {}) {
  const candidates = [];
  const push = (kind, label, weight = 1) => {
    const key = entityKey(kind, label);
    if (!key) return;
    candidates.push({ key, kind, label: normalizeEntityLabel(label), weight });
  };
  push("type", record.type, 1);
  for (const concept of record.concepts || []) push("concept", concept, 4);
  const refs = memoryRecordRefs(record);
  for (const ref of refs) {
    const clean = normalizeEntityLabel(ref);
    if (!clean) continue;
    const refBase = clean.split("#")[0];
    const extension = refExtension(ref);
    if (extension) push("file", refBase, 4);
    if (extension) push("extension", extension, 1);
    const folder = refFolderEntity(ref);
    if (folder) push("folder", folder, 3);
    if (clean.startsWith(".project-agent/")) push("source", refBase, 2);
  }
  for (const term of significantEntityTerms(record.title, 18)) push("term", term, 3);
  for (const term of significantEntityTerms(record.content, 22)) push("term", term, 2);
  const unique = new Map();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.key);
    unique.set(candidate.key, previous ? { ...previous, weight: Math.max(previous.weight, candidate.weight) } : candidate);
  }
  return [...unique.values()].slice(0, 48);
}

function buildMemoryEntityIndexPayload(projectDir, all = readAllMemory(projectDir)) {
  const digest = canonicalMemoryDigest(projectDir, all);
  const entityMap = new Map();
  const edgeMap = new Map();
  const documents = (all.records || []).map((record) => {
    const entities = entityCandidatesForRecord(record);
    for (const entity of entities) {
      const current = entityMap.get(entity.key) || {
        key: entity.key,
        kind: entity.kind,
        label: entity.label,
        recordIds: [],
        refs: [],
        weight: 0
      };
      current.weight += entity.weight;
      if (!current.recordIds.includes(record.id)) current.recordIds.push(record.id);
      if (record.ref && !current.refs.includes(record.ref) && current.refs.length < 8) current.refs.push(record.ref);
      entityMap.set(entity.key, current);
    }
    const edgeEntities = entities.slice(0, 24);
    for (let i = 0; i < edgeEntities.length; i += 1) {
      for (let j = i + 1; j < edgeEntities.length; j += 1) {
        const [from, to] = [edgeEntities[i].key, edgeEntities[j].key].sort();
        const edgeKey = `${from}=>${to}`;
        const current = edgeMap.get(edgeKey) || { from, to, weight: 0, recordIds: [] };
        current.weight += Math.max(edgeEntities[i].weight, edgeEntities[j].weight);
        if (!current.recordIds.includes(record.id)) current.recordIds.push(record.id);
        edgeMap.set(edgeKey, current);
      }
    }
    return {
      id: record.id,
      type: record.type,
      title: record.title,
      ref: record.ref,
      entities: entities.map((entity) => ({ key: entity.key, weight: entity.weight })),
      updatedAt: record.updatedAt || record.createdAt || null
    };
  });
  const entities = [...entityMap.values()]
    .map((entity) => ({
      ...entity,
      recordCount: entity.recordIds.length,
      recordIds: entity.recordIds.slice(0, 50),
      refs: entity.refs.slice(0, 8),
      weight: Number(entity.weight.toFixed(2))
    }))
    .sort((a, b) => b.recordCount - a.recordCount || b.weight - a.weight || a.key.localeCompare(b.key));
  const edges = [...edgeMap.values()]
    .map((edge) => ({
      ...edge,
      recordCount: edge.recordIds.length,
      recordIds: edge.recordIds.slice(0, 24),
      weight: Number(edge.weight.toFixed(2))
    }))
    .sort((a, b) => b.recordCount - a.recordCount || b.weight - a.weight)
    .slice(0, 2000);
  const avgEntitiesPerRecord = documents.length
    ? documents.reduce((sum, doc) => sum + doc.entities.length, 0) / documents.length
    : 0;
  return {
    schemaVersion: "project-agent.memory-entity-index.v1",
    engine: "entity-graph-lite",
    ref: MEMORY_ENTITY_INDEX_REF,
    generatedAt: nowIso(),
    canonicalHash: digest.hash,
    sourceRecords: digest.records,
    sourceErrors: digest.errors.length,
    statistics: {
      documentCount: documents.length,
      entityCount: entities.length,
      edgeCount: edges.length,
      avgEntitiesPerRecord: Number(avgEntitiesPerRecord.toFixed(2))
    },
    documents,
    entities,
    edges
  };
}

function vectorFeatureList(value = "", maxFeatures = VECTOR_PARAMS.maxFeatures) {
  const terms = tokenizeForIndex(value)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 1);
  const features = [];
  for (const term of terms) {
    features.push(`term:${term}`);
    if (term.length >= 4) {
      const clean = term.replace(/[^a-z0-9_./:-]/gi, "");
      for (let index = 0; index <= clean.length - 3 && index < 8; index += 1) {
        features.push(`tri:${clean.slice(index, index + 3)}`);
      }
    }
  }
  for (let index = 0; index < terms.length - 1 && index < 80; index += 1) {
    features.push(`bigram:${terms[index]} ${terms[index + 1]}`);
  }
  return features.slice(0, maxFeatures);
}

function hashedVector(features = [], dimensions = VECTOR_PARAMS.dimensions) {
  const buckets = new Map();
  for (const feature of features) {
    const hash = sha256(feature);
    const dimension = parseInt(hash.slice(0, 8), 16) % dimensions;
    const sign = parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    buckets.set(dimension, (buckets.get(dimension) || 0) + sign);
  }
  const norm = Math.sqrt([...buckets.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  return Object.fromEntries(
    [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dimension, value]) => [String(dimension), Number((value / norm).toFixed(6))])
      .filter(([, value]) => value !== 0)
  );
}

function memoryVectorDocument(record = {}) {
  const refs = memoryRecordRefs(record);
  const text = [
    record.type,
    record.title,
    record.content,
    ...(record.concepts || []),
    ...refs
  ].filter(Boolean).join(" ");
  const features = vectorFeatureList(text);
  const vector = hashedVector(features);
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    ref: record.ref,
    refs: refs.slice(0, 12),
    vector,
    featureCount: features.length,
    dimensionsUsed: Object.keys(vector).length,
    updatedAt: record.updatedAt || record.createdAt || null
  };
}

function buildMemoryVectorIndexPayload(projectDir, all = readAllMemory(projectDir)) {
  const digest = canonicalMemoryDigest(projectDir, all);
  const documents = (all.records || []).map(memoryVectorDocument);
  const avgDimensionsUsed = documents.length
    ? documents.reduce((sum, doc) => sum + Number(doc.dimensionsUsed || 0), 0) / documents.length
    : 0;
  return {
    schemaVersion: "project-agent.memory-vector-index.v1",
    engine: "lexical-vector-lite",
    ref: MEMORY_VECTOR_INDEX_REF,
    generatedAt: nowIso(),
    canonicalHash: digest.hash,
    sourceRecords: digest.records,
    sourceErrors: digest.errors.length,
    params: VECTOR_PARAMS,
    statistics: {
      documentCount: documents.length,
      dimensions: VECTOR_PARAMS.dimensions,
      avgDimensionsUsed: Number(avgDimensionsUsed.toFixed(2)),
      embeddingProvider: VECTOR_PARAMS.embeddingProvider,
      featureModel: VECTOR_PARAMS.featureModel
    },
    documents
  };
}

function compactMemorySearchIndex(index = null, status = "missing", currentDigest = null, bytes = 0) {
  if (!index) {
    return {
      schemaVersion: "project-agent.memory-search-index-status.v1",
      ok: true,
      status,
      engine: "bm25-lite",
      ref: MEMORY_SEARCH_INDEX_REF,
      exists: false,
      fresh: false,
      bytes,
      sourceRecords: currentDigest?.records || 0,
      currentHash: currentDigest?.hash || null,
      generatedAt: null
    };
  }
  const fresh = status === "fresh";
  return {
    schemaVersion: "project-agent.memory-search-index-status.v1",
    ok: true,
    status,
    engine: index.engine || "bm25-lite",
    ref: index.ref || MEMORY_SEARCH_INDEX_REF,
    exists: true,
    fresh,
    bytes,
    generatedAt: index.generatedAt || null,
    canonicalHash: index.canonicalHash || null,
    currentHash: currentDigest?.hash || null,
    sourceRecords: Number(index.sourceRecords || 0),
    currentRecords: currentDigest?.records || 0,
    statistics: index.statistics || null,
    params: index.params || BM25_PARAMS
  };
}

function readMemorySearchIndex(projectDir, options = {}) {
  const filePath = memorySearchIndexFile(projectDir);
  const currentDigest = options.currentDigest || canonicalMemoryDigest(projectDir);
  if (!existsSync(filePath)) {
    return { status: "missing", index: null, public: compactMemorySearchIndex(null, "missing", currentDigest, 0) };
  }
  const bytes = statSync(filePath).size;
  const index = readJsonFile(filePath, null);
  if (!index || index.schemaVersion !== "project-agent.memory-search-index.v1") {
    return { status: "invalid", index: null, public: compactMemorySearchIndex(null, "invalid", currentDigest, bytes) };
  }
  const status = index.canonicalHash === currentDigest.hash ? "fresh" : "stale";
  return { status, index, public: compactMemorySearchIndex(index, status, currentDigest, bytes) };
}

function compactMemoryEntityIndex(index = null, status = "missing", currentDigest = null, bytes = 0) {
  if (!index) {
    return {
      schemaVersion: "project-agent.memory-entity-index-status.v1",
      ok: true,
      status,
      engine: "entity-graph-lite",
      ref: MEMORY_ENTITY_INDEX_REF,
      exists: false,
      fresh: false,
      bytes,
      sourceRecords: currentDigest?.records || 0,
      currentHash: currentDigest?.hash || null,
      generatedAt: null
    };
  }
  const fresh = status === "fresh";
  return {
    schemaVersion: "project-agent.memory-entity-index-status.v1",
    ok: true,
    status,
    engine: index.engine || "entity-graph-lite",
    ref: index.ref || MEMORY_ENTITY_INDEX_REF,
    exists: true,
    fresh,
    bytes,
    generatedAt: index.generatedAt || null,
    canonicalHash: index.canonicalHash || null,
    currentHash: currentDigest?.hash || null,
    sourceRecords: Number(index.sourceRecords || 0),
    currentRecords: currentDigest?.records || 0,
    statistics: index.statistics || null
  };
}

function readMemoryEntityIndex(projectDir, options = {}) {
  const filePath = memoryEntityIndexFile(projectDir);
  const currentDigest = options.currentDigest || canonicalMemoryDigest(projectDir);
  if (!existsSync(filePath)) {
    return { status: "missing", index: null, public: compactMemoryEntityIndex(null, "missing", currentDigest, 0) };
  }
  const bytes = statSync(filePath).size;
  const index = readJsonFile(filePath, null);
  if (!index || index.schemaVersion !== "project-agent.memory-entity-index.v1") {
    return { status: "invalid", index: null, public: compactMemoryEntityIndex(null, "invalid", currentDigest, bytes) };
  }
  const status = index.canonicalHash === currentDigest.hash ? "fresh" : "stale";
  return { status, index, public: compactMemoryEntityIndex(index, status, currentDigest, bytes) };
}

function compactMemoryVectorIndex(index = null, status = "missing", currentDigest = null, bytes = 0) {
  if (!index) {
    return {
      schemaVersion: "project-agent.memory-vector-index-status.v1",
      ok: true,
      status,
      engine: "lexical-vector-lite",
      ref: MEMORY_VECTOR_INDEX_REF,
      exists: false,
      fresh: false,
      bytes,
      sourceRecords: currentDigest?.records || 0,
      currentHash: currentDigest?.hash || null,
      generatedAt: null,
      embeddingProvider: VECTOR_PARAMS.embeddingProvider
    };
  }
  const fresh = status === "fresh";
  return {
    schemaVersion: "project-agent.memory-vector-index-status.v1",
    ok: true,
    status,
    engine: index.engine || "lexical-vector-lite",
    ref: index.ref || MEMORY_VECTOR_INDEX_REF,
    exists: true,
    fresh,
    bytes,
    generatedAt: index.generatedAt || null,
    canonicalHash: index.canonicalHash || null,
    currentHash: currentDigest?.hash || null,
    sourceRecords: Number(index.sourceRecords || 0),
    currentRecords: currentDigest?.records || 0,
    statistics: index.statistics || null,
    params: index.params || VECTOR_PARAMS,
    embeddingProvider: index.params?.embeddingProvider || index.statistics?.embeddingProvider || VECTOR_PARAMS.embeddingProvider
  };
}

function readMemoryVectorIndex(projectDir, options = {}) {
  const filePath = memoryVectorIndexFile(projectDir);
  const currentDigest = options.currentDigest || canonicalMemoryDigest(projectDir);
  if (!existsSync(filePath)) {
    return { status: "missing", index: null, public: compactMemoryVectorIndex(null, "missing", currentDigest, 0) };
  }
  const bytes = statSync(filePath).size;
  const index = readJsonFile(filePath, null);
  if (!index || index.schemaVersion !== "project-agent.memory-vector-index.v1") {
    return { status: "invalid", index: null, public: compactMemoryVectorIndex(null, "invalid", currentDigest, bytes) };
  }
  const status = index.canonicalHash === currentDigest.hash ? "fresh" : "stale";
  return { status, index, public: compactMemoryVectorIndex(index, status, currentDigest, bytes) };
}

function normalizeIndexPreference(input = {}) {
  const raw = input.useIndex ?? input.index ?? input.engine ?? false;
  if (raw === true) return "bm25";
  const clean = String(raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "bm25", "fts", "cache"].includes(clean)) return "bm25";
  if (["entity", "entities", "entity-graph", "graph"].includes(clean)) return "entity";
  if (["vector", "vectors", "embedding", "embeddings", "rerank"].includes(clean)) return "vector";
  if (["hybrid", "all", "both"].includes(clean)) return "hybrid";
  return "";
}

function scoreBm25(index = {}, terms = []) {
  const scores = new Map();
  const uniqueTerms = [...new Set(terms || [])];
  if (!uniqueTerms.length || !index?.documents?.length) return scores;
  const avgDocLength = Number(index.statistics?.avgDocLength || 0) || 1;
  const k1 = Number(index.params?.k1 || BM25_PARAMS.k1);
  const b = Number(index.params?.b || BM25_PARAMS.b);
  for (const doc of index.documents || []) {
    let score = 0;
    const length = Number(doc.length || 0) || 1;
    for (const term of uniqueTerms) {
      const tf = Number(doc.termFrequencies?.[term] || 0);
      if (!tf) continue;
      const idf = Number(index.idf?.[term] || 0);
      const denominator = tf + k1 * (1 - b + b * (length / avgDocLength));
      score += idf * ((tf * (k1 + 1)) / denominator);
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

function entityQueryKeys(query = "", filters = {}) {
  const keys = new Set();
  for (const term of significantEntityTerms(query, 24)) keys.add(entityKey("term", term));
  if (filters.type) keys.add(entityKey("type", filters.type));
  if (filters.concept) keys.add(entityKey("concept", filters.concept));
  if (filters.folder) keys.add(entityKey("folder", filters.folder));
  if (filters.file) keys.add(entityKey("file", normalizeEntityLabel(filters.file).split("#")[0]));
  if (filters.fileType) keys.add(entityKey("extension", filters.fileType));
  if (filters.sourceRef) keys.add(entityKey("source", normalizeEntityLabel(filters.sourceRef).split("#")[0]));
  return [...keys].filter(Boolean);
}

function entityScoreWeight(kind = "") {
  if (kind === "concept" || kind === "file") return 9;
  if (kind === "folder") return 7;
  if (kind === "term") return 5;
  if (kind === "source") return 4;
  if (kind === "type" || kind === "extension") return 3;
  return 2;
}

function scoreEntityIndex(index = {}, query = "", filters = {}) {
  const scores = new Map();
  const matchedEntities = [];
  const expandedEntities = [];
  if (!index?.documents?.length || !index?.entities?.length) return { scores, matchedEntities, expandedEntities };
  const entityByKey = new Map((index.entities || []).map((entity) => [entity.key, entity]));
  const docEntities = new Map((index.documents || []).map((doc) => [doc.id, new Map((doc.entities || []).map((entity) => [entity.key, entity.weight || 1]))]));
  const matched = entityQueryKeys(query, filters).filter((key) => entityByKey.has(key));
  for (const key of matched) {
    const entity = entityByKey.get(key);
    matchedEntities.push({ key, kind: entity.kind, label: entity.label, recordCount: entity.recordCount || 0 });
    const weight = entityScoreWeight(entity.kind);
    for (const recordId of entity.recordIds || []) {
      const recordWeight = Number(docEntities.get(recordId)?.get(key) || 1);
      scores.set(recordId, (scores.get(recordId) || 0) + weight + recordWeight);
    }
  }
  const matchedSet = new Set(matched);
  for (const edge of index.edges || []) {
    const touchesFrom = matchedSet.has(edge.from);
    const touchesTo = matchedSet.has(edge.to);
    if (!touchesFrom && !touchesTo) continue;
    const otherKey = touchesFrom ? edge.to : edge.from;
    const other = entityByKey.get(otherKey);
    if (other && expandedEntities.length < 12) expandedEntities.push({ key: other.key, kind: other.kind, label: other.label, via: touchesFrom ? edge.from : edge.to });
    for (const recordId of edge.recordIds || []) {
      scores.set(recordId, (scores.get(recordId) || 0) + Math.min(4, Number(edge.weight || 1)));
    }
  }
  return { scores, matchedEntities: matchedEntities.slice(0, 12), expandedEntities: expandedEntities.slice(0, 12) };
}

function sparseDot(a = {}, b = {}) {
  let score = 0;
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const [dimension, value] of Object.entries(small)) {
    const other = large[dimension];
    if (other) score += Number(value || 0) * Number(other || 0);
  }
  return score;
}

function scoreVectorIndex(index = {}, query = "", filters = {}) {
  const scores = new Map();
  const explanation = {
    similarity: "cosine",
    dimensions: index.params?.dimensions || VECTOR_PARAMS.dimensions,
    embeddingProvider: index.params?.embeddingProvider || VECTOR_PARAMS.embeddingProvider,
    featureModel: index.params?.featureModel || VECTOR_PARAMS.featureModel
  };
  const queryText = [
    query,
    filters.type,
    filters.concept,
    filters.folder,
    filters.file,
    filters.fileType,
    filters.sourceRef
  ].filter(Boolean).join(" ");
  if (!queryText.trim() || !index?.documents?.length) return { scores, explanation };
  const queryVector = hashedVector(vectorFeatureList(queryText, index.params?.maxFeatures || VECTOR_PARAMS.maxFeatures), index.params?.dimensions || VECTOR_PARAMS.dimensions);
  for (const doc of index.documents || []) {
    const similarity = sparseDot(queryVector, doc.vector || {});
    if (similarity >= Number(index.params?.minSimilarity || VECTOR_PARAMS.minSimilarity)) {
      scores.set(doc.id, similarity);
    }
  }
  return { scores, explanation };
}

function dateInRange(record, input = {}) {
  const from = input.dateFrom ? Date.parse(input.dateFrom) : null;
  const to = input.dateTo ? Date.parse(input.dateTo) : null;
  if (!from && !to) return true;
  const observed = Date.parse(record.updatedAt || record.createdAt || record.validFrom || "");
  if (!Number.isFinite(observed)) return false;
  if (from && observed < from) return false;
  if (to && observed > to) return false;
  return true;
}

function dateInConsolidationRange(value, input = {}) {
  const observed = Date.parse(value || "");
  if (!Number.isFinite(observed)) return !(input.since || input.until);
  const since = input.since ? Date.parse(input.since) : null;
  const until = input.until ? Date.parse(input.until) : null;
  if (since && observed < since) return false;
  if (until && observed > until) return false;
  return true;
}

function activeGoalId(projectDir) {
  const state = readJsonFile(path.join(stateDir(projectDir), "state.json"), {});
  if (state.activeGoalId) return state.activeGoalId;
  if (state.activeGoal?.id) return state.activeGoal.id;
  const goals = Array.isArray(state.goals) ? state.goals : [];
  return goals.find((goal) => goal.status === "active")?.id || "";
}

function normalizedEventText(event = {}) {
  return compact([
    event.title,
    event.detail,
    event.phase,
    event.status,
    event.workstream,
    event.tool,
    event.error,
    event.data ? JSON.stringify(event.data) : ""
  ].filter(Boolean).join(" "), 1400);
}

function candidateTypeForEvent(event = {}) {
  const text = normalizedEventText(event).toLowerCase();
  if (event.phase === "evidence") return "evidence";
  if (event.status === "failed" || event.status === "blocked" || event.error || /\b(risk|blocker|failed|failure|warning|hazard|stale)\b/.test(text)) return "risk";
  if (/\b(decision|decided|choose|chosen|rationale|architecture decision|tradeoff)\b/.test(text) || /决定|选择|取舍/.test(text)) return "decision";
  if (/\b(procedure|workflow|runbook|repeat|step|command|fix|repair|npm|node|curl|playwright)\b/.test(text) || /步骤|流程|命令|修复/.test(text)) return "procedure";
  if (/\b(evidence|verified|verification|test|tests|smoke|build|qa|screenshot|proof)\b/.test(text)) return "evidence";
  if (event.phase === "plan") return "decision";
  return "episode";
}

function confidenceForCandidate(type, source, event = {}) {
  if (type === "decision") return event.phase === "plan" || source === "handoff" ? 0.82 : 0.72;
  if (type === "procedure") return 0.78;
  if (type === "evidence") return 0.8;
  if (type === "risk") return 0.77;
  if (source === "architecture") return 0.7;
  return 0.62;
}

function importanceForCandidate(type, event = {}) {
  if (type === "decision" || type === "risk") return 8;
  if (type === "procedure" || type === "evidence") return 7;
  if (event.status === "current") return 6;
  return 4;
}

function conceptsForCandidate(type, source, event = {}) {
  return [...new Set([
    "consolidated",
    source,
    type,
    event.phase,
    event.workstream,
    event.tool
  ].filter(Boolean).map((item) => String(item).toLowerCase()))].slice(0, 16);
}

function candidateHash(candidate = {}) {
  return sha256(JSON.stringify({
    type: candidate.type,
    title: candidate.title,
    content: candidate.content,
    sourceRefs: [...(candidate.sourceRefs || [])].sort()
  }));
}

function candidateId(candidate = {}) {
  return `cand_${candidateHash(candidate).slice(0, 16)}`;
}

function eventCandidate(projectDir, event = {}, index = 0) {
  const type = candidateTypeForEvent(event);
  const sourceRef = `.project-agent/runtime.json#events[${index}]`;
  const title = compact(`${type === "episode" ? "Runtime episode" : cleanCandidateType(type)}: ${event.title || "Runtime event"}`, 150);
  const refs = normalizeRefs([sourceRef, ...(event.refs || []), ...(event.artifactRefs || [])]).slice(0, 12);
  const files = normalizeRefs([...(event.files || []).map((file) => file.path).filter(Boolean)]);
  const detail = event.detail || event.error || event.title || "Runtime event recorded by Project Agent Terminal.";
  const candidate = {
    source: "runtime",
    type,
    title,
    content: compact(`${event.phase || "observe"}/${event.status || "done"} runtime event recorded ${event.at || event.endedAt || event.startedAt || "without timestamp"}. ${detail}`, 1800),
    sourceRefs: refs.length ? refs : [sourceRef],
    files,
    concepts: conceptsForCandidate(type, "runtime", event),
    goalId: event.goalId || null,
    agentId: event.agentId || null,
    confidence: confidenceForCandidate(type, "runtime", event),
    importance: importanceForCandidate(type, event),
    observedAt: event.at || event.endedAt || event.startedAt || null,
    sourceEventIds: [event.id].filter(Boolean)
  };
  candidate.id = candidateId(candidate);
  candidate.hash = candidateHash(candidate);
  return candidate;
}

function cleanCandidateType(type) {
  return String(type || "memory").slice(0, 1).toUpperCase() + String(type || "memory").slice(1);
}

function handoffCandidates(projectDir) {
  const summary = readJsonFile(path.join(stateDir(projectDir), "takeover-summary.json"), null);
  if (!summary) return [];
  const candidates = [];
  const current = summary.currentState || {};
  if (current.title || current.summary || current.detail) {
    const candidate = {
      source: "handoff",
      type: "episode",
      title: compact(`Handoff state: ${current.title || summary.activeGoal?.objective || "Current project state"}`, 150),
      content: compact(current.summary || current.detail || summary.currentState?.body || "Current handoff state captured for takeover.", 1800),
      sourceRefs: [".project-agent/takeover-summary.json#currentState"],
      files: normalizeRefs(current.refs || summary.sourceRefs || []),
      concepts: ["consolidated", "handoff", "episode"],
      goalId: summary.activeGoal?.id || null,
      agentId: null,
      confidence: confidenceForCandidate("episode", "handoff"),
      importance: 5,
      observedAt: summary.generatedAt || null,
      sourceEventIds: []
    };
    candidate.id = candidateId(candidate);
    candidate.hash = candidateHash(candidate);
    candidates.push(candidate);
  }
  (summary.risks || []).slice(0, 6).forEach((risk, index) => {
    const candidate = {
      source: "handoff",
      type: "risk",
      title: compact(`Handoff risk: ${risk.id || risk.title || risk.summary || `risk ${index + 1}`}`, 150),
      content: compact(risk.summary || risk.detail || risk.nextAction || "Handoff risk captured for future agents.", 1800),
      sourceRefs: [`.project-agent/takeover-summary.json#risks[${index}]`, ...(risk.refs || [])],
      files: normalizeRefs(risk.files || []),
      concepts: ["consolidated", "handoff", "risk"],
      goalId: summary.activeGoal?.id || null,
      agentId: null,
      confidence: confidenceForCandidate("risk", "handoff"),
      importance: 8,
      observedAt: summary.generatedAt || null,
      sourceEventIds: []
    };
    candidate.id = candidateId(candidate);
    candidate.hash = candidateHash(candidate);
    candidates.push(candidate);
  });
  return candidates;
}

function architectureCandidates(projectDir) {
  const architecture = readJsonFile(path.join(stateDir(projectDir), "architecture-map.json"), null);
  const changes = architecture?.recentChanges || architecture?.changes || [];
  return changes.slice(0, 12).map((change, index) => {
    const filePath = change.path || change.file || change.ref || "unknown file";
    const candidate = {
      source: "architecture",
      type: "fact",
      title: compact(`Architecture change: ${filePath}`, 150),
      content: compact(`Architecture map recorded ${change.status || "changed"} file ${filePath}. ${change.summary || change.detail || "Use this as a local architecture signal before edits."}`, 1800),
      sourceRefs: [`.project-agent/architecture-map.json#recentChanges[${index}]`],
      files: normalizeRefs([filePath]),
      concepts: ["consolidated", "architecture", "fact"],
      goalId: null,
      agentId: null,
      confidence: confidenceForCandidate("fact", "architecture"),
      importance: 5,
      observedAt: architecture.generatedAt || change.at || null,
      sourceEventIds: []
    };
    candidate.id = candidateId(candidate);
    candidate.hash = candidateHash(candidate);
    return candidate;
  });
}

function allConsolidationCandidates(projectDir, input = {}) {
  const runtime = readJsonFile(path.join(stateDir(projectDir), "runtime.json"), {});
  const events = Array.isArray(runtime.events) ? runtime.events : [];
  const mode = normalizeConsolidationMode(input.mode);
  const goalId = input.goalId || (mode === "goal" ? activeGoalId(projectDir) : "");
  const eventLimit = Math.max(1, Math.min(120, Number(input.eventLimit || input.limit || (mode === "project" ? 80 : 30))));
  let runtimeCandidates = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => !goalId || event.goalId === goalId)
    .filter(({ event }) => dateInConsolidationRange(event.at || event.endedAt || event.startedAt, input))
    .slice(0, eventLimit)
    .map(({ event, index }) => eventCandidate(projectDir, event, index));
  const sourceCandidates = mode === "session" || mode === "goal" || mode === "dryRun" || mode === "manual"
    ? runtimeCandidates
    : [...runtimeCandidates, ...handoffCandidates(projectDir), ...architectureCandidates(projectDir)];
  const unique = [];
  const seen = new Set();
  for (const candidate of sourceCandidates) {
    if (seen.has(candidate.hash)) continue;
    seen.add(candidate.hash);
    unique.push(candidate);
  }
  return unique;
}

function normalizeConsolidationMode(mode) {
  const clean = String(mode || "dryRun");
  if (CONSOLIDATION_MODES.includes(clean)) return clean;
  const error = new Error(`Unsupported consolidation mode: ${mode}`);
  error.status = 400;
  throw error;
}

function existingConsolidationMap(projectDir) {
  const map = new Map();
  for (const record of readAllMemory(projectDir).records) {
    if (record.consolidation?.hash) map.set(record.consolidation.hash, record);
    const sourceKey = `${record.type}:${record.title}:${(record.sourceRefs || []).join("|")}`;
    map.set(sourceKey, record);
  }
  return map;
}

function annotateConsolidationCandidates(projectDir, candidates = [], input = {}) {
  const existing = existingConsolidationMap(projectDir);
  const durableThreshold = Math.max(0.65, Math.min(1, Number(input.minConfidence || 0.65)));
  return candidates.map((candidate) => {
    const sourceKey = `${candidate.type}:${candidate.title}:${(candidate.sourceRefs || []).join("|")}`;
    const duplicate = existing.get(candidate.hash) || existing.get(sourceKey);
    const lowConfidence = Number(candidate.confidence || 0) < durableThreshold;
    return {
      ...candidate,
      status: duplicate ? "duplicate" : lowConfidence ? "low_confidence" : "ready",
      duplicateOf: duplicate?.ref || null,
      durableThreshold
    };
  });
}

function selectedConsolidationCandidates(candidates = [], input = {}) {
  const ids = new Set(normalizeArray(input.candidateId || input.candidateIds).map((id) => String(id)));
  if (!ids.size) return candidates;
  return candidates.filter((candidate) => ids.has(candidate.id));
}

function recordMatchesForget(record, input = {}) {
  const ids = normalizeIdSelector(input);
  if (ids.length && !ids.includes(record.id)) return false;
  if (input.type && normalizeType(record.type) !== normalizeType(input.type)) return false;
  if (input.goalId && record.scope?.goalId !== input.goalId) return false;
  if (input.file && !(record.files || []).some((file) => refMatches(file, input.file))) return false;
  if (input.sourceRef && !(record.sourceRefs || []).some((ref) => refMatches(ref, input.sourceRef))) return false;
  if (input.generatedArtifact) {
    const refs = [...(record.sourceRefs || []), ...(record.files || [])];
    if (!refs.some((ref) => refMatches(ref, input.generatedArtifact))) return false;
  }
  if (input.concept && !(record.concepts || []).some((concept) => String(concept).toLowerCase() === String(input.concept).toLowerCase())) return false;
  if (!dateInRange(record, input)) return false;
  return true;
}

function eventMatchesForget(event = {}, input = {}, affectedRecords = []) {
  const ids = normalizeIdSelector(input);
  const recordIds = affectedRecords.map((record) => record.id);
  const recordRefs = affectedRecords.flatMap((record) => [record.ref, ...(record.sourceRefs || []), ...(record.files || [])]);
  if (ids.length && !ids.includes(event.id)) {
    const refs = [...(event.refs || []), ...(event.artifactRefs || []), ...(event.files || []).map((file) => file.path)];
    if (!refs.some((ref) => ids.some((id) => refMatches(ref, id)))) return false;
  }
  if (input.goalId && event.goalId !== input.goalId) return false;
  if (input.file && !(event.files || []).some((file) => refMatches(file.path, input.file))) return false;
  if (input.sourceRef && !(event.refs || []).some((ref) => refMatches(ref, input.sourceRef))) return false;
  if (input.generatedArtifact) {
    const refs = [...(event.refs || []), ...(event.artifactRefs || []), ...(event.files || []).map((file) => file.path)];
    if (!refs.some((ref) => refMatches(ref, input.generatedArtifact))) return false;
  }
  if (input.concept) {
    const text = `${event.title || ""} ${event.detail || ""} ${event.phase || ""} ${event.workstream || ""}`.toLowerCase();
    if (!text.includes(String(input.concept).toLowerCase())) return false;
  }
  if (!dateInRange({ updatedAt: event.endedAt || event.at || event.startedAt }, input)) return false;
  if (!ids.length && !input.goalId && !input.file && !input.sourceRef && !input.generatedArtifact && !input.concept && !input.type) return false;
  if (recordIds.length) {
    const text = JSON.stringify(event);
    if (recordIds.some((id) => text.includes(id)) || recordRefs.some((ref) => ref && text.includes(ref))) return true;
  }
  return Boolean(input.goalId || input.file || input.sourceRef || input.generatedArtifact || input.concept);
}

function generatedFileMatches(projectDir, file, input = {}, affectedRecords = []) {
  if (file.class !== "derived") return false;
  if (input.generatedArtifact && refMatches(file.ref, input.generatedArtifact)) return true;
  if (!affectedRecords.length) return false;
  if (file.bytes > 512000 || !/\.(json|md|txt)$/i.test(file.ref)) return false;
  let text = "";
  try {
    text = readFileSync(path.join(projectDir, file.ref), "utf8");
  } catch {
    return false;
  }
  return affectedRecords.some((record) =>
    [record.id, record.title, ...(record.sourceRefs || []), ...(record.files || [])]
      .filter(Boolean)
      .some((needle) => text.includes(String(needle)))
  );
}

function staleIndexEntries(projectDir, affectedRecords = []) {
  const entries = [];
  const indexMd = path.join(memoryDir(projectDir), "index.md");
  if (existsSync(indexMd) && affectedRecords.length) {
    entries.push({
      ref: ".project-agent/memory/index.md",
      action: "rebuild",
      reason: "canonical_index_mentions_affected_records"
    });
  }
  const dir = indexesDir(projectDir);
  if (existsSync(dir)) {
    for (const file of walkStateFiles(projectDir).filter((item) => item.relPath.startsWith(".project-agent/indexes/"))) {
      entries.push({
        ref: file.relPath,
        action: "mark_stale",
        reason: "optional_index_cache"
      });
    }
  }
  return entries;
}

function parseDateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function readRetentionPolicy(projectDir) {
  return readJsonFile(path.join(memoryDir(projectDir), "retention.json"), defaultRetentionPolicy()) || defaultRetentionPolicy();
}

function retentionBaseDateMs(record = {}) {
  return parseDateMs(record.validFrom) || parseDateMs(record.createdAt) || parseDateMs(record.updatedAt);
}

function retentionCandidateForRecord(record = {}, policy = defaultRetentionPolicy(), nowMs = Date.now()) {
  const type = normalizeType(record.type);
  const reasons = [];
  let action = "keep";
  let eligible = false;
  const validUntilMs = parseDateMs(record.validUntil);
  if (validUntilMs && validUntilMs <= nowMs) {
    reasons.push("valid_until_expired");
    action = "expire";
    eligible = true;
  }
  const ttlRaw = record.ttlDays ?? policy.ttlDaysByType?.[type];
  const ttlDays = ttlRaw === null || ttlRaw === undefined || ttlRaw === "" ? null : Number(ttlRaw);
  const baseMs = retentionBaseDateMs(record);
  if (Number.isFinite(ttlDays) && ttlDays >= 0 && baseMs && nowMs - baseMs > ttlDays * 86400000) {
    reasons.push("ttl_expired");
    action = "expire";
    eligible = true;
  }
  if (record.isLatest === false || record.supersededBy) {
    reasons.push(record.supersededBy ? "superseded_not_latest" : "not_latest");
    if (action === "keep") action = "flag_superseded";
  }
  const highImportanceFact = type === "fact" && Number(record.importance || 0) >= 8;
  if ((type === "decision" || type === "procedure" || highImportanceFact) && reasons.includes("ttl_expired") && !record.ttlDays && !validUntilMs) {
    action = "protect";
    eligible = false;
    reasons.push("protected_durable_type");
  }
  if (!reasons.length) return null;
  return {
    kind: "memory",
    id: record.id,
    type,
    title: record.title,
    ref: record.ref,
    action,
    eligible,
    reasons: [...new Set(reasons)],
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    validUntil: record.validUntil || null,
    ttlDays,
    importance: record.importance ?? null,
    isLatest: record.isLatest !== false,
    supersededBy: record.supersededBy || null
  };
}

function generatedRetentionCandidates(projectDir, policy = defaultRetentionPolicy()) {
  const limit = Number(policy.limits?.generatedBundleMaxBytes || 0);
  if (!limit || !existsSync(stateDir(projectDir))) return [];
  return walkStateFiles(projectDir)
    .filter((file) => classifyStateFile(file.relPath) === "derived" && file.bytes > limit)
    .map((file) => ({
      kind: "generated",
      ref: file.relPath,
      bytes: file.bytes,
      maxBytes: limit,
      action: "flag_generated_cleanup",
      eligible: false,
      reasons: ["generated_bundle_over_limit"]
    }));
}

export function auditMemoryRetention(projectDir, input = {}) {
  const root = stateDir(projectDir);
  if (!existsSync(root) || !existsSync(path.join(root, "state.json"))) {
    return {
      schemaVersion: "project-agent.memory-retention-audit.v1",
      ok: true,
      status: "not_started",
      projectDir,
      generatedAt: nowIso(),
      summary: "Project has not been started; retention audit will begin after project_start.",
      policy: null,
      candidates: [],
      totals: { records: 0, candidates: 0, actionable: 0, generatedOverLimit: 0, errors: 0 },
      refs: []
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const now = input.now || nowIso();
  const nowMs = parseDateMs(now) || Date.now();
  const policy = readRetentionPolicy(projectDir);
  const all = readAllMemory(projectDir);
  const memoryCandidates = all.records
    .map((record) => retentionCandidateForRecord(record, policy, nowMs))
    .filter(Boolean);
  const generatedCandidates = generatedRetentionCandidates(projectDir, policy);
  const candidates = [...memoryCandidates, ...generatedCandidates]
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || String(a.ref || "").localeCompare(String(b.ref || "")));
  const limit = Math.max(1, Math.min(200, Number(input.limit || 50)));
  const visibleCandidates = candidates.slice(0, limit);
  const totals = {
    records: all.records.length,
    candidates: candidates.length,
    actionable: candidates.filter((candidate) => candidate.eligible && candidate.action === "expire").length,
    expiredRecords: memoryCandidates.filter((candidate) => candidate.action === "expire").length,
    protectedRecords: memoryCandidates.filter((candidate) => candidate.action === "protect").length,
    staleSuperseded: memoryCandidates.filter((candidate) => candidate.action === "flag_superseded").length,
    generatedOverLimit: generatedCandidates.length,
    returned: visibleCandidates.length,
    errors: all.errors.length
  };
  const status = totals.actionable || totals.generatedOverLimit || totals.protectedRecords ? "warn" : all.errors.length ? "warn" : "ok";
  const result = {
    schemaVersion: "project-agent.memory-retention-audit.v1",
    ok: true,
    status,
    projectDir,
    generatedAt: nowIso(),
    now,
    summary: totals.actionable
      ? `Retention audit found ${totals.actionable} expired memory record(s) eligible for sweep.`
      : `Retention audit found ${totals.candidates} candidate(s) and no eligible memory expiry.`,
    dryRun: true,
    policy: {
      ref: ".project-agent/memory/retention.json",
      schemaVersion: policy.schemaVersion || "project-agent.memory-retention.v1",
      ttlDaysByType: policy.ttlDaysByType || {},
      limits: policy.limits || {}
    },
    candidates: visibleCandidates,
    totals,
    errors: all.errors.slice(0, 12),
    refs: [".project-agent/memory/retention.json", ".project-agent/memory/index.md", ...visibleCandidates.map((candidate) => candidate.ref).filter(Boolean)].slice(0, 40)
  };
  if (input.audit === true) {
    const audit = appendAudit(projectDir, "memory_retention_audited", {
      dryRun: true,
      summary: result.summary,
      affected: totals,
      refs: result.refs,
      contentHash: sha256(JSON.stringify({ now, totals, candidates: visibleCandidates }))
    });
    result.auditRef = `.project-agent/memory/audit.jsonl#${audit.id}`;
  }
  return result;
}

function forgetCriteria(input = {}) {
  return {
    ids: normalizeIdSelector(input),
    type: input.type || null,
    file: input.file || null,
    sourceRef: input.sourceRef || null,
    concept: input.concept || null,
    goalId: input.goalId || null,
    generatedArtifact: input.generatedArtifact || null,
    dateFrom: input.dateFrom || null,
    dateTo: input.dateTo || null
  };
}

function validateForgetInput(input = {}) {
  const criteria = forgetCriteria(input);
  const hasSelector = Object.values(criteria).some((value) => (Array.isArray(value) ? value.length : Boolean(value)));
  if (!hasSelector) {
    const error = new Error("At least one forget selector is required: id/ref, type, file, sourceRef, concept, goalId, generatedArtifact, or date range.");
    error.status = 400;
    throw error;
  }
  const mode = input.mode || "delete";
  if (!["delete", "redact", "expire", "supersede"].includes(mode)) {
    const error = new Error(`Unsupported forget mode: ${mode}`);
    error.status = 400;
    throw error;
  }
  if (criteria.type) normalizeType(criteria.type);
  return { criteria, mode };
}

function affectedMemoryPlan(projectDir, input = {}) {
  const { criteria, mode } = validateForgetInput(input);
  const all = readAllMemory(projectDir);
  const canonicalRecords = all.records.filter((record) => recordMatchesForget(record, input));
  const runtime = readJsonFile(path.join(stateDir(projectDir), "runtime.json"), {});
  const runtimeEvents = (runtime.events || [])
    .filter((event) => eventMatchesForget(event, input, canonicalRecords))
    .map((event) => ({
      id: event.id,
      title: event.title,
      phase: event.phase,
      status: event.status,
      refs: event.refs || [],
      files: (event.files || []).map((file) => file.path).filter(Boolean)
    }));
  const inventory = buildMemoryInventory(projectDir);
  const generatedFiles = (inventory.files || [])
    .filter((file) => generatedFileMatches(projectDir, file, input, canonicalRecords))
    .map((file) => ({
      ref: file.ref,
      bytes: file.bytes,
      action: input.dryRun === false ? "refresh_after_mutation" : "would_refresh"
    }));
  const indexEntries = staleIndexEntries(projectDir, canonicalRecords);
  return {
    schemaVersion: "project-agent.memory-forget-plan.v1",
    mode,
    criteria,
    canonicalRecords: canonicalRecords.map((record) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      ref: record.ref,
      sourceRefs: record.sourceRefs || [],
      files: record.files || [],
      action: mode,
      contentHash: sha256(JSON.stringify(record))
    })),
    runtimeEvents,
    generatedFiles,
    indexEntries,
    errors: all.errors
  };
}

function redactRecord(record, input = {}, auditRef = ".project-agent/memory/audit.jsonl") {
  const replacement = compact(input.replacement || "[redacted by project_memory_forget]", 4000);
  const next = {
    ...record,
    title: input.redactTitle === false ? record.title : compact(input.titleReplacement || "[redacted memory]", 160),
    content: replacement,
    updatedAt: nowIso(),
    redaction: {
      status: "redacted",
      rules: [...new Set([...(record.redaction?.rules || []), "project_memory_forget"])]
    }
  };
  if (input.file) next.files = (next.files || []).filter((file) => !refMatches(file, input.file));
  if (input.sourceRef) next.sourceRefs = (next.sourceRefs || []).filter((ref) => !refMatches(ref, input.sourceRef));
  if (input.generatedArtifact) {
    next.files = (next.files || []).filter((file) => !refMatches(file, input.generatedArtifact));
    next.sourceRefs = (next.sourceRefs || []).filter((ref) => !refMatches(ref, input.generatedArtifact));
  }
  if (!next.sourceRefs?.length) next.sourceRefs = [auditRef];
  return next;
}

function mutateRecord(record, mode, input = {}, auditRef = ".project-agent/memory/audit.jsonl") {
  if (mode === "redact") return redactRecord(record, input, auditRef);
  if (mode === "expire") {
    return {
      ...record,
      updatedAt: nowIso(),
      validUntil: input.validUntil || nowIso(),
      isLatest: false
    };
  }
  if (mode === "supersede") {
    return {
      ...record,
      updatedAt: nowIso(),
      validUntil: input.validUntil || nowIso(),
      isLatest: false,
      supersededBy: input.supersededBy || input.replacementId || null
    };
  }
  return record;
}

function mutateRuntime(projectDir, plan, input = {}) {
  const runtimePath = path.join(stateDir(projectDir), "runtime.json");
  const runtime = readJsonFile(runtimePath, null);
  if (!runtime) return { changed: false, removed: 0, redacted: 0 };
  const eventIds = new Set((plan.runtimeEvents || []).map((event) => event.id).filter(Boolean));
  if (!eventIds.size) return { changed: false, removed: 0, redacted: 0 };
  const before = runtime.events || [];
  let removed = 0;
  let redacted = 0;
  const events = before.flatMap((event) => {
    if (!eventIds.has(event.id)) return [event];
    if (plan.mode === "delete") {
      removed += 1;
      return [];
    }
    if (plan.mode === "redact") {
      redacted += 1;
      return [{
        ...event,
        title: input.titleReplacement || "[redacted runtime event]",
        detail: input.replacement || "[redacted by project_memory_forget]",
        refs: (event.refs || []).filter((ref) => !input.sourceRef || !refMatches(ref, input.sourceRef)),
        files: (event.files || []).filter((file) => !input.file || !refMatches(file.path, input.file)),
        data: event.data ? { redacted: true, reason: input.reason || "project_memory_forget" } : undefined
      }];
    }
    return [event];
  });
  atomicWrite(runtimePath, `${JSON.stringify({ ...runtime, updatedAt: nowIso(), events }, null, 2)}\n`);
  return { changed: removed > 0 || redacted > 0, removed, redacted };
}

export function forgetMemory(projectDir, input = {}) {
  const dryRun = input.dryRun !== false;
  const plan = affectedMemoryPlan(projectDir, input);
  const summary = `${dryRun ? "Dry-run" : "Execution"} ${plan.mode} affects ${plan.canonicalRecords.length} canonical record(s), ${plan.runtimeEvents.length} runtime event(s), ${plan.generatedFiles.length} generated file(s), and ${plan.indexEntries.length} index entr${plan.indexEntries.length === 1 ? "y" : "ies"}.`;
  const action = dryRun ? "memory_forget_dry_run" : "memory_forget_executed";
  const audit = {
    id: stableId("aud"),
    schemaVersion: "project-agent.memory-audit.v1",
    action,
    mode: plan.mode,
    dryRun,
    createdAt: nowIso(),
    reason: input.reason || "",
    criteria: plan.criteria,
    affected: {
      canonicalRecords: plan.canonicalRecords.length,
      runtimeEvents: plan.runtimeEvents.length,
      generatedFiles: plan.generatedFiles.length,
      indexEntries: plan.indexEntries.length
    },
    refs: [
      ...plan.canonicalRecords.map((record) => record.ref),
      ...plan.generatedFiles.map((file) => file.ref),
      ...plan.indexEntries.map((entry) => entry.ref)
    ].slice(0, 40),
    contentHashBefore: sha256(JSON.stringify(plan))
  };
  const auditRef = `.project-agent/memory/audit.jsonl#${audit.id}`;

  if (dryRun) {
    appendJsonl(path.join(memoryDir(projectDir), "audit.jsonl"), audit);
    return {
      schemaVersion: "project-agent.memory-forget.v1",
      ok: true,
      dryRun: true,
      mode: plan.mode,
      projectDir,
      summary,
      plan,
      auditRef,
      refresh: {
        required: false,
        targets: plan.generatedFiles.map((file) => file.ref)
      }
    };
  }

  const affectedIds = new Set(plan.canonicalRecords.map((record) => record.id));
  const mutatedTypes = new Set(plan.canonicalRecords.map((record) => normalizeType(record.type)));
  const mutations = [];
  for (const type of mutatedTypes) {
    const filePath = memoryFile(projectDir, type);
    const existing = readJsonlFile(filePath, type).records;
    const nextRecords = existing.flatMap((record) => {
      if (!affectedIds.has(record.id)) return [record];
      if (plan.mode === "delete") return [];
      return [mutateRecord(record, plan.mode, input, auditRef)];
    });
    writeJsonlFile(filePath, nextRecords);
    mutations.push({
      ref: `.project-agent/memory/${MEMORY_FILES[type]}`,
      before: existing.length,
      after: nextRecords.length,
      mode: plan.mode
    });
  }
  const runtimeMutation = mutateRuntime(projectDir, plan, input);
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_forget_executed" });
  const afterPlan = affectedMemoryPlan(projectDir, input);
  const finalAudit = {
    ...audit,
    mutations,
    runtimeMutation,
    contentHashAfter: sha256(JSON.stringify(afterPlan)),
    refresh: {
      targets: refresh.targets,
      optionalIndexes: Object.fromEntries(Object.entries(refresh.optionalIndexes).map(([key, value]) => [key, value.status || null]))
    }
  };
  appendJsonl(path.join(memoryDir(projectDir), "audit.jsonl"), finalAudit);
  return {
    schemaVersion: "project-agent.memory-forget.v1",
    ok: true,
    dryRun: false,
    mode: plan.mode,
    projectDir,
    summary,
    plan,
    mutations,
    runtimeMutation,
    index: refresh.memoryIndex,
    auditRef,
    postCheck: {
      remainingMatches: afterPlan.canonicalRecords.length,
      remainingRuntimeEvents: afterPlan.runtimeEvents.length
    },
    refresh: {
      ...refresh,
      targets: [...new Set([...refresh.targets, ...plan.generatedFiles.map((file) => file.ref)])].filter(Boolean)
    }
  };
}

export function ensureMemoryStore(projectDir, options = {}) {
  const dir = memoryDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const created = [];
  const projectName = path.basename(projectDir);
  for (const file of CANONICAL_FILES) {
    const filePath = path.join(dir, file);
    if (existsSync(filePath) && !options.force) continue;
    if (file.endsWith(".jsonl")) {
      writeFileSync(filePath, "", "utf8");
    } else if (file === "retention.json") {
      writeFileSync(filePath, `${JSON.stringify(defaultRetentionPolicy(), null, 2)}\n`, "utf8");
    } else if (file === "index.md") {
      writeFileSync(filePath, defaultIndexMarkdown(projectName), "utf8");
    }
    created.push(`.project-agent/memory/${file}`);
  }
  if (created.length || options.audit) {
    appendAudit(projectDir, created.length ? "store_initialized" : "store_verified", {
      refs: created.length ? created : [".project-agent/memory"],
      summary: created.length ? `Created ${created.length} canonical memory file(s).` : "Canonical memory store already exists."
    });
  }
  buildIndex(projectDir);
  return {
    ok: true,
    projectDir,
    memoryDir: ".project-agent/memory",
    created,
    verified: CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`)
  };
}

function classifyStateFile(relPath) {
  const fileName = path.posix.basename(relPath);
  if (relPath.startsWith(".project-agent/memory/")) {
    if (fileName === "retention.json" || fileName === "index.md" || fileName.endsWith(".jsonl")) return "source";
    return "unknown";
  }
  if (relPath.startsWith(".project-agent/indexes/")) return "index";
  if (SOURCE_STATE_FILES.has(fileName)) return "source";
  if (VOLATILE_STATE_FILES.has(fileName)) return "volatile";
  if (DERIVED_STATE_FILES.has(fileName)) return "derived";
  return "unknown";
}

function walkStateFiles(projectDir) {
  const root = stateDir(projectDir);
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = projectRelative(projectDir, abs);
      const stat = statSync(abs);
      files.push({ abs, relPath, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
    }
  };
  visit(root);
  return files;
}

function countRecords(abs, relPath) {
  if (relPath.endsWith(".jsonl")) return readJsonlFile(abs).records.length;
  if (relPath.endsWith("runtime.json")) {
    const runtime = readJsonFile(abs, {});
    return Number(runtime.events?.length || 0) + Number(runtime.hookIngresses?.length || 0);
  }
  return null;
}

function riskFlagsForFile(abs, relPath, bytes) {
  const flags = [];
  if (bytes > 100000) flags.push("large_file");
  if (/runtime\.json$/.test(relPath)) flags.push("raw_runtime_events");
  if (/architecture-map\.json$/.test(relPath)) flags.push("architecture_snapshot_text");
  if (/agent-context-bundle\.json$/.test(relPath)) flags.push("generated_duplication");
  if (bytes <= 256000 && /\.(json|jsonl|md|txt)$/i.test(relPath)) {
    try {
      const findings = scanSecretLikeText(readFileSync(abs, "utf8"));
      if (findings.length) flags.push("secret_like_text");
    } catch {}
  }
  return flags;
}

export function buildMemoryInventory(projectDir) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-inventory.v1",
      ok: true,
      status: "not_started",
      projectDir,
      generatedAt: nowIso(),
      summary: "Project has not been started; no .project-agent source memory exists yet.",
      totals: { files: 0, bytes: 0, canonicalRecords: 0, invalidRecords: 0 },
      lifecycle: {
        dogfood: { status: "not_started", expected: 0, present: 0, missing: 0 },
        retention: { status: "not_started", totals: { actionable: 0 } },
        tools: ["project_start"]
      },
      files: [],
      missingExpected: CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`),
      nextStep: { tool: "project_start", command: "Initialize the project, then run project_memory_inventory again." }
    };
  }
  const memDir = memoryDir(projectDir);
  const hasCanonicalMemory = existsSync(memDir);
  const files = walkStateFiles(projectDir).map((file) => {
    const classification = classifyStateFile(file.relPath);
    return {
      ref: file.relPath,
      class: classification,
      bytes: file.bytes,
      records: countRecords(file.abs, file.relPath),
      modifiedAt: file.modifiedAt,
      safeToDelete: classification === "derived" || classification === "index",
      riskFlags: riskFlagsForFile(file.abs, file.relPath, file.bytes)
    };
  });
  const canonicalRefs = CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`);
  const missingExpected = canonicalRefs.filter((ref) => !files.some((file) => file.ref === ref));
  const canonical = readAllMemory(projectDir);
  const memorySearchIndex = inspectMemorySearchIndex(projectDir);
  const memoryEntityIndex = inspectMemoryEntityIndex(projectDir);
  const memoryVectorIndex = inspectMemoryVectorIndex(projectDir);
  const dogfood = dogfoodSeedPlan(projectDir);
  const retention = auditMemoryRetention(projectDir, { limit: 12, audit: false });
  const classTotals = files.reduce((acc, file) => {
    acc[file.class] = (acc[file.class] || 0) + 1;
    return acc;
  }, {});
  const riskyFiles = files.filter((file) => file.riskFlags.length);
  const status = !hasCanonicalMemory ? "no_canonical_memory" : canonical.errors.length ? "warn" : "ok";
  const derivedBytes = files.filter((file) => file.class === "derived").reduce((sum, file) => sum + file.bytes, 0);
  const sourceBytes = files.filter((file) => file.class === "source").reduce((sum, file) => sum + file.bytes, 0);
  return {
    schemaVersion: "project-agent.memory-inventory.v1",
    ok: true,
    status,
    projectDir,
    generatedAt: nowIso(),
    summary: !hasCanonicalMemory
      ? "Project is started, but canonical .project-agent/memory does not exist yet."
      : `Inventory found ${canonical.records.length} canonical memory record(s), ${files.length} state file(s), and ${riskyFiles.length} risk surface(s).`,
    canonical: {
      exists: hasCanonicalMemory,
      dir: ".project-agent/memory",
      records: canonical.records.length,
      invalidRecords: canonical.errors.length,
      errors: canonical.errors.slice(0, 12),
      files: canonicalRefs
    },
    indexes: {
      memorySearch: memorySearchIndex,
      memoryEntities: memoryEntityIndex,
      memoryVectors: memoryVectorIndex
    },
    lifecycle: {
      dogfood,
      retention: {
        status: retention.status,
        summary: retention.summary,
        totals: retention.totals,
        candidates: (retention.candidates || []).slice(0, 8)
      },
      tools: [
        "project_memory_seed_dogfood",
        "project_memory_update",
        "project_memory_supersede",
        "project_memory_retention_audit",
        "project_memory_retention_sweep"
      ]
    },
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      canonicalRecords: canonical.records.length,
      invalidRecords: canonical.errors.length,
      sourceFiles: classTotals.source || 0,
      derivedFiles: classTotals.derived || 0,
      volatileFiles: classTotals.volatile || 0,
      indexFiles: classTotals.index || 0,
      unknownFiles: classTotals.unknown || 0,
      sourceBytes,
      derivedBytes,
      duplicationRatio: sourceBytes ? Number((derivedBytes / sourceBytes).toFixed(2)) : null
    },
    files,
    missingExpected,
    riskyFiles: riskyFiles.slice(0, 20),
    safeToDeleteAndRebuild: files.filter((file) => file.safeToDelete).map((file) => file.ref),
    growth: {
      largestFiles: files.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 8),
      growingSurfaces: files.filter((file) => file.class === "volatile" || file.riskFlags.includes("large_file")).slice(0, 12)
    }
  };
}

export function readAllMemory(projectDir) {
  const dir = memoryDir(projectDir);
  const records = [];
  const errors = [];
  if (!existsSync(dir)) return { records, errors };
  for (const type of MEMORY_TYPES) {
    const filePath = memoryFile(projectDir, type);
    const result = readJsonlFile(filePath, type);
    result.records.forEach((record, index) => {
      records.push({
        ...record,
        type: normalizeType(record.type || type),
        ref: canonicalRef({ ...record, type: record.type || type }),
        line: index + 1
      });
    });
    errors.push(...result.errors.map((error) => ({ ...error, file: `.project-agent/memory/${MEMORY_FILES[type]}` })));
  }
  return { records, errors };
}

function readAuditRows(projectDir) {
  const filePath = path.join(memoryDir(projectDir), "audit.jsonl");
  if (!existsSync(filePath)) return { records: [], errors: [] };
  const raw = readFileSync(filePath, "utf8");
  const records = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      records.push({
        ...record,
        ref: `.project-agent/memory/audit.jsonl#${record.id || `line-${index + 1}`}`,
        line: index + 1
      });
    } catch (error) {
      errors.push({
        line: index + 1,
        ref: `.project-agent/memory/audit.jsonl:${index + 1}`,
        errors: [error.message || String(error)]
      });
    }
  });
  return { records, errors };
}

function auditMatches(entry = {}, input = {}) {
  if (input.action && entry.action !== input.action) return false;
  if (input.mode && entry.mode !== input.mode) return false;
  if (input.memoryId && entry.memoryId !== input.memoryId) return false;
  if (input.type && entry.type !== input.type) return false;
  if (input.dryRun !== undefined && String(entry.dryRun) !== String(input.dryRun)) return false;
  if (input.ref) {
    const refs = [entry.ref, ...(entry.refs || [])].filter(Boolean);
    if (!refs.some((ref) => refMatches(ref, input.ref))) return false;
  }
  if (input.since || input.until) {
    const createdAt = Date.parse(entry.createdAt || "");
    if (!Number.isFinite(createdAt)) return false;
    const since = input.since ? Date.parse(input.since) : null;
    const until = input.until ? Date.parse(input.until) : null;
    if (since && createdAt < since) return false;
    if (until && createdAt > until) return false;
  }
  return true;
}

function auditEntrySummary(entry = {}) {
  if (entry.summary) return compact(entry.summary, 180);
  if (entry.action === "memory_added") return `Added ${entry.type || "memory"} ${entry.memoryId || ""}`.trim();
  if (entry.action === "memory_consolidated") return `Consolidated ${entry.created?.length || 0} memory record(s); skipped ${entry.skipped?.length || 0}.`;
  if (entry.action?.includes("memory_forget")) {
    const affected = entry.affected || {};
    return `${entry.dryRun ? "Dry-run" : "Executed"} ${entry.mode || "forget"} affected ${affected.canonicalRecords || 0} record(s), ${affected.runtimeEvents || 0} runtime event(s), ${affected.generatedFiles || 0} generated file(s).`;
  }
  if (entry.action?.includes("store_")) return entry.action.replace(/_/g, " ");
  return entry.action || "memory audit event";
}

export function queryMemoryAudit(projectDir, input = {}) {
  const root = stateDir(projectDir);
  const auditPath = path.join(memoryDir(projectDir), "audit.jsonl");
  if (!existsSync(root) || !existsSync(path.join(root, "state.json"))) {
    return {
      schemaVersion: "project-agent.memory-audit-query.v1",
      ok: true,
      status: "not_started",
      projectDir,
      generatedAt: nowIso(),
      summary: "Project has not been started; no canonical memory audit exists yet.",
      entries: [],
      totals: { entries: 0, returned: 0, errors: 0 },
      errors: [],
      refs: []
    };
  }
  if (!existsSync(auditPath)) {
    return {
      schemaVersion: "project-agent.memory-audit-query.v1",
      ok: true,
      status: "no_canonical_memory",
      projectDir,
      generatedAt: nowIso(),
      summary: "Canonical memory audit file does not exist yet.",
      entries: [],
      totals: { entries: 0, returned: 0, errors: 0 },
      errors: [],
      refs: [".project-agent/memory/audit.jsonl"]
    };
  }
  const limit = Math.max(1, Math.min(100, Number(input.limit || 20)));
  const audit = readAuditRows(projectDir);
  const filtered = audit.records
    .filter((entry) => auditMatches(entry, input))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const entries = filtered.slice(0, limit).map((entry) => ({
    id: entry.id,
    action: entry.action,
    mode: entry.mode || null,
    dryRun: entry.dryRun ?? null,
    memoryId: entry.memoryId || null,
    type: entry.type || null,
    title: entry.title || null,
    reason: entry.reason || null,
    createdAt: entry.createdAt || null,
    summary: auditEntrySummary(entry),
    affected: entry.affected || null,
    mutations: entry.mutations || [],
    runtimeMutation: entry.runtimeMutation || null,
    created: entry.created || [],
    skipped: entry.skipped || [],
    refs: [entry.ref, ...(entry.refs || [])].filter(Boolean).slice(0, 12),
    ref: entry.ref
  }));
  const actionCounts = filtered.reduce((acc, entry) => {
    acc[entry.action || "unknown"] = (acc[entry.action || "unknown"] || 0) + 1;
    return acc;
  }, {});
  return {
    schemaVersion: "project-agent.memory-audit-query.v1",
    ok: true,
    status: audit.errors.length ? "warn" : "ok",
    projectDir,
    generatedAt: nowIso(),
    summary: `Memory audit has ${audit.records.length} row(s); ${filtered.length} match the current filter.`,
    query: {
      action: input.action || null,
      mode: input.mode || null,
      memoryId: input.memoryId || null,
      type: input.type || null,
      dryRun: input.dryRun ?? null,
      ref: input.ref || null,
      since: input.since || null,
      until: input.until || null,
      limit
    },
    entries,
    totals: {
      entries: audit.records.length,
      matched: filtered.length,
      returned: entries.length,
      errors: audit.errors.length,
      actionCounts
    },
    errors: audit.errors.slice(0, 12),
    refs: [".project-agent/memory/audit.jsonl", ...entries.flatMap((entry) => entry.refs).slice(0, 24)]
  };
}

function writeReplacedMemoryRecord(projectDir, nextRecord = {}) {
  const { ref: _ref, line: _line, ...canonicalRecord } = nextRecord;
  const type = normalizeType(canonicalRecord.type);
  const filePath = memoryFile(projectDir, type);
  const existing = readJsonlFile(filePath, type).records;
  let replaced = false;
  const nextRecords = existing.map((record) => {
    if (record.id !== canonicalRecord.id) return record;
    replaced = true;
    return canonicalRecord;
  });
  if (!replaced) {
    const error = new Error(`Memory record not found for replacement: ${canonicalRecord.id}`);
    error.status = 404;
    throw error;
  }
  writeJsonlFile(filePath, nextRecords);
  return {
    ref: `.project-agent/memory/${MEMORY_FILES[type]}`,
    before: existing.length,
    after: nextRecords.length,
    mode: "replace"
  };
}

function appendMemoryRecord(projectDir, record = {}) {
  const { ref: _ref, line: _line, ...canonicalRecord } = record;
  const type = normalizeType(canonicalRecord.type);
  appendJsonl(memoryFile(projectDir, type), canonicalRecord);
  return {
    ref: `.project-agent/memory/${MEMORY_FILES[type]}`,
    mode: "append"
  };
}

function normalizeMemoryPatch(projectDir, record = {}, input = {}) {
  const patch = {};
  if (input.title !== undefined) {
    const redaction = redactSecretLikeText(input.title);
    patch.title = compact(redaction.text, 160);
    patch.titleRedactionRules = redaction.findings.map((finding) => finding.rule);
  }
  if (input.content !== undefined) {
    const redaction = redactSecretLikeText(input.content);
    patch.content = compact(redaction.text, 4000);
    patch.contentRedactionRules = redaction.findings.map((finding) => finding.rule);
  }
  if (input.concepts !== undefined) patch.concepts = [...new Set((input.concepts || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24);
  if (input.files !== undefined) patch.files = normalizeRefs(input.files || []);
  if (input.sourceRefs !== undefined || input.refs !== undefined) patch.sourceRefs = normalizeRefs(input.sourceRefs || input.refs || []);
  if (input.confidence !== undefined) patch.confidence = Number(input.confidence);
  if (input.importance !== undefined) patch.importance = Number(input.importance);
  if (input.validUntil !== undefined) patch.validUntil = input.validUntil || null;
  if (input.ttlDays !== undefined) patch.ttlDays = input.ttlDays === null || input.ttlDays === "" ? null : Number(input.ttlDays);
  if (input.goalId !== undefined || input.agentId !== undefined || input.scope) {
    patch.scope = {
      project: input.scope?.project || record.scope?.project || path.basename(projectDir),
      goalId: input.scope?.goalId ?? input.goalId ?? record.scope?.goalId ?? null,
      agentId: input.scope?.agentId ?? input.agentId ?? record.scope?.agentId ?? null
    };
  }
  return patch;
}

function changedMemoryFields(before = {}, after = {}) {
  return ["title", "content", "concepts", "files", "sourceRefs", "confidence", "importance", "validUntil", "ttlDays", "scope"]
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

export function seedDogfoodMemory(projectDir, input = {}) {
  const root = stateDir(projectDir);
  if (!existsSync(root) || !existsSync(path.join(root, "state.json"))) {
    return {
      schemaVersion: "project-agent.memory-dogfood-seed.v1",
      ok: true,
      status: "not_started",
      dryRun: input.dryRun === true,
      projectDir,
      generatedAt: nowIso(),
      summary: "Project has not been started; dogfood seed will run after project_start.",
      created: [],
      skipped: [],
      refs: []
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const plan = dogfoodSeedPlan(projectDir);
  const dryRun = input.dryRun === true;
  if (plan.status === "unavailable") {
    return {
      schemaVersion: "project-agent.memory-dogfood-seed.v1",
      ok: true,
      status: "unavailable",
      dryRun,
      projectDir,
      generatedAt: nowIso(),
      summary: plan.summary,
      plan,
      created: [],
      skipped: [],
      refs: plan.refs
    };
  }
  const definitions = dogfoodSeedDefinitions(projectDir);
  const existingIds = new Set(readAllMemory(projectDir).records.map((record) => record.id));
  const missing = definitions.filter((definition) => !existingIds.has(definition.id));
  const skipped = definitions
    .filter((definition) => existingIds.has(definition.id))
    .map((definition) => ({ id: definition.id, type: definition.type, title: definition.title, reason: "already_seeded" }));
  if (dryRun) {
    return {
      schemaVersion: "project-agent.memory-dogfood-seed.v1",
      ok: true,
      status: missing.length ? "dry_run" : "seeded",
      dryRun: true,
      projectDir,
      generatedAt: nowIso(),
      summary: missing.length ? `Dogfood seed would create ${missing.length} memory record(s).` : "Dogfood memory is already seeded.",
      plan,
      created: [],
      wouldCreate: missing.map((definition) => ({ id: definition.id, type: definition.type, title: definition.title })),
      skipped,
      refs: plan.refs
    };
  }
  const created = [];
  for (const definition of missing) {
    const result = addMemory(projectDir, {
      ...definition,
      goalId: input.goalId || definition.goalId,
      agentId: input.agentId || "project_memory_seed_dogfood"
    });
    created.push({
      id: result.record.id,
      type: result.record.type,
      title: result.record.title,
      ref: result.ref
    });
  }
  const audit = appendAudit(projectDir, "memory_dogfood_seeded", {
    dryRun: false,
    summary: `Dogfood seed created ${created.length} memory record(s); skipped ${skipped.length}.`,
    created,
    skipped,
    refs: [...created.map((item) => item.ref), MEMORY_GAP_BENCHMARK_REF],
    contentHash: sha256(JSON.stringify({ created, skipped }))
  });
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_dogfood_seeded" });
  const nextPlan = dogfoodSeedPlan(projectDir);
  return {
    schemaVersion: "project-agent.memory-dogfood-seed.v1",
    ok: true,
    status: created.length ? "ok" : "seeded",
    dryRun: false,
    projectDir,
    generatedAt: nowIso(),
    summary: created.length ? `Created ${created.length} dogfood memory record(s).` : "Dogfood memory is already seeded.",
    plan: nextPlan,
    created,
    skipped,
    auditRef: `.project-agent/memory/audit.jsonl#${audit.id}`,
    refresh,
    refs: [".project-agent/memory/index.md", ".project-agent/memory/audit.jsonl", ...created.map((item) => item.ref), MEMORY_GAP_BENCHMARK_REF]
  };
}

export function updateMemory(projectDir, input = {}) {
  ensureMemoryStore(projectDir, { audit: false });
  const reason = String(input.reason || "").trim();
  if (!reason) {
    const error = new Error("project_memory_update requires a reason.");
    error.status = 400;
    throw error;
  }
  const { record } = findMemoryRecordBySelector(projectDir, input);
  const patch = normalizeMemoryPatch(projectDir, record, input);
  const titleRules = patch.titleRedactionRules || [];
  const contentRules = patch.contentRedactionRules || [];
  delete patch.titleRedactionRules;
  delete patch.contentRedactionRules;
  const nextRecord = {
    ...record,
    ...patch,
    updatedAt: nowIso(),
    version: Number(record.version || 1) + 1,
    redaction: {
      status: [...titleRules, ...contentRules, ...(record.redaction?.rules || [])].length ? "redacted" : record.redaction?.status || "clean",
      rules: [...new Set([...(record.redaction?.rules || []), ...titleRules, ...contentRules])]
    },
    lifecycle: {
      ...(record.lifecycle || {}),
      status: record.lifecycle?.status || (record.isLatest === false ? "superseded" : "active"),
      updatedBy: "project_memory_update",
      reason
    }
  };
  const changedFields = changedMemoryFields(record, nextRecord);
  const validation = validateMemoryRecord(nextRecord, { expectedType: normalizeType(nextRecord.type), strict: true });
  if (!validation.ok) {
    const error = new Error(`Invalid memory update: ${validation.errors.join("; ")}`);
    error.status = 400;
    throw error;
  }
  if (input.dryRun === true) {
    return {
      schemaVersion: "project-agent.memory-update.v1",
      ok: true,
      status: "dry_run",
      dryRun: true,
      projectDir,
      generatedAt: nowIso(),
      summary: changedFields.length ? `Memory update would change ${changedFields.length} field(s).` : "Memory update would not change any fields.",
      ref: record.ref,
      changedFields,
      before: { id: record.id, version: record.version || 1, contentHash: sha256(JSON.stringify(record)) },
      after: { id: nextRecord.id, version: nextRecord.version, contentHash: sha256(JSON.stringify(nextRecord)) }
    };
  }
  const mutation = writeReplacedMemoryRecord(projectDir, nextRecord);
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_updated" });
  const audit = appendAudit(projectDir, "memory_updated", {
    memoryId: nextRecord.id,
    type: nextRecord.type,
    title: nextRecord.title,
    reason,
    refs: [canonicalRef(nextRecord), ...nextRecord.sourceRefs.slice(0, 8)],
    changedFields,
    versionBefore: record.version || 1,
    versionAfter: nextRecord.version,
    contentHashBefore: sha256(JSON.stringify(record)),
    contentHashAfter: sha256(JSON.stringify(nextRecord)),
    refresh: {
      targets: refresh.targets,
      optionalIndexes: Object.fromEntries(Object.entries(refresh.optionalIndexes).map(([key, value]) => [key, value.status || null]))
    }
  });
  return {
    schemaVersion: "project-agent.memory-update.v1",
    ok: true,
    status: changedFields.length ? "ok" : "unchanged",
    dryRun: false,
    projectDir,
    generatedAt: nowIso(),
    summary: changedFields.length ? `Updated ${nextRecord.type} memory ${nextRecord.id}.` : `Memory ${nextRecord.id} already matched the requested update.`,
    record: { ...nextRecord, ref: canonicalRef(nextRecord) },
    ref: canonicalRef(nextRecord),
    changedFields,
    mutation,
    refresh,
    auditRef: `.project-agent/memory/audit.jsonl#${audit.id}`
  };
}

function supersedeReplacementInput(oldRecord = {}, input = {}) {
  const replacement = input.replacement && typeof input.replacement === "object" ? input.replacement : input.newRecord && typeof input.newRecord === "object" ? input.newRecord : {};
  return { ...replacement, ...Object.fromEntries(Object.entries(input).filter(([key]) => !["id", "ids", "ref", "refs", "dryRun", "reason", "role", "detectSimilar", "replacement", "newRecord"].includes(key))) };
}

function buildSupersedeRecord(projectDir, oldRecord = {}, input = {}) {
  const replacement = supersedeReplacementInput(oldRecord, input);
  const type = normalizeType(replacement.type || oldRecord.type);
  const titleRedaction = redactSecretLikeText(replacement.title || oldRecord.title || "Superseded memory");
  const contentRedaction = redactSecretLikeText(replacement.content || "");
  if (!contentRedaction.text.trim()) {
    const error = new Error("project_memory_supersede requires replacement.content.");
    error.status = 400;
    throw error;
  }
  const sourceRefs = normalizeRefs(replacement.sourceRefs || replacement.refs || oldRecord.sourceRefs || []);
  const record = {
    id: replacement.id || stableId("mem"),
    schemaVersion: "project-agent.memory-record.v1",
    type,
    title: compact(titleRedaction.text, 160),
    content: compact(contentRedaction.text, 4000),
    scope: {
      project: replacement.scope?.project || oldRecord.scope?.project || path.basename(projectDir),
      goalId: replacement.scope?.goalId ?? replacement.goalId ?? oldRecord.scope?.goalId ?? null,
      agentId: replacement.scope?.agentId ?? replacement.agentId ?? input.agentId ?? oldRecord.scope?.agentId ?? null
    },
    sourceRefs: sourceRefs.length ? sourceRefs : [oldRecord.ref],
    files: normalizeRefs(replacement.files || oldRecord.files || []),
    concepts: [...new Set([...(oldRecord.concepts || []), ...(replacement.concepts || []), "supersession"].map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24),
    confidence: replacement.confidence === undefined ? oldRecord.confidence ?? 0.8 : Number(replacement.confidence),
    importance: replacement.importance === undefined ? oldRecord.importance ?? 5 : Number(replacement.importance),
    createdAt: replacement.createdAt || nowIso(),
    updatedAt: replacement.updatedAt || nowIso(),
    validFrom: replacement.validFrom || nowIso(),
    validUntil: replacement.validUntil || null,
    ttlDays: replacement.ttlDays ?? oldRecord.ttlDays ?? null,
    version: Number(oldRecord.version || 1) + 1,
    supersedes: [...new Set([oldRecord.id, ...(oldRecord.supersedes || [])])],
    isLatest: true,
    redaction: {
      status: titleRedaction.findings.length || contentRedaction.findings.length ? "redacted" : "clean",
      rules: [...titleRedaction.findings, ...contentRedaction.findings].map((finding) => finding.rule)
    },
    lifecycle: {
      status: "active",
      createdBy: "project_memory_supersede",
      supersedes: oldRecord.id,
      reason: input.reason || ""
    }
  };
  const validation = validateMemoryRecord(record, { expectedType: type, strict: true });
  if (!validation.ok) {
    const error = new Error(`Invalid superseding memory record: ${validation.errors.join("; ")}`);
    error.status = 400;
    throw error;
  }
  return record;
}

function similarSupersedeCandidates(projectDir, replacementRecord = {}, oldRecord = {}, input = {}) {
  if (input.detectSimilar === false) return [];
  const search = searchMemory(projectDir, {
    query: `${replacementRecord.title} ${replacementRecord.content}`,
    type: replacementRecord.type,
    latestOnly: true,
    limit: 8
  });
  return (search.results || [])
    .filter((item) => item.id !== oldRecord.id)
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      ref: item.refs?.[0],
      score: item.score,
      sourceQuality: item.sourceQuality?.status || null
    }));
}

export function supersedeMemory(projectDir, input = {}) {
  ensureMemoryStore(projectDir, { audit: false });
  const reason = String(input.reason || "").trim();
  if (!reason) {
    const error = new Error("project_memory_supersede requires a reason.");
    error.status = 400;
    throw error;
  }
  const dryRun = input.dryRun !== false;
  const { record: oldRecord } = findMemoryRecordBySelector(projectDir, input);
  const newRecord = buildSupersedeRecord(projectDir, oldRecord, input);
  const oldNext = {
    ...oldRecord,
    updatedAt: nowIso(),
    validUntil: input.validUntil || nowIso(),
    isLatest: false,
    supersededBy: newRecord.id,
    lifecycle: {
      ...(oldRecord.lifecycle || {}),
      status: "superseded",
      supersededAt: nowIso(),
      supersededBy: newRecord.id,
      reason
    }
  };
  const similarCandidates = similarSupersedeCandidates(projectDir, newRecord, oldRecord, input);
  const plan = {
    old: {
      id: oldRecord.id,
      type: oldRecord.type,
      title: oldRecord.title,
      ref: oldRecord.ref,
      version: oldRecord.version || 1,
      contentHash: sha256(JSON.stringify(oldRecord))
    },
    replacement: {
      id: newRecord.id,
      type: newRecord.type,
      title: newRecord.title,
      ref: canonicalRef(newRecord),
      version: newRecord.version,
      supersedes: newRecord.supersedes,
      contentHash: sha256(JSON.stringify(newRecord))
    },
    similarCandidates
  };
  if (dryRun) {
    const audit = input.audit === true
      ? appendAudit(projectDir, "memory_supersede_dry_run", {
          dryRun: true,
          reason,
          refs: [oldRecord.ref, canonicalRef(newRecord)],
          contentHash: sha256(JSON.stringify(plan))
        })
      : null;
    return {
      schemaVersion: "project-agent.memory-supersede.v1",
      ok: true,
      status: "dry_run",
      dryRun: true,
      projectDir,
      generatedAt: nowIso(),
      summary: `Supersede would mark ${oldRecord.id} non-latest and create ${newRecord.id}.`,
      plan,
      auditRef: audit ? `.project-agent/memory/audit.jsonl#${audit.id}` : null,
      refs: [oldRecord.ref, canonicalRef(newRecord), ...newRecord.sourceRefs]
    };
  }
  const oldMutation = writeReplacedMemoryRecord(projectDir, oldNext);
  const newMutation = appendMemoryRecord(projectDir, newRecord);
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_superseded" });
  const audit = appendAudit(projectDir, "memory_superseded", {
    dryRun: false,
    reason,
    oldMemoryId: oldRecord.id,
    newMemoryId: newRecord.id,
    type: newRecord.type,
    refs: [oldRecord.ref, canonicalRef(newRecord), ...newRecord.sourceRefs.slice(0, 8)],
    changedFields: ["isLatest", "validUntil", "supersededBy", "version", "supersedes"],
    contentHashBefore: sha256(JSON.stringify(oldRecord)),
    contentHashAfter: sha256(JSON.stringify(newRecord)),
    similarCandidates,
    refresh: {
      targets: refresh.targets,
      optionalIndexes: Object.fromEntries(Object.entries(refresh.optionalIndexes).map(([key, value]) => [key, value.status || null]))
    }
  });
  return {
    schemaVersion: "project-agent.memory-supersede.v1",
    ok: true,
    status: "ok",
    dryRun: false,
    projectDir,
    generatedAt: nowIso(),
    summary: `Superseded ${oldRecord.id} with ${newRecord.id}.`,
    oldRecord: { ...oldNext, ref: oldRecord.ref },
    record: { ...newRecord, ref: canonicalRef(newRecord) },
    ref: canonicalRef(newRecord),
    plan,
    mutations: [oldMutation, newMutation],
    refresh,
    auditRef: `.project-agent/memory/audit.jsonl#${audit.id}`,
    refs: [oldRecord.ref, canonicalRef(newRecord), ".project-agent/memory/audit.jsonl"]
  };
}

export function sweepMemoryRetention(projectDir, input = {}) {
  const dryRun = input.dryRun !== false;
  const audit = auditMemoryRetention(projectDir, { ...input, audit: false });
  if (audit.status === "not_started") {
    return {
      schemaVersion: "project-agent.memory-retention-sweep.v1",
      ok: true,
      status: "not_started",
      dryRun,
      projectDir,
      generatedAt: nowIso(),
      summary: audit.summary,
      audit,
      mutations: [],
      refs: audit.refs || []
    };
  }
  const candidates = (audit.candidates || []).filter((candidate) => candidate.kind === "memory" && candidate.eligible && candidate.action === "expire");
  if (dryRun) {
    const dryAudit = appendAudit(projectDir, "memory_retention_sweep_dry_run", {
      dryRun: true,
      reason: input.reason || "retention dry-run",
      summary: `Retention sweep dry-run found ${candidates.length} expirable record(s).`,
      affected: audit.totals,
      refs: audit.refs || [],
      contentHash: sha256(JSON.stringify({ candidates, totals: audit.totals }))
    });
    return {
      schemaVersion: "project-agent.memory-retention-sweep.v1",
      ok: true,
      status: candidates.length ? "dry_run" : "empty",
      dryRun: true,
      projectDir,
      generatedAt: nowIso(),
      summary: candidates.length ? `Retention sweep would expire ${candidates.length} memory record(s).` : "Retention sweep has no eligible records.",
      audit,
      mutations: [],
      auditRef: `.project-agent/memory/audit.jsonl#${dryAudit.id}`,
      refs: audit.refs || []
    };
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const mutations = [];
  const sweepAt = nowIso();
  for (const type of MEMORY_TYPES) {
    const filePath = memoryFile(projectDir, type);
    const existing = readJsonlFile(filePath, type).records;
    let changed = 0;
    const nextRecords = existing.map((record) => {
      if (!candidateIds.has(record.id)) return record;
      changed += 1;
      return {
        ...record,
        updatedAt: sweepAt,
        validUntil: record.validUntil || sweepAt,
        isLatest: false,
        retention: {
          status: "expired",
          sweptAt: sweepAt,
          reasons: candidates.find((candidate) => candidate.id === record.id)?.reasons || ["retention_sweep"],
          policyRef: ".project-agent/memory/retention.json"
        },
        lifecycle: {
          ...(record.lifecycle || {}),
          status: "expired",
          expiredAt: sweepAt,
          reason: input.reason || "retention sweep"
        }
      };
    });
    if (!changed) continue;
    writeJsonlFile(filePath, nextRecords);
    mutations.push({
      ref: `.project-agent/memory/${MEMORY_FILES[type]}`,
      before: existing.length,
      after: nextRecords.length,
      expired: changed,
      mode: "expire"
    });
  }
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_retention_swept" });
  const afterAudit = auditMemoryRetention(projectDir, { ...input, audit: false });
  const sweepAudit = appendAudit(projectDir, "memory_retention_swept", {
    dryRun: false,
    reason: input.reason || "retention sweep",
    summary: `Retention sweep expired ${candidates.length} memory record(s).`,
    affected: {
      before: audit.totals,
      after: afterAudit.totals,
      expired: candidates.length
    },
    mutations,
    refs: [...candidates.map((candidate) => candidate.ref), ".project-agent/memory/retention.json"].slice(0, 40),
    contentHashBefore: sha256(JSON.stringify(audit)),
    contentHashAfter: sha256(JSON.stringify(afterAudit)),
    refresh: {
      targets: refresh.targets,
      optionalIndexes: Object.fromEntries(Object.entries(refresh.optionalIndexes).map(([key, value]) => [key, value.status || null]))
    }
  });
  return {
    schemaVersion: "project-agent.memory-retention-sweep.v1",
    ok: true,
    status: candidates.length ? "ok" : "empty",
    dryRun: false,
    projectDir,
    generatedAt: nowIso(),
    summary: candidates.length ? `Expired ${candidates.length} memory record(s).` : "Retention sweep had no eligible records.",
    audit,
    afterAudit,
    mutations,
    refresh,
    auditRef: `.project-agent/memory/audit.jsonl#${sweepAudit.id}`,
    refs: [".project-agent/memory/retention.json", ".project-agent/memory/audit.jsonl", ...candidates.map((candidate) => candidate.ref)].slice(0, 40)
  };
}

export function consolidateMemory(projectDir, input = {}) {
  const root = stateDir(projectDir);
  if (!existsSync(root) || !existsSync(path.join(root, "state.json"))) {
    return {
      schemaVersion: "project-agent.memory-consolidation.v1",
      ok: true,
      status: "not_started",
      dryRun: true,
      mode: "dryRun",
      projectDir,
      generatedAt: nowIso(),
      summary: "Project has not been started; no runtime events can be consolidated yet.",
      candidates: [],
      created: [],
      skipped: [],
      totals: { candidates: 0, ready: 0, lowConfidence: 0, duplicates: 0, selected: 0, created: 0, skipped: 0 },
      refs: []
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const mode = normalizeConsolidationMode(input.mode || (input.dryRun === false ? "session" : "dryRun"));
  const dryRun = input.dryRun !== false || mode === "dryRun";
  const rawCandidates = allConsolidationCandidates(projectDir, { ...input, mode });
  const annotated = annotateConsolidationCandidates(projectDir, rawCandidates, input)
    .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || String(b.observedAt || "").localeCompare(String(a.observedAt || "")));
  const limit = Math.max(1, Math.min(100, Number(input.limit || 20)));
  const limited = annotated.slice(0, limit);
  const selected = selectedConsolidationCandidates(limited, input);
  if (!dryRun && mode === "manual" && !normalizeArray(input.candidateId || input.candidateIds).length) {
    const error = new Error("Manual consolidation execution requires candidateId or candidateIds.");
    error.status = 400;
    throw error;
  }
  const created = [];
  const skipped = [];
  if (!dryRun) {
    for (const candidate of selected) {
      if (candidate.status !== "ready") {
        skipped.push({
          candidateId: candidate.id,
          type: candidate.type,
          title: candidate.title,
          status: candidate.status,
          reason: candidate.status === "duplicate" ? "already_consolidated" : "low_confidence_proposal",
          duplicateOf: candidate.duplicateOf || null
        });
        continue;
      }
      const result = addMemory(projectDir, {
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        sourceRefs: candidate.sourceRefs,
        files: candidate.files,
        concepts: candidate.concepts,
        goalId: candidate.goalId,
        agentId: candidate.agentId,
        confidence: candidate.confidence,
        importance: candidate.importance,
        createdAt: candidate.observedAt || undefined,
        consolidation: {
          schemaVersion: "project-agent.memory-consolidation-source.v1",
          candidateId: candidate.id,
          hash: candidate.hash,
          source: candidate.source,
          mode,
          sourceEventIds: candidate.sourceEventIds || []
        }
      });
      created.push({
        candidateId: candidate.id,
        id: result.record.id,
        type: result.record.type,
        title: result.record.title,
        ref: result.ref,
        sourceRefs: result.record.sourceRefs || [],
        auditRef: result.auditRef
      });
    }
    const audit = appendAudit(projectDir, "memory_consolidated", {
      mode,
      dryRun: false,
      summary: `Consolidated ${created.length} durable memory record(s); skipped ${skipped.length}.`,
      created,
      skipped,
      refs: [...created.map((item) => item.ref), ...skipped.map((item) => item.duplicateOf).filter(Boolean)].slice(0, 40)
    });
    const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_consolidated" });
    return {
      schemaVersion: "project-agent.memory-consolidation.v1",
      ok: true,
      status: created.length ? "ok" : skipped.length ? "idempotent" : "empty",
      dryRun: false,
      mode,
      projectDir,
      generatedAt: nowIso(),
      summary: created.length
        ? `Created ${created.length} consolidated memory record(s); skipped ${skipped.length}.`
        : skipped.length
          ? `No new memory records created; ${skipped.length} candidate(s) were skipped.`
          : "No consolidation candidates matched the current selector.",
      candidates: limited,
      created,
      skipped,
      auditRef: `.project-agent/memory/audit.jsonl#${audit.id}`,
      totals: {
        candidates: limited.length,
        ready: limited.filter((item) => item.status === "ready").length,
        lowConfidence: limited.filter((item) => item.status === "low_confidence").length,
        duplicates: limited.filter((item) => item.status === "duplicate").length,
        selected: selected.length,
        created: created.length,
        skipped: skipped.length
      },
      refresh: { ...refresh, required: created.length > 0 },
      refs: [".project-agent/runtime.json", ".project-agent/memory/audit.jsonl", ...created.map((item) => item.ref)]
    };
  }
  return {
    schemaVersion: "project-agent.memory-consolidation.v1",
    ok: true,
    status: "dry_run",
    dryRun: true,
    mode,
    projectDir,
    generatedAt: nowIso(),
    summary: `Found ${limited.length} consolidation candidate(s): ${limited.filter((item) => item.status === "ready").length} ready, ${limited.filter((item) => item.status === "low_confidence").length} low-confidence, ${limited.filter((item) => item.status === "duplicate").length} duplicate.`,
    candidates: limited,
    created: [],
    skipped: selected
      .filter((candidate) => candidate.status !== "ready")
      .map((candidate) => ({
        candidateId: candidate.id,
        type: candidate.type,
        title: candidate.title,
        status: candidate.status,
        reason: candidate.status === "duplicate" ? "already_consolidated" : "low_confidence_proposal",
        duplicateOf: candidate.duplicateOf || null
      })),
    totals: {
      candidates: limited.length,
      ready: limited.filter((item) => item.status === "ready").length,
      lowConfidence: limited.filter((item) => item.status === "low_confidence").length,
      duplicates: limited.filter((item) => item.status === "duplicate").length,
      selected: selected.length,
      created: 0,
      skipped: selected.filter((item) => item.status !== "ready").length
    },
    refs: [".project-agent/runtime.json", ".project-agent/takeover-summary.json", ".project-agent/architecture-map.json"]
  };
}

function harnessQuery(projectDir, input = {}) {
  const state = readJsonFile(path.join(stateDir(projectDir), "state.json"), {});
  const runtime = readJsonFile(path.join(stateDir(projectDir), "runtime.json"), {});
  const takeover = readJsonFile(path.join(stateDir(projectDir), "takeover-summary.json"), {});
  const architecture = readJsonFile(path.join(stateDir(projectDir), "architecture-map.json"), {});
  const goals = Array.isArray(state.goals) ? state.goals : Object.values(state.goals || {});
  const activeGoal = state.activeGoal || goals.find((goal) => goal.id === state.activeGoalId || goal.status === "active") || {};
  const recentEvents = (runtime.events || []).slice(0, 6);
  const changedFiles = (architecture.recentChanges || architecture.changes || []).slice(0, 8).map((file) => file.path || file.file).filter(Boolean);
  return compact([
    input.query,
    activeGoal.objective,
    takeover.activeGoal?.objective,
    takeover.currentState?.title,
    takeover.currentState?.detail,
    takeover.nextStep?.command,
    ...(takeover.risks || []).slice(0, 3).map((risk) => risk.summary || risk.id),
    ...recentEvents.map((event) => `${event.title || ""} ${event.detail || ""}`),
    ...changedFiles
  ].filter(Boolean).join(" "), 1200);
}

function harnessReadPayload(projectDir, result) {
  try {
    const read = readMemory(projectDir, { ref: result.refs?.[0] || result.id });
    return {
      id: read.record.id,
      type: read.record.type,
      title: read.record.title,
      ref: read.ref,
      sourceRefs: read.sourceRefs,
      confidence: read.record.confidence,
      importance: read.record.importance,
      snippet: compact(read.record.content, 280)
    };
  } catch {
    return null;
  }
}

export function buildMemoryHarness(projectDir, input = {}) {
  const root = stateDir(projectDir);
  if (!existsSync(root) || !existsSync(path.join(root, "state.json"))) {
    return {
      schemaVersion: "project-agent.memory-harness.v1",
      ok: true,
      status: "not_started",
      automatic: true,
      projectDir,
      generatedAt: nowIso(),
      summary: "Project is not started; automatic memory routing will begin after project_start.",
      query: "",
      appliedCalls: [],
      autoReads: [],
      consolidation: null,
      nextCalls: [{ tool: "project_start", reason: "Initialize .project-agent before memory routing." }]
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const query = harnessQuery(projectDir, input);
  const limit = Math.max(1, Math.min(20, Number(input.limit || 6)));
  const maxReads = Math.max(0, Math.min(8, Number(input.maxReads ?? 3)));
  const indexStatus = inspectMemorySearchIndex(projectDir);
  const entityIndexStatus = inspectMemoryEntityIndex(projectDir);
  const vectorIndexStatus = inspectMemoryVectorIndex(projectDir);
  const explicitIndex = input.useIndex || input.index || undefined;
  const freshIndexCount = [indexStatus.fresh, entityIndexStatus.fresh, vectorIndexStatus.fresh].filter(Boolean).length;
  const autoIndex = freshIndexCount > 1
    ? "hybrid"
    : indexStatus.fresh
      ? "bm25"
      : entityIndexStatus.fresh
        ? "entity"
        : vectorIndexStatus.fresh
          ? "vector"
          : undefined;
  const useIndex = explicitIndex || autoIndex;
  const search = searchMemory(projectDir, {
    query,
    type: input.type || undefined,
    file: input.file || undefined,
    folder: input.folder || undefined,
    sourceRef: input.sourceRef || undefined,
    concept: input.concept || undefined,
    goalId: input.goalId || undefined,
    fileType: input.fileType || undefined,
    minConfidence: input.minConfidence,
    sourceQuality: input.sourceQuality || undefined,
    latestOnly: input.latestOnly,
    useIndex,
    limit
  });
  const autoReads = (search.results || [])
    .slice(0, maxReads)
    .map((result) => harnessReadPayload(projectDir, result))
    .filter(Boolean);
  const consolidation = input.consolidate === false
    ? null
    : consolidateMemory(projectDir, {
        mode: input.consolidationMode || (input.goalId ? "goal" : "session"),
        dryRun: true,
        goalId: input.goalId || undefined,
        limit: input.candidateLimit || 5,
        eventLimit: input.eventLimit || 20,
        minConfidence: input.minConfidence
      });
  const dogfood = dogfoodSeedPlan(projectDir);
  const retention = auditMemoryRetention(projectDir, { limit: input.retentionLimit || 5, audit: false });
  const appliedCalls = [
    {
      tool: "project_memory_search",
      reason: "Harness built a query from active goal, current cursor, recent runtime events, risks, and changed files.",
      arguments: {
        query,
        limit,
        type: input.type || undefined,
        file: input.file || undefined,
        folder: input.folder || undefined,
        concept: input.concept || undefined,
        sourceQuality: input.sourceQuality || undefined,
        useIndex
      }
    },
    ...autoReads.map((read) => ({
      tool: "project_memory_read",
      reason: "Harness auto-read a top canonical memory result so the agent does not need to manually choose refs.",
      arguments: { ref: read.ref }
    })),
    ...(consolidation ? [{
      tool: "project_memory_consolidate",
      reason: "Harness auto-ran non-mutating consolidation discovery over recent runtime/project signals.",
      arguments: {
        mode: consolidation.mode,
        dryRun: true,
        limit: input.candidateLimit || 5,
        goalId: input.goalId || undefined
      }
    }] : []),
    {
      tool: "project_memory_retention_audit",
      reason: "Harness checked retention policy and lifecycle hygiene without mutating memory.",
      arguments: {
        dryRun: true,
        limit: input.retentionLimit || 5
      }
    }
  ];
  const readyConsolidation = consolidation?.totals?.ready || 0;
  const dogfoodNeedsSeed = dogfood.status === "empty" || dogfood.status === "incomplete";
  const retentionNeedsSweep = Number(retention.totals?.actionable || 0) > 0;
  return {
    schemaVersion: "project-agent.memory-harness.v1",
    ok: true,
    status: autoReads.length || readyConsolidation || dogfoodNeedsSeed || retentionNeedsSweep ? "ready" : "watch",
    automatic: true,
    projectDir,
    generatedAt: nowIso(),
    summary: autoReads.length
      ? `Harness auto-read ${autoReads.length} canonical memory record(s), found ${readyConsolidation} consolidation candidate(s), and checked lifecycle hygiene.`
      : `Harness found ${search.results?.length || 0} search hit(s), ${readyConsolidation} consolidation candidate(s), and ${retention.totals?.actionable || 0} retention action(s).`,
    query,
    appliedCalls,
    search: {
      mode: search.mode,
      returned: search.results?.length || 0,
      optionalIndexes: search.ranking?.optionalIndexes || {},
      results: (search.results || []).slice(0, limit)
    },
    autoReads,
    consolidation: consolidation
      ? {
          status: consolidation.status,
          mode: consolidation.mode,
          totals: consolidation.totals,
          candidates: (consolidation.candidates || []).slice(0, input.candidateLimit || 5)
        }
      : null,
    lifecycle: {
      dogfood,
      retention: {
        status: retention.status,
        summary: retention.summary,
        totals: retention.totals,
        candidates: (retention.candidates || []).slice(0, 5)
      }
    },
    nextCalls: [
      ...(autoReads.length ? [] : [{ tool: "project_memory_search", arguments: { query, limit }, reason: "No auto-read results were available; broaden or refine query." }]),
      ...(dogfoodNeedsSeed ? [{ tool: "project_memory_seed_dogfood", arguments: { dryRun: false }, reason: "Durable dogfood memory is empty or incomplete and can be seeded idempotently from product benchmark docs." }] : []),
      ...(retentionNeedsSweep ? [{ tool: "project_memory_retention_sweep", arguments: { dryRun: false }, reason: "Retention audit found expired canonical memory that can be marked non-latest by policy." }] : []),
      ...(readyConsolidation ? [{ tool: "project_memory_consolidate", arguments: { mode: consolidation.mode, dryRun: false, limit: input.candidateLimit || 5 }, reason: "Optional governed write: promote ready runtime candidates when durable memory update is intended." }] : [])
    ],
    refs: [
      ".project-agent/memory/index.md",
      ".project-agent/runtime.json",
      ".project-agent/memory/retention.json",
      ...autoReads.flatMap((read) => [read.ref, ...(read.sourceRefs || [])]).filter(Boolean)
    ].slice(0, 24)
  };
}

export function addMemory(projectDir, input = {}) {
  ensureMemoryStore(projectDir, { audit: false });
  const type = normalizeType(input.type);
  const sourceRefs = normalizeRefs(input.sourceRefs || input.refs || []);
  const titleRedaction = redactSecretLikeText(input.title || "Untitled memory");
  const contentRedaction = redactSecretLikeText(input.content || "");
  const record = {
    id: input.id || stableId("mem"),
    schemaVersion: "project-agent.memory-record.v1",
    type,
    title: compact(titleRedaction.text, 160),
    content: compact(contentRedaction.text, 4000),
    scope: {
      project: input.scope?.project || path.basename(projectDir),
      goalId: input.scope?.goalId || input.goalId || null,
      agentId: input.scope?.agentId || input.agentId || null
    },
    sourceRefs,
    files: normalizeRefs(input.files || []),
    concepts: [...new Set((input.concepts || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24),
    confidence: input.confidence === undefined ? 0.8 : Number(input.confidence),
    importance: input.importance === undefined ? 5 : Number(input.importance),
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
    validFrom: input.validFrom || input.createdAt || nowIso(),
    validUntil: input.validUntil || null,
    ttlDays: input.ttlDays ?? null,
    version: Number(input.version || 1),
    supersedes: normalizeRefs(input.supersedes || []),
    isLatest: input.isLatest !== false,
    redaction: {
      status: titleRedaction.findings.length || contentRedaction.findings.length ? "redacted" : "clean",
      rules: [...titleRedaction.findings, ...contentRedaction.findings].map((finding) => finding.rule)
    },
    consolidation: input.consolidation && typeof input.consolidation === "object" ? input.consolidation : undefined
  };
  const validation = validateMemoryRecord(record, { expectedType: type, strict: true });
  if (!validation.ok) {
    const error = new Error(`Invalid memory record: ${validation.errors.join("; ")}`);
    error.status = 400;
    throw error;
  }
  appendJsonl(memoryFile(projectDir, type), record);
  const audit = appendAudit(projectDir, "memory_added", {
    memoryId: record.id,
    type,
    title: record.title,
    refs: [canonicalRef(record), ...record.sourceRefs.slice(0, 8)],
    contentHash: sha256(JSON.stringify(record))
  });
  const refresh = refreshMemoryDerivedState(projectDir, { reason: "memory_added" });
  return {
    ok: true,
    record,
    ref: canonicalRef(record),
    auditRef: `.project-agent/memory/audit.jsonl#${audit.id}`,
    refresh
  };
}

export function readMemory(projectDir, input = {}) {
  const target = String(input.ref || input.id || "").trim();
  if (!target) {
    const error = new Error("Memory id or canonical ref is required.");
    error.status = 400;
    throw error;
  }
  const id = target.includes("#") ? target.split("#").pop() : target;
  const all = readAllMemory(projectDir);
  const record = all.records.find((item) => item.id === id);
  if (!record) {
    const error = new Error(`Memory record not found: ${target}`);
    error.status = 404;
    throw error;
  }
  return {
    ok: true,
    record,
    ref: record.ref,
    sourceRefs: record.sourceRefs || [],
    provenance: {
      sourceRefs: record.sourceRefs || [],
      files: record.files || [],
      confidence: record.confidence,
      validFrom: record.validFrom,
      validUntil: record.validUntil
    }
  };
}

export function inspectMemorySearchIndex(projectDir) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-search-index-status.v1",
      ok: true,
      status: "not_started",
      engine: "bm25-lite",
      ref: MEMORY_SEARCH_INDEX_REF,
      exists: false,
      fresh: false,
      sourceRecords: 0,
      currentRecords: 0,
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory search index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  return readMemorySearchIndex(projectDir).public;
}

export function inspectMemoryEntityIndex(projectDir) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-entity-index-status.v1",
      ok: true,
      status: "not_started",
      engine: "entity-graph-lite",
      ref: MEMORY_ENTITY_INDEX_REF,
      exists: false,
      fresh: false,
      sourceRecords: 0,
      currentRecords: 0,
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory entity index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  return readMemoryEntityIndex(projectDir).public;
}

export function inspectMemoryVectorIndex(projectDir) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-vector-index-status.v1",
      ok: true,
      status: "not_started",
      engine: "lexical-vector-lite",
      ref: MEMORY_VECTOR_INDEX_REF,
      exists: false,
      fresh: false,
      sourceRecords: 0,
      currentRecords: 0,
      embeddingProvider: VECTOR_PARAMS.embeddingProvider,
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory vector index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  return readMemoryVectorIndex(projectDir).public;
}

export function rebuildMemorySearchIndex(projectDir, input = {}) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-search-index-rebuild.v1",
      ok: true,
      status: "not_started",
      projectDir,
      index: inspectMemorySearchIndex(projectDir),
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory search index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const all = readAllMemory(projectDir);
  const index = buildMemorySearchIndexPayload(projectDir, all);
  atomicWrite(memorySearchIndexFile(projectDir), `${JSON.stringify(index, null, 2)}\n`);
  const status = inspectMemorySearchIndex(projectDir);
  const audit = input.audit === false
    ? null
    : appendAudit(projectDir, "memory_index_rebuilt", {
        mode: "bm25-lite",
        refs: [MEMORY_SEARCH_INDEX_REF, ...CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`)],
        sourceRecords: index.sourceRecords,
        termCount: index.statistics.termCount,
        canonicalHash: index.canonicalHash
      });
  return {
    schemaVersion: "project-agent.memory-search-index-rebuild.v1",
    ok: true,
    status: status.status,
    projectDir,
    ref: MEMORY_SEARCH_INDEX_REF,
    engine: "bm25-lite",
    index: status,
    auditRef: audit ? `.project-agent/memory/audit.jsonl#${audit.id}` : null
  };
}

export function rebuildMemoryEntityIndex(projectDir, input = {}) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-entity-index-rebuild.v1",
      ok: true,
      status: "not_started",
      projectDir,
      index: inspectMemoryEntityIndex(projectDir),
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory entity index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const all = readAllMemory(projectDir);
  const index = buildMemoryEntityIndexPayload(projectDir, all);
  atomicWrite(memoryEntityIndexFile(projectDir), `${JSON.stringify(index, null, 2)}\n`);
  const status = inspectMemoryEntityIndex(projectDir);
  const audit = input.audit === false
    ? null
    : appendAudit(projectDir, "memory_entity_index_rebuilt", {
        mode: "entity-graph-lite",
        refs: [MEMORY_ENTITY_INDEX_REF, ...CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`)],
        sourceRecords: index.sourceRecords,
        entityCount: index.statistics.entityCount,
        edgeCount: index.statistics.edgeCount,
        canonicalHash: index.canonicalHash
      });
  return {
    schemaVersion: "project-agent.memory-entity-index-rebuild.v1",
    ok: true,
    status: status.status,
    projectDir,
    ref: MEMORY_ENTITY_INDEX_REF,
    engine: "entity-graph-lite",
    index: status,
    auditRef: audit ? `.project-agent/memory/audit.jsonl#${audit.id}` : null
  };
}

export function rebuildMemoryVectorIndex(projectDir, input = {}) {
  const root = stateDir(projectDir);
  const statePath = path.join(root, "state.json");
  if (!existsSync(root) || !existsSync(statePath)) {
    return {
      schemaVersion: "project-agent.memory-vector-index-rebuild.v1",
      ok: true,
      status: "not_started",
      projectDir,
      index: inspectMemoryVectorIndex(projectDir),
      nextStep: { tool: "project_start", command: "Initialize the project, then rebuild the memory vector index." }
    };
  }
  ensureMemoryStore(projectDir, { audit: false });
  const all = readAllMemory(projectDir);
  const index = buildMemoryVectorIndexPayload(projectDir, all);
  atomicWrite(memoryVectorIndexFile(projectDir), `${JSON.stringify(index, null, 2)}\n`);
  const status = inspectMemoryVectorIndex(projectDir);
  const audit = input.audit === false
    ? null
    : appendAudit(projectDir, "memory_vector_index_rebuilt", {
        mode: "lexical-vector-lite",
        refs: [MEMORY_VECTOR_INDEX_REF, ...CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`)],
        sourceRecords: index.sourceRecords,
        dimensions: index.statistics.dimensions,
        embeddingProvider: index.statistics.embeddingProvider,
        canonicalHash: index.canonicalHash
      });
  return {
    schemaVersion: "project-agent.memory-vector-index-rebuild.v1",
    ok: true,
    status: status.status,
    projectDir,
    ref: MEMORY_VECTOR_INDEX_REF,
    engine: "lexical-vector-lite",
    index: status,
    auditRef: audit ? `.project-agent/memory/audit.jsonl#${audit.id}` : null
  };
}

function scoreMemory(record, terms, query, context = {}, filters = {}, quality = sourceQualityForRecord(record)) {
  const exact = query && (record.id === query || record.ref === query || record.sourceRefs?.includes(query));
  const haystack = `${record.title} ${record.content}`.toLowerCase();
  const refs = memoryRecordRefs(record);
  const pathText = refs.join(" ").toLowerCase();
  const conceptText = (record.concepts || []).join(" ").toLowerCase();
  const breakdown = {
    exactRef: exact ? 100 : 0,
    keyword: 0,
    path: 0,
    concept: 0,
    filterMatch: 0,
    currentGoal: 0,
    changedFile: 0,
    statePriority: 0,
    sourceQuality: quality.status === "weak" ? -8 : quality.status === "watch" ? 3 : 8,
    recency: 0,
    importance: Math.max(0, Math.min(10, Number(record.importance || 0))),
    latest: record.isLatest === false ? 0 : 5
  };
  for (const term of terms) {
    if (haystack.includes(term)) breakdown.keyword += record.title?.toLowerCase().includes(term) ? 16 : 8;
    if (pathText.includes(term)) breakdown.path += 6;
    if (conceptText.includes(term)) breakdown.concept += 10;
  }
  if (filters.type && normalizeType(record.type) === filters.type) breakdown.filterMatch += 2;
  if (filters.file && refs.some((ref) => refMatches(ref, filters.file))) breakdown.filterMatch += 5;
  if (filters.folder && refs.some((ref) => refInFolder(ref, filters.folder))) breakdown.filterMatch += 5;
  if (filters.sourceRef && (record.sourceRefs || []).some((ref) => refMatches(ref, filters.sourceRef))) breakdown.filterMatch += 5;
  if (filters.concept && (record.concepts || []).some((concept) => String(concept || "").toLowerCase() === filters.concept)) breakdown.filterMatch += 5;
  if (filters.goalId && record.scope?.goalId === filters.goalId) breakdown.filterMatch += 5;
  if (filters.fileType && refs.some((ref) => refExtension(ref) === filters.fileType)) breakdown.filterMatch += 4;
  if (context.activeGoal && record.scope?.goalId === context.activeGoal) breakdown.currentGoal = 12;
  if (context.changedFiles?.size) {
    const changedHit = refs.some((ref) => {
      const clean = normalizeSearchText(refPath(ref));
      return context.changedFiles.has(clean) || [...context.changedFiles].some((changed) => clean === changed || clean.endsWith(`/${changed}`) || changed.endsWith(`/${clean}`));
    });
    if (changedHit) breakdown.changedFile = 10;
  }
  breakdown.statePriority = refs.reduce((max, ref) => Math.max(max, stateRefPriority(ref)), 0);
  const updated = Date.parse(record.updatedAt || record.createdAt || "");
  if (Number.isFinite(updated)) {
    const ageDays = Math.max(0, (Date.now() - updated) / 86400000);
    breakdown.recency = ageDays < 2 ? 8 : ageDays < 14 ? 5 : ageDays < 60 ? 2 : 0;
  }
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const matched = Boolean(exact || breakdown.keyword || breakdown.path || breakdown.concept);
  return { score, breakdown, matched };
}

export function searchMemory(projectDir, input = {}) {
  const query = compact(input.query || "", 500);
  const terms = tokenize(query);
  const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
  const filters = normalizeSearchFilters(input);
  const context = searchRankingContext(projectDir, filters);
  const all = readAllMemory(projectDir);
  const indexPreference = normalizeIndexPreference(input);
  const digest = canonicalMemoryDigest(projectDir, all);
  const indexState = readMemorySearchIndex(projectDir, { currentDigest: digest });
  const entityIndexState = readMemoryEntityIndex(projectDir, { currentDigest: digest });
  const vectorIndexState = readMemoryVectorIndex(projectDir, { currentDigest: digest });
  const wantsBm25 = indexPreference === "bm25" || indexPreference === "hybrid";
  const wantsEntity = indexPreference === "entity" || indexPreference === "hybrid";
  const wantsVector = indexPreference === "vector" || indexPreference === "hybrid";
  const useBm25 = wantsBm25 && indexState.status === "fresh" && indexState.index;
  const useEntity = wantsEntity && entityIndexState.status === "fresh" && entityIndexState.index;
  const useVector = wantsVector && vectorIndexState.status === "fresh" && vectorIndexState.index;
  const bm25Scores = useBm25 ? scoreBm25(indexState.index, terms) : new Map();
  const entityScores = useEntity ? scoreEntityIndex(entityIndexState.index, query, filters) : { scores: new Map(), matchedEntities: [], expandedEntities: [] };
  const vectorScores = useVector ? scoreVectorIndex(vectorIndexState.index, query, filters) : { scores: new Map(), explanation: { similarity: "cosine", dimensions: VECTOR_PARAMS.dimensions, embeddingProvider: VECTOR_PARAMS.embeddingProvider, featureModel: VECTOR_PARAMS.featureModel } };
  let filteredOut = 0;
  const records = all.records
    .flatMap((record) => {
      const quality = sourceQualityForRecord(record);
      if (!recordMatchesSearchFilters(record, filters, quality)) {
        filteredOut += 1;
        return [];
      }
      const scored = scoreMemory(record, terms, query, context, filters, quality);
      const bm25Raw = Number(bm25Scores.get(record.id) || 0);
      if (bm25Raw > 0) {
        scored.breakdown.bm25 = Math.round(bm25Raw * 12);
        scored.score += scored.breakdown.bm25;
      }
      const entityRaw = Number(entityScores.scores.get(record.id) || 0);
      if (entityRaw > 0) {
        scored.breakdown.entity = Math.round(entityRaw);
        scored.score += scored.breakdown.entity;
      }
      const vectorRaw = Number(vectorScores.scores.get(record.id) || 0);
      if (vectorRaw > 0) {
        scored.breakdown.vector = Math.max(1, Math.round(vectorRaw * 24));
        scored.score += scored.breakdown.vector;
      }
      const matched = !query || scored.matched || bm25Raw > 0 || entityRaw > 0 || vectorRaw > 0;
      if (!matched) return [];
      return {
        id: record.id,
        type: record.type,
        title: record.title,
        score: scored.score,
        scoreBreakdown: scored.breakdown,
        matched: scored.matched,
        sourceQuality: quality,
        refs: [record.ref, ...(record.sourceRefs || []), ...(record.files || [])].slice(0, 8),
        snippet: compact(record.content, 220),
        record
      };
    })
    .sort((a, b) => b.score - a.score || String(b.record.updatedAt || "").localeCompare(String(a.record.updatedAt || "")))
    .slice(0, limit);
  const appliedFilters = visibleSearchFilters(filters);
  return {
    schemaVersion: "project-agent.memory-search.v1",
    ok: true,
    mode: "grep-first-canonical-memory",
    projectDir,
    query,
    type: filters.type || null,
    filters: appliedFilters,
    ranking: {
      deterministic: true,
      optionalIndexes: {
        fts: { status: "not_configured", used: false },
        bm25: {
          status: indexState.public.status,
          used: Boolean(useBm25),
          requested: wantsBm25,
          ref: MEMORY_SEARCH_INDEX_REF,
          generatedAt: indexState.public.generatedAt || null,
          records: indexState.public.sourceRecords || 0,
          currentRecords: indexState.public.currentRecords ?? indexState.public.sourceRecords ?? 0
        },
        entity: {
          status: entityIndexState.public.status,
          used: Boolean(useEntity),
          requested: wantsEntity,
          ref: MEMORY_ENTITY_INDEX_REF,
          generatedAt: entityIndexState.public.generatedAt || null,
          records: entityIndexState.public.sourceRecords || 0,
          currentRecords: entityIndexState.public.currentRecords ?? entityIndexState.public.sourceRecords ?? 0,
          entityCount: entityIndexState.public.statistics?.entityCount || 0,
          edgeCount: entityIndexState.public.statistics?.edgeCount || 0,
          matched: entityScores.matchedEntities,
          expanded: entityScores.expandedEntities
        },
        vector: {
          status: vectorIndexState.public.status,
          used: Boolean(useVector),
          requested: wantsVector,
          ref: MEMORY_VECTOR_INDEX_REF,
          engine: vectorIndexState.public.engine || "lexical-vector-lite",
          generatedAt: vectorIndexState.public.generatedAt || null,
          records: vectorIndexState.public.sourceRecords || 0,
          currentRecords: vectorIndexState.public.currentRecords ?? vectorIndexState.public.sourceRecords ?? 0,
          dimensions: vectorIndexState.public.statistics?.dimensions || vectorIndexState.public.params?.dimensions || VECTOR_PARAMS.dimensions,
          similarity: vectorScores.explanation.similarity,
          embeddingProvider: vectorScores.explanation.embeddingProvider,
          featureModel: vectorScores.explanation.featureModel
        }
      },
      context: {
        activeGoal: context.activeGoal || null,
        changedFiles: context.changedFiles?.size || 0
      },
      weights: ["exactRef", "keyword", "path", "concept", "filterMatch", "currentGoal", "changedFile", "statePriority", "sourceQuality", "bm25", "entity", "vector", "recency", "importance", "latest"]
    },
    results: records.map(({ record, matched, ...item }) => item),
    errors: all.errors.slice(0, 12),
    searched: {
      records: all.records.length,
      filteredRecords: all.records.length - filteredOut,
      filteredOut,
      terms,
      refs: CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`)
    }
  };
}

export function memoryStoreRefs() {
  return CANONICAL_FILES.map((file) => `.project-agent/memory/${file}`);
}
