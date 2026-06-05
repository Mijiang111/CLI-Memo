#!/usr/bin/env node
import path from "node:path";
import {
  buildAgentContextBundle,
  buildTakeoverSummary,
  readAgentContextBundle,
  readContinuity,
  readStateManifest,
  readTakeoverSummary,
  verifyAgentContextBundle,
  verifyStateManifest,
  writeAgentContextBundle,
  writeTakeoverSummary
} from "./runtime-state.js";

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
  node server/agent-context-cli.js --project-dir /path/to/project [--write] [--verify] [--full]

Options:
  --project-dir PATH   Project root containing .project-agent
  --write              Refresh .project-agent/agent-context-bundle.json
  --verify             Verify takeover readiness
  --full               Print the full agent-context-bundle instead of the small takeover summary
`);
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const continuity = readContinuity(projectDir) || {};
const stateManifest = readStateManifest(projectDir) || continuity.stateManifest || null;
const stateManifestVerification = verifyStateManifest(projectDir, stateManifest);
const bundle = has("--write")
  ? writeAgentContextBundle(projectDir, buildAgentContextBundle(projectDir, continuity, { stateManifest, stateManifestVerification }))
  : readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity, { stateManifest, stateManifestVerification });

const verification = verifyAgentContextBundle(projectDir, bundle);
const takeoverSummary = has("--write")
  ? writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, continuity, { bundle, verification }))
  : readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, continuity, { bundle, verification });
console.log(JSON.stringify(has("--full") ? { agentContextBundle: bundle, takeoverSummary, verification } : { takeoverSummary, verification }, null, 2));
if (has("--verify") && !verification.canResume) process.exit(2);
