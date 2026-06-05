import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAgentContextBundle, verifyAgentContextBundle } from "./runtime-state.js";

function check(id, label, status, detail, refs = []) {
  return { id, label, status, detail, refs: refs.filter(Boolean).slice(0, 10) };
}

function statusFromChecks(checks) {
  if (checks.some((item) => item.status === "bad")) return "fail";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function score(checks) {
  return `${checks.filter((item) => item.status === "ok").length}/${checks.length}`;
}

export function runAgentContextDrill(projectDir, options = {}) {
  const bundle = options.bundle || readAgentContextBundle(projectDir);
  const verification = options.verification || verifyAgentContextBundle(projectDir, bundle);
  const quick = bundle?.quickStart || {};
  const coverage = bundle?.validation?.objectiveCoverage || {};
  const changedFiles = bundle?.architecture?.changedFiles || [];
  const interrupted = quick.interruptedWork || { count: 0, items: [] };
  const runbook = bundle?.governance?.runbook || {};
  const checks = [
    check(
      "bundle_verified",
      "Bundle Verified",
      verification.canResume ? (verification.status === "warn" ? "warn" : "ok") : "bad",
      verification.summary || "No bundle verification result.",
      [".project-agent/agent-context-bundle.json"]
    ),
    check(
      "objective_coverage",
      "Objective Coverage",
      coverage.schemaVersion === "project-agent.objective-coverage.v1" ? (coverage.status === "blocked" ? "bad" : coverage.status === "watch" ? "warn" : "ok") : "bad",
      coverage.summary || "No objective coverage map is embedded.",
      [".project-agent/agent-context-bundle.json"]
    ),
    check(
      "current_cursor",
      "Current Cursor",
      quick.currentCursor?.title ? "ok" : "bad",
      quick.currentCursor ? `${quick.currentCursor.phase || "event"}/${quick.currentCursor.status || "unknown"}: ${quick.currentCursor.title}` : "No current cursor.",
      [quick.currentCursor?.id, ...(quick.currentCursor?.refs || [])]
    ),
    check(
      "next_command",
      "Next Command",
      quick.nextCommand || runbook.nextCommand ? "ok" : "bad",
      quick.nextCommand || runbook.nextCommand || "No next command.",
      ["npm run event", ".project-agent/agent-runbook.json"]
    ),
    check(
      "changed_files",
      "Changed Files",
      changedFiles.length ? "ok" : "warn",
      changedFiles.length ? `${changedFiles.length} changed file(s) captured for inspection.` : "No changed files captured.",
      changedFiles.slice(0, 8).map((file) => file.path)
    ),
    check(
      "interrupted_work",
      "Interrupted Work",
      interrupted.count ? "warn" : "ok",
      interrupted.count ? `${interrupted.count} interrupted item(s) must be resolved first.` : "No interrupted work in bundle.",
      (interrupted.items || []).flatMap((item) => [item.id, ...(item.refs || [])]).slice(0, 8)
    ),
    check(
      "read_order",
      "Read Order",
      bundle?.readOrder?.[0] === ".project-agent/agent-context-bundle.json" ? "ok" : "bad",
      bundle?.readOrder?.length ? `${bundle.readOrder.length} read-order item(s).` : "No read order in bundle.",
      bundle?.readOrder || []
    )
  ];
  const status = statusFromChecks(checks);
  const firstActions = [
    {
      action: "Verify the bundle before trusting the handoff.",
      command: `npm run context -- --project-dir "${projectDir}" --verify`,
      refs: [".project-agent/agent-context-bundle.json"]
    },
    {
      action: "Read the bundle-only starter prompt.",
      command: "cat .project-agent/context-starter-prompt.md",
      refs: [".project-agent/context-starter-prompt.md"]
    },
    ...(interrupted.count
      ? [{
          action: "Resolve interrupted work before unrelated edits.",
          command: quick.nextCommand || runbook.nextCommand || null,
          refs: (interrupted.items || []).flatMap((item) => [item.id, ...(item.refs || [])]).slice(0, 8)
        }]
      : []),
    {
      action: "Inspect changed files and architecture impact.",
      command: "cat .project-agent/agent-context-bundle.json",
      refs: changedFiles.slice(0, 8).map((file) => file.path)
    },
    {
      action: "Record the next current event before using tools.",
      command: "npm run event -- --project-dir \"$PROJECT_DIR\" --phase execute --status current --title \"Next tool call\" --detail \"what the replacement agent is about to do\"",
      refs: [quick.currentCursor?.id, ".project-agent/runtime.json"]
    }
  ];
  return {
    schemaVersion: "project-agent.context-takeover-drill.v1",
    generatedAt: new Date().toISOString(),
    status,
    canResume: status !== "fail",
    score: score(checks),
    summary: status === "fail"
      ? "Bundle-only takeover drill is blocked."
      : status === "warn"
        ? "Bundle-only takeover drill can resume with warnings."
        : "Bundle-only takeover drill can resume.",
    checks,
    firstActions,
    nextCommand: quick.nextCommand || runbook.nextCommand || null,
    cursor: quick.currentCursor || null,
    objectiveCoverage: coverage,
    verification
  };
}

export function writeAgentContextDrill(projectDir, drill = runAgentContextDrill(projectDir)) {
  const dir = path.join(projectDir, ".project-agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "context-takeover-drill.json");
  writeFileSync(file, `${JSON.stringify(drill, null, 2)}\n`, "utf8");
  return { drill, file };
}
