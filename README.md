# Project Agent Terminal

A local terminal wrapper for the Project Agent MVP. It gives you a real command surface on the left and an AI-native project control plane on the right: visible memory, live process tracing, architecture change tracking, and handoff packets.

The app is designed for trusted local use. It runs commands in the selected project directory and binds to `127.0.0.1` by default.

## Local Health

The app exposes a local health snapshot:

```bash
curl http://127.0.0.1:4147/api/health
```

The response reports the API port, project directory, initialized state, terminal backend, manifest verification, memory/index freshness, and the explicit security boundary. Remote access is disabled by the default `127.0.0.1` bind host; auth is only enabled when non-local deployment is explicitly requested with a token. The header health strip uses this endpoint to show online/watch/offline and reconnect status.

## Sandbox And Permissions

The app exposes a machine-readable permission posture for the local harness:

```bash
curl http://127.0.0.1:4147/api/security/sandbox
```

The response reports local-only posture, read/write/execution/network scopes, automatic memory/context harness calls, confirmation-gated actions, blocked-by-default rules, package-script risk, and sensitive-looking env names without exposing values. The same snapshot appears in Project map -> Product -> Sandbox & Permissions.

## Optional Non-local Auth

Remote/shared access is disabled by default. A non-local bind only becomes effective when all three settings are present:

```bash
PROJECT_AGENT_BIND_HOST=0.0.0.0 \
PROJECT_AGENT_REMOTE=1 \
PROJECT_AGENT_AUTH_TOKEN="<at-least-16-characters>" \
npm run dev
```

Without the explicit remote flag and token, the server stays on `127.0.0.1`. `GET /api/security/auth` reports auth readiness without exposing the raw token. In remote mode, `/api` routes and `/terminal`/`/events` WebSockets require a bearer token; the UI can store the token locally through the Auth Unlock prompt.

## Local State Transfer

The app can export and restore `.project-agent` state through governed local APIs:

```bash
curl http://127.0.0.1:4147/api/state/export?mode=portable
```

`POST /api/state/import` defaults to dry-run and returns a create/replace/identical/reject plan. Executed imports require explicit overwrite, use hash validation, and refresh the state manifest after writing. The same flow is available in Project map -> Product -> State Transfer.

## Multi-project Launcher

The Product view also exposes a local project launcher:

```bash
curl http://127.0.0.1:4147/api/projects
```

It lists current, default, app-root, and registered projects with initialized state, active goal, memory counts, manifest health, running process state, and persisted log refs. `POST /api/projects/launch` returns a dry-run launch plan by default, including available API/UI ports and a runnable command with `PROJECT_DIR`, `PORT`, `VITE_API_PORT`, and `VITE_PORT`.

Launcher lifecycle controls are also API-first so agents and the UI can act without manual PID hunting:

```bash
curl "http://127.0.0.1:4147/api/projects/logs?projectDir=$PWD&limit=24"
curl -X POST http://127.0.0.1:4147/api/projects/stop -H "Content-Type: application/json" -d '{"projectDir":"'$PWD'","execute":true,"dryRun":false}'
curl -X POST http://127.0.0.1:4147/api/projects/restart -H "Content-Type: application/json" -d '{"projectDir":"'$PWD'","execute":true,"dryRun":false}'
```

Process logs are persisted under `.project-agent/launcher-logs/*.jsonl` with a bounded history.

## What It Does

- Opens a terminal rooted at `PROJECT_DIR`.
- Initializes the Project Agent project kernel and governance docs.
- Creates goals with acceptance criteria.
- Adds implementation actions and quality gates.
- Captures terminal command output as evidence.
- Runs completion audits before a goal can be marked complete.
- Generates a handoff packet for the next agent or session.
- Renders project memory as a knowledge graph with provenance.
- Shows the AI process cursor: previous event, current event, and next expected step.
- Scans the project architecture tree and highlights recently added, modified, or deleted files.
- Writes `.project-agent/continuity.json` so another agent can resume after a crash.
- Writes `.project-agent/takeover-summary.json` as the small default takeover packet for cold-start agent handoff.
- Writes `.project-agent/agent-context-bundle.json` as a budgeted takeover index for memory, process, architecture, governance, and validation.
- Writes `.project-agent/context-starter-prompt.md` as the summary-first starter prompt for cold-start agent takeover.
- Writes `.project-agent/context-takeover-drill.json` as the summary-first cold-start takeover rehearsal.
- Embeds objective coverage in continuity and the bundle so visible memory, dynamic process, managed architecture, and agent-neutral handoff each map to evidence and next actions.
- Writes `.project-agent/governance-spec.json` as the product-level AI-native development contract.
- Writes `.project-agent/continuity-contract.json` as the agent-neutral takeover contract.
- Writes `.project-agent/agent-runbook.json` with executable takeover steps, commands, and proof gates.
- Writes `.project-agent/memory-graph.json` with durable graph nodes, edges, and provenance.
- Writes `.project-agent/process-trace.json` with the previous/current/next AI process cursor.
- Writes `.project-agent/development-trail.json` with process steps linked to touched files, impacted folders, takeover risk, and inspect order.
- Writes `.project-agent/architecture-map.json` with the durable project tree, file changes, and inspect order.
- Embeds code graph changed-impact hints with dependents, dependencies, likely tests, symbol callers, co-changed files, and read-before-edit recommendations.
- Warns during pre-edit and handoff audit when impacted dependents or likely tests have no completed read/test evidence.
- Writes `.project-agent/state-manifest.json` with hashes for the handoff files.
- Embeds a State Boundary Audit that separates raw events, durable sources, derived indexes, and disclosure outputs.
- Tracks git freshness inside the freshness gate, including HEAD, branch, dirty files, untracked files, and state-file changes.
- Embeds a Temporal Provenance Audit that tracks fact source refs, source hashes, observed times, validity windows, stale sources, and contradictions.
- Exposes `/api/health` for local server, project, terminal, manifest, memory/index, reconnect, and security-boundary readiness.
- Exposes `/api/security/auth` for safe bind/auth readiness and optional bearer-token remote mode.
- Exposes `/api/security/sandbox` for local-only sandbox posture, permission scopes, automatic harness policy, confirmation gates, and blocked-by-default rules.
- Exposes `/api/state/export` and `/api/state/import` for dry-run-first `.project-agent` backup, migration, and restore.
- Exposes `/api/projects` and `/api/projects/launch` for local-only project discovery and launch planning without editing environment variables by hand.
- Writes `.project-agent/takeover-packet.json` as a concise next-agent startup index.
- Writes `.project-agent/continuity-audit.json` as a machine-readable takeover proof checklist.
- Writes `.project-agent/takeover-acceptance-audit.json` as a user-objective acceptance audit for visible memory, dynamic process, managed architecture, and crash-proof handoff.
- Writes `.project-agent/next-agent-prompt.md` as a paste-ready starter prompt for any replacement agent.

## AI State Panel

The right panel is intentionally not a dump of every field. It has five operational views:

- **Overview**: current step, governance, and the continuity contract.
- **Memory**: project kernel and the memory knowledge graph.
- **Process**: workstream recognition and live process trace.
- **Architecture**: browsable project tree, folder impact, and recent file changes.
- **Handoff**: continuity contract, takeover readiness, start protocol, and crash handoff state.

## Agent Continuity

Every project initialized by the CLI gets an `AGENTS.md` continuity protocol. A replacement agent should read files in this order:

1. `.project-agent/takeover-summary.json`
2. `npm run grep-context -- --project-dir /path/to/project --query "<task or active goal>" --limit 8`
3. `.project-agent/context-starter-prompt.md`
4. `.project-agent/takeover-packet.json`
5. `.project-agent/process-trace.json#current`
6. `.project-agent/architecture-map.json#recentChanges`
7. `.project-agent/agent-context-bundle.json#quickStart`
8. `.project-agent/continuity-contract.json`
9. `.project-agent/state-manifest.json`
10. `.project-agent/context-takeover-drill.json`
11. `.project-agent/governance-spec.json`
12. `.project-agent/agent-runbook.json`
13. `.project-agent/memory-graph.json`
14. `.project-agent/development-trail.json`
15. `.project-agent/architecture-map.json`
16. `.project-agent/continuity-audit.json`
17. `.project-agent/takeover-acceptance-audit.json`
18. `.project-agent/agent-context-bundle.json`
19. `.project-agent/continuity.json`
20. `.project-agent/continuity-detail.json`
21. `.project-agent/resume.md`
22. `.project-agent/recovery.md`
23. `.project-agent/state.json`
24. `PROJECT.md`
25. `docs/architecture/principles.md`
26. `docs/agents/roles.md`

The takeover summary is the default handoff surface: active goal, current state, next step, risks, readiness, byte/token budgets, source refs, and the grep-first retrieval protocol. A replacement agent should not begin by reading the full `.project-agent/agent-context-bundle.json` or `.project-agent/continuity.json`. `continuity.json` is now a lean summary-first manifest with refs, budgets, hashes, and on-demand reads; rich continuity details live in `.project-agent/continuity-detail.json` and are opened only when cited. The agent context bundle is a budgeted takeover index: each major section has a byte/token ceiling and falls back to summaries, hashes, and refs when the raw content is too large. Use `grep-context`, `jq`, or the `/api/context-read?ref=...` endpoint to inspect local fields, snippets, line ranges, and refs only when the summary or grep hits say they are needed. The objective coverage map translates the project goal into evidence-backed rows for visible memory, dynamic process, managed architecture, and agent-neutral handoff. The takeover acceptance audit turns the user's objective into a pass/warn/fail checklist backed by durable files. The context starter prompt is generated from the takeover summary, so a cold-start replacement agent can begin without depending on the previous chat or a live UI. The governance spec is the product-level contract: visible memory, dynamic process, managed architecture, and agent-neutral crash recovery. The continuity contract is the compact state contract: active goal, current cursor, capability status, inspect order, protected files, and proof checklist. The agent runbook turns that state into executable steps: summary read, grep-first context inspection, interrupted-work resolution, architecture inspection, heartbeat, current-event recording, outcome recording, and handoff refresh. Each runbook step is marked `done`, `current`, `pending`, `skipped`, or `blocked`, with `activeStepId`, `nextCommand`, and proof gates so a replacement agent knows exactly what to do next. The memory graph file stores the full project graph as durable nodes, edges, and provenance refs, not just the UI drawing. The process trace file is the dynamic work cursor: previous event, current event, next expected event, event inspect order, and files touched. The development trail file connects that process cursor to touched files, impacted folders, takeover risk, and the inspect order a replacement agent should follow before editing. The architecture map file is the durable project structure: tree, modules, recent changes, impacted folders, files, and inspect order. The state manifest hashes the handoff files so a replacement agent can see whether it is reading one coherent snapshot. The freshness gate also records git HEAD, branch, dirty files, untracked files, and state-file changes, so a handoff can be compared against the current repository snapshot. The temporal provenance audit records fact source refs, source hashes, observed times, validity windows, stale source refs, and contradictions across memory, decisions, process, and freshness state. The takeover packet is the concise startup index for a replacement agent: current cursor, first reads, first actions, guardrails, interrupted work, changed files, impacted folders, and next command. The continuity audit proves whether the handoff artifacts are present, schema-valid, and sufficient for takeover. The next-agent prompt is the paste-ready human prompt for any replacement coding agent. Together they are the crash recovery contract: the next agent should not need the previous chat transcript to know what is happening.

## Event Ingest

Any agent, hook, or wrapper can write live process events. Events are stored in `.project-agent/runtime.json`, shown in **Live Process**, added to the memory graph, and copied into `.project-agent/continuity.json`.

HTTP ingest:

```bash
curl -X POST http://127.0.0.1:4147/api/events \
  -H 'Content-Type: application/json' \
  -d '{
    "phase": "execute",
    "status": "current",
    "title": "Tool call running",
    "detail": "editing docs/product/roadmap.md",
    "agentId": "codex",
    "tool": "apply_patch",
    "files": [
      { "path": "docs/product/roadmap.md", "status": "modified", "summary": "+1/-0" }
    ]
  }'
```

Local adapter, useful for shell hooks or agents that do not want HTTP:

```bash
npm run event -- \
  --project-dir /path/to/project \
  --phase execute \
  --status current \
  --title "Tool call running" \
  --detail "editing docs/product/roadmap.md" \
  --tool apply_patch \
  --file docs/product/roadmap.md::modified \
  --summary +1/-0
```

Recommended phases are `observe`, `plan`, `execute`, `evidence`, `audit`, and `handoff`. Recommended statuses are `pending`, `current`, `done`, `failed`, and `blocked`.

## MCP Project Tools

CLI Memo can also run as a local MCP server, so coding agents can call the project memory and handoff layer directly instead of only reading fixed files:

```bash
npm run mcp -- --project-dir /path/to/project
```

The MCP server exposes the first project-native tool set:

- `project_start`: initialize or repair `.project-agent` state, optionally creating the first active goal.
- `project_takeover_summary`: read the small summary-first takeover packet.
- `project_context_search`: run grep-first retrieval with optional file/folder/fileType filters and return snippets with exact refs.
- `project_read_ref`: read a project-relative file ref, line range, or JSON selector.
- `project_record_event`: record the agent's current process event into runtime state.
- `project_architecture_changes`: inspect recent changes, impact, inspect order, code graph summary, symbol callers, likely test owners, and read-before-edit recommendations.
- `project_handoff_audit`: verify takeover readiness, freshness, manifest status, inspection coverage, blockers, and warnings.
- `project_memory_search`: search canonical memory with deterministic type/file/folder/sourceRef/concept/goalId/fileType/sourceQuality filters, exact refs, source-quality flags, and score breakdowns.
- `project_memory_seed_dogfood`: idempotently seed benchmark-backed product dogfood memories when `docs/research/memory-gap-deep-benchmark.md` exists.
- `project_memory_update`: update one canonical memory with a required reason, provenance-preserving version increment, audit row, and cache cascade refresh.
- `project_memory_supersede`: create a new canonical memory version, mark the old record non-latest with `supersededBy`, and keep both records inspectable by exact refs.
- `project_memory_retention_audit`: inspect retention policy candidates without mutation.
- `project_memory_retention_sweep`: dry-run or execute retention expiry, marking eligible records non-latest and refreshing memory indexes.
- `project_memory_rebuild_index`: rebuild the optional `.project-agent/indexes/memory-bm25.json` cache; direct search uses it when `useIndex: "bm25"` is explicitly requested and the cache is fresh.
- `project_memory_rebuild_entity_index`: rebuild the optional `.project-agent/indexes/memory-entities.json` entity graph cache over canonical memory concepts, refs, files, folders, and terms.
- `project_memory_rebuild_vector_index`: rebuild the optional `.project-agent/indexes/memory-vectors.json` local lexical-vector cache. It uses deterministic hashed sparse vectors with `embeddingProvider: "none"` and only affects search when `useIndex: "vector"` or `useIndex: "hybrid"` is requested or auto-selected by the harness.
- `project_memory_harness`: automatically derive memory search/read calls from the active goal, current cursor, recent runtime events, risks, and changed files. It auto-uses fresh BM25/entity/vector caches as a hybrid search path, checks dogfood/retention lifecycle state, returns governed next calls, and is returned by `project_takeover_summary` so agents do not wait for a human to pick memory refs manually.

HTTP mirrors the lifecycle tools with `POST /api/memory/seed-dogfood`, `POST /api/memory/update`, `POST /api/memory/supersede`, `GET /api/memory/retention`, and `POST /api/memory/retention/sweep`.

Pre-start projects are treated as `not_started`, not as failed handoffs. In that state, `project_takeover_summary` points the agent to `project_start` and avoids returning refs that do not exist yet.

## Universal Command Wrapper

When possible, run external agent commands through `agent-run`. It wraps any command, records a `current` event before execution, records `done` or `failed` afterward, scans changed files, publishes the agent heartbeat, and refreshes `.project-agent/takeover-summary.json`, `.project-agent/agent-context-bundle.json`, `.project-agent/context-starter-prompt.md`, `.project-agent/governance-spec.json`, `.project-agent/continuity-contract.json`, `.project-agent/agent-runbook.json`, `.project-agent/memory-graph.json`, `.project-agent/process-trace.json`, `.project-agent/development-trail.json`, `.project-agent/architecture-map.json`, `.project-agent/state-manifest.json`, `.project-agent/takeover-packet.json`, `.project-agent/continuity-audit.json`, `.project-agent/takeover-acceptance-audit.json`, `.project-agent/next-agent-prompt.md`, `.project-agent/continuity.json`, `.project-agent/continuity-detail.json`, `.project-agent/resume.md`, and `.project-agent/recovery.md`.

```bash
npm run agent-run -- \
  --project-dir /path/to/project \
  --agent codex-session-1 \
  --role coding_agent \
  --goal goal_123 \
  --title "Run tests" \
  --workstream qa_testing \
  -- npm test
```

Before a replacement agent trusts the handoff files, it can verify the manifest without starting the UI:

```bash
npm run manifest -- --project-dir /path/to/project --verify
```

To refresh or inspect the summary-first takeover packet without starting the UI:

```bash
npm run context -- --project-dir /path/to/project --write
```

By default this prints the lean `.project-agent/takeover-summary.json` plus verification. Add `--full` to print the budgeted context bundle.

To use grep-first retrieval as the default local context database:

```bash
npm run grep-context -- --project-dir /path/to/project --query "current task or active goal" --limit 8
npm run grep-context -- --project-dir /path/to/project --query "memory filter" --folder docs --file-type md
npm run grep-context -- --project-dir /path/to/project --read ".project-agent/process-trace.json:1-40" --max-bytes 6000
```

To generate or launch a Codex CLI agent with the summary-first and grep-first protocol:

```bash
npm run cli-agent -- --project-dir /path/to/project
npm run cli-agent -- --project-dir /path/to/project --launch
```

To let an AI harness discover the provider config and first memory calls without manual JSON editing:

```bash
curl http://127.0.0.1:4147/api/agent/bootstrap
```

The response uses `project-agent.agent-bootstrap.v1` and includes Codex, Claude Code, Gemini, Kimi, and generic MCP snippets, `project_takeover_summary` as the first tool, `project_memory_harness` as the automatic memory routing step, the ordered context/read/event protocol, and the local-only project scope. The same state appears in Project map -> Product -> Agent Bootstrap.

To prove that the summary and budgeted bundle contain enough memory, process, architecture, governance, and validation state for a cold-start replacement agent:

```bash
npm run context -- --project-dir /path/to/project --verify
```

To generate a paste-ready starter prompt from the takeover summary:

```bash
npm run context-prompt -- --project-dir /path/to/project --write
```

To rehearse the replacement agent's first actions from the takeover summary and budgeted bundle:

```bash
npm run context-drill -- --project-dir /path/to/project --write
```

To run a read-only Codex takeover smoke test and record token usage/evidence:

```bash
npm run codex-smoke -- --project-dir /path/to/project
```

The CLI writes `.project-agent/codex-takeover-smoke.json`, records a runtime audit event, and refreshes process trace/resume/recovery artifacts by default. Use `--no-refresh` only when you want to inspect the smoke artifact without updating handoff files.

To audit whether the user's objective is actually covered by durable state:

```bash
npm run acceptance -- --project-dir /path/to/project --write --verify
```

Use this for Codex, Claude, Gemini, local scripts, tests, and build commands when you want another agent to be able to recover from a crash without reading the previous chat.

## Live Architecture Events

The server also watches the project tree. When a source, docs, config, test, or state file is added, modified, or deleted, the watcher turns that change into a runtime event and pushes a notification over WebSocket:

```text
ws://127.0.0.1:4147/events
```

The UI listens to this stream and refreshes **AI State** immediately, so external agents can edit files while the user sees the process stream, knowledge graph, architecture tree, and crash handoff update without manual refresh. Internally generated `.project-agent` files are kept out of architecture-change noise, while real project source, docs, config, and tests still produce architecture events.

## Agent Leases

Agents can publish a lightweight heartbeat so the next agent can tell whether work is active or stale:

```bash
npm run agent -- heartbeat \
  --project-dir /path/to/project \
  --agent-id codex-session-1 \
  --role coding_agent \
  --goal goal_123 \
  --note "editing roadmap" \
  --lease-seconds 90
```

HTTP heartbeat:

```bash
curl -X POST http://127.0.0.1:4147/api/agents/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "codex-session-1",
    "role": "coding_agent",
    "goalId": "goal_123",
    "note": "editing roadmap",
    "leaseSeconds": 90
  }'
```

The active/stale lease list is copied into `.project-agent/continuity.json`, `.project-agent/resume.md`, and **Crash Handoff**. A stale active lease is the signal that a prior agent may have crashed mid-work. If that same stale agent also has an unsuperseded `current` runtime event, the system promotes it to **Interrupted Work** in the continuity contract, resume/recovery docs, takeover drill, and Handoff UI so the next agent resolves the half-finished operation first.

## Auto Handoff Snapshot

The server debounces runtime changes and automatically refreshes the handoff files:

```text
.project-agent/continuity.json
.project-agent/continuity-detail.json
.project-agent/takeover-summary.json
.project-agent/agent-context-bundle.json
.project-agent/context-starter-prompt.md
.project-agent/context-takeover-drill.json
.project-agent/governance-spec.json
.project-agent/continuity-contract.json
.project-agent/agent-runbook.json
.project-agent/memory-graph.json
.project-agent/process-trace.json
.project-agent/development-trail.json
.project-agent/architecture-map.json
.project-agent/state-manifest.json
.project-agent/takeover-packet.json
.project-agent/continuity-audit.json
.project-agent/takeover-acceptance-audit.json
.project-agent/next-agent-prompt.md
.project-agent/recovery.md
.project-agent/resume.md
```

This means a replacement agent does not have to wait for a manual handoff command after a crash. File changes, event ingest, terminal events, session-log imports, and agent heartbeats all schedule a fresh snapshot. Check the latest snapshot status with:

```bash
curl http://127.0.0.1:4147/api/handoff-snapshot
```

Or force a write:

```bash
curl -X POST http://127.0.0.1:4147/api/handoff-snapshot \
  -H 'Content-Type: application/json' \
  -d '{"reason":"manual"}'
```

## Session Log Adapter

When inheriting work from a crashed or previous agent, import its JSONL session log before continuing. The adapter accepts already-normalized events and common Codex/Claude-style message or tool-call records. Imported events appear in the live process, memory graph, and continuity packet.

HTTP import:

```bash
curl -X POST http://127.0.0.1:4147/api/import/session-log \
  -H 'Content-Type: application/json' \
  -d '{
    "file": "/path/to/session.jsonl",
    "format": "auto",
    "agentId": "previous-agent",
    "source": "codex-session-log"
  }'
```

Local import:

```bash
npm run import-log -- \
  --project-dir /path/to/project \
  --file /path/to/session.jsonl \
  --format auto \
  --agent previous-agent \
  --source codex-session-log
```

The adapter never needs the previous chat transcript to be manually pasted. It extracts tool calls, assistant notes, user instructions, file refs, and patch file paths where possible.

## Recovery Brief

Generate a concise handoff brief for the next agent:

```bash
npm run recovery -- --project-dir /path/to/project --role coding_agent --write
```

This writes `.project-agent/recovery.md`. The same content is available over HTTP:

```bash
curl 'http://127.0.0.1:4147/api/recovery?role=coding_agent&format=markdown&write=1'
```

The brief summarizes the active goal, current cursor, previous and next events, recent events, changed files, graph size, and read-first state files. A replacement agent should read `.project-agent/takeover-summary.json` first, then use `recovery.md` only when it needs the larger human-readable crash brief.

## Resume Packet

Generate the shortest practical starter prompt for a replacement agent:

```bash
npm run resume -- --project-dir /path/to/project --role coding_agent --write
```

This writes `.project-agent/resume.md` and, by default, refreshes `.project-agent/recovery.md` at the same time. The same content is available over HTTP:

```bash
curl 'http://127.0.0.1:4147/api/resume?role=coding_agent&format=markdown&write=1'
```

Use `resume.md` as a human-readable companion to `.project-agent/takeover-summary.json`: it contains the current objective, current cursor, previous and expected next event, changed files, recent events, and read-first files. It is meant for the "prior agent crashed, continue now" case.

## Run In Development

```bash
npm install
PROJECT_DIR=/path/to/your/project npm run dev
```

Open the Vite URL printed by the terminal, usually `http://127.0.0.1:5174`.

## Run In Production Mode

```bash
npm install
npm run build
PROJECT_DIR=/path/to/your/project PORT=4147 npm start
```

Open `http://127.0.0.1:4147`.

## Terminal Modes

The server tries to start a true PTY first through `node-pty`.

If PTY startup fails on the host machine, the app automatically falls back to pipe shell mode. Pipe mode still supports ordinary command execution and evidence capture, but full-screen interactive terminal apps such as editors, TUIs, and prompts that require a real TTY may be limited.

The mode is shown in the terminal top bar as `pty`, `pipe`, `stopped`, or `failed`.

## Project Agent CLI

By default, this UI uses:

```text
../project-agent-mvp/project_agent.py
```

Override it with:

```bash
PROJECT_AGENT_CLI=/path/to/project_agent.py PROJECT_DIR=/path/to/project npm start
```

## Verification

```bash
npm run build
npm test
```

The smoke test starts the server, initializes a project, creates a goal, loads a role-scoped kernel packet, opens the terminal WebSocket, runs a terminal command, saves the command as evidence, adds action evidence, and verifies the audit can complete.

## Security Notes

- Keep the server bound to `127.0.0.1` unless you deliberately add authentication and network hardening.
- Treat `PROJECT_DIR` as trusted; terminal input and quality gates execute local shell commands.
- Do not expose this service directly to the public internet.
