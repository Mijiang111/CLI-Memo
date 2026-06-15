import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildMemoryInventory } from "./memory-store.js";
import { readState, summarizeState } from "./project-agent.js";
import { readStateManifest, verifyStateManifest } from "./runtime-state.js";

const LAUNCHER_SCHEMA = "project-agent.project-launcher.v1";
const LAUNCH_PLAN_SCHEMA = "project-agent.project-launch-plan.v1";
const LAUNCH_CONTROL_SCHEMA = "project-agent.project-launch-control.v1";
const LAUNCH_LOGS_SCHEMA = "project-agent.project-launcher-logs.v1";
const LAUNCH_LOG_ENTRY_SCHEMA = "project-agent.project-launcher-log-entry.v1";
const REGISTRY_FILE = "project-launcher.json";
const LAUNCH_LOG_DIR = "launcher-logs";
const DEFAULT_API_PORT = 4147;
const DEFAULT_UI_PORT = 5174;
const MAX_MEMORY_LOGS = 30;
const MAX_PERSISTED_LOG_LINES = 200;
const MAX_RETURNED_LOG_LINES = 80;
const launched = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stateDir(projectDir) {
  return path.join(projectDir, ".project-agent");
}

function registryPath(projectDir) {
  return path.join(stateDir(projectDir), REGISTRY_FILE);
}

function launcherLogRef(id) {
  return `.project-agent/${LAUNCH_LOG_DIR}/${id}.jsonl`;
}

function launcherLogPath(controlProjectDir, id) {
  return path.join(stateDir(controlProjectDir), LAUNCH_LOG_DIR, `${id}.jsonl`);
}

function projectId(projectDir) {
  return `proj_${sha256(path.resolve(projectDir)).slice(0, 12)}`;
}

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readRegistry(projectDir) {
  const registry = readJson(registryPath(projectDir), null);
  if (!registry || registry.schemaVersion !== "project-agent.project-launcher-registry.v1") {
    return {
      schemaVersion: "project-agent.project-launcher-registry.v1",
      updatedAt: nowIso(),
      projects: []
    };
  }
  return {
    ...registry,
    projects: Array.isArray(registry.projects) ? registry.projects : []
  };
}

function writeRegistry(projectDir, registry) {
  const target = registryPath(projectDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const next = {
    schemaVersion: "project-agent.project-launcher-registry.v1",
    updatedAt: nowIso(),
    projects: dedupeProjects(registry.projects || [])
  };
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function dedupeProjects(projects = []) {
  const byPath = new Map();
  for (const project of projects) {
    const projectDir = path.resolve(project.projectDir || "");
    if (!projectDir) continue;
    byPath.set(projectDir, {
      id: project.id || projectId(projectDir),
      name: project.name || path.basename(projectDir),
      projectDir,
      addedAt: project.addedAt || nowIso(),
      lastSelectedAt: project.lastSelectedAt || null,
      source: project.source || "registered"
    });
  }
  return [...byPath.values()].sort((a, b) => String(b.lastSelectedAt || b.addedAt || "").localeCompare(String(a.lastSelectedAt || a.addedAt || "")));
}

function compact(value, max = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function compactLogText(value, max = 4000) {
  const text = String(value ?? "").replace(/\u0000/g, "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function projectMtime(projectDir) {
  const stats = safeCall(() => statSync(projectDir), null);
  return stats ? new Date(stats.mtimeMs).toISOString() : null;
}

function activeLaunchedProject(projectDir) {
  const id = projectId(projectDir);
  return activeLaunchedProjectById(id);
}

function activeLaunchedProjectById(id) {
  const item = launched.get(id);
  if (!item) return null;
  if (item.process.exitCode !== null) {
    launched.delete(id);
    return null;
  }
  return item;
}

function resolveLaunchedProject({ projectDir, projectId: inputProjectId } = {}) {
  const id = inputProjectId || (projectDir ? projectId(projectDir) : null);
  return id ? activeLaunchedProjectById(id) : null;
}

function readLogEntries(controlProjectDir, id, limit = MAX_RETURNED_LOG_LINES, { cap = MAX_RETURNED_LOG_LINES } = {}) {
  const target = launcherLogPath(controlProjectDir, id);
  if (!existsSync(target)) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_RETURNED_LOG_LINES, cap));
  return readFileSync(target, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeLogEntries(controlProjectDir, id, entries) {
  const target = launcherLogPath(controlProjectDir, id);
  mkdirSync(path.dirname(target), { recursive: true });
  const bounded = entries.slice(-MAX_PERSISTED_LOG_LINES);
  writeFileSync(target, `${bounded.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function appendLauncherLog(controlProjectDir, item, input = {}) {
  const id = item.id || projectId(item.projectDir);
  const entry = {
    schemaVersion: LAUNCH_LOG_ENTRY_SCHEMA,
    id,
    projectDir: item.projectDir,
    pid: item.process?.pid || input.pid || null,
    apiPort: item.apiPort || input.apiPort || null,
    uiPort: item.uiPort || input.uiPort || null,
    stream: input.stream || "lifecycle",
    event: input.event || null,
    text: compactLogText(input.text),
    at: input.at || nowIso()
  };
  const entries = [...readLogEntries(controlProjectDir, id, MAX_PERSISTED_LOG_LINES - 1, { cap: MAX_PERSISTED_LOG_LINES }), entry];
  writeLogEntries(controlProjectDir, id, entries);
  return entry;
}

function pushItemLog(item, entry) {
  item.logs.push(entry);
  if (item.logs.length > MAX_MEMORY_LOGS) item.logs.shift();
}

function launchedSummary(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    projectDir: item.projectDir,
    status: item.status || "running",
    pid: item.process?.pid || null,
    apiPort: item.apiPort,
    uiPort: item.uiPort,
    url: `http://127.0.0.1:${item.uiPort}`,
    startedAt: item.startedAt,
    log: {
      path: launcherLogRef(item.id),
      persistedLimit: MAX_PERSISTED_LOG_LINES
    }
  };
}

function projectLogSummary(controlProjectDir, id) {
  return {
    path: launcherLogRef(id),
    persisted: existsSync(launcherLogPath(controlProjectDir, id)),
    persistedLimit: MAX_PERSISTED_LOG_LINES
  };
}

function controlProjectDirFrom(options = {}) {
  return path.resolve(options.controlProjectDir || options.currentProjectDir || options.defaultProjectDir || options.projectDir || process.cwd());
}

function projectSummary(projectDir, options = {}) {
  const absProjectDir = path.resolve(projectDir);
  const id = projectId(absProjectDir);
  const controlProjectDir = path.resolve(options.controlProjectDir || options.currentProjectDir || absProjectDir);
  const statePath = path.join(absProjectDir, ".project-agent", "state.json");
  const initialized = existsSync(statePath);
  const state = safeCall(() => summarizeState(readState(absProjectDir)), null);
  const manifest = safeCall(() => readStateManifest(absProjectDir), null);
  const verification = manifest ? safeCall(() => verifyStateManifest(absProjectDir, manifest), null) : null;
  const memory = safeCall(() => buildMemoryInventory(absProjectDir), null);
  const running = activeLaunchedProject(absProjectDir);
  return {
    id,
    name: options.name || state?.project?.name || path.basename(absProjectDir),
    projectDir: absProjectDir,
    source: options.source || "registered",
    current: Boolean(options.current),
    exists: existsSync(absProjectDir),
    initialized,
    modifiedAt: projectMtime(absProjectDir),
    activeGoal: state?.activeGoal
      ? {
          id: state.activeGoal.id,
          status: state.activeGoal.status,
          objective: compact(state.activeGoal.objective, 180)
        }
      : null,
    counts: {
      goals: state?.goals?.length || 0,
      actions: state?.actions?.length || 0,
      memoryRecords: memory?.totals?.canonicalRecords || memory?.canonical?.records || 0,
      stateFiles: memory?.totals?.files || 0
    },
    health: {
      status: !existsSync(absProjectDir) ? "missing" : initialized ? verification?.status || "ok" : "not_started",
      manifestOk: verification ? Boolean(verification.ok) : !initialized,
      memoryStatus: memory?.status || "unknown"
    },
    log: projectLogSummary(controlProjectDir, id),
    running: running
      ? launchedSummary(running)
      : null
  };
}

function discoveredProjects({ appRoot, currentProjectDir, defaultProjectDir }) {
  return dedupeProjects([
    { projectDir: currentProjectDir, name: path.basename(currentProjectDir), source: "current", lastSelectedAt: nowIso() },
    { projectDir: defaultProjectDir, name: path.basename(defaultProjectDir), source: "default" },
    { projectDir: appRoot, name: path.basename(appRoot), source: "app-root" }
  ]);
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, host);
  });
}

async function findAvailablePort(start, avoid = new Set()) {
  for (let port = Number(start || DEFAULT_API_PORT); port < Number(start || DEFAULT_API_PORT) + 80; port += 1) {
    if (avoid.has(port)) continue;
    const open = await isPortOpen(port);
    if (!open) return port;
  }
  throw new Error(`No available port found near ${start}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function launchCommand(projectDir, apiPort, uiPort) {
  return `PROJECT_DIR=${shellQuote(projectDir)} PORT=${apiPort} VITE_API_PORT=${apiPort} VITE_PORT=${uiPort} npm run dev`;
}

export async function buildProjectLauncher({ appRoot, currentProjectDir, defaultProjectDir, currentPort = DEFAULT_API_PORT, currentUiPort = DEFAULT_UI_PORT } = {}) {
  const registry = readRegistry(currentProjectDir);
  const projects = dedupeProjects([
    ...discoveredProjects({ appRoot, currentProjectDir, defaultProjectDir }),
    ...(registry.projects || [])
  ]);
  return {
    schemaVersion: LAUNCHER_SCHEMA,
    status: "ok",
    checkedAt: nowIso(),
    boundary: {
      bindHost: "127.0.0.1",
      localOnly: true,
      auth: "not_enabled"
    },
    current: {
      projectDir: currentProjectDir,
      apiPort: Number(currentPort || DEFAULT_API_PORT),
      uiPort: Number(currentUiPort || DEFAULT_UI_PORT)
    },
    registry: {
      path: ".project-agent/project-launcher.json",
      count: registry.projects.length
    },
    logs: {
      dir: `.project-agent/${LAUNCH_LOG_DIR}`,
      persistedLimit: MAX_PERSISTED_LOG_LINES,
      returnedLimit: MAX_RETURNED_LOG_LINES
    },
    projects: projects.map((project) => projectSummary(project.projectDir, {
      name: project.name,
      source: project.source,
      controlProjectDir: currentProjectDir,
      current: path.resolve(project.projectDir) === path.resolve(currentProjectDir)
    })),
    running: [...launched.values()]
      .filter((item) => item.process.exitCode === null)
      .map((item) => launchedSummary(item))
  };
}

export function registerLauncherProject(currentProjectDir, input = {}) {
  if (!input.projectDir) {
    const error = new Error("projectDir is required");
    error.status = 400;
    throw error;
  }
  const targetDir = path.resolve(input.projectDir);
  if (input.create === true) mkdirSync(targetDir, { recursive: true });
  if (!existsSync(targetDir)) {
    const error = new Error(`Project directory does not exist: ${targetDir}`);
    error.status = 400;
    throw error;
  }
  const registry = readRegistry(currentProjectDir);
  const entry = {
    id: projectId(targetDir),
    name: input.name || path.basename(targetDir),
    projectDir: targetDir,
    addedAt: nowIso(),
    lastSelectedAt: nowIso(),
    source: "registered"
  };
  const next = writeRegistry(currentProjectDir, {
    ...registry,
    projects: [entry, ...(registry.projects || [])]
  });
  return {
    ok: true,
    entry,
    registry: {
      path: ".project-agent/project-launcher.json",
      count: next.projects.length
    },
    project: projectSummary(targetDir, { name: entry.name, source: entry.source, controlProjectDir: currentProjectDir })
  };
}

export async function buildLaunchPlan({ appRoot, controlProjectDir, projectDir, currentPort = DEFAULT_API_PORT, currentUiPort = DEFAULT_UI_PORT, apiPort, uiPort } = {}) {
  if (!projectDir) {
    const error = new Error("projectDir is required");
    error.status = 400;
    throw error;
  }
  const absProjectDir = path.resolve(projectDir);
  if (!existsSync(absProjectDir)) {
    const error = new Error(`Project directory does not exist: ${absProjectDir}`);
    error.status = 400;
    throw error;
  }
  const avoid = new Set([Number(currentPort || DEFAULT_API_PORT), Number(currentUiPort || DEFAULT_UI_PORT)]);
  const nextApiPort = apiPort ? Number(apiPort) : await findAvailablePort(Number(currentPort || DEFAULT_API_PORT) + 1, avoid);
  avoid.add(nextApiPort);
  const nextUiPort = uiPort ? Number(uiPort) : await findAvailablePort(Number(currentUiPort || DEFAULT_UI_PORT) + 1, avoid);
  return {
    schemaVersion: LAUNCH_PLAN_SCHEMA,
    status: "ready",
    generatedAt: nowIso(),
    project: projectSummary(absProjectDir, { controlProjectDir }),
    localOnly: true,
    bindHost: "127.0.0.1",
    apiPort: nextApiPort,
    uiPort: nextUiPort,
    url: `http://127.0.0.1:${nextUiPort}`,
    command: launchCommand(absProjectDir, nextApiPort, nextUiPort),
    env: {
      PROJECT_DIR: absProjectDir,
      PORT: String(nextApiPort),
      VITE_API_PORT: String(nextApiPort),
      VITE_PORT: String(nextUiPort)
    },
    cwd: appRoot,
    nextAction: "Launch will start a separate local Project Agent Terminal instance for this project."
  };
}

export async function launchProjectInstance(options = {}) {
  const plan = await buildLaunchPlan(options);
  if (options.dryRun !== false && options.execute !== true) {
    return {
      ...plan,
      dryRun: true,
      launched: false
    };
  }
  const command = options.command || "npm";
  const args = Array.isArray(options.args) ? options.args : ["run", "dev"];
  const controlProjectDir = controlProjectDirFrom(options);
  const child = spawn(command, args, {
    cwd: options.appRoot,
    env: {
      ...process.env,
      PROJECT_DIR: plan.env.PROJECT_DIR,
      PORT: plan.env.PORT,
      VITE_API_PORT: plan.env.VITE_API_PORT,
      VITE_PORT: plan.env.VITE_PORT
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const item = {
    id: plan.project.id,
    name: plan.project.name,
    projectDir: plan.project.projectDir,
    apiPort: plan.apiPort,
    uiPort: plan.uiPort,
    startedAt: nowIso(),
    status: "launching",
    controlProjectDir,
    process: child,
    logs: []
  };
  launched.set(item.id, item);
  const recordLog = (stream, text, event = null) => {
    const entry = appendLauncherLog(controlProjectDir, item, { stream, text, event });
    pushItemLog(item, entry);
  };
  recordLog("lifecycle", `Started ${command} ${args.join(" ")} for ${item.projectDir}`, "start");
  child.stdout.on("data", (chunk) => recordLog("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => recordLog("stderr", chunk.toString()));
  child.once("error", (error) => {
    item.status = "error";
    recordLog("stderr", error.message || String(error), "spawn_error");
  });
  child.on("close", (code, signal) => {
    item.status = "exited";
    item.exitedAt = nowIso();
    item.exitCode = code;
    item.signal = signal;
    recordLog("lifecycle", `Process exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}`, "exit");
    setTimeout(() => launched.delete(item.id), 2000);
  });
  return {
    ...plan,
    dryRun: false,
    launched: true,
    pid: child.pid,
    logs: item.logs,
    log: projectLogSummary(controlProjectDir, item.id),
    status: "launching"
  };
}

export function readProjectLauncherLogs(controlProjectDir, input = {}) {
  const controlDir = path.resolve(controlProjectDir);
  const absProjectDir = input.projectDir ? path.resolve(input.projectDir) : null;
  const id = input.projectId || (absProjectDir ? projectId(absProjectDir) : null);
  if (!id) {
    const error = new Error("projectDir or projectId is required");
    error.status = 400;
    throw error;
  }
  const entries = readLogEntries(controlDir, id, input.limit);
  const running = resolveLaunchedProject({ projectDir: absProjectDir, projectId: id });
  return {
    schemaVersion: LAUNCH_LOGS_SCHEMA,
    status: entries.length ? "ok" : "empty",
    checkedAt: nowIso(),
    project: absProjectDir
      ? projectSummary(absProjectDir, { controlProjectDir: controlDir })
      : {
          id,
          projectDir: running?.projectDir || null,
          name: running?.name || id
        },
    log: {
      path: launcherLogRef(id),
      persisted: existsSync(launcherLogPath(controlDir, id)),
      persistedLimit: MAX_PERSISTED_LOG_LINES,
      returnedLimit: MAX_RETURNED_LOG_LINES
    },
    running: launchedSummary(running),
    counts: {
      returned: entries.length
    },
    entries
  };
}

export async function stopProjectInstance(options = {}) {
  const controlDir = controlProjectDirFrom(options);
  const absProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  const id = options.projectId || (absProjectDir ? projectId(absProjectDir) : null);
  if (!id) {
    const error = new Error("projectDir or projectId is required");
    error.status = 400;
    throw error;
  }
  const dryRun = options.dryRun !== false && options.execute !== true;
  const item = resolveLaunchedProject({ projectDir: absProjectDir, projectId: id });
  const project = absProjectDir
    ? projectSummary(absProjectDir, { controlProjectDir: controlDir })
    : {
        id,
        projectDir: item?.projectDir || null,
        name: item?.name || id
      };
  if (!item) {
    return {
      schemaVersion: LAUNCH_CONTROL_SCHEMA,
      action: "stop",
      status: "not_running",
      dryRun,
      stopped: false,
      checkedAt: nowIso(),
      project,
      log: projectLogSummary(controlDir, id)
    };
  }
  if (dryRun) {
    return {
      schemaVersion: LAUNCH_CONTROL_SCHEMA,
      action: "stop",
      status: "would_stop",
      dryRun: true,
      stopped: false,
      checkedAt: nowIso(),
      project,
      running: launchedSummary(item),
      log: projectLogSummary(controlDir, id)
    };
  }
  const signal = options.signal || "SIGTERM";
  item.status = "stopping";
  const entry = appendLauncherLog(controlDir, item, {
    stream: "lifecycle",
    event: "stop_requested",
    text: `Stop requested with ${signal}`
  });
  pushItemLog(item, entry);
  const killed = item.process.exitCode === null ? item.process.kill(signal) : false;
  return {
    schemaVersion: LAUNCH_CONTROL_SCHEMA,
    action: "stop",
    status: killed ? "stopping" : "not_running",
    dryRun: false,
    stopped: killed,
    signal,
    checkedAt: nowIso(),
    project,
    running: launchedSummary(item),
    log: projectLogSummary(controlDir, id)
  };
}

function waitForProcessClose(item, timeoutMs = 2500) {
  if (!item || item.process.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    item.process.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function restartProjectInstance(options = {}) {
  const controlDir = controlProjectDirFrom(options);
  const absProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  const id = options.projectId || (absProjectDir ? projectId(absProjectDir) : null);
  if (!id && !absProjectDir) {
    const error = new Error("projectDir or projectId is required");
    error.status = 400;
    throw error;
  }
  const item = resolveLaunchedProject({ projectDir: absProjectDir, projectId: id });
  const targetProjectDir = absProjectDir || item?.projectDir;
  if (!targetProjectDir) {
    const error = new Error("projectDir is required when the project is not running");
    error.status = 400;
    throw error;
  }
  const dryRun = options.dryRun !== false && options.execute !== true;
  const launchPlan = await buildLaunchPlan({
    ...options,
    controlProjectDir: controlDir,
    projectDir: targetProjectDir,
    apiPort: options.apiPort || item?.apiPort,
    uiPort: options.uiPort || item?.uiPort
  });
  const base = {
    schemaVersion: LAUNCH_CONTROL_SCHEMA,
    action: "restart",
    dryRun,
    checkedAt: nowIso(),
    project: launchPlan.project,
    running: launchedSummary(item),
    log: projectLogSummary(controlDir, launchPlan.project.id),
    launchPlan
  };
  if (dryRun) {
    return {
      ...base,
      status: item ? "would_restart" : "would_start",
      stopped: false,
      launched: false
    };
  }
  let stopped = false;
  let exited = true;
  if (item) {
    const stopResult = await stopProjectInstance({
      controlProjectDir: controlDir,
      projectDir: targetProjectDir,
      dryRun: false,
      execute: true
    });
    stopped = Boolean(stopResult.stopped);
    exited = await waitForProcessClose(item);
  }
  const launchResult = await launchProjectInstance({
    ...options,
    controlProjectDir: controlDir,
    projectDir: targetProjectDir,
    apiPort: exited ? launchPlan.apiPort : options.apiPort,
    uiPort: exited ? launchPlan.uiPort : options.uiPort,
    dryRun: false,
    execute: true
  });
  return {
    ...base,
    status: launchResult.launched ? "restarting" : "failed",
    dryRun: false,
    stopped,
    stopWaitedForExit: exited,
    launched: Boolean(launchResult.launched),
    launch: launchResult,
    running: launchedSummary(resolveLaunchedProject({ projectDir: targetProjectDir }))
  };
}
