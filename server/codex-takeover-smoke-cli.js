#!/usr/bin/env node
import path from "node:path";
import { runCodexTakeoverSmoke } from "./codex-takeover-smoke.js";
import { buildNextAgentPrompt } from "./next-agent-prompt.js";

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
  node server/codex-takeover-smoke-cli.js --project-dir /path/to/project [--no-codex] [--timeout-ms 120000]

Options:
  --project-dir PATH   Project root containing .project-agent
  --role NAME          Role for refresh artifacts. Defaults to coding_agent
  --no-codex           Do not invoke Codex; validate the summary/drill only
  --no-refresh         Do not refresh process trace/resume/recovery after recording the smoke event
  --timeout-ms N       Codex exec timeout. Defaults to 120000
`);
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const result = runCodexTakeoverSmoke(projectDir, {
  runCodex: !has("--no-codex"),
  timeoutMs: Number(valueAfter("--timeout-ms", 120000))
});
let output = result;

if (!has("--no-refresh")) {
  try {
    const refresh = await buildNextAgentPrompt(projectDir, {
      role: valueAfter("--role", "coding_agent"),
      writeFile: true,
      writeResume: true,
      writeRecovery: true
    });
    output = {
      ...result,
      processTraceRefresh: {
        status: "done",
        current: refresh.continuity?.processTrace?.current || null,
        files: {
          nextAgentPrompt: refresh.file,
          resume: refresh.resumeFile,
          recovery: refresh.recoveryFile
        }
      }
    };
  } catch (error) {
    output = {
      ...result,
      processTraceRefresh: {
        status: "failed",
        error: error.message || String(error)
      }
    };
  }
}

console.log(JSON.stringify(output, null, 2));
if (result.status === "fail") process.exit(2);
