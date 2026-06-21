import path from "node:path";
import { buildArchitecture } from "./architecture.js";

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function tokenize(value = "") {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) || [])]
    .filter((term) => term.length > 1)
    .slice(0, 32);
}

function extLanguage(ext = "") {
  const clean = String(ext || "").replace(/^\./, "").toLowerCase();
  if (["js", "jsx", "mjs", "cjs"].includes(clean)) return "javascript";
  if (["ts", "tsx", "mts", "cts"].includes(clean)) return "typescript";
  return clean || "unknown";
}

function symbolMatches(symbol = {}, terms = []) {
  const name = String(symbol.name || "").toLowerCase();
  if (!terms.length) return false;
  return terms.some((term) => name.includes(term));
}

function scoreNode(node = {}, graph = {}, terms = [], input = {}) {
  const symbolGraph = graph.symbolGraph || {};
  const symbolDependents = symbolGraph.symbolDependentsByPath?.[node.path] || [];
  const tests = graph.testOwnershipByPath?.[node.path] || [];
  const haystack = [
    node.path,
    node.kind,
    node.ext,
    ...(node.imports || []),
    ...(node.importedBy || []),
    ...(node.packageImports || []),
    ...(node.exportedSymbols || []).map((symbol) => symbol.name),
    ...(node.localSymbols || []).map((symbol) => symbol.name),
    ...(node.callSymbols || []).map((symbol) => symbol.name)
  ].join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += node.path.toLowerCase().includes(term) ? 18 : 8;
  }
  if (input.file && node.path.includes(input.file)) score += 60;
  if (input.symbol && [...(node.exportedSymbols || []), ...(node.localSymbols || [])].some((symbol) => String(symbol.name || "").toLowerCase() === String(input.symbol).toLowerCase())) score += 45;
  if (node.importedBy?.length) score += Math.min(18, node.importedBy.length * 3);
  if (symbolDependents.length) score += Math.min(24, symbolDependents.reduce((sum, item) => sum + Number(item.calls || 1), 0));
  if (tests.length) score += 6;
  return score;
}

function resultForNode(node = {}, graph = {}, score = 0) {
  const symbolGraph = graph.symbolGraph || {};
  const symbolDependents = symbolGraph.symbolDependentsByPath?.[node.path] || [];
  const tests = graph.testOwnershipByPath?.[node.path] || [];
  const changedImpact = (graph.changedImpact || []).find((item) => item.path === node.path);
  return {
    path: node.path,
    language: extLanguage(node.ext || path.posix.extname(node.path)),
    kind: node.kind || "code",
    score,
    lineCount: node.lineCount || 0,
    imports: (node.imports || []).slice(0, 12),
    importedBy: (node.importedBy || []).slice(0, 12),
    packageImports: (node.packageImports || []).slice(0, 8),
    exportedSymbols: (node.exportedSymbols || []).slice(0, 10),
    localSymbols: (node.localSymbols || []).slice(0, 10),
    callSymbols: (node.callSymbols || []).slice(0, 10),
    symbolDependents: symbolDependents.slice(0, 10),
    tests: tests.slice(0, 8),
    risk: changedImpact?.risk || (symbolDependents.length ? "symbol_fan_in" : node.importedBy?.length ? "fan_in" : tests.length ? "tested" : "unknown"),
    nextAction: changedImpact?.nextAction || (symbolDependents.length
      ? `Inspect ${symbolDependents.slice(0, 3).map((item) => item.source).join(", ")} before editing exported APIs.`
      : node.importedBy?.length
        ? `Inspect ${node.importedBy.slice(0, 3).join(", ")} before editing ${node.path}.`
        : tests.length
          ? `Run or inspect ${tests.slice(0, 3).join(", ")} before claiming ${node.path}.`
          : `Inspect ${node.path} directly; no local caller/test ownership was inferred.`),
    refs: [node.path, ...(symbolDependents || []).map((item) => item.source), ...(node.importedBy || []), ...tests].filter(Boolean).slice(0, 16)
  };
}

export function searchCodeGraph(projectDir, input = {}) {
  const architecture = buildArchitecture(projectDir, { persist: input.persist === true });
  const graph = architecture.codeGraph || {};
  const terms = tokenize(`${input.query || ""} ${input.symbol || ""} ${input.file || ""}`);
  const language = String(input.language || "").replace(/^\./, "").toLowerCase();
  const symbolKind = String(input.symbolKind || input.kind || "").toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
  const nodes = (graph.nodes || [])
    .filter((node) => !language || extLanguage(node.ext || path.posix.extname(node.path)).includes(language) || String(node.ext || "").replace(/^\./, "") === language)
    .filter((node) => !input.file || String(node.path || "").includes(String(input.file)))
    .filter((node) => !input.symbol || [...(node.exportedSymbols || []), ...(node.localSymbols || []), ...(node.callSymbols || [])].some((symbol) => symbolMatches(symbol, [String(input.symbol).toLowerCase()])))
    .filter((node) => !symbolKind || [...(node.exportedSymbols || []), ...(node.localSymbols || [])].some((symbol) => String(symbol.kind || "").toLowerCase() === symbolKind))
    .map((node) => ({ node, score: scoreNode(node, graph, terms, input) }))
    .filter((item) => !terms.length || item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path))
    .slice(0, limit)
    .map((item) => resultForNode(item.node, graph, item.score));
  const hotspots = (graph.symbolGraph?.hotspots || graph.hotspots || []).slice(0, 8);
  return {
    schemaVersion: "project-agent.code-search.v1",
    ok: true,
    status: graph.status || "missing",
    engine: "symbol-graph-lite",
    projectDir,
    generatedAt: nowIso(),
    query: {
      query: compact(input.query || "", 240),
      file: input.file || null,
      symbol: input.symbol || null,
      symbolKind: symbolKind || null,
      language: language || null,
      limit
    },
    ast: {
      treeSitter: false,
      provider: "none",
      reason: "This tranche exposes existing local import/export/call intelligence as a probe-like search surface; tree-sitter can replace the engine behind this schema later."
    },
    graph: {
      status: graph.status || "missing",
      nodeCount: graph.nodeCount || 0,
      edgeCount: graph.edgeCount || 0,
      symbolCount: graph.symbolCount || 0,
      symbolEdgeCount: graph.symbolEdgeCount || 0,
      warnings: graph.warnings || []
    },
    results: nodes,
    hotspots,
    totals: {
      returned: nodes.length,
      scannedNodes: graph.nodeCount || 0,
      hotspots: hotspots.length
    },
    summary: nodes.length
      ? `Code search returned ${nodes.length} symbol/import graph result(s) from ${graph.nodeCount || 0} node(s).`
      : `Code search found no matching symbol/import graph nodes for "${compact(input.query || input.symbol || input.file || "", 80)}".`,
    refs: [".project-agent/architecture-map.json#codeGraph", ...nodes.flatMap((item) => item.refs).slice(0, 24)]
  };
}
