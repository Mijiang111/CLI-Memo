# Project Agent Terminal 产品开发日志

日期：2026-06-05  
最新本地提交：`feat: add summary-first takeover and cli terminal bridge`（以 `git log` 为准）  
当前状态：Summary-first takeover、grep-first retrieval、CLI Agent terminal bridge 已实现并验证；远端 `origin` 尚未配置，暂不能 push 到 GitHub。

更新：接手协议已从“把大包塞给模型”改为 summary-first。`.project-agent/takeover-summary.json` 成为默认入口，`agent-context-bundle.json` 改为预算化索引；memory/process/architecture/handoff 超预算时只披露摘要、hash 和 source refs，由接手 agent 按需读取。

更新：新增 grep-first retrieval 层。`npm run grep-context`、`/api/context-search` 和 `/api/context-read` 提供本地、零模型、refs-first 的检索路径，让 agent 像用 RAG 一样先检索命中片段，再按 ref 读取原文。

更新：CLI Agent 入口回到 terminal 本身。产品不再在右侧提供 Codex smoke 按钮；右侧保持 Goal / State / Next / Risk / Resume、Audit、Handoff。真实 Codex 或其他 CLI Agent 应直接在 terminal 中运行，terminal 后端负责提供真实 TTY。

更新：terminal 后端新增 Python PTY bridge fallback。当前机器上 `node-pty` 会报 `posix_spawnp failed`，旧 fallback 是普通 pipe，导致 `codex` 报 `stdin is not a terminal`。现在 fallback 会启动 Python PTY bridge，让 `sys.stdin.isatty()` 返回 `True`，`codex --version` 可在产品 terminal 中正常输出。

更新：State Boundary Audit 已落地到 continuity、continuity contract、agent context bundle validation、provenance ledger、attention pack、starter prompts、Handoff UI 和 smoke tests。它把 raw events、durable sources、derived indexes、disclosure outputs 明确分层，避免把 prompt/resume/graph index 误当成唯一真相。

更新：Git Freshness Audit 已接入 freshness gate。系统会读取 git HEAD、branch、dirty tree、untracked files 和 state-file changes，并把结果写入 continuity、bundle、starter prompts、Handoff UI 和 smoke tests。dirty tree 不会直接阻断接管，但会作为 freshness warning，提醒下一位 agent 在声称可复现 handoff 前先 review、commit 或 stash。

更新：本轮产品工作已经从“能恢复上下文”推进到“能解释这个上下文是否可信”。State Boundary 负责区分真相源和披露层；Git Freshness 负责把 handoff snapshot 和当前 repo 快照对齐。这两个能力让 Project Agent Terminal 更接近一个 agent control plane，而不是单纯的 resume 文件生成器。

更新：Temporal Provenance Audit 已从 Graphiti benchmark 转化成产品能力。系统会把 memory graph、decision ledger、process trace、freshness gate 中的重要 fact 统一成 temporal facts，记录 source refs、source hash、observedAt、validFrom、validUntil、stale sources、watch/invalid 状态和 contradictions，并写入 continuity、continuity contract、agent context bundle validation、provenance ledger、attention pack、starter prompts、Handoff UI 和 smoke tests。

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

## 四、当前验证状态

当前版本已验证：

- `node --check` 通过相关 server 文件。
- `npm run build` 通过，只有 Vite chunk size warning。
- `PORT=4159 npm test` 通过，输出 `smoke ok`。
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

已完成本地提交链：

```text
current HEAD feat: add summary-first takeover and cli terminal bridge
f57f460 fix: restore sidecar code graph binding
913e785 feat: add temporal provenance audit
caf860a docs: update product development log
8432ebc feat: add git freshness audit
2612546 feat: add state boundary audit
8dc80a6 docs: add product development log
69044ef chore: snapshot project agent terminal
```

推送状态：

- 当前 `git remote -v` 为空。
- 失败原因：当前 repo 没有配置 `origin` remote，不能把本地提交 push 到 GitHub。
- 需要补充远端，例如：

```bash
git remote add origin <github-repo-url>
git push -u origin main
```

## 六、产品判断

现在的产品已经具备一个清晰的核心形态：

> Project Agent Terminal 是一个把 agent 工作状态产品化的本地 control plane。它不是只保存聊天摘要，而是把目标、过程、文件、依赖、证据、审计、handoff、prompt budget 和 hook ingress 都变成可见、可验证、可恢复的 durable state。

这件事的差异化在于：下一个 agent 拿到的不是“请继续做”的自然语言，而是一组带 source refs、hash、cursor、runbook、proof gate 的接管协议。

## 七、下一轮建议

本轮已产品化 **Temporal Provenance Audit**。下一项优先产品能力建议是 **Code Graph Adapter / Import Path Intelligence**：

- 从 RepoWise 和 CodeBoarding 学习真实 import/call graph adapter。
- 将当前 code graph 从文件级依赖推进到 symbol/import path 级依赖。
- 在 pre-edit risk 中加入 owners、tests、co-change partners 和 governing decisions 的组合判断。
- 让 Handoff UI 能明确回答“改这个文件会影响哪些调用者、哪些测试、哪些产品决策”。

这个方向对应 RepoWise 和 CodeBoarding 的 benchmark gap：Project Agent Terminal 现在已经能解释 memory/process/governance 的可信度，下一步要更深入解释代码依赖和编辑风险。
