import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { defaultContextQuery, searchContext } from "./grep-context.js";
import { readTakeoverSummary } from "./runtime-state.js";

const BOOTSTRAP_FILE = ".project-agent/cli-agent-bootstrap.md";

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
    "## Operating Rule",
    "",
    "Before editing, explain which refs you inspected and why those refs were enough."
  ].join("\n");

  return {
    schemaVersion: "project-agent.cli-agent-bootstrap.v1",
    generatedAt: nowIso(),
    role,
    projectDir,
    promptFile: BOOTSTRAP_FILE,
    query,
    markdown,
    contextSearch
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
