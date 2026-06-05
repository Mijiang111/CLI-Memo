#!/usr/bin/env node
import path from "node:path";
import { buildAgentContextPrompt } from "./agent-context-prompt.js";

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
  node server/agent-context-prompt-cli.js --project-dir /path/to/project [--write] [--json]

Options:
  --project-dir PATH   Project root containing .project-agent
  --write              Write .project-agent/context-starter-prompt.md
  --json               Print JSON instead of markdown
`);
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const result = buildAgentContextPrompt(projectDir, { writeFile: has("--write") });
if (has("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.markdown);
}
if (!result.verification?.canResume) process.exit(2);
