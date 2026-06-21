# Memory Gap Deep Benchmark

Date: 2026-06-14

## Scope

This benchmark audits the current CLI Memo memory layer against public agent-memory systems, with targeted source reads only. No external repository was cloned wholesale. The comparison focuses on the remaining gaps after the six-stage canonical memory work landed.

The current judgment is:

CLI Memo now has a strong grep-first, file-native memory control plane. It has canonical JSONL files, MCP tools, HTTP endpoints, a UI, deterministic search, optional BM25/entity/lexical-vector caches, forget dry-runs, consolidation proposals, and an automatic memory harness.

It still trails mature memory systems in lifecycle automation, semantic evolution, cross-language code understanding, and production-grade maintenance loops.

## Current Local Evidence

Implemented:

- Canonical memory types and files exist in `server/memory-store.js`: `episode`, `fact`, `decision`, `procedure`, `evidence`, `risk`; files live under `.project-agent/memory/*.jsonl` plus `audit.jsonl`, `retention.json`, and `index.md`.
- `project_start` creates/verifies the memory store and returns memory refs through MCP.
- MCP memory tools exist: `project_memory_inventory`, `project_memory_add`, `project_memory_read`, `project_memory_search`, `project_memory_rebuild_index`, `project_memory_rebuild_entity_index`, `project_memory_rebuild_vector_index`, `project_memory_forget`, `project_memory_harness`, `project_memory_consolidate`, and `project_memory_audit`.
- HTTP endpoints mirror the core memory tools under `/api/memory/*`.
- The UI exposes inventory, search, index status, harness auto-reads, consolidation proposals, forget preview/confirm, and audit rows.
- `npm test` passes with `smoke ok`.
- `npm run build` passes, with only the existing Vite chunk-size warning.

Important limitations:

- The demo project has 0 canonical memory records even though the store exists. Its audit has 37 rows, so mechanisms are being exercised, but durable dogfood memory is empty.
- `retention.json` defines TTL and limits, but there is no first-class retention sweep tool.
- `project_memory_forget` supports delete/redact/expire/supersede and refresh targets, but optional BM25/entity/vector caches are not rebuilt as part of forget execution.
- `addMemory` accepts `supersedes`, and `forget` can mark an old record superseded, but there is no dedicated `project_memory_update` or `project_memory_supersede` tool that creates a new version chain.
- `consolidateMemory` is deterministic and useful, but candidate extraction is rule/template based from runtime, handoff, and architecture state. It does not yet do semantic LLM extraction, contradiction detection, or memory evolution.
- The vector cache is `lexical-vector-lite` with `embeddingProvider: "none"`, so it is not true semantic retrieval.
- Architecture source classification covers many languages, but the code graph and symbol graph are JS/TS-only and regex/lite based.
- `retention.json` says `allowRawArchitectureText: false`, but persisted runtime architecture snapshots still include raw `text` for diffable files.

## External Benchmark Set

Partial sources reviewed:

- Mem0: README and `mem0/memory/main.py`
- Graphiti: README and `graphiti_core/graphiti.py`
- Basic Memory: README
- Model Context Protocol memory server: README
- LangMem: README
- Probe: README
- Local reference agentmemory: targeted source files under `work/agentmemory/src/functions` and `work/agentmemory/src/state`

Public source links:

- https://github.com/mem0ai/mem0
- https://github.com/getzep/graphiti
- https://github.com/basicmachines-co/basic-memory
- https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- https://github.com/langchain-ai/langmem
- https://github.com/probelabs/probe
- https://github.com/rohitg00/agentmemory

## Gap Matrix

| Gap | CLI Memo current state | Benchmark bar | Severity | Next build |
| --- | --- | --- | --- | --- |
| Durable dogfood memory | Store exists, demo has 0 records | Memory products ship with visible useful memory content | P0 | Seed/project dogfood consolidation |
| Retention sweep | Policy exists, no sweep | agentmemory auto-forget; Mem0 scoped delete; Graphiti invalidation | P0 | `project_memory_retention_audit/sweep` |
| Update/supersede | Fields/modes exist, no first-class tool | Mem0 update; agentmemory remember supersedes; Graphiti temporal invalidation | P0 | `project_memory_update` and `project_memory_supersede` |
| Consolidation quality | Rule-based candidates | LangMem background manager; agentmemory LLM consolidation; Graphiti structured extraction | P1 | Consolidation V2 with optional LLM proposals |
| Semantic retrieval | Deterministic + BM25/entity + lexical vector | Mem0 semantic + BM25 + entity; Graphiti semantic + keyword + graph | P1 | Optional provider-backed embeddings |
| Cross-language code memory | JS/TS regex code graph only | Probe tree-sitter AST search, boolean queries, token caps | P1 | Tree-sitter/probe-like code search cache |
| Derived state bloat | Inventory detects 15.93x derived/source bytes in demo | File-native systems keep indexes disposable and small | P1 | Generated directory + cleanup/rebuild commands |
| Privacy enforcement | Add sanitizer exists; raw runtime/architecture risk remains | Governance delete and local-first file visibility | P1 | Central sanitizer and policy enforcement |
| Read/access audit | Write/forget/consolidate audit exists; read/search audit absent | agentmemory access tracker | P2 | Optional bounded access log |
| Agent E2E packaging | MCP/HTTP/UI exist; no full external client e2e | Basic Memory/Probe publish install snippets and doctor/status flows | P2 | Codex/Claude MCP e2e and doctor |

## Gap 1: Canonical Store Exists, But Durable Memory Is Empty

### Current state

CLI Memo has the right storage shape. `server/memory-store.js` defines six canonical types and expected files, and `ensureMemoryStore()` creates them. The demo project currently reports 0 canonical records while keeping fresh empty BM25/entity/vector indexes.

This means the mechanism works, but the product has not started dogfooding its own long-term memory as the source of truth.

### Benchmark

Basic Memory's core product claim is that knowledge lives as Markdown files both humans and AI can read, write, and search. It demonstrates actual note content, observations, and relations as first-class user-visible memory.

Mem0's README example shows every chat loop searching existing memories before responding and adding memories after the response. In other words, memory is not a passive admin surface; it is part of the normal agent loop.

### Gap

CLI Memo's memory layer is operationally wired, but the included project state does not yet prove that durable records become the normal working substrate.

### Build

1. Add a dogfood seed step that turns current product decisions into canonical records:
   - decision: grep-first canonical memory is the source of truth
   - procedure: run `npm test` and `npm run build` before handoff
   - risk: optional vector cache is lexical, not semantic
   - fact: generated bundles are rebuildable
2. Add inventory wording for `empty_canonical_memory`.
3. Make smoke tests use a temp fixture for destructive tests, so demo memory is not always returned to empty.
4. Add `project_memory_consolidate` examples to README showing how records should survive across sessions.

## Gap 2: Retention Sweep Is Policy-Only

### Current state

`defaultRetentionPolicy()` defines:

- runtime event cap
- terminal output cap
- raw architecture text preference
- generated bundle max bytes
- TTLs by memory type
- stale index policy

`forgetMemory()` handles manual delete/redact/expire/supersede with dry-run default and audit rows. But there is no scheduled or callable tool that reads `retention.json`, finds expired/stale/low-value records, and mutates state.

### Benchmark

agentmemory has `mem::auto-forget`, which:

- deletes TTL-expired memories
- marks near-duplicate/contradictory older memories as non-latest
- deletes old low-value observations
- updates BM25/vector indexes
- writes audit rows

Mem0 exposes scoped delete and delete-all surfaces that require `user_id`, `agent_id`, or `run_id`, preventing accidental global deletion. Graphiti treats changed facts as temporal invalidation instead of blind overwrite.

### Gap

CLI Memo has manual governance but lacks autonomous lifecycle hygiene.

### Build

Add:

- `project_memory_retention_audit`
- `project_memory_retention_sweep`

Rules:

- dry-run default
- apply `ttlDays`, `validUntil`, and `ttlDaysByType`
- expire old `episode`, `evidence`, and `risk` records by policy
- flag old non-latest superseded records
- flag large generated files beyond `generatedBundleMaxBytes`
- never delete `decision`, `procedure`, or high-importance `fact` without explicit selector
- rebuild `index.md`, BM25, entity, vector, handoff, and manifest after execution
- append one audit row with before/after counts

## Gap 3: Update And Supersede Are Not First-Class

### Current state

`addMemory()` writes `version`, `supersedes`, `validUntil`, and `isLatest`. `forgetMemory(mode="supersede")` can mark matching records non-latest and set `supersededBy`. But there is no tool that says: create a new memory version, carry provenance forward, mark old record superseded, and audit the chain.

### Benchmark

Mem0's update path re-embeds the new text, preserves `created_at`, preserves session identifiers if not provided, writes history, removes old entity links, and re-links new entities. agentmemory's `mem::remember` compares new content with latest memories and auto-supersedes similar records by setting the old record non-latest and creating a new version. Graphiti uses validity windows and invalidation, so old truth remains historically inspectable.

### Gap

CLI Memo can represent supersession, but the API does not guide agents through the correct operation.

### Build

Add `project_memory_update`:

- selector: `id` or `ref`
- fields: `title`, `content`, `concepts`, `files`, `confidence`, `importance`, `validUntil`, `ttlDays`
- preserve `createdAt`, `sourceRefs`, and scope by default
- require `reason`
- append audit with changed fields and content hashes
- rebuild all optional indexes

Add `project_memory_supersede`:

- selector: old `id/ref`
- new record input: type/title/content/sourceRefs/reason
- old record: `isLatest=false`, `validUntil=now`, `supersededBy=newId`
- new record: `version=old.version+1`, `supersedes=[oldId, ...old.supersedes]`
- optional `detectSimilar=true` to propose candidates before mutation

## Gap 4: Consolidation Is Deterministic But Shallow

### Current state

`consolidateMemory()` produces candidates from:

- runtime events
- takeover summary state and risks
- architecture recent changes

It deduplicates via hash/source key, filters by confidence, supports dry-run/manual/session/goal/project modes, and writes ready candidates through `addMemory()`.

This is useful and safe. It is not yet a semantic consolidation engine.

### Benchmark

agentmemory groups observations by concept, sends top observations to an LLM consolidation prompt, parses structured XML, and evolves existing memories by title match. LangMem explicitly separates hot-path memory tools from background memory managers that extract, consolidate, and update knowledge. Graphiti depends on structured JSON output for entity/edge extraction and deduplication, preserving episodes as provenance.

### Gap

CLI Memo's consolidation cannot yet infer durable decisions or procedures from messy session logs, and it cannot detect contradiction beyond duplicate-ish source keys.

### Build

Keep deterministic consolidation as the safe default, then add Consolidation V2:

- `mode=semanticDryRun`
- provider config disabled by default
- structured proposal schema validated locally
- sourceRefs required for every proposed claim
- proposal classes: add, update, supersede, expire, reject
- contradiction candidates shown, never auto-mutated at first
- manual execution via candidate IDs

## Gap 5: Retrieval Is Hybrid-Lite, Not Semantic

### Current state

`searchMemory()` is strong as a deterministic grep-first search. It supports filters, source quality, current-goal boosts, changed-file boosts, recency, importance, latest status, and optional fresh indexes.

Optional indexes:

- BM25 cache: `bm25-lite`
- entity cache: `entity-graph-lite`
- vector cache: `lexical-vector-lite`

The vector cache explicitly uses `embeddingProvider: "none"` and `featureModel: "lexical-hash-v1"`.

### Benchmark

Mem0 initializes an embedding model and vector store, then fuses semantic search, BM25 keyword search, and entity boosts. Graphiti combines vector, text, and graph traversal, with temporal relevance. agentmemory's hybrid search combines BM25, vector, graph retrieval, RRF-style ranking, query expansion, and optional reranking.

### Gap

CLI Memo's retrieval is reliable and inspectable, but it will miss paraphrase queries that do not share words or obvious entities.

### Build

Add optional semantic cache:

- config: `CLI_MEMO_MEMORY_EMBEDDER=none|openai|local`
- keep `none` as default
- cache file remains rebuildable under `.project-agent/indexes/`
- every vector result must still return canonical refs
- record embedding metadata: provider, model, dimensions, generatedAt, canonicalHash
- add `project_memory_rebuild_semantic_index`
- update `useIndex=hybrid` to combine deterministic, BM25, entity, and semantic scores

Do not replace grep-first search. Semantic retrieval should be a discovery layer, not the source of truth.

## Gap 6: Code Memory Is Not AST-Grade

### Current state

`server/architecture.js` classifies many source extensions as code, but `CODE_GRAPH_EXTENSIONS` is JS/TS only. `buildCodeGraph()` only processes those extensions with available text, and `buildSymbolGraph()` relies on lightweight symbol/import extraction.

### Benchmark

Probe positions itself as AST-aware structural search with zero setup. Its README emphasizes tree-sitter parsing, complete functions/classes instead of line fragments, boolean query syntax, token caps, deterministic local search, MCP tools, and direct CLI usage.

### Gap

CLI Memo can tell an agent which JS/TS files changed and estimate import impact, but it cannot yet recall cross-language symbols, complete function blocks, or Python/Go/Rust ownership with AST confidence.

### Build

Add a code-memory layer separate from long-term semantic memory:

- `project_code_search`
- `project_code_extract`
- optional tree-sitter parser for JS/TS/Python/Rust/Go first
- path/language/kind filters
- token cap
- complete function/class extraction
- only store symbol metadata and refs by default, not full code text
- let memory records cite code refs, but keep code index rebuildable

This should complement `project_memory_search`, not merge with it.

## Gap 7: Derived State Bloat And Cache Refresh Are Only Partly Solved

### Current state

`project_memory_inventory` classifies source/derived/volatile/index files and marks safe-to-delete surfaces. In the demo project, derived bytes are much larger than source bytes, with a duplication ratio of 15.93. Large generated artifacts include context bundles and continuity detail.

`forgetMemory()` refreshes `index.md`, mutates runtime, and returns handoff refresh targets. The MCP and HTTP wrappers schedule or run broader refreshes. However, optional BM25/entity/vector cache files are not rebuilt during forget execution; they become stale and are ignored by search until rebuilt.

### Benchmark

Basic Memory keeps plain files as source and uses a local SQLite index as secondary infrastructure. The MCP memory reference server stores its graph in a JSONL path configured by `MEMORY_FILE_PATH`. agentmemory removes records from BM25/vector indexes during forget and flushes index persistence.

### Gap

CLI Memo protects correctness by freshness checks, but the user experience can leave stale cache status after mutation. Generated files also still live at `.project-agent/` root instead of a clearer generated directory.

### Build

Add:

- `project_memory_rebuild_all_indexes`
- optional automatic rebuild after forget/consolidate/update/supersede
- `project_memory_refresh_derived`
- `project_memory_cleanup_generated` with dry-run default
- migration target `.project-agent/generated/`

Retention should treat generated state as disposable cache. Canonical records and source state should remain outside cleanup by default.

## Gap 8: Privacy Policy Is Not Fully Enforced

### Current state

`addMemory()` redacts secret-like text in title/content. `buildMemoryInventory()` scans small text files and flags `secret_like_text`, `raw_runtime_events`, and `architecture_snapshot_text`.

But architecture persistence still stores raw `text` for diffable files inside `runtime.architectureSnapshot`. That conflicts with the retention policy preference `allowRawArchitectureText: false`.

### Benchmark

File-native memory systems are strong because users can inspect and delete actual files. agentmemory adds explicit governance delete and access-log deletion. Graphiti can disable or limit raw episode content with constructor options such as `store_raw_episode_content`.

### Gap

CLI Memo can detect risky raw storage, but policy does not yet control every writer.

### Build

1. Centralize sanitization in one module.
2. Make architecture persistence honor `retention.json.limits.allowRawArchitectureText`.
3. Store hashes, symbols, imports, and snippets instead of full text by default.
4. Add `project_memory_privacy_audit`.
5. Add redaction cascade for:
   - canonical memory
   - runtime events
   - architecture snapshots
   - generated handoff files
   - indexes
6. Add tests with fake secrets proving no raw secret remains after refresh.

## Gap 9: Read/Access Audit Is Missing

### Current state

`queryMemoryAudit()` exposes append-only lifecycle rows for add, forget, index rebuild, and consolidation. Search and read operations are not recorded as access events.

### Benchmark

agentmemory has an access tracker with count, last access time, and bounded recent timestamps, and delete paths remove access logs for deleted memories.

### Gap

CLI Memo can answer "what changed memory?" but not "what memory did agents actually use?" This weakens retention scoring and product analytics.

### Build

Add optional bounded access logging:

- off or lightweight by default
- record memory id, tool, timestamp, query hash, agent id
- do not store raw query text unless configured
- use access counts in retention audit and search explain
- delete access rows during forget

## Gap 10: External Agent E2E And Doctor Are Thin

### Current state

The MCP server exists and the local smoke test passes. `GET /api/agent/bootstrap` exposes a bootstrap kit. The project does not yet have an automated end-to-end test that installs the MCP config into Codex/Claude-style clients and proves takeover + harness + read/write/forget works through stdio.

### Benchmark

Basic Memory and Probe publish explicit MCP snippets, direct CLI modes, status/doctor-like flows, and clear install paths. agentmemory positions itself as cross-client memory for Claude Code, Codex CLI, Cursor, Gemini CLI, and other MCP clients.

### Gap

CLI Memo's integration is viable but still mostly developer-local. Handoff to a new user or new client needs a doctor and e2e script.

### Build

Add:

- `npm run doctor:mcp`
- `npm run e2e:mcp`
- `npm run e2e:codex`
- `npm run e2e:claude`
- generated MCP config snippets in `project_agent_bootstrap`
- assertions:
  - `project_takeover_summary` returns lifecycle and memory harness
  - `project_memory_add/read/search/forget` work over stdio
  - dry-run forget is non-mutating
  - executed forget refreshes handoff and all indexes

## Recommended Build Order

### P0: Make Lifecycle Real

1. Dogfood seed/consolidation so the project has durable canonical records.
2. Add `project_memory_update`.
3. Add `project_memory_supersede`.
4. Add `project_memory_retention_audit`.
5. Add `project_memory_retention_sweep`.

### P1: Make Retrieval And Maintenance Production-Grade

6. Add rebuild-all-indexes and automatic cache refresh after memory mutations.
7. Add Consolidation V2 semantic dry-run with optional provider.
8. Add optional provider-backed semantic vector cache.
9. Enforce raw architecture text policy and add privacy audit.
10. Add generated cleanup/migration path.

### P2: Make It Great For Coding Agents

11. Add tree-sitter/probe-like code search/extract.
12. Add bounded read/access audit.
13. Add Codex/Claude MCP e2e and doctor commands.

## Product Positioning After Benchmark

CLI Memo should not try to become Mem0 or Graphiti directly. Its strongest differentiator is project-control memory for coding agents:

- file-native canonical memory
- exact refs as proof
- grep-first deterministic search
- MCP tools agents can autonomously call
- handoff/control-plane state
- governed delete/redaction
- optional semantic/code indexes as rebuildable caches

The missing work is not a new architecture. It is closing the lifecycle loop: update, supersede, expire, sweep, privacy enforcement, cache refresh, and real dogfood memory.
