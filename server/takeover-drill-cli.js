#!/usr/bin/env node
import path from "node:path";
import { attachTakeoverDrill, renderTakeoverDrillMarkdown } from "./takeover-drill.js";
import { readContinuity } from "./runtime-state.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function usage() {
  return `Usage:
  node server/takeover-drill-cli.js --project-dir /path/to/project --json

Options:
  --project-dir <path>  Project root. Defaults to cwd.
  --expect <path>       Treat a file as being written by the current handoff operation. Repeatable.
  --json                Output JSON instead of markdown.
`;
}

function takeRepeated(args, name) {
  const values = [];
  let value;
  while ((value = take(args, name))) values.push(value);
  return values;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(take(args, "--project-dir") || process.cwd());
const expectedFiles = takeRepeated(args, "--expect");
const json = args.includes("--json");
const continuity = readContinuity(projectDir);
const packet = attachTakeoverDrill(projectDir, continuity || {}, { expectedFiles });
const drill = packet.takeoverDrill;

if (json) console.log(JSON.stringify(drill, null, 2));
else {
  console.log("# Takeover Drill");
  console.log("");
  console.log(renderTakeoverDrillMarkdown(drill));
}

if (!drill.canResume) process.exit(2);
