# CLI Memo Product Roadmap

Date: 2026-06-08

## Product Thesis

CLI Memo should become an agent-native project control plane. The current product already gives humans a terminal, visible project memory, process trace, architecture map, and crash handoff. The next step is to expose those same capabilities as MCP tools so Claude, Codex, Gemini, Kimi, and other coding agents can actively recall, inspect, and update project state instead of only reading fixed handoff files.

## North Star

An incoming agent should be able to start with one small summary, search exact local refs, inspect architecture impact, record what it is doing, and prove whether handoff state is fresh enough to trust.

## Phase 1: MCP-Native Project Memory

Status: in progress

Goal: turn CLI Memo's file-backed state and grep-first retrieval into agent-callable MCP tools.

Initial tools:

- `project_start`: initialize or repair project state and optionally create the first active goal.
- `project_takeover_summary`: return the small summary-first takeover packet.
- `project_context_search`: grep-first search across project files and `.project-agent` state.
- `project_read_ref`: read an exact file ref, line range, or JSON selector.
- `project_record_event`: write an agent process event into runtime state.
- `project_architecture_changes`: return recent changes, impact, inspect order, and code graph summary.
- `project_handoff_audit`: return readiness, freshness, blockers, warnings, manifest status, and acceptance status.

Acceptance criteria:

- MCP server starts over stdio from `npm run mcp`.
- Tools list is available through a real MCP client.
- Pre-start projects return `not_started` and point to `project_start` instead of missing handoff refs.
- Core tools reuse existing runtime-state, architecture, and grep-context modules.
- `npm test` verifies MCP initialization, tool discovery, takeover summary, context search, ref read, architecture changes, handoff audit, and event recording.

## Phase 2: Agent Bootstrap Integrations

Goal: make the MCP server easy to install for multiple coding agents.

Status: landed. `GET /api/agent/bootstrap` now returns a provider-neutral `project-agent.agent-bootstrap.v1` kit that can be consumed directly by AI harnesses. It includes Codex, Claude Code, Gemini, Kimi, and generic MCP snippets, the default `project_takeover_summary` first call, the automatic `project_memory_harness` call, the ordered tool protocol, and local-only security boundaries. Product tab now exposes the same kit as machine-readable setup state rather than a manual doc-only flow.

Work:

- Generate Claude Code MCP config snippets.
- Generate Codex MCP config snippets.
- Add provider-neutral bootstrap prompt that tells agents when to call each project tool.
- Add docs for local-only security boundaries and project-dir scoping.

Latest execution record:

- Benchmark need analysis: local agents need a first-tool and memory-read protocol that avoids asking users to paste prior chat or hand-edit raw JSON.
- Architecture and code: `server/cli-agent-bootstrap.js` now owns the canonical bootstrap model; `/api/agent/bootstrap` and `/api/cli-agent-bootstrap.bootstrapKit` share it.
- Deployment: the canonical MCP command remains `npm run mcp -- --project-dir <dir>`, scoped to the project and local-only by default.
- UI testing: Product tab includes `AgentBootstrapPanel`; smoke coverage verifies API schema, provider snippets, first call, automatic memory harness, protocol steps, and UI source wiring.

Acceptance criteria:

- A new agent can connect without editing raw JSON by hand.
- `project_takeover_summary` is the default first tool recommendation.
- Agents are instructed to use `project_context_search` before large reads.

## Phase 3: Memory Lifecycle And Governance

Status: in progress. Canonical memory foundation, forget/consolidate governance, hybrid-lite indexes, and P0 lifecycle closure are landed. The latest tranche adds idempotent dogfood seed, first-class update/supersede, retention audit/sweep, and cache cascade refresh across all canonical memory write paths.

Goal: turn project state from generated handoff files into governed memory units with inventory, retention, redaction, and forget semantics.

Detailed implementation order: see `docs/product/memory-implementation-steps.md`.

Work:

- Add `project_memory_inventory` to explain what is stored, where it came from, how large it is, and whether it is source or derived.
- Add canonical `.project-agent/memory/` records for episodes, facts, decisions, procedures, evidence, and audit rows.
- Add `project_memory_add`, `project_memory_read`, and `project_memory_search` over typed memory records.
- Add `project_memory_forget` with dry-run, redaction/delete cascade, index cleanup, and generated-file refresh.
- Add `project_memory_consolidate` to promote runtime traces and evidence into durable long-term memory.
- Add retention policy for runtime events, raw terminal output, architecture snapshot text, and generated bundles.
- Add P0 lifecycle tools: `project_memory_seed_dogfood`, `project_memory_update`, `project_memory_supersede`, `project_memory_retention_audit`, and `project_memory_retention_sweep`.
- Make the AI memory harness report dogfood/retention lifecycle state and recommend governed next calls without asking users to manually inspect memory files.

Acceptance criteria:

- The product can answer "what do you remember about this project?" without reading every generated file.
- The product can answer "what will be deleted if I forget X?" before mutating state.
- A delete or redaction removes stale references from generated takeover files after refresh.
- Every durable memory has source refs, type, confidence, timestamps, and lifecycle metadata.
- Agents can update or supersede one canonical memory through first-class tools instead of using delete/forget as an indirect workaround.
- Retention policy can be audited non-destructively and swept with dry-run-first expiry semantics.
- Canonical writes refresh `index.md`, BM25, entity, and lexical-vector caches so the harness sees fresh memory after mutation.

Latest execution record, 2026-06-15:

- Benchmark / need analysis: `docs/research/memory-gap-deep-benchmark.md` showed CLI Memo already has strong grep-first canonical/control-plane memory; the P0 gap was lifecycle closure: dogfood content, update, supersede, retention sweep, and cache refresh.
- Architecture / best code: `server/memory-store.js` now owns idempotent dogfood seed records, provenance-preserving in-place update, version-chain supersession, retention audit/sweep, and a shared memory-derived-state refresh path for `index.md`, BM25, entity, and lexical-vector caches.
- Deployment: MCP exposes `project_memory_seed_dogfood`, `project_memory_update`, `project_memory_supersede`, `project_memory_retention_audit`, and `project_memory_retention_sweep`; HTTP mirrors them through `/api/memory/seed-dogfood`, `/api/memory/update`, `/api/memory/supersede`, `/api/memory/retention`, and `/api/memory/retention/sweep`.
- UI testing: Project map -> Memory now shows Dogfood and Retention lifecycle metrics plus a harness lifecycle strip. Smoke coverage verifies MCP and HTTP seed/update/supersede/retention flows, audit rows, searchability, and cache refresh.

## Phase 4: Better Retrieval And Memory Quality

Status: in progress. Deterministic filters/source-quality scoring, optional rebuildable BM25 cache, optional rebuildable entity graph cache, and a local rebuildable `lexical-vector-lite` cache are landed; the AI memory harness auto-uses fresh optional caches as hybrid search while direct search keeps an explicit opt-in switch. Remote embedding/vector backends remain future-gated.

Goal: make grep-first retrieval feel like a local project memory database.

Work:

- Improve ranking with recent-change weighting and state-file priority.
- Add file-type scopes and folder filters.
- Add optional rebuildable BM25 cache that the AI memory harness can auto-use when fresh, while keeping direct search deterministic unless explicitly requested.
- Add optional rebuildable entity graph cache over canonical memory concepts, refs, files, folders, and terms.
- Add optional embedding/vector reranking without making it the default takeover path. First vector tranche: `.project-agent/indexes/memory-vectors.json` stores local hashed lexical vectors with `embeddingProvider: none`; `project_memory_rebuild_vector_index`, `/api/memory/vector-index`, and `useIndex=vector|hybrid` expose explainable cosine reranking.
- Add source/ref quality scoring so weak claims are flagged before injection.

Acceptance criteria:

- Search results consistently include useful refs for active goal, current cursor, changed files, and handoff risk.
- Retrieval remains deterministic and explainable when embeddings are disabled.
- Optional vector scoring reports `ranking.optionalIndexes.vector` and `scoreBreakdown.vector` while preserving canonical memory refs.

Latest execution record, 2026-06-13:

- Benchmark / need analysis: users should not manually pick memory refs or choose retrieval internals. BM25/entity improved recall, but fuzzy lexical reranking still needed a rebuildable local cache before any remote embedding provider is considered.
- Architecture / best code: vector retrieval is implemented as `lexical-vector-lite`, a deterministic hashed sparse-vector cache generated only from canonical `.project-agent/memory` records. It shares canonical hash freshness with BM25/entity, returns cosine-similarity metadata, and keeps `embeddingProvider: none` so it cannot become an untraceable fact source.
- Deployment: added `project_memory_rebuild_vector_index`, `GET/POST /api/memory/vector-index`, `useIndex=vector|hybrid` scoring in `project_memory_search`, automatic harness hybrid use when fresh, health/inventory/UI status, and manifest refresh after HTTP index rebuilds.
- UI testing: `npm run build` passed and `npm test` passed with MCP and HTTP rebuild/search coverage for vector cache, hybrid harness auto-use, and state-manifest coherence.

## Phase 5: Stronger Code Intelligence

Status: in progress. First tranche landed with local import graph changed-impact enrichment, test ownership hints, co-change recommendations, and read-before-edit refs in architecture, insights, prompts, and UI. Second tranche landed with handoff/pre-edit inspection coverage warnings that automatically detect read/test evidence from runtime events. Third tranche landed with local `symbol-graph-lite` export/import/call intelligence so changed-file impact can show which dependents call exported symbols.

Goal: move from file-level architecture awareness toward code ownership and dependency impact.

Work:

- Improve import graph and changed-impact mapping. First tranche: changed files now carry dependents, dependencies, package imports, tests, co-changed files, why text, recommended reads, refs, and next action.
- Add test ownership hints. First tranche: same-stem, same-folder, and source-name matching infer likely tests for JS/TS files.
- Add co-change and inspection recommendations. First tranche: code graph summaries, runtime state, and pre-edit risk include impacted tests and read-before-edit refs. Second tranche: `inspectionCoverage` warns when impacted dependents/tests lack completed read/test evidence.
- Show which files should be read before editing a target file. First tranche: Project map -> Graph exposes compact recommended read rows and co-change summaries.
- Add symbol-level code intelligence. Third tranche: `codeGraph.symbolGraph` indexes JS/TS exported symbols, local symbols, import bindings, and direct call counts, then merges symbol callers into `changedImpact.recommendedReads` and Graph UI symbol rows.

Acceptance criteria:

- Architecture output can explain why a changed file matters.
- Handoff audit can warn when impacted tests or dependent modules have not been inspected.
- Changed code impact can identify exported symbols and dependent files that call them without requiring a remote code-intelligence service.

Latest execution record, 2026-06-13:

- Benchmark / need analysis: file-level import edges are useful, but autonomous coding harnesses also need to know whether a dependent merely imports a file or calls a changed exported API.
- Architecture / best code: `server/architecture.js` now builds a local `project-agent.symbol-graph-lite.v1` from JS/TS text, extracting exported symbols, local symbols, import bindings, call counts, symbol dependents, symbol hotspots, and symbol-aware changed impact. `server/insights.js`, MCP architecture changes, and summary-first bundle code graph summaries preserve the symbol fields.
- Deployment: symbol intelligence ships inside `.project-agent/architecture-map.json#codeGraph.symbolGraph`, `project_architecture_changes`, `/api/insights`, agent context bundle summaries, and Project map -> Graph without adding parser or remote service dependencies.
- UI testing: `npm test` verifies exported function detection, symbol caller detection, symbol-aware `recommendedReads`, summary preservation, and visible UI source wiring; `npm run build` passes with the existing Vite chunk-size warning. Browser QA on Project map -> Graph verified desktop/mobile symbol rows, console cleanliness, and zero horizontal overflow; Browser screenshot capture itself timed out at the CDP layer.

## Phase 6: Productization

Status: in progress. First tranche landed with `/api/health`, local-only security boundary metadata, header health strip, and reconnect/backoff UI. Second tranche landed with `.project-agent` state export/import, dry-run restore planning, hash validation, and Product tab UI. Third tranche landed with a local multi-project launcher, registry, automatic port planning, and dynamic Vite/API port wiring. Fourth tranche landed with machine-readable sandbox and permission guidance for local-only runtime, state writes, process launches, sensitive env names, and package-script risk. Fifth tranche landed with optional non-local bearer-token auth guarded by explicit remote opt-in, auth readiness API, HTTP/WS enforcement, and UI unlock support. Sixth tranche landed with launcher stop/restart controls and persisted bounded process logs for AI/UI inspection.

Goal: turn the local prototype into a reliable user-facing product.

Work:

- Add multi-project launcher. Third tranche: `/api/projects` lists current/default/registered projects, `POST /api/projects/register` stores local project refs, and `POST /api/projects/launch` builds or executes a local-only launch plan with separate API/UI ports. Sixth tranche: `GET /api/projects/logs`, `POST /api/projects/stop`, and `POST /api/projects/restart` expose machine-readable lifecycle controls with persisted `.project-agent/launcher-logs/*.jsonl` process history.
- Add port health checks and reconnect UX. First tranche: health snapshot covers server port, project root, initialized state, terminal backend, manifest status, memory/index freshness, and local-only security boundary.
- Add optional auth for non-local deployment. Fifth tranche: remote access remains disabled unless `PROJECT_AGENT_BIND_HOST` requests a non-local host, `PROJECT_AGENT_REMOTE=1` is set, and `PROJECT_AGENT_AUTH_TOKEN` is configured; otherwise the server stays on `127.0.0.1`. When enabled, `/api` and `/terminal`/`/events` WebSockets require bearer-token auth, while `GET /api/security/auth` exposes safe readiness without leaking token values.
- Add sandbox and permission guidance. Fourth tranche: `GET /api/security/sandbox` returns `project-agent.sandbox-guidance.v1` with local-only posture, read/write/execution/network scopes, automatic harness calls, confirmation gates, blocked-by-default policies, sensitive env name counts without values, package-script risk, and Product tab UI.
- Add import/export of `.project-agent` state. Second tranche: `portable` export includes source and generated handoff state while excluding volatile runtime and rebuildable indexes; import defaults to dry-run and requires explicit overwrite to execute.

Acceptance criteria:

- Local users can launch, connect agents, and recover sessions without reading internal docs.
- Remote or shared use has explicit security boundaries.
- Agents and UI can inspect project process state, recent logs, and stop/restart outcomes without manual PID or terminal-log hunting.

Latest execution record, 2026-06-13:

- Benchmark / need analysis: the previous launcher produced launch plans and in-memory child-process logs, but AI/UI had no durable way to inspect process output or stop/restart a spawned project after refresh. The product need is API-first lifecycle control so users do not manually hunt terminal output, PIDs, or memory refs.
- Architecture / best code: `server/project-launcher.js` now owns launch, stop, restart, and persisted `.project-agent/launcher-logs/*.jsonl` records with bounded history; Express exposes separate launch-plan, lifecycle-control, and log-read schemas so harnesses can choose the right non-manual action.
- Deployment: `GET /api/projects/logs`, `POST /api/projects/stop`, and `POST /api/projects/restart` are wired into the local-only API, runtime events, sandbox guidance, README usage, and Product tab controls.
- UI testing: `npm run build`, `npm test`, and Browser QA passed. Desktop Product tab showed Plan/Restart/Logs/Stop controls, disabled Stop for idle projects, opened the persisted logs panel, and reported no console errors. Mobile 390px QA showed launcher controls/log panel with no Project Launcher section overflow.

## Current Build Order

1. Ship MCP MVP.
2. Add agent bootstrap snippets.
3. Add `project_memory_inventory`.
4. Add canonical `.project-agent/memory/*.jsonl` store.
5. Add `project_memory_add`, `project_memory_read`, and `project_memory_search`.
6. Add `project_memory_forget` with dry-run and cascade refresh.
7. Add `project_memory_consolidate`.
8. Close P0 memory lifecycle: dogfood seed, update, supersede, retention audit/sweep, and write-path cache cascade refresh.
9. Add optional FTS/BM25, entity, and local vector indexes; keep remote embedding/vector providers future-gated.
10. Improve P1 memory quality: rebuild-all-indexes, Consolidation V2, optional semantic embeddings, privacy audit, and generated cleanup.
11. Deepen P2 architecture/code memory with tree-sitter/probe-like AST search and bounded access audit.
12. Productize setup, security, and external Codex/Claude MCP e2e doctor flows.
