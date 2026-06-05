#!/usr/bin/env node
import path from "node:path";
import { runAgentContextDrill, writeAgentContextDrill } from "./agent-context-drill.js";

const args = process.argv.slice(2);

function valueAfter(flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function has(flag) {
  return args.includes(flag);
}

if (has("--help") || has("-h")) {
  console.log(`Usage:
  node server/agent-context-drill-cli.js --project-dir /path/to/project [--write]

Options:
  --project-dir PATH   Project root containing .project-agent
  --write              Write .project-agent/context-takeover-drill.json
`);
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const result = has("--write") ? writeAgentContextDrill(projectDir) : { drill: runAgentContextDrill(projectDir), file: null };
console.log(JSON.stringify(result.drill, null, 2));
if (!result.drill.canResume) process.exit(2);
