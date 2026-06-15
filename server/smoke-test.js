import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { publicAuthBoundary, resolveAuthBoundary, validateAuthRequest } from "./auth-boundary.js";
import { launchProjectInstance, readProjectLauncherLogs, stopProjectInstance } from "./project-launcher.js";

const port = Number(process.env.PORT || (4200 + Math.floor(Math.random() * 1000)));
const base = `http://127.0.0.1:${port}`;
const ownsProjectDir = !process.env.PROJECT_DIR;
const projectDir = process.env.PROJECT_DIR || mkdtempSync(path.join(os.tmpdir(), "project-agent-terminal-smoke-"));
const gitSmokeInitialized = ownsProjectDir && spawnSync("git", ["init"], { cwd: projectDir, encoding: "utf8" }).status === 0;

const authSmokeToken = "smoke-auth-token-123456";
const localAuthBoundary = resolveAuthBoundary({ env: {} });
if (localAuthBoundary.effective.bindHost !== "127.0.0.1" || localAuthBoundary.auth.required !== false || localAuthBoundary.auth.mode !== "not_enabled") {
  throw new Error(`local auth boundary should default to local/no-auth: ${JSON.stringify(publicAuthBoundary(localAuthBoundary))}`);
}
const blockedRemoteBoundary = resolveAuthBoundary({ env: { PROJECT_AGENT_BIND_HOST: "0.0.0.0" } });
if (blockedRemoteBoundary.status !== "blocked" || blockedRemoteBoundary.effective.bindHost !== "127.0.0.1" || blockedRemoteBoundary.effective.remoteAccess !== "blocked_by_auth_guard") {
  throw new Error(`remote bind without opt-in/token should stay local and blocked: ${JSON.stringify(publicAuthBoundary(blockedRemoteBoundary))}`);
}
const readyRemoteBoundary = resolveAuthBoundary({ env: { PROJECT_AGENT_BIND_HOST: "0.0.0.0", PROJECT_AGENT_REMOTE: "1", PROJECT_AGENT_AUTH_TOKEN: authSmokeToken } });
if (readyRemoteBoundary.status !== "watch" || readyRemoteBoundary.effective.bindHost !== "0.0.0.0" || readyRemoteBoundary.auth.required !== true || readyRemoteBoundary.auth.mode !== "bearer_token") {
  throw new Error(`remote auth boundary should enable token auth: ${JSON.stringify(publicAuthBoundary(readyRemoteBoundary))}`);
}
if (!validateAuthRequest({ headers: { authorization: `Bearer ${authSmokeToken}` }, url: "/api/health" }, readyRemoteBoundary).ok || validateAuthRequest({ headers: {}, url: "/api/health" }, readyRemoteBoundary).ok) {
  throw new Error("auth request validator did not accept bearer token and reject missing token");
}
if (JSON.stringify(publicAuthBoundary(readyRemoteBoundary)).includes(authSmokeToken) || JSON.stringify(readyRemoteBoundary).includes(authSmokeToken)) {
  throw new Error("auth boundary leaked raw token through JSON serialization");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error("server did not start");
}

async function waitForUrl(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`server did not start for ${url}`);
}

async function remoteAuthServerSmoke() {
  const remotePort = port + 1000;
  const remoteProjectDir = mkdtempSync(path.join(os.tmpdir(), "project-agent-terminal-remote-auth-"));
  const remoteBase = `http://127.0.0.1:${remotePort}`;
  const remoteChild = spawn("node", ["server/index.js"], {
    env: {
      ...process.env,
      PROJECT_DIR: remoteProjectDir,
      PORT: String(remotePort),
      PROJECT_AGENT_BIND_HOST: "0.0.0.0",
      PROJECT_AGENT_REMOTE: "1",
      PROJECT_AGENT_AUTH_TOKEN: authSmokeToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  remoteChild.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForUrl(`${remoteBase}/api/security/auth`);
    const authStatus = await fetch(`${remoteBase}/api/security/auth`).then((res) => res.json());
    if (authStatus.effective?.bindHost !== "0.0.0.0" || authStatus.auth?.required !== true || authStatus.auth?.mode !== "bearer_token" || JSON.stringify(authStatus).includes(authSmokeToken)) {
      throw new Error(`remote auth status did not expose safe bearer-token readiness: ${JSON.stringify(authStatus)}`);
    }
    const unauthenticated = await fetch(`${remoteBase}/api/health`);
    if (unauthenticated.status !== 401) {
      throw new Error(`remote health should require auth, got ${unauthenticated.status}: ${await unauthenticated.text()}`);
    }
    const authenticated = await fetch(`${remoteBase}/api/health`, {
      headers: { Authorization: `Bearer ${authSmokeToken}` }
    });
    if (!authenticated.ok) throw new Error(`remote health bearer token failed ${authenticated.status}: ${await authenticated.text()}`);
    const health = await authenticated.json();
    if (health.server?.bindHost !== "0.0.0.0" || health.security?.authRequired !== true || health.security?.auth !== "bearer_token" || health.security?.remoteAccess !== "enabled_with_bearer_token") {
      throw new Error(`remote authenticated health missing auth boundary: ${JSON.stringify(health.security)}`);
    }
  } finally {
    remoteChild.kill();
    await Promise.race([
      new Promise((resolve) => remoteChild.once("close", resolve)),
      wait(1000)
    ]);
    rmSync(remoteProjectDir, { recursive: true, force: true });
  }
}

await remoteAuthServerSmoke();

async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

function terminalSmoke(goalId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`);
    let transcript = "";
    let captured = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`terminal did not echo command output. Transcript: ${transcript.slice(-500)}`));
    }, 5000);

    ws.on("open", () => {
      setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "echo WS_SMOKE\r" })), 250);
    });
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "output") transcript += msg.data;
      if (!captured && transcript.includes("WS_SMOKE")) {
        captured = true;
        clearTimeout(timer);
        ws.close();
        try {
          await post("/api/evidence/last-command", {
            goalId,
            summary: "Terminal command output can be captured",
            verifies: ["ac_1"]
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runtimeEventSocketSmoke() {
  return new Promise((resolve, reject) => {
    const watchedRelPath = `docs/product/live-watch-${Date.now()}.md`;
    const watchedAbsPath = path.join(projectDir, watchedRelPath);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
    let wroteFile = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`runtime event socket did not announce architecture change for ${watchedRelPath}`));
    }, 7000);

    ws.on("open", () => {
      setTimeout(() => {
        wroteFile = true;
        writeFileSync(watchedAbsPath, "# Live Watch Smoke\n\nArchitecture watcher should detect this file.\n", "utf8");
      }, 150);
    });
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!wroteFile || !["runtime-event", "runtime-events"].includes(msg.type)) return;
      try {
        const runtime = await get("/api/events");
        const matched = runtime.events?.some((event) => event.files?.some((file) => file.path === watchedRelPath));
        if (!matched) return;
        clearTimeout(timer);
        ws.close();
        resolve(watchedRelPath);
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function mcpPayload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text || "{}";
  return JSON.parse(text);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function mcpCall(projectDir, name, args = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server/project-mcp.js", "--project-dir", projectDir],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "project-agent-terminal-smoke-call", version: "0.1.0" });
  try {
    await client.connect(transport);
    return mcpPayload(await client.callTool({ name, arguments: args }));
  } catch (error) {
    throw new Error(`${error.message || String(error)}${stderr ? `\nMCP call stderr:\n${stderr}` : ""}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function mcpSmoke(goalId) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server/project-mcp.js", "--project-dir", projectDir],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "project-agent-terminal-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    const toolNames = new Set((toolList.tools || []).map((tool) => tool.name));
    for (const name of [
      "project_start",
      "project_takeover_summary",
      "project_context_search",
      "project_read_ref",
      "project_record_event",
      "project_architecture_changes",
      "project_handoff_audit",
      "project_memory_inventory",
      "project_memory_seed_dogfood",
      "project_memory_add",
      "project_memory_read",
      "project_memory_update",
      "project_memory_supersede",
      "project_memory_search",
      "project_memory_rebuild_index",
      "project_memory_rebuild_entity_index",
      "project_memory_rebuild_vector_index",
      "project_memory_forget",
      "project_memory_retention_audit",
      "project_memory_retention_sweep",
      "project_memory_harness",
      "project_memory_consolidate",
      "project_memory_audit"
    ]) {
      if (!toolNames.has(name)) throw new Error(`MCP tool missing: ${name}`);
    }

    const summary = mcpPayload(await client.callTool({ name: "project_takeover_summary", arguments: {} }));
    if (summary.takeoverSummary?.schemaVersion !== "project-agent.takeover-summary.v1" || !summary.verification?.canResume) {
      throw new Error(`MCP takeover summary failed: ${JSON.stringify(summary)}`);
    }

    const search = mcpPayload(await client.callTool({
      name: "project_context_search",
      arguments: { query: "Smoke test Project Agent Terminal", limit: 5 }
    }));
    if (search.mode !== "grep-first" || !search.results?.length) {
      throw new Error(`MCP context search failed: ${JSON.stringify(search)}`);
    }
    const scopedContextSearch = mcpPayload(await client.callTool({
      name: "project_context_search",
      arguments: { query: "project-agent", folder: ".project-agent", fileType: "json", limit: 5 }
    }));
    if (scopedContextSearch.filters?.folder !== ".project-agent" || scopedContextSearch.filters?.fileType !== "json" || !scopedContextSearch.results?.length || !scopedContextSearch.results.every((item) => item.file.startsWith(".project-agent/") && item.file.endsWith(".json"))) {
      throw new Error(`MCP context search filters failed: ${JSON.stringify(scopedContextSearch)}`);
    }

    const read = mcpPayload(await client.callTool({
      name: "project_read_ref",
      arguments: { ref: ".project-agent/takeover-summary.json#schemaVersion", maxBytes: 2000 }
    }));
    if (read.value !== "project-agent.takeover-summary.v1") {
      throw new Error(`MCP read ref failed: ${JSON.stringify(read)}`);
    }

    const architecture = mcpPayload(await client.callTool({
      name: "project_architecture_changes",
      arguments: { limit: 5, persist: false }
    }));
    if (!architecture.totals?.files || !Array.isArray(architecture.recentChanges)) {
      throw new Error(`MCP architecture changes failed: ${JSON.stringify(architecture)}`);
    }

    const audit = mcpPayload(await client.callTool({ name: "project_handoff_audit", arguments: {} }));
    if (!audit.verification?.canResume || !audit.manifest?.status) {
      throw new Error(`MCP handoff audit failed: ${JSON.stringify(audit)}`);
    }

    const event = mcpPayload(await client.callTool({
      name: "project_record_event",
      arguments: {
        phase: "plan",
        status: "done",
        title: "MCP smoke event",
        detail: "MCP server can record project process events",
        refs: ["mcp-smoke"],
        goalId,
        agentId: "mcp-smoke"
      }
    }));
    if (!event.ok || event.accepted < 1) {
      throw new Error(`MCP record event failed: ${JSON.stringify(event)}`);
    }

    const decisionEvent = mcpPayload(await client.callTool({
      name: "project_record_event",
      arguments: {
        phase: "plan",
        status: "done",
        title: "Decision: Consolidation smoke keeps runtime decisions durable",
        detail: "Decision: project_memory_consolidate should promote this runtime decision into canonical memory. CONSO_DECISION_SMOKE",
        refs: ["mcp-consolidate-decision"],
        goalId,
        agentId: "mcp-smoke"
      }
    }));
    const procedureEvent = mcpPayload(await client.callTool({
      name: "project_record_event",
      arguments: {
        phase: "execute",
        status: "done",
        title: "Procedure: Run consolidation smoke workflow",
        detail: "Procedure: run project_memory_consolidate after runtime evidence to create durable memory. CONSO_PROCEDURE_SMOKE",
        refs: ["mcp-consolidate-procedure"],
        goalId,
        agentId: "mcp-smoke"
      }
    }));
    if (!decisionEvent.ok || !procedureEvent.ok) {
      throw new Error(`MCP consolidation seed events failed: ${JSON.stringify({ decisionEvent, procedureEvent })}`);
    }

    mkdirSync(path.join(projectDir, "docs", "research"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "docs", "research", "memory-gap-deep-benchmark.md"),
      "# Memory Gap Deep Benchmark\n\nP0 lifecycle requires dogfood seed, update, supersede, and retention audit/sweep. DOGFOOD_SEED_SMOKE\n",
      "utf8"
    );

    const inventory = mcpPayload(await client.callTool({ name: "project_memory_inventory", arguments: {} }));
    if (!["ok", "warn"].includes(inventory.status) || !inventory.canonical?.exists || !inventory.files?.some((file) => file.ref === ".project-agent/memory/facts.jsonl" && file.class === "source")) {
      throw new Error(`MCP memory inventory failed: ${JSON.stringify(inventory)}`);
    }
    if (inventory.lifecycle?.dogfood?.status !== "empty" || !inventory.lifecycle?.tools?.includes("project_memory_update") || !inventory.lifecycle?.tools?.includes("project_memory_retention_sweep")) {
      throw new Error(`MCP memory inventory missing lifecycle P0 status/tools: ${JSON.stringify(inventory.lifecycle)}`);
    }

    const dogfoodSeed = mcpPayload(await client.callTool({
      name: "project_memory_seed_dogfood",
      arguments: { dryRun: false, goalId, agentId: "mcp-smoke" }
    }));
    if (!dogfoodSeed.created?.length || dogfoodSeed.plan?.status !== "seeded" || !dogfoodSeed.auditRef || !dogfoodSeed.refreshed) {
      throw new Error(`MCP dogfood seed failed: ${JSON.stringify(dogfoodSeed)}`);
    }

    const dogfoodSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "grep-first canonical memory source truth", concept: "dogfood-seed", limit: 5 }
    }));
    if (!dogfoodSearch.results?.some((item) => item.id === "mem_dogfood_grep_first_source_truth")) {
      throw new Error(`MCP dogfood seed should be searchable: ${JSON.stringify(dogfoodSearch)}`);
    }

    const dogfoodIdempotent = mcpPayload(await client.callTool({
      name: "project_memory_seed_dogfood",
      arguments: { dryRun: false, goalId, agentId: "mcp-smoke" }
    }));
    if (dogfoodIdempotent.created?.length || dogfoodIdempotent.status !== "seeded") {
      throw new Error(`MCP dogfood seed should be idempotent: ${JSON.stringify(dogfoodIdempotent)}`);
    }

    const consolidationPreview = mcpPayload(await client.callTool({
      name: "project_memory_consolidate",
      arguments: { mode: "goal", goalId, dryRun: true, limit: 10 }
    }));
    if (consolidationPreview.status !== "dry_run" || !consolidationPreview.candidates?.some((item) => item.content?.includes("CONSO_DECISION_SMOKE") && item.status === "ready") || !consolidationPreview.candidates?.some((item) => item.content?.includes("CONSO_PROCEDURE_SMOKE") && item.status === "ready")) {
      throw new Error(`MCP memory consolidate preview failed: ${JSON.stringify(consolidationPreview)}`);
    }

    const consolidationExecution = mcpPayload(await client.callTool({
      name: "project_memory_consolidate",
      arguments: { mode: "goal", goalId, dryRun: false, limit: 10 }
    }));
    if (consolidationExecution.dryRun || consolidationExecution.created?.length < 2 || !consolidationExecution.auditRef || !consolidationExecution.refreshed) {
      throw new Error(`MCP memory consolidate execution failed: ${JSON.stringify(consolidationExecution)}`);
    }

    const consolidationDecisionSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "CONSO_DECISION_SMOKE", limit: 5 }
    }));
    if (!consolidationDecisionSearch.results?.some((item) => item.type === "decision" && item.snippet.includes("CONSO_DECISION_SMOKE"))) {
      throw new Error(`MCP consolidated decision is not searchable: ${JSON.stringify(consolidationDecisionSearch)}`);
    }

    const consolidationProcedureSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "CONSO_PROCEDURE_SMOKE", limit: 5 }
    }));
    if (!consolidationProcedureSearch.results?.some((item) => item.type === "procedure" && item.snippet.includes("CONSO_PROCEDURE_SMOKE"))) {
      throw new Error(`MCP consolidated procedure is not searchable: ${JSON.stringify(consolidationProcedureSearch)}`);
    }

    const memoryHarness = mcpPayload(await client.callTool({
      name: "project_memory_harness",
      arguments: { query: "CONSO_DECISION_SMOKE CONSO_PROCEDURE_SMOKE", limit: 6, maxReads: 3, candidateLimit: 5 }
    }));
    if (memoryHarness.schemaVersion !== "project-agent.memory-harness.v1" || !memoryHarness.automatic || !memoryHarness.appliedCalls?.some((call) => call.tool === "project_memory_search") || !memoryHarness.appliedCalls?.some((call) => call.tool === "project_memory_read") || !memoryHarness.autoReads?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE"))) {
      throw new Error(`MCP memory harness did not auto route search/read: ${JSON.stringify(memoryHarness)}`);
    }

    const takeoverWithHarness = mcpPayload(await client.callTool({
      name: "project_takeover_summary",
      arguments: { refresh: false }
    }));
    if (takeoverWithHarness.memoryHarness?.schemaVersion !== "project-agent.memory-harness.v1" || !takeoverWithHarness.memoryHarness?.appliedCalls?.some((call) => call.tool === "project_memory_search")) {
      throw new Error(`MCP takeover summary should include automatic memory harness: ${JSON.stringify(takeoverWithHarness.memoryHarness)}`);
    }

    const consolidationAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_consolidated", ref: consolidationExecution.created[0]?.ref, limit: 5 }
    }));
    if (!consolidationAudit.entries?.some((item) => item.action === "memory_consolidated" && item.created?.some((created) => created.ref === consolidationExecution.created[0]?.ref))) {
      throw new Error(`MCP memory audit did not capture consolidation: ${JSON.stringify(consolidationAudit)}`);
    }

    const consolidationIdempotent = mcpPayload(await client.callTool({
      name: "project_memory_consolidate",
      arguments: { mode: "manual", candidateIds: [consolidationExecution.created[0].candidateId], dryRun: false, limit: 10 }
    }));
    if (consolidationIdempotent.created?.length || !consolidationIdempotent.skipped?.some((item) => item.status === "duplicate")) {
      throw new Error(`MCP memory consolidate should be idempotent for existing candidates: ${JSON.stringify(consolidationIdempotent)}`);
    }

    const addedMemory = mcpPayload(await client.callTool({
      name: "project_memory_add",
      arguments: {
        type: "procedure",
        title: "Run API tests with local Redis",
        content: "API tests require local Redis before running the integration suite.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        files: ["docs/quality/test-strategy.md"],
        concepts: ["testing", "redis", "memory"],
        goalId,
        importance: 8,
        confidence: 0.9
      }
    }));
    if (!addedMemory.ok || !addedMemory.ref?.startsWith(".project-agent/memory/procedures.jsonl#")) {
      throw new Error(`MCP memory add failed: ${JSON.stringify(addedMemory)}`);
    }

    const addedAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_added", memoryId: addedMemory.record.id, limit: 5 }
    }));
    if (!["ok", "warn"].includes(addedAudit.status) || !addedAudit.entries?.some((item) => item.memoryId === addedMemory.record.id && item.refs?.includes(addedMemory.ref))) {
      throw new Error(`MCP memory audit did not capture add: ${JSON.stringify(addedAudit)}`);
    }

    const readMemory = mcpPayload(await client.callTool({
      name: "project_memory_read",
      arguments: { ref: addedMemory.ref }
    }));
    if (readMemory.record?.title !== "Run API tests with local Redis" || !readMemory.sourceRefs?.length) {
      throw new Error(`MCP memory read failed: ${JSON.stringify(readMemory)}`);
    }

    const searchMemory = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", limit: 5 }
    }));
    if (searchMemory.mode !== "grep-first-canonical-memory" || !searchMemory.results?.some((item) => item.id === addedMemory.record.id && item.refs?.includes(addedMemory.ref))) {
      throw new Error(`MCP memory search failed: ${JSON.stringify(searchMemory)}`);
    }
    const filteredMemorySearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: {
        query: "Redis integration suite",
        type: "procedure",
        folder: "docs/quality",
        fileType: "md",
        concept: "testing",
        sourceQuality: "strong",
        minConfidence: 0.8,
        limit: 5
      }
    }));
    const filteredHit = filteredMemorySearch.results?.find((item) => item.id === addedMemory.record.id);
    if (!filteredHit || filteredMemorySearch.filters?.folder !== "docs/quality" || filteredMemorySearch.filters?.fileType !== "md" || filteredHit.sourceQuality?.status !== "strong" || filteredHit.scoreBreakdown?.filterMatch < 10 || filteredMemorySearch.ranking?.deterministic !== true) {
      throw new Error(`MCP memory search filters/ranking failed: ${JSON.stringify(filteredMemorySearch)}`);
    }

    const rebuiltIndex = mcpPayload(await client.callTool({
      name: "project_memory_rebuild_index",
      arguments: {}
    }));
    if (rebuiltIndex.schemaVersion !== "project-agent.memory-search-index-rebuild.v1" || rebuiltIndex.index?.status !== "fresh" || rebuiltIndex.index?.sourceRecords < 1 || !rebuiltIndex.auditRef) {
      throw new Error(`MCP memory index rebuild failed: ${JSON.stringify(rebuiltIndex)}`);
    }

    const indexedMemorySearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", useIndex: "bm25", limit: 5 }
    }));
    const indexedHit = indexedMemorySearch.results?.find((item) => item.id === addedMemory.record.id);
    if (!indexedHit || indexedMemorySearch.ranking?.optionalIndexes?.bm25?.used !== true || !indexedHit.scoreBreakdown?.bm25) {
      throw new Error(`MCP memory BM25 indexed search failed: ${JSON.stringify(indexedMemorySearch)}`);
    }

    const rebuiltEntityIndex = mcpPayload(await client.callTool({
      name: "project_memory_rebuild_entity_index",
      arguments: {}
    }));
    if (rebuiltEntityIndex.schemaVersion !== "project-agent.memory-entity-index-rebuild.v1" || rebuiltEntityIndex.index?.status !== "fresh" || rebuiltEntityIndex.index?.statistics?.entityCount < 1 || !rebuiltEntityIndex.auditRef) {
      throw new Error(`MCP memory entity index rebuild failed: ${JSON.stringify(rebuiltEntityIndex)}`);
    }

    const entityMemorySearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", useIndex: "entity", folder: "docs/quality", concept: "redis", limit: 5 }
    }));
    const entityHit = entityMemorySearch.results?.find((item) => item.id === addedMemory.record.id);
    if (!entityHit || entityMemorySearch.ranking?.optionalIndexes?.entity?.used !== true || !entityHit.scoreBreakdown?.entity || !entityMemorySearch.ranking?.optionalIndexes?.entity?.matched?.length) {
      throw new Error(`MCP memory entity indexed search failed: ${JSON.stringify(entityMemorySearch)}`);
    }

    const rebuiltVectorIndex = mcpPayload(await client.callTool({
      name: "project_memory_rebuild_vector_index",
      arguments: {}
    }));
    if (rebuiltVectorIndex.schemaVersion !== "project-agent.memory-vector-index-rebuild.v1" || rebuiltVectorIndex.index?.status !== "fresh" || rebuiltVectorIndex.index?.statistics?.dimensions < 1 || rebuiltVectorIndex.index?.embeddingProvider !== "none" || !rebuiltVectorIndex.auditRef) {
      throw new Error(`MCP memory vector index rebuild failed: ${JSON.stringify(rebuiltVectorIndex)}`);
    }

    const vectorMemorySearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", useIndex: "vector", limit: 5 }
    }));
    const vectorHit = vectorMemorySearch.results?.find((item) => item.id === addedMemory.record.id);
    if (!vectorHit || vectorMemorySearch.ranking?.optionalIndexes?.vector?.used !== true || vectorMemorySearch.ranking?.optionalIndexes?.vector?.embeddingProvider !== "none" || !vectorHit.scoreBreakdown?.vector) {
      throw new Error(`MCP memory vector indexed search failed: ${JSON.stringify(vectorMemorySearch)}`);
    }

    const indexedHarness = mcpPayload(await client.callTool({
      name: "project_memory_harness",
      arguments: {
        query: "Redis integration suite",
        folder: "docs/quality",
        fileType: "md",
        concept: "redis",
        limit: 5,
        maxReads: 1,
        consolidate: false
      }
    }));
    if (indexedHarness.search?.optionalIndexes?.bm25?.used !== true || indexedHarness.search?.optionalIndexes?.entity?.used !== true || indexedHarness.search?.optionalIndexes?.vector?.used !== true || indexedHarness.appliedCalls?.[0]?.arguments?.useIndex !== "hybrid" || !indexedHarness.autoReads?.some((item) => item.ref === addedMemory.ref)) {
      throw new Error(`MCP memory harness should auto-use fresh hybrid indexes: ${JSON.stringify(indexedHarness)}`);
    }

    const updatedMemory = mcpPayload(await client.callTool({
      name: "project_memory_update",
      arguments: {
        ref: addedMemory.ref,
        reason: "MCP smoke lifecycle update",
        title: "Run API tests with local Redis and lifecycle caches",
        content: "API tests require local Redis before running the integration suite. UPDATE_LIFECYCLE_SMOKE",
        concepts: ["testing", "redis", "memory", "lifecycle"],
        confidence: 0.91
      }
    }));
    if (updatedMemory.schemaVersion !== "project-agent.memory-update.v1" || updatedMemory.dryRun || updatedMemory.record?.version !== Number(addedMemory.record.version || 1) + 1 || !updatedMemory.changedFields?.includes("content") || !updatedMemory.refreshed) {
      throw new Error(`MCP memory update failed: ${JSON.stringify(updatedMemory)}`);
    }

    const updatedIndexedSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "UPDATE_LIFECYCLE_SMOKE", useIndex: "hybrid", limit: 5 }
    }));
    if (!updatedIndexedSearch.results?.some((item) => item.id === addedMemory.record.id && item.snippet.includes("UPDATE_LIFECYCLE_SMOKE")) || updatedIndexedSearch.ranking?.optionalIndexes?.bm25?.used !== true || updatedIndexedSearch.ranking?.optionalIndexes?.entity?.used !== true || updatedIndexedSearch.ranking?.optionalIndexes?.vector?.used !== true) {
      throw new Error(`MCP updated memory should refresh indexes and stay searchable: ${JSON.stringify(updatedIndexedSearch)}`);
    }

    const updateAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_updated", memoryId: addedMemory.record.id, limit: 5 }
    }));
    if (!updateAudit.entries?.some((item) => item.action === "memory_updated" && item.memoryId === addedMemory.record.id)) {
      throw new Error(`MCP memory audit did not capture update: ${JSON.stringify(updateAudit)}`);
    }

    const supersedeOld = mcpPayload(await client.callTool({
      name: "project_memory_add",
      arguments: {
        type: "fact",
        title: "Supersede old smoke fact",
        content: "SUPERSEDE_OLD_SMOKE will be replaced by a newer canonical fact.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        concepts: ["supersede-smoke"],
        goalId,
        confidence: 0.88,
        importance: 7
      }
    }));
    const supersedeDryRun = mcpPayload(await client.callTool({
      name: "project_memory_supersede",
      arguments: {
        ref: supersedeOld.ref,
        dryRun: true,
        reason: "MCP smoke supersede preview",
        content: "SUPERSEDE_NEW_SMOKE replaces the old smoke fact.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        concepts: ["supersede-smoke", "lifecycle"]
      }
    }));
    if (!supersedeDryRun.dryRun || supersedeDryRun.plan?.old?.id !== supersedeOld.record.id || !supersedeDryRun.plan?.replacement?.supersedes?.includes(supersedeOld.record.id)) {
      throw new Error(`MCP memory supersede dry-run failed: ${JSON.stringify(supersedeDryRun)}`);
    }
    const superseded = mcpPayload(await client.callTool({
      name: "project_memory_supersede",
      arguments: {
        ref: supersedeOld.ref,
        dryRun: false,
        reason: "MCP smoke supersede execution",
        content: "SUPERSEDE_NEW_SMOKE replaces the old smoke fact.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        concepts: ["supersede-smoke", "lifecycle"]
      }
    }));
    if (superseded.dryRun || superseded.oldRecord?.isLatest !== false || superseded.oldRecord?.supersededBy !== superseded.record?.id || !superseded.record?.supersedes?.includes(supersedeOld.record.id) || !superseded.refreshed) {
      throw new Error(`MCP memory supersede execution failed: ${JSON.stringify(superseded)}`);
    }
    const supersedeSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "SUPERSEDE_NEW_SMOKE", latestOnly: true, limit: 5 }
    }));
    if (!supersedeSearch.results?.some((item) => item.id === superseded.record.id) || supersedeSearch.results?.some((item) => item.id === supersedeOld.record.id)) {
      throw new Error(`MCP superseded memory latest search failed: ${JSON.stringify(supersedeSearch)}`);
    }

    const expiredMemory = mcpPayload(await client.callTool({
      name: "project_memory_add",
      arguments: {
        type: "episode",
        title: "Retention expired smoke episode",
        content: "RETENTION_EXPIRED_SMOKE should be expired by retention sweep.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        concepts: ["retention-smoke"],
        goalId,
        validUntil: "2000-01-01T00:00:00.000Z",
        confidence: 0.8,
        importance: 4
      }
    }));
    const retentionAudit = mcpPayload(await client.callTool({
      name: "project_memory_retention_audit",
      arguments: { limit: 50 }
    }));
    if (retentionAudit.schemaVersion !== "project-agent.memory-retention-audit.v1" || !retentionAudit.candidates?.some((item) => item.id === expiredMemory.record.id && item.action === "expire" && item.eligible)) {
      throw new Error(`MCP memory retention audit failed: ${JSON.stringify(retentionAudit)}`);
    }
    const retentionDryRun = mcpPayload(await client.callTool({
      name: "project_memory_retention_sweep",
      arguments: { dryRun: true, limit: 50, reason: "MCP smoke retention dry-run" }
    }));
    if (!retentionDryRun.dryRun || !retentionDryRun.auditRef || !retentionDryRun.audit?.candidates?.some((item) => item.id === expiredMemory.record.id)) {
      throw new Error(`MCP memory retention sweep dry-run failed: ${JSON.stringify(retentionDryRun)}`);
    }
    const retentionSweep = mcpPayload(await client.callTool({
      name: "project_memory_retention_sweep",
      arguments: { dryRun: false, limit: 50, reason: "MCP smoke retention sweep" }
    }));
    if (retentionSweep.dryRun || !retentionSweep.mutations?.some((item) => item.expired >= 1) || !retentionSweep.refreshed) {
      throw new Error(`MCP memory retention sweep execution failed: ${JSON.stringify(retentionSweep)}`);
    }
    const expiredRead = mcpPayload(await client.callTool({
      name: "project_memory_read",
      arguments: { ref: expiredMemory.ref }
    }));
    if (expiredRead.record?.isLatest !== false || expiredRead.record?.retention?.status !== "expired") {
      throw new Error(`MCP retention sweep did not mark record expired: ${JSON.stringify(expiredRead)}`);
    }

    const dryRunForget = mcpPayload(await client.callTool({
      name: "project_memory_forget",
      arguments: { ref: addedMemory.ref, mode: "delete", dryRun: true, reason: "MCP smoke dry-run" }
    }));
    if (!dryRunForget.dryRun || dryRunForget.plan?.canonicalRecords?.length !== 1 || !dryRunForget.auditRef) {
      throw new Error(`MCP memory forget dry-run failed: ${JSON.stringify(dryRunForget)}`);
    }

    const dryRunAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_forget_dry_run", dryRun: true, ref: addedMemory.ref, limit: 5 }
    }));
    if (!dryRunAudit.entries?.some((item) => item.action === "memory_forget_dry_run" && item.dryRun === true && item.refs?.includes(addedMemory.ref))) {
      throw new Error(`MCP memory audit did not capture forget dry-run: ${JSON.stringify(dryRunAudit)}`);
    }

    const stillSearchable = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", limit: 5 }
    }));
    if (!stillSearchable.results?.some((item) => item.id === addedMemory.record.id)) {
      throw new Error(`MCP dry-run forget mutated canonical memory: ${JSON.stringify(stillSearchable)}`);
    }

    const executedForget = mcpPayload(await client.callTool({
      name: "project_memory_forget",
      arguments: { ref: addedMemory.ref, mode: "delete", dryRun: false, reason: "MCP smoke delete" }
    }));
    if (executedForget.dryRun || executedForget.postCheck?.remainingMatches !== 0 || !executedForget.refreshed) {
      throw new Error(`MCP memory forget execution failed: ${JSON.stringify(executedForget)}`);
    }

    const executedAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_forget_executed", mode: "delete", ref: addedMemory.ref, limit: 5 }
    }));
    if (!executedAudit.entries?.some((item) => item.action === "memory_forget_executed" && item.mode === "delete" && item.refs?.includes(addedMemory.ref))) {
      throw new Error(`MCP memory audit did not capture forget execution: ${JSON.stringify(executedAudit)}`);
    }

    const deletedSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "Redis integration suite", limit: 5 }
    }));
    if (deletedSearch.results?.some((item) => item.id === addedMemory.record.id)) {
      throw new Error(`MCP deleted memory still appears in search: ${JSON.stringify(deletedSearch)}`);
    }

    const redactMemory = mcpPayload(await client.callTool({
      name: "project_memory_add",
      arguments: {
        type: "fact",
        title: "Redaction smoke fact",
        content: "NEVER_FIND_ME_SMOKE should be removed by redaction.",
        sourceRefs: [".project-agent/runtime.json#events[0]"],
        concepts: ["redaction-smoke"],
        goalId
      }
    }));
    const redacted = mcpPayload(await client.callTool({
      name: "project_memory_forget",
      arguments: {
        ref: redactMemory.ref,
        mode: "redact",
        dryRun: false,
        replacement: "[redacted smoke content]",
        reason: "MCP smoke redact"
      }
    }));
    if (redacted.postCheck?.remainingMatches !== 1 || !redacted.refreshed) {
      throw new Error(`MCP memory redact failed: ${JSON.stringify(redacted)}`);
    }
    const redactedAudit = mcpPayload(await client.callTool({
      name: "project_memory_audit",
      arguments: { action: "memory_forget_executed", mode: "redact", ref: redactMemory.ref, limit: 5 }
    }));
    if (!redactedAudit.entries?.some((item) => item.action === "memory_forget_executed" && item.mode === "redact" && item.mutations?.length)) {
      throw new Error(`MCP memory audit did not capture redact execution: ${JSON.stringify(redactedAudit)}`);
    }
    const redactedSearch = mcpPayload(await client.callTool({
      name: "project_memory_search",
      arguments: { query: "NEVER_FIND_ME_SMOKE", limit: 5 }
    }));
    if (redactedSearch.results?.some((item) => item.id === redactMemory.record.id)) {
      throw new Error(`MCP redacted memory content still appears in search: ${JSON.stringify(redactedSearch)}`);
    }
  } catch (error) {
    throw new Error(`${error.message || String(error)}${stderr ? `\nMCP stderr:\n${stderr}` : ""}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function mcpColdStartSmoke() {
  const coldProjectDir = mkdtempSync(path.join(os.tmpdir(), "project-agent-terminal-mcp-cold-"));
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server/project-mcp.js", "--project-dir", coldProjectDir],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "project-agent-terminal-cold-start-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
    const toolList = await client.listTools();
    if (!toolList.tools?.some((tool) => tool.name === "project_start")) {
      throw new Error(`MCP project_start tool missing: ${JSON.stringify(toolList)}`);
    }

    const inventoryBefore = mcpPayload(await client.callTool({ name: "project_memory_inventory", arguments: {} }));
    if (inventoryBefore.status !== "not_started" || !inventoryBefore.nextStep?.tool) {
      throw new Error(`MCP pre-start memory inventory should be not_started: ${JSON.stringify(inventoryBefore)}`);
    }

    const memoryAuditBefore = mcpPayload(await client.callTool({ name: "project_memory_audit", arguments: {} }));
    if (memoryAuditBefore.status !== "not_started" || memoryAuditBefore.entries?.length) {
      throw new Error(`MCP pre-start memory audit should be not_started: ${JSON.stringify(memoryAuditBefore)}`);
    }

    const memoryConsolidateBefore = mcpPayload(await client.callTool({ name: "project_memory_consolidate", arguments: {} }));
    if (memoryConsolidateBefore.status !== "not_started" || memoryConsolidateBefore.candidates?.length) {
      throw new Error(`MCP pre-start memory consolidate should be not_started: ${JSON.stringify(memoryConsolidateBefore)}`);
    }

    const memoryHarnessBefore = mcpPayload(await client.callTool({ name: "project_memory_harness", arguments: {} }));
    if (memoryHarnessBefore.status !== "not_started" || memoryHarnessBefore.autoReads?.length) {
      throw new Error(`MCP pre-start memory harness should be not_started: ${JSON.stringify(memoryHarnessBefore)}`);
    }

    const before = mcpPayload(await client.callTool({ name: "project_takeover_summary", arguments: {} }));
    if (before.lifecycle?.status !== "not_started" || before.takeoverSummary?.defaultReadOrder?.length || before.takeoverSummary?.nextStep?.command !== "project_start") {
      throw new Error(`MCP pre-start summary should be explicit not_started: ${JSON.stringify(before)}`);
    }

    const auditBefore = mcpPayload(await client.callTool({ name: "project_handoff_audit", arguments: {} }));
    if (auditBefore.lifecycle !== "not_started" || auditBefore.status !== "not_started" || !auditBefore.blockers?.includes("project_not_started")) {
      throw new Error(`MCP pre-start audit should not look like broken handoff: ${JSON.stringify(auditBefore)}`);
    }

    const readBefore = mcpPayload(await client.callTool({
      name: "project_read_ref",
      arguments: { ref: ".project-agent/takeover-packet.json" }
    }));
    if (readBefore.lifecycle !== "not_started" || readBefore.status !== "not_started" || !readBefore.nextStep?.tool) {
      throw new Error(`MCP pre-start ref read should point to project_start: ${JSON.stringify(readBefore)}`);
    }

    const started = mcpPayload(await client.callTool({
      name: "project_start",
      arguments: {
        objective: "Cold start MCP project",
        acceptance: ["MCP can initialize project state"]
      }
    }));
    if (started.lifecycle?.status !== "active" || !started.goal || !existsSync(path.join(coldProjectDir, ".project-agent", "takeover-packet.json")) || !existsSync(path.join(coldProjectDir, ".project-agent", "process-trace.json")) || !existsSync(path.join(coldProjectDir, ".project-agent", "architecture-map.json")) || !existsSync(path.join(coldProjectDir, ".project-agent", "memory", "facts.jsonl"))) {
      throw new Error(`MCP project_start did not create a coherent handoff package: ${JSON.stringify(started)}`);
    }

    const memoryAuditAfterStart = mcpPayload(await client.callTool({ name: "project_memory_audit", arguments: { limit: 5 } }));
    if (!["ok", "warn"].includes(memoryAuditAfterStart.status) || !memoryAuditAfterStart.entries?.some((item) => item.action === "store_initialized")) {
      throw new Error(`MCP post-start memory audit should include store initialization: ${JSON.stringify(memoryAuditAfterStart)}`);
    }

    const after = mcpPayload(await client.callTool({ name: "project_takeover_summary", arguments: {} }));
    if (after.lifecycle?.status !== "active" || after.takeoverSummary?.defaultReadOrder?.[0] !== ".project-agent/takeover-summary.json") {
      throw new Error(`MCP post-start summary should be active with readable refs: ${JSON.stringify(after)}`);
    }
  } catch (error) {
    throw new Error(`${error.message || String(error)}${stderr ? `\nMCP cold-start stderr:\n${stderr}` : ""}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(coldProjectDir, { recursive: true, force: true });
  }
}

const child = spawn("node", ["server/index.js"], {
  env: {
    ...process.env,
    PROJECT_DIR: projectDir,
    PORT: String(port),
    PROJECT_AGENT_BIND_HOST: "127.0.0.1",
    PROJECT_AGENT_REMOTE: "0",
    PROJECT_AGENT_ALLOW_REMOTE: "0",
    PROJECT_AGENT_AUTH_TOKEN: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForServer();
  const config = await get("/api/config");
  if (!config.projectDir || config.apiPort !== port || !config.uiPort) throw new Error(`missing project config fields: ${JSON.stringify(config)}`);
  const health = await get("/api/health");
  if (health.schemaVersion !== "project-agent.health.v1" || !["ok", "watch"].includes(health.status) || health.server?.bindHost !== "127.0.0.1" || health.server?.port !== port || !health.server?.uiPort || health.security?.boundary !== "local_only" || health.security?.remoteAccess !== "disabled_by_bind_host" || health.security?.auth !== "not_enabled" || health.security?.authRequired !== false || !health.project?.projectDir || !health.terminal?.backend || !health.memory || !health.state?.manifest) {
    throw new Error(`health endpoint missing productization readiness fields: ${JSON.stringify(health)}`);
  }
  const authEndpoint = await get("/api/security/auth");
  if (authEndpoint.schemaVersion !== "project-agent.auth-boundary.v1" || authEndpoint.effective?.localOnly !== true || authEndpoint.auth?.required !== false || authEndpoint.auth?.valuesExposed !== false || authEndpoint.requested?.tokenFingerprint !== null || JSON.stringify(authEndpoint).includes("PROJECT_AGENT_AUTH_TOKEN")) {
    throw new Error(`auth endpoint missing safe local defaults: ${JSON.stringify(authEndpoint)}`);
  }
  if (!health.security?.authBoundary || health.security.authBoundary.schemaVersion !== authEndpoint.schemaVersion || health.security.authBoundary.auth?.required !== false) {
    throw new Error(`health endpoint missing auth boundary summary: ${JSON.stringify(health.security?.authBoundary)}`);
  }
  const sandboxGuidance = await get("/api/security/sandbox");
  if (sandboxGuidance.schemaVersion !== "project-agent.sandbox-guidance.v1" || !["ok", "watch"].includes(sandboxGuidance.status) || sandboxGuidance.posture?.localOnly !== true || sandboxGuidance.posture?.auth !== "not_enabled" || sandboxGuidance.posture?.apiPort !== port || sandboxGuidance.auth?.schemaVersion !== "project-agent.auth-boundary.v1" || sandboxGuidance.auth?.auth?.required !== false || sandboxGuidance.secrets?.rawEnvReturned !== false || sandboxGuidance.secrets?.sensitiveEnv?.valuesExposed !== false) {
    throw new Error(`sandbox guidance endpoint missing local permission posture: ${JSON.stringify(sandboxGuidance)}`);
  }
  if (!sandboxGuidance.policy?.allowedAutomations?.includes("project_takeover_summary_memory_harness") || !sandboxGuidance.policy?.allowedAutomations?.includes("project_launcher_status_and_logs") || !sandboxGuidance.policy?.requiresConfirmation?.includes("state_import_execute_overwrite") || !sandboxGuidance.policy?.requiresConfirmation?.includes("launcher_execute_stop_or_restart_process") || !sandboxGuidance.policy?.blockedByDefault?.includes("remote_bind_without_auth")) {
    throw new Error(`sandbox guidance missing automation/confirmation/block policy: ${JSON.stringify(sandboxGuidance.policy)}`);
  }
  if (!sandboxGuidance.permissions?.writeScopes?.some((scope) => scope.id === "state_import" && scope.gate === "dry_run_plus_overwrite_confirmation") || !sandboxGuidance.permissions?.writeScopes?.some((scope) => scope.id === "launcher_logs" && scope.gate === "launch_stop_restart_lifecycle") || !sandboxGuidance.permissions?.executionScopes?.some((scope) => scope.id === "launcher" && scope.gate === "launch_plan_then_execute") || !sandboxGuidance.checks?.some((item) => item.id === "memory_harness" && item.status === "ok")) {
    throw new Error(`sandbox guidance missing concrete permission scopes: ${JSON.stringify(sandboxGuidance.permissions)}`);
  }
  if (!health.security?.sandbox || health.security.sandbox.schemaVersion !== sandboxGuidance.schemaVersion || !health.security.sandbox.checks) {
    throw new Error(`health endpoint missing sandbox guidance summary: ${JSON.stringify(health.security?.sandbox)}`);
  }
  await post("/api/init", { name: "smoke" });
  const created = await post("/api/goals", {
    objective: "Smoke test Project Agent Terminal",
    acceptance: ["Kernel endpoint works"]
  });
  const goalId = created.goal.id;
  const projectsEndpoint = await get("/api/projects");
  if (projectsEndpoint.schemaVersion !== "project-agent.project-launcher.v1" || projectsEndpoint.boundary?.localOnly !== true || projectsEndpoint.current?.apiPort !== port || !projectsEndpoint.projects?.some((project) => project.current && project.projectDir === projectDir)) {
    throw new Error(`project launcher endpoint missing current project: ${JSON.stringify(projectsEndpoint)}`);
  }
  const launcherTargetDir = path.join(projectDir, "launcher-target");
  const registeredProject = await post("/api/projects/register", {
    projectDir: launcherTargetDir,
    name: "launcher-target",
    create: true
  });
  if (!registeredProject.ok || registeredProject.project?.projectDir !== launcherTargetDir || !existsSync(launcherTargetDir)) {
    throw new Error(`project launcher register failed: ${JSON.stringify(registeredProject)}`);
  }
  const projectsAfterRegister = await get("/api/projects");
  if (!projectsAfterRegister.projects?.some((project) => project.projectDir === launcherTargetDir && project.source === "registered")) {
    throw new Error(`registered project missing from launcher list: ${JSON.stringify(projectsAfterRegister)}`);
  }
  const launchPlan = await post("/api/projects/launch", {
    projectDir: launcherTargetDir,
    dryRun: true
  });
  if (launchPlan.schemaVersion !== "project-agent.project-launch-plan.v1" || launchPlan.dryRun !== true || launchPlan.launched !== false || launchPlan.apiPort === port || launchPlan.uiPort === config.uiPort || !launchPlan.command?.includes("PROJECT_DIR=") || !launchPlan.command?.includes("VITE_API_PORT=") || !launchPlan.command?.includes("VITE_PORT=") || launchPlan.bindHost !== "127.0.0.1" || !launchPlan.url?.startsWith("http://127.0.0.1:")) {
    throw new Error(`project launch plan failed: ${JSON.stringify(launchPlan)}`);
  }
  const emptyLauncherLogs = await get(`/api/projects/logs?projectDir=${encodeURIComponent(launcherTargetDir)}&limit=5`);
  if (emptyLauncherLogs.schemaVersion !== "project-agent.project-launcher-logs.v1" || emptyLauncherLogs.log?.path !== `.project-agent/launcher-logs/${launchPlan.project.id}.jsonl` || !Array.isArray(emptyLauncherLogs.entries)) {
    throw new Error(`project launcher logs endpoint missing persisted log contract: ${JSON.stringify(emptyLauncherLogs)}`);
  }
  const stopDryRun = await post("/api/projects/stop", {
    projectDir: launcherTargetDir,
    dryRun: true
  });
  if (stopDryRun.schemaVersion !== "project-agent.project-launch-control.v1" || stopDryRun.action !== "stop" || stopDryRun.status !== "not_running" || stopDryRun.stopped !== false || stopDryRun.log?.path !== `.project-agent/launcher-logs/${launchPlan.project.id}.jsonl`) {
    throw new Error(`project launcher stop dry-run failed: ${JSON.stringify(stopDryRun)}`);
  }
  const restartDryRun = await post("/api/projects/restart", {
    projectDir: launcherTargetDir,
    dryRun: true
  });
  if (restartDryRun.schemaVersion !== "project-agent.project-launch-control.v1" || restartDryRun.action !== "restart" || restartDryRun.status !== "would_start" || restartDryRun.launched !== false || restartDryRun.launchPlan?.schemaVersion !== "project-agent.project-launch-plan.v1") {
    throw new Error(`project launcher restart dry-run failed: ${JSON.stringify(restartDryRun)}`);
  }
  const launcherLifecycleDir = path.join(projectDir, "launcher-lifecycle");
  mkdirSync(launcherLifecycleDir, { recursive: true });
  const lifecycleLaunch = await launchProjectInstance({
    appRoot: process.cwd(),
    controlProjectDir: projectDir,
    projectDir: launcherLifecycleDir,
    currentPort: port,
    currentUiPort: config.uiPort,
    apiPort: port + 41,
    uiPort: config.uiPort + 41,
    dryRun: false,
    execute: true,
    command: process.execPath,
    args: ["-e", "console.log('launcher-lifecycle-ready'); setTimeout(() => process.exit(0), 10000);"]
  });
  if (lifecycleLaunch.schemaVersion !== "project-agent.project-launch-plan.v1" || lifecycleLaunch.launched !== true || !lifecycleLaunch.log?.path?.includes(".project-agent/launcher-logs/")) {
    throw new Error(`project launcher lifecycle launch failed: ${JSON.stringify(lifecycleLaunch)}`);
  }
  await wait(500);
  const lifecycleLogs = readProjectLauncherLogs(projectDir, { projectDir: launcherLifecycleDir, limit: 20 });
  if (lifecycleLogs.schemaVersion !== "project-agent.project-launcher-logs.v1" || lifecycleLogs.status !== "ok" || !lifecycleLogs.entries.some((entry) => entry.event === "start") || !lifecycleLogs.entries.some((entry) => entry.stream === "stdout" && entry.text.includes("launcher-lifecycle-ready"))) {
    throw new Error(`project launcher lifecycle logs missing start/stdout entries: ${JSON.stringify(lifecycleLogs)}`);
  }
  const lifecycleStop = await stopProjectInstance({
    controlProjectDir: projectDir,
    projectDir: launcherLifecycleDir,
    dryRun: false,
    execute: true
  });
  if (lifecycleStop.schemaVersion !== "project-agent.project-launch-control.v1" || lifecycleStop.action !== "stop" || lifecycleStop.stopped !== true || lifecycleStop.status !== "stopping") {
    throw new Error(`project launcher lifecycle stop failed: ${JSON.stringify(lifecycleStop)}`);
  }
  await wait(500);
  const lifecycleLogsAfterStop = readProjectLauncherLogs(projectDir, { projectDir: launcherLifecycleDir, limit: 30 });
  if (!lifecycleLogsAfterStop.entries.some((entry) => entry.event === "stop_requested")) {
    throw new Error(`project launcher lifecycle logs missing stop entry: ${JSON.stringify(lifecycleLogsAfterStop)}`);
  }
  const packet = await get(`/api/kernel?role=coding_agent&goal=${goalId}`);
  if (packet.goalId !== goalId) throw new Error("kernel did not bind goal");
  const initialInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (!initialInsights.graph?.nodes?.some((node) => node.id === "goal")) throw new Error("insights missing goal graph node");
  if (!initialInsights.knowledgeGraph?.nodes?.some((node) => node.kind === "goal")) throw new Error("insights missing goal knowledge node");
  if (!initialInsights.architecture?.totals?.files) throw new Error("insights missing architecture file count");
  if (!initialInsights.process?.workstreams?.lanes?.some((lane) => lane.id === "strategy")) throw new Error("insights missing workstream lanes");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/governance-spec.json")) throw new Error("insights missing governance spec state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/takeover-summary.json")) throw new Error("insights missing takeover summary state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/agent-context-bundle.json")) throw new Error("insights missing agent context bundle state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/continuity.json")) throw new Error("insights missing continuity state refs");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/continuity-contract.json")) throw new Error("insights missing continuity contract state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/agent-runbook.json")) throw new Error("insights missing agent runbook state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/memory-graph.json")) throw new Error("insights missing memory graph state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/process-trace.json")) throw new Error("insights missing process trace state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/architecture-map.json")) throw new Error("insights missing architecture map state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/state-manifest.json")) throw new Error("insights missing state manifest state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/takeover-packet.json")) throw new Error("insights missing takeover packet state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/continuity-audit.json")) throw new Error("insights missing continuity audit state ref");
  if (!initialInsights.continuity?.stateRefs?.includes(".project-agent/next-agent-prompt.md")) throw new Error("insights missing next-agent prompt state ref");
  if (!initialInsights.continuity?.continuityContract?.capabilities?.some((item) => item.id === "process_identified")) {
    throw new Error(`insights missing continuity contract process capability: ${JSON.stringify(initialInsights.continuity?.continuityContract)}`);
  }
  if (!initialInsights.continuity?.memoryGraph?.nodes?.some((node) => node.kind === "goal")) {
    throw new Error(`continuity missing durable memory graph: ${JSON.stringify(initialInsights.continuity?.memoryGraph)}`);
  }
  if (initialInsights.continuity?.processTrace?.schemaVersion !== "project-agent.process-trace.v1") {
    throw new Error(`continuity missing durable process trace schema: ${JSON.stringify(initialInsights.continuity?.processTrace)}`);
  }
  if (initialInsights.continuity?.architectureMap?.schemaVersion !== "project-agent.architecture-map.v1") {
    throw new Error(`continuity missing durable architecture map schema: ${JSON.stringify(initialInsights.continuity?.architectureMap)}`);
  }
  if (initialInsights.continuity?.takeoverPacket?.schemaVersion !== "project-agent.takeover-packet.v1") {
    throw new Error(`continuity missing durable takeover packet schema: ${JSON.stringify(initialInsights.continuity?.takeoverPacket)}`);
  }
  if (initialInsights.continuity?.continuityAudit?.schemaVersion !== "project-agent.continuity-audit.v1" || !initialInsights.continuity?.continuityAudit?.checks?.length) {
    throw new Error(`continuity missing durable continuity audit: ${JSON.stringify(initialInsights.continuity?.continuityAudit)}`);
  }
  if (initialInsights.continuity?.governanceSpec?.schemaVersion !== "project-agent.governance-spec.v1" || !initialInsights.continuity?.governanceSpec?.requirements?.some((item) => item.id === "agent_neutral_handoff")) {
    throw new Error(`continuity missing durable governance spec: ${JSON.stringify(initialInsights.continuity?.governanceSpec)}`);
  }
  if (initialInsights.continuity?.decisionLedger?.schemaVersion !== "project-agent.decision-ledger.v1" || initialInsights.continuity?.decisionLedger?.decisionCount < 2 || !initialInsights.continuity?.decisionLedger?.decisions?.some((item) => item.id === "product:agent_governance_workspace" && item.sourceHash && item.validFrom)) {
    throw new Error(`continuity missing temporal decision ledger: ${JSON.stringify(initialInsights.continuity?.decisionLedger)}`);
  }
  if (initialInsights.continuity?.temporalProvenance?.schemaVersion !== "project-agent.temporal-provenance-audit.v1" || !initialInsights.continuity?.temporalProvenance?.facts?.some((item) => item.id === "decision:product:temporal_provenance" && item.sourceHash && item.validFrom) || !initialInsights.continuity?.temporalProvenance?.checks?.some((check) => check.id === "source_hashes") || !initialInsights.continuity?.temporalProvenance?.checks?.some((check) => check.id === "validity_windows")) {
    throw new Error(`continuity missing temporal provenance audit: ${JSON.stringify(initialInsights.continuity?.temporalProvenance)}`);
  }
  if (initialInsights.continuity?.objectiveCoverage?.schemaVersion !== "project-agent.objective-coverage.v1" || !initialInsights.continuity?.objectiveCoverage?.requirements?.some((item) => item.id === "memory_visible_knowledge_graph")) {
    throw new Error(`continuity missing objective coverage map: ${JSON.stringify(initialInsights.continuity?.objectiveCoverage)}`);
  }
  if (!initialInsights.continuity?.agentRunbook?.steps?.some((step) => step.id === "run_takeover_drill")) {
    throw new Error(`insights missing executable agent runbook: ${JSON.stringify(initialInsights.continuity?.agentRunbook)}`);
  }
  if (!initialInsights.continuity?.agentRunbook?.activeStepId || !initialInsights.continuity?.agentRunbook?.nextCommand) {
    throw new Error(`agent runbook missing active step or next command: ${JSON.stringify(initialInsights.continuity?.agentRunbook)}`);
  }
  if (!initialInsights.continuity?.agentRunbook?.steps?.every((step) => step.status && step.tone)) {
    throw new Error(`agent runbook steps missing dynamic status: ${JSON.stringify(initialInsights.continuity?.agentRunbook?.steps)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/takeover-summary.json")) {
    throw new Error(`insights missing summary-first start protocol: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (initialInsights.continuity?.startProtocol?.readFirst?.[0]?.path !== ".project-agent/takeover-summary.json") {
    throw new Error(`insights start protocol should begin with takeover summary: ${JSON.stringify(initialInsights.continuity?.startProtocol?.readFirst)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/context-starter-prompt.md")) {
    throw new Error(`insights missing context starter prompt read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/continuity-contract.json")) {
    throw new Error(`insights missing continuity contract read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/agent-context-bundle.json")) {
    throw new Error(`insights missing budgeted bundle read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/process-trace.json")) {
    throw new Error(`insights missing process trace read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/architecture-map.json")) {
    throw new Error(`insights missing architecture map read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  if (!initialInsights.continuity?.startProtocol?.readFirst?.some((item) => item.path === ".project-agent/state-manifest.json")) {
    throw new Error(`insights missing state manifest read-first item: ${JSON.stringify(initialInsights.continuity?.startProtocol)}`);
  }
  const contractEndpoint = await get("/api/continuity-contract");
  if (!contractEndpoint.continuityContract?.proofChecklist?.some((item) => item.id === "resume_cursor")) {
    throw new Error(`continuity contract endpoint missing proof checklist: ${JSON.stringify(contractEndpoint)}`);
  }
  if (contractEndpoint.continuityContract?.agentRunbook?.entrypoint !== ".project-agent/agent-runbook.json") {
    throw new Error(`continuity contract endpoint missing agent runbook summary: ${JSON.stringify(contractEndpoint.continuityContract?.agentRunbook)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.governanceSpec !== ".project-agent/governance-spec.json") {
    throw new Error(`continuity contract endpoint missing governance spec source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.contextBundle !== ".project-agent/agent-context-bundle.json") {
    throw new Error(`continuity contract endpoint missing context bundle source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.memoryGraph !== ".project-agent/memory-graph.json") {
    throw new Error(`continuity contract endpoint missing memory graph source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.processTrace !== ".project-agent/process-trace.json") {
    throw new Error(`continuity contract endpoint missing process trace source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.architectureMap !== ".project-agent/architecture-map.json") {
    throw new Error(`continuity contract endpoint missing architecture map source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.stateManifest !== ".project-agent/state-manifest.json") {
    throw new Error(`continuity contract endpoint missing state manifest source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.takeoverPacket !== ".project-agent/takeover-packet.json") {
    throw new Error(`continuity contract endpoint missing takeover packet source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.continuityAudit !== ".project-agent/continuity-audit.json") {
    throw new Error(`continuity contract endpoint missing continuity audit source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.starterPrompt !== ".project-agent/next-agent-prompt.md") {
    throw new Error(`continuity contract endpoint missing starter prompt source: ${JSON.stringify(contractEndpoint.continuityContract?.sourceOfTruth)}`);
  }
  if (contractEndpoint.continuityContract?.sourceOfTruth?.temporalProvenance !== ".project-agent/continuity.json#temporalProvenance" || !contractEndpoint.continuityContract?.capabilities?.some((item) => item.id === "temporal_provenance") || !contractEndpoint.continuityContract?.proofChecklist?.some((item) => item.id === "temporal_provenance")) {
    throw new Error(`continuity contract endpoint missing temporal provenance contract: ${JSON.stringify(contractEndpoint.continuityContract)}`);
  }
  const runbookEndpoint = await get("/api/agent-runbook");
  if (!runbookEndpoint.agentRunbook?.steps?.some((step) => step.command?.includes("npm run takeover"))) {
    throw new Error(`agent runbook endpoint missing takeover command: ${JSON.stringify(runbookEndpoint)}`);
  }
  const governanceSpecEndpoint = await get("/api/governance-spec");
  if (governanceSpecEndpoint.governanceSpec?.schemaVersion !== "project-agent.governance-spec.v1" || !governanceSpecEndpoint.governanceSpec?.requirements?.some((item) => item.id === "memory_visible_knowledge_graph")) {
    throw new Error(`governance spec endpoint missing requirements: ${JSON.stringify(governanceSpecEndpoint)}`);
  }
  const memoryGraphEndpoint = await get("/api/memory-graph");
  if (!memoryGraphEndpoint.memoryGraph?.edges?.length || !memoryGraphEndpoint.memoryGraph?.provenanceRefs?.length) {
    throw new Error(`memory graph endpoint missing durable graph data: ${JSON.stringify(memoryGraphEndpoint)}`);
  }
  const processTraceEndpoint = await get("/api/process-trace");
  if (processTraceEndpoint.processTrace?.schemaVersion !== "project-agent.process-trace.v1" || !processTraceEndpoint.processTrace?.phases?.some((phase) => phase.id === "plan")) {
    throw new Error(`process trace endpoint missing durable process data: ${JSON.stringify(processTraceEndpoint)}`);
  }
  const architectureMapEndpoint = await get("/api/architecture-map");
  if (architectureMapEndpoint.architectureMap?.schemaVersion !== "project-agent.architecture-map.v1" || !architectureMapEndpoint.architectureMap?.tree?.length) {
    throw new Error(`architecture map endpoint missing durable architecture data: ${JSON.stringify(architectureMapEndpoint)}`);
  }
  const stateManifestEndpoint = await get("/api/state-manifest?write=1");
  if (stateManifestEndpoint.stateManifest?.schemaVersion !== "project-agent.state-manifest.v1" || !stateManifestEndpoint.stateManifest?.aggregateHash || !stateManifestEndpoint.stateManifest?.files?.some((file) => file.path === ".project-agent/memory-graph.json" && file.sha256)) {
    throw new Error(`state manifest endpoint missing file hashes: ${JSON.stringify(stateManifestEndpoint)}`);
  }
  if (stateManifestEndpoint.verification?.schemaVersion !== "project-agent.state-manifest-verification.v1" || !stateManifestEndpoint.verification?.ok) {
    throw new Error(`state manifest endpoint failed verification: ${JSON.stringify(stateManifestEndpoint.verification)}`);
  }
  const manifestCli = spawnSync(
    "node",
    ["server/state-manifest-cli.js", "--project-dir", projectDir, "--verify"],
    { encoding: "utf8" }
  );
  if (manifestCli.status !== 0) throw new Error(`state manifest cli verification failed: ${manifestCli.stderr || manifestCli.stdout}`);
  const manifestCliJson = JSON.parse(manifestCli.stdout);
  if (manifestCliJson.verification?.schemaVersion !== "project-agent.state-manifest-verification.v1" || !manifestCliJson.verification?.ok) {
    throw new Error(`state manifest cli missing ok verification: ${manifestCli.stdout}`);
  }
  const stateExportEndpoint = await get("/api/state/export?mode=portable");
  if (
    stateExportEndpoint.schemaVersion !== "project-agent.state-export.v1" ||
    stateExportEndpoint.status !== "ok" ||
    stateExportEndpoint.mode !== "portable" ||
    !stateExportEndpoint.digest ||
    !stateExportEndpoint.files?.some((file) => file.path === ".project-agent/state.json" && file.class === "source" && file.content) ||
    !stateExportEndpoint.files?.some((file) => file.path === ".project-agent/takeover-summary.json" && file.class === "derived") ||
    stateExportEndpoint.files?.some((file) => file.path === ".project-agent/runtime.json")
  ) {
    throw new Error(`state export endpoint missing portable bundle: ${JSON.stringify({ ...stateExportEndpoint, files: stateExportEndpoint.files?.slice(0, 4) })}`);
  }
  const stateImportDryRun = await post("/api/state/import", { bundle: stateExportEndpoint, dryRun: true });
  if (stateImportDryRun.schemaVersion !== "project-agent.state-import-plan.v1" || stateImportDryRun.status !== "dry_run" || stateImportDryRun.totals?.rejected || stateImportDryRun.totals?.identical < stateExportEndpoint.files.length) {
    throw new Error(`state import dry-run endpoint failed: ${JSON.stringify(stateImportDryRun)}`);
  }
  const transferSmokeContent = `${JSON.stringify({
    schemaVersion: "project-agent.state-transfer-smoke.v1",
    marker: "STATE_TRANSFER_SMOKE",
    goalId
  }, null, 2)}\n`;
  const transferSmokeBundle = {
    schemaVersion: "project-agent.state-export.v1",
    status: "ok",
    mode: "full",
    generatedAt: new Date().toISOString(),
    digest: "state-transfer-smoke",
    files: [
      {
        path: ".project-agent/state-transfer-smoke.json",
        class: "unknown",
        bytes: Buffer.byteLength(transferSmokeContent, "utf8"),
        sha256: sha256(transferSmokeContent),
        schemaVersion: "project-agent.state-transfer-smoke.v1",
        encoding: "utf8",
        content: transferSmokeContent
      }
    ]
  };
  const transferSmokePreview = await post("/api/state/import", { bundle: transferSmokeBundle, dryRun: true });
  if (transferSmokePreview.status !== "dry_run" || transferSmokePreview.totals?.create !== 1 || transferSmokePreview.totals?.rejected) {
    throw new Error(`state import create preview failed: ${JSON.stringify(transferSmokePreview)}`);
  }
  const transferSmokeExecution = await post("/api/state/import", { bundle: transferSmokeBundle, dryRun: false, overwrite: true });
  if (transferSmokeExecution.status !== "ok" || !transferSmokeExecution.written?.includes(".project-agent/state-transfer-smoke.json") || !transferSmokeExecution.stateManifest?.ok) {
    throw new Error(`state import execution failed: ${JSON.stringify(transferSmokeExecution)}`);
  }
  const transferSmokeFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "state-transfer-smoke.json"), "utf8"));
  if (transferSmokeFile.marker !== "STATE_TRANSFER_SMOKE" || transferSmokeFile.goalId !== goalId) {
    throw new Error(`state import did not write expected smoke file: ${JSON.stringify(transferSmokeFile)}`);
  }
  const contextBundleEndpoint = await get("/api/agent-context-bundle?write=1");
  if (contextBundleEndpoint.agentContextBundle?.schemaVersion !== "project-agent.context-bundle.v1" || !contextBundleEndpoint.agentContextBundle?.contentHash || contextBundleEndpoint.agentContextBundle?.readOrder?.[0] !== ".project-agent/takeover-summary.json" || !contextBundleEndpoint.agentContextBundle?.memory?.budget || !contextBundleEndpoint.agentContextBundle?.process?.budget || !contextBundleEndpoint.agentContextBundle?.architecture?.budget || !contextBundleEndpoint.agentContextBundle?.handoff?.budget || !contextBundleEndpoint.agentContextBundle?.process?.trace?.current || !contextBundleEndpoint.agentContextBundle?.validation?.stateManifestVerification?.ok || contextBundleEndpoint.agentContextBundle?.validation?.disclosureGate?.schemaVersion !== "project-agent.disclosure-gate.v1" || contextBundleEndpoint.agentContextBundle?.validation?.attentionPack?.schemaVersion !== "project-agent.attention-pack.v1" || !contextBundleEndpoint.agentContextBundle?.validation?.attentionPack?.items?.length || contextBundleEndpoint.takeoverSummary?.schemaVersion !== "project-agent.takeover-summary.v1" || !contextBundleEndpoint.takeoverSummary?.onDemandReads?.length) {
    throw new Error(`agent context bundle endpoint missing takeover context: ${JSON.stringify(contextBundleEndpoint.agentContextBundle)}`);
  }
  if (contextBundleEndpoint.agentContextBundle?.validation?.disclosureGate?.packing?.schemaVersion !== "project-agent.prompt-packing-gate.v1" || !contextBundleEndpoint.agentContextBundle?.validation?.disclosureGate?.packing?.limits?.maxFiles || !Array.isArray(contextBundleEndpoint.agentContextBundle?.validation?.disclosureGate?.packing?.omittedRefs)) {
    throw new Error(`agent context bundle endpoint missing prompt packing gate: ${JSON.stringify(contextBundleEndpoint.agentContextBundle?.validation?.disclosureGate)}`);
  }
  if (gitSmokeInitialized && (contextBundleEndpoint.agentContextBundle?.validation?.freshnessGate?.git?.schemaVersion !== "project-agent.git-freshness.v1" || contextBundleEndpoint.agentContextBundle?.validation?.freshnessGate?.git?.repo?.available !== true || !contextBundleEndpoint.agentContextBundle?.validation?.freshnessGate?.checks?.some((check) => check.id === "git_snapshot"))) {
    throw new Error(`agent context bundle endpoint missing git freshness: ${JSON.stringify(contextBundleEndpoint.agentContextBundle?.validation?.freshnessGate)}`);
  }
  if (contextBundleEndpoint.agentContextBundle?.validation?.temporalProvenance?.schemaVersion !== "project-agent.temporal-provenance-audit.v1" || !contextBundleEndpoint.agentContextBundle?.validation?.temporalProvenance?.facts?.length) {
    throw new Error(`agent context bundle endpoint missing temporal provenance: ${JSON.stringify(contextBundleEndpoint.agentContextBundle?.validation?.temporalProvenance)}`);
  }
  if (contextBundleEndpoint.verification?.schemaVersion !== "project-agent.context-bundle-verification.v1" || !contextBundleEndpoint.verification?.canResume || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "memory_graph" && check.status === "ok") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "objective_coverage") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "disclosure_gate") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "freshness_gate") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "phase_ledger") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "checkpoint_ledger") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "decision_ledger") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "state_boundary") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "runtime_eval") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "hook_ingress") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "provenance_ledger") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "attention_pack") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "pre_edit_risk") || !contextBundleEndpoint.verification?.checks?.some((check) => check.id === "handoff_lifecycle")) {
    throw new Error(`agent context bundle endpoint failed bundle-only verification: ${JSON.stringify(contextBundleEndpoint.verification)}`);
  }
  if (!contextBundleEndpoint.verification?.checks?.some((check) => check.id === "temporal_provenance")) {
    throw new Error(`agent context bundle endpoint missing temporal provenance verification: ${JSON.stringify(contextBundleEndpoint.verification)}`);
  }
  if (!contextBundleEndpoint.verification?.checks?.some((check) => check.id === "prompt_packing_gate")) {
    throw new Error(`agent context bundle endpoint missing prompt packing verification: ${JSON.stringify(contextBundleEndpoint.verification)}`);
  }
  const contextCli = spawnSync(
    "node",
    ["server/agent-context-cli.js", "--project-dir", projectDir, "--write", "--verify"],
    { encoding: "utf8" }
  );
  if (contextCli.status !== 0) throw new Error(`agent context cli failed: ${contextCli.stderr || contextCli.stdout}`);
  const contextCliJson = JSON.parse(contextCli.stdout);
  if (contextCliJson.agentContextBundle || contextCliJson.takeoverSummary?.schemaVersion !== "project-agent.takeover-summary.v1" || !contextCliJson.takeoverSummary?.currentState || !contextCliJson.takeoverSummary?.onDemandReads?.length) {
    throw new Error(`agent context cli should default to lean takeover summary: ${contextCli.stdout}`);
  }
  if (!contextCliJson.verification?.canResume || !contextCliJson.verification?.checks?.some((check) => check.id === "architecture_map" && check.status === "ok") || !contextCliJson.verification?.checks?.some((check) => check.id === "code_graph") || !contextCliJson.verification?.checks?.some((check) => check.id === "disclosure_gate") || !contextCliJson.verification?.checks?.some((check) => check.id === "freshness_gate") || !contextCliJson.verification?.checks?.some((check) => check.id === "phase_ledger") || !contextCliJson.verification?.checks?.some((check) => check.id === "checkpoint_ledger") || !contextCliJson.verification?.checks?.some((check) => check.id === "decision_ledger") || !contextCliJson.verification?.checks?.some((check) => check.id === "state_boundary") || !contextCliJson.verification?.checks?.some((check) => check.id === "runtime_eval") || !contextCliJson.verification?.checks?.some((check) => check.id === "hook_ingress") || !contextCliJson.verification?.checks?.some((check) => check.id === "provenance_ledger") || !contextCliJson.verification?.checks?.some((check) => check.id === "attention_pack") || !contextCliJson.verification?.checks?.some((check) => check.id === "pre_edit_risk") || !contextCliJson.verification?.checks?.some((check) => check.id === "handoff_lifecycle")) {
    throw new Error(`agent context cli missing bundle-only verification: ${contextCli.stdout}`);
  }
  if (!contextCliJson.verification?.checks?.some((check) => check.id === "temporal_provenance")) {
    throw new Error(`agent context cli missing temporal provenance verification: ${contextCli.stdout}`);
  }
  if (!contextCliJson.verification?.checks?.some((check) => check.id === "prompt_packing_gate")) {
    throw new Error(`agent context cli missing prompt packing gate: ${contextCli.stdout}`);
  }
  await mcpColdStartSmoke();
  await mcpSmoke(goalId);
  const rebuiltMemoryIndexEndpoint = await post("/api/memory/index/rebuild", {});
  if (rebuiltMemoryIndexEndpoint.schemaVersion !== "project-agent.memory-search-index-rebuild.v1" || rebuiltMemoryIndexEndpoint.index?.status !== "fresh" || rebuiltMemoryIndexEndpoint.index?.sourceRecords < 1) {
    throw new Error(`memory index rebuild endpoint failed: ${JSON.stringify(rebuiltMemoryIndexEndpoint)}`);
  }
  const memoryIndexEndpoint = await get("/api/memory/index");
  if (memoryIndexEndpoint.status !== "fresh" || memoryIndexEndpoint.engine !== "bm25-lite" || !memoryIndexEndpoint.statistics?.documentCount) {
    throw new Error(`memory index status endpoint failed: ${JSON.stringify(memoryIndexEndpoint)}`);
  }
  const indexedMemoryEndpoint = await get("/api/memory/search?query=CONSO_DECISION_SMOKE&useIndex=bm25&limit=5");
  if (indexedMemoryEndpoint.ranking?.optionalIndexes?.bm25?.used !== true || !indexedMemoryEndpoint.results?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE") && item.scoreBreakdown?.bm25)) {
    throw new Error(`memory indexed search endpoint failed: ${JSON.stringify(indexedMemoryEndpoint)}`);
  }
  const rebuiltMemoryEntityIndexEndpoint = await post("/api/memory/entity-index/rebuild", {});
  if (rebuiltMemoryEntityIndexEndpoint.schemaVersion !== "project-agent.memory-entity-index-rebuild.v1" || rebuiltMemoryEntityIndexEndpoint.index?.status !== "fresh" || rebuiltMemoryEntityIndexEndpoint.index?.statistics?.entityCount < 1) {
    throw new Error(`memory entity index rebuild endpoint failed: ${JSON.stringify(rebuiltMemoryEntityIndexEndpoint)}`);
  }
  const memoryEntityIndexEndpoint = await get("/api/memory/entity-index");
  if (memoryEntityIndexEndpoint.status !== "fresh" || memoryEntityIndexEndpoint.engine !== "entity-graph-lite" || !memoryEntityIndexEndpoint.statistics?.entityCount) {
    throw new Error(`memory entity index status endpoint failed: ${JSON.stringify(memoryEntityIndexEndpoint)}`);
  }
  const rebuiltMemoryVectorIndexEndpoint = await post("/api/memory/vector-index/rebuild", {});
  if (rebuiltMemoryVectorIndexEndpoint.schemaVersion !== "project-agent.memory-vector-index-rebuild.v1" || rebuiltMemoryVectorIndexEndpoint.index?.status !== "fresh" || rebuiltMemoryVectorIndexEndpoint.index?.statistics?.dimensions < 1 || rebuiltMemoryVectorIndexEndpoint.index?.embeddingProvider !== "none") {
    throw new Error(`memory vector index rebuild endpoint failed: ${JSON.stringify(rebuiltMemoryVectorIndexEndpoint)}`);
  }
  const memoryVectorIndexEndpoint = await get("/api/memory/vector-index");
  if (memoryVectorIndexEndpoint.status !== "fresh" || memoryVectorIndexEndpoint.engine !== "lexical-vector-lite" || !memoryVectorIndexEndpoint.statistics?.dimensions || memoryVectorIndexEndpoint.embeddingProvider !== "none") {
    throw new Error(`memory vector index status endpoint failed: ${JSON.stringify(memoryVectorIndexEndpoint)}`);
  }
  const vectorMemoryEndpoint = await get("/api/memory/search?query=CONSO_DECISION_SMOKE&useIndex=vector&limit=5");
  if (vectorMemoryEndpoint.ranking?.optionalIndexes?.vector?.used !== true || vectorMemoryEndpoint.ranking?.optionalIndexes?.vector?.embeddingProvider !== "none" || !vectorMemoryEndpoint.results?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE") && item.scoreBreakdown?.vector)) {
    throw new Error(`memory vector search endpoint failed: ${JSON.stringify(vectorMemoryEndpoint)}`);
  }
  const entityMemoryEndpoint = await get("/api/memory/search?query=CONSO_DECISION_SMOKE&useIndex=hybrid&limit=5");
  if (entityMemoryEndpoint.ranking?.optionalIndexes?.bm25?.used !== true || entityMemoryEndpoint.ranking?.optionalIndexes?.entity?.used !== true || entityMemoryEndpoint.ranking?.optionalIndexes?.vector?.used !== true || !entityMemoryEndpoint.results?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE") && item.scoreBreakdown?.entity && item.scoreBreakdown?.vector)) {
    throw new Error(`memory hybrid entity search endpoint failed: ${JSON.stringify(entityMemoryEndpoint)}`);
  }
  const contextSearchEndpoint = await get("/api/context-search?query=project-agent&folder=.project-agent&fileType=json&limit=5");
  if (contextSearchEndpoint.filters?.folder !== ".project-agent" || contextSearchEndpoint.filters?.fileType !== "json" || !contextSearchEndpoint.results?.length || !contextSearchEndpoint.results.every((item) => item.file.startsWith(".project-agent/") && item.file.endsWith(".json"))) {
    throw new Error(`context search endpoint filters failed: ${JSON.stringify(contextSearchEndpoint)}`);
  }
  const memorySearchEndpoint = await get("/api/memory/search?query=CONSO_DECISION_SMOKE&type=decision&sourceQuality=strong&minConfidence=0.8&limit=5");
  if (memorySearchEndpoint.filters?.type !== "decision" || memorySearchEndpoint.filters?.sourceQuality !== "strong" || memorySearchEndpoint.ranking?.deterministic !== true || !memorySearchEndpoint.results?.some((item) => item.type === "decision" && item.snippet.includes("CONSO_DECISION_SMOKE") && item.sourceQuality?.status === "strong")) {
    throw new Error(`memory search endpoint filters/ranking failed: ${JSON.stringify(memorySearchEndpoint)}`);
  }
  await post("/api/events", {
    phase: "execute",
    status: "done",
    title: "Procedure: HTTP consolidation UI confirmation",
    detail: "Procedure: HTTP_CONSOLIDATE_UI_CONFIRM should become durable memory through the confirmed HTTP consolidation path.",
    refs: ["http-consolidate-ui-confirm"],
    goalId,
    agentId: "http-smoke"
  });
  const memoryConsolidateEndpoint = await get("/api/memory/consolidate?mode=session&limit=10");
  if (memoryConsolidateEndpoint.schemaVersion !== "project-agent.memory-consolidation.v1" || memoryConsolidateEndpoint.status !== "dry_run" || !Array.isArray(memoryConsolidateEndpoint.candidates) || memoryConsolidateEndpoint.totals?.candidates === undefined) {
    throw new Error(`memory consolidate endpoint missing dry-run proposals: ${JSON.stringify(memoryConsolidateEndpoint)}`);
  }
  const httpReadyCandidate = memoryConsolidateEndpoint.candidates?.find((candidate) => candidate.content?.includes("HTTP_CONSOLIDATE_UI_CONFIRM") && candidate.status === "ready");
  if (!httpReadyCandidate) {
    throw new Error(`memory consolidate endpoint did not expose ready HTTP confirmation candidate: ${JSON.stringify(memoryConsolidateEndpoint)}`);
  }
  const memoryConsolidateExecutionEndpoint = await post("/api/memory/consolidate", {
    mode: "manual",
    dryRun: false,
    candidateIds: [httpReadyCandidate.id],
    limit: 10
  });
  if (memoryConsolidateExecutionEndpoint.dryRun || memoryConsolidateExecutionEndpoint.status !== "ok" || !memoryConsolidateExecutionEndpoint.created?.some((item) => item.title.includes("HTTP consolidation UI confirmation")) || !memoryConsolidateExecutionEndpoint.refreshScheduled) {
    throw new Error(`memory consolidate execution endpoint failed: ${JSON.stringify(memoryConsolidateExecutionEndpoint)}`);
  }
  const memoryConsolidateExecutionSearch = await get("/api/memory/search?query=HTTP_CONSOLIDATE_UI_CONFIRM&limit=5");
  if (!memoryConsolidateExecutionSearch.results?.some((item) => item.snippet.includes("HTTP_CONSOLIDATE_UI_CONFIRM"))) {
    throw new Error(`memory consolidate execution result not searchable: ${JSON.stringify(memoryConsolidateExecutionSearch)}`);
  }
  const memoryHarnessEndpoint = await get("/api/memory/harness?query=CONSO_DECISION_SMOKE%20CONSO_PROCEDURE_SMOKE&limit=6&maxReads=3");
  if (memoryHarnessEndpoint.schemaVersion !== "project-agent.memory-harness.v1" || !memoryHarnessEndpoint.automatic || !memoryHarnessEndpoint.appliedCalls?.some((call) => call.tool === "project_memory_read") || !memoryHarnessEndpoint.autoReads?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE"))) {
    throw new Error(`memory harness endpoint missing automatic search/read results: ${JSON.stringify(memoryHarnessEndpoint)}`);
  }
  if (!memoryHarnessEndpoint.appliedCalls?.some((call) => call.tool === "project_memory_retention_audit") || !memoryHarnessEndpoint.lifecycle?.dogfood || !memoryHarnessEndpoint.lifecycle?.retention) {
    throw new Error(`memory harness endpoint missing lifecycle automation: ${JSON.stringify(memoryHarnessEndpoint)}`);
  }
  const dogfoodSeedEndpoint = await post("/api/memory/seed-dogfood", {});
  if (dogfoodSeedEndpoint.schemaVersion !== "project-agent.memory-dogfood-seed.v1" || !["ok", "seeded", "unavailable"].includes(dogfoodSeedEndpoint.status) || dogfoodSeedEndpoint.dryRun) {
    throw new Error(`memory dogfood seed endpoint failed: ${JSON.stringify(dogfoodSeedEndpoint)}`);
  }
  const httpLifecycleMemory = await post("/api/memory", {
    type: "fact",
    title: "HTTP lifecycle update fact",
    content: "HTTP_UPDATE_LIFECYCLE_SMOKE_OLD should become a newer memory body.",
    sourceRefs: [".project-agent/runtime.json#events[0]"],
    concepts: ["http-lifecycle"],
    goalId,
    confidence: 0.86,
    importance: 6
  });
  const httpLifecycleUpdate = await post("/api/memory/update", {
    ref: httpLifecycleMemory.ref,
    reason: "HTTP smoke lifecycle update",
    content: "HTTP_UPDATE_LIFECYCLE_SMOKE_NEW is searchable after update and cache refresh.",
    concepts: ["http-lifecycle", "update"]
  });
  if (httpLifecycleUpdate.schemaVersion !== "project-agent.memory-update.v1" || httpLifecycleUpdate.dryRun || !httpLifecycleUpdate.refreshScheduled || !httpLifecycleUpdate.changedFields?.includes("content")) {
    throw new Error(`memory update endpoint failed: ${JSON.stringify(httpLifecycleUpdate)}`);
  }
  const httpUpdateSearch = await get("/api/memory/search?query=HTTP_UPDATE_LIFECYCLE_SMOKE_NEW&useIndex=hybrid&limit=5");
  if (!httpUpdateSearch.results?.some((item) => item.id === httpLifecycleMemory.record.id && item.snippet.includes("HTTP_UPDATE_LIFECYCLE_SMOKE_NEW")) || httpUpdateSearch.ranking?.optionalIndexes?.bm25?.used !== true) {
    throw new Error(`memory update endpoint result not indexed/searchable: ${JSON.stringify(httpUpdateSearch)}`);
  }
  const httpSupersedeMemory = await post("/api/memory", {
    type: "fact",
    title: "HTTP supersede old fact",
    content: "HTTP_SUPERSEDE_OLD_SMOKE should become non-latest.",
    sourceRefs: [".project-agent/runtime.json#events[0]"],
    concepts: ["http-supersede"],
    goalId
  });
  const httpSupersedeDryRun = await post("/api/memory/supersede", {
    ref: httpSupersedeMemory.ref,
    dryRun: true,
    reason: "HTTP supersede preview",
    content: "HTTP_SUPERSEDE_NEW_SMOKE should become latest.",
    sourceRefs: [".project-agent/runtime.json#events[0]"],
    concepts: ["http-supersede", "lifecycle"]
  });
  if (!httpSupersedeDryRun.dryRun || httpSupersedeDryRun.plan?.old?.id !== httpSupersedeMemory.record.id) {
    throw new Error(`memory supersede dry-run endpoint failed: ${JSON.stringify(httpSupersedeDryRun)}`);
  }
  const httpSupersede = await post("/api/memory/supersede", {
    ref: httpSupersedeMemory.ref,
    dryRun: false,
    reason: "HTTP supersede execution",
    content: "HTTP_SUPERSEDE_NEW_SMOKE should become latest.",
    sourceRefs: [".project-agent/runtime.json#events[0]"],
    concepts: ["http-supersede", "lifecycle"]
  });
  if (httpSupersede.dryRun || !httpSupersede.refreshScheduled || httpSupersede.oldRecord?.isLatest !== false || !httpSupersede.record?.supersedes?.includes(httpSupersedeMemory.record.id)) {
    throw new Error(`memory supersede endpoint failed: ${JSON.stringify(httpSupersede)}`);
  }
  const httpExpiredMemory = await post("/api/memory", {
    type: "episode",
    title: "HTTP retention expired episode",
    content: "HTTP_RETENTION_EXPIRED_SMOKE should expire through HTTP sweep.",
    sourceRefs: [".project-agent/runtime.json#events[0]"],
    concepts: ["http-retention"],
    goalId,
    validUntil: "2000-01-01T00:00:00.000Z"
  });
  const httpRetentionAudit = await get("/api/memory/retention?limit=100");
  if (httpRetentionAudit.schemaVersion !== "project-agent.memory-retention-audit.v1" || !httpRetentionAudit.candidates?.some((item) => item.id === httpExpiredMemory.record.id && item.eligible)) {
    throw new Error(`memory retention endpoint failed: ${JSON.stringify(httpRetentionAudit)}`);
  }
  const httpRetentionSweep = await post("/api/memory/retention/sweep", {
    dryRun: false,
    limit: 100,
    reason: "HTTP retention sweep smoke"
  });
  if (httpRetentionSweep.dryRun || !httpRetentionSweep.refreshScheduled || !httpRetentionSweep.mutations?.some((item) => item.expired >= 1)) {
    throw new Error(`memory retention sweep endpoint failed: ${JSON.stringify(httpRetentionSweep)}`);
  }
  const cliBootstrapEndpoint = await get("/api/cli-agent-bootstrap?query=CONSO_DECISION_SMOKE%20CONSO_PROCEDURE_SMOKE");
  if (cliBootstrapEndpoint.memoryHarness?.schemaVersion !== "project-agent.memory-harness.v1" || !cliBootstrapEndpoint.markdown?.includes("Automatic Memory Harness") || !cliBootstrapEndpoint.memoryHarness?.autoReads?.some((item) => item.snippet.includes("CONSO_DECISION_SMOKE"))) {
    throw new Error(`cli agent bootstrap missing automatic memory harness: ${JSON.stringify(cliBootstrapEndpoint.memoryHarness)}`);
  }
  const agentBootstrapEndpoint = await get("/api/agent/bootstrap");
  const agentBootstrapProviders = new Set((agentBootstrapEndpoint.providers || []).map((provider) => provider.id));
  if (
    agentBootstrapEndpoint.schemaVersion !== "project-agent.agent-bootstrap.v1" ||
    agentBootstrapEndpoint.status !== "ready" ||
    !agentBootstrapProviders.has("codex") ||
    !agentBootstrapProviders.has("claude") ||
    !agentBootstrapProviders.has("generic") ||
    agentBootstrapEndpoint.firstCall?.tool !== "project_takeover_summary" ||
    agentBootstrapEndpoint.automaticHarness?.tool !== "project_memory_harness" ||
    agentBootstrapEndpoint.automaticHarness?.arguments?.useIndex !== "hybrid" ||
    agentBootstrapEndpoint.automation?.manualUserStepsRequired !== false ||
    !agentBootstrapEndpoint.toolProtocol?.some((step) => step.tool === "project_context_search") ||
    !agentBootstrapEndpoint.toolProtocol?.some((step) => step.tool === "project_record_event")
  ) {
    throw new Error(`agent bootstrap kit missing harness-consumable protocol: ${JSON.stringify(agentBootstrapEndpoint)}`);
  }
  const memoryAuditEndpoint = await get("/api/memory/audit?limit=10");
  if (memoryAuditEndpoint.schemaVersion !== "project-agent.memory-audit-query.v1" || !["ok", "warn"].includes(memoryAuditEndpoint.status) || !memoryAuditEndpoint.entries?.some((item) => item.action === "memory_added") || !memoryAuditEndpoint.entries?.some((item) => item.action === "memory_consolidated") || !memoryAuditEndpoint.totals?.actionCounts) {
    throw new Error(`memory audit endpoint missing canonical timeline rows: ${JSON.stringify(memoryAuditEndpoint)}`);
  }
  const memoryAuditForgetEndpoint = await get("/api/memory/audit?action=memory_forget_executed&limit=5");
  if (!memoryAuditForgetEndpoint.entries?.some((item) => item.action === "memory_forget_executed")) {
    throw new Error(`memory audit endpoint action filter failed: ${JSON.stringify(memoryAuditForgetEndpoint)}`);
  }
  const contextPromptEndpoint = await fetch(`${base}/api/agent-context-prompt?format=markdown&write=1`);
  if (!contextPromptEndpoint.ok) throw new Error(`/api/agent-context-prompt failed ${contextPromptEndpoint.status}: ${await contextPromptEndpoint.text()}`);
  const contextPromptMarkdown = await contextPromptEndpoint.text();
  if (!contextPromptMarkdown.includes("Takeover Starter Prompt") || !contextPromptMarkdown.includes("## Takeover Gate") || !contextPromptMarkdown.includes("## Current State") || !contextPromptMarkdown.includes("## Next Step") || !contextPromptMarkdown.includes("## Memory Budget") || !contextPromptMarkdown.includes("## On-Demand Reads")) {
    throw new Error(`agent context prompt endpoint missing summary-first sections: ${contextPromptMarkdown.slice(0, 500)}`);
  }
  if (!readFileSync(path.join(projectDir, ".project-agent", "context-starter-prompt.md"), "utf8").includes("Takeover Starter Prompt")) {
    throw new Error("context-starter-prompt.md was not written by endpoint");
  }
  const contextPromptCli = spawnSync(
    "node",
    ["server/agent-context-prompt-cli.js", "--project-dir", projectDir, "--write"],
    { encoding: "utf8" }
  );
  if (contextPromptCli.status !== 0) throw new Error(`agent context prompt cli failed: ${contextPromptCli.stderr || contextPromptCli.stdout}`);
  if (!contextPromptCli.stdout.includes("Takeover Starter Prompt") || !readFileSync(path.join(projectDir, ".project-agent", "context-starter-prompt.md"), "utf8").includes("## Current State")) {
    throw new Error(`agent context prompt cli missing starter content: ${contextPromptCli.stdout.slice(0, 500)}`);
  }
  const contextDrillEndpoint = await get("/api/agent-context-drill?write=1");
  if (contextDrillEndpoint.drill?.schemaVersion !== "project-agent.context-takeover-drill.v1" || !contextDrillEndpoint.drill?.canResume || !contextDrillEndpoint.drill?.firstActions?.some((item) => item.action.includes("Verify the bundle"))) {
    throw new Error(`agent context drill endpoint missing replacement rehearsal: ${JSON.stringify(contextDrillEndpoint)}`);
  }
  const contextDrillCli = spawnSync(
    "node",
    ["server/agent-context-drill-cli.js", "--project-dir", projectDir, "--write"],
    { encoding: "utf8" }
  );
  if (contextDrillCli.status !== 0) throw new Error(`agent context drill cli failed: ${contextDrillCli.stderr || contextDrillCli.stdout}`);
  const contextDrillCliJson = JSON.parse(contextDrillCli.stdout);
  if (contextDrillCliJson.schemaVersion !== "project-agent.context-takeover-drill.v1" || !contextDrillCliJson.checks?.some((check) => check.id === "current_cursor" && check.status === "ok")) {
    throw new Error(`agent context drill cli missing current cursor check: ${contextDrillCli.stdout}`);
  }
  const takeoverPacketEndpoint = await get("/api/takeover-packet");
  if (takeoverPacketEndpoint.takeoverPacket?.schemaVersion !== "project-agent.takeover-packet.v1" || !takeoverPacketEndpoint.takeoverPacket?.firstRead?.length || !takeoverPacketEndpoint.takeoverPacket?.firstActions?.length) {
    throw new Error(`takeover packet endpoint missing durable startup data: ${JSON.stringify(takeoverPacketEndpoint)}`);
  }
  const promptEndpoint = await fetch(`${base}/api/next-agent-prompt?role=coding_agent&goal=${goalId}&format=markdown&write=1`);
  if (!promptEndpoint.ok) throw new Error(`/api/next-agent-prompt failed ${promptEndpoint.status}: ${await promptEndpoint.text()}`);
  const promptMarkdown = await promptEndpoint.text();
  if (!promptMarkdown.includes("Next Agent Starter Prompt") || !promptMarkdown.includes(".project-agent/takeover-packet.json") || !promptMarkdown.includes("## Next Command")) {
    throw new Error(`next-agent prompt endpoint missing required sections: ${promptMarkdown.slice(0, 500)}`);
  }
  if (!readFileSync(path.join(projectDir, ".project-agent", "next-agent-prompt.md"), "utf8").includes("Next Agent Starter Prompt")) {
    throw new Error("next-agent-prompt.md was not written by endpoint");
  }
  const continuityAuditEndpoint = await get("/api/continuity-audit?write=1");
  if (!continuityAuditEndpoint.continuityAudit?.canResume || !continuityAuditEndpoint.continuityAudit?.checks?.some((check) => check.id === "starter_prompt" && check.status === "ok")) {
    throw new Error(`continuity audit endpoint cannot resume or is missing starter prompt proof: ${JSON.stringify(continuityAuditEndpoint)}`);
  }
  const contractFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "continuity-contract.json"), "utf8"));
  if (!contractFile.capabilities?.some((item) => item.id === "architecture_managed")) {
    throw new Error(`continuity contract file missing architecture capability: ${JSON.stringify(contractFile)}`);
  }
  const runbookFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "agent-runbook.json"), "utf8"));
  if (!runbookFile.proofGates?.some((gate) => gate.id === "handoff_portable")) {
    throw new Error(`agent runbook file missing proof gates: ${JSON.stringify(runbookFile)}`);
  }
  if (!runbookFile.steps?.some((step) => step.id === "verify_state_manifest" && step.command?.includes("npm run manifest"))) {
    throw new Error(`agent runbook file missing manifest verification step: ${JSON.stringify(runbookFile.steps)}`);
  }
  if (runbookFile.steps?.[0]?.id !== "read_takeover_summary" || runbookFile.steps?.[1]?.id !== "inspect_budgeted_context") {
    throw new Error(`agent runbook should begin with takeover summary and budgeted context: ${JSON.stringify(runbookFile.steps?.slice(0, 3))}`);
  }
  if (!runbookFile.proofGates?.every((gate) => gate.status)) {
    throw new Error(`agent runbook file proof gates missing status: ${JSON.stringify(runbookFile.proofGates)}`);
  }
  const memoryGraphFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "memory-graph.json"), "utf8"));
  if (!memoryGraphFile.nodes?.length || !memoryGraphFile.edges?.length || !memoryGraphFile.provenanceCoverage) {
    throw new Error(`memory graph file missing nodes/edges/provenance: ${JSON.stringify(memoryGraphFile)}`);
  }
  const processTraceFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "process-trace.json"), "utf8"));
  if (processTraceFile.schemaVersion !== "project-agent.process-trace.v1" || !processTraceFile.current?.title || !processTraceFile.inspectOrder?.length) {
    throw new Error(`process trace file missing current cursor/inspect order: ${JSON.stringify(processTraceFile)}`);
  }
  const developmentTrailFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "development-trail.json"), "utf8"));
  if (developmentTrailFile.schemaVersion !== "project-agent.development-trail.v1" || !developmentTrailFile.current?.title || !developmentTrailFile.steps?.length || !developmentTrailFile.inspectOrder?.length) {
    throw new Error(`development trail file missing process-to-architecture links: ${JSON.stringify(developmentTrailFile)}`);
  }
  const architectureMapFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "architecture-map.json"), "utf8"));
  if (architectureMapFile.schemaVersion !== "project-agent.architecture-map.v1" || !architectureMapFile.tree?.length || !architectureMapFile.files?.length) {
    throw new Error(`architecture map file missing tree/files: ${JSON.stringify(architectureMapFile)}`);
  }
  if (architectureMapFile.codeGraph?.schemaVersion !== "project-agent.code-graph.v1") {
    throw new Error(`architecture map file missing code graph schema: ${JSON.stringify(architectureMapFile.codeGraph)}`);
  }
  const takeoverPacketFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "takeover-packet.json"), "utf8"));
  if (takeoverPacketFile.schemaVersion !== "project-agent.takeover-packet.v1" || !takeoverPacketFile.cursor?.title || !takeoverPacketFile.nextCommand) {
    throw new Error(`takeover packet file missing cursor/next command: ${JSON.stringify(takeoverPacketFile)}`);
  }
  const governanceSpecFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "governance-spec.json"), "utf8"));
  if (governanceSpecFile.schemaVersion !== "project-agent.governance-spec.v1" || !governanceSpecFile.requirements?.some((item) => item.id === "process_dynamic_previous_current_next")) {
    throw new Error(`governance spec file missing dynamic process requirement: ${JSON.stringify(governanceSpecFile)}`);
  }
  const takeoverAcceptanceFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "takeover-acceptance-audit.json"), "utf8"));
  if (takeoverAcceptanceFile.schemaVersion !== "project-agent.takeover-acceptance-audit.v1" || !["pass", "warn", "fail"].includes(takeoverAcceptanceFile.status) || !takeoverAcceptanceFile.rows?.some((item) => item.id === "agent_neutral_handoff") || !takeoverAcceptanceFile.rows?.some((item) => item.id === "development_trail_links_steps_to_architecture")) {
    throw new Error(`takeover acceptance audit file missing user-objective proof: ${JSON.stringify(takeoverAcceptanceFile)}`);
  }
  const agentContextBundleFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "agent-context-bundle.json"), "utf8"));
  const memoryGraphSchema = agentContextBundleFile.memory?.graph?.schemaVersion;
  const processTraceSchema = agentContextBundleFile.process?.trace?.schemaVersion;
  const developmentTrailSchema = agentContextBundleFile.process?.developmentTrail?.schemaVersion;
  const architectureMapSchema = agentContextBundleFile.architecture?.map?.schemaVersion;
  const codeGraphSchema = agentContextBundleFile.architecture?.codeGraph?.schemaVersion || agentContextBundleFile.architecture?.map?.codeGraph?.schemaVersion;
  if (
    agentContextBundleFile.schemaVersion !== "project-agent.context-bundle.v1" ||
    !agentContextBundleFile.contentHash ||
    !agentContextBundleFile.quickStart?.currentCursor ||
    agentContextBundleFile.readOrder?.[0] !== ".project-agent/takeover-summary.json" ||
    !agentContextBundleFile.readOrder?.includes(".project-agent/agent-context-bundle.json#quickStart") ||
    !agentContextBundleFile.memory?.budget ||
    !agentContextBundleFile.process?.budget ||
    !agentContextBundleFile.architecture?.budget ||
    !agentContextBundleFile.handoff?.budget ||
    !["project-agent.memory-graph.v1", "project-agent.memory-graph-summary.v1"].includes(memoryGraphSchema) ||
    !["project-agent.process-trace.v1", "project-agent.process-trace-summary.v1"].includes(processTraceSchema) ||
    !["project-agent.development-trail.v1", "project-agent.development-trail-summary.v1"].includes(developmentTrailSchema) ||
    !["project-agent.architecture-map.v1", "project-agent.architecture-map-summary.v1"].includes(architectureMapSchema) ||
    !["project-agent.code-graph.v1", "project-agent.code-graph-summary.v1"].includes(codeGraphSchema) ||
    !agentContextBundleFile.validation?.stateManifestVerification?.ok ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.canResume ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "disclosure_gate") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "freshness_gate") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "phase_ledger") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "decision_ledger") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "state_boundary") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "code_graph") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "runtime_eval") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "hook_ingress") ||
    !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "attention_pack") ||
    agentContextBundleFile.validation?.disclosureGate?.schemaVersion !== "project-agent.disclosure-gate.v1" ||
    agentContextBundleFile.validation?.attentionPack?.schemaVersion !== "project-agent.attention-pack.v1" ||
    !agentContextBundleFile.validation?.attentionPack?.items?.length ||
    agentContextBundleFile.validation?.takeoverAcceptanceAudit?.schemaVersion !== "project-agent.takeover-acceptance-audit.v1"
  ) {
    throw new Error(`agent context bundle file missing portable context: ${JSON.stringify(agentContextBundleFile)}`);
  }
  if (agentContextBundleFile.validation?.checkpointLedger?.schemaVersion !== "project-agent.checkpoint-ledger.v1" || !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "checkpoint_ledger")) {
    throw new Error(`agent context bundle file missing checkpoint ledger: ${JSON.stringify(agentContextBundleFile.validation?.checkpointLedger)}`);
  }
  if (agentContextBundleFile.validation?.disclosureGate?.packing?.schemaVersion !== "project-agent.prompt-packing-gate.v1" || !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "prompt_packing_gate")) {
    throw new Error(`agent context bundle file missing prompt packing gate: ${JSON.stringify(agentContextBundleFile.validation?.disclosureGate)}`);
  }
  if (gitSmokeInitialized && (agentContextBundleFile.validation?.freshnessGate?.git?.schemaVersion !== "project-agent.git-freshness.v1" || !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "freshness_gate"))) {
    throw new Error(`agent context bundle file missing git freshness: ${JSON.stringify(agentContextBundleFile.validation?.freshnessGate)}`);
  }
  if (agentContextBundleFile.validation?.temporalProvenance?.schemaVersion !== "project-agent.temporal-provenance-audit.v1" || !agentContextBundleFile.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "temporal_provenance") || !agentContextBundleFile.validation?.temporalProvenance?.checks?.some((check) => check.id === "contradictions")) {
    throw new Error(`agent context bundle file missing temporal provenance: ${JSON.stringify(agentContextBundleFile.validation?.temporalProvenance)}`);
  }
  const takeoverSummaryFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "takeover-summary.json"), "utf8"));
  if (takeoverSummaryFile.schemaVersion !== "project-agent.takeover-summary.v1" || takeoverSummaryFile.budget?.status !== "ok" || typeof takeoverSummaryFile.takeover?.canTakeOver !== "boolean" || !takeoverSummaryFile.onDemandReads?.length || takeoverSummaryFile.defaultReadOrder?.[0] !== ".project-agent/takeover-summary.json") {
    throw new Error(`takeover summary file missing lean takeover contract: ${JSON.stringify(takeoverSummaryFile)}`);
  }
  const continuityRaw = readFileSync(path.join(projectDir, ".project-agent", "continuity.json"), "utf8");
  const continuityFile = JSON.parse(continuityRaw);
  const continuityDetailFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "continuity-detail.json"), "utf8"));
  if (
    continuityFile.storageSchemaVersion !== "project-agent.continuity-manifest.v1" ||
    continuityFile.mode !== "summary-first" ||
    continuityFile.continuityManifest?.mode !== "summary-first" ||
    continuityFile.continuityManifest?.budget?.status !== "ok" ||
    continuityRaw.length > 60000 ||
    continuityFile.agentContextBundle ||
    continuityFile.takeoverSummary ||
    continuityFile.continuityContract ||
    continuityFile.memoryGraph ||
    continuityFile.processTrace ||
    continuityFile.architectureMap ||
    continuityFile.agentContextBundleRef?.path !== ".project-agent/agent-context-bundle.json" ||
    continuityFile.takeoverSummaryRef?.path !== ".project-agent/takeover-summary.json" ||
    continuityFile.continuityDetailRef?.path !== ".project-agent/continuity-detail.json" ||
    !continuityFile.onDemandReads?.some((read) => read.ref === ".project-agent/continuity-detail.json")
  ) {
    throw new Error(`continuity file is not a lean summary-first manifest: ${JSON.stringify({ bytes: continuityRaw.length, storageSchemaVersion: continuityFile.storageSchemaVersion, mode: continuityFile.mode, budget: continuityFile.continuityManifest?.budget, hasBundle: Boolean(continuityFile.agentContextBundle), hasSummary: Boolean(continuityFile.takeoverSummary) })}`);
  }
  if (continuityDetailFile.schemaVersion !== "project-agent.continuity-detail.v1" || !continuityDetailFile.fields?.includes("phaseLedger") || !continuityDetailFile.fields?.includes("startProtocol")) {
    throw new Error(`continuity detail file missing on-demand detail fields: ${JSON.stringify(continuityDetailFile)}`);
  }
  const stateManifestFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "state-manifest.json"), "utf8"));
  if (stateManifestFile.schemaVersion !== "project-agent.state-manifest.v1" || !stateManifestFile.aggregateHash || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-summary.json") || !stateManifestFile.files?.some((file) => file.path === ".project-agent/continuity-detail.json" && file.sha256) || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-packet.json" && file.sha256) || !stateManifestFile.files?.some((file) => file.path === ".project-agent/development-trail.json" && file.sha256) || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-acceptance-audit.json" && file.sha256)) {
    throw new Error(`state manifest file missing takeover packet hash: ${JSON.stringify(stateManifestFile)}`);
  }
  const nextAgentPromptFile = readFileSync(path.join(projectDir, ".project-agent", "next-agent-prompt.md"), "utf8");
  if (!nextAgentPromptFile.includes("Mandatory Read Order") || !nextAgentPromptFile.includes("Required First Actions") || !nextAgentPromptFile.includes("## Attention Pack") || !nextAgentPromptFile.includes("## Freshness Gate") || !nextAgentPromptFile.includes("## Runtime Eval") || !nextAgentPromptFile.includes("## Phase Ledger") || !nextAgentPromptFile.includes("## Decision Ledger") || !nextAgentPromptFile.includes("## Temporal Provenance") || !nextAgentPromptFile.includes("## State Boundary") || !nextAgentPromptFile.includes("## Code Graph") || !nextAgentPromptFile.includes("## Hook Ingress") || !nextAgentPromptFile.includes("## Provenance Ledger") || !nextAgentPromptFile.includes("## Disclosure Gate") || !nextAgentPromptFile.includes("## Pre-Edit Risk") || !nextAgentPromptFile.includes("## Handoff Lifecycle") || !nextAgentPromptFile.includes(".project-agent/governance-spec.json") || !nextAgentPromptFile.includes(".project-agent/state-manifest.json")) {
    throw new Error(`next-agent prompt file missing startup instructions: ${nextAgentPromptFile.slice(0, 500)}`);
  }
  if (!nextAgentPromptFile.includes("## Checkpoint Ledger")) {
    throw new Error(`next-agent prompt file missing checkpoint ledger instructions: ${nextAgentPromptFile.slice(0, 500)}`);
  }
  if (!nextAgentPromptFile.includes("packed files:") || !nextAgentPromptFile.includes("omitted refs:")) {
    throw new Error(`next-agent prompt file missing prompt packing instructions: ${nextAgentPromptFile.slice(0, 500)}`);
  }
  if (!nextAgentPromptFile.includes("backpressure:")) {
    throw new Error(`next-agent prompt file missing hook backpressure instructions: ${nextAgentPromptFile.slice(0, 500)}`);
  }
  if (gitSmokeInitialized && (!nextAgentPromptFile.includes("- git:") || !nextAgentPromptFile.includes("dirty tree:"))) {
    throw new Error(`next-agent prompt file missing git freshness instructions: ${nextAgentPromptFile.slice(0, 500)}`);
  }
  const continuityAuditFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "continuity-audit.json"), "utf8"));
  if (continuityAuditFile.schemaVersion !== "project-agent.continuity-audit.v1" || !continuityAuditFile.canResume || !continuityAuditFile.checks?.some((check) => check.id === "takeover_packet" && check.status === "ok") || !continuityAuditFile.checks?.some((check) => check.id === "governance_spec" && check.status === "ok") || !continuityAuditFile.checks?.some((check) => check.id === "state_manifest" && check.status === "ok")) {
    throw new Error(`continuity audit file missing takeover proof: ${JSON.stringify(continuityAuditFile)}`);
  }
  if (continuityAuditFile.stateManifestVerification?.schemaVersion !== "project-agent.state-manifest-verification.v1") {
    throw new Error(`continuity audit file missing manifest verification proof: ${JSON.stringify(continuityAuditFile.stateManifestVerification)}`);
  }
  if (!initialInsights.continuity?.takeoverDrill?.checks?.some((check) => check.id === "read_first_files")) {
    throw new Error(`insights missing takeover drill read-first check: ${JSON.stringify(initialInsights.continuity?.takeoverDrill)}`);
  }
  if (!initialInsights.continuity?.governance?.domains?.some((domain) => domain.id === "memory_visibility")) {
    throw new Error(`insights missing governance matrix: ${JSON.stringify(initialInsights.continuity?.governance)}`);
  }
  if (!initialInsights.continuity?.graphTrace?.coreNodes?.some((node) => node.id === "goal")) {
    throw new Error(`insights missing graph trace goal node: ${JSON.stringify(initialInsights.continuity?.graphTrace)}`);
  }
  const governanceEndpoint = await get("/api/governance");
  if (!governanceEndpoint.governance?.domains?.some((domain) => domain.id === "agent_continuity")) {
    throw new Error(`governance endpoint missing continuity domain: ${JSON.stringify(governanceEndpoint)}`);
  }
  const graphTraceEndpoint = await get("/api/graph-trace");
  if (!graphTraceEndpoint.graphTrace?.keyRelations?.length) {
    throw new Error(`graph trace endpoint missing key relations: ${JSON.stringify(graphTraceEndpoint)}`);
  }
  if (!initialInsights.continuity?.processTrace?.current?.title) {
    throw new Error(`insights missing process trace current event: ${JSON.stringify(initialInsights.continuity?.processTrace)}`);
  }
  if (!initialInsights.continuity?.architectureTrace?.totals?.files) {
    throw new Error(`insights missing architecture trace totals: ${JSON.stringify(initialInsights.continuity?.architectureTrace)}`);
  }
  const architectureTraceEndpoint = await get("/api/architecture-trace");
  if (!architectureTraceEndpoint.architectureTrace?.totals?.files) {
    throw new Error(`architecture trace endpoint missing file totals: ${JSON.stringify(architectureTraceEndpoint)}`);
  }
  if (!initialInsights.flow?.some((step) => step.id === "plan" && step.status === "done")) {
    throw new Error(`insights flow did not mark plan done: ${JSON.stringify(initialInsights.flow)}`);
  }
  await post("/api/agents/heartbeat", {
    agentId: "smoke-agent",
    role: "coding_agent",
    goalId,
    note: "running smoke test",
    leaseSeconds: 30
  });
  const agentList = await get("/api/agents");
  if (!agentList.agents?.some((agent) => agent.id === "smoke-agent" && agent.effectiveStatus === "active")) {
    throw new Error(`active agent heartbeat missing: ${JSON.stringify(agentList)}`);
  }
  const staleCli = spawnSync(
    "node",
    [
      "server/agent-cli.js",
      "heartbeat",
      "--project-dir",
      projectDir,
      "--agent-id",
      "stale-agent",
      "--role",
      "coding_agent",
      "--goal",
      goalId,
      "--lease-seconds",
      "1",
      "--note",
      "simulated crashed worker",
      "--json"
    ],
    { encoding: "utf8" }
  );
  if (staleCli.status !== 0) throw new Error(`agent cli failed: ${staleCli.stderr || staleCli.stdout}`);
  await wait(1200);
  const leaseInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (!leaseInsights.continuity?.agentLeases?.some((agent) => agent.id === "stale-agent" && agent.effectiveStatus === "stale")) {
    throw new Error(`stale agent lease missing from continuity: ${JSON.stringify(leaseInsights.continuity?.agentLeases)}`);
  }
  await post("/api/events", {
    phase: "execute",
    status: "current",
    title: "Stale agent half patch",
    detail: "simulated prior agent stopped while editing AGENTS.md",
    goalId,
    agentId: "stale-agent",
    tool: "apply_patch",
    source: "agent-run",
    files: [{ path: "AGENTS.md", status: "modified", summary: "+1/-0" }]
  });
  const interruptedInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (!interruptedInsights.continuity?.interruptedWork?.items?.some((item) => item.agentId === "stale-agent" && item.title === "Stale agent half patch")) {
    throw new Error(`interrupted work missing from continuity: ${JSON.stringify(interruptedInsights.continuity?.interruptedWork)}`);
  }
  if (!interruptedInsights.continuity?.continuityContract?.agentState?.interruptedWork?.count) {
    throw new Error(`interrupted work missing from continuity contract: ${JSON.stringify(interruptedInsights.continuity?.continuityContract?.agentState)}`);
  }
  if (!interruptedInsights.continuity?.startProtocol?.firstActions?.[0]?.action.includes("Resolve interrupted work")) {
    throw new Error(`start protocol did not prioritize interrupted work: ${JSON.stringify(interruptedInsights.continuity?.startProtocol?.firstActions)}`);
  }
  const roadmapPath = path.join(projectDir, "docs", "product", "roadmap.md");
  writeFileSync(roadmapPath, `${readFileSync(roadmapPath, "utf8")}\n- Smoke test records file diff stats.\n`, "utf8");
  const diffInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  const roadmapChange = diffInsights.architecture?.recentChanges?.find((change) => change.path === "docs/product/roadmap.md");
  if (!roadmapChange || roadmapChange.additions < 1 || !roadmapChange.summary) {
    throw new Error(`insights missing architecture diff stats: ${JSON.stringify(roadmapChange)}`);
  }
  if (!diffInsights.architecture?.impact?.folders?.some((folder) => folder.folder === "docs/product" && folder.files >= 1)) {
    throw new Error(`architecture impact missing docs/product folder: ${JSON.stringify(diffInsights.architecture?.impact)}`);
  }
  if (!diffInsights.continuity?.architectureTrace?.inspectOrder?.some((item) => item.path === "docs/product" || item.path === "docs/product/roadmap.md")) {
    throw new Error(`architecture trace missing inspect order after diff: ${JSON.stringify(diffInsights.continuity?.architectureTrace)}`);
  }
  await post("/api/events", {
    phase: "execute",
    status: "current",
    title: "Hook tool running",
    detail: "external agent is editing roadmap",
    goalId,
    agentId: "smoke-agent",
    tool: "codex-hook",
    files: [{ path: "docs/product/roadmap.md", status: "modified", summary: roadmapChange.summary }]
  });
  const cliEvent = spawnSync(
    "node",
    [
      "server/event-cli.js",
      "--project-dir",
      projectDir,
      "--phase",
      "plan",
      "--title",
      "CLI adapter wrote event",
      "--detail",
      "local adapter event",
      "--ref",
      "adapter-smoke"
    ],
    { encoding: "utf8" }
  );
  if (cliEvent.status !== 0) throw new Error(`event cli failed: ${cliEvent.stderr || cliEvent.stdout}`);
  const hookInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (hookInsights.currentStep?.label !== "Hook tool running") {
    throw new Error(`hook event did not drive current step: ${JSON.stringify(hookInsights.currentStep)}`);
  }
  if (hookInsights.currentStep?.workstream?.id !== "strategy") {
    throw new Error(`roadmap hook event was not classified as strategy: ${JSON.stringify(hookInsights.currentStep)}`);
  }
  if (!hookInsights.knowledgeGraph?.nodes?.some((node) => node.kind === "event" && node.label.includes("Hook"))) {
    throw new Error("hook event missing from knowledge graph");
  }
  if (!hookInsights.knowledgeGraph?.nodes?.some((node) => node.kind === "workstream" && node.label === "Strategy")) {
    throw new Error("strategy workstream node missing from knowledge graph");
  }
  if (!hookInsights.continuity?.recentEvents?.some((event) => event.title === "CLI adapter wrote event")) {
    throw new Error("cli adapter event missing from continuity");
  }
  if (hookInsights.continuity?.preEditRisk?.schemaVersion !== "project-agent.pre-edit-risk.v1" || !hookInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "test_gap") || !hookInsights.continuity?.preEditRisk?.firstChecks?.length) {
    throw new Error(`pre-edit risk missing after hook event: ${JSON.stringify(hookInsights.continuity?.preEditRisk)}`);
  }
  const sanitizedHook = await post("/api/hooks", {
    source: "codex-hook",
    agentId: "smoke-agent",
    goalId,
    events: [
      {
        type: "tool_use",
        tool: "apply_patch",
        title: "Sanitized hook event",
        detail: "external hook carried password=supersecret123 and ghp_123456789012345678901234",
        data: { apiKey: "sk-test1234567890abcdef" },
        files: [{ path: "docs/product/roadmap.md", status: "modified", summary: "+1/-0" }]
      },
      {
        type: "mystery signal",
        title: "Unknown hook event",
        detail: "unknown hook type should normalize to observation"
      }
    ]
  });
  if (sanitizedHook.schemaVersion !== "project-agent.hook-ingress.v1" || sanitizedHook.accepted !== 2 || !sanitizedHook.entries?.some((entry) => entry.redactedFindings?.length) || !sanitizedHook.entries?.some((entry) => entry.warnings?.some((warning) => warning.startsWith("unknown_type:")))) {
    throw new Error(`sanitized hook ingress did not audit redaction and unknown type: ${JSON.stringify(sanitizedHook)}`);
  }
  if (sanitizedHook.pressure?.schemaVersion !== "project-agent.hook-backpressure.v1" || sanitizedHook.httpStatus !== 202) {
    throw new Error(`sanitized hook ingress missing pressure metadata: ${JSON.stringify(sanitizedHook.pressure)}`);
  }
  const hookRuntime = await get("/api/events");
  const sanitizedRuntimeEvent = hookRuntime.events?.find((event) => event.title === "Sanitized hook event");
  if (!sanitizedRuntimeEvent?.data?.ingress || sanitizedRuntimeEvent.detail.includes("supersecret123") || sanitizedRuntimeEvent.detail.includes("ghp_123456789012345678901234") || JSON.stringify(sanitizedRuntimeEvent).includes("sk-test1234567890abcdef")) {
    throw new Error(`sanitized hook event leaked secret-like content: ${JSON.stringify(sanitizedRuntimeEvent)}`);
  }
  const saturatedHookRes = await fetch(`${base}/api/hooks?maxEvents=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "codex-hook",
      events: [{ type: "tool_start", title: "Backpressure smoke", detail: "should return 429" }]
    })
  });
  const saturatedHook = await saturatedHookRes.json();
  if (saturatedHookRes.status !== 429 || saturatedHook.pressure?.status !== "saturated" || saturatedHook.accepted !== 0 || !saturatedHook.blockers?.includes("batch_limit")) {
    throw new Error(`saturated hook ingress did not return auditable 429 backpressure: ${JSON.stringify(saturatedHook)}`);
  }
  const hookIngressInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (hookIngressInsights.continuity?.hookIngressAudit?.schemaVersion !== "project-agent.hook-ingress-audit.v1" || hookIngressInsights.continuity?.hookIngressAudit?.acceptedEvents < 2 || hookIngressInsights.continuity?.hookIngressAudit?.sanitizedEvents < 1 || hookIngressInsights.continuity?.hookIngressAudit?.unknownTypeEvents < 1) {
    throw new Error(`continuity missing hook ingress audit: ${JSON.stringify(hookIngressInsights.continuity?.hookIngressAudit)}`);
  }
  if (hookIngressInsights.continuity?.hookIngressAudit?.backpressure?.schemaVersion !== "project-agent.hook-backpressure-audit.v1" || hookIngressInsights.continuity?.hookIngressAudit?.saturatedAttempts < 1 || hookIngressInsights.continuity?.hookIngressAudit?.rejectedEvents < 1 || !hookIngressInsights.continuity?.hookIngressAudit?.recentAttempts?.some((attempt) => attempt.httpStatus === 429)) {
    throw new Error(`continuity missing hook ingress backpressure audit: ${JSON.stringify(hookIngressInsights.continuity?.hookIngressAudit)}`);
  }
  const phaseStartedAt = new Date(Date.now() - 75).toISOString();
  const phaseEndedAt = new Date().toISOString();
  const phaseHook = await post("/api/hooks", {
    source: "codex-hook",
    agentId: "smoke-agent",
    goalId,
    events: [
      {
        id: "span-parent-smoke",
        type: "command_start",
        runId: "run-smoke-ledger",
        tool: "npm",
        title: "Ledger parent span",
        detail: "parent command for phase ledger smoke",
        startedAt: phaseStartedAt,
        artifactRefs: ["artifact:parent-log"]
      },
      {
        id: "span-child-smoke",
        type: "command_done",
        parentId: "span-parent-smoke",
        runId: "run-smoke-ledger",
        tool: "npm test",
        title: "Ledger child span",
        detail: "child command completed for phase ledger smoke",
        startedAt: phaseStartedAt,
        endedAt: phaseEndedAt,
        durationMs: 75,
        artifactRefs: ["artifact:child-log"],
        files: [{ path: "docs/product/roadmap.md", status: "modified", summary: "+1/-0" }]
      }
    ]
  });
  if (phaseHook.schemaVersion !== "project-agent.hook-ingress.v1" || phaseHook.accepted !== 2) {
    throw new Error(`phase hook ingress did not accept parent/child spans: ${JSON.stringify(phaseHook)}`);
  }
  const phaseRuntime = await get("/api/events");
  const phaseChildRuntime = phaseRuntime.events?.find((event) => event.id === "span-child-smoke");
  if (phaseChildRuntime?.parentId !== "span-parent-smoke" || phaseChildRuntime?.runId !== "run-smoke-ledger" || phaseChildRuntime?.durationMs !== 75 || !phaseChildRuntime?.artifactRefs?.includes("artifact:child-log")) {
    throw new Error(`phase runtime event missing span metadata: ${JSON.stringify(phaseChildRuntime)}`);
  }
  const phaseInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (phaseInsights.continuity?.phaseLedger?.schemaVersion !== "project-agent.phase-ledger.v1" || phaseInsights.continuity?.phaseLedger?.status !== "linked" || phaseInsights.continuity?.phaseLedger?.linkedCount < 1 || phaseInsights.continuity?.phaseLedger?.runCount < 1 || !phaseInsights.continuity?.phaseLedger?.spans?.some((span) => span.spanId === "span-child-smoke" && span.parentSpanId === "span-parent-smoke" && span.runId === "run-smoke-ledger") || !phaseInsights.continuity?.phaseLedger?.tree?.some((node) => node.spanId === "span-parent-smoke" && node.children?.some((child) => child.spanId === "span-child-smoke"))) {
    throw new Error(`continuity missing linked phase ledger: ${JSON.stringify(phaseInsights.continuity?.phaseLedger)}`);
  }
  if (!phaseInsights.continuity?.runtimeEval?.checks?.some((check) => check.id === "phase_ledger") || phaseInsights.continuity?.runtimeEval?.trace?.parentLinkCount < 1 || phaseInsights.continuity?.continuityContract?.phaseLedger?.status !== "linked") {
    throw new Error(`runtime eval/contract missing phase ledger: ${JSON.stringify(phaseInsights.continuity?.runtimeEval)}`);
  }
  if (phaseInsights.continuity?.checkpointLedger?.schemaVersion !== "project-agent.checkpoint-ledger.v1" || !phaseInsights.continuity?.checkpointLedger?.checkpoints?.some((checkpoint) => checkpoint.spanId === "span-child-smoke" && checkpoint.runId === "run-smoke-ledger" && checkpoint.parentSpanId === "span-parent-smoke") || !phaseInsights.continuity?.checkpointLedger?.runGroups?.some((run) => run.runId === "run-smoke-ledger") || !phaseInsights.continuity?.checkpointLedger?.checks?.some((check) => check.id === "resume_points") || !phaseInsights.continuity?.continuityContract?.checkpointLedger?.status) {
    throw new Error(`continuity missing checkpoint ledger: ${JSON.stringify(phaseInsights.continuity?.checkpointLedger)}`);
  }
  mkdirSync(path.join(projectDir, "src"), { recursive: true });
  writeFileSync(path.join(projectDir, "src", "workstream-smoke.js"), "export const smoke = true;\n", "utf8");
  writeFileSync(path.join(projectDir, "src", "dep-target.js"), "export function dependencyTarget() {\n  return \"target\";\n}\n", "utf8");
  writeFileSync(path.join(projectDir, "src", "dep-entry.js"), "import { dependencyTarget } from \"./dep-target.js\";\nexport const dependencyEntry = dependencyTarget();\n", "utf8");
  writeFileSync(path.join(projectDir, "src", "dep-target.test.js"), "import { dependencyTarget } from \"./dep-target.js\";\nif (dependencyTarget() !== \"target\") throw new Error(\"dep target smoke failed\");\n", "utf8");
  await post("/api/events", {
    phase: "execute",
    status: "current",
    title: "Code patch running",
    detail: "external agent is editing source code",
    goalId,
    agentId: "smoke-agent",
    tool: "codex-hook",
    files: [
      { path: "src/workstream-smoke.js", status: "added", summary: "+1/-0" },
      { path: "src/dep-target.js", status: "added", summary: "+1/-0" },
      { path: "src/dep-entry.js", status: "added", summary: "+2/-0" },
      { path: "src/dep-target.test.js", status: "added", summary: "+2/-0" }
    ]
  });
  const codeWorkstreamInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (codeWorkstreamInsights.currentStep?.workstream?.id !== "implementation") {
    throw new Error(`source event was not classified as implementation: ${JSON.stringify(codeWorkstreamInsights.currentStep)}`);
  }
  const smokeCodeGraph = codeWorkstreamInsights.continuity?.codeGraph || codeWorkstreamInsights.continuity?.architectureMap?.codeGraph;
  if (smokeCodeGraph?.schemaVersion !== "project-agent.code-graph.v1" || !smokeCodeGraph.edges?.some((edge) => edge.source === "src/dep-entry.js" && edge.target === "src/dep-target.js" && edge.kind === "local")) {
    throw new Error(`code graph missing local dependency edge: ${JSON.stringify(smokeCodeGraph)}`);
  }
  if (!smokeCodeGraph.changedImpact?.some((item) => item.path === "src/dep-target.js" && item.dependents?.includes("src/dep-entry.js"))) {
    throw new Error(`code graph missing changed dependent impact: ${JSON.stringify(smokeCodeGraph?.changedImpact)}`);
  }
  if (!smokeCodeGraph.testOwnershipByPath?.["src/dep-target.js"]?.includes("src/dep-target.test.js") || !smokeCodeGraph.changedImpact?.some((item) => item.path === "src/dep-target.js" && item.tests?.includes("src/dep-target.test.js") && item.recommendedReads?.includes("src/dep-target.test.js"))) {
    throw new Error(`code graph missing test ownership hints: ${JSON.stringify({ ownership: smokeCodeGraph.testOwnershipByPath, impact: smokeCodeGraph.changedImpact })}`);
  }
  const depTargetSymbols = smokeCodeGraph.symbolGraph?.symbolsByPath?.["src/dep-target.js"]?.exportedSymbols || [];
  const depTargetSymbolDependents = smokeCodeGraph.symbolGraph?.symbolDependentsByPath?.["src/dep-target.js"] || [];
  if (
    smokeCodeGraph.symbolGraph?.schemaVersion !== "project-agent.symbol-graph-lite.v1" ||
    !depTargetSymbols.some((symbol) => symbol.name === "dependencyTarget" && symbol.kind === "function") ||
    !depTargetSymbolDependents.some((row) => row.source === "src/dep-entry.js" && row.imported === "dependencyTarget" && row.calls >= 1) ||
    !smokeCodeGraph.changedImpact?.some((item) => item.path === "src/dep-target.js" && item.symbolDependents?.some((row) => row.source === "src/dep-entry.js" && row.calls >= 1) && item.recommendedReads?.includes("src/dep-entry.js"))
  ) {
    throw new Error(`code graph missing symbol-level dependency impact: ${JSON.stringify(smokeCodeGraph.symbolGraph)}`);
  }
  if (!codeWorkstreamInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "dependency_impact" && check.refs?.includes("src/dep-entry.js") && check.refs?.includes("src/dep-target.test.js"))) {
    throw new Error(`pre-edit risk missing dependency impact check: ${JSON.stringify(codeWorkstreamInsights.continuity?.preEditRisk)}`);
  }
  if (!codeWorkstreamInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "test_gap" && check.refs?.includes("src/dep-target.test.js"))) {
    throw new Error(`pre-edit risk missing test ownership refs: ${JSON.stringify(codeWorkstreamInsights.continuity?.preEditRisk)}`);
  }
  const missingInspectionCoverage = codeWorkstreamInsights.continuity?.preEditRisk?.inspectionCoverage;
  if (missingInspectionCoverage?.schemaVersion !== "project-agent.inspection-coverage.v1" || missingInspectionCoverage.status !== "warn" || !missingInspectionCoverage.missingRefs?.includes("src/dep-entry.js") || !missingInspectionCoverage.missingRefs?.includes("src/dep-target.test.js")) {
    throw new Error(`pre-edit risk missing inspection coverage warning: ${JSON.stringify(missingInspectionCoverage)}`);
  }
  if (!codeWorkstreamInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "inspection_coverage" && check.status === "warn" && check.refs?.includes("src/dep-entry.js") && check.refs?.includes("src/dep-target.test.js"))) {
    throw new Error(`pre-edit risk missing inspection coverage check: ${JSON.stringify(codeWorkstreamInsights.continuity?.preEditRisk)}`);
  }
  if (!codeWorkstreamInsights.continuity?.handoffLifecycle?.checks?.some((check) => check.id === "inspection_coverage" && check.status === "warn")) {
    throw new Error(`handoff lifecycle missing inspection coverage warning: ${JSON.stringify(codeWorkstreamInsights.continuity?.handoffLifecycle)}`);
  }
  const handoffInspectionAudit = await mcpCall(projectDir, "project_handoff_audit", { refresh: true });
  if (handoffInspectionAudit.inspectionCoverage?.status !== "warn" || !handoffInspectionAudit.warnings?.includes("inspection_coverage") || !handoffInspectionAudit.inspectionCoverage?.missingRefs?.includes("src/dep-target.test.js")) {
    throw new Error(`MCP handoff audit missing inspection coverage warning: ${JSON.stringify(handoffInspectionAudit)}`);
  }
  await post("/api/events", {
    phase: "evidence",
    status: "done",
    title: "Inspect dependency impact and run targeted test",
    detail: "Read src/dep-entry.js and ran src/dep-target.test.js before accepting the code graph handoff.",
    goalId,
    agentId: "smoke-agent",
    tool: "npm test",
    refs: ["src/dep-entry.js", "src/dep-target.test.js"],
    files: [
      { path: "src/dep-entry.js", status: "inspected", summary: "read dependent" },
      { path: "src/dep-target.test.js", status: "done", summary: "targeted test passed" }
    ]
  });
  const inspectedCodeInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  const inspectedCoverage = inspectedCodeInsights.continuity?.preEditRisk?.inspectionCoverage;
  if (inspectedCoverage?.status !== "ok" || !inspectedCoverage.inspectedRefs?.includes("src/dep-entry.js") || !inspectedCoverage.inspectedRefs?.includes("src/dep-target.test.js") || inspectedCoverage.missingRefs?.length) {
    throw new Error(`inspection coverage did not resolve after evidence event: ${JSON.stringify(inspectedCoverage)}`);
  }
  if (!codeWorkstreamInsights.continuity?.continuityContract?.capabilities?.some((item) => item.id === "code_graph") || codeWorkstreamInsights.continuity?.continuityContract?.sourceOfTruth?.codeGraph !== ".project-agent/architecture-map.json#codeGraph") {
    throw new Error(`continuity contract missing code graph capability/source: ${JSON.stringify(codeWorkstreamInsights.continuity?.continuityContract)}`);
  }
  if (!["project-agent.code-graph.v1", "project-agent.code-graph-summary.v1"].includes(codeWorkstreamInsights.continuity?.agentContextBundle?.architecture?.codeGraph?.schemaVersion) || !codeWorkstreamInsights.continuity?.agentContextBundle?.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "code_graph")) {
    throw new Error(`agent context bundle missing verified code graph: ${JSON.stringify(codeWorkstreamInsights.continuity?.agentContextBundle?.architecture?.codeGraph)}`);
  }
  if (!codeWorkstreamInsights.continuity?.agentContextBundle?.architecture?.codeGraph?.sourceRef || !codeWorkstreamInsights.continuity?.agentContextBundle?.validation?.provenanceLedger?.claims?.some((claim) => claim.id === "code_graph")) {
    throw new Error(`agent context bundle missing code graph source/provenance: ${JSON.stringify(codeWorkstreamInsights.continuity?.agentContextBundle?.validation)}`);
  }
  if (!codeWorkstreamInsights.knowledgeGraph?.nodes?.some((node) => node.kind === "workstream" && node.label === "Code Development")) {
    throw new Error("code development workstream node missing from knowledge graph");
  }
  const sessionLogPath = path.join(projectDir, ".project-agent", "synthetic-session.jsonl");
  const sessionLines = [
    {
      role: "user",
      content: "Please update docs/product/roadmap.md so the next agent can resume."
    },
    {
      type: "function_call",
      name: "apply_patch",
      input: "*** Update File: docs/product/roadmap.md\n+Imported session event proves adapter support."
    },
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_smoke",
            name: "exec_command",
            input: { cmd: "npm test", cwd: "outputs/project-agent-terminal" }
          }
        ]
      }
    }
  ];
  writeFileSync(sessionLogPath, sessionLines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  const importResult = await post("/api/import/session-log", {
    file: sessionLogPath,
    format: "auto",
    agentId: "previous-agent",
    source: "api-session-log",
    goalId
  });
  if (importResult.imported < 3) throw new Error(`session log import missed events: ${JSON.stringify(importResult)}`);
  const cliLogPath = path.join(projectDir, ".project-agent", "synthetic-cli-session.jsonl");
  writeFileSync(
    cliLogPath,
    JSON.stringify({
      phase: "audit",
      status: "done",
      title: "Imported CLI log event",
      detail: "session-log-cli can import normalized JSONL",
      files: [{ path: "AGENTS.md", status: "modified", summary: "+1/-0" }]
    }),
    "utf8"
  );
  const importCli = spawnSync(
    "node",
    [
      "server/session-log-cli.js",
      "--project-dir",
      projectDir,
      "--file",
      cliLogPath,
      "--source",
      "cli-session-log",
      "--agent",
      "previous-agent"
    ],
    { encoding: "utf8" }
  );
  if (importCli.status !== 0) throw new Error(`session log cli failed: ${importCli.stderr || importCli.stdout}`);
  const importedInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (!importedInsights.process?.events?.some((event) => event.title.includes("Tool running") && event.tool === "apply_patch")) {
    throw new Error(`imported apply_patch event missing from process: ${JSON.stringify(importedInsights.process?.events)}`);
  }
  if (!importedInsights.process?.events?.some((event) => event.tool === "apply_patch" && event.workstream?.id === "strategy")) {
    throw new Error(`imported roadmap apply_patch event missing strategy workstream: ${JSON.stringify(importedInsights.process?.events)}`);
  }
  if (!importedInsights.knowledgeGraph?.nodes?.some((node) => node.kind === "file" && node.label.includes("roadmap.md"))) {
    throw new Error("imported session file missing from knowledge graph");
  }
  if (!importedInsights.continuity?.recentEvents?.some((event) => event.title === "Imported CLI log event")) {
    throw new Error("session-log-cli event missing from continuity");
  }
  const wrappedCommand = spawnSync(
    "node",
    [
      "server/agent-run-cli.js",
      "--project-dir",
      projectDir,
      "--agent",
      "smoke-agent",
      "--goal",
      goalId,
      "--title",
      "Wrapped command smoke",
      "--workstream",
      "implementation",
      "--",
      "node",
      "-e",
      "require('fs').writeFileSync('docs/product/agent-run-smoke.md', '# Agent Run Smoke\\n\\nWrapped command changed this file.\\n')"
    ],
    { encoding: "utf8" }
  );
  if (wrappedCommand.status !== 0) throw new Error(`agent-run cli failed: ${wrappedCommand.stderr || wrappedCommand.stdout}`);
  let wrappedInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (wrappedInsights.continuity?.handoffSnapshot?.status === "writing") {
    await wait(1500);
    wrappedInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  }
  if (!wrappedInsights.process?.events?.some((event) => event.title === "Wrapped command smoke finished" && event.source === "agent-run")) {
    throw new Error(`agent-run event missing from process: ${JSON.stringify(wrappedInsights.process?.events)}`);
  }
  if (!wrappedInsights.continuity?.changedFiles?.some((file) => file.path === "docs/product/agent-run-smoke.md")) {
    throw new Error(`agent-run changed file missing from continuity: ${JSON.stringify(wrappedInsights.continuity?.changedFiles)}`);
  }
  if (wrappedInsights.continuity?.handoffSnapshot?.status !== "done") {
    throw new Error(`agent-run did not refresh handoff snapshot: ${JSON.stringify(wrappedInsights.continuity?.handoffSnapshot)}`);
  }
  if (wrappedInsights.continuity?.handoffLifecycle?.schemaVersion !== "project-agent.handoff-lifecycle.v1" || !["open", "accepted", "expired", "cancelled"].includes(wrappedInsights.continuity?.handoffLifecycle?.status)) {
    throw new Error(`agent-run missing typed handoff lifecycle: ${JSON.stringify(wrappedInsights.continuity?.handoffLifecycle)}`);
  }
  if (wrappedInsights.continuity?.freshnessGate?.schemaVersion !== "project-agent.freshness-gate.v1" || !["fresh", "watch", "stale", "expired"].includes(wrappedInsights.continuity?.freshnessGate?.status)) {
    throw new Error(`agent-run missing temporal freshness gate: ${JSON.stringify(wrappedInsights.continuity?.freshnessGate)}`);
  }
  if (wrappedInsights.continuity?.runtimeEval?.schemaVersion !== "project-agent.runtime-eval.v1" || !wrappedInsights.continuity?.runtimeEval?.spans?.length) {
    throw new Error(`agent-run missing runtime trace eval: ${JSON.stringify(wrappedInsights.continuity?.runtimeEval)}`);
  }
  if (wrappedInsights.continuity?.phaseLedger?.schemaVersion !== "project-agent.phase-ledger.v1" || wrappedInsights.continuity?.phaseLedger?.status !== "linked" || wrappedInsights.continuity?.phaseLedger?.linkedCount < 1 || !wrappedInsights.continuity?.phaseLedger?.spans?.some((span) => span.source === "agent-run" && span.parentSpanId)) {
    throw new Error(`agent-run missing linked phase ledger: ${JSON.stringify(wrappedInsights.continuity?.phaseLedger)}`);
  }
  if (wrappedInsights.continuity?.checkpointLedger?.schemaVersion !== "project-agent.checkpoint-ledger.v1" || !wrappedInsights.continuity?.checkpointLedger?.checkpoints?.some((checkpoint) => checkpoint.source === "agent-run" && checkpoint.parentSpanId) || !wrappedInsights.continuity?.checkpointLedger?.resumable?.length) {
    throw new Error(`agent-run missing checkpoint ledger: ${JSON.stringify(wrappedInsights.continuity?.checkpointLedger)}`);
  }
  const recoveryRes = await fetch(`${base}/api/recovery?role=coding_agent&goal=${goalId}&format=markdown&write=1`);
  if (!recoveryRes.ok) throw new Error(`/api/recovery failed ${recoveryRes.status}: ${await recoveryRes.text()}`);
  const recoveryMarkdown = await recoveryRes.text();
  if (
    !recoveryMarkdown.includes("## Current Cursor") ||
    !recoveryMarkdown.includes("## Workstream Cursor") ||
    !recoveryMarkdown.includes("## Project Governance Matrix") ||
    !recoveryMarkdown.includes("## Agent-Neutral Continuity Contract") ||
    !recoveryMarkdown.includes("## Memory Graph Trace") ||
    !recoveryMarkdown.includes("## Memory Graph Snapshot") ||
    !recoveryMarkdown.includes("## Process Trace") ||
    !recoveryMarkdown.includes(".project-agent/process-trace.json") ||
    !recoveryMarkdown.includes("## Takeover Readiness") ||
    !recoveryMarkdown.includes("## Takeover Drill") ||
    !recoveryMarkdown.includes("## Next Agent Takeover Packet") ||
    !recoveryMarkdown.includes(".project-agent/takeover-packet.json") ||
    !recoveryMarkdown.includes("## New Agent Start Protocol") ||
    !recoveryMarkdown.includes("## Architecture Map Snapshot") ||
    !recoveryMarkdown.includes(".project-agent/architecture-map.json") ||
    !recoveryMarkdown.includes("## Architecture Impact") ||
    !recoveryMarkdown.includes("## Architecture Trace") ||
    !recoveryMarkdown.includes("## Changed Files")
  ) {
    throw new Error(`recovery brief missing required sections: ${recoveryMarkdown.slice(0, 500)}`);
  }
  const recoveryCli = spawnSync(
    "node",
    ["server/recovery-cli.js", "--project-dir", projectDir, "--role", "coding_agent", "--goal", goalId, "--write"],
    { encoding: "utf8" }
  );
  if (recoveryCli.status !== 0) throw new Error(`recovery cli failed: ${recoveryCli.stderr || recoveryCli.stdout}`);
  if (!readFileSync(path.join(projectDir, ".project-agent", "recovery.md"), "utf8").includes("Project Recovery Brief")) {
    throw new Error("recovery.md was not written");
  }
  const resumeRes = await fetch(`${base}/api/resume?role=coding_agent&goal=${goalId}&format=markdown&write=1`);
  if (!resumeRes.ok) throw new Error(`/api/resume failed ${resumeRes.status}: ${await resumeRes.text()}`);
  const resumeMarkdown = await resumeRes.text();
  if (
    !resumeMarkdown.includes("Next Agent Resume Packet") ||
    !resumeMarkdown.includes("## Current Cursor") ||
    !resumeMarkdown.includes("## Workstream Cursor") ||
    !resumeMarkdown.includes("## Project Governance Matrix") ||
    !resumeMarkdown.includes("## Agent-Neutral Continuity Contract") ||
    !resumeMarkdown.includes("## Memory Graph Trace") ||
    !resumeMarkdown.includes("## Memory Graph Snapshot") ||
    !resumeMarkdown.includes("## Process Trace") ||
    !resumeMarkdown.includes(".project-agent/process-trace.json") ||
    !resumeMarkdown.includes("## Takeover Readiness") ||
    !resumeMarkdown.includes("## Interrupted Work") ||
    !resumeMarkdown.includes("## Takeover Drill") ||
    !resumeMarkdown.includes("## Next Agent Takeover Packet") ||
    !resumeMarkdown.includes(".project-agent/takeover-packet.json") ||
    !resumeMarkdown.includes("## New Agent Start Protocol") ||
    !resumeMarkdown.includes("## Agent Runbook") ||
    !resumeMarkdown.includes("## Architecture Map Snapshot") ||
    !resumeMarkdown.includes(".project-agent/architecture-map.json") ||
    !resumeMarkdown.includes("## Architecture Impact") ||
    !resumeMarkdown.includes("## Architecture Trace")
  ) {
    throw new Error(`resume packet missing required sections: ${resumeMarkdown.slice(0, 500)}`);
  }
  const resumeCli = spawnSync(
    "node",
    ["server/resume-cli.js", "--project-dir", projectDir, "--role", "coding_agent", "--goal", goalId, "--write"],
    { encoding: "utf8" }
  );
  if (resumeCli.status !== 0) throw new Error(`resume cli failed: ${resumeCli.stderr || resumeCli.stdout}`);
  if (!readFileSync(path.join(projectDir, ".project-agent", "resume.md"), "utf8").includes("Next Agent Resume Packet")) {
    throw new Error("resume.md was not written");
  }
  const nextAgentCli = spawnSync(
    "node",
    ["server/next-agent-prompt-cli.js", "--project-dir", projectDir, "--role", "coding_agent", "--goal", goalId, "--write"],
    { encoding: "utf8" }
  );
  if (nextAgentCli.status !== 0) throw new Error(`next-agent prompt cli failed: ${nextAgentCli.stderr || nextAgentCli.stdout}`);
  if (!readFileSync(path.join(projectDir, ".project-agent", "next-agent-prompt.md"), "utf8").includes("Next Agent Starter Prompt")) {
    throw new Error("next-agent-prompt.md was not written by cli");
  }
  const drill = await get("/api/takeover-drill");
  if (!drill.canResume) {
    throw new Error(`takeover drill endpoint is not resumable: ${JSON.stringify(drill)}`);
  }
  if (drill.nextAgentBrief?.firstRead?.[0]?.path !== ".project-agent/takeover-summary.json") {
    throw new Error(`takeover drill read order should begin with takeover summary: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/takeover-summary.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable takeover summary: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/agent-context-bundle.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable context bundle: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/continuity-contract.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable continuity contract: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/state-manifest.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable state manifest: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/process-trace.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable process trace: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  if (!drill.nextAgentBrief?.firstRead?.some((item) => item.path === ".project-agent/architecture-map.json" && item.exists)) {
    throw new Error(`takeover drill endpoint missing readable architecture map: ${JSON.stringify(drill.nextAgentBrief?.firstRead)}`);
  }
  const drillStateRefs = drill.nextAgentBrief?.stateRefs || drill.checks?.find((check) => check.id === "state_refs")?.refs || [];
  if (!drillStateRefs.includes(".project-agent/takeover-summary.json") || !drillStateRefs.includes(".project-agent/agent-context-bundle.json") || !drillStateRefs.includes(".project-agent/process-trace.json")) {
    throw new Error(`takeover drill endpoint missing on-demand detail refs: ${JSON.stringify(drillStateRefs)}`);
  }
  if (drill.nextAgentBrief?.schemaVersion !== "project-agent.takeover-packet.v1" || !drill.nextAgentBrief?.nextCommand) {
    throw new Error(`takeover drill endpoint missing next-agent packet schema/command: ${JSON.stringify(drill.nextAgentBrief)}`);
  }
  if (!drill.nextAgentBrief?.agentRunbook?.entrypoint && !drill.nextAgentBrief?.agentRunbook?.steps?.length) {
    throw new Error(`takeover drill endpoint missing agent runbook brief: ${JSON.stringify(drill.nextAgentBrief)}`);
  }
  if (!drill.checks?.some((check) => check.id === "agent_leases" && check.status === "warn")) {
    throw new Error(`takeover drill endpoint missing stale agent lease warning: ${JSON.stringify(drill.checks)}`);
  }
  if (drill.nextAgentBrief?.interruptedWork?.status !== "suspected_interruption" || !drill.nextAgentBrief?.interruptedWork?.items?.some((item) => item.leaseStatus === "stale")) {
    throw new Error(`takeover drill should surface stale interrupted work risk: ${JSON.stringify(drill.nextAgentBrief?.interruptedWork)}`);
  }
  const drillCli = spawnSync("node", ["server/takeover-drill-cli.js", "--project-dir", projectDir, "--json"], { encoding: "utf8" });
  if (drillCli.status !== 0) throw new Error(`takeover drill cli failed: ${drillCli.stderr || drillCli.stdout}`);
  const drillCliJson = JSON.parse(drillCli.stdout);
  if (!drillCliJson.canResume || !drillCliJson.checks?.some((check) => check.id === "first_actions" && check.status === "ok")) {
    throw new Error(`takeover drill cli missing executable protocol: ${drillCli.stdout}`);
  }
  const watchedRelPath = await runtimeEventSocketSmoke();
  await wait(2500);
  const autoSnapshot = await get("/api/handoff-snapshot");
  if (autoSnapshot.snapshot?.status !== "done") {
    throw new Error(`auto handoff snapshot did not complete: ${JSON.stringify(autoSnapshot)}`);
  }
  const autoResumeMarkdown = readFileSync(path.join(projectDir, ".project-agent", "resume.md"), "utf8");
  const autoRecoveryMarkdown = readFileSync(path.join(projectDir, ".project-agent", "recovery.md"), "utf8");
  const autoPromptMarkdown = readFileSync(path.join(projectDir, ".project-agent", "next-agent-prompt.md"), "utf8");
  const autoContextPromptMarkdown = readFileSync(path.join(projectDir, ".project-agent", "context-starter-prompt.md"), "utf8");
  const autoContextDrill = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "context-takeover-drill.json"), "utf8"));
  const autoContinuityAudit = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "continuity-audit.json"), "utf8"));
  if (!autoResumeMarkdown.includes(watchedRelPath)) {
    throw new Error("auto resume.md snapshot did not include watched architecture change");
  }
  if (!autoRecoveryMarkdown.includes(watchedRelPath)) {
    throw new Error("auto recovery.md snapshot did not include watched architecture change");
  }
  if (!autoResumeMarkdown.includes("- status: done") || !autoRecoveryMarkdown.includes("- status: done")) {
    throw new Error("auto handoff documents did not record final done status");
  }
  if (!autoResumeMarkdown.includes("## Workstream Cursor") || !autoRecoveryMarkdown.includes("## Workstream Cursor")) {
    throw new Error("auto handoff documents did not include workstream cursor");
  }
  if (!autoResumeMarkdown.includes("## Takeover Readiness") || !autoRecoveryMarkdown.includes("## Takeover Readiness")) {
    throw new Error("auto handoff documents did not include takeover readiness");
  }
  if (!autoResumeMarkdown.includes("## Interrupted Work") || !autoRecoveryMarkdown.includes("## Interrupted Work")) {
    throw new Error("auto handoff documents did not include interrupted work");
  }
  if (!autoResumeMarkdown.includes("## Project Governance Matrix") || !autoRecoveryMarkdown.includes("## Project Governance Matrix")) {
    throw new Error("auto handoff documents did not include project governance matrix");
  }
  if (!autoResumeMarkdown.includes("## Agent-Neutral Continuity Contract") || !autoRecoveryMarkdown.includes("## Agent-Neutral Continuity Contract")) {
    throw new Error("auto handoff documents did not include continuity contract");
  }
  if (!autoResumeMarkdown.includes("## Memory Graph Trace") || !autoRecoveryMarkdown.includes("## Memory Graph Trace")) {
    throw new Error("auto handoff documents did not include memory graph trace");
  }
  if (!autoResumeMarkdown.includes("## Memory Graph Snapshot") || !autoRecoveryMarkdown.includes("## Memory Graph Snapshot")) {
    throw new Error("auto handoff documents did not include memory graph snapshot");
  }
  if (!autoResumeMarkdown.includes("## Process Trace") || !autoRecoveryMarkdown.includes("## Process Trace")) {
    throw new Error("auto handoff documents did not include process trace");
  }
  if (!autoResumeMarkdown.includes(".project-agent/process-trace.json") || !autoRecoveryMarkdown.includes(".project-agent/process-trace.json")) {
    throw new Error("auto handoff documents did not include process trace file pointer");
  }
  if (!autoResumeMarkdown.includes("## Development Trail") || !autoRecoveryMarkdown.includes("## Development Trail")) {
    throw new Error("auto handoff documents did not include development trail");
  }
  if (!autoResumeMarkdown.includes(".project-agent/development-trail.json") || !autoRecoveryMarkdown.includes(".project-agent/development-trail.json")) {
    throw new Error("auto handoff documents did not include development trail file pointer");
  }
  if (!autoResumeMarkdown.includes("## Takeover Drill") || !autoRecoveryMarkdown.includes("## Takeover Drill")) {
    throw new Error("auto handoff documents did not include takeover drill");
  }
  if (!autoResumeMarkdown.includes("## Next Agent Takeover Packet") || !autoRecoveryMarkdown.includes("## Next Agent Takeover Packet")) {
    throw new Error("auto handoff documents did not include next-agent takeover packet");
  }
  if (!autoResumeMarkdown.includes(".project-agent/takeover-packet.json") || !autoRecoveryMarkdown.includes(".project-agent/takeover-packet.json")) {
    throw new Error("auto handoff documents did not include takeover packet file pointer");
  }
  if (!autoResumeMarkdown.includes("## New Agent Start Protocol") || !autoRecoveryMarkdown.includes("## New Agent Start Protocol")) {
    throw new Error("auto handoff documents did not include start protocol");
  }
  if (!autoPromptMarkdown.includes("Next Agent Starter Prompt") || !autoPromptMarkdown.includes(watchedRelPath)) {
    throw new Error("auto next-agent prompt did not include startup prompt or watched architecture change");
  }
  if (!autoPromptMarkdown.includes(".project-agent/takeover-packet.json") || !autoPromptMarkdown.includes("## Next Command") || !autoPromptMarkdown.includes("## Code Graph")) {
    throw new Error("auto next-agent prompt did not include takeover packet pointer or next command");
  }
  if (!autoPromptMarkdown.includes("## Checkpoint Ledger")) {
    throw new Error("auto next-agent prompt did not include checkpoint ledger");
  }
  if (!autoPromptMarkdown.includes("## State Boundary")) {
    throw new Error("auto next-agent prompt did not include state boundary");
  }
  if (!autoPromptMarkdown.includes("## Temporal Provenance")) {
    throw new Error("auto next-agent prompt did not include temporal provenance");
  }
  if (!autoPromptMarkdown.includes("packed files:") || !autoPromptMarkdown.includes("omitted refs:")) {
    throw new Error("auto next-agent prompt did not include prompt packing details");
  }
  if (!autoPromptMarkdown.includes("backpressure:")) {
    throw new Error("auto next-agent prompt did not include hook backpressure details");
  }
  if (gitSmokeInitialized && (!autoPromptMarkdown.includes("- git:") || !autoPromptMarkdown.includes("dirty tree:"))) {
    throw new Error("auto next-agent prompt did not include git freshness details");
  }
  if (!autoContextPromptMarkdown.includes("Takeover Starter Prompt") || !autoContextPromptMarkdown.includes("## Takeover Gate") || !autoContextPromptMarkdown.includes("## Current State") || !autoContextPromptMarkdown.includes("## Next Step") || !autoContextPromptMarkdown.includes("## Memory Budget") || !autoContextPromptMarkdown.includes("## On-Demand Reads")) {
    throw new Error("auto context-starter prompt did not include summary-first takeover instructions");
  }
  if (!autoContextPromptMarkdown.includes(".project-agent/takeover-summary.json") || !autoContextPromptMarkdown.includes(".project-agent/agent-context-bundle.json")) {
    throw new Error("auto context-starter prompt did not include summary/bundle refs");
  }
  if (autoContextDrill.schemaVersion !== "project-agent.context-takeover-drill.v1" || !autoContextDrill.firstActions?.length || !autoContextDrill.checks?.some((check) => check.id === "bundle_verified")) {
    throw new Error(`auto context takeover drill did not include bundle-only rehearsal: ${JSON.stringify(autoContextDrill)}`);
  }
  if (!autoContinuityAudit.canResume || !autoContinuityAudit.checks?.some((check) => check.id === "process_trace" && check.status === "ok")) {
    throw new Error(`auto continuity audit did not prove process trace: ${JSON.stringify(autoContinuityAudit)}`);
  }
  if (!autoResumeMarkdown.includes("## Agent Runbook") || !autoRecoveryMarkdown.includes("## Agent Runbook")) {
    throw new Error("auto handoff documents did not include agent runbook");
  }
  if (!autoResumeMarkdown.includes("## Architecture Map Snapshot") || !autoRecoveryMarkdown.includes("## Architecture Map Snapshot")) {
    throw new Error("auto handoff documents did not include architecture map snapshot");
  }
  if (!autoResumeMarkdown.includes(".project-agent/architecture-map.json") || !autoRecoveryMarkdown.includes(".project-agent/architecture-map.json")) {
    throw new Error("auto handoff documents did not include architecture map file pointer");
  }
  if (!autoResumeMarkdown.includes("## Architecture Impact") || !autoRecoveryMarkdown.includes("## Architecture Impact")) {
    throw new Error("auto handoff documents did not include architecture impact");
  }
  if (!autoResumeMarkdown.includes("## Architecture Trace") || !autoRecoveryMarkdown.includes("## Architecture Trace")) {
    throw new Error("auto handoff documents did not include architecture trace");
  }
  const autoInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (autoInsights.continuity?.handoffSnapshot?.status !== "done") {
    throw new Error(`handoff snapshot missing from continuity: ${JSON.stringify(autoInsights.continuity?.handoffSnapshot)}`);
  }
  if (!autoInsights.continuity?.takeoverReadiness?.canTakeOver) {
    throw new Error(`takeover readiness failed after auto snapshot: ${JSON.stringify(autoInsights.continuity?.takeoverReadiness)}`);
  }
  await terminalSmoke(goalId);
  const action = await post("/api/actions", {
    goalId,
    title: "Run terminal smoke",
    activity: "implementation",
    role: "coding_agent"
  });
  await post("/api/evidence", {
    goalId,
    kind: "document",
    ref: "PROJECT.md",
    summary: "Kernel endpoint works",
    verifies: ["ac_1", action.action.id]
  });
  await post(`/api/actions/${action.action.id}`, { status: "done" });
  const audit = await get(`/api/audit/${goalId}`);
  if (!audit.canComplete) throw new Error(`audit failed unexpectedly: ${JSON.stringify(audit)}`);
  const finalInsights = await get(`/api/insights?role=coding_agent&goal=${goalId}`);
  if (!finalInsights.targets?.some((target) => target.id === "ac_1" && target.verified)) {
    throw new Error(`insights did not expose verified acceptance target: ${JSON.stringify(finalInsights.targets)}`);
  }
  if (!finalInsights.graph?.edges?.some((edge) => edge.source === "evidence" && edge.target === "audit")) {
    throw new Error("insights missing evidence->audit graph edge");
  }
  if (!finalInsights.process?.events?.some((event) => event.title.includes("Evidence saved") || event.title.includes("Command evidence saved"))) {
    throw new Error(`insights missing dynamic process evidence event: ${JSON.stringify(finalInsights.process?.events)}`);
  }
  if (!finalInsights.continuity?.workstreams?.active?.id) {
    throw new Error(`continuity missing active workstream: ${JSON.stringify(finalInsights.continuity?.workstreams)}`);
  }
  if (!finalInsights.continuity?.architectureImpact?.folders?.length) {
    throw new Error(`continuity missing architecture impact: ${JSON.stringify(finalInsights.continuity?.architectureImpact)}`);
  }
  if (!finalInsights.continuity?.takeoverReadiness?.checks?.some((check) => check.id === "cursor" && check.status === "ok")) {
    throw new Error(`continuity missing cursor readiness check: ${JSON.stringify(finalInsights.continuity?.takeoverReadiness)}`);
  }
  if (!finalInsights.continuity?.startProtocol?.firstActions?.some((item) => item.action.includes("Record a current event"))) {
    throw new Error(`continuity missing executable start protocol: ${JSON.stringify(finalInsights.continuity?.startProtocol)}`);
  }
  if (!finalInsights.continuity?.takeoverDrill?.canResume) {
    throw new Error(`continuity takeover drill cannot resume: ${JSON.stringify(finalInsights.continuity?.takeoverDrill)}`);
  }
  if (!finalInsights.continuity?.governance?.domains?.some((domain) => domain.id === "architecture_management")) {
    throw new Error(`continuity missing architecture governance domain: ${JSON.stringify(finalInsights.continuity?.governance)}`);
  }
  if (!finalInsights.continuity?.graphTrace?.provenanceCoverage) {
    throw new Error(`continuity missing graph trace provenance coverage: ${JSON.stringify(finalInsights.continuity?.graphTrace)}`);
  }
  if (!finalInsights.continuity?.memoryGraph?.nodes?.length || !finalInsights.continuity?.memoryGraph?.edges?.length) {
    throw new Error(`continuity missing durable memory graph: ${JSON.stringify(finalInsights.continuity?.memoryGraph)}`);
  }
  if (finalInsights.continuity?.processTrace?.schemaVersion !== "project-agent.process-trace.v1") {
    throw new Error(`continuity missing durable process trace schema: ${JSON.stringify(finalInsights.continuity?.processTrace)}`);
  }
  if (!finalInsights.continuity?.processTrace?.inspectOrder?.length) {
    throw new Error(`continuity missing process trace inspect order: ${JSON.stringify(finalInsights.continuity?.processTrace)}`);
  }
  if (finalInsights.continuity?.developmentTrail?.schemaVersion !== "project-agent.development-trail.v1" || !finalInsights.continuity?.developmentTrail?.current || !finalInsights.continuity?.developmentTrail?.inspectOrder?.length) {
    throw new Error(`continuity missing process-to-architecture development trail: ${JSON.stringify(finalInsights.continuity?.developmentTrail)}`);
  }
  if (finalInsights.continuity?.architectureMap?.schemaVersion !== "project-agent.architecture-map.v1") {
    throw new Error(`continuity missing durable architecture map schema: ${JSON.stringify(finalInsights.continuity?.architectureMap)}`);
  }
  if (!finalInsights.continuity?.architectureMap?.tree?.length || !finalInsights.continuity?.architectureMap?.inspectOrder?.length) {
    throw new Error(`continuity missing architecture map tree/inspect order: ${JSON.stringify(finalInsights.continuity?.architectureMap)}`);
  }
  if (finalInsights.continuity?.codeGraph?.schemaVersion !== "project-agent.code-graph.v1" || !finalInsights.continuity?.architectureMap?.codeGraph?.edges?.some((edge) => edge.source === "src/dep-entry.js" && edge.target === "src/dep-target.js")) {
    throw new Error(`continuity missing durable code graph: ${JSON.stringify(finalInsights.continuity?.codeGraph || finalInsights.continuity?.architectureMap?.codeGraph)}`);
  }
  if (finalInsights.continuity?.takeoverPacket?.schemaVersion !== "project-agent.takeover-packet.v1" || !finalInsights.continuity?.takeoverPacket?.firstActions?.length) {
    throw new Error(`continuity missing durable takeover packet: ${JSON.stringify(finalInsights.continuity?.takeoverPacket)}`);
  }
  if (finalInsights.continuity?.continuityAudit?.schemaVersion !== "project-agent.continuity-audit.v1" || !finalInsights.continuity?.continuityAudit?.canResume || !finalInsights.continuity?.continuityAudit?.checks?.some((check) => check.id === "starter_prompt")) {
    throw new Error(`continuity missing visible continuity audit: ${JSON.stringify(finalInsights.continuity?.continuityAudit)}`);
  }
  if (finalInsights.continuity?.continuityAudit?.stateManifestVerification?.schemaVersion !== "project-agent.state-manifest-verification.v1") {
    throw new Error(`continuity audit missing visible manifest verification: ${JSON.stringify(finalInsights.continuity?.continuityAudit?.stateManifestVerification)}`);
  }
  if (!finalInsights.continuity?.architectureTrace?.topFolders?.length) {
    throw new Error(`continuity missing architecture trace top folders: ${JSON.stringify(finalInsights.continuity?.architectureTrace)}`);
  }
  if (!finalInsights.continuity?.continuityContract?.inspectOrder?.process?.length) {
    throw new Error(`continuity contract missing process inspect order: ${JSON.stringify(finalInsights.continuity?.continuityContract)}`);
  }
  if (!finalInsights.continuity?.agentRunbook?.stateMachine?.transitions?.length) {
    throw new Error(`continuity missing executable agent state machine: ${JSON.stringify(finalInsights.continuity?.agentRunbook)}`);
  }
  if (!finalInsights.continuity?.agentRunbook?.steps?.some((step) => step.status === "current")) {
    throw new Error(`continuity runbook missing current step: ${JSON.stringify(finalInsights.continuity?.agentRunbook?.steps)}`);
  }
  if (!finalInsights.continuity?.agentRunbook?.steps?.some((step) => step.id === "verify_state_manifest")) {
    throw new Error(`continuity runbook missing manifest verification step: ${JSON.stringify(finalInsights.continuity?.agentRunbook?.steps)}`);
  }
  if (finalInsights.continuity?.preEditRisk?.schemaVersion !== "project-agent.pre-edit-risk.v1" || !finalInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "architecture_impact")) {
    throw new Error(`continuity missing pre-edit risk: ${JSON.stringify(finalInsights.continuity?.preEditRisk)}`);
  }
  if (!finalInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "dependency_impact")) {
    throw new Error(`continuity missing dependency impact risk check: ${JSON.stringify(finalInsights.continuity?.preEditRisk)}`);
  }
  if (finalInsights.continuity?.handoffLifecycle?.schemaVersion !== "project-agent.handoff-lifecycle.v1" || !finalInsights.continuity?.continuityContract?.handoffLifecycle?.status) {
    throw new Error(`continuity missing typed handoff lifecycle: ${JSON.stringify(finalInsights.continuity?.handoffLifecycle)}`);
  }
  if (finalInsights.continuity?.freshnessGate?.schemaVersion !== "project-agent.freshness-gate.v1" || !finalInsights.continuity?.continuityContract?.freshnessGate?.status) {
    throw new Error(`continuity missing temporal freshness gate: ${JSON.stringify(finalInsights.continuity?.freshnessGate)}`);
  }
  if (gitSmokeInitialized && (finalInsights.continuity?.freshnessGate?.git?.schemaVersion !== "project-agent.git-freshness.v1" || finalInsights.continuity?.freshnessGate?.git?.repo?.available !== true || !finalInsights.continuity?.freshnessGate?.checks?.some((check) => check.id === "git_snapshot"))) {
    throw new Error(`continuity missing git freshness audit: ${JSON.stringify(finalInsights.continuity?.freshnessGate)}`);
  }
  if (finalInsights.continuity?.runtimeEval?.schemaVersion !== "project-agent.runtime-eval.v1" || !finalInsights.continuity?.continuityContract?.runtimeEval?.score || !finalInsights.continuity?.runtimeEval?.checks?.some((check) => check.id === "span_capture")) {
    throw new Error(`continuity missing runtime trace eval: ${JSON.stringify(finalInsights.continuity?.runtimeEval)}`);
  }
  if (finalInsights.continuity?.phaseLedger?.schemaVersion !== "project-agent.phase-ledger.v1" || !finalInsights.continuity?.continuityContract?.phaseLedger?.status || !finalInsights.continuity?.phaseLedger?.checks?.some((check) => check.id === "parent_links")) {
    throw new Error(`continuity missing phase ledger: ${JSON.stringify(finalInsights.continuity?.phaseLedger)}`);
  }
  if (finalInsights.continuity?.checkpointLedger?.schemaVersion !== "project-agent.checkpoint-ledger.v1" || !finalInsights.continuity?.continuityContract?.checkpointLedger?.status || !finalInsights.continuity?.checkpointLedger?.checks?.some((check) => check.id === "resume_points")) {
    throw new Error(`continuity missing checkpoint ledger: ${JSON.stringify(finalInsights.continuity?.checkpointLedger)}`);
  }
  if (finalInsights.continuity?.decisionLedger?.schemaVersion !== "project-agent.decision-ledger.v1" || !finalInsights.continuity?.continuityContract?.decisionLedger?.status || !finalInsights.continuity?.decisionLedger?.checks?.some((check) => check.id === "source_refs") || !finalInsights.continuity?.decisionLedger?.decisions?.some((item) => item.id === "product:temporal_provenance" && item.sourceHash && item.validFrom)) {
    throw new Error(`continuity missing decision ledger: ${JSON.stringify(finalInsights.continuity?.decisionLedger)}`);
  }
  if (finalInsights.continuity?.temporalProvenance?.schemaVersion !== "project-agent.temporal-provenance-audit.v1" || !finalInsights.continuity?.continuityContract?.temporalProvenance?.status || !finalInsights.continuity?.continuityContract?.capabilities?.some((item) => item.id === "temporal_provenance") || !finalInsights.continuity?.temporalProvenance?.facts?.some((item) => item.id === "decision:product:temporal_provenance" && item.sourceHash && item.validFrom) || !finalInsights.continuity?.temporalProvenance?.checks?.some((check) => check.id === "stale_sources") || !finalInsights.continuity?.temporalProvenance?.checks?.some((check) => check.id === "contradictions")) {
    throw new Error(`continuity missing temporal provenance audit: ${JSON.stringify(finalInsights.continuity?.temporalProvenance)}`);
  }
  if (finalInsights.continuity?.stateBoundary?.schemaVersion !== "project-agent.state-boundary-audit.v1" || !finalInsights.continuity?.continuityContract?.stateBoundary?.status || !finalInsights.continuity?.stateBoundary?.checks?.some((check) => check.id === "disclosure_outputs_separate") || !finalInsights.continuity?.stateBoundary?.layers?.some((layer) => layer.id === "derived_indexes" && layer.derivedFrom?.length)) {
    throw new Error(`continuity missing state boundary audit: ${JSON.stringify(finalInsights.continuity?.stateBoundary)}`);
  }
  if (finalInsights.continuity?.hookIngressAudit?.schemaVersion !== "project-agent.hook-ingress-audit.v1" || !finalInsights.continuity?.continuityContract?.hookIngressAudit?.status) {
    throw new Error(`continuity missing hook ingress audit: ${JSON.stringify(finalInsights.continuity?.hookIngressAudit)}`);
  }
  if (finalInsights.continuity?.hookIngressAudit?.backpressure?.schemaVersion !== "project-agent.hook-backpressure-audit.v1" || finalInsights.continuity?.hookIngressAudit?.saturatedAttempts < 1) {
    throw new Error(`continuity missing final hook backpressure audit: ${JSON.stringify(finalInsights.continuity?.hookIngressAudit)}`);
  }
  const finalBundle = finalInsights.continuity?.agentContextBundle || {};
  const finalValidation = finalBundle.validation || {};
  const finalAttentionIds = new Set((finalValidation.attentionPack?.items || []).map((item) => item.id));
  const finalClaimIds = new Set((finalValidation.provenanceLedger?.claims || []).map((claim) => claim.id));
  const finalCodeGraphSchema = finalBundle.architecture?.codeGraph?.schemaVersion;
  const requiredClaims = ["state_manifest", "phase_ledger", "decision_ledger", "state_boundary", "code_graph", "hook_ingress"];
  const bundleFailures = [
    finalBundle.schemaVersion !== "project-agent.context-bundle.v1" ? "bundle_schema" : "",
    !finalValidation.stateManifestVerification?.ok ? "state_manifest_verification" : "",
    !finalValidation.agentContextBundleVerification?.canResume ? "bundle_verification" : "",
    !["project-agent.code-graph.v1", "project-agent.code-graph-summary.v1"].includes(finalCodeGraphSchema) ? "code_graph_schema" : "",
    finalValidation.disclosureGate?.schemaVersion !== "project-agent.disclosure-gate.v1" ? "disclosure_gate" : "",
    finalValidation.freshnessGate?.schemaVersion !== "project-agent.freshness-gate.v1" ? "freshness_gate" : "",
    finalValidation.phaseLedger?.schemaVersion !== "project-agent.phase-ledger.v1" ? "phase_ledger" : "",
    finalValidation.decisionLedger?.schemaVersion !== "project-agent.decision-ledger.v1" ? "decision_ledger" : "",
    finalValidation.stateBoundary?.schemaVersion !== "project-agent.state-boundary-audit.v1" ? "state_boundary" : "",
    finalValidation.runtimeEval?.schemaVersion !== "project-agent.runtime-eval.v1" ? "runtime_eval" : "",
    finalValidation.hookIngressAudit?.schemaVersion !== "project-agent.hook-ingress-audit.v1" ? "hook_ingress" : "",
    finalValidation.provenanceLedger?.schemaVersion !== "project-agent.provenance-ledger.v1" ? "provenance_ledger" : "",
    !requiredClaims.every((id) => finalClaimIds.has(id)) ? `claims:${requiredClaims.filter((id) => !finalClaimIds.has(id)).join(",")}` : "",
    finalValidation.attentionPack?.schemaVersion !== "project-agent.attention-pack.v1" || !finalAttentionIds.size ? "attention_pack" : "",
    finalValidation.preEditRisk?.schemaVersion !== "project-agent.pre-edit-risk.v1" ? "pre_edit_risk" : "",
    finalBundle.handoff?.lifecycle?.schemaVersion !== "project-agent.handoff-lifecycle.v1" ? "handoff_lifecycle" : ""
  ].filter(Boolean);
  if (bundleFailures.length) {
    throw new Error(`continuity missing visible agent context bundle (${bundleFailures.join(", ")}): ${JSON.stringify(finalInsights.continuity?.agentContextBundle)}`);
  }
  if (finalInsights.continuity?.agentContextBundle?.validation?.temporalProvenance?.schemaVersion !== "project-agent.temporal-provenance-audit.v1" || !finalInsights.continuity?.agentContextBundle?.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "temporal_provenance") || !finalInsights.continuity?.agentContextBundle?.validation?.provenanceLedger?.claims?.some((claim) => claim.id === "temporal_provenance")) {
    throw new Error(`agent context bundle missing temporal provenance provenance/attention: ${JSON.stringify(finalInsights.continuity?.agentContextBundle?.validation?.temporalProvenance)}`);
  }
  if (finalInsights.continuity?.agentContextBundle?.validation?.disclosureGate?.packing?.schemaVersion !== "project-agent.prompt-packing-gate.v1" || !finalInsights.continuity?.agentContextBundle?.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "prompt_packing_gate")) {
    throw new Error(`agent context bundle missing prompt packing gate: ${JSON.stringify(finalInsights.continuity?.agentContextBundle?.validation?.disclosureGate)}`);
  }
  if (finalInsights.continuity?.agentContextBundle?.validation?.checkpointLedger?.schemaVersion !== "project-agent.checkpoint-ledger.v1" || !finalInsights.continuity?.agentContextBundle?.validation?.provenanceLedger?.claims?.some((claim) => claim.id === "checkpoint_ledger")) {
    throw new Error(`agent context bundle missing checkpoint ledger provenance/attention: ${JSON.stringify(finalInsights.continuity?.agentContextBundle?.validation?.checkpointLedger)}`);
  }
  if (!["project-agent.development-trail.v1", "project-agent.development-trail-summary.v1"].includes(finalInsights.continuity?.agentContextBundle?.process?.developmentTrail?.schemaVersion) || !finalInsights.continuity?.agentContextBundle?.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "development_trail")) {
    throw new Error(`agent context bundle missing verified development trail: ${JSON.stringify(finalInsights.continuity?.agentContextBundle?.process?.developmentTrail)}`);
  }
  if (finalInsights.continuity?.takeoverAcceptanceAudit?.schemaVersion !== "project-agent.takeover-acceptance-audit.v1" || !finalInsights.continuity?.takeoverAcceptanceAudit?.rows?.some((row) => row.id === "memory_visible_knowledge_graph") || !finalInsights.continuity?.agentContextBundle?.validation?.agentContextBundleVerification?.checks?.some((check) => check.id === "takeover_acceptance_audit")) {
    throw new Error(`continuity missing user-objective takeover acceptance audit: ${JSON.stringify(finalInsights.continuity?.takeoverAcceptanceAudit)}`);
  }
  if (finalInsights.continuity?.governanceSpec?.schemaVersion !== "project-agent.governance-spec.v1" || !finalInsights.continuity?.governanceSpec?.requirements?.every((item) => item.evidence?.length)) {
    throw new Error(`continuity missing evidence-backed governance spec: ${JSON.stringify(finalInsights.continuity?.governanceSpec)}`);
  }
  if (finalInsights.continuity?.objectiveCoverage?.schemaVersion !== "project-agent.objective-coverage.v1" || !finalInsights.continuity?.objectiveCoverage?.proofSources?.some((item) => item.id === "dynamic_process")) {
    throw new Error(`continuity missing objective coverage proof sources: ${JSON.stringify(finalInsights.continuity?.objectiveCoverage)}`);
  }
  const appSource = readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");
  if (!appSource.includes("HealthStrip") || !appSource.includes("data-health-strip") || !appSource.includes("/health") || !appSource.includes("Reconnect")) {
    throw new Error("UI source missing visible health/reconnect strip");
  }
  if (!appSource.includes("StateTransferPanel") || !appSource.includes("data-state-transfer") || !appSource.includes("/state/export") || !appSource.includes("/state/import") || !appSource.includes("Preview Import")) {
    throw new Error("UI source missing visible state import/export surface");
  }
  if (!appSource.includes("ProjectLauncherPanel") || !appSource.includes("data-project-launcher") || !appSource.includes("/projects/register") || !appSource.includes("/projects/launch") || !appSource.includes("/projects/stop") || !appSource.includes("/projects/restart") || !appSource.includes("/projects/logs") || !appSource.includes("data-launcher-logs") || !appSource.includes("Project Launcher")) {
    throw new Error("UI source missing visible multi-project launcher surface");
  }
  if (!appSource.includes("AgentBootstrapPanel") || !appSource.includes("data-agent-bootstrap") || !appSource.includes("/agent/bootstrap") || !appSource.includes("project_memory_harness") || !appSource.includes("project_takeover_summary") || !appSource.includes("no manual json")) {
    throw new Error("UI source missing visible agent bootstrap harness surface");
  }
  if (!appSource.includes("data-memory-lifecycle") || !appSource.includes("Dogfood") || !appSource.includes("Retention") || !appSource.includes("memory-lifecycle-strip")) {
    throw new Error("UI source missing visible P0 memory lifecycle surface");
  }
  if (!appSource.includes("SandboxPermissionPanel") || !appSource.includes("data-sandbox-guidance") || !appSource.includes("/security/sandbox") || !appSource.includes("Sandbox & Permissions")) {
    throw new Error("UI source missing visible sandbox and permission guidance surface");
  }
  if (!appSource.includes("AuthUnlockPanel") || !appSource.includes("data-auth-unlock") || !appSource.includes("project-agent-auth-token") || !appSource.includes("authToken=")) {
    throw new Error("UI source missing optional auth unlock/token propagation surface");
  }
  if (!appSource.includes("GovernanceSpecPanel") || !appSource.includes("data-governance-spec")) {
    throw new Error("UI source missing visible governance spec panel");
  }
  if (!appSource.includes("data-state-manifest") || !appSource.includes("State Manifest")) {
    throw new Error("UI source missing visible state manifest panel");
  }
  if (!appSource.includes("data-agent-context-bundle") || !appSource.includes("Agent Context Bundle") || !appSource.includes("contextBundleVerification") || !appSource.includes("objectiveCoverage") || !appSource.includes("contextTakeoverDrill")) {
    throw new Error("UI source missing visible agent context bundle panel");
  }
  if (!appSource.includes("ObjectiveCoveragePanel") || !appSource.includes("data-objective-coverage") || !appSource.includes("Objective Coverage")) {
    throw new Error("UI source missing visible objective coverage panel");
  }
  if (!appSource.includes("data-code-graph-symbols") || !appSource.includes("symbolDependents") || !appSource.includes("symbols {")) {
    throw new Error("UI source missing visible symbol-level code graph surface");
  }
  if (!appSource.includes("DevelopmentTrailPanel") || !appSource.includes("data-development-trail") || !appSource.includes("Development Trail")) {
    throw new Error("UI source missing visible process-to-architecture development trail");
  }
  if (!appSource.includes("PreEditRiskPanel") || !appSource.includes("data-pre-edit-risk") || !appSource.includes("Pre-Edit Risk")) {
    throw new Error("UI source missing visible pre-edit risk panel");
  }
  if (!appSource.includes("FreshnessGatePanel") || !appSource.includes("data-freshness-gate") || !appSource.includes("Freshness Gate")) {
    throw new Error("UI source missing visible freshness gate panel");
  }
  if (!appSource.includes("RuntimeEvalPanel") || !appSource.includes("data-runtime-eval") || !appSource.includes("Runtime Eval")) {
    throw new Error("UI source missing visible runtime eval panel");
  }
  if (!appSource.includes("PhaseLedgerPanel") || !appSource.includes("data-phase-ledger") || !appSource.includes("Phase Ledger")) {
    throw new Error("UI source missing visible phase ledger panel");
  }
  if (!appSource.includes("CheckpointLedgerPanel") || !appSource.includes("data-checkpoint-ledger") || !appSource.includes("Checkpoint Ledger")) {
    throw new Error("UI source missing visible checkpoint ledger panel");
  }
  if (!appSource.includes("DecisionLedgerPanel") || !appSource.includes("data-decision-ledger") || !appSource.includes("Decision Ledger")) {
    throw new Error("UI source missing visible decision ledger panel");
  }
  if (!appSource.includes("TemporalProvenancePanel") || !appSource.includes("data-temporal-provenance") || !appSource.includes("Temporal Provenance") || !appSource.includes("temporal-fact-grid")) {
    throw new Error("UI source missing visible temporal provenance panel");
  }
  if (!appSource.includes("CodeGraphPanel") || !appSource.includes("data-code-graph") || !appSource.includes("Code Graph")) {
    throw new Error("UI source missing visible code graph panel");
  }
  if (!appSource.includes("HookIngressPanel") || !appSource.includes("data-hook-ingress") || !appSource.includes("Hook Ingress")) {
    throw new Error("UI source missing visible hook ingress panel");
  }
  if (!appSource.includes("hook-ingress-attempts") || !appSource.includes("backpressure") || !appSource.includes("recentAttempts")) {
    throw new Error("UI source missing visible hook backpressure details");
  }
  if (!appSource.includes("ProvenanceLedgerPanel") || !appSource.includes("data-provenance-ledger") || !appSource.includes("Provenance Ledger")) {
    throw new Error("UI source missing visible provenance ledger panel");
  }
  if (!appSource.includes("StateBoundaryPanel") || !appSource.includes("data-state-boundary") || !appSource.includes("State Boundary") || !appSource.includes("state-boundary-layers")) {
    throw new Error("UI source missing visible state boundary panel");
  }
  if (!appSource.includes("AttentionPackPanel") || !appSource.includes("data-attention-pack") || !appSource.includes("Attention Pack")) {
    throw new Error("UI source missing visible attention pack panel");
  }
  if (!appSource.includes("packingTotals") || !appSource.includes("disclosure-omitted") || !appSource.includes("omittedRefs")) {
    throw new Error("UI source missing visible prompt packing gate details");
  }
  if (!appSource.includes("HandoffLifecyclePanel") || !appSource.includes("data-handoff-lifecycle") || !appSource.includes("Handoff Lifecycle")) {
    throw new Error("UI source missing visible handoff lifecycle panel");
  }
  if (!appSource.includes("git {git.status") || !appSource.includes("dirty {git.dirty?.entries") || !appSource.includes("untracked {git.dirty?.untracked")) {
    throw new Error("UI source missing visible git freshness details");
  }
  if (!appSource.includes("TakeoverAcceptancePanel") || !appSource.includes("data-takeover-acceptance") || !appSource.includes("Takeover Acceptance")) {
    throw new Error("UI source missing visible takeover acceptance audit");
  }
  const developmentTrailEndpoint = await get("/api/development-trail");
  if (developmentTrailEndpoint.developmentTrail?.schemaVersion !== "project-agent.development-trail.v1" || !developmentTrailEndpoint.developmentTrail?.inspectOrder?.length) {
    throw new Error(`development trail endpoint missing durable trail: ${JSON.stringify(developmentTrailEndpoint)}`);
  }
  const takeoverAcceptanceEndpoint = await get("/api/takeover-acceptance-audit?write=1");
  if (takeoverAcceptanceEndpoint.takeoverAcceptanceAudit?.schemaVersion !== "project-agent.takeover-acceptance-audit.v1" || !takeoverAcceptanceEndpoint.takeoverAcceptanceAudit?.rows?.some((row) => row.id === "architecture_visible_managed")) {
    throw new Error(`takeover acceptance endpoint missing user-objective rows: ${JSON.stringify(takeoverAcceptanceEndpoint)}`);
  }
  const acceptanceCli = spawnSync("node", ["server/takeover-acceptance-audit-cli.js", "--project-dir", projectDir, "--write", "--verify"], { encoding: "utf8" });
  if (acceptanceCli.status !== 0) throw new Error(`takeover acceptance cli failed: ${acceptanceCli.stderr || acceptanceCli.stdout}`);
  const acceptanceCliJson = JSON.parse(acceptanceCli.stdout);
  if (acceptanceCliJson.schemaVersion !== "project-agent.takeover-acceptance-audit.v1" || !acceptanceCliJson.rows?.some((row) => row.id === "process_dynamic_previous_current_next")) {
    throw new Error(`takeover acceptance cli missing dynamic process row: ${acceptanceCli.stdout}`);
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("agent-context-bundle.json")) {
    throw new Error("AGENTS.md missing agent context bundle instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("context-starter-prompt.md")) {
    throw new Error("AGENTS.md missing context starter prompt instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("context-takeover-drill.json")) {
    throw new Error("AGENTS.md missing context takeover drill instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("development-trail.json")) {
    throw new Error("AGENTS.md missing development trail instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("takeover-acceptance-audit.json")) {
    throw new Error("AGENTS.md missing takeover acceptance audit instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("governance-spec.json")) {
    throw new Error("AGENTS.md missing governance spec instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("continuity-contract.json")) {
    throw new Error("AGENTS.md missing continuity contract instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("process-trace.json")) {
    throw new Error("AGENTS.md missing process trace instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("architecture-map.json")) {
    throw new Error("AGENTS.md missing architecture map instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("state-manifest.json")) {
    throw new Error("AGENTS.md missing state manifest instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("npm run manifest")) {
    throw new Error("AGENTS.md missing state manifest verification command");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("takeover-packet.json")) {
    throw new Error("AGENTS.md missing takeover packet instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("continuity-audit.json")) {
    throw new Error("AGENTS.md missing continuity audit instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("next-agent-prompt.md")) {
    throw new Error("AGENTS.md missing next-agent prompt instructions");
  }
  if (!readFileSync(path.join(projectDir, "AGENTS.md"), "utf8").includes("startProtocol.firstActions")) {
    throw new Error("AGENTS.md missing startProtocol instructions");
  }
  if (!finalInsights.knowledgeGraph?.edges?.some((edge) => edge.label === "verifies")) {
    throw new Error("insights knowledge graph missing verification edge");
  }
  console.log("smoke ok");
} finally {
  child.kill("SIGTERM");
  if (ownsProjectDir) rmSync(projectDir, { recursive: true, force: true });
}
