#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { recordAgentHeartbeat, readRuntime, summarizeAgentLeases } from "./runtime-state.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function usage() {
  return `Usage:
  node server/agent-cli.js heartbeat --project-dir /path/to/project --agent-id codex --role coding_agent
  node server/agent-cli.js list --project-dir /path/to/project

Options:
  --project-dir <path>     Project root. Defaults to cwd.
  --agent-id <id>          Stable agent/session id. Defaults to local-agent.
  --role <name>            Agent role.
  --goal <id>              Goal id the agent is working on.
  --status <status>        active, idle, done, failed, or handoff.
  --note <text>            Short current work note.
  --lease-seconds <n>      Seconds before active agent is treated as stale. Defaults to 90.
  --json                   Output JSON.
`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const command = args.shift() || "list";
const projectDir = path.resolve(take(args, "--project-dir") || process.cwd());
const json = args.includes("--json");

if (command === "heartbeat") {
  const runtime = recordAgentHeartbeat(projectDir, {
    agentId: take(args, "--agent-id") || "local-agent",
    role: take(args, "--role") || undefined,
    goalId: take(args, "--goal") || undefined,
    status: take(args, "--status") || "active",
    note: take(args, "--note") || undefined,
    leaseSeconds: take(args, "--lease-seconds") || undefined,
    source: "agent-cli",
    pid: String(process.pid),
    host: os.hostname()
  });
  const agents = summarizeAgentLeases(runtime);
  if (json) console.log(JSON.stringify({ agents }, null, 2));
  else {
    for (const agent of agents) {
      console.log(`${agent.id}\t${agent.effectiveStatus}\t${agent.role || "-"}\t${agent.goalId || "-"}\t${agent.note || ""}`);
    }
  }
  process.exit(0);
}

if (command === "list") {
  const agents = summarizeAgentLeases(readRuntime(projectDir));
  if (json) console.log(JSON.stringify({ agents }, null, 2));
  else {
    for (const agent of agents) {
      console.log(`${agent.id}\t${agent.effectiveStatus}\t${agent.role || "-"}\t${agent.goalId || "-"}\t${agent.note || ""}`);
    }
  }
  process.exit(0);
}

console.error(usage());
process.exit(1);
