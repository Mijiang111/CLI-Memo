#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliAgentCommand, resolveCodexCli, writeCliAgentBootstrap } from "./cli-agent-bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function valueAfter(flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function has(flag) {
  return args.includes(flag);
}

function usage() {
  return `Usage:
  node server/cli-agent-cli.js --project-dir /path/to/project
  node server/cli-agent-cli.js --project-dir /path/to/project --launch

Options:
  --project-dir PATH   Project root containing .project-agent. Defaults to cwd.
  --query TEXT         Override the grep-first bootstrap query.
  --role ROLE          Agent role. Defaults to coding_agent.
  --model MODEL        Optional Codex model.
  --launch            Start Codex CLI with the generated bootstrap prompt.
  --print-prompt      Print the bootstrap prompt instead of the shell command.
`;
}

if (has("--help") || has("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const model = valueAfter("--model");
const bootstrap = writeCliAgentBootstrap(projectDir, {
  appRoot,
  role: valueAfter("--role", "coding_agent"),
  query: valueAfter("--query")
});
const command = buildCliAgentCommand(projectDir, { model });

if (has("--print-prompt")) {
  console.log(bootstrap.markdown);
  process.exit(0);
}

if (!has("--launch")) {
  console.log(command);
  console.log(`Bootstrap prompt: ${bootstrap.promptPath}`);
  process.exit(resolveCodexCli() ? 0 : 1);
}

if (!resolveCodexCli()) {
  console.error("codex CLI was not found on PATH.");
  process.exit(1);
}

const codexArgs = ["--no-alt-screen", "-C", projectDir];
if (model) codexArgs.push("--model", model);
codexArgs.push(bootstrap.markdown);
const child = spawn("codex", codexArgs, {
  cwd: projectDir,
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
