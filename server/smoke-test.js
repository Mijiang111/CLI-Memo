import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const port = Number(process.env.PORT || 4147);
const base = `http://127.0.0.1:${port}`;
const ownsProjectDir = !process.env.PROJECT_DIR;
const projectDir = process.env.PROJECT_DIR || mkdtempSync(path.join(os.tmpdir(), "project-agent-terminal-smoke-"));
const gitSmokeInitialized = ownsProjectDir && spawnSync("git", ["init"], { cwd: projectDir, encoding: "utf8" }).status === 0;

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

const child = spawn("node", ["server/index.js"], {
  env: {
    ...process.env,
    PROJECT_DIR: projectDir,
    PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForServer();
  const config = await get("/api/config");
  if (!config.projectDir) throw new Error("missing projectDir");
  await post("/api/init", { name: "smoke" });
  const created = await post("/api/goals", {
    objective: "Smoke test Project Agent Terminal",
    acceptance: ["Kernel endpoint works"]
  });
  const goalId = created.goal.id;
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
  const stateManifestFile = JSON.parse(readFileSync(path.join(projectDir, ".project-agent", "state-manifest.json"), "utf8"));
  if (stateManifestFile.schemaVersion !== "project-agent.state-manifest.v1" || !stateManifestFile.aggregateHash || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-summary.json") || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-packet.json" && file.sha256) || !stateManifestFile.files?.some((file) => file.path === ".project-agent/development-trail.json" && file.sha256) || !stateManifestFile.files?.some((file) => file.path === ".project-agent/takeover-acceptance-audit.json" && file.sha256)) {
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
  writeFileSync(path.join(projectDir, "src", "dep-target.js"), "export const dependencyTarget = \"target\";\n", "utf8");
  writeFileSync(path.join(projectDir, "src", "dep-entry.js"), "import { dependencyTarget } from \"./dep-target.js\";\nexport const dependencyEntry = dependencyTarget;\n", "utf8");
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
      { path: "src/dep-entry.js", status: "added", summary: "+2/-0" }
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
  if (!codeWorkstreamInsights.continuity?.preEditRisk?.checks?.some((check) => check.id === "dependency_impact" && check.refs?.includes("src/dep-entry.js"))) {
    throw new Error(`pre-edit risk missing dependency impact check: ${JSON.stringify(codeWorkstreamInsights.continuity?.preEditRisk)}`);
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
