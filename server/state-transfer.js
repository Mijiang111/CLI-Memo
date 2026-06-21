import { createHash } from "node:crypto";
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
import { buildStateManifest, writeStateManifest, verifyStateManifest } from "./runtime-state.js";

const STATE_EXPORT_SCHEMA = "project-agent.state-export.v1";
const STATE_IMPORT_SCHEMA = "project-agent.state-import-plan.v1";
const MAX_IMPORT_FILES = 250;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

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

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateDir(projectDir) {
  return path.join(projectDir, ".project-agent");
}

function projectRelative(projectDir, absPath) {
  return path.relative(projectDir, absPath).split(path.sep).join("/");
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

function isTransferInternalPath(relPath) {
  return relPath.startsWith(".project-agent/import-backups/") || relPath.startsWith(".project-agent/state-transfer/");
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
      if (isTransferInternalPath(relPath)) continue;
      const stats = statSync(abs);
      files.push({ abs, path: relPath, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() });
    }
  };
  visit(root);
  return files;
}

function readUtf8File(abs) {
  return readFileSync(abs, "utf8");
}

function schemaVersionForContent(relPath, content) {
  if (!relPath.endsWith(".json")) return null;
  try {
    return JSON.parse(content)?.schemaVersion || null;
  } catch {
    return null;
  }
}

function selectedClasses(mode) {
  if (mode === "minimal") return new Set(["source"]);
  if (mode === "full") return new Set(["source", "derived", "volatile", "index", "unknown"]);
  return new Set(["source", "derived"]);
}

function summarizeClasses(files = []) {
  return files.reduce((acc, file) => {
    acc[file.class] = (acc[file.class] || 0) + 1;
    return acc;
  }, {});
}

function exportDigest(files = []) {
  return sha256(JSON.stringify(files.map((file) => ({
    path: file.path,
    class: file.class,
    bytes: file.bytes,
    sha256: file.sha256
  }))));
}

export function buildStateExport(projectDir, input = {}) {
  const mode = ["minimal", "portable", "full"].includes(input.mode) ? input.mode : "portable";
  const includeContents = input.includeContents !== false && input.contents !== false;
  const root = stateDir(projectDir);
  if (!existsSync(root)) {
    return {
      schemaVersion: STATE_EXPORT_SCHEMA,
      status: "not_started",
      mode,
      generatedAt: nowIso(),
      project: { name: path.basename(projectDir), projectDir },
      summary: "Project has not been started; no .project-agent state is available to export.",
      totals: { files: 0, bytes: 0 },
      files: [],
      nextAction: "Initialize project state before exporting."
    };
  }

  const classes = selectedClasses(mode);
  const allFiles = walkStateFiles(projectDir).map((file) => {
    const content = readUtf8File(file.abs);
    const classification = classifyStateFile(file.path);
    return {
      path: file.path,
      class: classification,
      bytes: Buffer.byteLength(content, "utf8"),
      modifiedAt: file.modifiedAt,
      sha256: sha256(content),
      schemaVersion: schemaVersionForContent(file.path, content),
      encoding: "utf8",
      ...(includeContents ? { content } : {})
    };
  });
  const files = allFiles.filter((file) => classes.has(file.class));
  const excluded = allFiles.filter((file) => !classes.has(file.class));
  return {
    schemaVersion: STATE_EXPORT_SCHEMA,
    status: "ok",
    mode,
    generatedAt: nowIso(),
    project: {
      name: path.basename(projectDir),
      projectDir,
      stateDir: ".project-agent"
    },
    policy: {
      includeContents,
      includedClasses: [...classes],
      excludedClasses: [...new Set(excluded.map((file) => file.class))],
      backupPathsExcluded: true
    },
    summary: `${mode} export contains ${files.length} .project-agent file(s) and ${files.reduce((sum, file) => sum + file.bytes, 0)} byte(s).`,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      allFiles: allFiles.length,
      excludedFiles: excluded.length,
      classes: summarizeClasses(files)
    },
    digest: exportDigest(files),
    files,
    excluded: excluded.map((file) => ({ path: file.path, class: file.class, bytes: file.bytes, sha256: file.sha256 })).slice(0, 40),
    restore: {
      endpoint: "POST /api/state/import",
      dryRunDefault: true,
      executeRequiresOverwrite: true
    }
  };
}

function normalizeStatePath(relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.includes("\0")) throw new Error("path is empty or invalid");
  if (!clean.startsWith(".project-agent/")) throw new Error("path must stay under .project-agent/");
  if (path.posix.isAbsolute(clean) || clean.split("/").includes("..")) throw new Error("path traversal is not allowed");
  if (clean.endsWith("/")) throw new Error("path must reference a file");
  if (isTransferInternalPath(clean)) throw new Error("state transfer internal paths cannot be imported");
  return clean;
}

function normalizeBundle(input = {}) {
  const raw = input.bundle ?? input;
  if (typeof raw === "string") return JSON.parse(raw);
  return raw || {};
}

function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function backupExistingFile(projectDir, relPath, backupStamp) {
  const abs = path.join(projectDir, relPath);
  if (!existsSync(abs)) return null;
  const backupRel = `.project-agent/import-backups/${backupStamp}/${relPath.replace(/^\.project-agent\//, "")}`;
  const backupAbs = path.join(projectDir, backupRel);
  mkdirSync(path.dirname(backupAbs), { recursive: true });
  writeFileSync(backupAbs, readFileSync(abs));
  return backupRel;
}

function validationError(message, details = {}) {
  const error = new Error(message);
  error.status = 400;
  error.details = details;
  return error;
}

export function importStateExportBundle(projectDir, input = {}) {
  const dryRun = input.dryRun !== false;
  const overwrite = input.overwrite === true;
  const bundle = normalizeBundle(input);
  const files = Array.isArray(bundle.files) ? bundle.files : [];
  const generatedAt = nowIso();
  const actions = [];
  const rejected = [];
  const warnings = [];

  if (bundle.schemaVersion !== STATE_EXPORT_SCHEMA) {
    throw validationError("Unsupported state export bundle schema.", { schemaVersion: bundle.schemaVersion || null });
  }
  if (files.length > MAX_IMPORT_FILES) {
    throw validationError(`Import bundle has too many files (${files.length}/${MAX_IMPORT_FILES}).`);
  }

  let totalBytes = 0;
  const seen = new Set();
  for (const file of files) {
    let relPath = "";
    try {
      relPath = normalizeStatePath(file.path);
    } catch (error) {
      rejected.push({ path: file.path || "", reason: error.message });
      continue;
    }
    if (seen.has(relPath)) {
      rejected.push({ path: relPath, reason: "duplicate path in bundle" });
      continue;
    }
    seen.add(relPath);
    if (file.encoding && file.encoding !== "utf8") {
      rejected.push({ path: relPath, reason: `unsupported encoding ${file.encoding}` });
      continue;
    }
    if (typeof file.content !== "string") {
      rejected.push({ path: relPath, reason: "missing utf8 content" });
      continue;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_IMPORT_FILE_BYTES) {
      rejected.push({ path: relPath, reason: `file exceeds ${MAX_IMPORT_FILE_BYTES} byte limit` });
      continue;
    }
    const expectedHash = file.sha256 || "";
    const actualHash = sha256(file.content);
    if (expectedHash && expectedHash !== actualHash) {
      rejected.push({ path: relPath, reason: "content hash does not match bundle metadata", expectedHash, actualHash });
      continue;
    }
    const abs = path.join(projectDir, relPath);
    const current = existsSync(abs) ? readUtf8File(abs) : null;
    const currentHash = current === null ? null : sha256(current);
    const classification = classifyStateFile(relPath);
    const action = current === null ? "create" : currentHash === actualHash ? "identical" : overwrite ? "replace" : "would_replace";
    if (action === "would_replace") {
      warnings.push({ path: relPath, reason: "existing file differs; execute import with overwrite=true to replace it" });
    }
    actions.push({
      path: relPath,
      class: classification,
      action,
      bytes,
      currentHash,
      bundleHash: actualHash,
      schemaVersion: file.schemaVersion || schemaVersionForContent(relPath, file.content)
    });
  }

  if (totalBytes > MAX_IMPORT_BYTES) {
    throw validationError(`Import bundle exceeds ${MAX_IMPORT_BYTES} byte limit.`, { totalBytes });
  }

  const blocked = rejected.length || (!dryRun && actions.some((action) => action.action === "would_replace"));
  const backupStamp = generatedAt.replace(/[:.]/g, "-");
  const written = [];
  const backups = [];

  if (!dryRun && !blocked) {
    for (const action of actions) {
      if (!["create", "replace"].includes(action.action)) continue;
      const source = files.find((file) => normalizeStatePath(file.path) === action.path);
      const backup = action.action === "replace" ? backupExistingFile(projectDir, action.path, backupStamp) : null;
      if (backup) backups.push({ path: action.path, backup });
      atomicWrite(path.join(projectDir, action.path), source.content);
      written.push(action.path);
    }
    if (existsSync(stateDir(projectDir))) {
      const stateManifest = writeStateManifest(projectDir, buildStateManifest(projectDir));
      const verification = verifyStateManifest(projectDir, stateManifest);
      return {
        schemaVersion: STATE_IMPORT_SCHEMA,
        status: "ok",
        dryRun,
        overwrite,
        importedAt: generatedAt,
        bundle: {
          mode: bundle.mode || "unknown",
          generatedAt: bundle.generatedAt || null,
          digest: bundle.digest || null,
          files: files.length
        },
        summary: `Imported ${written.length} file(s); ${actions.filter((action) => action.action === "identical").length} unchanged.`,
        totals: summarizeImportPlan(actions, rejected),
        actions,
        rejected,
        warnings,
        written,
        backups,
        stateManifest: {
          status: verification.status,
          ok: verification.ok,
          aggregateHash: verification.aggregateHash || stateManifest.aggregateHash || null,
          fileCount: stateManifest.fileCount || stateManifest.files?.length || 0
        }
      };
    }
  }

  return {
    schemaVersion: STATE_IMPORT_SCHEMA,
    status: blocked ? "blocked" : "dry_run",
    dryRun,
    overwrite,
    importedAt: dryRun ? null : generatedAt,
    checkedAt: generatedAt,
    bundle: {
      mode: bundle.mode || "unknown",
      generatedAt: bundle.generatedAt || null,
      digest: bundle.digest || null,
      files: files.length
    },
    summary: blocked
      ? `Import is blocked by ${rejected.length} rejected file(s) or overwrite requirements.`
      : `Dry-run found ${actions.filter((action) => action.action === "create").length} create, ${actions.filter((action) => action.action === "replace" || action.action === "would_replace").length} replace, and ${actions.filter((action) => action.action === "identical").length} identical file(s).`,
    totals: summarizeImportPlan(actions, rejected),
    actions,
    rejected,
    warnings,
    written,
    backups,
    nextAction: blocked
      ? "Review rejected paths and use overwrite=true only after the dry-run plan is acceptable."
      : "Run again with dryRun=false and overwrite=true to apply this state bundle."
  };
}

function summarizeImportPlan(actions = [], rejected = []) {
  return {
    files: actions.length,
    rejected: rejected.length,
    bytes: actions.reduce((sum, action) => sum + action.bytes, 0),
    create: actions.filter((action) => action.action === "create").length,
    replace: actions.filter((action) => action.action === "replace" || action.action === "would_replace").length,
    identical: actions.filter((action) => action.action === "identical").length,
    classes: summarizeClasses(actions)
  };
}
