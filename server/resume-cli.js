#!/usr/bin/env node
import path from "node:path";
import { buildResumePacket } from "./resume.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function usage() {
  return `Usage:
  node server/resume-cli.js --project-dir /path/to/project --role coding_agent --write

Options:
  --project-dir <path>  Project root. Defaults to cwd.
  --role <name>         Role for the context packet. Defaults to coding_agent.
  --goal <id>           Goal id. Defaults to active goal.
  --write               Write .project-agent/resume.md.
  --no-recovery-write   Do not refresh .project-agent/recovery.md.
  --json                Output JSON instead of markdown.
`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(take(args, "--project-dir") || process.cwd());
const json = args.includes("--json");
const write = args.includes("--write");
const result = await buildResumePacket(projectDir, {
  role: take(args, "--role") || "coding_agent",
  goal: take(args, "--goal") || undefined,
  writeFile: write,
  writeRecovery: !args.includes("--no-recovery-write")
});

if (json) console.log(JSON.stringify(result, null, 2));
else console.log(result.markdown);
