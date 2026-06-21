# Project Agent Terminal 产品开发日志

日期：2026-06-06  
最新本地提交：以 `git log -1 --oneline` 为准。  
当前状态：Summary-first takeover、grep-first retrieval、CLI Agent terminal bridge、lean continuity manifest、人类可读 handoff brief、terminal bracketed paste 清洗、直连后端 websocket 已实现并验证；远端 `origin` 指向 `Mijiang111/CLI-Memo.git`。

更新：CLI Memo 的下一阶段路线已写入 `docs/product/roadmap.md`。产品方向从“外部控制台 + 固定接手包”推进到“agent-native project memory MCP”：新增 `npm run mcp` 和 `server/project-mcp.js`，暴露 `project_start`、`project_takeover_summary`、`project_context_search`、`project_read_ref`、`project_record_event`、`project_architecture_changes`、`project_handoff_audit` 七个工具。MCP 现在把未初始化项目识别为 `not_started`，引导 agent 先调用 `project_start`，而不是输出不存在的 handoff refs。smoke test 已用真实 MCP stdio client 覆盖 cold start、工具发现和核心调用。

更新：右侧 Handoff 从“AI 可读大包”调整为“人先读 brief，AI 再展开 packet”。默认层只展示 Current objective、Where we are、Next move、Risk、Changed context；takeover summary、audit、provenance、temporal、boundary、runtime eval 等细节收进 `Agent-readable packet` 折叠区。目标是让新用户先理解产品在做什么，而不是被内部治理字段淹没。

更新：terminal 输入链路增加 bracketed paste 清洗。前端 xterm 启用 `ignoreBracketedPasteMode` 并在 `onData` 清理 `\x1b[200~` / `\x1b[201~` 与字面 `[200~` / `[201~`；后端写入 PTY、命令追踪、last-command evidence 也会二次清洗，避免命令记录和证据里出现浏览器粘贴控制序列。

更新：开发服务稳定性继续收敛。Vite 本地页面的 `/terminal` 和 `/events` websocket 改为直连后端 `4147`，绕开 Vite ws proxy 的 EPIPE 体感问题；`npm test` 默认端口改成随机高位端口，避免开发服务正在运行时 smoke test 误打真实 demo 并写入 `Smoke test / stale agent` 状态。

更新：stale goal 恢复路径补齐。浏览器如果还缓存旧 goal id，前端会在读取新 state 后自动切回当前 active goal；后端 `/api/kernel` 和 `/api/insights` 收到不存在的 goal 参数时也会降级到当前 active goal，避免 demo reset 后因为旧 URL/query 把服务打崩。

更新：demo 基线已清理。删除临时 live-watch / snapshot / agent-run demo 文档，`PROJECT.md`、roadmap、architecture principles 只保留 CLI Memo 当前核心叙事：summary-first 接手、grep-first retrieval、terminal 内启动 CLI agent、人类可读控制台。

更新：基于 agentmemory、RAVBYTE、ai-memory、Graphiti、Repomix/Gitingest 等参考项目的共同模式，`continuity.json` 已从 full-state dump 改成 lean manifest。默认文件只保留 summary、budget、hash、source refs 和 on-demand reads；rich audit/detail 移到 `.project-agent/continuity-detail.json`，由 bundle 构建和 API 在需要时 hydrate。

更新：接手协议已从“把大包塞给模型”改为 summary-first。`.project-agent/takeover-summary.json` 成为默认入口，`agent-context-bundle.json` 改为预算化索引；memory/process/architecture/handoff 超预算时只披露摘要、hash 和 source refs，由接手 agent 按需读取。

更新：新增 grep-first retrieval 层。`npm run grep-context`、`/api/context-search` 和 `/api/context-read` 提供本地、零模型、refs-first 的检索路径，让 agent 像用 RAG 一样先检索命中片段，再按 ref 读取原文。

更新：CLI Agent 入口回到 terminal 本身。产品不再在右侧提供 Codex smoke 按钮；右侧保持 Goal / State / Next / Risk / Resume、Audit、Handoff。真实 Codex 或其他 CLI Agent 应直接在 terminal 中运行，terminal 后端负责提供真实 TTY。

更新：terminal 后端新增 Python PTY bridge fallback。当前机器上 `node-pty` 会报 `posix_spawnp failed`，旧 fallback 是普通 pipe，导致 `codex` 报 `stdin is not a terminal`。现在 fallback 会启动 Python PTY bridge，让 `sys.stdin.isatty()` 返回 `True`，`codex --version` 可在产品 terminal 中正常输出。

更新：State Boundary Audit 已落地到 continuity、continuity contract、agent context bundle validation、provenance ledger、attention pack、starter prompts、Handoff UI 和 smoke tests。它把 raw events、durable sources、derived indexes、disclosure outputs 明确分层，避免把 prompt/resume/graph index 误当成唯一真相。

更新：Git Freshness Audit 已接入 freshness gate。系统会读取 git HEAD、branch、dirty tree、untracked files 和 state-file changes，并把结果写入 continuity、bundle、starter prompts、Handoff UI 和 smoke tests。dirty tree 不会直接阻断接管，但会作为 freshness warning，提醒下一位 agent 在声称可复现 handoff 前先 review、commit 或 stash。

更新：本轮产品工作已经从“能恢复上下文”推进到“能解释这个上下文是否可信”。State Boundary 负责区分真相源和披露层；Git Freshness 负责把 handoff snapshot 和当前 repo 快照对齐。这两个能力让 Project Agent Terminal 更接近一个 agent control plane，而不是单纯的 resume 文件生成器。

更新：Temporal Provenance Audit 已从 Graphiti benchmark 转化成产品能力。系统会把 memory graph、decision ledger、process trace、freshness gate 中的重要 fact 统一成 temporal facts，记录 source refs、source hash、observedAt、validFrom、validUntil、stale sources、watch/invalid 状态和 contradictions，并写入 continuity、continuity contract、agent context bundle validation、provenance ledger、attention pack、starter prompts、Handoff UI 和 smoke tests。

更新：Phase 4 的第一段 retrieval quality 已落地。`project_memory_search` 不再只是 keyword grep，它现在支持 type、file、folder、sourceRef、concept、goalId、fileType、minConfidence、sourceQuality、latestOnly 等 deterministic filters，并在每条结果里返回 `sourceQuality` 和 score breakdown。`project_context_search` 同步支持 folder/file/fileType 缩小范围，CLI `grep-context` 也增加 `--folder` 和 `--file-type`。AI memory harness 可以继承这些过滤条件，但默认仍自动 search/read/consolidate，不要求用户手动挑记忆。

更新：Phase 4 的 optional BM25 cache 已落地。新增 `.project-agent/indexes/memory-bm25.json`，由 canonical memory JSONL 生成 `bm25-lite` cache，并用 canonical hash 判断 fresh/stale。`project_memory_rebuild_index`、`POST /api/memory/index/rebuild` 负责重建；`project_memory_inventory` 和 Project map -> Memory 会显示 index freshness；直接 `project_memory_search` 只有显式 `useIndex: "bm25"` / `useIndex=bm25` 时才使用 cache，缺失或 stale 时自动回落到确定性的 grep-first ranking；AI memory harness 在 cache fresh 时会自动用 BM25，不要求用户手动选择记忆或手动选择索引。

## 一、产品定位

Project Agent Terminal 的方向已经从“本地 terminal wrapper”推进到“AI-native 项目治理工作台”：

- 左侧保留真实终端和项目执行面。
- 右侧提供可视化项目状态、过程追踪、架构影响、证据、审计和 handoff。
- 核心目标是让下一个 agent 不依赖上一段聊天记录，也能从 `.project-agent/` 的 durable state 接管项目。

这和 benchmark 里的单点能力不同：memory 项目负责记忆，repo intelligence 项目负责解释代码库，prompt packing 项目负责压缩上下文，observability 项目负责看运行轨迹。我们的产品要把这些能力合成一个可恢复、可审计、可交接的 agent control plane。

## 二、Benchmark 启发

本轮参考和吸收的方向主要来自：

- `ravbyte-ai/agent-memory-system`：repo 内 handoff 文件夹、required files、freshness validation。
- `neo4j-labs/agent-memory` 和 `memory-graph/memory-graph`：长期记忆应当是有 provenance 的 graph，而不是散乱摘要。
- `repowise-dev/repowise`：代码库智能需要 map、risk、impact 和多层 context。
- `repomix` / `gitingest`：prompt packing 必须有文件数、字节数、token budget 和 omitted refs。
- `akitahq/akita`：hook ingress 要有 sanitization、backpressure；source-of-truth 与 derived index 需要明确分层。

Benchmark 结论已经沉淀在 `docs/research/agent-governance-landscape.md`。当前产品实现优先覆盖了 memory、process、architecture、handoff、prompt packing、hook backpressure 这些高杠杆能力。

## 三、已产品化能力

### 1. Agent Context Bundle

新增/强化 `.project-agent/agent-context-bundle.json`，作为单文件接管索引。它把 quick start、memory graph、process trace、development trail、architecture map、governance、validation、handoff lifecycle、acceptance audit 放在一个 agent-neutral bundle 里。

产品价值：冷启动 agent 可以先读一个文件，快速知道目标、当前 cursor、下一步命令、风险、证据和必须验证的状态。

### 2. Continuity Contract 与 Runbook

新增 `.project-agent/continuity-contract.json` 和 `.project-agent/agent-runbook.json`：

- contract 负责“当前状态是什么、哪些能力可用、source-of-truth 在哪里”。
- runbook 负责“下一步怎么执行、用什么命令、哪些 proof gate 必须满足”。

产品价值：handoff 从自然语言提示变成可执行协议。

### 3. Memory Graph 与 Process Trace

新增 durable memory graph 和 process trace 文件：

- `.project-agent/memory-graph.json`：节点、边、provenance refs。
- `.project-agent/process-trace.json`：previous/current/next cursor、inspect order、file refs。
- `.project-agent/development-trail.json`：把过程事件和文件、文件夹、编辑风险连接起来。

产品价值：agent 的“知道什么”和“正在做什么”都可以被 UI 和下一个 agent 读取。

### 4. Architecture Map 与 Code Graph

新增 `.project-agent/architecture-map.json`，包含项目树、recent changes、impacted folders、inspect order 和 code graph。

产品价值：编辑前不仅看改动文件，还能看到依赖影响和优先检查顺序，降低覆盖他人工作或漏测的风险。

### 5. State Manifest、Freshness Gate、Provenance Ledger

新增状态 manifest 和验证层：

- `.project-agent/state-manifest.json`：记录 handoff 文件 hash、schema、mtime。
- freshness gate：检查状态是否过期。
- provenance ledger：检查 takeover claims 是否有 source refs 和 hashes。

产品价值：handoff 不只是“文件存在”，还要证明这些文件属于同一个可信快照。

### 6. Prompt Packing Gate

根据 Repomix/Gitingest 的经验，新增 prompt packing gate：

- 限制最大文件数、最大字节数。
- 记录 included files、omitted files、omitted refs。
- 把 packing 状态写进 bundle、prompt、UI 和 smoke test。

产品价值：bounded prompt 不再假装自己包含全部上下文；被省略的 refs 会明确暴露出来。

### 7. Hook Backpressure Audit

根据 Akita 的 hook ingress 设计，新增 sanitized hook ingress 和 backpressure audit：

- `/api/hooks`、`/api/events` 会记录 accepted/rejected events。
- 在 saturation 情况下返回 429，并带 `retryAfterMs`。
- continuity、bundle、prompt、UI、smoke 都能看到 backpressure 状态。

产品价值：外部 hook 不再是黑盒输入；它有边界、有拒绝记录、有压力状态。

### 8. State Boundary Audit

根据 Akita 的 source/index 分层和 RepoWise 的 evidence discipline，新增 State Boundary Audit：

- 将 raw events、durable sources、derived indexes、disclosure outputs 四层写入 continuity。
- 在 continuity contract 中标出 source-of-truth、derived indexes 和 prompt disclosure。
- 在 agent context bundle、starter prompt、next-agent prompt、Handoff UI 和 smoke test 中暴露边界检查。

产品价值：下一个 agent 不会把 prompt、resume、graph preview 或 UI 摘要误当成唯一真相；系统会提示它回到 raw/durable source refs 进行验证。

### 9. Git Freshness Audit

根据 ravbyte handoff validator 的 git freshness 思路，新增 Git Freshness Audit：

- 读取 git HEAD、branch、dirty tree、untracked files、state-file changes。
- 在 freshness gate 中增加 `git_snapshot` 检查，并把 git 状态写入 continuity contract。
- 在 prompt 和 Handoff UI 中显示当前 git 快照，帮助下一位 agent 判断接管状态是否仍然可复现。

产品价值：handoff 不再只证明 `.project-agent/` 文件存在，还能说明它们和当前 repository snapshot 的关系。dirty tree 会成为接管前必须注意的 warning，而不是被隐藏在终端里。

### 10. Temporal Provenance Audit

根据 Graphiti 的 temporal knowledge graph 思路，新增 Temporal Provenance Audit：

- 将 decision、memory node、memory edge、process cursor、freshness snapshot 统一成 temporal facts。
- 每条 fact 暴露 `sourceRefs`、`sourceHash`、`observedAt`、`validFrom`、`validUntil`、`changedSources` 和 `invalidatedBy`。
- 在 continuity contract 中新增 `temporal_provenance` capability 和 source-of-truth 指针。
- 在 agent context bundle、starter prompt、next-agent prompt、provenance ledger、attention pack、Handoff UI 和 smoke test 中暴露 temporal provenance。

产品价值：接手 agent 不只知道“这个说法来自哪里”，还知道“这个说法什么时候观察到、什么时候仍然有效、是否被后续变更变成 stale/watch/invalid”。这把 handoff 从 evidence-backed 推进到 time-aware。

### 11. Summary-first Takeover 与 Budgeted Context

根据 benchmark 中 prompt packing 和 durable handoff 的共同问题，接手协议改为 summary-first：

- `.project-agent/takeover-summary.json` 成为默认接手包。
- `agent-context-bundle.json` 改成预算化索引，超预算内容只保留摘要、hash 和 source refs。
- `npm run context` 默认输出 summary，`--full` 才输出完整 bundle。
- README、AGENTS、resume、recovery、smoke test 都同步成 summary-first 协议。

产品价值：下一个 agent 的冷启动不再依赖大上下文注入，而是先读小摘要，再按 refs 钻取。成本、延迟和上下文爆炸风险都更可控。

### 12. Grep-first Retrieval 与 CLI Agent Terminal

根据用户提出的 grep 架构方向，新增本地检索式上下文读取：

- `server/grep-context.js` 提供 project-local search/read 能力。
- `npm run grep-context` 可按 query 搜索 source refs，也可按 `file:line-line` 读取片段。
- `/api/context-search` 和 `/api/context-read` 提供同等 API 能力。
- `npm run cli-agent` 生成 CLI Agent bootstrap prompt；`--launch` 可直接启动 Codex CLI。
- terminal 后端新增 Python PTY bridge，确保 CLI Agent 拿到真实 TTY。

产品价值：Project Agent Terminal 的“记忆”不再只是把状态压缩给模型，而是形成 grep-first、refs-first、on-demand reads 的本地检索协议。terminal 仍是所有 CLI Agent 的执行入口，避免把 agent 启动做成额外 UI 按钮。

### 13. Lean Continuity Manifest

根据 GitHub 参考项目的实现方式，继续压缩默认接手面：

- `.project-agent/continuity.json` 不再内嵌 `agentContextBundle` 或 `takeoverSummary`。
- `.project-agent/continuity-detail.json` 保存 phase/checkpoint/decision/temporal/state-boundary/runtime/hook 等 rich detail，只有按 ref 读取时才进入上下文。
- `writeContinuity()` 返回给当前进程的对象仍是 hydrated 版本，保持 UI/API/smoke 兼容；磁盘默认文件则是 summary-first manifest。
- `buildAgentContextBundle()` 支持从 full continuity、continuity-detail、既有 bundle validation、continuity contract 逐级补齐，避免 CLI 重建时把 rich audit 降级成 compact summary。
- smoke + context + codex-smoke 串联后 `continuity.json` 约 52KB，内部预算约 10.2k tokens；此前 demo continuity 曾超过 800KB，粗估 20 万 tokens。

产品价值：这一步把“记忆管理会不会挤爆上下文”的风险从架构上拆开。默认接手只读小包和索引，细节保存在可 grep、可 hash、可按需读取的本地文件里。

### 14. Canonical Memory Lifecycle

根据 `docs/product/roadmap.md` 和 `docs/product/memory-implementation-steps.md`，把 Phase 3 的 canonical memory 基座落到代码中：

- 新增 `server/memory-store.js`，将 `.project-agent/memory/*.jsonl` 作为长期记忆 source of truth。
- `project_start` / `/api/init` 会创建 `index.md`、episodes/facts/decisions/procedures/evidence/risks/audit JSONL 和 `retention.json`。
- MCP 新增 `project_memory_inventory`、`project_memory_add`、`project_memory_read`、`project_memory_search`、`project_memory_forget`、`project_memory_harness`、`project_memory_consolidate`、`project_memory_audit`。
- HTTP 新增 `/api/memory/inventory`、`/api/memory/search`、`/api/memory/harness`、`/api/memory/consolidate`、`/api/memory/audit`、`/api/memory/read`、`POST /api/memory`、`POST /api/memory/consolidate`、`POST /api/memory/forget`。
- `project_memory_forget` 默认 `dryRun: true`，先报告 canonical records、runtime events、generated files、index entries，再允许显式执行 `delete`、`redact`、`expire`、`supersede`。
- 执行 delete 会删除 canonical record、重建 `index.md`，并由 MCP/API 包装层刷新或调度 takeover/context/state-manifest 更新。
- 执行 redact 会替换内容、标记 redaction metadata，并移除指定 file/sourceRef/generated artifact 引用。
- `project_memory_consolidate` 默认 dry-run，从 runtime events、handoff risks、architecture changes 生成 typed candidates；显式执行时只写入 ready candidates，低信心候选保留为 proposal，重复候选按 consolidation hash 跳过。
- `project_memory_harness` 会从 active goal、current cursor、recent runtime events、risks、changed files 自动生成查询，自动调用 canonical memory search/read，并自动跑非破坏性的 consolidation discovery。`project_takeover_summary` 会直接携带 `memoryHarness`，CLI bootstrap 也会写入 Automatic Memory Harness 段落，让 AI 一进入项目就知道该读哪些记忆，而不是等用户手动点 UI。
- `project_memory_audit` 可按 action、mode、ref、type、memory id、dry-run state、time window 查询 append-only lifecycle rows。
- `project_memory_rebuild_index` 会从 canonical memory 重建 `.project-agent/indexes/memory-bm25.json`，并记录 index freshness/audit row；index 是 cache，不是 source of truth。
- 右侧 Project map -> Memory 显示 Canonical Memory inventory、AI memory harness 自动调用、consolidation proposals、per-record `Preview forget` dry-run 影响面和 Audit timeline。

产品价值：这一步让 CLI Memo 能回答“你记住了什么、在哪里、能否删除、删除会影响什么、哪些运行痕迹值得沉淀，以及 AI 当前应该自动读取哪些记忆”。它把 memory 从生成文件里的重复摘要，推进成可审计、可搜索、可 dry-run 删除、可从运行过程沉淀，并能由 agent harness 自动调用的本地项目状态。

### 15. Deterministic Retrieval Filters And Quality

根据 Phase 4 roadmap，把 grep-first retrieval 往“本地项目记忆数据库”推进：

- `project_memory_search` 支持 type、file、folder、sourceRef、concept、goalId、fileType、minConfidence、sourceQuality、latestOnly 过滤。
- ranking 明确暴露 exactRef、keyword、path、concept、filterMatch、currentGoal、changedFile、statePriority、sourceQuality、recency、importance、latest 等 breakdown。
- source quality 会把低信心、redacted、superseded、缺少直接 source refs、仅引用 derived handoff 文件的记录标成 weak/watch/strong，避免 agent 在注入前看不见 claim 风险。
- `project_context_search` 和 `npm run grep-context` 支持 folder/file/fileType narrowing，继续保持零模型、确定性、refs-first。
- 右侧 Project map -> Memory 增加 query/type/folder/fileType/concept/sourceQuality 控件，并显示 applied filters、filtered/total record count、source quality 和 exact refs。

产品价值：agent 不需要靠自然语言猜“读哪条记忆”。它可以用确定性 filters 缩小范围，同时看到每个结果为什么排在前面，以及这条 claim 是否足够可靠。

### 16. Optional BM25 Memory Cache

根据 Phase 4 roadmap，把 fuzzy-ish local recall 做成可重建 cache，而不是替代 canonical memory：

- 新增 `.project-agent/indexes/memory-bm25.json`，schema 为 `project-agent.memory-search-index.v1`。
- index 存储 canonical hash、document statistics、BM25 params、document term frequencies 和 idf。
- `project_memory_rebuild_index` / `POST /api/memory/index/rebuild` 重建 cache，并写入 `memory_index_rebuilt` audit row。
- `GET /api/memory/index` 和 `project_memory_inventory.indexes.memorySearch` 报告 `fresh` / `stale` / `missing` / `invalid`。
- 直接 `project_memory_search` 只有在显式请求 `useIndex=bm25` 且 cache fresh 时才加入 `scoreBreakdown.bm25`；否则回落到 deterministic grep-first。
- `project_memory_harness` 在 fresh cache 存在时自动给 search call 带上 `useIndex=bm25`，并继续自动 `project_memory_read` top results。
- UI 的 Canonical Memory 卡片显示 BM25 freshness，并提供 `BM25 cache` search mode 作为可观测/调试入口，而不是用户必经流程。

产品价值：我们开始拥有“可提高召回，但可删除、可重建、可审计”的本地索引层。它不改变 forget 语义，也不会让 generated/index 文件变成事实来源。

### 17. Optional Entity Graph Memory Cache

继续 Phase 4 的 retrieval quality，新增本地 deterministic entity graph cache：

- 新增 `.project-agent/indexes/memory-entities.json`，schema 为 `project-agent.memory-entity-index.v1`。
- index 从 canonical memory 的 `concepts`、`sourceRefs`、`files`、folders、file extensions、title/content terms 生成 entity nodes、record memberships 和 co-occurrence edges。
- `project_memory_rebuild_entity_index` / `POST /api/memory/entity-index/rebuild` 重建 cache，并写入 `memory_entity_index_rebuilt` audit row。
- `GET /api/memory/entity-index` 和 `project_memory_inventory.indexes.memoryEntities` 报告 `fresh` / `stale` / `missing` / `invalid`。
- 直接 `project_memory_search` 支持 `useIndex=entity` 和 `useIndex=hybrid`，命中时返回 `scoreBreakdown.entity`、matched entities 和 expanded graph entities。
- `project_memory_harness` 在 BM25 和 entity cache 都 fresh 时自动使用 `hybrid`，只存在其中一个 fresh cache 时自动降级到对应 index，都不可用时回落 deterministic。
- UI 的 Canonical Memory 卡片显示 entity freshness，并提供 `Entity graph` / `Hybrid cache` search mode 作为可观测/调试入口。

产品价值：AI 不需要用户手动挑选记忆，也不需要依赖 embedding 服务，就能通过项目实体、文件、folder、concept 和术语关系自动召回相关 canonical memory。这个 cache 仍然可重建、可审计、可在 forget 后标记 stale。

### 18. Optional Vector Memory Cache

继续 Phase 4 的 retrieval quality，新增本地 deterministic vector rerank cache：

- 新增 `.project-agent/indexes/memory-vectors.json`，schema 为 `project-agent.memory-vector-index.v1`。
- index 从 canonical memory 的 type、title、content、concepts、source refs 和 files 生成 hashed sparse lexical vectors。
- `project_memory_rebuild_vector_index` / `POST /api/memory/vector-index/rebuild` 重建 cache，并写入 `memory_vector_index_rebuilt` audit row。
- `GET /api/memory/vector-index` 和 `project_memory_inventory.indexes.memoryVectors` 报告 `fresh` / `stale` / `missing` / `invalid`。
- 直接 `project_memory_search` 支持 `useIndex=vector` 和 `useIndex=hybrid`，命中时返回 `scoreBreakdown.vector` 和 `ranking.optionalIndexes.vector`。
- `project_memory_harness` 在任意多个 optional caches fresh 时自动使用 `hybrid`，三种 cache 都 fresh 时会同时纳入 BM25、entity 和 vector signals。
- UI 的 Canonical Memory 卡片显示 vector freshness，并提供 `Vector rerank` / `Hybrid cache` search mode 作为可观测/调试入口。

产品价值：这是 embedding 之前的安全落地层。它提升 fuzzy recall，但不联网、不隐藏来源、不改变 forget 语义；所有结果仍必须带 canonical refs，cache 可以删除后从 canonical memory 重建。

### 19. Governed UI Memory Execution

根据 roadmap checklist 的 UI execution gate，把 Memory 面板从“只能预览”推进到“可执行但受治理”：

- Forget 仍然必须先跑 `POST /api/memory/forget` dry-run，显示 canonical records、runtime events、generated files 和 index entries 的影响面。
- 只有 dry-run preview 命中记录后，UI 才显示 `Confirm delete` checkbox 和 `Execute delete` 按钮。
- Execute delete 复用同一个 `/api/memory/forget`，发送 `dryRun:false`、dry-run preview 中的 refs、`mode:delete`，因此继续写 audit row、刷新 manifest、触发 handoff snapshot。
- Consolidation 面板显示 dry-run proposals 后，只有 ready candidates 才能通过 `Confirm promote` checkbox 和 `Promote ready` 按钮执行。
- Execute consolidate 走 `POST /api/memory/consolidate`，使用 `mode:manual` + candidate ids，避免 UI 执行时意外提升未预览候选。
- Search 无结果和 consolidation 无候选时显示 compact empty state，减少过度过滤时的“空白面板”。

产品价值：用户不需要手动编辑 memory 文件，也不会误触 destructive write；AI harness 继续自动发现/读取，人工只在真正需要删除或提升长期记忆时做明确确认。

### 19b. Phase 3 P0 Memory Lifecycle Closure

根据 `docs/research/memory-gap-deep-benchmark.md` 的深度 benchmark，把 canonical memory 从“可写可搜”推进到“有生命周期闭环”：

- 新增 `project_memory_seed_dogfood` / `POST /api/memory/seed-dogfood`，当项目存在 `docs/research/memory-gap-deep-benchmark.md` 时，稳定、幂等地写入 product dogfood 记忆：grep-first source of truth、P0 lifecycle 顺序、harness 自动读取协议、lexical vector 风险、generated state 可重建。
- 新增 `project_memory_update` / `POST /api/memory/update`，对单条 canonical memory 做 provenance-preserving update：必须有 reason，默认保留 created/source/scope，递增 version，记录 changed fields 和 content hash，并刷新 index/cache。
- 新增 `project_memory_supersede` / `POST /api/memory/supersede`，创建新 record version，把旧 record 标记为 `isLatest=false`、`supersededBy=<newId>`，新 record 携带 `supersedes` 链，历史仍可精确读取。
- 新增 `project_memory_retention_audit`、`project_memory_retention_sweep`、`GET /api/memory/retention`、`POST /api/memory/retention/sweep`。audit 非破坏性；sweep 默认 dry-run，执行时只把合格过期记录标记 expired/non-latest，不删除 durable decisions/procedures。
- `add/update/supersede/forget/consolidate/retention sweep` 现在执行后都会级联刷新 `.project-agent/memory/index.md`、BM25、entity、lexical-vector caches，避免 harness 读到旧索引。
- `project_memory_inventory` 和 Project map -> Memory 增加 dogfood/retention lifecycle 状态；`project_memory_harness` 自动返回 lifecycle 状态和 next calls，不需要用户手动判断该读哪条记忆或该执行哪个治理工具。

产品价值：这一步回应了用户“不要让用户手动做，而是 AI 通过 harness 自动识别记忆读取和调用”的要求。CLI Memo 现在不只是能保存记忆，也能让 AI 自动发现空 dogfood、过期记录、更新/替换路径和刷新状态，并通过 MCP/API 受治理地落地。

### 20. Phase 5 Code Intelligence: Test Ownership Hints

根据 Phase 5 roadmap，把 architecture code graph 从“文件级 import 可视化”推进到“改文件前该读什么、该跑什么测试”的自动提示：

- `server/architecture.js` 的 `codeGraph` 现在会基于 recent changes 生成 `changedImpact`，包含 dependents、dependencies、packageImports、tests、testStatus、coChanged、recommendedReads、why、refs 和 nextAction。
- 新增 test ownership 推断：同 stem、同目录命名和 source-name 匹配的 test 文件会进入 `testOwnershipByPath`，作为 agent pre-edit risk 的自动测试 owner 信号。
- `coChangeRecommendations` 把同目录 co-changed 文件和 dependency/test refs 合并成 read-before-edit 建议，避免用户手动猜“该先看哪些文件”。
- `server/insights.js` 会把 persisted code graph hints 注入 continuity codeGraph，并让 `preEditRisk.dependency_impact` / `test_gap` 引用 impacted tests。
- `server/runtime-state.js` 和 `server/agent-context-prompt.js` 把 impacted tests/recommended reads 带进 agent context，供 harness 和新 session 自动读取。
- Project map -> Graph 的 changed-impact card 显示 dependents/deps/tests，并展示紧凑的 recommended read chips 和 co-change summary。

产品价值：Phase 5 的第一步不是让用户多点一个面板，而是让 agent 在接管、编辑前风险判断和 UI 观测里自动看到“这个文件为什么重要、哪些调用者/测试/邻近文件应该先读”。

### 21. Phase 5 Code Intelligence: Handoff Inspection Coverage

继续 Phase 5 acceptance，把 “should read” 推进到 “handoff audit can warn when not read/tested”：

- `preEditRisk.inspectionCoverage` 从 `codeGraph.changedImpact` 自动生成 required refs：changed file 的 dependents 和 likely tests。
- coverage detector 只把完成态的 observe/evidence/audit/handoff/read/grep/test 类 runtime events 视为 inspection evidence；普通 edit event 不会自动洗白。
- architecture watcher 产生的 `File added` / `File modified` / `File deleted` 事件被显式排除，避免“文件被扫描到”误判成“agent 已经读过/测过”。
- `handoffLifecycle.checks` 新增 `inspection_coverage`，让 handoff 状态直接显示 impacted dependent/test refs 是否有证据。
- MCP `project_handoff_audit` 返回 `inspectionCoverage`，并在缺口存在时把 `inspection_coverage` 放进顶层 `warnings`。
- agent context prompt 和 next-agent prompt 增加 inspection coverage 状态和 missing count。
- UI 的 Pre-Edit Risk 显示 `inspect missing/required` 以及 missing/seen chips。

产品价值：AI harness 不再只是自动推荐读哪些文件，还会自动判断这些文件/测试是否真的有完成态 evidence。用户不需要手动勾选；agent 只要通过现有 event/evidence 流程记录读过或测试过，handoff warning 就会自动消失。

### 22. Phase 6 Productization: Local Health And Reconnect

根据 Phase 6 roadmap，先落一个最小但完整的产品化健康面：

- 新增 `GET /api/health`，schema 为 `project-agent.health.v1`。
- health snapshot 覆盖 server bind host、port、uptime、projectDir、initialized、terminal backend、state manifest verification、canonical memory 状态、BM25/entity/vector index freshness 和 warnings。
- security boundary 明确写入 health：`boundary=local_only`、`auth=not_enabled`、`remoteAccess=disabled_by_bind_host`。
- 主 Header 新增 health strip，显示 online/watch/offline、project name、API port 和 local-only boundary。
- 前端 `refreshAll` / insights polling 会读取 `/api/health`；初始握手显示 `checking`，失败时才进入 `offline`，记录 consecutive failures、last error 和 next retry，并显示 `Reconnect` 按钮。
- smoke test 覆盖 `/api/health` schema、local-only boundary、port、projectDir、terminal/memory/state fields，以及 UI source 中的 health/reconnect strip。
- Browser QA 覆盖桌面和 390px 移动宽度：health strip 显示 `ok / demo-project / :4147 / local only`，无横向 overflow；停掉 dev server 后自动进入 `offline`，重启服务后无需用户手动操作即可恢复 `ok`。

产品价值：用户和 incoming agent 不需要打开日志就能知道本地 control plane 是否可靠、是否只是本机可访问、当前项目和 terminal/backend 是否健康。这个健康面也是后续 multi-project launcher、import/export 和 remote auth 的前置地基。

### 23. Phase 6 Productization: State Import/Export

根据 Phase 6 roadmap，第二段落地 `.project-agent` state transfer：

- 新增 `server/state-transfer.js`，导出 `project-agent.state-export.v1` bundle。
- export mode 支持 `minimal`、`portable`、`full`：默认 `portable` 包含 source 和 generated handoff state，排除 volatile runtime、rebuildable indexes 和 transfer backup paths。
- 新增 `POST /api/state/import`，返回 `project-agent.state-import-plan.v1`。导入默认 dry-run，会列出 create / replace / identical / rejected，并验证 schema、`.project-agent/` 路径边界、重复路径、utf8 content、sha256、单文件大小和总大小。
- 执行导入必须显式 `dryRun:false` 和 `overwrite:true`；写入使用 atomic temp-file replace，替换前备份到 `.project-agent/import-backups`，成功后刷新 state manifest 并记录 runtime event。
- Project map 新增 `Product` tab，State Transfer 面板提供 Export、Stage Export、Preview Import、overwrite confirmation 和 Import。
- smoke test 覆盖 portable export 不包含 `.project-agent/runtime.json`、同 bundle dry-run 全部 identical、合成 bundle create preview、执行导入写入测试文件并刷新 manifest、UI source 包含 state transfer surface。

产品价值：备份、迁移、恢复不再是“复制整个隐藏目录”。用户和 agent 都能先拿到 hash-backed transfer plan，再决定是否覆盖；这延续了 memory forget/consolidation 的 dry-run-first 治理模式。

### 24. Phase 6 Productization: Multi-project Launcher

根据 Phase 6 roadmap，第三段落地本地 multi-project launcher：

- 新增 `server/project-launcher.js`，提供 local registry、project summary、port discovery、launch plan 和可执行 launch。
- `GET /api/projects` 返回 `project-agent.project-launcher.v1`，自动列出 current/default/app-root/registered projects，并展示 initialized、active goal、memory counts、manifest health、running instance 和 local-only boundary。
- `POST /api/projects/register` 写入 `.project-agent/project-launcher.json`，可用 `create:true` 创建目标目录。
- `POST /api/projects/launch` 默认 dry-run，返回 `project-agent.project-launch-plan.v1`，自动避开当前 API/UI port，生成 `PROJECT_DIR=... PORT=... VITE_API_PORT=... VITE_PORT=... npm run dev`。
- `dryRun:false` + `execute:true` 可以从当前 server 启动独立本地实例；当前 smoke 和 Browser QA 只验证 dry-run plan，避免测试阶段遗留额外 listener。
- `vite.config.js` 支持 `PORT`、`VITE_API_PORT`、`VITE_PORT`；前端 websocket endpoint 不再硬编码 `4147`，launcher 生成的多实例命令可用。
- Product tab 新增 Project Launcher 面板，显示项目列表、Register、Refresh、Plan、Start、URL 和 launch command。
- smoke test 覆盖 launcher schema、current project discovery、register target project、dry-run launch plan 和 UI source surface。

产品价值：用户和 AI harness 不再需要手动编辑 `PROJECT_DIR` / `PORT` / Vite proxy。每个项目仍作为独立 local-only Project Agent Terminal instance 运行，保留项目级 health、memory、terminal、state 边界。

### 25. Phase 6 Productization: Sandbox And Permission Guidance

根据 Phase 6 roadmap，第四段落地机器可读 sandbox / permission guidance：

- 新增 `server/sandbox-guidance.js`，只读生成 `project-agent.sandbox-guidance.v1`。
- 新增 `GET /api/security/sandbox`，返回 local-only posture、auth 状态、project/state boundaries、read/write/execution/network scopes、automatic harness calls、requires-confirmation gates、blocked-by-default policies、sensitive env name counts 和 package script risk。
- endpoint 只返回敏感 env 名称和数量，不返回任何 env value。
- `/api/health.security.sandbox` 增加 compact summary，incoming agent 可以通过 health 先发现当前权限 posture。
- Product tab 新增 Sandbox & Permissions 面板，展示 Boundary、Writes、Scripts、Env Names、Automatic / Confirm / Blocked policy cards、scope counts 和具体 checks。
- smoke test 覆盖 sandbox schema、本地边界、auth not enabled、env values hidden、automatic memory harness policy、state import confirmation、remote bind blocked-by-default、write/execution scopes，以及 UI source surface。

产品价值：permission guidance 不再是用户手动读文档，而是 harness 自动可读的 posture snapshot。AI 可以自动知道 memory search/read/consolidation dry-run 是允许自动调用的，state import overwrite、memory forget execute、memory consolidation execute、launcher process spawn 必须走确认/显式执行，remote bind、路径逃逸、raw secret value export 等默认阻断。

### 26. Phase 6 Productization: Optional Auth For Intentional Non-local Deployment

根据 Phase 6 roadmap，第五段落地可选 remote/shared auth：

- 新增 `server/auth-boundary.js`，生成 `project-agent.auth-boundary.v1`。
- 默认仍然 effective bind `127.0.0.1`、`auth=not_enabled`。
- 请求非本地 bind 但没有 `PROJECT_AGENT_REMOTE=1` 或 `PROJECT_AGENT_AUTH_TOKEN` 时，server 会继续绑定 `127.0.0.1`，并把 remote posture 标记为 `blocked_by_auth_guard`。
- 只有 `PROJECT_AGENT_BIND_HOST=0.0.0.0`、`PROJECT_AGENT_REMOTE=1`、`PROJECT_AGENT_AUTH_TOKEN` 同时存在且 token 长度达标时，effective bind 才切到非本地，并启用 bearer-token auth。
- `GET /api/security/auth` 是公开 readiness endpoint，只返回 token fingerprint，不返回 raw token。
- remote auth mode 下，所有 `/api` 路由以及 `/terminal`、`/events` WebSocket upgrade 都要求 `Authorization: Bearer <token>`、`X-Project-Agent-Token` 或 WebSocket `authToken` query。
- `vite.config.js` 使用同一份 effective bind host；`npm run dev` 不再硬编码 `vite --host 127.0.0.1`。
- 前端 `api()` 会自动从 localStorage 读取 `project-agent-auth-token` 并附带 bearer token；`wsEndpoint()` 会给 WebSocket 附加 `authToken` query。
- 新增 `AuthUnlockPanel`，remote mode 下 API 返回 401 时可以输入 token 解锁。
- smoke test 会临时启动一个 `0.0.0.0` + bearer token server，验证 `/api/security/auth` 不泄漏 token、无 token 访问 `/api/health` 返回 401、有 bearer token 才能读取 health。

产品价值：remote/shared use 终于有了真实的执行边界，而不是“文档说要小心”。更重要的是，它仍然符合用户偏好的 harness 自动识别：agent 可以先读 `/api/security/auth` 判断当前 bind/auth posture，再决定是否带 token 调用 API；本地默认体验完全不增加步骤。

### 27. Phase 2 Agent Bootstrap Kit

根据用户偏好“不要让用户手动做，让 AI 通过 harness 自动识别记忆读取和调用”，把 Agent Bootstrap 从 markdown/CLI 辅助推进成机器可读合约：

- `server/cli-agent-bootstrap.js` 新增 `buildAgentBootstrapKit()`，返回 `project-agent.agent-bootstrap.v1`。
- `GET /api/agent/bootstrap` 返回 provider-neutral bootstrap kit，不写磁盘，可被 AI harness 直接读取。
- `GET /api/cli-agent-bootstrap` 保持原有 markdown fallback，同时返回同一份 `bootstrapKit`，避免 CLI/API 分叉。
- kit 包含 Codex、Claude Code、Gemini、Kimi 和 generic MCP 配置，canonical command 是 `npm run mcp -- --project-dir <dir>`。
- kit 明确 `firstCall.tool=project_takeover_summary`，并把 `automaticHarness.tool=project_memory_harness`、hybrid index preference、search/read/consolidate 参数写成结构化字段。
- ordered `toolProtocol` 覆盖 takeover summary、memory harness、context search、exact ref read 和 runtime event recording。
- Product tab 新增 Agent Bootstrap 面板，展示 providers、first tool、automatic memory harness、local-only boundary、provider rows、tool protocol 和 bounded snippet。
- smoke test 覆盖 `/api/agent/bootstrap` schema、Codex/Claude/generic provider、first tool、automatic harness、protocol steps、no manual user step flag 和 UI source wiring。
- MCP `project_memory_harness.useIndex` schema 补齐 `vector`，让 agent-side harness 与 UI 的 BM25/entity/vector/hybrid 检索能力一致。

产品价值：下一位 AI agent 不再需要用户解释“先读哪段记忆、怎么接 MCP、要不要手动贴 JSON”。它可以先读 bootstrap kit，再自动调用 takeover summary 和 memory harness，之后只按 exact refs 读取项目证据。

### 28. Phase 5 Symbol-Level Code Intelligence

根据 Phase 5 roadmap，把 code intelligence 从文件级 import graph 推进到本地符号级线索：

- `server/architecture.js` 新增 `project-agent.symbol-graph-lite.v1`，抽取 JS/TS exported symbols、local symbols、import bindings 和直接 call counts。
- `codeGraph.symbolGraph.symbolsByPath` 记录每个文件的导出函数/类/value、局部符号和高频调用。
- `codeGraph.symbolGraph.symbolDependentsByPath` 记录哪些 dependent 文件通过 named/default/namespace import 引用目标文件，并统计 direct call 次数。
- changed impact 现在包含 `symbols`、`symbolDependents`，并把 symbol caller files 合并进 `recommendedReads`，使 pre-edit/handoff harness 更早读到真正调用变更 API 的文件。
- `server/insights.js`、`server/runtime-state.js` 和 MCP `project_architecture_changes` 保留 symbol graph 的 counts、hotspots 和 changed impact 摘要，summary-first 接手包不会丢失这层线索。
- Project map -> Graph 新增 symbol metric、symbol caller chips 和 `data-code-graph-symbols` hotspot rows。
- smoke test 使用 `dependencyTarget()` exported function fixture，验证 exported function detection、symbol caller detection、symbol-aware `recommendedReads` 和 UI source wiring。

产品价值：AI 不再只知道“这个文件有 dependent”，还可以看到“哪个 dependent 正在调用哪个导出符号”。这让 edit 前的读文件选择更接近真实代码风险，同时仍然是本地、可解释、无远端服务的轻量实现。

## 四、当前验证状态

当前版本已验证：

- `node --check` 通过相关 server 文件。
- `npm run build` 通过，只有 Vite chunk size warning。
- `PORT=4159 npm test` 通过，输出 `smoke ok`。
- `npm test` 覆盖 `project_memory_audit` 工具发现、add audit row、forget dry-run/executed audit row、cold-start audit 状态和 `/api/memory/audit` action filter。
- `npm test` 覆盖 `project_memory_consolidate` 工具发现、cold-start not_started、dry-run proposals、executed decision/procedure promotion、searchability、audit row、idempotent duplicate skip 和 `/api/memory/consolidate` dry-run endpoint。
- `npm test` 覆盖 `project_memory_harness` 工具发现、cold-start not_started、自动 `project_memory_search`/`project_memory_read` 路由、`project_takeover_summary.memoryHarness`、`/api/memory/harness` 和 CLI bootstrap 的 automatic memory harness 输出。
- `npm test` 覆盖 `/api/agent/bootstrap` 的 `project-agent.agent-bootstrap.v1` schema、Codex/Claude/generic providers、`project_takeover_summary` first call、`project_memory_harness` automatic call、hybrid index preference、context/read/event protocol 和 Product tab source wiring。
- `npm test` 覆盖 `project_context_search` folder/fileType filters、`project_memory_search` type/folder/fileType/concept/sourceQuality/minConfidence filters、ranking breakdown、HTTP `/api/context-search` 和 `/api/memory/search` filter endpoints。
- `npm test` 覆盖 `project_memory_rebuild_index`、HTTP `/api/memory/index`、`POST /api/memory/index/rebuild`、BM25 indexed search opt-in、harness fresh-cache auto-use 和 `scoreBreakdown.bm25`。
- `npm test` 覆盖 `project_memory_rebuild_entity_index`、HTTP `/api/memory/entity-index`、`POST /api/memory/entity-index/rebuild`、entity/hybrid indexed search、harness fresh-cache hybrid auto-use 和 `scoreBreakdown.entity`。
- `npm test` 覆盖 HTTP `/api/memory/consolidate` dry-run proposal 和 confirmed manual execution path；UI execution controls 复用同一治理 API。
- `npm test` 覆盖 code graph changed-impact dependent refs、test ownership hints、recommendedReads、pre-edit dependency impact refs 和 test gap owned-test refs。
- `npm test` 覆盖 inspection coverage warning、MCP `project_handoff_audit.warnings=["inspection_coverage"]`、架构 watcher 事件不算 inspection evidence、以及完成态 evidence event 自动清除 missing refs。
- `npm test` 覆盖 symbol-level code intelligence：exported function symbol、symbol caller edge、direct call count、symbol-aware changedImpact/recommendedReads、summary preservation 和 UI source surface。
- `npm test` 覆盖 `/api/health` productization readiness fields、local-only security boundary、server port、project dir、terminal/memory/state health，以及 UI health/reconnect source surface。
- `npm test` 覆盖 `server/auth-boundary.js` local/no-auth default、remote bind without opt-in/token blocked posture、remote bearer-token ready posture、raw token JSON non-leak、remote `/api/health` 401 enforcement 和 authenticated remote health。
- `npm test` 覆盖 `/api/security/sandbox` schema、local-only posture、automatic memory harness policy、confirmation gates、blocked-by-default rules、env value hiding、permission scopes，以及 UI sandbox guidance source surface。
- `npm test` 覆盖 `/api/projects` launcher summary、current project discovery、registered project persistence、dry-run launch plan、dynamic port/env command，以及 UI launcher source surface。
- `npm test` 覆盖 `/api/state/export` portable bundle、`/api/state/import` dry-run and execute plan、state transfer write、manifest refresh，以及 UI state transfer source surface。
- Browser QA 确认 Project map -> Memory 的 AI memory harness 会显示自动 `project_memory_search` / `project_memory_read` / `project_memory_consolidate` 调用，并自动读到 canonical memory；memory filter UI 在桌面可点击搜索并显示 applied filters、score、sourceQuality、exact file refs；`?map=memory&memoryQuery=...` 深链接在 390px 移动宽度下直达过滤结果，控件、面板、结果行和页面横向 overflow 均为 0。
- Browser QA 确认 Project map -> Product -> Agent Bootstrap 在 1280px 和 390px 视口下显示 provider rows、`project_takeover_summary`、`project_memory_harness`、ordered protocol、no-manual-json posture；本轮 console error/warn 为 0，Agent Bootstrap section overflow 为 0，移动端 body overflow 为 0。
- Browser QA 确认 Project map -> Graph 在 1280px 和 390px 视口下显示 symbol rows、symbols/callers/calls 文案；本轮 console error/warn 为 0，Graph section overflow 为 0，移动端 body overflow 为 0。Browser screenshot capture 在 CDP `Page.captureScreenshot` 阶段超时，未作为通过证据使用。
- 固定 smoke + context + codex-smoke 样本显示 `.project-agent/continuity.json` 约 52KB，`storageSchemaVersion=project-agent.continuity-manifest.v1`，不再包含 `agentContextBundle` / `takeoverSummary`。
- `npm run grep-context -- --project-dir demo-project --query "grep-first takeover codex terminal" --limit 5` 通过。
- `npm run cli-agent -- --project-dir demo-project` 通过，生成 `.project-agent/cli-agent-bootstrap.md` 和 Codex 启动命令。
- 产品 terminal 后端显示 `connected / python-pty`。
- 产品 terminal 中 `python3 -c "import sys; print(sys.stdin.isatty())"` 输出 `True`。
- 产品 terminal 中 `codex --version` 输出 `codex-cli 0.136.0`。
- Browser QA 确认右侧不再显示 `Smoke` action button，terminal 仍显示 `python-pty`。
- smoke test 覆盖 bundle endpoint、CLI、prompt 文件、final insights、UI source checks、hook backpressure、prompt packing gate、state boundary audit、git freshness audit、temporal provenance audit、summary-first takeover、grep-first retrieval 和 terminal backend fallback。
- `.project-agent` 在 smoke 后没有残留。
- `4159` 测试端口没有遗留 listener。

## 五、当前 git 状态

已经在产品目录内初始化独立 git repo：

`/Users/michael/Documents/Codex/2026-06-01/rohitg00-agentmemory-https-github-com-rohitg00/outputs/project-agent-terminal`

已完成本地提交链以 `git log --oneline` 为准。当前主线包含：

```text
feat: add lean continuity manifest
feat: add summary-first takeover and cli terminal bridge
fix: restore sidecar code graph binding
feat: add temporal provenance audit
docs: update product development log
```

推送状态：

- 当前 `origin` 指向 `https://github.com/Mijiang111/CLI-Memo.git`。
- 本轮提交完成后可直接 `git push origin main`。
- 如果要换成 PR 工作流，可从 `main` 切出 `codex/<description>` 后再推送。

```bash
git push origin main
```

## 六、产品判断

现在的产品已经具备一个清晰的核心形态：

> Project Agent Terminal 是一个把 agent 工作状态产品化的本地 control plane。它不是只保存聊天摘要，而是把目标、过程、文件、依赖、证据、审计、handoff、prompt budget 和 hook ingress 都变成可见、可验证、可恢复的 durable state。

这件事的差异化在于：下一个 agent 拿到的不是“请继续做”的自然语言，而是一组带 source refs、hash、cursor、runbook、proof gate 的接管协议。

## 七、下一轮建议

本轮已产品化 **Local Health And Reconnect**、**State Import/Export**、**Multi-project Launcher**、**Sandbox And Permission Guidance** 和 **Optional Auth For Intentional Non-local Deployment**。下一项优先产品能力建议是 **Multi-project Launcher Stop/Restart And Persisted Logs**：

- 已经可以 plan/start 本地多项目实例，下一步要能从 Product tab stop/restart。
- 运行实例 logs 目前只在进程内存中，下一步应写入 `.project-agent` 下的 bounded process log，方便重启后仍能排查。
- 继续保持 harness 自动识别：launcher API 应返回 running/stopped/restartable 状态和最近 log refs，而不是要求用户去找终端窗口。

这个方向对应 Phase 6 的剩余可靠性 gap：本地 health、state transfer、launcher、permission posture、optional auth 都有机器可读 API；多项目实例的 lifecycle 和日志还需要变得同样可恢复。
