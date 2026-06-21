# Canonical Memory Implementation Steps

Date: 2026-06-12

## Current Judgment

CLI Memo already has strong handoff and control-plane memory. It can help an incoming agent resume work through takeover summaries, process traces, architecture maps, runtime events, and audit checks.

It does not yet have canonical long-term memory. It cannot fully answer:

- what do you remember about this project?
- why do you remember it?
- where did that claim come from?
- when does it expire?
- what exactly will be deleted if I forget it?

The next memory work should therefore build a grep-first, file-native canonical memory layer before adding smarter retrieval.

Update, 2026-06-15: the canonical layer and P0 lifecycle closure exist. The current P1/P2 tranche adds control-plane quality gates: rebuild all indexes from canonical memory, audit privacy/provenance policy, clean rebuildable generated state, record bounded harness read/search access, and produce governed Consolidation V2 add/update/supersede/expire proposals.

## Architecture Decision

Canonical memory is plain project state. Indexes are caches.

```text
canonical files
  -> exact ref read
  -> keyword / rg / FTS / BM25
  -> optional vector rerank
  -> optional entity graph traversal
  -> cited context pack
```

Rules:

1. Canonical memory lives in `.project-agent/memory/`.
2. Generated handoff files are rebuildable and disposable.
3. Every durable memory has source refs.
4. `project_read_ref` remains the final authority for exact evidence.
5. Search results return citations, not unsupported prose.
6. Delete and redaction mutate source files first, then refresh generated files and indexes.
7. Vector and graph indexes are optional rebuildable caches, never source of truth.

## Roadmap Execution Note: Agent Bootstrap Kit, 2026-06-13

Benchmark / need analysis: incoming agents should not ask users which memory files to inspect. They need a machine-readable bootstrap contract that names the first tool and the automatic memory harness call.

Architecture / best code: `buildAgentBootstrapKit()` now emits `project-agent.agent-bootstrap.v1` with provider configs, `firstCall=project_takeover_summary`, `automaticHarness=project_memory_harness`, hybrid memory index preference, and ordered context/read/event protocol.

Deployment: `GET /api/agent/bootstrap` exposes the kit without writing state, while `/api/cli-agent-bootstrap` keeps the markdown fallback and returns the same `bootstrapKit`.

UI testing: Product tab now includes Agent Bootstrap, and smoke coverage verifies the bootstrap API, no manual user step flag, automatic memory harness, protocol tools, and UI source wiring. Browser QA remains required for desktop/mobile rendered validation.

## Roadmap Execution Note: Memory Lifecycle P0, 2026-06-15

Benchmark / need analysis: `docs/research/memory-gap-deep-benchmark.md` concluded that CLI Memo is not missing a memory architecture; it is missing lifecycle closure. The immediate gap is dogfood seed, update/supersede, retention audit/sweep, hard cache refresh, and harness-visible lifecycle routing.

Architecture / best code: `server/memory-store.js` now keeps canonical JSONL as source of truth and adds `seedDogfoodMemory`, `updateMemory`, `supersedeMemory`, `auditMemoryRetention`, and `sweepMemoryRetention`. All executed write paths use a shared refresh path for `.project-agent/memory/index.md`, BM25, entity, and lexical-vector caches.

Deployment: MCP exposes `project_memory_seed_dogfood`, `project_memory_update`, `project_memory_supersede`, `project_memory_retention_audit`, and `project_memory_retention_sweep`. HTTP mirrors them with `/api/memory/seed-dogfood`, `/api/memory/update`, `/api/memory/supersede`, `/api/memory/retention`, and `/api/memory/retention/sweep`.

UI testing: Project map -> Memory shows dogfood and retention lifecycle cards plus a harness lifecycle strip. Smoke tests cover MCP and HTTP seed/update/supersede/retention flows, audit rows, post-write searchability, and fresh optional indexes.

## Roadmap Execution Note: Launcher Lifecycle, 2026-06-13

Benchmark / need analysis: project memory should be pulled through machine-readable harnesses, not by asking users to manually inspect state files or terminal logs. The same rule now applies to multi-project runtime control: spawned projects need durable log refs and API-visible lifecycle state so an AI can decide when to read logs, stop, or restart.

Architecture / best code: launcher state remains local-only and file-native. `server/project-launcher.js` now writes bounded JSONL process logs under `.project-agent/launcher-logs/`, returns explicit log refs in project summaries, and separates launch-plan (`project-agent.project-launch-plan.v1`), control (`project-agent.project-launch-control.v1`), and logs (`project-agent.project-launcher-logs.v1`) responses.

Deployment: `GET /api/projects/logs`, `POST /api/projects/stop`, and `POST /api/projects/restart` landed with sandbox permission metadata, README commands, runtime events, and Product tab controls.

UI testing: `npm run build`, `npm test`, and Browser QA passed. Desktop verified visible Plan/Restart/Logs/Stop controls and a persisted logs panel; 390px mobile verified wrapped controls and no Project Launcher section overflow.

## Target Layout

```text
.project-agent/
  state.json
  runtime.json
  memory/
    index.md
    episodes.jsonl
    facts.jsonl
    decisions.jsonl
    procedures.jsonl
    evidence.jsonl
    risks.jsonl
    audit.jsonl
    access.jsonl
    retention.json
  generated/
    takeover-summary.json
    takeover-packet.json
    process-trace.json
    architecture-map.json
    memory-graph.json
    agent-context-bundle.json
  indexes/
    bm25.sqlite
    vector.sqlite
    graph.json
```

Migration note: existing root-level generated files can stay where they are in the first implementation. The `generated/` directory is the target cleanup after the canonical store is working.

## Roadmap Execution Note: P1/P2 Memory Quality, 2026-06-15

Benchmark / need analysis: after P0, the remaining gap was not storage. It was operational trust: agents need to know whether indexes are fresh, whether memory contains secret-like or weakly sourced claims, whether generated files can be safely cleaned, and which memory records were automatically injected by the harness.

Architecture / best code: keep canonical JSONL as source of truth and make every smarter layer rebuildable or inspectable. `project_memory_rebuild_all_indexes` rebuilds `index.md`, BM25, entity, and lexical-vector caches. `project_memory_privacy_audit` scans canonical records and bounded state files for policy findings. `project_memory_generated_cleanup` defaults to dry-run and protects active handoff files unless explicitly targeted. `project_memory_access_audit` stores bounded `access.jsonl` rows for harness search/read calls. `project_memory_consolidate_v2` stays proposal-first and local: it uses semantic-signals-lite matching and retention policy, while provider-backed embeddings remain future-gated.

Deployment: MCP exposes the five P1/P2 memory tools; HTTP mirrors them through `/api/memory/indexes/rebuild-all`, `/api/memory/privacy`, `/api/memory/generated-cleanup`, `/api/memory/consolidate-v2`, and `/api/memory/access-audit`. The Memory UI shows Privacy, Access, V2, Cleanup, Rebuild all, and Preview cleanup surfaces.

UI testing: `npm test` verifies MCP and HTTP coverage for rebuild-all, privacy audit, generated cleanup dry-run/execution, V2 retention proposals, bounded access audit rows, code search, agent doctor, and UI source markers.

## Step 1: `project_memory_inventory`

Goal: make memory visible before making it smarter.

Build:

- Add a memory inventory module that scans `.project-agent`.
- Classify files as `source`, `derived`, `volatile`, `index`, or `unknown`.
- Count bytes, records, raw text exposure, generated duplication, stale files, and missing expected files.
- Detect risky storage such as architecture snapshot text, terminal output tails, large bundles, and secret-like strings.
- Expose MCP tool `project_memory_inventory`.

Output should answer:

- what exists?
- what is source vs derived?
- what is safe to delete and rebuild?
- what might contain raw sensitive text?
- which memory surfaces are growing?

Acceptance:

- Works before `.project-agent/memory/` exists.
- Returns a clean `not_started` or `no_canonical_memory` state when appropriate.
- Does not mutate files.
- Includes exact refs for every file it reports.
- Has smoke coverage through the MCP client.

## Step 2: Canonical `.project-agent/memory/*.jsonl` Store

Goal: create source-of-truth long-term memory files.

Build:

- Add `server/memory-store.js`.
- Add JSONL read/write helpers with atomic writes.
- Add stable ids such as `mem_...`, `aud_...`, `ret_...`.
- Add schema validation for each record type.
- Add `audit.jsonl` append-only records for memory writes, updates, deletes, redactions, and consolidations.
- Add `retention.json` for limits and policy defaults.

Initial files:

- `episodes.jsonl`: what happened in a run or session.
- `facts.jsonl`: durable project facts.
- `decisions.jsonl`: decisions and rationale.
- `procedures.jsonl`: repeatable workflows and known fixes.
- `evidence.jsonl`: test results, command evidence, screenshots, reports.
- `risks.jsonl`: known blockers, hazards, stale assumptions.
- `audit.jsonl`: memory lifecycle log.

Common record shape:

```json
{
  "id": "mem_...",
  "type": "decision",
  "title": "Short durable title",
  "content": "Durable memory text",
  "scope": {
    "project": "project-agent-terminal",
    "goalId": "goal_...",
    "agentId": "optional"
  },
  "sourceRefs": [".project-agent/runtime.json#events[0]"],
  "files": ["server/runtime-state.js"],
  "concepts": ["memory", "handoff"],
  "confidence": 0.9,
  "importance": 7,
  "createdAt": "2026-06-12T00:00:00.000Z",
  "updatedAt": "2026-06-12T00:00:00.000Z",
  "validFrom": "2026-06-12T00:00:00.000Z",
  "validUntil": null,
  "ttlDays": null,
  "version": 1,
  "supersedes": [],
  "isLatest": true,
  "redaction": {
    "status": "clean",
    "rules": []
  }
}
```

Acceptance:

- `project_start` creates the memory directory and empty canonical files.
- Existing projects can be refreshed without losing existing `.project-agent` state.
- Empty canonical memory is a valid state.
- Invalid JSONL records are reported by inventory and audit, not silently ignored.

## Step 3: `project_memory_add`, `project_memory_read`, `project_memory_search`

Goal: let agents write and retrieve typed long-term memory.

Build:

- Add MCP tool `project_memory_add`.
- Add MCP tool `project_memory_read`.
- Add MCP tool `project_memory_search`.
- Add MCP tool `project_memory_update` for provenance-preserving in-place version increments.
- Search canonical JSONL and `index.md` with deterministic text scoring first.
- Use exact source refs and snippets in every result.
- Keep `project_context_search` as the broad project grep tool; make `project_memory_search` only search canonical memory.

Search should score:

- exact id/ref match
- title/content keyword match
- file/path match
- concept match
- recency
- importance
- current goal scope
- `isLatest`

Result shape:

```json
{
  "id": "mem_...",
  "type": "procedure",
  "title": "Run API tests with local Redis",
  "score": 42,
  "scoreBreakdown": {
    "keyword": 20,
    "path": 8,
    "recency": 6,
    "importance": 8
  },
  "refs": [
    ".project-agent/memory/procedures.jsonl#mem_...",
    "docs/quality/test-strategy.md:18"
  ],
  "snippet": "API tests require local Redis before running the integration suite."
}
```

Acceptance:

- Add returns the written record and canonical ref.
- Read can fetch by id or canonical ref.
- Search is deterministic with embeddings disabled.
- Search never returns a claim without a canonical ref.
- Smoke tests cover add, read, search, and exact ref round trip.

## Step 4: `project_memory_forget`

Goal: make memory deletion safer than memory creation.

Build:

- Add MCP tool `project_memory_forget`.
- Require `dryRun: true` by default unless explicitly disabled.
- Support forgetting by id, type, file, source ref, concept, date range, goal id, or generated artifact.
- Support modes: `delete`, `redact`, `expire`, `supersede`.
- Report every affected canonical record, runtime event, generated file, and index entry before mutation.
- After mutation, refresh takeover files, state manifest, memory graph, and context bundle.
- Append audit rows for dry-run and execution.

Cascade targets:

- `.project-agent/memory/*.jsonl`
- `.project-agent/runtime.json`
- architecture snapshot raw text, if targeted
- generated takeover/context files
- future FTS/vector/entity indexes
- state manifest hashes

Acceptance:

- Dry-run explains exactly what would change.
- Executed forget removes or redacts canonical records.
- Generated files no longer contain deleted/redacted content after refresh.
- Search no longer returns deleted records.
- Audit records who/what/when/why and before/after refs.
- Forget works even when optional indexes are missing.
- Executed forget refreshes `index.md`, BM25, entity, and lexical-vector caches.

## Step 5: `project_memory_consolidate`

Goal: turn raw process traces into durable project knowledge.

Status: landed in the current tranche. `project_memory_consolidate` now produces dry-run candidates from runtime events, handoff risks, and architecture changes; explicit execution writes ready candidates to canonical memory, keeps low-confidence candidates as proposals, and skips duplicates by consolidation hash.

Build:

- Add MCP tool `project_memory_consolidate`.
- Promote runtime events, evidence, handoff summaries, and architecture changes into typed canonical memories.
- Detect candidates for facts, decisions, procedures, risks, and episodes.
- Merge duplicates.
- Supersede older memories when new evidence changes the truth.
- Use `project_memory_supersede` for explicit version-chain replacement when new evidence changes the truth.
- Keep links back to source runtime refs and files.

Consolidation modes:

- `dryRun`: list proposed memories.
- `manual`: create records from selected candidates.
- `goal`: consolidate only the active goal.
- `session`: consolidate recent runtime events.
- `project`: broader periodic cleanup.

Acceptance:

- Consolidation does not create memories without source refs.
- Re-running consolidation is idempotent or produces explicit supersession.
- Low-confidence candidates remain proposals, not durable memory.
- New procedures and decisions show up in `project_memory_search`.
- Audit records every created or superseded memory.

## Step 6: Lifecycle Closure

Goal: make memory maintenance callable by AI harnesses, not manual file editing.

Status: P0 landed.

Build:

- Add `project_memory_seed_dogfood` to create stable, idempotent product dogfood records from the benchmark docs when present.
- Add `project_memory_update` to mutate exactly one canonical memory, preserve created/source/scope fields by default, increment version, write changed fields and content hashes to audit, and refresh all memory indexes.
- Add `project_memory_supersede` to create a new canonical record, mark the old record `isLatest=false`, set `supersededBy`, carry `supersedes`, and preserve historical inspectability.
- Add `project_memory_retention_audit` and `project_memory_retention_sweep`; audit is non-mutating, sweep defaults to dry-run and only expires eligible records.
- Make `project_memory_harness` expose dogfood/retention lifecycle status and governed next calls.

Acceptance:

- Dogfood seed is idempotent and searchable.
- Update and supersede both require a reason and append audit rows.
- Superseded records disappear from `latestOnly` search while remaining readable by ref.
- Retention sweep marks expired records non-latest instead of deleting durable decisions/procedures.
- Post-write search can use fresh BM25/entity/vector caches.

## Step 7: Optional Indexes

Goal: improve fuzzy recall without weakening source-of-truth guarantees.

Status: partially landed. The FTS/BM25 slot is implemented as a local rebuildable `bm25-lite` cache at `.project-agent/indexes/memory-bm25.json`; the entity graph slot is implemented as a local rebuildable `entity-graph-lite` cache at `.project-agent/indexes/memory-entities.json`; the first vector tranche is implemented as a local rebuildable `lexical-vector-lite` cache at `.project-agent/indexes/memory-vectors.json` with `embeddingProvider: none`. Remote embedding stores remain future-gated.

Build order:

1. FTS/BM25 index over canonical JSONL and `index.md`. Landed as `project_memory_rebuild_index`, `/api/memory/index`, opt-in `useIndex=bm25` direct search, and automatic fresh-cache use inside `project_memory_harness`.
2. Entity extraction into rebuildable `indexes/memory-entities.json`. Landed as `project_memory_rebuild_entity_index`, `/api/memory/entity-index`, opt-in `useIndex=entity|hybrid` direct search, and automatic fresh-cache hybrid use inside `project_memory_harness`.
3. Optional local vector index. First tranche landed as `project_memory_rebuild_vector_index`, `/api/memory/vector-index`, opt-in `useIndex=vector|hybrid` direct search, and automatic fresh-cache hybrid use inside `project_memory_harness`.
4. Optional remote embedding/vector store into `indexes/vector.sqlite` or equivalent provider-backed cache.
5. Optional reranking that explains which signals were used.

Current vector tranche:

- Cache file: `.project-agent/indexes/memory-vectors.json`.
- Engine: `lexical-vector-lite`.
- Input: canonical memory title/content/type/concepts/refs only.
- Scoring: sparse hashed lexical features with cosine similarity.
- Safety: `embeddingProvider: none`; no network calls; cache can be deleted and rebuilt from canonical files.
- Search proof: `ranking.optionalIndexes.vector.used` and `scoreBreakdown.vector` appear only when the cache is fresh and requested or automatically selected by the harness.

Rules:

- Indexes are never required for correctness.
- Indexes can be deleted and rebuilt from canonical files.
- Deleting memory must remove stale index entries immediately or mark the index stale.
- Search responses must still cite canonical refs.

Acceptance:

- `project_memory_search` works when indexes are absent.
- `project_memory_inventory` reports index freshness.
- Rebuild produces the same canonical ids and refs.
- Indexed search reports `ranking.optionalIndexes.bm25.used` and `scoreBreakdown.bm25` only when the cache is fresh and explicitly requested.
- Optional vector/entity search improves recall but does not invent unsupported claims.

## Cross-Cutting Requirements

### Sanitization

All write paths must use one sanitizer:

- MCP memory add/update
- runtime event ingestion
- hook ingress
- terminal/agent-run evidence
- consolidation
- architecture snapshot capture

### Retention

Retention must be explicit and inspectable:

- max runtime events
- max terminal output bytes
- whether raw architecture text is allowed
- TTL defaults by memory type
- generated bundle size limits
- stale index policy

### Tests

Each step needs:

- unit tests for JSONL store and schema validation
- MCP smoke tests through a real stdio client
- dry-run mutation tests for forget
- refresh/cascade tests for generated files
- regression test that deleted memory does not appear in search

### UI

The UI should eventually show:

- memory inventory
- canonical memory list
- source vs generated badges
- forget dry-run preview
- audit timeline
- index freshness for BM25, entity, and local vector caches

## Implementation Order

1. `project_memory_inventory`
2. `.project-agent/memory/*.jsonl` canonical store
3. `project_memory_add`
4. `project_memory_read`
5. `project_memory_search`
6. `project_memory_forget` with dry-run and cascade refresh
7. `project_memory_consolidate`
8. Lifecycle closure: dogfood seed, update, supersede, retention audit/sweep, and cache cascade refresh
9. FTS/BM25 index
10. Optional entity graph
11. Optional local vector index
12. Optional remote/provider-backed vector index

Do not build vector/entity retrieval before forget exists. The product should first know what it stores and how to delete it.
