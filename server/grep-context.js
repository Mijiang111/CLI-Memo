import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".markdown",
  ".txt",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".toml",
  ".yaml",
  ".yml",
  ".css",
  ".html",
  ".sh"
]);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".vite", ".cache"]);
const DEFAULT_QUERY = "takeover current next risk memory architecture handoff grep context";

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function normalizeFilter(value) {
  return String(value || "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizeFileType(value) {
  return String(value || "").trim().replace(/^\./, "").toLowerCase();
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function priorityForPath(relPath) {
  if (relPath === ".project-agent/takeover-summary.json") return 48;
  if (relPath === ".project-agent/context-starter-prompt.md") return 44;
  if (relPath === ".project-agent/takeover-packet.json") return 42;
  if (relPath === ".project-agent/process-trace.json") return 40;
  if (relPath === ".project-agent/architecture-map.json") return 38;
  if (relPath === ".project-agent/agent-context-bundle.json") return 34;
  if (relPath === ".project-agent/continuity-contract.json") return 32;
  if (relPath === ".project-agent/agent-runbook.json") return 30;
  if (relPath === ".project-agent/memory-graph.json") return 28;
  if (relPath === ".project-agent/resume.md" || relPath === ".project-agent/recovery.md") return 26;
  if (relPath === "AGENTS.md") return 24;
  if (relPath === "PROJECT.md") return 22;
  if (relPath.startsWith("docs/")) return 14;
  if (relPath.startsWith(".project-agent/")) return 12;
  return 4;
}

function splitRef(rawRef) {
  const raw = String(rawRef || "").trim();
  const hashIndex = raw.indexOf("#");
  const fileAndLine = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const selector = hashIndex === -1 ? "" : raw.slice(hashIndex + 1);
  const lineMatch = fileAndLine.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (!lineMatch) return { raw, file: fileAndLine, selector, lineStart: null, lineEnd: null };
  return {
    raw,
    file: lineMatch[1],
    selector,
    lineStart: Number(lineMatch[2]),
    lineEnd: Number(lineMatch[3] || lineMatch[2])
  };
}

function resolveProjectRef(projectDir, ref) {
  const relPath = String(ref || "").replace(/^\.\//, "");
  if (!relPath || relPath.includes("..") || path.isAbsolute(relPath)) {
    const error = new Error("Ref must be a project-relative file path.");
    error.status = 400;
    throw error;
  }
  const abs = path.resolve(projectDir, relPath);
  if (!abs.startsWith(path.resolve(projectDir))) {
    const error = new Error("Ref must stay inside the project directory.");
    error.status = 400;
    throw error;
  }
  return { relPath, abs };
}

function contextFilters(options = {}) {
  return {
    file: normalizeFilter(options.file || ""),
    folder: normalizeFilter(options.folder || ""),
    fileType: normalizeFileType(options.fileType || options.ext || options.extension || "")
  };
}

function visibleContextFilters(filters = {}) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value)));
}

function fileMatchesContextFilters(relPath, filters = {}) {
  const clean = normalizeFilter(relPath);
  if (filters.file && clean !== filters.file && !clean.includes(filters.file)) return false;
  if (filters.folder && filters.folder !== "." && clean !== filters.folder && !clean.startsWith(`${filters.folder}/`)) return false;
  if (filters.fileType && path.extname(clean).replace(/^\./, "").toLowerCase() !== filters.fileType) return false;
  return true;
}

export function selectJsonPath(value, selector = "") {
  const clean = String(selector || "").replace(/^#/, "").replace(/^\./, "").trim();
  if (!clean) return value;
  return clean.split(".").filter(Boolean).reduce((current, part) => {
    if (current === undefined || current === null) return undefined;
    const match = part.match(/^([A-Za-z0-9_$-]+)(?:\[(\d+)\])?$/);
    if (!match) return undefined;
    const next = current[match[1]];
    return match[2] === undefined ? next : Array.isArray(next) ? next[Number(match[2])] : undefined;
  }, value);
}

function renderJsonValue(value, maxBytes) {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered.length <= maxBytes) return { value, truncated: false, content: rendered };
  return {
    value: null,
    truncated: true,
    content: `${rendered.slice(0, Math.max(0, maxBytes - 80))}\n... truncated by context-read maxBytes ...`
  };
}

export function readContextRef(projectDir, ref = "", options = {}) {
  const parsed = splitRef(ref);
  const maxBytes = Number(options.maxBytes || 12000);
  const { relPath, abs } = resolveProjectRef(projectDir, parsed.file);
  if (!existsSync(abs)) {
    const error = new Error(`Ref does not exist: ${relPath}`);
    error.status = 404;
    throw error;
  }
  if (!isTextFile(abs)) {
    const error = new Error("Only text, markdown, JSON, JSONL, and source refs are supported.");
    error.status = 400;
    throw error;
  }

  const raw = readFileSync(abs, "utf8");
  const isJson = path.extname(abs).toLowerCase() === ".json";
  if (isJson && parsed.selector) {
    const value = selectJsonPath(JSON.parse(raw), parsed.selector);
    return {
      ref: parsed.raw,
      file: relPath,
      selector: parsed.selector,
      ...renderJsonValue(value, maxBytes)
    };
  }
  if (isJson && !parsed.lineStart && raw.length <= maxBytes) {
    const value = JSON.parse(raw);
    return {
      ref: parsed.raw,
      file: relPath,
      selector: parsed.selector,
      ...renderJsonValue(value, maxBytes)
    };
  }

  const lines = raw.split(/\r?\n/);
  const start = parsed.lineStart ? Math.max(1, parsed.lineStart) : 1;
  const end = parsed.lineEnd ? Math.min(lines.length, Math.max(start, parsed.lineEnd)) : lines.length;
  const selected = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
  const truncated = selected.length > maxBytes;
  return {
    ref: parsed.raw,
    file: relPath,
    selector: parsed.selector,
    lineStart: start,
    lineEnd: end,
    lines: end - start + 1,
    value: null,
    content: truncated ? `${selected.slice(0, Math.max(0, maxBytes - 80))}\n... truncated by context-read maxBytes ...` : selected,
    truncated
  };
}

function tokenize(query) {
  return [...new Set(String(query || "").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [])]
    .filter((term) => term.length > 1)
    .slice(0, 16);
}

function walkFiles(projectDir, options = {}) {
  const maxFiles = Number(options.maxFiles || 500);
  const maxFileBytes = Number(options.maxFileBytes || 1024 * 1024);
  const filters = contextFilters(options);
  const files = [];
  const visit = (dir, relDir = "") => {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      const pa = priorityForPath(path.posix.join(relDir, a.name));
      const pb = priorityForPath(path.posix.join(relDir, b.name));
      return pb - pa || a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const relPath = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile() || !isTextFile(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes || !fileMatchesContextFilters(relPath, filters)) continue;
      files.push({ relPath, abs, bytes: stat.size, mtimeMs: stat.mtimeMs, priority: priorityForPath(relPath) });
    }
  };
  visit(projectDir);
  return files;
}

function scoreLine({ line, relPath, terms, phrase, priority }) {
  const text = line.toLowerCase();
  const pathText = relPath.toLowerCase();
  let score = priority;
  if (phrase && text.includes(phrase)) score += 36;
  for (const term of terms) {
    if (text.includes(term)) score += 10;
    if (pathText.includes(term)) score += 6;
  }
  if (/\b(current|next|risk|handoff|takeover|memory|architecture|grep|context|budget|codex)\b/i.test(line)) score += 4;
  return score;
}

function snippet(lines, lineIndex, radius = 1) {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length, lineIndex + radius + 1);
  return {
    lineStart: start + 1,
    lineEnd: end,
    content: lines.slice(start, end).map((line, index) => `${start + index + 1}: ${compact(line, 260)}`).join("\n")
  };
}

export function defaultContextQuery(projectDir) {
  try {
    const summary = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "takeover-summary.json"), "utf8"));
    return compact([
      summary.activeGoal?.objective,
      summary.currentState?.title,
      summary.currentState?.detail,
      summary.nextStep?.expected?.title,
      summary.risks?.[0]?.summary
    ].filter(Boolean).join(" "), 320) || DEFAULT_QUERY;
  } catch {
    return DEFAULT_QUERY;
  }
}

export function searchContext(projectDir, options = {}) {
  const query = compact(options.query || defaultContextQuery(projectDir), 500);
  const terms = tokenize(query);
  const phrase = String(query || "").toLowerCase().trim();
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  const filters = contextFilters(options);
  const files = walkFiles(projectDir, options);
  const rawMatches = [];
  let scannedBytes = 0;

  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    scannedBytes += file.bytes;
    const lines = text.split(/\r?\n/);
    const local = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const score = scoreLine({ line, relPath: file.relPath, terms, phrase, priority: file.priority });
      const matched = terms.some((term) => line.toLowerCase().includes(term) || file.relPath.toLowerCase().includes(term)) || (phrase && line.toLowerCase().includes(phrase));
      if (!matched && score <= file.priority + 4) continue;
      const hit = snippet(lines, i);
      local.push({
        file: file.relPath,
        ref: `${file.relPath}:${hit.lineStart}-${hit.lineEnd}`,
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        score,
        snippet: hit.content,
        reason: compact(line, 140),
        bytes: file.bytes
      });
      local.sort((a, b) => b.score - a.score);
      if (local.length > 4) local.length = 4;
    }
    if (!local.length && terms.some((term) => file.relPath.toLowerCase().includes(term))) {
      const hit = snippet(lines, 0);
      local.push({
        file: file.relPath,
        ref: `${file.relPath}:${hit.lineStart}-${hit.lineEnd}`,
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        score: file.priority + 8,
        snippet: hit.content,
        reason: "path match",
        bytes: file.bytes
      });
    }
    rawMatches.push(...local);
  }

  rawMatches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const perFile = new Map();
  const results = [];
  for (const match of rawMatches) {
    const count = perFile.get(match.file) || 0;
    if (count >= 2) continue;
    perFile.set(match.file, count + 1);
    results.push({ rank: results.length + 1, ...match });
    if (results.length >= limit) break;
  }

  return {
    schemaVersion: "project-agent.grep-context.v1",
    generatedAt: nowIso(),
    mode: "grep-first",
    query,
    terms,
    filters: visibleContextFilters(filters),
    budget: {
      llmCalls: 0,
      scannedFiles: files.length,
      scannedBytes,
      returnedResults: results.length
    },
    results,
    readHint: results[0] ? `Use context-read or grep-context --read ${JSON.stringify(results[0].ref)} for detail.` : "No grep hits; read takeover-summary.json first."
  };
}
