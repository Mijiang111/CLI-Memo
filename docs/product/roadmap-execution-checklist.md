# Roadmap Execution Checklist

Date: 2026-06-12

This checklist turns `docs/product/roadmap.md` into an implementation gate. Each phase should pass through the same four checkpoints before it is considered landed:

1. Benchmark and need analysis
2. Architecture and code design
3. Deployment implementation
4. UI and product testing

## Current Tranche

Landed in this tranche:

- Phase 3 step 1: `project_memory_inventory`
- Phase 3 step 2: canonical `.project-agent/memory/*.jsonl` store
- Phase 3 step 3: `project_memory_add`, `project_memory_read`, and `project_memory_search`
- Phase 3 step 4: `project_memory_forget` dry-run plus governed delete/redact/expire/supersede execution
- Phase 3 audit query: `project_memory_audit`, `/api/memory/audit`, and sidecar audit timeline
- Phase 3 step 5: `project_memory_consolidate` runtime-to-memory promotion with dry-run proposals, explicit execution, duplicate skipping, and low-confidence gating
- Phase 3 P0 lifecycle closure: `project_memory_seed_dogfood`, `project_memory_update`, `project_memory_supersede`, `project_memory_retention_audit`, and `project_memory_retention_sweep`
- Phase 3/4 P1 quality closure: `project_memory_rebuild_all_indexes`, `project_memory_privacy_audit`, `project_memory_generated_cleanup`, `project_memory_consolidate_v2`, and `project_memory_access_audit`
- Cache cascade refresh: add/update/supersede/forget/consolidate/retention sweep refresh `index.md`, BM25, entity, and lexical-vector caches after canonical writes
- Rebuild-all cache refresh: canonical `index.md`, BM25, entity, and lexical-vector caches can be rebuilt together through MCP and HTTP.
- Bounded access audit: automatic harness search/read calls are recorded in `.project-agent/memory/access.jsonl` and queryable through MCP/HTTP.
- Generated cleanup: rebuildable generated/index files are dry-run previewed, active handoff files are protected by default, and executed cleanup refreshes indexes/state manifest.
- Consolidation V2: governed add/update/supersede/expire proposals are exposed without mutation, with retention-expiry proposals covered.
- AI memory harness: automatic canonical memory search/read and non-mutating consolidation discovery attached to takeover/bootstrap flows
- AI memory harness lifecycle: dogfood/retention status and governed next calls are returned without requiring users to inspect memory files manually
- HTTP API and sidecar UI read path for canonical memory inventory
- HTTP API and sidecar UI dry-run preview path for memory forget impact
- HTTP API and sidecar UI auto-discovery path for memory consolidation proposals
- HTTP API and sidecar UI proof for automatic memory harness calls
- MCP smoke coverage for inventory, add, read, search, audit, consolidate, and cold-start memory initialization
- MCP smoke coverage for `project_memory_harness` and automatic `memoryHarness` attached to `project_takeover_summary`
- MCP smoke coverage for forget dry-run, executed delete, executed redact, search cleanup, and refresh handoff
- MCP smoke coverage for consolidate dry-run, executed decision/procedure promotion, searchability, audit row, and idempotent duplicate skip
- MCP and HTTP smoke coverage for dogfood seed idempotency, memory update, memory supersede, retention audit/sweep, audit rows, latest-only behavior, and post-write indexed searchability
- MCP and HTTP smoke coverage for rebuild-all indexes, privacy audit, generated cleanup, access audit, Consolidation V2, code search, and agent doctor readiness
- Phase 4 step 1: deterministic memory/context search filters, source-quality scoring, and explainable ranking breakdowns
- Phase 4 step 2: optional rebuildable BM25 cache with freshness reporting, direct indexed search opt-in, and automatic fresh-cache use inside the AI memory harness
- Phase 4 step 3: optional rebuildable entity graph cache with freshness reporting, entity/hybrid indexed search, and automatic fresh-cache hybrid use inside the AI memory harness
- Governed UI execution: memory forget and consolidation now require dry-run preview plus checkbox confirmation before destructive/promoting POST execution
- Richer Memory empty states for over-constrained search filters and missing consolidation proposals
- Phase 6 productization: local health/reconnect, state transfer, multi-project launcher, sandbox/permission guidance, and optional non-local bearer-token auth are exposed through HTTP APIs and Product tab surfaces

Verification:

- `npm test`
- `npm run build`
- Browser UI smoke: initialize/rebuild demo project, open Project map -> Memory, verify Canonical Memory status, deterministic search filters, BM25/entity/vector cache freshness, P1/P2 Privacy/Access/V2/Cleanup cards, Rebuild all, Preview cleanup, AI memory harness auto-read calls, consolidation proposals, audit timeline, preview forget impact, confirmed forget execution, confirmed consolidate execution, richer empty states, Product tab health/launcher/state-transfer/sandbox surfaces, and console cleanliness.

## Phase 1: MCP-Native Project Memory

### Benchmark And Need Analysis

Need: agents should not scrape generated files blindly. They need callable tools for start, takeover summary, grep-first search, exact ref read, event recording, architecture impact, and handoff audit.

Benchmark lesson: MCP memory servers work best when tool results are structured, small, and source-ref oriented. CLI Memo's advantage is not generic chat memory; it is project-control memory with process, evidence, architecture, and handoff state.

### Architecture And Code

Keep MCP as a thin adapter over existing runtime-state, architecture, grep-context, and project-agent modules. Tool outputs should preserve JSON refs and avoid inventing unsupported prose.

### Deployment

Entrypoint: `npm run mcp`.

Smoke requirements:

- stdio server starts
- real MCP client lists tools
- cold-start project returns `not_started`
- `project_start` initializes state and handoff files

### UI Testing

UI should show no regression in the existing sidecar state after MCP state refreshes. MCP is agent-facing, so UI testing focuses on state surfaces that MCP mutates.

## Phase 2: Agent Bootstrap Integrations

### Benchmark And Need Analysis

Need: Claude Code, Codex, Gemini, Kimi, and other local agents need harness-consumable bootstrap state without asking the user to hand-edit raw JSON or manually decide which memories to read.

Benchmark lesson: good agent bootstrap flows recommend a first tool and reading protocol. The first call should be `project_takeover_summary`, followed by automatic `project_memory_harness`, then `project_context_search` before broad reads.

### Architecture And Code

Provider-specific snippets should be generated from one provider-neutral bootstrap model. Keep project-dir scoping explicit and local-only by default.

Landed:

- `server/cli-agent-bootstrap.js` exposes `buildAgentBootstrapKit()` as the canonical `project-agent.agent-bootstrap.v1` model.
- The model includes Codex, Claude Code, Gemini, Kimi, and generic MCP configs, `firstCall`, `automaticHarness`, ordered `toolProtocol`, local-only security posture, and `automation.manualUserStepsRequired: false`.
- MCP harness schema accepts BM25, entity, vector, and hybrid optional indexes so agent-side memory routing matches the UI.

### Deployment

Expose snippets through CLI/API docs and keep `npm run mcp -- --project-dir <dir>` as the canonical command.

Landed:

- `GET /api/agent/bootstrap` returns the machine-readable bootstrap kit without writing state.
- `GET /api/cli-agent-bootstrap` still writes the markdown fallback and now returns the same kit under `bootstrapKit`.
- Product tab consumes `/api/agent/bootstrap` during `refreshAll`.

### UI Testing

Product tab should show an Agent Bootstrap surface with provider count, first tool, automatic memory harness, local boundary, provider rows, ordered protocol rows, and a bounded provider snippet.

Smoke requirements:

- `/api/agent/bootstrap` returns ready status, Codex/Claude/generic providers, `project_takeover_summary`, `project_memory_harness`, hybrid memory index preference, context search, record event, and no manual user step requirement.
- Source smoke verifies `AgentBootstrapPanel`, `/agent/bootstrap`, `project_takeover_summary`, `project_memory_harness`, and the no-manual-JSON Product tab state.
- Browser QA should cover Product tab desktop/mobile visibility, console cleanliness, and no Agent Bootstrap overflow.

## Phase 3: Memory Lifecycle And Governance

### Benchmark And Need Analysis

Need: CLI Memo can already generate handoff memory, but it could not answer what it canonically remembers, why, where the claim came from, when it expires, or what deletion would affect.

Benchmark lesson: canonical files should be source of truth; indexes and generated bundles are rebuildable caches. Retrieval starts with grep-first exact refs; vector/entity indexes come after forget semantics.

Latest benchmark lesson: `docs/research/memory-gap-deep-benchmark.md` shows the remaining P0 risk is not missing storage, but missing lifecycle closure: useful durable dogfood memory, first-class update/supersede, retention sweep, privacy/cache hardening, and harness-visible automation.

### Architecture And Code

Implemented foundation:

- `server/memory-store.js`
- `.project-agent/memory/index.md`
- `.project-agent/memory/episodes.jsonl`
- `.project-agent/memory/facts.jsonl`
- `.project-agent/memory/decisions.jsonl`
- `.project-agent/memory/procedures.jsonl`
- `.project-agent/memory/evidence.jsonl`
- `.project-agent/memory/risks.jsonl`
- `.project-agent/memory/audit.jsonl`
- `.project-agent/memory/retention.json`

Rules now enforced:

- memory add requires `sourceRefs`
- every search result returns canonical refs
- inventory works before canonical memory exists
- cold-start `project_start` creates memory files
- existing projects can create memory files through rebuild/init
- forget defaults to `dryRun: true`
- dry-run reports canonical records, runtime events, generated files, and index entries before mutation
- executed delete removes canonical records and rebuilds `index.md`
- executed redact replaces memory content and removes targeted source/file refs where requested
- executed forget appends audit rows and triggers/generated refresh from MCP/API wrappers
- audit query filters append-only memory lifecycle rows by action, mode, ref, type, memory id, dry-run state, and time window
- consolidation promotes runtime events, handoff risks, and architecture changes into canonical memory candidates
- consolidation defaults to dry-run, requires explicit `dryRun: false` to write, skips duplicates by consolidation hash, and leaves low-confidence candidates as proposals
- memory harness automatically builds a query from active goal, current cursor, recent runtime events, risks, and changed files, then calls canonical memory search/read and consolidation discovery for the agent
- dogfood seed creates stable benchmark-backed product memory records when the benchmark doc exists, and skips existing records by stable id
- update mutates one canonical record, preserves provenance by default, increments version, requires a reason, writes changed fields/content hashes to audit, and refreshes rebuildable caches
- supersede creates a new record version, marks the old record non-latest with `supersededBy`, carries `supersedes`, requires a reason, and keeps history readable by exact ref
- retention audit applies `validUntil`, per-record TTL, policy TTL, and generated bundle limits without mutation; retention sweep defaults to dry-run and marks eligible records expired instead of deleting decisions/procedures
- executed canonical writes refresh `.project-agent/memory/index.md`, `.project-agent/indexes/memory-bm25.json`, `.project-agent/indexes/memory-entities.json`, and `.project-agent/indexes/memory-vectors.json`
- access audit records harness read/search calls in bounded `.project-agent/memory/access.jsonl`
- generated cleanup protects active handoff files by default and removes only rebuildable files unless refs are explicit
- privacy audit reports secret-like state, weak provenance, raw architecture policy risks, and writer audit gaps
- Consolidation V2 proposes add/update/supersede/expire actions before execution

### Deployment

MCP tools:

- `project_memory_inventory`
- `project_memory_add`
- `project_memory_read`
- `project_memory_search`
- `project_memory_forget`
- `project_memory_harness`
- `project_memory_consolidate`
- `project_memory_audit`
- `project_memory_seed_dogfood`
- `project_memory_update`
- `project_memory_supersede`
- `project_memory_retention_audit`
- `project_memory_retention_sweep`

HTTP endpoints:

- `GET /api/memory/inventory`
- `GET /api/memory/search`
- `GET /api/memory/harness`
- `GET /api/memory/consolidate`
- `GET /api/memory/audit`
- `GET /api/memory/read`
- `POST /api/memory`
- `POST /api/memory/consolidate`
- `POST /api/memory/forget`
- `POST /api/memory/seed-dogfood`
- `POST /api/memory/update`
- `POST /api/memory/supersede`
- `GET /api/memory/retention`
- `POST /api/memory/retention/sweep`
- `POST /api/memory/indexes/rebuild-all`
- `GET /api/memory/privacy`
- `GET /api/memory/access-audit`
- `GET /api/memory/consolidate-v2`
- `POST /api/memory/consolidate-v2`
- `GET /api/memory/generated-cleanup`
- `POST /api/memory/generated-cleanup`

### UI Testing

Current UI surface:

- Project map -> Memory -> Canonical Memory
- status, record count, source/derived/volatile/index classification, risky surfaces, and latest search results
- per-record `Preview forget` dry-run showing affected records, runtime events, and generated files
- AI memory harness showing automatic `project_memory_search`, `project_memory_read`, and dry-run consolidation calls
- lifecycle cards for dogfood seed and retention sweep status
- P1/P2 cards for privacy, access audit, Consolidation V2, and generated cleanup
- Rebuild all and Preview cleanup controls
- harness lifecycle strip showing dogfood/retention state and next calls such as `project_memory_seed_dogfood` or `project_memory_retention_sweep`
- consolidation proposals showing automatically discovered ready, low-confidence, and duplicate candidate counts
- audit timeline showing memory add/forget/store lifecycle rows and action counts
- dry-run-first execution controls for forget and consolidation, each gated by an explicit checkbox confirmation

## Phase 4: Better Retrieval And Memory Quality

### Benchmark And Need Analysis

Need: grep-first is trustworthy but can miss paraphrases and weakly named concepts. Ranking should improve while remaining deterministic when optional indexes are disabled.

### Architecture And Code

Implemented foundation:

- `project_memory_search` supports deterministic filters for type, file, folder, sourceRef, concept, goalId, fileType, minConfidence, sourceQuality, and latestOnly.
- each memory result includes `sourceQuality`, exact refs, and score breakdowns for exactRef, keyword, path, concept, filterMatch, currentGoal, changedFile, statePriority, sourceQuality, recency, importance, and latest.
- `project_context_search` supports folder/file/fileType narrowing for broad grep-first retrieval.
- ranking remains local and deterministic for direct search; optional BM25 and entity graph caches are rebuildable, direct-search opt-in, and automatically adopted by the AI memory harness only when fresh, while vector indexes stay disabled by default and are reported as such.
- `.project-agent/indexes/memory-entities.json` stores a local `entity-graph-lite` cache with canonical hash freshness checks, entity nodes, co-occurrence edges, and per-record entity memberships.
- the AI memory harness can inherit memory search filters while still auto-running search/read/consolidation without asking the user to pick memory refs manually.
- Project map -> Memory exposes compact search controls and displays applied filters, record counts, source quality, and exact refs.
- `.project-agent/indexes/memory-bm25.json` stores a local `bm25-lite` cache with canonical hash freshness checks.

Next code path:

- add optional vector cache only after entity/index freshness semantics remain stable

### Deployment

Deployment surfaces:

- MCP `project_memory_search`
- MCP `project_memory_rebuild_index`
- MCP `project_memory_rebuild_entity_index`
- MCP `project_memory_harness`
- MCP `project_context_search`
- HTTP `GET /api/memory/search`
- HTTP `GET /api/memory/index`
- HTTP `POST /api/memory/index/rebuild`
- HTTP `GET /api/memory/entity-index`
- HTTP `POST /api/memory/entity-index/rebuild`
- HTTP `GET /api/memory/harness`
- HTTP `GET /api/context-search`
- CLI `npm run grep-context -- --folder <path> --file-type <ext>`

Smoke coverage ships the ranking changes behind deterministic tests and does not require vector services.

### UI Testing

Current UI surface:

- memory query, type, folder, fileType, concept, and sourceQuality filters
- applied filter chips and filtered/total record count
- result rows showing type, score, source quality, and exact refs
- direct links can open `?map=memory` with `memoryQuery`, `memoryType`, `memoryFolder`, `memoryFileType`, `memoryConcept`, and `memorySourceQuality` for deterministic UI testing and agent deep links
- BM25 and entity cache freshness cards plus `BM25 cache`, `Entity graph`, and `Hybrid cache` search modes for observability/debugging; harness auto-use is the primary AI path
- Phase 5 step 1: code graph test ownership hints, changed-impact test refs, recommended read-before-edit files, and co-change recommendations
- Phase 5 step 2: handoff/pre-edit inspection coverage warnings for impacted dependents/tests without completed read/test evidence
- Phase 5 step 3: local symbol graph over JS/TS exports, import bindings, call counts, symbol dependents, symbol hotspots, and symbol-aware changedImpact recommended reads

Next UI surface:

- executed write success details can expand beyond the compact created/skipped counts when the sidecar gets a larger detail drawer

## Phase 5: Stronger Code Intelligence

### Benchmark And Need Analysis

Need: architecture output should explain why changed files matter and what to read before edits.

Benchmark lesson: file-level change lists are too weak for an autonomous coding harness. The useful unit is a changed file plus inbound dependents, outbound imports, likely tests, nearby co-changed files, and a compact recommended read list that can be injected into takeover and pre-edit risk.

Second benchmark lesson: a recommendation is not enough for handoff safety. The harness must distinguish "this file changed" from "an agent completed a read/test/evidence step for the impacted ref." Architecture watcher events alone are not inspection proof.

### Architecture And Code

Implemented first tranche on the existing local code graph:

- import/dependency graph
- changed-impact mapping now persists dependents, dependencies, tests, test status, co-changed files, recommended reads, why text, refs, and next action
- symbol graph now persists exported symbols, local symbols, import bindings, direct call counts, symbol dependents, symbol hotspots, and symbol-aware changed impact
- test ownership hints infer likely test files from same-stem, same-folder, and source-name matches
- co-change recommendations are derived from same-folder changed files and merged into read-before-edit refs
- runtime summaries and agent context prompt now carry impacted tests alongside dependencies
- runtime summaries, MCP architecture changes, and agent context bundle code graph summaries now preserve symbol graph counts and hotspots
- `inspectionCoverage` derives required dependent/test refs from `codeGraph.changedImpact` and marks them missing until completed observe/evidence/audit/read/grep/test events cite the refs
- architecture watcher `File added/modified/deleted` events are explicitly excluded from inspection evidence, so generated file-change noise does not clear handoff warnings

### Deployment

Keep architecture scans local and incremental. Persist summaries into `.project-agent/architecture-map.json`.

Current deployment surfaces:

- `.project-agent/architecture-map.json#codeGraph`
- MCP `project_architecture_changes`
- HTTP `GET /api/insights`
- agent context bundle and starter prompt code graph summaries
- `.project-agent/architecture-map.json#codeGraph.symbolGraph`
- pre-edit risk checks for dependency impact and test gap
- `preEditRisk.inspectionCoverage`
- `handoffLifecycle.checks[]#inspection_coverage`
- MCP `project_handoff_audit.inspectionCoverage` and top-level `warnings: ["inspection_coverage"]` when coverage is missing

### UI Testing

Verify Project map -> Graph and Architecture show dependent files, tests, and inspection order without overflowing the sidecar.

Current UI surface:

- changed-impact cards show dependent, dependency, and test counts
- changed-impact cards show exported symbol count and compact symbol caller rows
- Graph panel shows `data-code-graph-symbols` hotspot rows with symbol/caller/call counts
- each impacted file can show compact read-before-edit recommendations from `recommendedReads`
- co-change recommendation rows summarize read/test fan-out for quick inspection
- Pre-Edit Risk now shows `inspect missing/required` and compact missing/seen chips for impacted dependents/tests

Current smoke coverage:

- import edge from `src/dep-entry.js` to `src/dep-target.js`
- test ownership hint from `src/dep-target.js` to `src/dep-target.test.js`
- changed-impact `recommendedReads` includes dependent and test refs
- pre-edit risk `dependency_impact` and `test_gap` checks cite impacted tests
- pre-edit risk `inspection_coverage` warns when `src/dep-entry.js` and `src/dep-target.test.js` have not been inspected/run
- MCP `project_handoff_audit` surfaces `inspectionCoverage.status="warn"` and `warnings` includes `inspection_coverage`
- a completed evidence event citing the dependent and targeted test resolves `inspectionCoverage` back to `ok`
- exported function smoke fixture proves `symbolGraph.symbolsByPath`, `symbolDependentsByPath`, symbol-aware `changedImpact`, and symbol-aware `recommendedReads`
- Browser QA on Project map -> Graph verifies desktop/mobile symbol rows, console cleanliness, and zero horizontal overflow; Browser screenshot capture currently times out in the CDP screenshot command.

Next code path:

- deepen symbol extraction only where it improves harness decisions; keep the current lite graph local and explainable before adding a parser dependency

## Phase 6: Productization

### Benchmark And Need Analysis

Need: local prototype should become reliable for real users who launch, connect agents, recover sessions, and understand security boundaries.

Benchmark lesson: before multi-project launch or remote deployment, the app needs one authoritative health snapshot. A user and an incoming agent should know whether the local server, project root, terminal backend, manifest, memory indexes, and security boundary are reachable without reading logs.

Second benchmark lesson: backup and migration should not be a raw folder copy. A useful project-memory export needs file classes, hashes, byte counts, and a dry-run restore plan so an agent can prove what will be created, replaced, skipped, or rejected before mutating `.project-agent`.

Third benchmark lesson: a local multi-project product cannot depend on users editing `PROJECT_DIR`, `PORT`, or Vite proxy config by hand. The launcher should discover project state, keep local-only boundaries explicit, allocate ports, and return a runnable launch plan that an AI harness can execute.

Fourth benchmark lesson: permission guidance cannot be a doc-only checklist. The AI harness needs one machine-readable posture snapshot that says which memory/context calls are automatic, which local writes or process launches require explicit confirmation, which path/network boundaries are blocked by default, and whether sensitive env names or package scripts need review.

Fifth benchmark lesson: optional remote/shared use must be opt-in and token-gated, not a side effect of setting `HOST=0.0.0.0`. The safe default is still local-only; a non-local bind becomes effective only when explicit remote intent and a sufficiently long auth token are both present, and the harness can verify that readiness through a public non-secret endpoint.

### Architecture And Code

Implemented tranches:

- `GET /api/health` returns `project-agent.health.v1`
- health includes server bind host/port/uptime, project root/state dir, initialized state, terminal backend, state manifest verification, memory record/index freshness, warnings, and next action
- health declares the explicit security boundary: `local_only`, `auth=not_enabled`, and `remoteAccess=disabled_by_bind_host`
- Header health strip displays online/watch/offline, project name, API port, local-only boundary, and reconnect button when offline
- frontend refresh/reconnect state tracks last successful health check, consecutive failures, last error, and next retry time
- initial handshake stays in checking state; only confirmed API failures enter offline/reconnect
- `server/state-transfer.js` builds `project-agent.state-export.v1` bundles and `project-agent.state-import-plan.v1` dry-run/execution plans
- export modes: `minimal` source-only, `portable` source plus generated handoff state, `full` source/derived/volatile/index/unknown state; transfer-internal backup paths are excluded
- import validates schema, `.project-agent/` path boundaries, duplicate paths, utf8 content, per-file sha256, file count, per-file byte limits, and total byte limits
- import defaults to dry-run; execution requires `overwrite=true`, writes through atomic temp-file replace, backs up replaced files under `.project-agent/import-backups`, and refreshes the state manifest
- Project map -> Product exposes State Transfer with export, stage current export, preview import, explicit overwrite confirmation, and compact create/replace/identical/reject counts
- `server/project-launcher.js` builds a local project registry and launcher summary with current/default/app-root/registered projects
- `GET /api/projects` returns `project-agent.project-launcher.v1` with per-project initialized state, active goal summary, memory counts, manifest health, local-only boundary, and running instance metadata
- `POST /api/projects/register` writes `.project-agent/project-launcher.json`
- `POST /api/projects/launch` returns `project-agent.project-launch-plan.v1`; dry-run is default, and execution can spawn a separate `npm run dev` with `PROJECT_DIR`, `PORT`, `VITE_API_PORT`, and `VITE_PORT`
- `vite.config.js` now reads `PORT`, `VITE_API_PORT`, and `VITE_PORT`; the frontend websocket endpoint uses `VITE_API_PORT` so launched instances do not hard-code `4147`
- Project map -> Product exposes Project Launcher with project list, register, refresh, plan launch, start, and generated URL/command
- `server/sandbox-guidance.js` returns `project-agent.sandbox-guidance.v1` without mutating project state
- `GET /api/security/sandbox` reports local-only posture, auth status, project/state boundaries, read/write/execution/network scopes, automatic memory/context harness calls, confirmation gates, blocked-by-default policies, sensitive env names without values, and package-script watch/blocked counts
- `/api/health` includes a compact `security.sandbox` summary so incoming agents can discover permission posture through the same health path
- Project map -> Product exposes Sandbox & Permissions before Launcher and State Transfer so users and agents can scan boundary, scripts, writes, env names, automatic calls, confirmation gates, blocked rules, and current checks
- `server/auth-boundary.js` resolves effective bind/auth posture from `PROJECT_AGENT_BIND_HOST`, `PROJECT_AGENT_REMOTE`, and `PROJECT_AGENT_AUTH_TOKEN` while keeping the raw token non-enumerable and absent from JSON responses
- `GET /api/security/auth` returns `project-agent.auth-boundary.v1` so a remote harness can discover readiness without a token leak
- non-local bind requests stay on `127.0.0.1` unless explicit remote opt-in and bearer token are both configured
- when remote auth is enabled, `/api` routes and `/terminal`/`/events` WebSocket upgrades require `Authorization: Bearer <token>`, `X-Project-Agent-Token`, or an `authToken` WebSocket query value
- `vite.config.js` uses the same effective bind host; the dev script no longer hard-codes `vite --host 127.0.0.1`, so default local and intentional remote modes share one source of truth
- frontend API and WebSocket helpers automatically attach a stored bearer token, and `AuthUnlockPanel` gives the Product UI a recovery path when remote mode returns 401

Still to build:

- multi-project launcher follow-up: stop/restart controls and persisted process logs

### Deployment

Default to local-only. Require explicit auth and permission configuration for non-local use.

Current deployment surfaces:

- HTTP `GET /api/health`
- HTTP `GET /api/security/auth`
- HTTP `GET /api/security/sandbox`
- HTTP `GET /api/projects`
- HTTP `POST /api/projects/register`
- HTTP `POST /api/projects/launch`
- HTTP `GET /api/state/export?mode=portable|minimal|full`
- HTTP `POST /api/state/import`
- Header health strip in the main app shell
- Optional Auth Unlock panel when remote API calls return 401
- Project map -> Product -> Project Launcher and State Transfer panels
- existing Vite proxy and API remain bound to `127.0.0.1` unless `PROJECT_AGENT_REMOTE=1` and `PROJECT_AGENT_AUTH_TOKEN` are configured with a non-local `PROJECT_AGENT_BIND_HOST`
- smoke coverage validates health schema, port, project dir, terminal health, memory health, local-only boundary, auth boundary schema, blocked remote-by-default posture, remote bearer-token HTTP enforcement, sandbox guidance schema, automatic harness policy, confirmation gates, blocked-by-default rules, concrete permission scopes, project launcher schema, current project discovery, project registration, dry-run launch plan, state export schema, portable export policy, import dry-run, executed import write, manifest refresh, and UI source surface

### UI Testing

Test common flows:

- start local project
- connect MCP agent
- recover after server restart
- detect stale ports and reconnect
- show local-only security boundary without requiring docs
- avoid header overflow on desktop and mobile
- Browser QA result: desktop and 390px mobile health strip render without horizontal overflow; stopping the dev server shows offline/retry/Reconnect, and restarting the service auto-recovers to ok without user action
- Browser QA should cover Project map -> Product, export, stage current export, preview import, explicit overwrite confirmation, executed import, and mobile overflow
- Browser QA should cover Project map -> Product launcher visibility, project rows, dry-run launch plan, generated URL/command, and mobile overflow
- Browser QA should cover Product sandbox visibility, boundary metrics, automatic/confirm/blocked policy cards, permission checks, no sensitive env values rendered, and mobile overflow
- Browser QA should cover local Product auth posture, hidden Auth Unlock panel in local mode, and no regression in API/WS connection after token helpers were added

## Next Implementation Order

1. Multi-project launcher follow-up: stop/restart controls and persisted process logs.
2. Optional vector cache after local index freshness semantics remain stable.
