import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readRuntime, writeRuntime } from "./runtime-state.js";

const IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".vite",
  ".cache",
  "__pycache__",
  ".venv",
  "venv"
]);

const IMPORTANT_FILES = new Set([
  "PROJECT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "vite.config.js",
  "vite.config.ts"
]);

const INTERNAL_RUNTIME_FILES = new Set([
  ".project-agent/runtime.json",
  ".project-agent/takeover-summary.json",
  ".project-agent/agent-context-bundle.json",
  ".project-agent/context-starter-prompt.md",
  ".project-agent/context-takeover-drill.json",
  ".project-agent/codex-takeover-smoke.json",
  ".project-agent/memory-graph.json",
  ".project-agent/process-trace.json",
  ".project-agent/development-trail.json",
  ".project-agent/architecture-map.json",
  ".project-agent/takeover-packet.json",
  ".project-agent/continuity-audit.json",
  ".project-agent/takeover-acceptance-audit.json",
  ".project-agent/governance-spec.json",
  ".project-agent/state-manifest.json",
  ".project-agent/agent-runbook.json",
  ".project-agent/continuity-contract.json",
  ".project-agent/continuity.json",
  ".project-agent/recovery.md",
  ".project-agent/resume.md",
  ".project-agent/next-agent-prompt.md"
]);

function isInternalRuntimePath(relPath) {
  return relPath === ".project-agent" || String(relPath || "").startsWith(".project-agent/");
}

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".rb", ".php", ".css", ".scss", ".html"]);
const CODE_GRAPH_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
const TEST_PATTERNS = [/\.test\./, /\.spec\./, /(^|\/)tests?\//, /(^|\/)__tests__\//];
const DIFFABLE_KINDS = new Set(["kernel", "docs", "code", "test", "config"]);
const MAX_TEXT_BYTES = 220_000;
const MAX_EXACT_DIFF_LINES = 900;
const MAX_CODE_GRAPH_NODES = 220;
const MAX_CODE_GRAPH_EDGES = 420;
const IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const IMPORT_BINDING_RE = /\bimport\s+(?:type\s+)?([^'";]+?)\s+from\s+["']([^"']+)["']/g;
const EXPORT_LIST_RE = /\bexport\s*\{([^}]+)\}/g;
const SYMBOL_NAME = "[A-Za-z_$][\\w$]*";
const CALL_RE = new RegExp(`\\b(${SYMBOL_NAME})\\s*\\(`, "g");
const JS_CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "class",
  "return",
  "typeof",
  "import",
  "require",
  "new",
  "super"
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function classifyFile(relPath) {
  const base = path.basename(relPath);
  const ext = path.extname(relPath).toLowerCase();
  if (IMPORTANT_FILES.has(base)) return "kernel";
  if (relPath.startsWith(".project-agent/")) return "state";
  if (TEST_PATTERNS.some((pattern) => pattern.test(relPath))) return "test";
  if (relPath.startsWith("docs/") || DOC_EXTENSIONS.has(ext)) return "docs";
  if (SOURCE_EXTENSIONS.has(ext)) return "code";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return "config";
  return "asset";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function splitLines(text) {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function readFileFacts(absPath, file) {
  let buffer;
  try {
    buffer = readFileSync(absPath);
  } catch {
    return file;
  }
  const hash = sha256(buffer);
  const diffable = DIFFABLE_KINDS.has(file.kind) && buffer.length <= MAX_TEXT_BYTES && !buffer.includes(0);
  if (!diffable) {
    return { ...file, hash, diffable: false };
  }
  const text = buffer.toString("utf8");
  const lines = splitLines(text);
  return {
    ...file,
    hash,
    diffable: true,
    lineCount: lines.length,
    text
  };
}

function changeStatus(relPath, file, previousMap) {
  const previous = previousMap.get(relPath);
  if (!previous) return "added";
  if (previous.hash && file.hash && previous.hash !== file.hash) return "modified";
  if (previous.mtimeMs !== file.mtimeMs || previous.size !== file.size) return "modified";
  return "unchanged";
}

function lcsLength(a, b) {
  const width = b.length + 1;
  let prev = new Array(width).fill(0);
  let next = new Array(width).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], next[j - 1]);
    }
    [prev, next] = [next, prev.fill(0)];
  }
  return prev[b.length];
}

function diffStats(status, previous, current) {
  const previousLineCount = previous?.lineCount || 0;
  const lineCount = current?.lineCount || 0;
  if (status === "added") {
    return { additions: lineCount, deletions: 0, previousLineCount, lineCount, summary: `+${lineCount}/-0` };
  }
  if (status === "deleted") {
    return { additions: 0, deletions: previousLineCount, previousLineCount, lineCount: 0, summary: `+0/-${previousLineCount}` };
  }
  if (status !== "modified") {
    return { additions: 0, deletions: 0, previousLineCount, lineCount, summary: "+0/-0" };
  }
  if (previous?.text && current?.text) {
    const a = splitLines(previous.text);
    const b = splitLines(current.text);
    if (a.length <= MAX_EXACT_DIFF_LINES && b.length <= MAX_EXACT_DIFF_LINES) {
      const lcs = lcsLength(a, b);
      const additions = Math.max(0, b.length - lcs);
      const deletions = Math.max(0, a.length - lcs);
      return { additions, deletions, previousLineCount: a.length, lineCount: b.length, summary: `+${additions}/-${deletions}` };
    }
  }
  const delta = lineCount - previousLineCount;
  const additions = Math.max(0, delta);
  const deletions = Math.max(0, -delta);
  return { additions, deletions, previousLineCount, lineCount, summary: `+${additions}/-${deletions}` };
}

function scanDir(root, rel = "", depth = 0, files = [], maxFiles = 600) {
  if (files.length >= maxFiles) return [];
  const abs = path.join(root, rel);
  let entries = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }

  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".project-agent") {
      if (entry.name !== ".project-agent") continue;
    }
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    const childRel = toPosix(path.join(rel, entry.name));
    if (isInternalRuntimePath(childRel) || INTERNAL_RUNTIME_FILES.has(childRel)) continue;
    const childAbs = path.join(root, childRel);
    let stats;
    try {
      stats = statSync(childAbs);
    } catch {
      continue;
    }
    if (entry.isDirectory()) {
      const node = {
        type: "dir",
        name: entry.name,
        path: childRel,
        depth,
        children: depth < 5 ? scanDir(root, childRel, depth + 1, files, maxFiles) : []
      };
      node.fileCount = node.children.reduce((sum, child) => sum + (child.type === "file" ? 1 : child.fileCount || 0), 0);
      children.push(node);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = readFileFacts(childAbs, {
      type: "file",
      name: entry.name,
      path: childRel,
      depth,
      ext: path.extname(entry.name).toLowerCase(),
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
      modifiedAt: stats.mtime.toISOString(),
      kind: classifyFile(childRel)
    });
    files.push(file);
    children.push(file);
    if (files.length >= maxFiles) break;
  }
  return children;
}

function flattenFiles(snapshot) {
  return new Map((snapshot?.files || []).map((file) => [file.path, file]));
}

function firstPackageSegment(specifier) {
  const parts = String(specifier || "").split("/").filter(Boolean);
  if (!parts.length) return specifier || "";
  if (parts[0].startsWith("@") && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function extractImportSpecifiers(text = "") {
  const specs = [];
  const patterns = [
    ["import", IMPORT_RE],
    ["export", EXPORT_FROM_RE],
    ["require", REQUIRE_RE],
    ["dynamic", DYNAMIC_IMPORT_RE]
  ];
  for (const [syntax, pattern] of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) && specs.length < 160) {
      const specifier = String(match[1] || "").trim();
      if (!specifier) continue;
      specs.push({ specifier, syntax });
    }
  }
  return specs;
}

function lineNumberAt(text = "", index = 0) {
  return text.slice(0, index).split("\n").length;
}

function parseNamedBindings(block = "") {
  return String(block || "")
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((part) => {
      const [importedRaw, localRaw] = part.split(/\s+as\s+/i).map((item) => item.trim());
      const imported = importedRaw || "";
      const local = localRaw || imported;
      return imported && local ? { imported, local } : null;
    })
    .filter(Boolean);
}

function parseImportBindings(clause = "", specifier = "") {
  const clean = String(clause || "").trim();
  if (!clean) return [];
  const bindings = [];
  const namedMatch = clean.match(/\{([^}]+)\}/);
  const namespaceMatch = clean.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const beforeComma = clean.split(",")[0]?.trim();
  if (beforeComma && !beforeComma.startsWith("{") && !beforeComma.startsWith("*") && /^[A-Za-z_$][\w$]*$/.test(beforeComma)) {
    bindings.push({ imported: "default", local: beforeComma, specifier, syntax: "import" });
  }
  if (namespaceMatch?.[1]) {
    bindings.push({ imported: "*", local: namespaceMatch[1], specifier, syntax: "import" });
  }
  if (namedMatch?.[1]) {
    for (const binding of parseNamedBindings(namedMatch[1])) {
      bindings.push({ ...binding, specifier, syntax: "import" });
    }
  }
  return bindings;
}

function extractImportBindings(text = "") {
  const bindings = [];
  const regex = new RegExp(IMPORT_BINDING_RE.source, IMPORT_BINDING_RE.flags);
  let match;
  while ((match = regex.exec(text)) && bindings.length < 240) {
    bindings.push(...parseImportBindings(match[1], String(match[2] || "").trim()));
  }
  return bindings.slice(0, 240);
}

function addSymbol(target, seen, filePath, text, match, name, kind, exported = false) {
  if (!name || JS_CONTROL_WORDS.has(name)) return;
  const line = lineNumberAt(text, match.index || 0);
  const key = `${kind}:${name}:${line}:${exported ? "export" : "local"}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    name,
    kind,
    exported,
    line,
    ref: `${filePath}:${line}`
  });
}

function extractSymbolFacts(text = "", filePath = "") {
  const exportedSymbols = [];
  const localSymbols = [];
  const exportedSeen = new Set();
  const localSeen = new Set();
  const symbolPatterns = [
    { kind: "function", exported: true, regex: new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+(${SYMBOL_NAME})\\b`, "g") },
    { kind: "class", exported: true, regex: new RegExp(`\\bexport\\s+class\\s+(${SYMBOL_NAME})\\b`, "g") },
    { kind: "value", exported: true, regex: new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${SYMBOL_NAME})\\b`, "g") },
    { kind: "function", exported: false, regex: new RegExp(`\\b(?:async\\s+)?function\\s+(${SYMBOL_NAME})\\b`, "g") },
    { kind: "class", exported: false, regex: new RegExp(`\\bclass\\s+(${SYMBOL_NAME})\\b`, "g") },
    { kind: "value", exported: false, regex: new RegExp(`\\b(?:const|let|var)\\s+(${SYMBOL_NAME})\\b`, "g") }
  ];
  for (const pattern of symbolPatterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match;
    while ((match = regex.exec(text))) {
      addSymbol(pattern.exported ? exportedSymbols : localSymbols, pattern.exported ? exportedSeen : localSeen, filePath, text, match, match[1], pattern.kind, pattern.exported);
      if (pattern.exported) addSymbol(localSymbols, localSeen, filePath, text, match, match[1], pattern.kind, false);
    }
  }
  const exportListRegex = new RegExp(EXPORT_LIST_RE.source, EXPORT_LIST_RE.flags);
  let exportMatch;
  while ((exportMatch = exportListRegex.exec(text))) {
    for (const binding of parseNamedBindings(exportMatch[1])) {
      addSymbol(exportedSymbols, exportedSeen, filePath, text, exportMatch, binding.imported, "reexport", true);
    }
  }
  const callCounts = {};
  const callRegex = new RegExp(CALL_RE.source, CALL_RE.flags);
  let callMatch;
  while ((callMatch = callRegex.exec(text))) {
    const name = callMatch[1];
    const previous = text[Math.max(0, callMatch.index - 1)];
    if (!name || JS_CONTROL_WORDS.has(name) || previous === ".") continue;
    callCounts[name] = (callCounts[name] || 0) + 1;
  }
  const callSymbols = Object.entries(callCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([name, count]) => ({ name, count }));
  return {
    exportedSymbols: exportedSymbols.slice(0, 32),
    localSymbols: localSymbols.slice(0, 48),
    importedBindings: extractImportBindings(text),
    callCounts,
    callSymbols
  };
}

function resolveLocalImport(fromPath, specifier, filesByPath) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return {
      kind: "package",
      packageName: firstPackageSegment(specifier),
      target: null,
      unresolvedPath: null
    };
  }
  const fromDir = path.posix.dirname(fromPath);
  const base = specifier.startsWith("/")
    ? path.posix.normalize(specifier.replace(/^\/+/, ""))
    : path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [base];
  const ext = path.posix.extname(base);
  if (!ext) {
    for (const candidateExt of CODE_GRAPH_EXTENSIONS) candidates.push(`${base}${candidateExt}`);
    for (const candidateExt of CODE_GRAPH_EXTENSIONS) candidates.push(path.posix.join(base, `index${candidateExt}`));
  } else {
    for (const candidateExt of CODE_GRAPH_EXTENSIONS) candidates.push(path.posix.join(base, `index${candidateExt}`));
  }
  const target = candidates.find((candidate) => filesByPath.has(candidate));
  return {
    kind: target ? "local" : "unresolved",
    packageName: null,
    target: target || null,
    unresolvedPath: target ? null : base
  };
}

function pathWithoutExtension(relPath = "") {
  const ext = path.posix.extname(relPath);
  return ext ? relPath.slice(0, -ext.length) : relPath;
}

function testSubjectStem(testPath = "") {
  const withoutExt = pathWithoutExtension(testPath);
  return withoutExt
    .replace(/(^|\/)__tests__\//g, "$1")
    .replace(/(^|\/)tests?\//g, "$1")
    .replace(/\.(test|spec)$/i, "")
    .replace(/[-_](test|spec)$/i, "");
}

function testOwnershipReason(sourcePath, testPath) {
  const sourceStem = pathWithoutExtension(sourcePath).toLowerCase();
  const testStem = testSubjectStem(testPath).toLowerCase();
  const sourceBase = path.posix.basename(sourceStem);
  const testBase = path.posix.basename(testStem);
  const sourceDir = path.posix.dirname(sourcePath);
  const testDir = path.posix.dirname(testPath);
  if (testStem === sourceStem || testStem.endsWith(`/${sourceBase}`)) return "same_stem";
  if (testDir === sourceDir && testBase.includes(sourceBase)) return "same_folder_name";
  if (sourceBase !== "index" && testPath.toLowerCase().includes(sourceBase)) return "name_contains_source";
  return "";
}

function buildTestOwnership(files = []) {
  const testFiles = files
    .filter((file) => file.kind === "test" || TEST_PATTERNS.some((pattern) => pattern.test(file.path)))
    .map((file) => ({ path: file.path, kind: file.kind, lineCount: file.lineCount || 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sourceFiles = files.filter((file) => CODE_GRAPH_EXTENSIONS.has(file.ext) && file.kind !== "test");
  const ownershipByPath = {};
  const ownership = [];
  for (const source of sourceFiles) {
    const tests = testFiles
      .map((test) => ({ ...test, reason: testOwnershipReason(source.path, test.path) }))
      .filter((test) => test.reason)
      .slice(0, 8);
    if (!tests.length) continue;
    ownershipByPath[source.path] = tests.map((test) => test.path);
    ownership.push({
      path: source.path,
      tests,
      status: "owned",
      summary: `${tests.length} likely test owner${tests.length === 1 ? "" : "s"}`
    });
  }
  return { testFiles, ownershipByPath, ownership };
}

function uniqueList(items = [], limit = 12) {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function buildChangedCodeImpact({ recentChanges = [], nodeMap = new Map(), dependenciesByPath = {}, dependentsByPath = {}, testOwnershipByPath = {}, symbolsByPath = {}, symbolDependentsByPath = {} }) {
  return (recentChanges || [])
    .filter((file) => file?.path && (nodeMap.has(file.path) || dependenciesByPath[file.path] || dependentsByPath[file.path] || /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(file.path)))
    .slice(0, 16)
    .map((file) => {
      const node = nodeMap.get(file.path) || {};
      const dependencies = (dependenciesByPath[file.path] || node.imports || []).filter((item) => !String(item).startsWith("pkg:")).slice(0, 10);
      const packageImports = (node.packageImports || (dependenciesByPath[file.path] || []).filter((item) => String(item).startsWith("pkg:")).map((item) => item.replace(/^pkg:/, ""))).slice(0, 8);
      const dependents = (dependentsByPath[file.path] || node.importedBy || []).slice(0, 10);
      const tests = (testOwnershipByPath[file.path] || []).slice(0, 8);
      const symbols = (symbolsByPath[file.path]?.exportedSymbols || []).slice(0, 8);
      const symbolDependents = (symbolDependentsByPath[file.path] || []).slice(0, 8);
      const symbolReadTargets = uniqueList(symbolDependents.map((item) => item.source), 8);
      const coChanged = (recentChanges || [])
        .filter((change) => change.path !== file.path && folderForPath(change.path) === folderForPath(file.path))
        .map((change) => change.path)
        .slice(0, 6);
      const recommendedReads = uniqueList([...symbolReadTargets, ...dependents, ...dependencies, ...tests, ...coChanged], 16);
      const firstReadTargets = uniqueList([...symbolReadTargets, ...dependents, ...tests], 3);
      const risk = symbolDependents.length ? "symbol_fan_in" : dependents.length ? "fan_in" : tests.length ? "tested" : dependencies.length ? "fan_out" : "isolated";
      const testStatus = file.kind === "test" ? "test_file" : tests.length ? "owned" : "missing";
      return {
        path: file.path,
        status: file.status || "changed",
        dependencies,
        dependents,
        symbols,
        symbolDependents,
        packageImports,
        tests,
        testStatus,
        coChanged,
        recommendedReads,
        risk,
        refs: uniqueList([file.path, ...recommendedReads], 20),
        why: [
          symbolDependents.length ? `${symbolDependents.length} symbol caller(s)` : "",
          dependents.length ? `${dependents.length} local dependent(s)` : "",
          dependencies.length ? `${dependencies.length} local dependency link(s)` : "",
          tests.length ? `${tests.length} likely test owner(s)` : "",
          coChanged.length ? `${coChanged.length} co-changed file(s)` : ""
        ].filter(Boolean).join("; ") || "No local dependency or test owner was inferred.",
        nextAction: symbolDependents.length
          ? `Inspect ${firstReadTargets.join(", ")} for symbol calls before editing ${file.path}.`
          : dependents.length
          ? `Inspect ${firstReadTargets.join(", ")} before editing ${file.path}.`
          : tests.length
            ? `Run or inspect ${tests.slice(0, 3).join(", ")} before claiming ${file.path}.`
            : dependencies.length
              ? `Inspect imports used by ${file.path} before editing.`
              : `No local dependency/test owner is linked for ${file.path}; inspect manually.`
      };
    });
}

function buildSymbolGraph({ graphFiles = [], filesByPath = new Map(), symbolFactsByPath = new Map(), recentChanges = [] }) {
  const symbolsByPath = {};
  const symbolEdgeMap = new Map();
  const symbolDependents = new Map();
  for (const file of graphFiles) {
    const facts = symbolFactsByPath.get(file.path) || {};
    const exportedSymbols = (facts.exportedSymbols || []).slice(0, 16);
    const localSymbols = (facts.localSymbols || []).slice(0, 16);
    const callSymbols = (facts.callSymbols || []).slice(0, 16);
    if (exportedSymbols.length || localSymbols.length || callSymbols.length) {
      symbolsByPath[file.path] = {
        exportedSymbols,
        localSymbols,
        callSymbols
      };
    }
    for (const binding of facts.importedBindings || []) {
      const resolved = resolveLocalImport(file.path, binding.specifier, filesByPath);
      if (resolved.kind !== "local" || !resolved.target) continue;
      const calls = Number(facts.callCounts?.[binding.local] || 0);
      const edgeKey = `${file.path}->${resolved.target}:${binding.imported}:${binding.local}`;
      if (symbolEdgeMap.has(edgeKey)) continue;
      const edge = {
        source: file.path,
        target: resolved.target,
        imported: binding.imported,
        local: binding.local,
        specifier: binding.specifier,
        calls,
        status: calls ? "called" : "imported",
        refs: [file.path, resolved.target]
      };
      symbolEdgeMap.set(edgeKey, edge);
      const rows = symbolDependents.get(resolved.target) || [];
      rows.push({
        source: file.path,
        imported: binding.imported,
        local: binding.local,
        calls,
        ref: file.path,
        target: resolved.target
      });
      symbolDependents.set(resolved.target, rows);
    }
  }
  const edges = [...symbolEdgeMap.values()].sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source) || a.local.localeCompare(b.local));
  const symbolDependentsByPath = Object.fromEntries(
    [...symbolDependents.entries()].map(([target, rows]) => [
      target,
      rows.sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source)).slice(0, 16)
    ])
  );
  const symbolCount = Object.values(symbolsByPath).reduce((sum, item) => sum + (item.localSymbols?.length || 0), 0);
  const exportedCount = Object.values(symbolsByPath).reduce((sum, item) => sum + (item.exportedSymbols?.length || 0), 0);
  const hotspots = Object.entries(symbolDependentsByPath)
    .map(([target, rows]) => ({
      path: target,
      symbols: (symbolsByPath[target]?.exportedSymbols || []).slice(0, 6),
      dependents: rows.length,
      calls: rows.reduce((sum, row) => sum + (row.calls || 0), 0),
      refs: uniqueList([target, ...rows.map((row) => row.source)], 8)
    }))
    .sort((a, b) => b.calls - a.calls || b.dependents - a.dependents || a.path.localeCompare(b.path))
    .slice(0, 12);
  const changedImpact = (recentChanges || [])
    .filter((file) => file?.path && (symbolsByPath[file.path] || symbolDependentsByPath[file.path]))
    .slice(0, 12)
    .map((file) => ({
      path: file.path,
      status: file.status || "changed",
      symbols: (symbolsByPath[file.path]?.exportedSymbols || []).slice(0, 8),
      symbolDependents: (symbolDependentsByPath[file.path] || []).slice(0, 8),
      refs: uniqueList([file.path, ...(symbolDependentsByPath[file.path] || []).map((row) => row.source)], 10)
    }));
  const status = edges.length ? "linked" : symbolCount ? "indexed" : "missing";
  return {
    schemaVersion: "project-agent.symbol-graph-lite.v1",
    status,
    symbolCount,
    exportedCount,
    usageEdgeCount: edges.length,
    calledEdgeCount: edges.filter((edge) => edge.calls > 0).length,
    symbolsByPath,
    symbolDependentsByPath,
    edges: edges.slice(0, 160),
    hotspots,
    changedImpact,
    summary: symbolCount
      ? `${symbolCount} local symbol(s), ${exportedCount} export(s), ${edges.length} local symbol usage edge(s).`
      : "No local JS/TS symbols were indexed.",
    refs: [".project-agent/architecture-map.json#codeGraph.symbolGraph"],
    nextAction: hotspots.length
      ? `Inspect symbol callers for ${hotspots[0].path} before editing exported APIs.`
      : "Use file-level dependency impact until symbol usage edges are available."
  };
}

function buildCoChangeRecommendations(changedImpact = []) {
  return changedImpact
    .filter((item) => item.recommendedReads?.length || item.tests?.length || item.coChanged?.length)
    .slice(0, 12)
    .map((item) => ({
      path: item.path,
      risk: item.risk,
      reads: item.recommendedReads.slice(0, 10),
      tests: (item.tests || []).slice(0, 6),
      reason: item.why,
      nextAction: item.nextAction
    }));
}

function buildCodeGraph(files = [], scannedAt = null, recentChanges = []) {
  const graphFiles = files
    .filter((file) => CODE_GRAPH_EXTENSIONS.has(file.ext) && file.text && file.diffable)
    .slice(0, MAX_CODE_GRAPH_NODES);
  const filesByPath = new Map(files.filter((file) => file.path).map((file) => [file.path, file]));
  const nodeMap = new Map(graphFiles.map((file) => [
    file.path,
    {
      id: file.path,
      path: file.path,
      kind: file.kind,
      ext: file.ext,
      lineCount: file.lineCount || 0,
      hash: file.hash,
      imports: [],
      importedBy: [],
      packageImports: []
    }
  ]));
  const symbolFactsByPath = new Map();
  for (const file of graphFiles) {
    const facts = extractSymbolFacts(file.text, file.path);
    symbolFactsByPath.set(file.path, facts);
    const node = nodeMap.get(file.path);
    if (node) {
      node.exportedSymbols = facts.exportedSymbols.slice(0, 12);
      node.localSymbols = facts.localSymbols.slice(0, 12);
      node.callSymbols = facts.callSymbols.slice(0, 12);
    }
  }
  const packageCounts = new Map();
  const edgeMap = new Map();
  let truncatedEdges = false;

  for (const file of graphFiles) {
    const sourceNode = nodeMap.get(file.path);
    const specs = extractImportSpecifiers(file.text);
    for (const spec of specs) {
      const resolved = resolveLocalImport(file.path, spec.specifier, filesByPath);
      const target = resolved.target || resolved.packageName || resolved.unresolvedPath || spec.specifier;
      const edgeKey = `${file.path}->${target}:${spec.specifier}:${spec.syntax}`;
      if (edgeMap.has(edgeKey)) continue;
      if (edgeMap.size >= MAX_CODE_GRAPH_EDGES) {
        truncatedEdges = true;
        continue;
      }
      const edge = {
        source: file.path,
        target: resolved.target,
        specifier: spec.specifier,
        syntax: spec.syntax,
        kind: resolved.kind,
        packageName: resolved.packageName,
        unresolvedPath: resolved.unresolvedPath
      };
      edgeMap.set(edgeKey, edge);
      if (resolved.kind === "local" && resolved.target) {
        sourceNode.imports.push(resolved.target);
        if (!nodeMap.has(resolved.target)) {
          const targetFile = filesByPath.get(resolved.target);
          nodeMap.set(resolved.target, {
            id: resolved.target,
            path: resolved.target,
            kind: targetFile?.kind || "code",
            ext: targetFile?.ext || path.posix.extname(resolved.target),
            lineCount: targetFile?.lineCount || 0,
            hash: targetFile?.hash,
            imports: [],
            importedBy: [],
            packageImports: []
          });
        }
        nodeMap.get(resolved.target)?.importedBy.push(file.path);
      } else if (resolved.kind === "package" && resolved.packageName) {
        sourceNode.packageImports.push(resolved.packageName);
        packageCounts.set(resolved.packageName, (packageCounts.get(resolved.packageName) || 0) + 1);
      }
    }
  }

  const edges = [...edgeMap.values()];
  const nodes = [...nodeMap.values()]
    .map((node) => ({
      ...node,
      imports: [...new Set(node.imports)].sort(),
      importedBy: [...new Set(node.importedBy)].sort(),
      packageImports: [...new Set(node.packageImports)].sort()
    }))
    .sort((a, b) => (b.importedBy.length + b.imports.length) - (a.importedBy.length + a.imports.length) || a.path.localeCompare(b.path));
  const dependenciesByPath = Object.fromEntries(
    nodes
      .filter((node) => node.imports.length || node.packageImports.length)
      .map((node) => [node.path, [...node.imports, ...node.packageImports.map((packageName) => `pkg:${packageName}`)].slice(0, 16)])
  );
  const dependentsByPath = Object.fromEntries(nodes.filter((node) => node.importedBy.length).map((node) => [node.path, node.importedBy.slice(0, 16)]));
  const symbolGraph = buildSymbolGraph({ graphFiles, filesByPath, symbolFactsByPath, recentChanges });
  const testOwnership = buildTestOwnership(files);
  const changedImpact = buildChangedCodeImpact({
    recentChanges,
    nodeMap,
    dependenciesByPath,
    dependentsByPath,
    testOwnershipByPath: testOwnership.ownershipByPath,
    symbolsByPath: symbolGraph.symbolsByPath,
    symbolDependentsByPath: symbolGraph.symbolDependentsByPath
  });
  const coChangeRecommendations = buildCoChangeRecommendations(changedImpact);
  const localEdgeCount = edges.filter((edge) => edge.kind === "local").length;
  const packageEdgeCount = edges.filter((edge) => edge.kind === "package").length;
  const unresolvedEdgeCount = edges.filter((edge) => edge.kind === "unresolved").length;
  const status = localEdgeCount
    ? "linked"
    : packageEdgeCount
      ? "external"
      : nodes.length
        ? "flat"
        : "missing";
  const warnings = [
    files.length > graphFiles.length && files.some((file) => CODE_GRAPH_EXTENSIONS.has(file.ext) && !file.text) ? "large_or_binary_code_files_skipped" : "",
    files.filter((file) => CODE_GRAPH_EXTENSIONS.has(file.ext) && file.text && file.diffable).length > MAX_CODE_GRAPH_NODES ? "node_limit" : "",
    truncatedEdges ? "edge_limit" : "",
    unresolvedEdgeCount ? "unresolved_imports" : ""
  ].filter(Boolean);

  return {
    schemaVersion: "project-agent.code-graph.v1",
    status,
    scannedAt,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    localEdgeCount,
    packageEdgeCount,
    unresolvedEdgeCount,
    symbolCount: symbolGraph.symbolCount,
    symbolEdgeCount: symbolGraph.usageEdgeCount,
    calledSymbolEdgeCount: symbolGraph.calledEdgeCount,
    nodes: nodes.slice(0, 80),
    edges: edges.slice(0, 160),
    symbolGraph,
    packages: [...packageCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24)
      .map(([name, count]) => ({ name, count })),
    testFiles: testOwnership.testFiles.slice(0, 40),
    testOwnership: testOwnership.ownership.slice(0, 40),
    testOwnershipByPath: Object.fromEntries(Object.entries(testOwnership.ownershipByPath).slice(0, 120)),
    changedImpact,
    coChangeRecommendations,
    hotspots: nodes
      .filter((node) => node.importedBy.length || node.imports.length)
      .slice(0, 12)
      .map((node) => ({
        path: node.path,
        imports: node.imports.length,
        importedBy: node.importedBy.length,
        packages: node.packageImports.length,
        symbols: node.exportedSymbols?.length || 0,
        symbolCallers: symbolGraph.symbolDependentsByPath[node.path]?.length || 0,
        refs: [node.path, ...node.importedBy.slice(0, 4), ...node.imports.slice(0, 4)]
      })),
    dependenciesByPath,
    dependentsByPath,
    warnings,
    summary: nodes.length
      ? `${nodes.length} code node(s), ${localEdgeCount} local edge(s), ${packageEdgeCount} package edge(s), ${symbolGraph.exportedCount || 0} export symbol(s), ${unresolvedEdgeCount} unresolved.`
      : "No JS/TS source files were available for import graphing.",
    refs: [".project-agent/architecture-map.json"],
    nextAction:
      changedImpact.find((item) => item.dependents?.length)?.nextAction ||
      changedImpact.find((item) => item.tests?.length)?.nextAction ||
      (status === "linked"
        ? "Inspect dependents before editing files with inbound local edges."
        : status === "external"
          ? "Check package imports and unresolved aliases before cross-file edits."
          : "Add import/export evidence or refresh architecture scan before relying on code impact.")
  };
}

function summarizeModules(files) {
  const counts = new Map();
  for (const file of files) counts.set(file.kind, (counts.get(file.kind) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ kind, count }));
}

function folderForPath(relPath) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  if (parts[0] === "docs" && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === ".project-agent") return ".project-agent";
  return parts[0];
}

function impactPriority(change) {
  if (change.status === "deleted") return 4;
  if (change.kind === "kernel" || change.kind === "config") return 3;
  if (change.kind === "code" || change.kind === "test") return 2;
  return 1;
}

function summarizeArchitectureImpact(recentChanges = []) {
  const folderMap = new Map();
  for (const change of recentChanges || []) {
    if (!change?.path) continue;
    const folder = folderForPath(change.path);
    const current = folderMap.get(folder) || {
      folder,
      files: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      additions: 0,
      deletions: 0,
      kinds: new Set(),
      latestAt: "",
      latestFile: "",
      priority: 0,
      changes: []
    };
    current.files += 1;
    current[change.status] = (current[change.status] || 0) + 1;
    current.additions += change.additions || 0;
    current.deletions += change.deletions || 0;
    current.kinds.add(change.kind || "file");
    if (!current.latestAt || (change.modifiedAt || "") > current.latestAt) {
      current.latestAt = change.modifiedAt || "";
      current.latestFile = change.path;
    }
    current.priority = Math.max(current.priority, impactPriority(change));
    current.changes.push({
      path: change.path,
      status: change.status,
      kind: change.kind,
      summary: change.summary,
      modifiedAt: change.modifiedAt
    });
    folderMap.set(folder, current);
  }

  const folders = [...folderMap.values()]
    .map((item) => ({
      ...item,
      kinds: [...item.kinds].sort(),
      changes: item.changes.slice(0, 6),
      summary: `${item.files} file(s), +${item.additions}/-${item.deletions}`
    }))
    .sort((a, b) => b.priority - a.priority || (b.latestAt || "").localeCompare(a.latestAt || "") || b.files - a.files)
    .slice(0, 12);

  return {
    folders,
    topFolders: folders.slice(0, 5),
    totals: {
      folders: folders.length,
      files: folders.reduce((sum, item) => sum + item.files, 0),
      added: folders.reduce((sum, item) => sum + item.added, 0),
      modified: folders.reduce((sum, item) => sum + item.modified, 0),
      deleted: folders.reduce((sum, item) => sum + item.deleted, 0),
      additions: folders.reduce((sum, item) => sum + item.additions, 0),
      deletions: folders.reduce((sum, item) => sum + item.deletions, 0)
    }
  };
}

function applyStatusToTree(nodes, statusByPath) {
  return nodes.map((node) => {
    if (node.type === "file") return { ...node, status: statusByPath.get(node.path) || "unchanged" };
    const children = applyStatusToTree(node.children || [], statusByPath);
    const status = children.some((child) => child.status === "added")
      ? "added"
      : children.some((child) => child.status === "modified")
        ? "modified"
        : children.some((child) => child.status === "deleted")
          ? "deleted"
          : "unchanged";
    return { ...node, status, children };
  });
}

function makeSnapshot(projectDir) {
  const files = [];
  const tree = scanDir(projectDir, "", 0, files);
  return {
    scannedAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    tree
  };
}

function normalizeChange(change) {
  return {
    ...change,
    changeKey: `${change.path}:${change.status}:${change.hash || change.previousHash || change.modifiedAt || ""}`
  };
}

function mergeRecentChanges(changes, previousChanges) {
  const merged = new Map();
  const ordered = [...changes, ...(previousChanges || [])]
    .filter((item) => !isInternalRuntimePath(item.path) && !INTERNAL_RUNTIME_FILES.has(item.path))
    .map(normalizeChange)
    .sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""));
  for (const change of ordered) {
    if (!merged.has(change.path)) merged.set(change.path, change);
  }
  return [...merged.values()]
    .slice(0, 80)
    .map(({ changeKey, ...change }) => change);
}

export function buildArchitecture(projectDir, options = {}) {
  const persist = options.persist !== false;
  const runtime = readRuntime(projectDir);
  const previous = runtime.architectureSnapshot;
  const previousMap = flattenFiles(previous);
  const snapshot = makeSnapshot(projectDir);
  const statusByPath = new Map();
  const changes = [];

  for (const file of snapshot.files) {
    const status = previous ? changeStatus(file.path, file, previousMap) : "unchanged";
    const previousFile = previousMap.get(file.path);
    statusByPath.set(file.path, status);
    if (status !== "unchanged") {
      changes.push({
        path: file.path,
        name: file.name,
        kind: file.kind,
        status,
        size: file.size,
        modifiedAt: file.modifiedAt,
        hash: file.hash,
        previousHash: previousFile?.hash,
        ...diffStats(status, previousFile, file)
      });
    }
  }

  if (previous) {
    const currentPaths = new Set(snapshot.files.map((file) => file.path));
    for (const file of previous.files || []) {
      if (isInternalRuntimePath(file.path) || INTERNAL_RUNTIME_FILES.has(file.path)) continue;
      if (!currentPaths.has(file.path)) {
        statusByPath.set(file.path, "deleted");
        changes.push({
          path: file.path,
          name: file.name,
          kind: file.kind,
          status: "deleted",
          size: file.size,
          modifiedAt: new Date().toISOString(),
          previousHash: file.hash,
          ...diffStats("deleted", file, null)
        });
      }
    }
  }

  const recentChanges = mergeRecentChanges(changes, runtime.architectureChanges);
  const impact = summarizeArchitectureImpact(recentChanges);
  const codeGraph = buildCodeGraph(snapshot.files, snapshot.scannedAt, recentChanges);
  const architecture = {
    root: path.basename(projectDir),
    projectDir,
    scannedAt: snapshot.scannedAt,
    tree: applyStatusToTree(snapshot.tree, statusByPath),
    files: snapshot.files.map(({ text, ...file }) => ({ ...file, status: statusByPath.get(file.path) || "unchanged" })),
    modules: summarizeModules(snapshot.files),
    changes,
    recentChanges,
    impact,
    codeGraph,
    totals: {
      files: snapshot.files.length,
      directories: countDirectories(snapshot.tree),
      changed: changes.length,
      tracked: existsSync(path.join(projectDir, ".project-agent", "state.json"))
    }
  };

  if (persist) {
    runtime.architectureSnapshot = {
      scannedAt: snapshot.scannedAt,
      files: snapshot.files.map(({ path: filePath, name, kind, size, mtimeMs, modifiedAt, hash, diffable, lineCount, text }) => ({
        path: filePath,
        name,
        kind,
        size,
        mtimeMs,
        modifiedAt,
        hash,
        diffable,
        lineCount,
        text: diffable ? text : undefined
      }))
    };
    runtime.architectureChanges = recentChanges;
    writeRuntime(projectDir, runtime);
  }
  return architecture;
}

function countDirectories(nodes) {
  return nodes.reduce((sum, node) => {
    if (node.type !== "dir") return sum;
    return sum + 1 + countDirectories(node.children || []);
  }, 0);
}
