# Project Agent Terminal 产品开发日志

日期：2026-06-05  
本地提交：`69044ef chore: snapshot project agent terminal`  
当前状态：已完成本地 git snapshot；远端 `origin` 尚未配置，暂不能 push 到 GitHub。

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

## 四、当前验证状态

上一轮完成后已验证：

- `node --check` 通过相关 server 文件。
- `npm run build` 通过，只有 Vite chunk size warning。
- `PORT=4176 npm test` 通过，输出 `smoke ok`。
- smoke test 覆盖 bundle endpoint、CLI、prompt 文件、final insights、UI source checks、hook backpressure、prompt packing gate。
- `.project-agent` 在 smoke 后没有残留。
- `4176` 端口没有遗留 listener。

## 五、当前 git 状态

已经在产品目录内初始化独立 git repo：

`/Users/michael/Documents/Codex/2026-06-01/rohitg00-agentmemory-https-github-com-rohitg00/outputs/project-agent-terminal`

已完成第一笔本地提交：

```text
69044ef chore: snapshot project agent terminal
```

推送状态：

- `git push -u origin main` 已尝试。
- 失败原因：当前 repo 没有配置 `origin` remote。
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

下一轮最值得继续产品化的是 **State Boundary Audit**：

- 明确 raw events、durable sources、derived indexes、disclosure outputs 四层。
- 在 continuity contract 里标出哪些文件是 source-of-truth，哪些只是 derived index。
- 在 bundle validation 中增加 `stateBoundary` 检查。
- 在 prompt 和 UI 里提示 agent：不要把 prompt、resume 或 derived graph 当成唯一真相，必须回到 raw/durable source refs。

这个方向直接对应 Akita 和 RepoWise 的 benchmark gap：source files 和 query/index 层需要分离。它会让 Project Agent Terminal 的状态治理更像一个可审计系统，而不是一组漂亮的 JSON 文件。
