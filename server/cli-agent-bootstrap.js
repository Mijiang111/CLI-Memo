import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultContextQuery, searchContext } from "./grep-context.js";
import { buildMemoryHarness } from "./memory-store.js";
import { readTakeoverSummary } from "./runtime-state.js";

const BOOTSTRAP_FILE = ".project-agent/cli-agent-bootstrap.md";
const DEFAULT_MCP_SERVER_NAME = "cli-memo";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function compact(value, max = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function nowIso() {
  return new Date().toISOString();
}

function buildMcpCommand(projectDir, appRoot) {
  return {
    serverName: DEFAULT_MCP_SERVER_NAME,
    transport: "stdio",
    command: "npm",
    args: ["run", "mcp", "--", "--project-dir", projectDir],
    cwd: appRoot,
    commandLine: `npm run mcp -- --project-dir ${shellQuote(projectDir)}`
  };
}

function providerSnippet(serverName, command) {
  return JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command: command.command,
          args: command.args,
          cwd: command.cwd
        }
      }
    },
    null,
    2
  );
}

function buildProviderConfigs(command) {
  const snippet = providerSnippet(command.serverName, command);
  return [
    {
      id: "codex",
      label: "Codex",
      configType: "mcp_stdio",
      serverName: command.serverName,
      commandLine: command.commandLine,
      snippet,
      consumes: ["firstCall", "automaticHarness", "toolProtocol"]
    },
    {
      id: "claude",
      label: "Claude Code",
      configType: "mcpServers",
      serverName: command.serverName,
      commandLine: command.commandLine,
      snippet,
      consumes: ["firstCall", "automaticHarness", "toolProtocol"]
    },
    {
      id: "gemini",
      label: "Gemini",
      configType: "mcp_stdio",
      serverName: command.serverName,
      commandLine: command.commandLine,
      snippet,
      consumes: ["firstCall", "automaticHarness", "toolProtocol"]
    },
    {
      id: "kimi",
      label: "Kimi",
      configType: "mcp_stdio",
      serverName: command.serverName,
      commandLine: command.commandLine,
      snippet,
      consumes: ["firstCall", "automaticHarness", "toolProtocol"]
    },
    {
      id: "generic",
      label: "Generic MCP client",
      configType: "stdio_command",
      serverName: command.serverName,
      command,
      commandLine: command.commandLine,
      snippet,
      consumes: ["firstCall", "automaticHarness", "toolProtocol"]
    }
  ];
}

export function buildAgentBootstrapKit(projectDir, options = {}) {
  const appRoot = options.appRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const bindHost = options.bindHost || "127.0.0.1";
  const apiPort = Number(options.apiPort || 4147);
  const uiPort = Number(options.uiPort || 5174);
  const generatedAt = nowIso();
  const command = buildMcpCommand(projectDir, appRoot);
  const firstCall = {
    tool: "project_takeover_summary",
    mode: "automatic",
    arguments: {
      projectDir,
      refresh: true
    },
    reason: "Small summary-first takeover packet with lifecycle, verification, and memory harness hints.",
    expectedKeys: ["takeoverSummary", "memoryHarness", "verification"]
  };
  const automaticHarness = {
    tool: "project_memory_harness",
    mode: "automatic",
    arguments: {
      projectDir,
      limit: 6,
      maxReads: 3,
      candidateLimit: 5,
      useIndex: "hybrid",
      consolidate: true,
      consolidationMode: "session"
    },
    reason: "Derive memory search/read calls from active goal, cursor, runtime events, risks, and changed files.",
    appliedTools: ["project_memory_search", "project_memory_read", "project_memory_consolidate"],
    destructive: false
  };
  const toolProtocol = [
    {
      step: 1,
      tool: firstCall.tool,
      mode: "automatic",
      arguments: firstCall.arguments,
      reason: firstCall.reason
    },
    {
      step: 2,
      tool: automaticHarness.tool,
      mode: "automatic",
      arguments: automaticHarness.arguments,
      reason: automaticHarness.reason
    },
    {
      step: 3,
      tool: "project_context_search",
      mode: "on_demand",
      arguments: {
        projectDir,
        query: "active goal or current task",
        limit: 8
      },
      reason: "Find exact refs before broad file reads."
    },
    {
      step: 4,
      tool: "project_read_ref",
      mode: "on_demand",
      arguments: {
        projectDir,
        ref: "<ref returned by project_context_search>",
        maxBytes: 12000
      },
      reason: "Read only refs selected by retrieval evidence."
    },
    {
      step: 5,
      tool: "project_record_event",
      mode: "automatic_for_work",
      arguments: {
        projectDir,
        phase: "execute",
        status: "current",
        title: "Current agent work"
      },
      reason: "Keep the next agent and memory harness aligned with current work."
    }
  ];
  return {
    schemaVersion: "project-agent.agent-bootstrap.v1",
    generatedAt,
    status: "ready",
    projectDir,
    appRoot,
    localOnly: true,
    automation: {
      harnessConsumable: true,
      manualUserStepsRequired: false,
      manualJsonEditingRequired: false,
      defaultFirstTool: firstCall.tool,
      automaticMemoryTool: automaticHarness.tool
    },
    endpoints: {
      apiBaseUrl: `http://${bindHost}:${apiPort}/api`,
      uiUrl: `http://${bindHost}:${uiPort}/`,
      bootstrap: `http://${bindHost}:${apiPort}/api/agent/bootstrap`
    },
    mcp: command,
    providers: buildProviderConfigs(command),
    firstCall,
    automaticHarness,
    toolProtocol,
    security: {
      localOnly: true,
      bindHost,
      apiPort,
      uiPort,
      projectScope: projectDir,
      envValuesExposed: false,
      remoteAccess: "disabled_by_default",
      blockedByDefault: ["remote_bind_without_explicit_auth", "destructive_memory_actions_without_dry_run", "secret_value_export"]
    },
    docs: [
      { ref: "README.md", reason: "operator commands and API surface" },
      { ref: "docs/product/roadmap.md", reason: "product phase acceptance criteria" },
      { ref: ".project-agent/takeover-summary.json", reason: "summary-first takeover state" }
    ]
  };
}

export function resolveCodexCli() {
  const result = spawnSync("which", ["codex"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function buildCliAgentBootstrap(projectDir, options = {}) {
  const appRoot = options.appRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const summary = readTakeoverSummary(projectDir) || {};
  const query = compact(options.query || defaultContextQuery(projectDir), 320);
  const grepCli = path.join(appRoot, "server", "grep-context-cli.js");
  const contextSearch = searchContext(projectDir, { query, limit: 5, maxFiles: 500 });
  const memoryHarness = buildMemoryHarness(projectDir, { query, limit: 6, maxReads: 3, candidateLimit: 5 });
  const role = options.role || "coding_agent";
  const activeGoal = summary.activeGoal?.objective || "Continue the current project goal.";
  const current = summary.currentState?.title || summary.currentState?.detail || "Read takeover summary.";
  const next = summary.nextStep?.command || "Use grep-context to find the next relevant ref.";

  const markdown = [
    "# Project Agent CLI Bootstrap",
    "",
    `Generated: ${nowIso()}`,
    `Role: ${role}`,
    `Project: ${path.basename(projectDir)}`,
    "",
    "## Start Protocol",
    "",
    "1. Read `.project-agent/takeover-summary.json` first.",
    "2. Use grep-first retrieval before reading large state files.",
    "3. Return snippets and refs first; read full files only on demand.",
    "4. Do not run `codex-smoke` unless the human explicitly asks.",
    "5. Treat `.project-agent/agent-context-bundle.json` and `.project-agent/continuity.json` as archives, not default context.",
    "",
    "## Current State",
    "",
    `Goal: ${activeGoal}`,
    `Current: ${current}`,
    `Next command: ${next}`,
    "",
    "## Grep-First Commands",
    "",
    "Use these from any shell rooted in the project:",
    "",
    "```bash",
    `node ${shellQuote(grepCli)} --project-dir ${shellQuote(projectDir)} --query ${shellQuote(query)} --limit 8`,
    `node ${shellQuote(grepCli)} --project-dir ${shellQuote(projectDir)} --read '<ref from grep result>' --max-bytes 6000`,
    "```",
    "",
    "## Initial Grep Hits",
    "",
    contextSearch.results.length
      ? contextSearch.results.map((item) => `- ${item.ref} (${item.reason})`).join("\n")
      : "- No grep hits yet; inspect `.project-agent/takeover-summary.json`.",
    "",
    "## Automatic Memory Harness",
    "",
    `- status: ${memoryHarness.status}`,
    `- query: ${memoryHarness.query || query}`,
    `- applied calls: ${memoryHarness.appliedCalls.map((call) => call.tool).join(" -> ") || "none"}`,
    memoryHarness.autoReads.length
      ? memoryHarness.autoReads.map((item) => `- auto-read ${item.type}: ${item.title} (${item.ref})`).join("\n")
      : "- auto-read: none yet",
    memoryHarness.consolidation?.totals
      ? `- consolidation candidates: ${memoryHarness.consolidation.totals.ready || 0} ready, ${memoryHarness.consolidation.totals.lowConfidence || 0} low-confidence, ${memoryHarness.consolidation.totals.duplicates || 0} duplicate`
      : "- consolidation candidates: not checked",
    "",
    "## Operating Rule",
    "",
    "Before editing, use the automatic memory harness results first, then explain which refs you inspected and why those refs were enough."
  ].join("\n");

  return {
    schemaVersion: "project-agent.cli-agent-bootstrap.v1",
    generatedAt: nowIso(),
    role,
    projectDir,
    promptFile: BOOTSTRAP_FILE,
    query,
    markdown,
    contextSearch,
    memoryHarness
  };
}

export function writeCliAgentBootstrap(projectDir, options = {}) {
  const bootstrap = buildCliAgentBootstrap(projectDir, options);
  const absFile = path.join(projectDir, BOOTSTRAP_FILE);
  mkdirSync(path.dirname(absFile), { recursive: true });
  writeFileSync(absFile, `${bootstrap.markdown}\n`, "utf8");
  return { ...bootstrap, promptFile: BOOTSTRAP_FILE, promptPath: absFile };
}

export function buildCliAgentCommand(projectDir, options = {}) {
  const promptPath = path.join(projectDir, BOOTSTRAP_FILE);
  const model = options.model ? ` --model ${shellQuote(options.model)}` : "";
  return `codex --no-alt-screen -C ${shellQuote(projectDir)}${model} "$(cat ${shellQuote(promptPath)})"`;
}
