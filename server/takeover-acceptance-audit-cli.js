#!/usr/bin/env node
import path from "node:path";
import { buildTakeoverAcceptanceAudit, readTakeoverAcceptanceAudit, refreshTakeoverAcceptanceAudit } from "./takeover-acceptance-audit.js";
import { readContinuity } from "./runtime-state.js";

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
  node server/takeover-acceptance-audit-cli.js --project-dir /path/to/project [--write] [--verify]

Options:
  --project-dir PATH   Project root containing .project-agent
  --write              Write .project-agent/takeover-acceptance-audit.json and refresh continuity
  --verify             Exit nonzero if user-objective acceptance is blocked
`);
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const continuity = readContinuity(projectDir) || {};
let audit = readTakeoverAcceptanceAudit(projectDir) || buildTakeoverAcceptanceAudit(projectDir, continuity);

if (has("--write")) {
  audit = refreshTakeoverAcceptanceAudit(projectDir, continuity).audit;
}

console.log(JSON.stringify(audit, null, 2));
if (has("--verify") && !audit.canResume) process.exit(2);
