#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildArchitecture } from "./architecture.js";
import { buildContinuityAudit, writeContinuityAudit } from "./continuity-audit.js";
import { defaultContextQuery, readContextRef, searchContext } from "./grep-context.js";
import { buildInsights } from "./insights.js";
import { buildAgentDoctor } from "./agent-doctor.js";
import { searchCodeGraph } from "./code-search.js";
import {
  addMemory,
  auditMemoryPrivacy,
  auditMemoryRetention,
  buildMemoryInventory,
  buildMemoryHarness,
  cleanupGeneratedMemoryState,
  consolidateMemory,
  consolidateMemoryV2,
  ensureMemoryStore,
  forgetMemory,
  inspectMemoryEntityIndex,
  inspectMemorySearchIndex,
  memoryStoreRefs,
  queryMemoryAccessAudit,
  queryMemoryAudit,
  readMemory,
  rebuildAllMemoryIndexes,
  rebuildMemoryEntityIndex,
  rebuildMemorySearchIndex,
  rebuildMemoryVectorIndex,
  seedDogfoodMemory,
  searchMemory,
  supersedeMemory,
  sweepMemoryRetention,
  updateMemory
} from "./memory-store.js";
import { readState, runJson, runProjectAgent, summarizeState } from "./project-agent.js";
import {
  buildAgentContextBundle,
  buildTakeoverSummary,
  ingestHookEvents,
  readAgentContextBundle,
  readArchitectureMap,
  readContinuity,
  readRuntime,
  readStateManifest,
  readTakeoverAcceptanceAudit,
  readTakeoverSummary,
  summarizeAgentLeases,
  verifyAgentContextBundle,
  verifyStateManifest,
  writeAgentContextBundle,
  writeContinuity,
  writeTakeoverSummary
} from "./runtime-state.js";
import { refreshTakeoverAcceptanceAudit } from "./takeover-acceptance-audit.js";
import { attachTakeoverDrill } from "./takeover-drill.js";

const args = process.argv.slice(2);

function valueAfter(flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function has(flag) {
  return args.includes(flag);
}

function usage() {
  return `Usage:
  node server/project-mcp.js --project-dir /path/to/project

Options:
  --project-dir PATH   Default project root. Defaults to PROJECT_DIR or cwd.
  --help               Print this message.
`;
}

if (has("--help") || has("-h")) {
  console.log(usage());
  process.exit(0);
}

const defaultProjectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const EXPECTED_HANDOFF_FILES = [
  ".project-agent/continuity-audit.json",
  ".project-agent/takeover-acceptance-audit.json",
  ".project-agent/state-manifest.json"
];

const ProjectDirSchema = {
  projectDir: z.string().optional().describe("Project root. Defaults to the MCP server PROJECT_DIR or cwd.")
};

const FileChangeSchema = z.object({
  path: z.string(),
  status: z.string().optional(),
  kind: z.string().optional(),
  summary: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  hash: z.string().optional()
});

function resolveProjectDir(input = {}) {
  return path.resolve(input.projectDir || defaultProjectDir);
}

function stateFilePath(projectDir, name = "state.json") {
  return path.join(projectDir, ".project-agent", name);
}

function isProjectStarted(projectDir) {
  return existsSync(stateFilePath(projectDir));
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function toolResult(payload) {
  const structuredContent = jsonSafe(payload);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

function toolError(error, context = {}) {
  const payload = {
    ok: false,
    error: error?.message || String(error),
    ...context
  };
  return {
    ...toolResult(payload),
    isError: true
  };
}

function uniqueItems(items = [], limit = 24) {
  return [...new Set((items || []).filter(Boolean))].slice(0, limit);
}

function startNextStep(projectDir) {
  return {
    tool: "project_start",
    command: "Call MCP tool project_start with the projectDir and optional name/objective.",
    arguments: {
      projectDir,
      name: path.basename(projectDir),
      objective: "Optional first goal",
      acceptance: ["Optional acceptance criterion"]
    }
  };
}

function notStartedTakeover(projectDir) {
  return {
    schemaVersion: "project-agent.takeover-summary.v1",
    lifecycle: "not_started",
    status: "not_started",
    generatedAt: new Date().toISOString(),
    project: path.basename(projectDir),
    purpose: "Project has not been started yet; no handoff refs are available.",
    defaultReadOrder: [],
    activeGoal: null,
    currentState: {
      phase: "observe",
      status: "not_started",
      title: "Project not started",
      detail: "No .project-agent/state.json exists yet. Start the project before reading takeover refs.",
      refs: []
    },
    nextStep: {
      command: "project_start",
      expected: {
        title: "Initialize project state",
        detail: "Create the project kernel, durable state files, and first handoff snapshot."
      },
      mcp: startNextStep(projectDir)
    },
    takeover: {
      status: "not_started",
      canTakeOver: false,
      blockers: ["project_not_started"],
      warnings: [],
      summary: "This is a clean pre-start project, not a failed handoff. Call project_start first."
    },
    risks: [],
    budgets: {},
    retrieval: {
      mode: "not_started",
      summary: "No takeover refs exist until the project is started.",
      rules: [
        "Do not read takeover-packet, process-trace, architecture-map, memory-graph, or state-manifest yet.",
        "Call project_start to initialize durable project state.",
        "After project_start, call project_takeover_summary again."
      ]
    },
    sourceRefs: [],
    onDemandReads: [],
    hashes: {},
    validation: {
      bundleVerification: {
        status: "not_started",
        canResume: false,
        summary: "Project has not been started yet.",
        blockers: ["project_not_started"],
        warnings: []
      },
      acceptance: null
    },
    budget: {
      status: "ok",
      maxBytes: 14000,
      maxTokens: 1800,
      bytes: 0,
      estimatedTokens: 0
    }
  };
}

function notStartedAudit(projectDir) {
  return {
    ok: true,
    projectDir,
    lifecycle: "not_started",
    status: "not_started",
    canResume: false,
    summary: "Project has not been started yet. This is a pre-start state, not a broken handoff.",
    blockers: ["project_not_started"],
    warnings: [],
    nextStep: startNextStep(projectDir),
    takeover: {
      status: "not_started",
      canTakeOver: false,
      summary: "Call project_start before trying to take over project work."
    },
    verification: {
      status: "not_started",
      canResume: false,
      summary: "No .project-agent/state.json exists yet.",
      blockers: ["project_not_started"],
      warnings: []
    },
    manifest: {
      status: "not_started",
      valid: false,
      files: 0,
      blockers: [],
      warnings: []
    },
    acceptance: null,
    freshnessGate: null,
    risks: [],
    sourceRefs: []
  };
}

function projectLifecycle(projectDir, { summary = null, continuity = null, verification = null } = {}) {
  const effectiveSummary = summary || summarizeState(readState(projectDir));
  if (!effectiveSummary.initialized) {
    return {
      status: "not_started",
      canResume: false,
      summary: "Project has not been started yet.",
      nextStep: startNextStep(projectDir)
    };
  }
  if (!effectiveSummary.activeGoal) {
    return {
      status: "started_idle",
      canResume: true,
      summary: "Project is initialized, but no active goal exists yet.",
      nextStep: {
        tool: "project_start",
        command: "Call project_start with an objective to create the first active goal.",
        arguments: {
          projectDir,
          objective: "First project goal",
          acceptance: ["Acceptance criterion"]
        }
      }
    };
  }
  if (continuity?.interruptedWork?.count) {
    return {
      status: "interrupted",
      canResume: true,
      summary: "Project has interrupted work that should be resolved before new edits.",
      nextStep: continuity.startProtocol?.firstActions?.[0] || continuity.takeoverPacket?.firstActions?.[0] || null
    };
  }
  if (verification && !verification.canResume) {
    return {
      status: "blocked",
      canResume: false,
      summary: verification.summary || "Project handoff state has blockers.",
      nextStep: { command: "Call project_start with refresh=true or inspect project_handoff_audit blockers." }
    };
  }
  return {
    status: "active",
    canResume: true,
    summary: "Project is started and has an active goal.",
    nextStep: continuity?.takeoverSummary?.nextStep || null
  };
}

async function refreshProjectState(projectDir, { role = "coding_agent" } = {}) {
  const rawState = readState(projectDir);
  const summary = summarizeState(rawState);
  const architecture = buildArchitecture(projectDir);
  const runtime = readRuntime(projectDir);
  let packet = null;
  if (summary.initialized) {
    const args = ["kernel", "--role", role, "--format", "json"];
    if (summary.activeGoal?.id) args.push("--goal", summary.activeGoal.id);
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
    terminalSnapshot: null
  });
  let continuity = writeContinuity(projectDir, insights.continuity);
  continuity = attachTakeoverDrill(projectDir, continuity);
  const continuityAudit = buildContinuityAudit(projectDir, continuity, { expectedFiles: EXPECTED_HANDOFF_FILES });
  writeContinuityAudit(projectDir, continuityAudit);
  continuity = writeContinuity(projectDir, { ...continuity, continuityAudit });
  const finalContinuityAudit = buildContinuityAudit(projectDir, continuity, { expectedFiles: EXPECTED_HANDOFF_FILES });
  writeContinuityAudit(projectDir, finalContinuityAudit);
  const takeoverAcceptance = refreshTakeoverAcceptanceAudit(projectDir, {
    ...continuity,
    continuityAudit: finalContinuityAudit
  });
  continuity = takeoverAcceptance.continuity;
  const bundle = readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity);
  const verification = verifyAgentContextBundle(projectDir, bundle);
  const takeoverSummary = readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, continuity, { bundle, verification });
  return {
    rawState,
    summary: summarizeState(readState(projectDir)),
    architecture,
    continuity,
    bundle,
    verification,
    takeoverSummary,
    files: EXPECTED_HANDOFF_FILES
  };
}

function buildBundleAndSummary(projectDir, { refresh = false } = {}) {
  if (!isProjectStarted(projectDir)) {
    const takeoverSummary = notStartedTakeover(projectDir);
    return {
      lifecycle: projectLifecycle(projectDir),
      continuity: {},
      stateManifest: null,
      stateManifestVerification: {
        status: "not_started",
        valid: false,
        blockers: [],
        warnings: []
      },
      bundle: null,
      verification: takeoverSummary.validation.bundleVerification,
      takeoverSummary
    };
  }
  const continuity = readContinuity(projectDir) || {};
  const stateManifest = readStateManifest(projectDir) || continuity.stateManifest || null;
  const stateManifestVerification = verifyStateManifest(projectDir, stateManifest);
  const bundle = refresh
    ? writeAgentContextBundle(projectDir, buildAgentContextBundle(projectDir, continuity, { stateManifest, stateManifestVerification }))
    : readAgentContextBundle(projectDir) || buildAgentContextBundle(projectDir, continuity, { stateManifest, stateManifestVerification });
  const verification = verifyAgentContextBundle(projectDir, bundle);
  const takeoverSummary = refresh
    ? writeTakeoverSummary(projectDir, buildTakeoverSummary(projectDir, continuity, { bundle, verification }))
    : readTakeoverSummary(projectDir) || buildTakeoverSummary(projectDir, continuity, { bundle, verification });
  const lifecycle = projectLifecycle(projectDir, { summary: summarizeState(readState(projectDir)), continuity, verification });
  return { lifecycle, continuity, stateManifest, stateManifestVerification, bundle, verification, takeoverSummary };
}

function architectureInspectOrder(projectDir, architecture) {
  const map = readArchitectureMap(projectDir);
  if (map?.inspectOrder?.length) return map.inspectOrder.slice(0, 20);
  return (architecture.recentChanges || []).map((change) => change.path).filter(Boolean).slice(0, 20);
}

function decorateTakeoverSummary(takeoverSummary, lifecycle) {
  if (lifecycle.status !== "started_idle") {
    return {
      ...takeoverSummary,
      lifecycle: lifecycle.status,
      lifecycleSummary: lifecycle.summary
    };
  }
  return {
    ...takeoverSummary,
    lifecycle: "started_idle",
    status: "started_idle",
    currentState: {
      phase: "plan",
      status: "idle",
      title: "Project started, no active goal",
      detail: "The project kernel and handoff files exist, but no active goal has been created yet.",
      refs: [".project-agent/state.json"]
    },
    nextStep: {
      command: "project_start",
      expected: {
        title: "Create the first active goal",
        detail: "Call project_start with an objective and acceptance criteria."
      },
      mcp: lifecycle.nextStep
    },
    takeover: {
      status: "started_idle",
      canTakeOver: true,
      blockers: [],
      warnings: [],
      summary: "Project is initialized and idle. Create or select a goal before continuing implementation."
    },
    validation: {
      ...(takeoverSummary.validation || {}),
      bundleVerification: {
        status: "started_idle",
        canResume: true,
        summary: "Project is initialized and idle; no active handoff is required yet.",
        blockers: [],
        warnings: []
      }
    }
  };
}

function registerProjectTools(server) {
  server.registerTool(
    "project_start",
    {
      title: "Project Start",
      description: "Initialize or repair CLI Memo state for a project, optionally creating the first active goal.",
      inputSchema: {
        ...ProjectDirSchema,
        name: z.string().optional().describe("Project display name. Defaults to the project folder name."),
        force: z.boolean().optional().describe("Rewrite starter docs/state. Defaults to false."),
        refresh: z.boolean().optional().describe("Refresh handoff files after initialization. Defaults to true."),
        objective: z.string().optional().describe("Optional first goal objective to create after initialization."),
        acceptance: z.array(z.string()).optional().describe("Optional acceptance criteria for the first goal."),
        role: z.string().optional().describe("Role used when refreshing project context. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const wasStarted = isProjectStarted(projectDir);
        const name = input.name || path.basename(projectDir);
        let initOutput = "";
        if (!wasStarted || input.force) {
          const initArgs = ["init", "--name", name];
          if (input.force) initArgs.push("--force");
          const initResult = await runProjectAgent(projectDir, initArgs);
          initOutput = initResult.stdout;
        }

        let goal = null;
        if (input.objective) {
          const goalArgs = ["goal", "create", "--objective", input.objective];
          for (const item of input.acceptance || []) goalArgs.push("--accept", item);
          goal = await runJson(projectDir, goalArgs);
        }
        const memoryStore = ensureMemoryStore(projectDir, { audit: true });
        const dogfoodSeed = seedDogfoodMemory(projectDir, { agentId: "project_start" });

        ingestHookEvents(projectDir, {
          event: {
            phase: "observe",
            status: "done",
            workstream: input.objective ? "strategy" : "governance",
            title: wasStarted && !input.force ? "Project state refreshed" : "Project started",
            detail: input.objective || name,
            refs: ["PROJECT.md", ".project-agent/state.json"],
            files: [
              { path: "PROJECT.md", status: wasStarted ? "unchanged" : "added", kind: "kernel" },
              { path: ".project-agent/state.json", status: wasStarted ? "modified" : "added", kind: "state" }
            ],
            source: "project-mcp",
            type: "agent_note"
          }
        }, { source: "project-mcp" });

        const refresh = input.refresh !== false ? await refreshProjectState(projectDir, { role: input.role || "coding_agent" }) : null;
        const lifecycle = projectLifecycle(projectDir, {
          summary: refresh?.summary || summarizeState(readState(projectDir)),
          continuity: refresh?.continuity || readContinuity(projectDir),
          verification: refresh?.verification || null
        });
        return toolResult({
          ok: true,
          projectDir,
          lifecycle,
          initialized: !wasStarted || Boolean(input.force),
          refreshed: Boolean(refresh),
          goal,
          initOutput,
          createdOrVerified: [
            "PROJECT.md",
            "AGENTS.md",
            "docs/architecture/principles.md",
            "docs/product/roadmap.md",
            "docs/quality/test-strategy.md",
            "docs/agents/roles.md",
            ".project-agent/state.json",
            ".project-agent/takeover-summary.json",
            ".project-agent/agent-context-bundle.json",
            ".project-agent/process-trace.json",
            ".project-agent/architecture-map.json",
            ".project-agent/memory-graph.json",
            ".project-agent/state-manifest.json",
            ...memoryStoreRefs()
          ],
          memoryStore,
          dogfoodSeed,
          takeoverSummary: refresh?.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, lifecycle) : null,
          verification: refresh?.verification || null
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_takeover_summary",
    {
      title: "Project Takeover Summary",
      description: "Return the small summary-first takeover packet. Call this before reading large state files.",
      inputSchema: {
        ...ProjectDirSchema,
        refresh: z.boolean().optional().describe("Refresh the bundle and takeover summary before returning.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const { lifecycle, takeoverSummary, verification } = buildBundleAndSummary(projectDir, { refresh: input.refresh });
        const memoryHarness = buildMemoryHarness(projectDir, {
          goalId: takeoverSummary.activeGoal?.id,
          limit: 6,
          maxReads: 3,
          candidateLimit: 5
        });
        return toolResult({
          ok: true,
          projectDir,
          lifecycle,
          takeoverSummary: decorateTakeoverSummary(takeoverSummary, lifecycle),
          memoryHarness,
          verification: lifecycle.status === "started_idle"
            ? {
                status: "started_idle",
                canResume: true,
                summary: lifecycle.summary,
                blockers: [],
                warnings: []
              }
            : verification
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_context_search",
    {
      title: "Project Context Search",
      description: "Run grep-first retrieval over project files and .project-agent state, returning snippets and exact refs.",
      inputSchema: {
        ...ProjectDirSchema,
        query: z.string().optional().describe("Search query. Defaults to the active takeover summary."),
        limit: z.number().int().min(1).max(50).optional(),
        maxFiles: z.number().int().min(1).max(5000).optional(),
        maxFileBytes: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
        file: z.string().optional().describe("Restrict grep-first search to refs matching this file fragment."),
        folder: z.string().optional().describe("Restrict grep-first search to project-relative folder prefix."),
        fileType: z.string().optional().describe("Restrict grep-first search to an extension such as md, json, js, or jsx.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = searchContext(projectDir, {
          query: input.query || defaultContextQuery(projectDir),
          limit: input.limit || 10,
          maxFiles: input.maxFiles || 500,
          maxFileBytes: input.maxFileBytes || 1024 * 1024,
          file: input.file,
          folder: input.folder,
          fileType: input.fileType
        });
        return toolResult({ ok: true, projectDir, ...result });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_read_ref",
    {
      title: "Project Read Ref",
      description: "Read an exact project-relative ref, line range, or JSON selector returned by project_context_search.",
      inputSchema: {
        ...ProjectDirSchema,
        ref: z.string().describe("Project-relative ref, such as .project-agent/process-trace.json#current or src/App.jsx:1-40."),
        maxBytes: z.number().int().min(256).max(200000).optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        if (!isProjectStarted(projectDir) && String(input.ref || "").replace(/^\.\//, "").startsWith(".project-agent/")) {
          return toolResult({
            ok: false,
            lifecycle: "not_started",
            status: "not_started",
            projectDir,
            ref: input.ref,
            error: "Project has not been started yet; .project-agent refs do not exist.",
            nextStep: startNextStep(projectDir)
          });
        }
        const result = readContextRef(projectDir, input.ref, { maxBytes: input.maxBytes || 12000 });
        return toolResult({ ok: true, projectDir, ...result });
      } catch (error) {
        return toolError(error, { projectDir: resolveProjectDir(input), ref: input.ref });
      }
    }
  );

  server.registerTool(
    "project_record_event",
    {
      title: "Project Record Event",
      description: "Record the agent's current process event into .project-agent/runtime.json.",
      inputSchema: {
        ...ProjectDirSchema,
        phase: z.enum(["observe", "plan", "execute", "evidence", "audit", "handoff"]).optional(),
        status: z.enum(["pending", "current", "done", "failed", "blocked"]).optional(),
        workstream: z.enum(["discussion", "strategy", "architecture", "implementation", "qa_testing", "governance"]).optional(),
        title: z.string().optional(),
        detail: z.string().optional(),
        refs: z.array(z.string()).optional(),
        files: z.array(FileChangeSchema).optional(),
        agentId: z.string().optional(),
        goalId: z.string().optional(),
        tool: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const event = {
          phase: input.phase || "observe",
          status: input.status || "done",
          workstream: input.workstream,
          title: input.title || "MCP agent event",
          detail: input.detail || "",
          refs: input.refs || [],
          files: input.files || [],
          agentId: input.agentId,
          goalId: input.goalId,
          tool: input.tool,
          type: "agent_note",
          source: "project-mcp",
          data: input.data
        };
        const result = ingestHookEvents(projectDir, { event }, { source: "project-mcp", agentId: input.agentId, goalId: input.goalId });
        return toolResult({ ok: result.accepted > 0, projectDir, ...result });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_architecture_changes",
    {
      title: "Project Architecture Changes",
      description: "Return recent file changes, impacted folders, inspect order, and code graph summary.",
      inputSchema: {
        ...ProjectDirSchema,
        limit: z.number().int().min(1).max(100).optional(),
        persist: z.boolean().optional().describe("Persist the architecture scan snapshot. Defaults to true.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const architecture = buildArchitecture(projectDir, { persist: input.persist !== false });
        return toolResult({
          ok: true,
          projectDir,
          lifecycle: projectLifecycle(projectDir).status,
          root: architecture.root,
          scannedAt: architecture.scannedAt,
          totals: architecture.totals,
          modules: architecture.modules,
          impact: architecture.impact,
          inspectOrder: architectureInspectOrder(projectDir, architecture),
          recentChanges: (architecture.recentChanges || []).slice(0, input.limit || 20),
          codeGraph: architecture.codeGraph
            ? {
                status: architecture.codeGraph.status,
                nodeCount: architecture.codeGraph.nodeCount,
                edgeCount: architecture.codeGraph.edgeCount,
                symbolCount: architecture.codeGraph.symbolCount || architecture.codeGraph.symbolGraph?.symbolCount || 0,
                symbolEdgeCount: architecture.codeGraph.symbolEdgeCount || architecture.codeGraph.symbolGraph?.usageEdgeCount || 0,
                hotspots: (architecture.codeGraph.hotspots || []).slice(0, 8),
                symbolGraph: architecture.codeGraph.symbolGraph
                  ? {
                      schemaVersion: architecture.codeGraph.symbolGraph.schemaVersion,
                      status: architecture.codeGraph.symbolGraph.status,
                      symbolCount: architecture.codeGraph.symbolGraph.symbolCount || 0,
                      usageEdgeCount: architecture.codeGraph.symbolGraph.usageEdgeCount || 0,
                      hotspots: (architecture.codeGraph.symbolGraph.hotspots || []).slice(0, 6),
                      changedImpact: (architecture.codeGraph.symbolGraph.changedImpact || []).slice(0, 6)
                    }
                  : null,
                changedImpact: (architecture.codeGraph.changedImpact || []).slice(0, 8)
              }
            : null
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_code_search",
    {
      title: "Project Code Search",
      description: "Search the local symbol/import graph for files, symbols, dependents, tests, and read-before-edit refs.",
      inputSchema: {
        ...ProjectDirSchema,
        query: z.string().optional(),
        file: z.string().optional(),
        symbol: z.string().optional(),
        symbolKind: z.enum(["function", "class", "value", "reexport"]).optional(),
        language: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        persist: z.boolean().optional().describe("Persist the architecture snapshot while searching. Defaults to false.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(searchCodeGraph(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_handoff_audit",
    {
      title: "Project Handoff Audit",
      description: "Return takeover readiness, freshness, manifest verification, inspection coverage, acceptance status, blockers, and warnings.",
      inputSchema: {
        ...ProjectDirSchema,
        refresh: z.boolean().optional().describe("Refresh the bundle and takeover summary before auditing.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        if (!isProjectStarted(projectDir)) return toolResult(notStartedAudit(projectDir));
        const { lifecycle, continuity, stateManifest, stateManifestVerification, bundle, verification, takeoverSummary } = buildBundleAndSummary(projectDir, { refresh: input.refresh });
        const acceptance = bundle.validation?.takeoverAcceptanceAudit || continuity.takeoverAcceptanceAudit || readTakeoverAcceptanceAudit(projectDir) || null;
        const freshnessGate = bundle.validation?.freshnessGate || continuity.freshnessGate || continuity.continuityContract?.freshnessGate || null;
        const preEditRisk = bundle.validation?.preEditRisk || continuity.preEditRisk || null;
        const inspectionCoverage = preEditRisk?.inspectionCoverage || null;
        if (lifecycle.status === "started_idle") {
          return toolResult({
            ok: true,
            projectDir,
            lifecycle: "started_idle",
            status: "started_idle",
            canResume: true,
            summary: lifecycle.summary,
            blockers: [],
            warnings: [],
            nextStep: lifecycle.nextStep,
            verification: {
              status: "started_idle",
              canResume: true,
              summary: lifecycle.summary,
              blockers: [],
              warnings: []
            },
            manifest: {
              status: stateManifestVerification.status,
              valid: stateManifestVerification.valid,
              checkedAt: stateManifestVerification.checkedAt,
              files: stateManifest?.files?.length || 0,
              blockers: stateManifestVerification.blockers || [],
              warnings: stateManifestVerification.warnings || []
            },
            acceptance,
            sourceRefs: decorateTakeoverSummary(takeoverSummary, lifecycle).sourceRefs || []
          });
        }
        const auditWarnings = uniqueItems([
          ...(verification.warnings || []),
          ...(stateManifestVerification.warnings || []),
          ...(acceptance?.warnings || []),
          freshnessGate && ["stale", "expired"].includes(freshnessGate.status) ? "freshness_gate" : "",
          inspectionCoverage?.status === "warn" ? "inspection_coverage" : ""
        ], 16);
        const audit = {
          ok: true,
          projectDir,
          lifecycle: lifecycle.status,
          takeover: takeoverSummary.takeover || null,
          activeGoal: takeoverSummary.activeGoal || null,
          nextStep: takeoverSummary.nextStep || null,
          verification: {
            status: verification.status,
            canResume: verification.canResume,
            summary: verification.summary,
            blockers: verification.blockers || [],
            warnings: verification.warnings || []
          },
          manifest: {
            status: stateManifestVerification.status,
            valid: stateManifestVerification.valid,
            checkedAt: stateManifestVerification.checkedAt,
            files: stateManifest?.files?.length || 0,
            blockers: stateManifestVerification.blockers || [],
            warnings: stateManifestVerification.warnings || []
          },
          acceptance: acceptance
            ? {
                status: acceptance.status,
                canResume: acceptance.canResume,
                score: acceptance.score,
                summary: acceptance.summary,
                blockers: acceptance.blockers || [],
                warnings: acceptance.warnings || []
              }
            : null,
          freshnessGate,
          preEditRisk,
          inspectionCoverage,
          warnings: auditWarnings,
          risks: takeoverSummary.risks || [],
          sourceRefs: takeoverSummary.sourceRefs || []
        };
        return toolResult(audit);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_agent_doctor",
    {
      title: "Project Agent Doctor",
      description: "Run an external-agent readiness doctor for bootstrap, automatic memory harness, indexes, privacy, access audit, and code search.",
      inputSchema: {
        ...ProjectDirSchema,
        query: z.string().optional(),
        bindHost: z.string().optional(),
        apiPort: z.number().int().min(1).max(65535).optional(),
        uiPort: z.number().int().min(1).max(65535).optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(buildAgentDoctor(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_inventory",
    {
      title: "Project Memory Inventory",
      description: "Inspect .project-agent memory surfaces, classifying source, derived, volatile, index, risky, and missing canonical files.",
      inputSchema: {
        ...ProjectDirSchema
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(buildMemoryInventory(projectDir));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_seed_dogfood",
    {
      title: "Project Memory Dogfood Seed",
      description: "Idempotently seed durable product dogfood memory from the local memory gap benchmark when those docs exist.",
      inputSchema: {
        ...ProjectDirSchema,
        dryRun: z.boolean().optional().describe("Set true to preview missing dogfood records without writing."),
        goalId: z.string().optional(),
        agentId: z.string().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = seedDogfoodMemory(projectDir, input);
        if (!result.dryRun && result.refresh?.required) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_add",
    {
      title: "Project Memory Add",
      description: "Write a typed canonical long-term memory record into .project-agent/memory/*.jsonl.",
      inputSchema: {
        ...ProjectDirSchema,
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).describe("Canonical memory type."),
        title: z.string().min(1).describe("Short durable memory title."),
        content: z.string().min(1).describe("Durable memory body."),
        sourceRefs: z.array(z.string()).min(1).describe("Exact refs proving where the memory came from."),
        files: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional(),
        goalId: z.string().optional(),
        agentId: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        importance: z.number().min(0).max(10).optional(),
        validUntil: z.string().nullable().optional(),
        ttlDays: z.number().nullable().optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult({ projectDir, ...addMemory(projectDir, input) });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_read",
    {
      title: "Project Memory Read",
      description: "Read one canonical memory by id or .project-agent/memory/*.jsonl#id ref.",
      inputSchema: {
        ...ProjectDirSchema,
        id: z.string().optional(),
        ref: z.string().optional(),
        auditAccess: z.boolean().optional().describe("Record this read in bounded access audit.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult({ projectDir, ...readMemory(projectDir, input) });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_update",
    {
      title: "Project Memory Update",
      description: "Update one canonical memory in place with provenance-preserving version increment, audit row, and index cascade refresh.",
      inputSchema: {
        ...ProjectDirSchema,
        id: z.string().optional(),
        ref: z.string().optional(),
        dryRun: z.boolean().optional(),
        reason: z.string().min(1).describe("Required rationale for the memory update."),
        title: z.string().optional(),
        content: z.string().optional(),
        sourceRefs: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional(),
        goalId: z.string().optional(),
        agentId: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        importance: z.number().min(0).max(10).optional(),
        validUntil: z.string().nullable().optional(),
        ttlDays: z.number().nullable().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = updateMemory(projectDir, input);
        if (!result.dryRun) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_supersede",
    {
      title: "Project Memory Supersede",
      description: "Create a new canonical memory version and mark the old memory non-latest with supersededBy provenance.",
      inputSchema: {
        ...ProjectDirSchema,
        id: z.string().optional(),
        ref: z.string().optional(),
        dryRun: z.boolean().optional().describe("Defaults to true. Set false to mutate the version chain."),
        reason: z.string().min(1).describe("Required rationale for supersession."),
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        sourceRefs: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional(),
        goalId: z.string().optional(),
        agentId: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        importance: z.number().min(0).max(10).optional(),
        validUntil: z.string().nullable().optional(),
        ttlDays: z.number().nullable().optional(),
        replacement: z.object({
          id: z.string().optional(),
          type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
          title: z.string().optional(),
          content: z.string().optional(),
          sourceRefs: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          concepts: z.array(z.string()).optional(),
          confidence: z.number().min(0).max(1).optional(),
          importance: z.number().min(0).max(10).optional(),
          validUntil: z.string().nullable().optional(),
          ttlDays: z.number().nullable().optional()
        }).optional(),
        detectSimilar: z.boolean().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = supersedeMemory(projectDir, input);
        if (!result.dryRun) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_search",
    {
      title: "Project Memory Search",
      description: "Search only canonical .project-agent/memory records with deterministic grep-first scoring and exact refs.",
      inputSchema: {
        ...ProjectDirSchema,
        query: z.string().optional(),
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
        file: z.string().optional().describe("Restrict to memory records citing this file/ref fragment."),
        folder: z.string().optional().describe("Restrict to records whose canonical/source/file refs live under this folder."),
        sourceRef: z.string().optional().describe("Restrict to records citing this source ref."),
        concept: z.string().optional().describe("Restrict to records tagged with this concept."),
        goalId: z.string().optional().describe("Restrict to records scoped to this goal id."),
        fileType: z.string().optional().describe("Restrict to records citing refs with this extension, for example md or json."),
        minConfidence: z.number().min(0).max(1).optional(),
        sourceQuality: z.enum(["strong", "watch", "weak"]).optional(),
        latestOnly: z.boolean().optional(),
        useIndex: z.enum(["bm25", "entity", "vector", "hybrid"]).optional().describe("Use a fresh optional rebuildable search cache. Falls back to deterministic grep-first when missing or stale."),
        limit: z.number().int().min(1).max(50).optional(),
        auditAccess: z.boolean().optional().describe("Record this search in bounded access audit.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(searchMemory(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_rebuild_index",
    {
      title: "Project Memory Rebuild Index",
      description: "Rebuild the optional local BM25 cache over canonical memory records and return freshness metadata.",
      inputSchema: {
        ...ProjectDirSchema,
        audit: z.boolean().optional().describe("Append a memory audit row. Defaults to true.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(rebuildMemorySearchIndex(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_rebuild_entity_index",
    {
      title: "Project Memory Rebuild Entity Index",
      description: "Rebuild the optional local entity graph cache over canonical memory records and return freshness metadata.",
      inputSchema: {
        ...ProjectDirSchema,
        audit: z.boolean().optional().describe("Append a memory audit row. Defaults to true.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(rebuildMemoryEntityIndex(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_rebuild_vector_index",
    {
      title: "Project Memory Rebuild Vector Index",
      description: "Rebuild the optional local lexical-vector cache over canonical memory records and return freshness metadata.",
      inputSchema: {
        ...ProjectDirSchema,
        audit: z.boolean().optional().describe("Append a memory audit row. Defaults to true.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(rebuildMemoryVectorIndex(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_rebuild_all_indexes",
    {
      title: "Project Memory Rebuild All Indexes",
      description: "Rebuild canonical memory index.md plus BM25, entity, and lexical-vector caches from source JSONL memory.",
      inputSchema: {
        ...ProjectDirSchema,
        audit: z.boolean().optional().describe("Append a memory audit row. Defaults to true.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(rebuildAllMemoryIndexes(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_forget",
    {
      title: "Project Memory Forget",
      description: "Dry-run or execute governed memory deletion/redaction/expiry/supersession with affected refs and refresh targets.",
      inputSchema: {
        ...ProjectDirSchema,
        dryRun: z.boolean().optional().describe("Defaults to true. Set false only when the caller explicitly wants mutation."),
        mode: z.enum(["delete", "redact", "expire", "supersede"]).optional(),
        id: z.string().optional(),
        ids: z.array(z.string()).optional(),
        ref: z.string().optional(),
        refs: z.array(z.string()).optional(),
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
        file: z.string().optional(),
        sourceRef: z.string().optional(),
        concept: z.string().optional(),
        goalId: z.string().optional(),
        generatedArtifact: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        reason: z.string().optional(),
        replacement: z.string().optional(),
        titleReplacement: z.string().optional(),
        supersededBy: z.string().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = forgetMemory(projectDir, input);
        if (!result.dryRun) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_retention_audit",
    {
      title: "Project Memory Retention Audit",
      description: "Dry-run retention policy over canonical memory and generated surfaces, returning expirable records and cleanup candidates.",
      inputSchema: {
        ...ProjectDirSchema,
        now: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        audit: z.boolean().optional().describe("Append a non-mutating audit row. Defaults to false.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(auditMemoryRetention(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_retention_sweep",
    {
      title: "Project Memory Retention Sweep",
      description: "Dry-run or execute retention hygiene by marking expired canonical memory non-latest and refreshing all memory indexes.",
      inputSchema: {
        ...ProjectDirSchema,
        dryRun: z.boolean().optional().describe("Defaults to true. Set false to mark eligible records expired."),
        now: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        reason: z.string().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = sweepMemoryRetention(projectDir, input);
        if (!result.dryRun && result.refresh?.required) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_privacy_audit",
    {
      title: "Project Memory Privacy Audit",
      description: "Scan canonical memory and bounded project-agent state for secret-like text, weak provenance, raw architecture text policy, and writer audit gaps.",
      inputSchema: {
        ...ProjectDirSchema,
        limit: z.number().int().min(1).max(100).optional(),
        maxFileBytes: z.number().int().min(1024).max(1048576).optional(),
        audit: z.boolean().optional().describe("Append a non-mutating audit row. Defaults to false.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(auditMemoryPrivacy(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_generated_cleanup",
    {
      title: "Project Memory Generated Cleanup",
      description: "Dry-run or remove rebuildable generated/index files, then rebuild memory indexes from canonical memory.",
      inputSchema: {
        ...ProjectDirSchema,
        dryRun: z.boolean().optional().describe("Defaults to true. Set false to remove matching rebuildable files."),
        mode: z.enum(["overLimit", "rebuildable", "indexes"]).optional(),
        ref: z.string().optional(),
        refs: z.array(z.string()).optional(),
        maxBytes: z.number().int().min(0).optional(),
        includeIndexes: z.boolean().optional(),
        rebuildIndexes: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        audit: z.boolean().optional().describe("Append an audit row. Defaults to true."),
        role: z.string().optional().describe("Role used when refreshing generated project context after executed cleanup. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = cleanupGeneratedMemoryState(projectDir, input);
        if (!result.dryRun) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_harness",
    {
      title: "Project Memory Harness",
      description: "Automatically route the agent through canonical memory search/read and non-mutating consolidation discovery based on goal, cursor, runtime events, risks, and changed files.",
      inputSchema: {
        ...ProjectDirSchema,
        query: z.string().optional(),
        goalId: z.string().optional(),
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
        file: z.string().optional(),
        folder: z.string().optional(),
        sourceRef: z.string().optional(),
        concept: z.string().optional(),
        fileType: z.string().optional(),
        sourceQuality: z.enum(["strong", "watch", "weak"]).optional(),
        latestOnly: z.boolean().optional(),
        useIndex: z.enum(["bm25", "entity", "vector", "hybrid"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        maxReads: z.number().int().min(0).max(8).optional(),
        candidateLimit: z.number().int().min(1).max(20).optional(),
        eventLimit: z.number().int().min(1).max(120).optional(),
        retentionLimit: z.number().int().min(1).max(200).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        consolidate: z.boolean().optional(),
        consolidateV2: z.boolean().optional(),
        consolidationMode: z.enum(["dryRun", "manual", "goal", "session", "project"]).optional(),
        v2CandidateLimit: z.number().int().min(1).max(20).optional(),
        auditAccess: z.boolean().optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(buildMemoryHarness(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_consolidate",
    {
      title: "Project Memory Consolidate",
      description: "Dry-run or execute runtime-to-memory promotion from runtime events, handoff summaries, and architecture changes into canonical memory.",
      inputSchema: {
        ...ProjectDirSchema,
        mode: z.enum(["dryRun", "manual", "goal", "session", "project"]).optional(),
        dryRun: z.boolean().optional().describe("Defaults to true. Set false only when the caller explicitly wants durable memory writes."),
        candidateId: z.string().optional(),
        candidateIds: z.array(z.string()).optional(),
        goalId: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        eventLimit: z.number().int().min(1).max(120).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = consolidateMemory(projectDir, input);
        if (!result.dryRun && result.refresh?.required) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_consolidate_v2",
    {
      title: "Project Memory Consolidate V2",
      description: "Dry-run or execute governed add/update/supersede/expire proposals using local semantic signals and retention policy.",
      inputSchema: {
        ...ProjectDirSchema,
        mode: z.enum(["dryRun", "manual", "goal", "session", "project"]).optional(),
        dryRun: z.boolean().optional().describe("Defaults to true. Set false only with explicit proposal/candidate ids."),
        proposalId: z.string().optional(),
        proposalIds: z.array(z.string()).optional(),
        candidateId: z.string().optional(),
        candidateIds: z.array(z.string()).optional(),
        goalId: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(120).optional(),
        eventLimit: z.number().int().min(1).max(120).optional(),
        retentionLimit: z.number().int().min(1).max(200).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        includeRetention: z.boolean().optional(),
        preferSupersede: z.boolean().optional(),
        reason: z.string().optional(),
        agentId: z.string().optional(),
        role: z.string().optional().describe("Role used when refreshing project context after executed mutation. Defaults to coding_agent.")
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        const result = consolidateMemoryV2(projectDir, input);
        if (!result.dryRun) {
          const refresh = await refreshProjectState(projectDir, { role: input.role || "coding_agent" });
          return toolResult({
            ...result,
            refreshed: true,
            refreshSummary: {
              lifecycle: projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              }),
              verification: refresh.verification,
              takeoverSummary: refresh.takeoverSummary ? decorateTakeoverSummary(refresh.takeoverSummary, projectLifecycle(projectDir, {
                summary: refresh.summary,
                continuity: refresh.continuity,
                verification: refresh.verification
              })) : null
            }
          });
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_audit",
    {
      title: "Project Memory Audit",
      description: "Query append-only canonical memory lifecycle audit rows with refs, filters, and action counts.",
      inputSchema: {
        ...ProjectDirSchema,
        action: z.string().optional(),
        mode: z.enum(["delete", "redact", "expire", "supersede"]).optional(),
        memoryId: z.string().optional(),
        type: z.enum(["episode", "fact", "decision", "procedure", "evidence", "risk"]).optional(),
        dryRun: z.boolean().optional(),
        ref: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(queryMemoryAudit(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "project_memory_access_audit",
    {
      title: "Project Memory Access Audit",
      description: "Query bounded canonical memory read/search access rows recorded by the automatic memory harness or explicit auditAccess calls.",
      inputSchema: {
        ...ProjectDirSchema,
        action: z.string().optional(),
        tool: z.string().optional(),
        actor: z.string().optional(),
        query: z.string().optional(),
        ref: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async (input) => {
      try {
        const projectDir = resolveProjectDir(input);
        return toolResult(queryMemoryAccessAudit(projectDir, input));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}

async function main() {
  const server = new McpServer({
    name: "cli-memo-project-agent",
    version: "0.1.0"
  });
  registerProjectTools(server);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
