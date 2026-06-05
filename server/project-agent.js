import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const defaultCli = path.resolve(appRoot, "..", "project-agent-mvp", "project_agent.py");

export const projectAgentCli = process.env.PROJECT_AGENT_CLI || defaultCli;

export function ensureCliExists() {
  if (!existsSync(projectAgentCli)) {
    throw new Error(`Project Agent CLI not found at ${projectAgentCli}`);
  }
}

export function runProjectAgent(projectDir, args, options = {}) {
  ensureCliExists();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [projectAgentCli, "--project-dir", projectDir, ...args], {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(stderr || stdout || `project_agent.py exited ${code}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runJson(projectDir, args, options = {}) {
  const jsonArgs = args.includes("--format") ? args : [...args, "--json"];
  const result = await runProjectAgent(projectDir, jsonArgs, options);
  const trimmed = result.stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Expected JSON from project_agent.py, got: ${trimmed.slice(0, 500)}`);
  }
}

export function readState(projectDir) {
  const statePath = path.join(projectDir, ".project-agent", "state.json");
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function summarizeState(state) {
  if (!state) {
    return {
      initialized: false,
      goals: [],
      activeGoal: null,
      actions: [],
      gates: [],
      evidence: [],
      decisions: [],
      risks: []
    };
  }

  const goals = Object.values(state.goals || {}).sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || "")
  );
  const activeGoal = goals.find((goal) => goal.status === "active") || goals[0] || null;
  const goalId = activeGoal?.id;
  const actions = Object.values(state.actions || {})
    .filter((action) => !goalId || action.goalId === goalId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const gates = Object.values(state.gates || {})
    .filter((gate) => !goalId || gate.goalId === goalId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const evidence = Object.values(state.evidence || {})
    .filter((item) => !goalId || activeGoal?.evidence?.includes(item.id))
    .sort((a, b) => (b.producedAt || "").localeCompare(a.producedAt || ""));
  const decisions = Object.values(state.decisions || {})
    .filter((item) => !goalId || !item.goalId || item.goalId === goalId)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const risks = Object.values(state.risks || {})
    .filter((item) => !goalId || !item.goalId || item.goalId === goalId)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return {
    initialized: true,
    project: state.project,
    updatedAt: state.updatedAt,
    goals,
    activeGoal,
    actions,
    gates,
    evidence,
    decisions,
    risks
  };
}
