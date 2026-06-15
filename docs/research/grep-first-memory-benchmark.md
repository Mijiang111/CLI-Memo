# Grep-First Agent Memory Benchmark

Date: 2026-06-12

## Question

Should CLI Memo make grep-first, file-native memory the primary architecture for coding-agent memory?

Short answer: yes, for this product. Grep-first should be the canonical layer. Vector, graph, and learned rerankers should be optional acceleration and discovery layers, not the source of truth.

## Definition

In this benchmark, "grep-first memory" means:

- memory is stored as plain files, usually Markdown, JSONL, or structured JSON;
- every durable claim has a stable path, line, id, or selector;
- retrieval starts with exact refs, keyword search, BM25/FTS, path priority, and small reads;
- generated context is disposable and can be rebuilt from source files;
- agents can inspect, edit, diff, delete, and version memory with normal developer tools.

This is not limited to the Unix `grep` binary. It includes `rg`, FTS5, BM25, trigram indexes, AST-aware search, and file-native MCP tools.

## Projects Reviewed

| Project | Architecture | Grep-first relevance | Notes |
| --- | --- | --- | --- |
| Claude Code memory | Plain Markdown memory files, browsable via `/memory` | Very high | Official docs say auto memory files are plain Markdown that users can edit/delete. Good evidence that file-native memory is viable for coding agents. |
| `basicmachines-co/basic-memory` | Markdown files + knowledge graph + semantic search + MCP | Very high | Strong local-first reference: humans and AI share readable files while MCP provides agent access. |
| `phasespace-labs/palinode` | Git-versioned Markdown folder + hybrid search + MCP | Very high | Closest to "memory as repo": if services fail, `cat` still works. |
| `TyposBro/agent-vault` | Markdown vault + provider exports, no mandatory MCP/vector DB | Very high | Pure source-of-truth and portability layer; intentionally avoids heavy retrieval runtime. |
| `agentscope-ai/ReMe` | File-based and vector-based memory systems | High | Explicitly frames "memory as files, files as memory." |
| `modelcontextprotocol/server-memory` | JSONL-backed knowledge graph | Medium-high | Not Markdown-first, but the reference MCP memory server stores atomic observations and exposes search/delete tools. |
| `momokun7/xgrep` | Trigram indexed code search + MCP | High for retrieval | Not a memory product, but shows grep-like MCP retrieval can be fast, deterministic, and token-aware. |
| `probelabs/probe` | Ripgrep-speed + tree-sitter AST search + MCP | High for code memory | Not long-term memory, but excellent model for source-code recall without embeddings. |
| `coleam00/claude-memory-compiler` | Hooks capture sessions; LLM compiles structured knowledge articles | Medium-high | Shows file/wiki-style compiled memory for Claude Code. |
| `zilliztech/memsearch` | Markdown + Milvus hybrid retrieval | Medium | Markdown-backed, but vector DB becomes important infrastructure. |
| `adamrdrew/agent-memory-mcp` | LanceDB + BM25 + vector | Medium | Good hybrid retrieval reference, less grep-first because source of truth is DB-backed. |
| `ToolOracle/memoryoracle` | FTS5 BM25 + vector + update/forget | Medium | Strong local query/governance hints; less file-native. |
| `rohitg00/agentmemory` | hooks + observations + BM25/vector/graph + MCP | Medium | Excellent full memory runtime, but not grep-first as the canonical mental model. |

## Findings

### 1. There are real grep-first memory products on GitHub

The category exists. The strongest examples are `basic-memory`, `palinode`, `agent-vault`, and `ReMe`. They converge on a similar thesis: memory should be readable files first, with MCP/search/indexing layered on top.

### 2. Coding-agent memory benefits unusually much from grep-first

Coding work already uses files, paths, diffs, refs, git history, and line numbers. A memory item that says "API tests require Redis" is more useful if it can point to:

```text
docs/testing.md:42
.project-agent/memory/procedures.jsonl#proc_...
.project-agent/runtime.json#events[12]
```

For coding agents, exact refs are not a UX detail. They are the difference between a useful memory and an unsupported claim.

### 3. Grep-first is better for trust and deletion

If memory is a folder of files, users and agents can answer:

- where is this stored?
- who wrote it?
- what generated files repeat it?
- how do I delete it?
- what diff did this change create?

Vector-only memory often fails this audit trail unless it adds a separate provenance layer. Grep-first starts with provenance.

### 4. Grep-first is weaker at fuzzy recall

The weakness is obvious: if the user asks "where did we handle login throttling?" but the memory says "rate limit middleware," pure grep may miss it. This is why the best designs are not "grep only"; they are file-native source of truth plus optional vector/entity/BM25 reranking.

### 5. The best architecture is hybrid, but asymmetric

The source of truth should be grep-first. The retrieval layer can be hybrid:

```text
canonical files
  -> exact ref read
  -> keyword / rg / FTS5 / BM25
  -> optional vector rerank
  -> optional graph/entity traversal
  -> small, cited context pack
```

Vector and graph indexes should be rebuildable caches. If the index corrupts, delete it and rebuild from files.

## Benchmark Matrix

| Dimension | Grep-first files | BM25/FTS | Vector DB | Graph DB | Recommended for CLI Memo |
| --- | --- | --- | --- | --- | --- |
| Human inspectability | Excellent | Good if backed by files | Weak unless source refs are strict | Medium | Grep-first |
| Exact code refs | Excellent | Good | Weak by default | Medium | Grep-first + read_ref |
| Fuzzy recall | Weak-medium | Medium | Excellent | Medium-high | Optional vector |
| Temporal/version history | Excellent with git/JSONL | Medium | Weak unless modeled | Good | Files + git + supersedes |
| Deletion confidence | Excellent | Good | Risky if embeddings linger | Medium | Files + cascade |
| Setup complexity | Low | Low-medium | Medium-high | Medium-high | Low first |
| Offline/local-first | Excellent | Excellent | Depends | Depends | Required |
| Agent autonomy | Good with MCP tools | Good | Good | Good | MCP over files |
| Scaling to huge memory | Medium | Good | Excellent | Good | Add index only when needed |
| Debuggability | Excellent | Good | Weak-medium | Medium | Grep-first |

## Recommended CLI Memo Architecture

CLI Memo should be a project-control memory system, not a generic vector memory service.

Recommended stack:

```text
.project-agent/
  memory/
    index.md
    episodes.jsonl
    decisions.jsonl
    facts.jsonl
    procedures.jsonl
    evidence.jsonl
    risks.jsonl
    audit.jsonl
  runtime.json
  state.json
  generated/
    takeover-summary.json
    takeover-packet.json
    process-trace.json
    architecture-map.json
    agent-context-bundle.json
  indexes/
    bm25.sqlite
    vector.sqlite       # optional
    graph.json          # optional
```

Rules:

1. Canonical memory lives in files.
2. Generated handoff context is rebuildable.
3. Every memory has `sourceRefs`.
4. `project_read_ref` is the final authority.
5. Search returns citations, not just text.
6. Delete and redaction mutate source files, then rebuild generated files and indexes.
7. Vector/graph indexes are caches, not truth.

## MCP Surface

Keep current control-plane tools:

- `project_start`
- `project_takeover_summary`
- `project_context_search`
- `project_read_ref`
- `project_record_event`
- `project_architecture_changes`
- `project_handoff_audit`

Add grep-first memory tools:

- `project_memory_inventory`
- `project_memory_add`
- `project_memory_search`
- `project_memory_read`
- `project_memory_update`
- `project_memory_supersede`
- `project_memory_forget`
- `project_memory_consolidate`
- `project_memory_audit`

Search result shape should look like:

```json
{
  "id": "mem_...",
  "type": "procedure",
  "title": "Run API tests with local Redis",
  "score": 42,
  "scoreBreakdown": {
    "path": 8,
    "keyword": 20,
    "recency": 6,
    "exactRef": 8
  },
  "refs": [
    ".project-agent/memory/procedures.jsonl#mem_...",
    "docs/quality/test-strategy.md:18"
  ],
  "snippet": "API tests require local Redis before running the integration suite."
}
```

## Product Conclusion

Grep-first is not just "simpler." For coding-agent memory, it is safer, more debuggable, more compatible with git, and easier for agents to cite precisely. The product should use grep-first as the memory substrate and add vector/graph later as rebuildable retrieval accelerators.

This keeps CLI Memo aligned with developer expectations: memory is not a mysterious database. It is project state you can read, search, diff, review, and delete.

## Sources

- https://code.claude.com/docs/en/memory
- https://github.com/basicmachines-co/basic-memory
- https://github.com/phasespace-labs/palinode
- https://github.com/TyposBro/agent-vault
- https://github.com/agentscope-ai/ReMe
- https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- https://github.com/momokun7/xgrep
- https://github.com/probelabs/probe
- https://github.com/coleam00/claude-memory-compiler
- https://github.com/zilliztech/memsearch
- https://github.com/adamrdrew/agent-memory-mcp
- https://github.com/ToolOracle/memoryoracle
- https://github.com/rohitg00/agentmemory

