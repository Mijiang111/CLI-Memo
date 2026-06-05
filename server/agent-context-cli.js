#!/usr/bin/env node
import path from "node:path";
import {
  buildAgentContextBundle,
  readAgentContextBundle,
  readContinuity,
  readStateManifest,
  verifyAgentContextBundle,
  verifyStateManifest,
  writeAgentContextBundle
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
  node server/agent-context-cli.js --project-dir /path/to/project [--write] [--verify]

Options:
  --project-dir PATH   Project root containing .project-agent
  --write              Refresh .project-agent/agent-context-bundle.json
  --verify             Verify bundle-only takeover readiness
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
console.log(JSON.stringify({ agentContextBundle: bundle, verification }, null, 2));
if (has("--verify") && !verification.canResume) process.exit(2);
