# Agent Memory Architecture Benchmark

Date: 2026-06-08

## Purpose

This benchmark studies public GitHub agent-memory projects and extracts the parts CLI Memo should adopt. The focus is not "which repo has more tools"; it is how memory is captured, normalized, retrieved, consolidated, audited, and forgotten.

## Projects Reviewed

| Project | Primary lesson | Fit for CLI Memo |
| --- | --- | --- |
| `rohitg00/agentmemory` | Coding-agent memory should be a runtime with hooks, MCP tools, observations, semantic memories, hybrid retrieval, consolidation, retention, and governance delete. | High. This is the closest reference for coding-agent workflows. |
| `modelcontextprotocol/servers` memory server | A minimal MCP memory server is a knowledge graph of entities, relations, and atomic observations with explicit create/read/search/delete tools. | High as the minimal MCP contract baseline. |
| `mem0ai/mem0` and Mem0 MCP | Production memory needs scopes, API/SDK access, semantic search, entity-aware retrieval, and explicit update/delete surfaces. | Medium-high. Useful for user/session/agent scoping and CRUD discipline. |
| `letta-ai/letta` | Separate always-visible core memory from searchable archival memory; memory blocks need labels, descriptions, limits, read-only flags, and deletion. | High. Useful for deciding what enters takeover context vs what stays searchable. |
| `getzep/graphiti` | Temporal memory should preserve provenance, validity windows, superseded facts, and hybrid graph/keyword/vector retrieval. | Medium-high. Useful for decisions and architecture facts that change over time. |
| `langchain-ai/langmem` | Memory can run in the hot path as agent tools, or in the background as extraction/consolidation/update jobs. | Medium. Useful as an integration pattern, less as a full product architecture. |
| `agentralabs/agentic-memory` | A memory product needs operational modes, backups, retention, budget policies, and maintenance loops. | Medium. Useful for product reliability and local-first operation. |

Sources:

- https://github.com/rohitg00/agentmemory
- https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- https://github.com/mem0ai/mem0
- https://github.com/mem0ai/mem0-mcp
- https://github.com/letta-ai/letta
- https://docs.letta.com/guides/core-concepts/memory/memory-blocks
- https://docs.letta.com/guides/core-concepts/memory/archival-memory
- https://docs.letta.com/guides/core-concepts/memory/context-hierarchy
- https://github.com/getzep/graphiti
- https://github.com/langchain-ai/langmem
- https://github.com/agentralabs/agentic-memory

## Benchmark Dimensions

### 1. Capture

Mature systems do not wait for a human to manually write notes. They capture from:

- agent tool calls and command execution
- user prompts and assistant messages
- file reads/writes/edits
- session starts/stops/handoffs
- explicit "remember this" calls
- background import of transcripts or logs

CLI Memo currently captures project events, hook ingress, terminal/agent-run events, architecture snapshots, and state actions. It should add a canonical memory-write path so captured events can become typed memory units instead of only runtime events and generated handoff files.

### 2. Memory Taxonomy

The strongest pattern is a layered taxonomy:

- working memory: current goal, cursor, next action, blockers
- episodic memory: what happened in a run/session
- semantic memory: facts, decisions, architecture constraints, preferences
- procedural memory: reliable workflows, failure fixes, runbooks
- governance memory: deletions, redactions, provenance, audit trails

CLI Memo currently has working/process memory and handoff memory. It does not yet have first-class episodic/semantic/procedural memory records.

### 3. Source Of Truth Vs Derived Context

Good systems keep canonical memory units separate from generated context. Generated bundles are disposable; canonical memory is governed.

Recommended model for CLI Memo:

```text
.project-agent/
  memory/
    episodes.jsonl
    facts.jsonl
    decisions.jsonl
    procedures.jsonl
    evidence.jsonl
    audit.jsonl
    index.json
    retention.json
  runtime.json
  state.json
  generated/
    takeover-summary.json
    takeover-packet.json
    agent-context-bundle.json
    process-trace.json
```

The current system mixes canonical and derived files in `.project-agent/`. That makes deletion and redaction harder because the same fact can exist in several generated artifacts.

### 4. Retrieval

Best-in-class systems combine multiple signals:

- exact ref read for provenance
- keyword/BM25 search for deterministic lookup
- vector search for semantic paraphrase
- graph/entity traversal for relationships
- recency and validity windows for current truth
- reranking or explanation for why a memory surfaced

CLI Memo's grep-first search is a good deterministic base. The missing layer is a typed index over memory units, with optional vector reranking and provenance-first result explanations.

### 5. Consolidation And Evolution

Mature systems do not treat every observation as permanent truth. They consolidate and evolve:

- observations become durable semantic memories
- repeated failures become procedures
- newer facts supersede older facts
- low-value or expired items decay
- derived facts keep links to source episodes

CLI Memo generates summaries, memory graphs, and takeover packets, but these are mostly handoff artifacts. It needs a consolidation job that writes canonical memory records with `sourceRefs`, `confidence`, `version`, `supersedes`, and `validUntil`.

### 6. Forgetting, Deletion, And Audit

This is the biggest gap in CLI Memo.

Public references expose deletion at different levels:

- MCP reference memory: delete entities, relations, and observations.
- Mem0 MCP: delete one memory, bulk delete memories, delete entities.
- Letta: delete memory blocks and manage archival memories through SDK endpoints.
- agentmemory: `mem::forget`, `mem::auto-forget`, and governance delete with audit rows.
- Graphiti: invalidates old facts while preserving temporal history and provenance.

CLI Memo currently mostly appends, overwrites generated files, and caps runtime arrays. It does not have a semantic `forget` path that deletes from source records, indexes, generated bundles, and manifests together.

### 7. Agent Interface

The right MCP surface should separate project control-plane tools from memory tools.

Current CLI Memo MCP tools:

- `project_start`
- `project_takeover_summary`
- `project_context_search`
- `project_read_ref`
- `project_record_event`
- `project_architecture_changes`
- `project_handoff_audit`

Recommended next tools:

- `project_memory_inventory`: list memory surfaces, sizes, counts, derived-vs-source status, and risky raw-text storage.
- `project_memory_add`: write a typed memory record with scope, refs, confidence, and optional TTL.
- `project_memory_search`: search typed memory, explain score, return exact refs.
- `project_memory_read`: read one canonical memory and its provenance.
- `project_memory_supersede`: mark a fact/procedure/decision as evolved by a newer one.
- `project_memory_forget`: dry-run and execute deletion/redaction with cascade into indexes and generated files.
- `project_memory_consolidate`: promote events/evidence into durable typed memory.
- `project_memory_audit`: query memory writes, reads, redactions, and deletes.

## What CLI Memo Should Learn

1. Make canonical memory units explicit.
2. Keep generated handoff files disposable.
3. Add a deletion/redaction cascade before adding more capture surfaces.
4. Preserve provenance for every derived claim.
5. Separate always-in-context takeover state from searchable long-term memory.
6. Add typed memory: episode, fact, decision, procedure, evidence, preference, risk.
7. Add versioning and supersession instead of overwriting facts silently.
8. Keep grep-first retrieval, then add optional vector/entity reranking.
9. Add memory inventory and budget checks so the product can explain what it stores.
10. Treat retention policy as product UX, not an internal cleanup script.

## Proposed CLI Memo Memory Model

```json
{
  "id": "mem_...",
  "type": "decision|fact|procedure|episode|evidence|risk|preference",
  "scope": {
    "project": "project-agent-terminal",
    "goalId": "goal_...",
    "agentId": "optional"
  },
  "title": "Short title",
  "content": "Durable memory text",
  "sourceRefs": [
    ".project-agent/runtime.json#events[0]",
    "server/runtime-state.js:3066"
  ],
  "files": ["server/runtime-state.js"],
  "concepts": ["memory", "retention", "handoff"],
  "confidence": 0.9,
  "importance": 7,
  "createdAt": "2026-06-08T00:00:00.000Z",
  "updatedAt": "2026-06-08T00:00:00.000Z",
  "validFrom": "2026-06-08T00:00:00.000Z",
  "validUntil": null,
  "ttlDays": null,
  "version": 1,
  "supersedes": [],
  "isLatest": true,
  "redaction": {
    "status": "clean|redacted|unknown",
    "rules": []
  }
}
```

## Recommended Build Order

1. `project_memory_inventory`
   - Count source files, derived files, runtime events, architecture snapshot raw text, generated bundle bytes.
   - Output what is safe, risky, duplicated, and deletable.

2. Canonical memory store
   - Add `.project-agent/memory/*.jsonl`.
   - Start with `episodes`, `facts`, `decisions`, `procedures`, `evidence`, `audit`.

3. `project_memory_add/read/search`
   - Deterministic keyword search first.
   - Return exact `sourceRefs`; never return unsupported claims without provenance.

4. `project_memory_forget`
   - Always support dry-run first.
   - Delete/redact canonical records, runtime records, architecture snapshot text, generated files, and indexes.
   - Regenerate handoff files after mutation.

5. `project_memory_consolidate`
   - Promote runtime events and evidence into typed long-term memories.
   - Detect duplicates and superseded facts.

6. Optional vector/entity index
   - Keep it behind a flag.
   - Explain whether each match came from keyword, vector, graph, recency, or exact ref.

## Product Position

CLI Memo should not become a generic personal-memory product. Its strongest wedge is project memory for coding agents: goal state, handoff continuity, architecture impact, evidence, decisions, procedures, and recovery. That means it should borrow the lifecycle machinery from agentmemory/Mem0/Letta/Graphiti, but keep the memory schema biased toward software work.

