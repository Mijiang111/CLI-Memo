#!/usr/bin/env node
import path from "node:path";
import { importSessionLog } from "./session-log-adapter.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function usage() {
  return `Usage:
  node server/session-log-cli.js --file /path/to/session.jsonl --project-dir /path/to/project

Options:
  --project-dir <path>  Project root. Defaults to cwd.
  --file <path>         JSONL session log. Relative paths resolve from project root.
  --format <name>       auto | generic | codex | claude
  --agent <id>          Agent/session id to attach to imported events.
  --goal <id>           Goal id to attach to imported events.
  --source <name>       Event source label.
  --limit <n>           Max events to import. Defaults to 200.
`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(take(args, "--project-dir") || process.cwd());
const file = take(args, "--file");
if (!file) {
  console.error(usage());
  process.exit(2);
}

const result = importSessionLog(projectDir, {
  file,
  format: take(args, "--format") || "auto",
  agentId: take(args, "--agent") || undefined,
  goalId: take(args, "--goal") || undefined,
  source: take(args, "--source") || "session-log-cli",
  limit: Number(take(args, "--limit")) || 200
});

console.log(JSON.stringify(result, null, 2));
