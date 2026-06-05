import express from "express";
import { createServer } from "node:http";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { TerminalSession } from "./terminal-session.js";
import { readState, runJson, runProjectAgent, summarizeState, projectAgentCli } from "./project-agent.js";
import { buildInsights } from "./insights.js";
import { buildArchitecture } from "./architecture.js";
import {
  readContinuity,
  readAgentRunbook,
  readContinuityContract,
  readArchitectureMap,
  readMemoryGraph,
  readProcessTrace,
  readDevelopmentTrail,
  readTakeoverPacket,
  readContinuityAudit,
  readTakeoverAcceptanceAudit,
  readGovernanceSpec,
  readStateManifest,
  readAgentContextBundle,
  buildAgentContextBundle,
  writeAgentContextBundle,
  verifyAgentContextBundle,
  buildStateManifest,
  writeStateManifest,
  verifyStateManifest,
  readRuntime,
  ingestHookEvents,
  recordAgentHeartbeat,
  recordEvent,
  recordEvents,
  summarizeAgentLeases,
  writeContinuity
} from "./runtime-state.js";
import { importSessionLog } from "./session-log-adapter.js";
import { buildRecoveryBrief } from "./recovery.js";
import { buildResumePacket } from "./resume.js";
import { buildNextAgentPrompt } from "./next-agent-prompt.js";
import { buildAgentContextPrompt } from "./agent-context-prompt.js";
import { runAgentContextDrill, writeAgentContextDrill } from "./agent-context-drill.js";
import { architectureEventsFromChanges, startArchitectureWatcher } from "./architecture-watcher.js";
import { createAutoHandoffSnapshot } from "./handoff-snapshot.js";
import { attachTakeoverDrill } from "./takeover-drill.js";
import { buildContinuityAudit, writeContinuityAudit } from "./continuity-audit.js";
import { refreshTakeoverAcceptanceAudit } from "./takeover-acceptance-audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const defaultProjectDir = path.resolve(appRoot, "demo-project");
const projectDir = path.resolve(process.env.PROJECT_DIR || defaultProjectDir);
const port = Number(process.env.PORT || 4147);

mkdirSync(projectDir, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));

const appClients = new Set();
let autoHandoffSnapshot = null;

function broadcastAppEvent(message) {
  const payload = JSON.stringify({ at: new Date().toISOString(), ...message });
  for (const ws of appClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function recordAndNotify(event, message = {}) {
  const runtime = recordEvent(projectDir, event);
  broadcastAppEvent({ type: "runtime-event", event: runtime.events?.[0], updatedAt: runtime.updatedAt, ...message });
  autoHandoffSnapshot?.schedule(message.reason || "runtime-event");
  return runtime;
}

function recordManyAndNotify(events, message = {}) {
  const runtime = recordEvents(projectDir, events);
  broadcastAppEvent({ type: "runtime-events", count: events.length, updatedAt: runtime.updatedAt, ...message });
  if (events.length) autoHandoffSnapshot?.schedule(message.reason || "runtime-events");
  return runtime;
}

function ingestHooksAndNotify(payload, message = {}, options = {}) {
  const result = ingestHookEvents(projectDir, payload, options);
  broadcastAppEvent({ type: "hook-ingress", accepted: result.accepted, rejected: result.rejected, status: result.status, pressure: result.pressure, reason: message.reason || "hook-ingress" });
  if (result.accepted) autoHandoffSnapshot?.schedule(message.reason || "hook-ingress");
  return result;
}

function recordArchitectureEvents(architecture, source = "architecture-api") {
  const events = architectureEventsFromChanges(architecture?.changes || [], source);
  if (events.length) recordManyAndNotify(events, { reason: "architecture-changed" });
  return events;
}

function recordAgentAndNotify(agent) {
  const runtime = recordAgentHeartbeat(projectDir, agent);
  const leases = summarizeAgentLeases(runtime);
  broadcastAppEvent({ type: "agent-heartbeat", agentId: agent.agentId || agent.id, agents: leases, reason: "agent-heartbeat" });
  autoHandoffSnapshot?.schedule("agent-heartbeat");
  return { runtime, agents: leases };
}

const terminal = new TerminalSession({
  projectDir,
  shell: process.env.SHELL,
  onEvent: (event) => recordAndNotify(event, { reason: "terminal-event" })
});

autoHandoffSnapshot = createAutoHandoffSnapshot(projectDir, {
  role: "coding_agent",
  terminalSnapshot: () => terminal.getSnapshot(),
  onSnapshot: (snapshot) => broadcastAppEvent({ type: "handoff-snapshot", snapshot, reason: "handoff-snapshot" })
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function currentSummary() {
  return summarizeState(readState(projectDir));
}

app.get("/api/config", (req, res) => {
  res.json({
    projectDir,
    projectAgentCli,
    initialized: existsSync(path.join(projectDir, ".project-agent", "state.json"))
  });
});

app.get("/api/state", (req, res) => {
  res.json(currentSummary());
});

app.get("/api/architecture", (req, res) => {
  const architecture = buildArchitecture(projectDir);
  recordArchitectureEvents(architecture);
  res.json(architecture);
});

app.get("/api/continuity", (req, res) => {
  const continuity = readContinuity(projectDir) || {};
  res.json({
    ...continuity,
    stateManifest: readStateManifest(projectDir) || continuity.stateManifest || null
  });
});

app.get("/api/continuity-contract", (req, res) => {
  res.json({ continuityContract: readContinuityContract(projectDir) || null });
});

app.get("/api/agent-runbook", (req, res) => {
  res.json({ agentRunbook: readAgentRunbook(projectDir) || null });
});

app.get("/api/memory-graph", (req, res) => {
  res.json({ memoryGraph: readMemoryGraph(projectDir) || null });
});

app.get("/api/governance", (req, res) => {
  res.json({ governance: readContinuity(projectDir)?.governance || null });
});

app.get("/api/governance-spec", (req, res) => {
  res.json({ governanceSpec: readGovernanceSpec(projectDir) || null });
});

app.get("/api/state-manifest", (req, res) => {
  if (req.query.write === "1" || req.query.write === "true") {
    const stateManifest = writeStateManifest(projectDir, buildStateManifest(projectDir));
    res.json({ stateManifest, verification: verifyStateManifest(projectDir, stateManifest) });
    return;
  }
  const stateManifest = readStateManifest(projectDir) || null;
  res.json({ stateManifest, verification: verifyStateManifest(projectDir, stateManifest) });
});

app.get("/api/agent-context-bundle", (req, res) => {
  if (req.query.write === "1" || req.query.write === "true") {
    const continuity = readContinuity(projectDir) || {};
    const stateManifest = readStateManifest(projectDir) || continuity.stateManifest || null;
    const bundle = writeAgentContextBundle(projectDir, buildAgentContextBundle(projectDir, continuity, {
      stateManifest,
      stateManifestVerification: verifyStateManifest(projectDir, stateManifest)
    }));
    res.json({ agentContextBundle: bundle, verification: verifyAgentContextBundle(projectDir, bundle) });
    return;
  }
  const agentContextBundle = readAgentContextBundle(projectDir) || null;
  res.json({ agentContextBundle, verification: verifyAgentContextBundle(projectDir, agentContextBundle) });
});

app.get("/api/agent-context-prompt", (req, res) => {
  const result = buildAgentContextPrompt(projectDir, {
    writeFile: req.query.write === "1" || req.query.write === "true"
  });
  if (req.query.format === "markdown" || req.query.markdown === "1") {
    res.type("text/markdown").send(result.markdown);
    return;
  }
  res.json(result);
});

app.get("/api/agent-context-drill", (req, res) => {
  if (req.query.write === "1" || req.query.write === "true") {
    const result = writeAgentContextDrill(projectDir);
    res.json({ drill: result.drill, file: result.file });
    return;
  }
  res.json({ drill: runAgentContextDrill(projectDir), file: null });
});

app.get("/api/graph-trace", (req, res) => {
  res.json({ graphTrace: readContinuity(projectDir)?.graphTrace || null });
});

app.get("/api/process-trace", (req, res) => {
  res.json({ processTrace: readProcessTrace(projectDir) || null });
});

app.get("/api/development-trail", (req, res) => {
  res.json({ developmentTrail: readDevelopmentTrail(projectDir) || null });
});

app.get("/api/architecture-trace", (req, res) => {
  res.json({ architectureTrace: readContinuity(projectDir)?.architectureTrace || null });
});

app.get("/api/architecture-map", (req, res) => {
  res.json({ architectureMap: readArchitectureMap(projectDir) || null });
});

app.get("/api/takeover-packet", (req, res) => {
  res.json({ takeoverPacket: readTakeoverPacket(projectDir) || null });
});

app.get("/api/continuity-audit", (req, res) => {
  const existing = readContinuityAudit(projectDir);
  if (req.query.write === "1" || req.query.write === "true" || !existing) {
    const shouldWrite = req.query.write === "1" || req.query.write === "true";
    const audit = buildContinuityAudit(projectDir, readContinuity(projectDir) || {}, {
      expectedFiles: shouldWrite ? [".project-agent/continuity-audit.json", ".project-agent/takeover-acceptance-audit.json", ".project-agent/state-manifest.json"] : []
    });
    if (shouldWrite) writeContinuityAudit(projectDir, audit);
    res.json({ continuityAudit: audit });
    return;
  }
  res.json({ continuityAudit: existing });
});

app.get("/api/takeover-acceptance-audit", (req, res) => {
  const existing = readTakeoverAcceptanceAudit(projectDir);
  if (req.query.write === "1" || req.query.write === "true" || !existing) {
    const continuity = readContinuity(projectDir) || {};
    const result = refreshTakeoverAcceptanceAudit(projectDir, continuity);
    res.json({ takeoverAcceptanceAudit: result.audit, file: result.file });
    return;
  }
  res.json({ takeoverAcceptanceAudit: existing });
});

app.get("/api/handoff-snapshot", (req, res) => {
  const runtime = readRuntime(projectDir);
  res.json({ snapshot: runtime.handoffSnapshot || null });
});

app.get("/api/takeover-drill", (req, res) => {
  const continuity = attachTakeoverDrill(projectDir, readContinuity(projectDir) || {});
  res.json(continuity.takeoverDrill);
});

app.post(
  "/api/handoff-snapshot",
  asyncHandler(async (req, res) => {
    const snapshot = await autoHandoffSnapshot.writeNow(req.body?.reason || "manual");
    res.json({ snapshot });
  })
);

app.get("/api/events", (req, res) => {
  const runtime = readRuntime(projectDir);
  res.json({ events: runtime.events || [] });
});

app.get("/api/agents", (req, res) => {
  const runtime = readRuntime(projectDir);
  res.json({ agents: summarizeAgentLeases(runtime) });
});

app.post("/api/agents/heartbeat", (req, res) => {
  const { agents } = recordAgentAndNotify({
    agentId: req.body?.agentId || req.body?.id || "local-agent",
    role: req.body?.role,
    goalId: req.body?.goalId,
    status: req.body?.status || "active",
    note: req.body?.note,
    source: req.body?.source || "heartbeat-api",
    pid: req.body?.pid,
    host: req.body?.host,
    leaseSeconds: req.body?.leaseSeconds
  });
  res.json({ agents });
});

app.post("/api/events", (req, res) => {
  const maxEvents = Number.isFinite(Number(req.query?.maxEvents ?? req.body?.maxEvents)) ? Number(req.query?.maxEvents ?? req.body?.maxEvents) : undefined;
  const result = ingestHooksAndNotify(req.body || {}, { reason: "event-ingest" }, { source: req.body?.source || "event-api", agentId: req.body?.agentId, goalId: req.body?.goalId, maxEvents });
  res.status(result.httpStatus || (result.accepted ? 202 : 400)).json({ accepted: result.accepted, rejected: result.rejected, events: result.events, total: result.total, ingress: result });
});

app.post("/api/hooks", (req, res) => {
  const maxEvents = Number.isFinite(Number(req.query?.maxEvents ?? req.body?.maxEvents)) ? Number(req.query?.maxEvents ?? req.body?.maxEvents) : undefined;
  const result = ingestHooksAndNotify(req.body || {}, { reason: "hook-ingress" }, { source: req.body?.source || "hook-api", agentId: req.body?.agentId, goalId: req.body?.goalId, maxEvents });
  res.status(result.httpStatus || (result.accepted ? 202 : 400)).json(result);
});

app.post(
  "/api/import/session-log",
  asyncHandler(async (req, res) => {
    const result = importSessionLog(projectDir, {
      file: req.body?.file,
      items: req.body?.items,
      format: req.body?.format || "auto",
      agentId: req.body?.agentId,
      goalId: req.body?.goalId,
      source: req.body?.source || "session-log-api",
      limit: Number(req.body?.limit) || 200
    });
    if (result.imported) {
      broadcastAppEvent({ type: "runtime-events", count: result.imported, reason: "session-log-import" });
      autoHandoffSnapshot?.schedule("session-log-import");
    }
    res.json(result);
  })
);

app.get(
  "/api/recovery",
  asyncHandler(async (req, res) => {
    const result = await buildRecoveryBrief(projectDir, {
      role: req.query.role || "coding_agent",
      goal: req.query.goal,
      writeFile: req.query.write === "1" || req.query.write === "true",
      terminalSnapshot: terminal.getSnapshot(),
      agentmemoryUrl: process.env.AGENTMEMORY_URL,
      agentmemorySecret: process.env.AGENTMEMORY_SECRET
    });
    if (req.query.format === "markdown") {
      res.type("text/markdown").send(result.markdown);
      return;
    }
    res.json(result);
  })
);

app.get(
  "/api/resume",
  asyncHandler(async (req, res) => {
    const result = await buildResumePacket(projectDir, {
      role: req.query.role || "coding_agent",
      goal: req.query.goal,
      writeFile: req.query.write === "1" || req.query.write === "true",
      writeRecovery: req.query.writeRecovery !== "0" && req.query.writeRecovery !== "false",
      terminalSnapshot: terminal.getSnapshot(),
      agentmemoryUrl: process.env.AGENTMEMORY_URL,
      agentmemorySecret: process.env.AGENTMEMORY_SECRET
    });
    if (req.query.format === "markdown") {
      res.type("text/markdown").send(result.markdown);
      return;
    }
    res.json(result);
  })
);

app.get(
  "/api/next-agent-prompt",
  asyncHandler(async (req, res) => {
    const result = await buildNextAgentPrompt(projectDir, {
      role: req.query.role || "coding_agent",
      goal: req.query.goal,
      writeFile: req.query.write === "1" || req.query.write === "true",
      writeResume: req.query.writeResume !== "0" && req.query.writeResume !== "false",
      writeRecovery: req.query.writeRecovery !== "0" && req.query.writeRecovery !== "false",
      terminalSnapshot: terminal.getSnapshot(),
      agentmemoryUrl: process.env.AGENTMEMORY_URL,
      agentmemorySecret: process.env.AGENTMEMORY_SECRET
    });
    if (req.query.format === "markdown") {
      res.type("text/markdown").send(result.markdown);
      return;
    }
    res.json(result);
  })
);

app.get(
  "/api/insights",
  asyncHandler(async (req, res) => {
    const rawState = readState(projectDir);
    const summary = summarizeState(rawState);
    const architecture = buildArchitecture(projectDir);
    recordArchitectureEvents(architecture);
    const runtime = readRuntime(projectDir);
    let packet = null;
    if (summary.initialized) {
      const role = req.query.role || "coding_agent";
      const goal = req.query.goal || summary.activeGoal?.id;
      const args = ["kernel", "--role", role, "--format", "json"];
      if (goal) args.push("--goal", goal);
      packet = await runJson(projectDir, args);
    }
    const insights = await buildInsights({
      projectDir,
      rawState,
      summary,
      packet,
      architecture,
      runtimeEvents: runtime.events || [],
      hookIngresses: runtime.hookIngresses || [],
      agentLeases: summarizeAgentLeases(runtime),
      handoffSnapshot: runtime.handoffSnapshot || null,
      terminalSnapshot: terminal.getSnapshot(),
      agentmemoryUrl: process.env.AGENTMEMORY_URL,
      agentmemorySecret: process.env.AGENTMEMORY_SECRET
    });
    insights.continuity = writeContinuity(projectDir, insights.continuity);
    insights.continuity = attachTakeoverDrill(projectDir, insights.continuity);
    const continuityAudit = buildContinuityAudit(projectDir, insights.continuity, {
      expectedFiles: [".project-agent/continuity-audit.json", ".project-agent/takeover-acceptance-audit.json", ".project-agent/state-manifest.json"]
    });
    writeContinuityAudit(projectDir, continuityAudit);
    insights.continuity = writeContinuity(projectDir, {
      ...insights.continuity,
      continuityAudit
    });
    const finalContinuityAudit = buildContinuityAudit(projectDir, insights.continuity, {
      expectedFiles: [".project-agent/continuity-audit.json", ".project-agent/takeover-acceptance-audit.json", ".project-agent/state-manifest.json"]
    });
    writeContinuityAudit(projectDir, finalContinuityAudit);
    const takeoverAcceptance = refreshTakeoverAcceptanceAudit(projectDir, {
      ...insights.continuity,
      continuityAudit: finalContinuityAudit
    });
    insights.continuity = takeoverAcceptance.continuity;
    res.json(insights);
  })
);

app.post(
  "/api/init",
  asyncHandler(async (req, res) => {
    const name = req.body?.name || path.basename(projectDir);
    const result = await runProjectAgent(projectDir, ["init", "--name", name]);
    recordAndNotify({
      phase: "observe",
      title: "Project initialized",
      status: "done",
      detail: name,
      refs: ["PROJECT.md", ".project-agent/state.json"]
    });
    res.json({ output: result.stdout, state: currentSummary() });
  })
);

app.get(
  "/api/kernel",
  asyncHandler(async (req, res) => {
    const role = req.query.role || "coding_agent";
    const goal = req.query.goal;
    const args = ["kernel", "--role", role, "--format", "json"];
    if (goal) args.push("--goal", goal);
    const packet = await runJson(projectDir, args);
    res.json(packet);
  })
);

app.post(
  "/api/goals",
  asyncHandler(async (req, res) => {
    const args = ["goal", "create", "--objective", req.body.objective || "Untitled goal"];
    for (const item of req.body.acceptance || []) args.push("--accept", item);
    if (req.body.owner) args.push("--owner", req.body.owner);
    const goal = await runJson(projectDir, args);
    recordAndNotify({
      phase: "plan",
      title: "Goal created",
      status: "done",
      detail: goal.objective,
      refs: [goal.id]
    });
    res.json({ goal, state: currentSummary() });
  })
);

app.post(
  "/api/actions",
  asyncHandler(async (req, res) => {
    const args = [
      "action",
      "add",
      req.body.goalId,
      "--title",
      req.body.title || "Untitled action",
      "--activity",
      req.body.activity || "implementation"
    ];
    if (req.body.role) args.push("--role", req.body.role);
    if (req.body.description) args.push("--description", req.body.description);
    const action = await runJson(projectDir, args);
    recordAndNotify({
      phase: action.activityClass || "plan",
      title: "Action added",
      status: "done",
      detail: action.title,
      refs: [action.id, action.goalId]
    });
    res.json({ action, state: currentSummary() });
  })
);

app.post(
  "/api/actions/:id",
  asyncHandler(async (req, res) => {
    const args = ["action", "set", req.params.id];
    if (req.body.status) args.push("--status", req.body.status);
    if (req.body.role) args.push("--role", req.body.role);
    if (req.body.agent) args.push("--agent", req.body.agent);
    const action = await runJson(projectDir, args);
    recordAndNotify({
      phase: action.activityClass || "execute",
      title: "Action updated",
      status: action.status === "done" ? "done" : "current",
      detail: `${action.title} -> ${action.status}`,
      refs: [action.id, action.goalId]
    });
    res.json({ action, state: currentSummary() });
  })
);

app.post(
  "/api/gates",
  asyncHandler(async (req, res) => {
    const args = [
      "gate",
      "add",
      req.body.goalId,
      "--name",
      req.body.name || "Quality gate",
      "--type",
      req.body.type || "test"
    ];
    if (req.body.command) args.push("--command", req.body.command);
    if (req.body.actionId) args.push("--action-id", req.body.actionId);
    if (req.body.optional) args.push("--optional");
    const gate = await runJson(projectDir, args);
    recordAndNotify({
      phase: "audit",
      title: "Quality gate added",
      status: "done",
      detail: gate.name,
      refs: [gate.id, gate.goalId]
    });
    res.json({ gate, state: currentSummary() });
  })
);

app.post(
  "/api/gates/:id/run",
  asyncHandler(async (req, res) => {
    const result = await runJson(projectDir, ["gate", "run", req.params.id], { allowFailure: true });
    recordAndNotify({
      phase: "audit",
      title: "Quality gate run",
      status: result.status === "passed" ? "done" : "current",
      detail: result.name || req.params.id,
      refs: [req.params.id]
    });
    res.json({ result, state: currentSummary() });
  })
);

app.post(
  "/api/evidence",
  asyncHandler(async (req, res) => {
    const args = [
      "evidence",
      req.body.goalId,
      "--kind",
      req.body.kind || "command",
      "--ref",
      req.body.ref || "manual",
      "--summary",
      req.body.summary || "Evidence captured"
    ];
    for (const item of req.body.verifies || []) args.push("--verifies", item);
    if (req.body.producedBy) args.push("--produced-by", req.body.producedBy);
    const evidence = await runJson(projectDir, args);
    recordAndNotify({
      phase: "evidence",
      title: "Evidence saved",
      status: "done",
      detail: evidence.summary,
      refs: [evidence.id, evidence.ref, ...(evidence.verifies || [])].filter(Boolean)
    });
    res.json({ evidence, state: currentSummary() });
  })
);

app.post(
  "/api/evidence/last-command",
  asyncHandler(async (req, res) => {
    const snapshot = terminal.captureLastCommand();
    if (!snapshot) {
      res.status(400).json({ error: "No command captured yet." });
      return;
    }
    const state = currentSummary();
    const goalId = req.body.goalId || state.activeGoal?.id;
    if (!goalId) {
      res.status(400).json({ error: "Create or select a goal first." });
      return;
    }
    const verifies = req.body.verifies?.length ? req.body.verifies : [];
    const cleanOutput = (snapshot.output || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    const summary =
      req.body.summary ||
      `${snapshot.command} produced ${cleanOutput.split("\n").filter(Boolean).length || 1} line(s) of terminal output`;
    const args = [
      "evidence",
      goalId,
      "--kind",
      req.body.kind || "command",
      "--ref",
      snapshot.command,
      "--summary",
      summary,
      "--produced-by",
      "project-agent-terminal"
    ];
    for (const item of verifies) args.push("--verifies", item);
    const evidence = await runJson(projectDir, args);
    recordAndNotify({
      phase: "evidence",
      title: "Command evidence saved",
      status: "done",
      detail: evidence.summary,
      refs: [evidence.id, evidence.ref, ...(evidence.verifies || [])].filter(Boolean)
    });
    res.json({ evidence, command: snapshot, state: currentSummary() });
  })
);

app.get(
  "/api/audit/:goalId",
  asyncHandler(async (req, res) => {
    const audit = await runJson(projectDir, ["audit", req.params.goalId]);
    recordAndNotify({
      phase: "audit",
      title: "Completion audit",
      status: audit.canComplete ? "done" : "current",
      detail: audit.canComplete ? "ready to complete" : `${audit.missing?.length || 0} missing`,
      refs: [req.params.goalId]
    });
    res.json(audit);
  })
);

app.post(
  "/api/audit/:goalId/complete",
  asyncHandler(async (req, res) => {
    const result = await runProjectAgent(projectDir, ["audit", req.params.goalId, "--complete"], { allowFailure: true });
    recordAndNotify({
      phase: "audit",
      title: "Goal completion requested",
      status: result.code === 0 ? "done" : "current",
      detail: result.stdout.split("\n").find(Boolean) || req.params.goalId,
      refs: [req.params.goalId]
    });
    res.json({ output: result.stdout, state: currentSummary() });
  })
);

app.get(
  "/api/handoff/:goalId",
  asyncHandler(async (req, res) => {
    const result = await runProjectAgent(projectDir, ["handoff", req.params.goalId]);
    recordAndNotify({
      phase: "handoff",
      title: "Handoff generated",
      status: "done",
      detail: req.params.goalId,
      refs: [req.params.goalId, ".project-agent/state.json"]
    });
    res.json({ markdown: result.stdout, state: currentSummary() });
  })
);

app.get("/api/terminal/snapshot", (req, res) => {
  res.json(terminal.getSnapshot());
});

const dist = path.join(appRoot, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || String(err) });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => terminal.attach(ws));

const eventsWss = new WebSocketServer({ noServer: true });
eventsWss.on("connection", (ws) => {
  appClients.add(ws);
  ws.send(JSON.stringify({ type: "hello", projectDir, at: new Date().toISOString() }));
  ws.on("close", () => appClients.delete(ws));
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/terminal") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    return;
  }
  if (pathname === "/events") {
    eventsWss.handleUpgrade(request, socket, head, (ws) => eventsWss.emit("connection", ws, request));
    return;
  }
  socket.destroy();
});

startArchitectureWatcher(projectDir, {
  onEvents(events) {
    recordManyAndNotify(events, { reason: "architecture-watcher" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Project Agent Terminal server on http://127.0.0.1:${port}`);
  console.log(`Project dir: ${projectDir}`);
});
