#!/usr/bin/env node
import path from "node:path";
import { ingestHookEvents } from "./runtime-state.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeMany(args, name) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    values.push(args[index + 1]);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values.filter(Boolean);
}

function readJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseFile(value, defaults) {
  if (!value) return null;
  if (value.trim().startsWith("{")) return readJson(value, null);
  const [filePath, status] = value.split("::");
  return {
    path: filePath,
    status: status || defaults.status,
    kind: defaults.kind,
    summary: defaults.summary,
    additions: defaults.additions,
    deletions: defaults.deletions,
    hash: defaults.hash
  };
}

function usage() {
  return `Usage:
  node server/event-cli.js --phase execute --title "Tool call" --detail "npm test" --ref npm-test
  node server/event-cli.js --phase execute --title "File modified" --file docs/product/roadmap.md::modified --summary +1/-0

Options:
  --project-dir <path>   Project root. Defaults to cwd.
  --phase <name>         observe | plan | execute | evidence | audit | handoff
  --status <name>        pending | current | done | failed | blocked
  --workstream <name>    discussion | strategy | architecture | implementation | qa_testing | governance
  --title <text>         Event title.
  --detail <text>        Event detail.
  --ref <value>          Repeatable reference.
  --file <path::status>  Repeatable changed file reference.
  --agent <id>           Agent/session id.
  --goal <id>            Goal id.
	  --tool <name>          Tool name.
	  --hook-type <name>     Closed hook type, e.g. tool_start, tool_done, file_change, or x.custom.
	  --source <name>        Event source, e.g. codex-hook.
  --summary <text>       File diff summary, e.g. +3/-1.
  --additions <n>        File additions for single-file events.
  --deletions <n>        File deletions for single-file events.
  --hash <value>         File hash.
  --data-json <json>     Extra structured data.
`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(take(args, "--project-dir") || process.cwd());
const fileDefaults = {
  status: take(args, "--file-status") || undefined,
  kind: take(args, "--file-kind") || undefined,
  summary: take(args, "--summary") || undefined,
  additions: Number(take(args, "--additions")),
  deletions: Number(take(args, "--deletions")),
  hash: take(args, "--hash") || undefined
};
if (!Number.isFinite(fileDefaults.additions)) fileDefaults.additions = undefined;
if (!Number.isFinite(fileDefaults.deletions)) fileDefaults.deletions = undefined;

const event = {
  phase: take(args, "--phase") || "observe",
  status: take(args, "--status") || "done",
  workstream: take(args, "--workstream") || undefined,
  title: take(args, "--title") || "Agent event",
  detail: take(args, "--detail") || "",
  refs: takeMany(args, "--ref"),
  files: takeMany(args, "--file").map((value) => parseFile(value, fileDefaults)).filter(Boolean),
  agentId: take(args, "--agent") || undefined,
  goalId: take(args, "--goal") || undefined,
	  tool: take(args, "--tool") || undefined,
	  type: take(args, "--hook-type") || undefined,
	  source: take(args, "--source") || "event-cli",
	  data: readJson(take(args, "--data-json"), undefined)
	};
	
	const result = ingestHookEvents(projectDir, { event }, { source: event.source, agentId: event.agentId, goalId: event.goalId });
	if (!result.accepted) {
	  console.error(JSON.stringify(result, null, 2));
	  process.exit(2);
	}
	console.log(JSON.stringify(result.events[0], null, 2));
