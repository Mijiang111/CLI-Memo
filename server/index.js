import express from "express";
import { createServer } from "node:http";
import { mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { TerminalSession } from "./terminal-session.js";
import { readState, runJson, runProjectAgent, summarizeState, projectAgentCli } from "./project-agent.js";
import { buildInsights } from "./insights.js";
import { buildArchitecture } from "./architecture.js";
import {
  readContinuity,
  readContinuityDetail,
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
  readTakeoverSummary,
  buildAgentContextBundle,
  buildTakeoverSummary,
  writeAgentContextBundle,
  writeTakeoverSummary,
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
import { readCodexTakeoverSmoke, runCodexTakeoverSmoke } from "./codex-takeover-smoke.js";
import { architectureEventsFromChanges, startArchitectureWatcher } from "./architecture-watcher.js";
import { createAutoHandoffSnapshot } from "./handoff-snapshot.js";
import { attachTakeoverDrill } from "./takeover-drill.js";
import { buildContinuityAudit, writeContinuityAudit } from "./continuity-audit.js";
import { refreshTakeoverAcceptanceAudit } from "./takeover-acceptance-audit.js";
import { defaultContextQuery, readContextRef, searchContext } from "./grep-context.js";
import { buildAgentBootstrapKit, buildCliAgentCommand, resolveCodexCli, writeCliAgentBootstrap } from "./cli-agent-bootstrap.js";
import { addMemory, auditMemoryRetention, buildMemoryHarness, buildMemoryInventory, consolidateMemory, ensureMemoryStore, forgetMemory, inspectMemoryEntityIndex, inspectMemorySearchIndex, inspectMemoryVectorIndex, queryMemoryAudit, readMemory, rebuildMemoryEntityIndex, rebuildMemorySearchIndex, rebuildMemoryVectorIndex, seedDogfoodMemory, searchMemory, supersedeMemory, sweepMemoryRetention, updateMemory } from "./memory-store.js";
import { buildStateExport, importStateExportBundle } from "./state-transfer.js";
import { buildProjectLauncher, launchProjectInstance, readProjectLauncherLogs, registerLauncherProject, restartProjectInstance, stopProjectInstance } from "./project-launcher.js";
import { buildSandboxGuidance } from "./sandbox-guidance.js";
import { publicAuthBoundary, resolveAuthBoundary, validateAuthRequest } from "./auth-boundary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const defaultProjectDir = path.resolve(appRoot, "demo-project");
const projectDir = path.resolve(process.env.PROJECT_DIR || defaultProjectDir);
const port = Number(process.env.PORT || 4147);
const uiPort = Number(process.env.VITE_PORT || 5174);
const authBoundary = resolveAuthBoundary({ env: process.env });
const bindHost = authBoundary.effective.bindHost;
const serverStartedAt = new Date().toISOString();

mkdirSync(projectDir, { recursive: true });

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/security/auth") return next();
  const auth = validateAuthRequest(req, authBoundary);
  if (auth.ok) return next();
  res.status(401).json({
    schemaVersion: "project-agent.auth-error.v1",
    error: "Authentication required.",
    auth: publicAuthBoundary(authBoundary)
  });
});

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

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function pathHealth(absPath) {
  const stats = safeCall(() => statSync(absPath), null);
  return {
    path: absPath,
    exists: Boolean(stats),
    type: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : "missing",
    readable: Boolean(stats)
  };
}

function buildHealthSnapshot() {
  const initialized = existsSync(path.join(projectDir, ".project-agent", "state.json"));
  const terminalSnapshot = terminal.getSnapshot();
  const stateManifest = readStateManifest(projectDir);
  const stateManifestVerification = stateManifest ? verifyStateManifest(projectDir, stateManifest) : null;
  const memoryInventory = safeCall(() => buildMemoryInventory(projectDir), null);
  const memorySearchIndex = safeCall(() => inspectMemorySearchIndex(projectDir), null);
  const memoryEntityIndex = safeCall(() => inspectMemoryEntityIndex(projectDir), null);
  const memoryVectorIndex = safeCall(() => inspectMemoryVectorIndex(projectDir), null);
  const sandboxGuidance = safeCall(() => buildSandboxGuidance({ appRoot, projectDir, bindHost, apiPort: port, uiPort, authBoundary: publicAuthBoundary(authBoundary) }), null);
  const warnings = [
    terminalSnapshot.backend === "failed" ? "terminal_backend_failed" : "",
    terminalSnapshot.backend === "pipe" ? "terminal_pipe_mode" : "",
    initialized && stateManifestVerification && !stateManifestVerification.ok ? "state_manifest_mismatch" : "",
    memorySearchIndex && ["stale", "invalid"].includes(memorySearchIndex.status) ? "memory_bm25_index" : "",
    memoryEntityIndex && ["stale", "invalid"].includes(memoryEntityIndex.status) ? "memory_entity_index" : "",
    memoryVectorIndex && ["stale", "invalid"].includes(memoryVectorIndex.status) ? "memory_vector_index" : "",
    sandboxGuidance?.status === "blocked" ? "sandbox_boundary_blocked" : ""
  ].filter(Boolean);
  return {
    schemaVersion: "project-agent.health.v1",
    status: warnings.length ? "watch" : "ok",
    checkedAt: new Date().toISOString(),
    server: {
      startedAt: serverStartedAt,
      uptimeSeconds: Math.round(process.uptime()),
      bindHost,
      port,
      uiPort,
      url: `http://${bindHost}:${port}`,
      uiUrl: `http://${bindHost}:${uiPort}`,
      node: process.version
    },
    project: {
      name: path.basename(projectDir),
      projectDir,
      initialized,
      root: pathHealth(projectDir),
      stateDir: pathHealth(path.join(projectDir, ".project-agent"))
    },
    terminal: {
      backend: terminalSnapshot.backend,
      shell: terminalSnapshot.shell,
      status: terminalSnapshot.backend === "failed" ? "bad" : terminalSnapshot.backend === "stopped" ? "warn" : "ok",
      reason: terminalSnapshot.backendReason || ""
    },
    state: {
      manifest: stateManifest
        ? {
            status: stateManifestVerification?.status || "unknown",
            ok: Boolean(stateManifestVerification?.ok),
            fileCount: stateManifest?.files?.length || stateManifest?.fileCount || 0,
            checkedAt: stateManifestVerification?.checkedAt || null
          }
        : {
            status: initialized ? "missing" : "not_started",
            ok: !initialized,
            fileCount: 0,
            checkedAt: null
          }
    },
    memory: {
      status: memoryInventory?.status || "unknown",
      records: memoryInventory?.totals?.records || 0,
      canonicalFiles: memoryInventory?.canonicalFiles?.length || 0,
      bm25: memorySearchIndex ? { status: memorySearchIndex.status, fresh: Boolean(memorySearchIndex.fresh) } : null,
      entity: memoryEntityIndex ? { status: memoryEntityIndex.status, fresh: Boolean(memoryEntityIndex.fresh) } : null,
      vector: memoryVectorIndex ? { status: memoryVectorIndex.status, fresh: Boolean(memoryVectorIndex.fresh), engine: memoryVectorIndex.engine } : null
    },
    security: {
      boundary: authBoundary.effective.boundary,
      localOnly: authBoundary.effective.localOnly,
      auth: authBoundary.auth.mode,
      authRequired: authBoundary.auth.required,
      remoteAccess: authBoundary.effective.remoteAccess,
      summary: authBoundary.effective.localOnly
        ? "Server binds to 127.0.0.1 and is intended for trusted local use only."
        : "Server is in intentional non-local mode and requires bearer-token auth.",
      authBoundary: publicAuthBoundary(authBoundary),
      sandbox: sandboxGuidance
        ? {
            schemaVersion: sandboxGuidance.schemaVersion,
            status: sandboxGuidance.status,
            summary: sandboxGuidance.posture?.summary || "",
            checks: sandboxGuidance.summary,
            nextAction: sandboxGuidance.nextAction
          }
        : null
    },
    warnings,
    nextAction: warnings.length
      ? "Review warning details before accepting a handoff or remote launch."
      : "Local server, project state, terminal backend, and memory surfaces are reachable."
  };
}

function resolveReadableGoalId(summary, requestedGoalId) {
  const goals = new Set((summary.goals || []).map((goal) => goal.id));
  if (requestedGoalId && goals.has(requestedGoalId)) return requestedGoalId;
  return summary.activeGoal?.id || "";
}

app.get("/api/config", (req, res) => {
  res.json({
    projectDir,
    projectAgentCli,
    appRoot,
    apiPort: port,
    uiPort,
    initialized: existsSync(path.join(projectDir, ".project-agent", "state.json"))
  });
});

app.get("/api/health", (req, res) => {
  res.json(buildHealthSnapshot());
});

app.get("/api/security/auth", (req, res) => {
  res.json(publicAuthBoundary(authBoundary));
});

app.get("/api/security/sandbox", (req, res) => {
  res.json(buildSandboxGuidance({ appRoot, projectDir, bindHost, apiPort: port, uiPort, authBoundary: publicAuthBoundary(authBoundary) }));
});

app.get("/api/projects", asyncHandler(async (req, res) => {
  res.json(await buildProjectLauncher({
    appRoot,
    currentProjectDir: projectDir,
    defaultProjectDir,
    currentPort: port,
    currentUiPort: uiPort
  }));
}));

app.post("/api/projects/register", (req, res) => {
  try {
    const result = registerLauncherProject(projectDir, req.body || {});
    recordAndNotify({
      phase: "audit",
      title: "Launcher project registered",
      status: "done",
      detail: result.entry.projectDir,
      refs: [".project-agent/project-launcher.json"],
      files: [{ path: ".project-agent/project-launcher.json", status: "modified", kind: "launcher" }]
    }, { reason: "project-register" });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/projects/launch", asyncHandler(async (req, res) => {
  const result = await launchProjectInstance({
    appRoot,
    controlProjectDir: projectDir,
    projectDir: req.body?.projectDir,
    currentPort: port,
    currentUiPort: uiPort,
    apiPort: req.body?.apiPort,
    uiPort: req.body?.uiPort,
    dryRun: req.body?.dryRun,
    execute: req.body?.execute
  });
  if (result.launched) {
    recordAndNotify({
      phase: "execute",
      title: "Launcher started project instance",
      status: "done",
      detail: result.url,
      refs: [".project-agent/project-launcher.json"],
      files: [{ path: result.project.projectDir, status: "launched", kind: "project" }]
    }, { reason: "project-launch" });
  }
  res.json(result);
}));

app.get("/api/projects/logs", (req, res) => {
  try {
    res.json(readProjectLauncherLogs(projectDir, {
      projectDir: req.query?.projectDir,
      projectId: req.query?.projectId,
      limit: req.query?.limit
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/projects/stop", asyncHandler(async (req, res) => {
  const result = await stopProjectInstance({
    controlProjectDir: projectDir,
    projectDir: req.body?.projectDir,
    projectId: req.body?.projectId,
    dryRun: req.body?.dryRun,
    execute: req.body?.execute,
    signal: req.body?.signal
  });
  if (result.stopped) {
    recordAndNotify({
      phase: "execute",
      title: "Launcher stopped project instance",
      status: "done",
      detail: result.project?.projectDir || result.project?.id,
      refs: [result.log?.path].filter(Boolean),
      files: [{ path: result.project?.projectDir || result.project?.id, status: "stopping", kind: "project" }]
    }, { reason: "project-stop" });
  }
  res.json(result);
}));

app.post("/api/projects/restart", asyncHandler(async (req, res) => {
  const result = await restartProjectInstance({
    appRoot,
    controlProjectDir: projectDir,
    projectDir: req.body?.projectDir,
    projectId: req.body?.projectId,
    currentPort: port,
    currentUiPort: uiPort,
    apiPort: req.body?.apiPort,
    uiPort: req.body?.uiPort,
    dryRun: req.body?.dryRun,
    execute: req.body?.execute
  });
  if (result.launched) {
    recordAndNotify({
      phase: "execute",
      title: "Launcher restarted project instance",
      status: "done",
      detail: result.launch?.url || result.launchPlan?.url,
      refs: [result.log?.path].filter(Boolean),
      files: [{ path: result.project?.projectDir, status: "restarted", kind: "project" }]
    }, { reason: "project-restart" });
  }
  res.json(result);
}));

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
    stateManifest: readStateManifest(projectDir) || continuity.stateManifest || null,
    takeoverSummary: readTakeoverSummary(projectDir) || continuity.takeoverSummary || null
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

app.get("/api/memory/inventory", (req, res) => {
  res.json(buildMemoryInventory(projectDir));
});

app.get("/api/memory/search", (req, res) => {
  res.json(searchMemory(projectDir, {
    query: req.query.query || req.query.q || "",
    type: req.query.type || undefined,
    file: req.query.file || undefined,
    folder: req.query.folder || undefined,
    sourceRef: req.query.sourceRef || undefined,
    concept: req.query.concept || undefined,
    goalId: req.query.goalId || undefined,
    fileType: req.query.fileType || undefined,
    minConfidence: req.query.minConfidence === undefined ? undefined : Number(req.query.minConfidence),
    sourceQuality: req.query.sourceQuality || undefined,
    latestOnly: req.query.latestOnly === undefined ? undefined : req.query.latestOnly === "true",
    useIndex: req.query.useIndex || req.query.index || undefined,
    limit: Number(req.query.limit || 10)
  }));
});

app.get("/api/memory/retention", (req, res) => {
  try {
    res.json(auditMemoryRetention(projectDir, {
      now: req.query.now || undefined,
      limit: Number(req.query.limit || 50),
      audit: req.query.audit === "true" || req.query.audit === "1"
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

function responseWithFreshManifest(result) {
  const stateManifest = writeStateManifest(projectDir, buildStateManifest(projectDir));
  return {
    ...result,
    refreshScheduled: true,
    stateManifest: {
      path: ".project-agent/state-manifest.json",
      aggregateHash: stateManifest.aggregateHash,
      fileCount: stateManifest.files?.length || stateManifest.fileCount || 0
    }
  };
}

app.get("/api/memory/index", (req, res) => {
  res.json(inspectMemorySearchIndex(projectDir));
});

app.post("/api/memory/index/rebuild", (req, res) => {
  try {
    res.json(responseWithFreshManifest(rebuildMemorySearchIndex(projectDir, req.body || {})));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/memory/entity-index", (req, res) => {
  res.json(inspectMemoryEntityIndex(projectDir));
});

app.post("/api/memory/entity-index/rebuild", (req, res) => {
  try {
    res.json(responseWithFreshManifest(rebuildMemoryEntityIndex(projectDir, req.body || {})));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/memory/vector-index", (req, res) => {
  res.json(inspectMemoryVectorIndex(projectDir));
});

app.post("/api/memory/vector-index/rebuild", (req, res) => {
  try {
    res.json(responseWithFreshManifest(rebuildMemoryVectorIndex(projectDir, req.body || {})));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/memory/harness", (req, res) => {
  try {
    res.json(buildMemoryHarness(projectDir, {
      query: req.query.query || req.query.q || undefined,
      goalId: req.query.goalId || undefined,
      type: req.query.type || undefined,
      file: req.query.file || undefined,
      folder: req.query.folder || undefined,
      sourceRef: req.query.sourceRef || undefined,
      concept: req.query.concept || undefined,
      fileType: req.query.fileType || undefined,
      sourceQuality: req.query.sourceQuality || undefined,
      latestOnly: req.query.latestOnly === undefined ? undefined : req.query.latestOnly === "true",
      useIndex: req.query.useIndex || req.query.index || undefined,
      limit: Number(req.query.limit || 6),
      maxReads: Number(req.query.maxReads ?? 3),
      candidateLimit: Number(req.query.candidateLimit || 5),
      eventLimit: req.query.eventLimit === undefined ? undefined : Number(req.query.eventLimit),
      retentionLimit: req.query.retentionLimit === undefined ? undefined : Number(req.query.retentionLimit),
      minConfidence: req.query.minConfidence === undefined ? undefined : Number(req.query.minConfidence),
      consolidate: req.query.consolidate === undefined ? undefined : req.query.consolidate !== "false",
      consolidationMode: req.query.consolidationMode || undefined
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/memory/consolidate", (req, res) => {
  try {
    res.json(consolidateMemory(projectDir, {
      mode: req.query.mode || "dryRun",
      dryRun: true,
      goalId: req.query.goalId || undefined,
      since: req.query.since || undefined,
      until: req.query.until || undefined,
      limit: Number(req.query.limit || 10),
      eventLimit: req.query.eventLimit === undefined ? undefined : Number(req.query.eventLimit),
      minConfidence: req.query.minConfidence === undefined ? undefined : Number(req.query.minConfidence)
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/memory/audit", (req, res) => {
  res.json(queryMemoryAudit(projectDir, {
    action: req.query.action || undefined,
    mode: req.query.mode || undefined,
    memoryId: req.query.memoryId || undefined,
    type: req.query.type || undefined,
    dryRun: req.query.dryRun === undefined ? undefined : req.query.dryRun === "true" || req.query.dryRun === "1",
    ref: req.query.ref || undefined,
    since: req.query.since || undefined,
    until: req.query.until || undefined,
    limit: Number(req.query.limit || 20)
  }));
});

app.get("/api/memory/read", (req, res) => {
  try {
    res.json(readMemory(projectDir, { id: req.query.id, ref: req.query.ref }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory", (req, res) => {
  try {
    const result = addMemory(projectDir, req.body || {});
    recordAndNotify({
      phase: "evidence",
      title: "Canonical memory added",
      status: "done",
      detail: result.record.title,
      refs: [result.ref, ...(result.record.sourceRefs || [])],
      files: [{ path: result.ref.split("#")[0], status: "modified", kind: "memory" }]
    }, { reason: "memory-add" });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/seed-dogfood", (req, res) => {
  try {
    const result = seedDogfoodMemory(projectDir, req.body || {});
    if (!result.dryRun && result.created?.length) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "audit",
        title: "Dogfood memory seeded",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, ...(result.created || []).map((record) => record.ref)].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-dogfood-seed" });
      autoHandoffSnapshot?.schedule("memory-dogfood-seed");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun && Boolean(result.created?.length)
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/update", (req, res) => {
  try {
    const result = updateMemory(projectDir, req.body || {});
    if (!result.dryRun) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "audit",
        title: "Canonical memory updated",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, result.ref].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-update" });
      autoHandoffSnapshot?.schedule("memory-update");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/supersede", (req, res) => {
  try {
    const result = supersedeMemory(projectDir, req.body || {});
    if (!result.dryRun) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "audit",
        title: "Canonical memory superseded",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, result.ref, result.oldRecord?.ref].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-supersede" });
      autoHandoffSnapshot?.schedule("memory-supersede");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/consolidate", (req, res) => {
  try {
    const result = consolidateMemory(projectDir, req.body || {});
    if (!result.dryRun) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "evidence",
        title: "Canonical memory consolidated",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, ...(result.created || []).map((record) => record.ref)].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-consolidate" });
      autoHandoffSnapshot?.schedule("memory-consolidate");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/retention/sweep", (req, res) => {
  try {
    const result = sweepMemoryRetention(projectDir, req.body || {});
    if (!result.dryRun) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "audit",
        title: "Memory retention sweep executed",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, ...(result.refs || [])].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-retention-sweep" });
      autoHandoffSnapshot?.schedule("memory-retention-sweep");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.post("/api/memory/forget", (req, res) => {
  try {
    const result = forgetMemory(projectDir, req.body || {});
    if (!result.dryRun) {
      writeStateManifest(projectDir, buildStateManifest(projectDir));
      recordAndNotify({
        phase: "audit",
        title: "Canonical memory forget executed",
        status: "done",
        detail: result.summary,
        refs: [result.auditRef, ...(result.plan?.canonicalRecords || []).map((record) => record.ref)].filter(Boolean),
        files: [{ path: ".project-agent/memory", status: "modified", kind: "memory" }]
      }, { reason: "memory-forget" });
      autoHandoffSnapshot?.schedule("memory-forget");
    }
    res.json({
      ...result,
      refreshScheduled: !result.dryRun
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/governance", (req, res) => {
  const continuity = readContinuity(projectDir) || {};
  const detail = readContinuityDetail(projectDir) || {};
  res.json({ governance: continuity.governance || detail.governance || null });
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

app.get("/api/state/export", (req, res) => {
  const bundle = buildStateExport(projectDir, {
    mode: req.query.mode || "portable",
    includeContents: req.query.contents !== "0" && req.query.contents !== "false"
  });
  if (req.query.download === "1" || req.query.download === "true") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="project-agent-state-${bundle.mode || "portable"}-${stamp}.json"`);
  }
  res.json(bundle);
});

app.post("/api/state/import", (req, res) => {
  try {
    const result = importStateExportBundle(projectDir, req.body || {});
    if (!result.dryRun && result.status === "ok") {
      recordAndNotify({
        phase: "audit",
        title: "Project state import executed",
        status: "done",
        detail: result.summary,
        refs: [".project-agent/state-manifest.json", ...result.written.slice(0, 8)],
        files: result.written.slice(0, 12).map((file) => ({ path: file, status: "modified", kind: "state" }))
      }, { reason: "state-import" });
      autoHandoffSnapshot?.schedule("state-import");
    }
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error), details: error.details || null });
  }
});

app.get("/api/agent-context-bundle", (req, res) => {
  if (req.query.write === "1" || req.query.write === "true") {
    const continuity = readContinuity(projectDir) || {};
    const stateManifest = readStateManifest(projectDir) || continuity.stateManifest || null;
    const bundle = writeAgentContextBundle(projectDir, buildAgentContextBundle(projectDir, continuity, {
      stateManifest,
      stateManifestVerification: verifyStateManifest(projectDir, stateManifest)
    }));
    const verification = verifyAgentContextBundle(projectDir, bundle);
    const takeoverSummary = writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, continuity, { bundle, verification }));
    res.json({ agentContextBundle: bundle, takeoverSummary, verification });
    return;
  }
  const agentContextBundle = readAgentContextBundle(projectDir) || null;
  res.json({ agentContextBundle, verification: verifyAgentContextBundle(projectDir, agentContextBundle) });
});

app.get("/api/takeover-summary", (req, res) => {
  const continuity = readContinuity(projectDir) || {};
  const bundle = readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity);
  const verification = verifyAgentContextBundle(projectDir, bundle);
  if (req.query.write === "1" || req.query.write === "true") {
    const takeoverSummary = writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, continuity, { bundle, verification }));
    res.json({ takeoverSummary, verification });
    return;
  }
  res.json({ takeoverSummary: readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, continuity, { bundle, verification }), verification });
});

app.get("/api/context-read", (req, res) => {
  try {
    res.json(readContextRef(projectDir, req.query.ref || "", {
      maxBytes: Number(req.query.maxBytes || 12000)
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

app.get("/api/context-search", (req, res) => {
  const query = req.query.query || req.query.q || defaultContextQuery(projectDir);
  res.json(searchContext(projectDir, {
    query,
    limit: Number(req.query.limit || 10),
    maxFiles: Number(req.query.maxFiles || 500),
    maxFileBytes: Number(req.query.maxFileBytes || 1024 * 1024),
    file: req.query.file || undefined,
    folder: req.query.folder || undefined,
    fileType: req.query.fileType || req.query.ext || undefined
  }));
});

app.get("/api/cli-agent-bootstrap", (req, res) => {
  const bootstrap = writeCliAgentBootstrap(projectDir, {
    appRoot,
    role: req.query.role || "coding_agent",
    query: req.query.query
  });
  res.json({
    ...bootstrap,
    bootstrapKit: buildAgentBootstrapKit(projectDir, { appRoot, bindHost, apiPort: port, uiPort }),
    command: buildCliAgentCommand(projectDir, { model: req.query.model }),
    codexCli: resolveCodexCli() || null
  });
});

app.get("/api/agent/bootstrap", (req, res) => {
  res.json(buildAgentBootstrapKit(projectDir, {
    appRoot,
    bindHost,
    apiPort: port,
    uiPort,
    provider: req.query.provider || undefined
  }));
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

app.get("/api/codex-takeover-smoke", (req, res) => {
  const smoke = readCodexTakeoverSmoke(projectDir);
  res.json({ smoke, file: smoke?.file || null });
});

app.post("/api/codex-takeover-smoke", (req, res) => {
  const result = runCodexTakeoverSmoke(projectDir, {
    runCodex: req.body?.noCodex ? false : req.body?.runCodex !== false,
    writeSummary: req.body?.write !== false,
    timeoutMs: Number(req.body?.timeoutMs || 120000)
  });
  broadcastAppEvent({ type: "runtime-event", reason: "codex-takeover-smoke", updatedAt: new Date().toISOString() });
  autoHandoffSnapshot?.schedule("codex-takeover-smoke");
  res.json({ smoke: result });
});

app.get("/api/graph-trace", (req, res) => {
  const continuity = readContinuity(projectDir) || {};
  const detail = readContinuityDetail(projectDir) || {};
  res.json({ graphTrace: continuity.graphTrace || detail.graphTrace || null });
});

app.get("/api/process-trace", (req, res) => {
  res.json({ processTrace: readProcessTrace(projectDir) || null });
});

app.get("/api/development-trail", (req, res) => {
  res.json({ developmentTrail: readDevelopmentTrail(projectDir) || null });
});

app.get("/api/architecture-trace", (req, res) => {
  const continuity = readContinuity(projectDir) || {};
  const detail = readContinuityDetail(projectDir) || {};
  res.json({ architectureTrace: continuity.architectureTrace || detail.architectureTrace || null });
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
      const goal = resolveReadableGoalId(summary, req.query.goal);
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
    const memoryStore = ensureMemoryStore(projectDir, { audit: true });
    const dogfoodSeed = seedDogfoodMemory(projectDir, { agentId: "api_init" });
    recordAndNotify({
      phase: "observe",
      title: "Project initialized",
      status: "done",
      detail: name,
      refs: ["PROJECT.md", ".project-agent/state.json", ".project-agent/memory/index.md"]
    });
    res.json({ output: result.stdout, state: currentSummary(), memoryStore, dogfoodSeed });
  })
);

app.get(
  "/api/kernel",
  asyncHandler(async (req, res) => {
    const summary = currentSummary();
    const role = req.query.role || "coding_agent";
    const goal = resolveReadableGoalId(summary, req.query.goal);
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
    const cleanOutput = (snapshot.output || "")
      .replace(/\x1b\[200~/g, "")
      .replace(/\x1b\[201~/g, "")
      .replace(/\[200~/g, "")
      .replace(/\[201~/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .trim();
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
  const auth = validateAuthRequest(request, authBoundary);
  if (!auth.ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Authentication required.\"}");
    socket.destroy();
    return;
  }
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

server.listen(port, bindHost, () => {
  console.log(`Project Agent Terminal server on http://${bindHost}:${port}`);
  console.log(`Project dir: ${projectDir}`);
});
