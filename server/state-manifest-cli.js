#!/usr/bin/env node
import { buildStateManifest, readStateManifest, verifyStateManifest, writeStateManifest } from "./runtime-state.js";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

const args = process.argv.slice(2);
const projectDir = argValue(args, "--project-dir", process.cwd());
const shouldWrite = hasFlag(args, "--write");
const shouldVerify = hasFlag(args, "--verify") || !shouldWrite;

if (shouldWrite) {
  const manifest = writeStateManifest(projectDir, buildStateManifest(projectDir));
  console.log(JSON.stringify({ stateManifest: manifest }, null, 2));
} else if (shouldVerify) {
  const manifest = readStateManifest(projectDir);
  const verification = verifyStateManifest(projectDir, manifest);
  console.log(JSON.stringify({ stateManifest: manifest, verification }, null, 2));
  process.exitCode = verification.ok ? 0 : 2;
}
