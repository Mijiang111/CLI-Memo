#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { buildArchitecture } from "./architecture.js";
import { buildResumePacket } from "./resume.js";
import { readRuntime, recordAgentHeartbeat, recordEvent, writeRuntime } from "./runtime-state.js";

function take(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function usage() {
  return `Usage:
  node server/agent-run-cli.js --project-dir /path/to/project --agent codex -- npm test
  npm run agent-run -- --title "Patch UI" --workstream implementation -- npm run build

Options:
  --project-dir <path>   Project memory root. Defaults to cwd.
  --cwd <path>           Command working directory. Defaults to project dir.
  --agent <id>           Agent/session id. Defaults to local-agent.
  --role <name>          Agent role. Defaults to coding_agent.
  --goal <id>            Goal id to attach to events and heartbeat.
  --phase <name>         Runtime phase. Defaults to execute.
  --workstream <name>    Optional workstream classification.
  --title <text>         Event title. Defaults to command.
  --source <name>        Event source. Defaults to agent-run.
  --tool <name>          Tool label. Defaults to command executable.
  --shell                Run command through the system shell.
  --no-snapshot          Do not refresh resume/recovery after command.
  -- <command...>        Command to execute.
`;
}

function compact(value, max = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function commandText(parts) {
  return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function filesFromChanges(changes = []) {
  return changes.slice(0, 12).map((change) => ({
    path: change.path,
    status: change.status,
    kind: change.kind,
    summary: change.summary,
    additions: change.additions || 0,
    deletions: change.deletions || 0,
    hash: change.hash
  }));
}

async function refreshSnapshot(projectDir, { role, reason, terminalSnapshot }) {
  const doneStatus = {
    status: "done",
    reason,
    updatedAt: new Date().toISOString()
  };
  const result = await buildResumePacket(projectDir, {
    role,
    writeFile: true,
    writeRecovery: true,
    persistArchitecture: false,
    handoffSnapshot: doneStatus,
    terminalSnapshot
  });
  const runtime = readRuntime(projectDir);
  runtime.handoffSnapshot = {
    ...doneStatus,
    resumeFile: result.file,
    recoveryFile: result.recoveryFile,
    continuityGeneratedAt: result.continuity?.generatedAt
  };
  writeRuntime(projectDir, runtime);
  return runtime.handoffSnapshot;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  const divider = args.indexOf("--");
  if (divider === -1 || divider === args.length - 1) {
    console.error(usage());
    return 2;
  }
  const optionArgs = args.slice(0, divider);
  const command = args.slice(divider + 1);

  const projectDir = path.resolve(take(optionArgs, "--project-dir") || process.cwd());
  const cwd = path.resolve(take(optionArgs, "--cwd") || projectDir);
  const agentId = take(optionArgs, "--agent") || "local-agent";
  const role = take(optionArgs, "--role") || "coding_agent";
  const goalId = take(optionArgs, "--goal") || undefined;
  const phase = take(optionArgs, "--phase") || "execute";
  const workstream = take(optionArgs, "--workstream") || undefined;
  const source = take(optionArgs, "--source") || "agent-run";
  const title = take(optionArgs, "--title") || commandText(command);
  const tool = take(optionArgs, "--tool") || command[0];
  const useShell = flag(optionArgs, "--shell");
  const noSnapshot = flag(optionArgs, "--no-snapshot");
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const startEventId = `${runId}_start`;

  if (optionArgs.length) {
    console.error(`Unknown option(s): ${optionArgs.join(" ")}`);
    console.error(usage());
    return 2;
  }

  buildArchitecture(projectDir);
  recordAgentHeartbeat(projectDir, {
    agentId,
    role,
    goalId,
    status: "active",
    note: `running ${title}`,
    source,
    leaseSeconds: 120
  });
  recordEvent(projectDir, {
    id: startEventId,
    phase,
    status: "current",
    workstream,
    title,
    detail: commandText(command),
    agentId,
    goalId,
    tool,
    source,
    runId,
    startedAt,
    refs: [cwd]
  });

  let outputTail = "";
  const appendOutput = (chunk) => {
    outputTail = compact(`${outputTail}${chunk}`, 2000);
  };

  const child = spawn(useShell ? commandText(command) : command[0], useShell ? [] : command.slice(1), {
    cwd,
    shell: useShell,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env
  });

  const stopChild = (signal) => {
    const endedAt = new Date().toISOString();
    recordEvent(projectDir, {
      phase,
      status: "failed",
      workstream,
      title: `${title} interrupted`,
      detail: signal,
      agentId,
      goalId,
      tool,
      source,
      parentId: startEventId,
      runId,
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      error: signal,
      refs: [cwd]
    });
    child.kill(signal);
  };

  process.once("SIGINT", () => stopChild("SIGINT"));
  process.once("SIGTERM", () => stopChild("SIGTERM"));

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    appendOutput(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendOutput(chunk);
  });

  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    child.on("error", (error) => resolve({ code: 1, error }));
  });

  const architecture = buildArchitecture(projectDir);
  const files = filesFromChanges(architecture.changes || []);
  const ok = exit.code === 0 && !exit.signal && !exit.error;
  const endedAt = new Date().toISOString();
  recordEvent(projectDir, {
    phase,
    status: ok ? "done" : "failed",
    workstream,
    title: ok ? `${title} finished` : `${title} failed`,
    detail: compact(exit.error?.message || outputTail || commandText(command), 1000),
    refs: [cwd, ...files.map((file) => file.path)].filter(Boolean),
    files,
    agentId,
    goalId,
    tool,
    source,
    parentId: startEventId,
    runId,
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    error: ok ? undefined : exit.error?.message || outputTail || `exit ${exit.code}`,
    data: {
      command,
      cwd,
      exitCode: exit.code,
      signal: exit.signal || null,
      changedFiles: files.length
    }
  });
  recordAgentHeartbeat(projectDir, {
    agentId,
    role,
    goalId,
    status: ok ? "idle" : "failed",
    note: ok ? `finished ${title}` : `failed ${title}`,
    source,
    leaseSeconds: 120
  });

  let snapshot = null;
  if (!noSnapshot) {
    snapshot = await refreshSnapshot(projectDir, {
      role,
      reason: ok ? "agent-run" : "agent-run-failed",
      terminalSnapshot: {
        backend: "agent-run",
        lastCommand: {
          command: commandText(command),
          exitCode: exit.code,
          output: outputTail
        }
      }
    });
  }

  console.error(
    JSON.stringify(
      {
        status: ok ? "done" : "failed",
        exitCode: exit.code,
        changedFiles: files.map((file) => file.path),
        snapshot: snapshot?.status || null
      },
      null,
      2
    )
  );
  return exit.code;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
