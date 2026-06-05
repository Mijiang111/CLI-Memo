# Agent Governance Benchmark

Last updated: 2026-06-04

This note records a source-level benchmark of adjacent GitHub projects for Project Agent Terminal. The goal is not to copy a memory database, an observability platform, or a code wiki generator. The goal is to learn which architecture patterns make cross-agent continuity reliable, visible, and auditable.

## Local Evidence Set

All benchmark repositories were shallow-cloned under `work/benchmarks/` and read from source, not just from README claims.

| Project | Local directory | Commit | Category |
| --- | --- | --- | --- |
| rohitg00/agentmemory | `work/agentmemory` | `fd9e3bd` | coding-agent memory runtime |
| axiomhq/agent-memory | `work/benchmarks/axiomhq-agent-memory` | `7207541` | journal-to-memory pipeline |
| ravbyte-ai/agent-memory-system | `work/benchmarks/ravbyte-agent-memory-system` | `1f72872` | repo memory + handoff |
| akitaonrails/ai-memory | `work/benchmarks/akitaonrails-ai-memory` | `fbc85dd` | hook-driven Rust memory service |
| getzep/graphiti | `work/benchmarks/getzep-graphiti` | `34f56e6` | temporal knowledge graph |
| repowise-dev/repowise | `work/benchmarks/repowise-dev-repowise` | `413e829` | codebase intelligence |
| CodeBoarding/CodeBoarding | `work/benchmarks/codeboarding-codeboarding` | `74ee4d5` | architecture diagram generation |
| yamadashy/repomix | `work/benchmarks/yamadashy-repomix` | `eb54625` | repo prompt packing |
| cyclotruc/gitingest | `work/benchmarks/cyclotruc-gitingest` | `4e259a0` | repo digest generation |
| mem0ai/mem0 | `work/benchmarks/mem0ai-mem0` | `74771b4` | general AI memory API |
| AgentOps-AI/agentops | `work/benchmarks/agentops-ai-agentops` | `a855a92` | agent observability |
| Arize-ai/phoenix | `work/benchmarks/arize-ai-phoenix` | `9390732` | traces, evals, prompt observability |
| langchain-ai/langgraph | `work/benchmarks/langchain-ai-langgraph` | `43682f0` | durable workflow checkpoints |

## Evaluation Frame

I used seven criteria because they map to the product promise:

1. Capture: how events enter the system.
2. Structure: how raw events become durable knowledge.
3. Retrieve: how agents find the right context.
4. Verify: how freshness, safety, and acceptance are checked.
5. Disclose: how the next agent receives only the useful state.
6. Govern: how goals, decisions, risks, and open work become first-class.
7. See: whether humans can inspect and steer the system.

## Headline Finding

The open-source landscape is split into strong single-purpose systems:

| Product shape | Strong examples | What they solve | What remains open |
| --- | --- | --- | --- |
| Memory runtime | rohitg00/agentmemory, mem0 | storing and retrieving facts across agents | project process, architecture, acceptance, and visual takeover |
| Journal to wiki | axiomhq/agent-memory, akitaonrails/ai-memory | turning raw session data into durable pages | product workbench and explicit project-goal governance |
| Handoff folder | ravbyte-ai/agent-memory-system | deterministic repo context and next-agent handoff | deeper temporal provenance and live UI |
| Temporal graph | Graphiti | fact validity, provenance, hybrid graph retrieval | coding-agent workflow semantics |
| Code intelligence | RepoWise, CodeBoarding | architecture, risk, call graph, decision context | session continuity and agent handoff |
| Prompt packing | Repomix, Gitingest | bounded code context for LLMs | durable state and governance |
| Observability/runtime | AgentOps, Phoenix, LangGraph | traces, spans, evals, checkpoints | project-specific takeover contract |

Project Agent Terminal should position as the visible governance layer around any coding agent: it can consume memory, trace, code graph, and checkpoint signals, but its unique job is to bind them into a project takeover state machine.

## Source-Level Notes

### Axiom Agent Memory

Key files:

- `src/schema.ts`
- `src/journal.ts`
- `src/machines/consolidate.ts`
- `src/prompts/defrag.ts`
- `src/agents-md/generator.ts`
- `docs/adr/0001-notes-and-links-memory-model.md`

Architecture:

- Capture is a validated journal queue. `JournalQueueEntrySchema` normalizes harness events into `version`, `timestamp`, `harness`, `retrieval`, and `context`.
- Pending entries live as JSON under an inbox directory, then move to `.processed`.
- Consolidation is an XState machine: load queue, fetch history, list existing notes, run agent, parse output, write entries, mark processed, commit changes.
- The current model is notes-and-links. Importance is meant to emerge from links and top-of-mind index notes rather than stored usage counters.
- AGENTS.md disclosure is a boundary artifact, generated from the memory archive and the top-of-mind selection.

Useful for us:

- Treat workflow as data. Our agent-run and takeover flow should be replayable from structured state, not only terminal logs.
- Keep disclosure separate from storage. The next-agent prompt is an output view, not the memory database itself.
- Use an explicit top-of-mind mechanism for the small amount of state that should be inlined.

Limitations:

- It is file-centric and CLI-centric, with little human-visible workbench.
- It does not solve architecture awareness, QA acceptance, or multi-workstream project governance.

### RAVBYTE Agent Memory System

Key files:

- `src/generator/generate.ts`
- `src/agent-log/store.ts`
- `src/validators/rules.ts`
- `src/graph/builder.ts`
- `memory/agent-handoff.md`
- `memory/agent-worklog.jsonl`

Architecture:

- Scanner generates a fixed `memory/` folder: overview, repository map, architecture, workflow, APIs, storage, security, testing, issues, guidelines.
- Worklog is append-only JSONL and handoff is regenerated from recent events.
- Handoff includes current state, recent events, next steps, mentioned files, and optional graph annotations.
- Validator checks required files, Last Updated freshness, repository graph freshness relative to `git rev-parse --short HEAD`, unsafe paths, and secret-like patterns.
- Graph builder uses static imports, simple function/export extraction, layers, health score, circular dependencies, layer violations, patterns, and blast radius.

Useful for us:

- Fixed durable artifacts are extremely good for agent takeover. Our `.project-agent/` folder is directionally right.
- Freshness gates should compare artifacts to current repo state, not simply check existence.
- Handoff should annotate touched files with architecture graph metadata.

Limitations:

- Generated docs can be shallow and inferred.
- It lacks temporal validity, user intent, and visible project operating state.

### Akita AI Memory

Key files:

- `docs/ARCHITECTURE.md`
- `crates/ai-memory-store/migrations/V01__init.sql`
- `crates/ai-memory-core/src/handoff.rs`
- `crates/ai-memory-hooks/src/router.rs`

Architecture:

- One Rust binary exposes hook ingress and MCP tools.
- Hook clients fire-and-forget HTTP to `/hook`; the server returns 202 or 429 when saturated.
- Heavy work goes through a single writer actor with SQLite WAL and busy timeout.
- Markdown wiki is the source of truth; SQLite is the derived index for pages, sessions, observations, links, handoffs, FTS, embeddings, audit log.
- Handoff is explicit: `open`, `accepted`, `expired`, with from-agent, target-agent, cwd, summary, open questions, next steps, touched files.
- Unknown hook events normalize to a closed vocabulary unless extensions opt in.

Useful for us:

- Handoff should be a typed row/state machine, not a freeform Markdown convention.
- Hook ingress needs backpressure and sanitization at the boundary.
- Wiki/source files and query indexes should be separated.

Limitations:

- It is a service runtime, not a visual governance workbench.
- It is comparatively heavy for a product that wants to wrap arbitrary existing agents.

### rohitg00 AgentMemory

Key files:

- `src/index.ts`
- `src/state/schema.ts`
- `src/functions/observe.ts`
- `src/functions/compress-synthetic.ts`
- `src/state/hybrid-search.ts`
- `src/functions/graph.ts`
- `src/functions/actions.ts`
- `src/functions/leases.ts`
- `src/functions/checkpoints.ts`
- `src/functions/sentinels.ts`

Architecture:

- Runs as an `iii-sdk` worker with many registered functions and REST/MCP endpoints.
- Storage is `iii-state` style KV: sessions, observations, memories, summaries, graph nodes/edges, relations, actions, leases, routines, signals, checkpoints, sentinels, crystals, lessons, retention, access log, slots, commits.
- Observations come from hooks, are sanitized, deduped, written to KV, streamed to viewers, and optionally compressed.
- Default compression path is zero-LLM synthetic compression. LLM compression is opt-in via `AGENTMEMORY_AUTO_COMPRESS=true`.
- Search is triple-stream: BM25, vectors, graph retrieval, RRF, session diversification, optional rerank.
- It has governance-like primitives, but they are broad function surfaces rather than one coherent project lifecycle.

Useful for us:

- Zero-LLM fallback is important. Not every event should spend model tokens.
- A mature memory layer needs multiple retrieval streams and graceful degradation.
- Agent isolation, scopes, and hooks are real product requirements.

Limitations:

- It is not UI-first. The user still needs to trust tools and search results.
- The orchestration objects are broad, but the product state machine is not as explicit as our continuity/runbook/takeover flow.

### Graphiti

Key files:

- `graphiti_core/graphiti.py`
- `graphiti_core/nodes.py`
- `graphiti_core/edges.py`
- `graphiti_core/search/search.py`
- `graphiti_core/utils/maintenance/edge_operations.py`
- `graphiti_core/prompts/extract_edges.py`

Architecture:

- Stores episodic nodes, entity nodes, community nodes, saga nodes, and typed edges.
- Entity facts carry provenance through referenced episodes.
- Facts have `valid_at`, `invalid_at`, and `expired_at`, making contradictions and time travel first-class.
- Search combines full-text, cosine similarity, BFS, node distance, MMR/RRF, and cross-encoder rerank.
- Episode windows preserve previous context during extraction.

Useful for us:

- Our memory graph should store provenance references and validity windows, not just labels and edges.
- A project decision can become stale or invalidated when later work contradicts it.
- Retrieval should support graph expansion from the current process cursor and changed files.

Limitations:

- General temporal graph extraction can overfit or hallucinate without a project ontology.
- Graph DB infrastructure is likely too much for the initial workbench.

### RepoWise

Key files:

- `docs/INTELLIGENCE_LAYERS.md`
- `docs/architecture/ARCHITECTURE.md`
- `packages/server/src/repowise/server/mcp_server/tool_risk.py`
- `packages/server/src/repowise/server/services/knowledge_map.py`
- `plugins/codex/skills/pre-modification-check/SKILL.md`

Architecture:

- Five intelligence layers: graph, git, documentation, decision, code health.
- Three stores: SQL for structured truth, vector for semantic search, graph for dependencies and centrality.
- Decision intelligence mines ADRs, changelogs, PR bodies, inline markers, git archaeology, docs, comments, and LLM generation. It keeps evidence spans and confidence gates.
- Risk before edit combines dependency count, git metadata, co-change partners, ownership, test gaps, security findings, PageRank impact surface, and governing decisions.
- Auto-sync keeps docs and graph current through commit hooks, watcher, webhooks, and polling.

Useful for us:

- Add a pre-edit risk panel to takeover: touched files, co-change partners, governing decisions, tests, owners.
- Treat decisions as evidence-backed objects with staleness and conflict detection.
- Architecture view should eventually consume a real code graph adapter.

Limitations:

- RepoWise owns codebase documentation. Our product should consume or interoperate with that layer, not duplicate the whole generator.
- It does not track live agent handoff state as the central product object.

### CodeBoarding

Key files:

- `codeboarding_workflows/orchestration.py`
- `static_analyzer/engine/call_graph_builder.py`
- `diagram_analysis/diagram_generator.py`
- `output_generators/markdown.py`

Architecture:

- Pipeline materializes a local/remote repo source, resolves a run context, runs analysis, and finalizes the run context even on failure.
- Static analyzer uses LSP document symbols and references to build call flow graphs, package dependencies, references, and hierarchy.
- Diagram generator combines static analysis with LLM agents for meta, abstraction, details, and incremental updates.
- Output is Mermaid/Markdown with component descriptions, source files, method references, and clickable links.

Useful for us:

- Project map needs evidence-backed file and symbol refs, not only product-state nodes.
- A run context should be finalized even if analysis fails.
- Incremental architecture analysis should be a product capability, not a one-off screenshot.

Limitations:

- It generates architecture explanations but does not manage process continuity or acceptance gates.

### Repomix and Gitingest

Key files:

- Repomix: `src/core/packager.ts`, `src/core/security/securityCheck.ts`
- Gitingest: `src/gitingest/ingestion.py`, `src/gitingest/output_formatter.py`

Architecture:

- Repomix collects files, git diff, git log, validates file safety, filters suspicious files, computes metrics, token counts, and writes bounded output.
- Gitingest walks a repo with depth, file-count, file-size, and total-size limits, then emits summary, tree, and file contents with token estimates.

Useful for us:

- The resume bundle needs token budgeting and secret filtering.
- A handoff prompt should be explicitly bounded and inspectable.
- Code context should be a generated view, not a permanent dump.

Limitations:

- These are packing/digest tools, not memory or governance systems.

### Mem0

Key files:

- `mem0/memory/main.py`
- `mem0/memory/storage.py`
- `mem0/vector_stores/*`
- `openmemory/api/app/mcp_server.py`

Architecture:

- General-purpose memory API with user, agent, and run scopes.
- Supports many vector stores, LLMs, embedders, rerankers, and OpenMemory UI/MCP.
- Carefully validates entity IDs, filters, metadata, and sensitive config fields.

Useful for us:

- Session scope should include user, project, agent, and run dimensions.
- Adapter abstraction matters if we later plug in external memory backends.

Limitations:

- It is not specific to codebase architecture, process trace, QA gates, or agent takeover.

### AgentOps and Phoenix

Key files:

- AgentOps: `agentops/sdk/core.py`, `agentops/semconv/*`, `agentops/instrumentation/*`
- Phoenix: `docs/phoenix/get-started/get-started-tracing.mdx`, `app/src/store/tracingStore.tsx`

Architecture:

- AgentOps uses OpenTelemetry providers, authenticated OTLP exporters, metrics exporters, span processors, and semantic conventions for agents/tools/workflows.
- Phoenix focuses on traces, spans, evals, datasets, experiments, and prompt playgrounds.

Useful for us:

- Process events should have span-like structure: parent, status, timing, tool, cost, error, artifact refs.
- UI affordances for trace trees and eval results are relevant for QA acceptance.

Limitations:

- Observability answers what happened in one run. It does not decide what the next agent must read or do.

### LangGraph

Key files:

- `libs/checkpoint/langgraph/checkpoint/base/__init__.py`
- `libs/checkpoint-sqlite/*`
- `libs/checkpoint-postgres/*`

Architecture:

- Checkpoints are durable state snapshots keyed by thread/config.
- Metadata records source, step, parents, run id, and per-channel delta counters.
- Checkpointer interface supports get, list, put, pending writes, parent configs, and delta-channel history.

Useful for us:

- Our `agent-run` wrapper should become a checkpoint ledger: command, phase, parent, artifacts, result, acceptance status.
- Phase deltas can make recovery faster than replaying the full log.

Limitations:

- LangGraph is an agent workflow runtime. We should not force users to rewrite their agents into LangGraph just to get governance.

## Comparative Scorecard

Scores are relative to Project Agent Terminal's target, not to each project narrowly.

| Capability | Best reference | Current Project Agent Terminal | Gap |
| --- | --- | --- | --- |
| Cross-agent capture | Akita, rohit | Medium: terminal/runtime events and CLI wrappers | More hook adapters and backpressure |
| Durable takeover files | RAVBYTE, Akita | High: `.project-agent/` bundle, manifest, prompt, audit | Freshness against git and artifact hashes can get stricter |
| Source-of-truth separation | Akita, RepoWise | Medium: durable JSON/MD files, no derived DB yet | Define raw/event/wiki/index boundaries |
| Temporal provenance | Graphiti | Medium-low: provenance refs exist, temporal validity is shallow | Add validity windows and contradiction/staleness |
| Code architecture intelligence | RepoWise, CodeBoarding | Medium: architecture map and development trail | Add real code graph adapter or import path |
| Prompt safety and budget | Repomix, Gitingest | Medium-low: next-agent prompt exists | Add token budget, secret scan, size limits |
| Risk before edit | RepoWise | Low-medium: changed files and impact folders | Add risk, tests, owners, co-change partners |
| Handoff state machine | Akita | Medium: takeover packet and audits | Add open/accepted/expired semantics |
| Human visual workbench | Project Agent Terminal | High | Keep this as the main differentiator |

## Product Implications

### Keep

- The visible workbench is the right wedge. None of the close projects combine memory, process, architecture, governance, handoff, terminal, and takeover readiness in one surface.
- `.project-agent/` as a durable handoff folder is directionally strong.
- The five-lane Governance Kernel is a good abstraction: Capture, Curate, Retrieve, Verify, Disclose.

### Tighten

- Capture should use a closed event vocabulary plus extension namespace, following Akita's pattern.
- Curate should preserve source provenance on every memory node and decision.
- Retrieve should support code graph and process graph expansion, not just text summaries.
- Verify should include git freshness, state manifest hashes, secret scan, and required-file checks.
- Disclose should generate a bounded prompt with top-of-mind state, warm refs, and cold recovery refs.

### Add Next

1. Handoff lifecycle states: `open`, `accepted`, `expired`, `cancelled`.
2. Phase ledger for `agent-run`: parent event, command, artifacts, changed files, result, proof gate.
3. Source provenance model: every memory/decision/architecture node gets `sourceRefs`, `sourceHash`, `observedAt`, and optional `validFrom` / `validUntil`.
4. Freshness gates: architecture map commit, process trace timestamp, state manifest hash, dirty tree warning.
5. Prompt packing gate: token estimate, secret scan, max files, max bytes, omitted refs list.
6. Code graph adapter: start with dependency/import graph, then allow RepoWise/CodeBoarding-style richer imports.
7. Pre-edit risk panel: touched files, tests, co-change partners, ownership, governing decisions, stale docs.

### Avoid

- Do not build a general vector memory platform like Mem0.
- Do not build a full observability backend like Phoenix or AgentOps.
- Do not build a full code wiki generator like RepoWise.
- Do not require LangGraph as the runtime.
- Do not make the UI a decorative map. The map should be backed by state files and source refs.

## Adopted Pattern Map

| External pattern | Product translation |
| --- | --- |
| Axiom journal queue and top-of-mind note | `.project-agent/agent-context-bundle.json` plus bounded next-agent prompt |
| RAVBYTE worklog, handoff, freshness validator | process trace, takeover packet, state manifest, acceptance audit |
| Akita hook router, sanitizer, backpressure, source/index split, typed handoff | sanitized hook ingress, 429 backpressure audit, state boundary audit, and handoff state machine |
| Graphiti temporal fact edges | provenance-backed memory graph with validity windows |
| RepoWise risk and decision intelligence | pre-edit risk panel and evidence-backed decisions |
| CodeBoarding LSP call graph and linked diagram | architecture map with file/symbol refs |
| Repomix/Gitingest prompt packing | token/file/byte-budgeted, secret-filtered resume bundle with omitted refs |
| AgentOps/Phoenix spans | structured process events and QA traces |
| LangGraph checkpoints | phase ledger and resumable agent-run history |

## Bottom Line

The benchmark supports a sharper product thesis:

Project Agent Terminal should be the **agent governance workspace**. Memory systems remember facts. Code intelligence systems explain repos. Observability systems show traces. Workflow runtimes checkpoint execution. Project Agent Terminal should bind these signals into one visible, evidence-backed state contract so a new agent can take over without the prior chat transcript.
