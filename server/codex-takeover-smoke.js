import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildAgentContextBundle,
  buildTakeoverSummary,
  readAgentContextBundle,
  readContinuity,
  readTakeoverSummary,
  recordEvent,
  verifyAgentContextBundle,
  writeTakeoverSummary
} from "./runtime-state.js";

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 700) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (!text.trim()) return 0;
  return Math.ceil(Math.max(text.length / 4, text.split(/\s+/).filter(Boolean).length * 1.35));
}

function parseJsonLines(text = "") {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseModelAssessment(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function collectUsage(value, usage = {}) {
  if (!value || typeof value !== "object") return usage;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") {
      if (/input.*token|prompt.*token/i.test(key)) usage.inputTokens = Math.max(usage.inputTokens || 0, entry);
      if (/output.*token|completion.*token/i.test(key)) usage.outputTokens = Math.max(usage.outputTokens || 0, entry);
      if (/total.*token/i.test(key)) usage.totalTokens = Math.max(usage.totalTokens || 0, entry);
    } else if (entry && typeof entry === "object") {
      collectUsage(entry, usage);
    }
  }
  return usage;
}

function codexAvailable() {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

function buildSmokePrompt(summary) {
  return [
    "You are running a read-only takeover smoke test for this project.",
    "Do not edit files. Do not rely on prior chat history.",
    "Start from `.project-agent/takeover-summary.json`.",
    "Do not read full `.project-agent/agent-context-bundle.json` or `.project-agent/continuity.json`; use summary source refs and jq-style field reads only if needed.",
    "If the current state refers to a prior Codex takeover smoke test, treat it as historical smoke evidence, not as the current product task.",
    "",
    "Return a concise JSON object with these keys:",
    "canTakeOver, currentGoal, currentState, nextStep, risks, filesRead, warnings.",
    "",
    "The summary says:",
    JSON.stringify({
      activeGoal: summary.activeGoal || null,
      currentState: summary.currentState || null,
      nextStep: summary.nextStep || null,
      takeover: summary.takeover || null,
      risks: summary.risks || [],
      budgets: summary.budgets || {},
      onDemandReads: summary.onDemandReads || []
    }, null, 2)
  ].join("\n");
}

function validateSummary(summary, verification) {
  const warnings = [
    !summary?.activeGoal?.objective ? "missing_active_goal" : "",
    !summary?.currentState?.title ? "missing_current_state" : "",
    !summary?.nextStep?.command ? "missing_next_command" : "",
    summary?.budget?.status === "over_budget" ? "summary_over_budget" : "",
    ...(verification?.warnings || []).map((item) => `bundle_${item}`)
  ].filter(Boolean);
  const blockers = [
    verification?.canResume === false ? "bundle_verification_blocked" : "",
    summary?.takeover?.canTakeOver === false ? "takeover_blocked" : ""
  ].filter(Boolean);
  return {
    status: blockers.length ? "fail" : warnings.length ? "warn" : "pass",
    canTakeOver: blockers.length === 0,
    warnings,
    blockers
  };
}

function writeSmokeArtifact(projectDir, result) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "codex-takeover-smoke.json");
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return file;
}

export function runCodexTakeoverSmoke(projectDir, options = {}) {
  const continuity = readContinuity(projectDir) || {};
  const bundle = readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity);
  const verification = verifyAgentContextBundle(projectDir, bundle);
  const summary = options.writeSummary === false
    ? readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, continuity, { bundle, verification })
    : writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, continuity, { bundle, verification }));
  const prompt = buildSmokePrompt(summary);
  const validation = validateSummary(summary, verification);
  const startedAt = nowIso();
  const runId = `codex_smoke_${Date.now().toString(36)}`;
  const shouldRunCodex = options.runCodex !== false;
  const warnings = [...validation.warnings];
  let codex = null;
  let modelOutput = "";
  let usage = {};
  let status = validation.status;

  if (shouldRunCodex && codexAvailable()) {
    const outputFile = path.join(os.tmpdir(), `${runId}-last-message.txt`);
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--cd",
      projectDir,
      "--json",
      "--output-last-message",
      outputFile,
      prompt
    ];
    const result = spawnSync("codex", args, {
      cwd: projectDir,
      encoding: "utf8",
      timeout: Number(options.timeoutMs || 120000),
      maxBuffer: 10 * 1024 * 1024
    });
    const events = parseJsonLines(result.stdout || "");
    usage = collectUsage(events);
    if (usage.inputTokens || usage.outputTokens) usage.totalTokens = usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (existsSync(outputFile)) modelOutput = readFileSync(outputFile, "utf8");
    codex = {
      command: `codex ${args.slice(0, -1).join(" ")} <prompt>`,
      exitCode: result.status,
      signal: result.signal || null,
      stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
      stderr: compact(result.stderr || "", 1200),
      outputFile
    };
    if (result.status !== 0) {
      status = "fail";
      warnings.push("codex_exec_failed");
    }
  } else if (shouldRunCodex) {
    warnings.push("codex_cli_unavailable");
    status = status === "pass" ? "warn" : status;
  } else {
    warnings.push("codex_run_skipped");
    status = status === "pass" ? "warn" : status;
  }

  const modelAssessment = parseModelAssessment(modelOutput);
  if (codex?.exitCode === 0 && modelAssessment?.canTakeOver === false) {
    status = "fail";
    warnings.push("codex_model_cannot_take_over");
  }

  const endedAt = nowIso();
  const result = {
    schemaVersion: "project-agent.codex-takeover-smoke.v1",
    runId,
    startedAt,
    endedAt,
    status,
    canTakeOver: status !== "fail" && validation.canTakeOver && modelAssessment?.canTakeOver !== false,
    summary: status === "fail"
      ? "Codex takeover smoke test failed or takeover is blocked."
      : status === "warn"
        ? "Codex takeover smoke test completed with warnings."
        : "Codex takeover smoke test passed.",
    tokenUsage: {
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      totalTokens: usage.totalTokens || null,
      estimatedPromptTokens: estimateTokens(prompt),
      estimatedSummaryTokens: estimateTokens(summary)
    },
    takeoverSummary: {
      status: summary.takeover?.status || "unknown",
      canTakeOver: summary.takeover?.canTakeOver !== false,
      budget: summary.budget || null,
      currentState: summary.currentState || null,
      nextStep: summary.nextStep || null,
      risks: summary.risks || []
    },
    verification: {
      status: verification.status,
      canResume: verification.canResume,
      blockers: verification.blockers || [],
      warnings: verification.warnings || []
    },
    codex,
    modelAssessment,
    modelOutput: compact(modelOutput, 4000),
    warnings: [...new Set(warnings)],
    blockers: validation.blockers,
    refs: [".project-agent/takeover-summary.json", ".project-agent/context-starter-prompt.md", ".project-agent/codex-takeover-smoke.json"]
  };
  const file = writeSmokeArtifact(projectDir, result);
  recordEvent(projectDir, {
    id: runId,
    phase: "audit",
    status: result.status === "fail" ? "failed" : "done",
    title: "Codex takeover smoke test",
    detail: `${result.summary} tokens=${result.tokenUsage.totalTokens || result.tokenUsage.estimatedPromptTokens}`,
    refs: result.refs,
    artifactRefs: [".project-agent/codex-takeover-smoke.json"],
    source: "codex-takeover-smoke",
    tool: "codex",
    runId,
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    cost: result.tokenUsage,
    data: {
      status: result.status,
      canTakeOver: result.canTakeOver,
      warnings: result.warnings,
      blockers: result.blockers,
      file
    }
  });
  return { ...result, file };
}

export function readCodexTakeoverSmoke(projectDir) {
  const file = path.join(projectDir, ".project-agent", "codex-takeover-smoke.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
