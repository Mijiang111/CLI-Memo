import { execFileSync } from "node:child_process";

const GRAPH_POSITIONS = {
  kernel: { x: 58, y: 70 },
  goal: { x: 190, y: 48 },
  code: { x: 322, y: 82 },
  memory: { x: 194, y: 142 },
  evidence: { x: 78, y: 192 },
  audit: { x: 214, y: 226 },
  handoff: { x: 326, y: 184 }
};

function statusTone(status) {
  if (["complete", "done", "passed", "pass", "ready"].includes(status)) return "ok";
  if (["blocked", "failed"].includes(status)) return "bad";
  if (["active", "pending", "waiting", "current"].includes(status)) return "warn";
  return "muted";
}

const WORKSTREAMS = {
  discussion: {
    label: "Discussion",
    description: "User intent, feedback, and problem framing"
  },
  strategy: {
    label: "Strategy",
    description: "Goals, product direction, and planning"
  },
  architecture: {
    label: "Architecture",
    description: "System shape, modules, folders, and contracts"
  },
  implementation: {
    label: "Code Development",
    description: "Code edits, commands, and implementation steps"
  },
  qa_testing: {
    label: "QA + Testing",
    description: "Builds, tests, verification, and quality checks"
  },
  governance: {
    label: "Governance",
    description: "Memory, evidence, recovery, handoff, and agent leases"
  }
};

const WORKSTREAM_ORDER = ["discussion", "strategy", "architecture", "implementation", "qa_testing", "governance"];

function workstreamMeta(id) {
  const key = WORKSTREAMS[id] ? id : "discussion";
  return { id: key, ...WORKSTREAMS[key] };
}

function addScore(scores, id, amount = 1) {
  scores[id] = (scores[id] || 0) + amount;
}

function textIncludesAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function detectWorkstream(event = {}) {
  if (WORKSTREAMS[event.workstream]) return workstreamMeta(event.workstream);
  const files = Array.isArray(event.files) ? event.files : [];
  const paths = files.map((file) => file.path || "").join(" ");
  const refs = (event.refs || []).join(" ");
  const text = [event.phase, event.title, event.detail, event.tool, event.source, paths, refs].join(" ").toLowerCase();
  const scores = Object.fromEntries(WORKSTREAM_ORDER.map((id) => [id, 0]));

  if (event.phase === "observe") addScore(scores, "discussion", 2);
  if (event.phase === "plan") addScore(scores, "strategy", 2);
  if (event.phase === "execute") addScore(scores, "implementation", 1);
  if (event.phase === "evidence") addScore(scores, "governance", 2);
  if (event.phase === "audit") addScore(scores, "qa_testing", 3);
  if (event.phase === "handoff") addScore(scores, "governance", 3);

  for (const file of files) {
    const filePath = String(file.path || "").toLowerCase();
    if (!filePath) continue;
    if (/(\btests?\b|__tests__|spec\.|test\.|smoke-test|playwright|vitest|jest|pytest)/.test(filePath)) addScore(scores, "qa_testing", 4);
    if (/docs\/architecture|architecture|principles|modules|folders|contracts/.test(filePath)) addScore(scores, "architecture", 4);
    if (/project\.md|docs\/product|roadmap|strategy|planning/.test(filePath)) addScore(scores, "strategy", 3);
    if (/\.project-agent|agents\.md|recovery|resume|continuity|runtime|handoff/.test(filePath)) addScore(scores, "governance", 4);
    if (/^(src|server|lib|app|components)\//.test(filePath) || /package\.json|vite\.config|tsconfig|pyproject|requirements/.test(filePath)) {
      addScore(scores, "implementation", 3);
    }
  }

  if (textIncludesAny(text, ["user instruction", "discussion", "feedback", "question", "clarify", "conversation"])) addScore(scores, "discussion", 3);
  if (textIncludesAny(text, ["strategy", "roadmap", "planning", "objective", "goal", "product", "principle", "philosophy"])) addScore(scores, "strategy", 3);
  if (textIncludesAny(text, ["architecture", "module", "folder", "dependency", "contract", "system shape", "knowledge graph"])) addScore(scores, "architecture", 3);
  if (textIncludesAny(text, ["implement", "implementation", "apply_patch", "code", "file modified", "file added", "edit", "command running"])) addScore(scores, "implementation", 3);
  if (textIncludesAny(text, ["test", "qa", "smoke", "build", "verify", "verification", "audit", "playwright", "screenshot", "console"])) addScore(scores, "qa_testing", 4);
  if (textIncludesAny(text, ["handoff", "recovery", "resume", "continuity", "lease", "memory", "snapshot", "evidence", "agent"])) addScore(scores, "governance", 3);

  const priority = ["qa_testing", "governance", "architecture", "implementation", "strategy", "discussion"];
  const best = priority.reduce((winner, id) => (scores[id] > scores[winner] ? id : winner), "discussion");
  return workstreamMeta(best);
}

function latestHandoffForGoal(state, goalId) {
  return Object.values(state?.handoffs || {})
    .filter((item) => !goalId || item.goalId === goalId)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0] || null;
}

function latestMemoryForGoal(state, goalId) {
  const handoffIds = new Set(
    Object.values(state?.handoffs || {})
      .filter((item) => !goalId || item.goalId === goalId)
      .map((item) => item.id)
  );
  return (state?.memories || [])
    .filter((item) => !item.sourceId || handoffIds.has(item.sourceId))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0] || null;
}

function evidenceVerifies(evidence, targetId) {
  return evidence.some((item) => (item.verifies || []).includes(targetId));
}

function buildTargets(summary) {
  const criteria =
    summary.activeGoal?.acceptanceCriteria?.map((item) => ({
      id: item.id,
      label: item.statement,
      type: "acceptance",
      verified: evidenceVerifies(summary.evidence || [], item.id)
    })) || [];
  const actions = (summary.actions || []).map((item) => ({
    id: item.id,
    label: item.title,
    type: "action",
    verified: evidenceVerifies(summary.evidence || [], item.id)
  }));
  return [...criteria, ...actions];
}

function buildCurrentStep({ summary, audit, handoff, terminalSnapshot }) {
  if (!summary.initialized) {
    return {
      label: "Initialize memory",
      body: "Project docs and structured state are not loaded yet.",
      tone: "warn",
      source: ["project"],
      workstream: workstreamMeta("governance"),
      provenance: [".project-agent/state.json"]
    };
  }
  if (!summary.activeGoal) {
    return {
      label: "Seed a goal",
      body: "The agent needs an objective before memory can become a working map.",
      tone: "warn",
      source: ["memory"],
      workstream: workstreamMeta("strategy"),
      provenance: [".project-agent/state.json"]
    };
  }
  if (terminalSnapshot?.currentCommand) {
    return {
      label: "Executing command",
      body: terminalSnapshot.currentCommand.command,
      tone: "warn",
      source: ["terminal", "goal"],
      workstream: workstreamMeta("implementation"),
      provenance: ["terminal-session", summary.activeGoal.id]
    };
  }
  if (terminalSnapshot?.lastCommand && !(summary.evidence || []).length) {
    return {
      label: "Bind command evidence",
      body: terminalSnapshot.lastCommand.command,
      tone: "warn",
      source: ["terminal", "acceptance"],
      workstream: workstreamMeta("governance"),
      provenance: ["terminal-session", summary.activeGoal.id]
    };
  }
  if (summary.activeGoal.status === "complete" && handoff) {
    return {
      label: "Handoff ready",
      body: "Memory, evidence, audit, and handoff are connected.",
      tone: "ok",
      source: ["memory", "handoff"],
      workstream: workstreamMeta("governance"),
      provenance: [handoff.id, summary.activeGoal.id]
    };
  }
  if (summary.activeGoal.status === "complete") {
    return {
      label: "Prepare handoff",
      body: "The goal is complete; generate a packet for the next agent.",
      tone: "ok",
      source: ["goal", "handoff"],
      workstream: workstreamMeta("governance"),
      provenance: [summary.activeGoal.id]
    };
  }
  if (!(summary.evidence || []).length) {
    return {
      label: "Collect evidence",
      body: "Run a command, review output, then save it against the goal.",
      tone: "muted",
      source: ["goal", "terminal"],
      workstream: workstreamMeta("implementation"),
      provenance: [summary.activeGoal.id]
    };
  }
  if (!audit) {
    return {
      label: "Ready for audit",
      body: `${summary.evidence.length} evidence item(s) are in memory.`,
      tone: "ok",
      source: ["evidence", "goal"],
      workstream: workstreamMeta("qa_testing"),
      provenance: summary.evidence.map((item) => item.id)
    };
  }
  if (audit.canComplete) {
    return {
      label: "Completion allowed",
      body: "The audit says the goal has enough evidence.",
      tone: "ok",
      source: ["audit", "evidence"],
      workstream: workstreamMeta("qa_testing"),
      provenance: [summary.activeGoal.id]
    };
  }
  return {
    label: "Resolve gaps",
    body: `${audit.missing?.length || 0} missing and ${audit.weak?.length || 0} weak item(s) remain.`,
    tone: "warn",
    source: ["audit", "memory"],
    workstream: workstreamMeta("qa_testing"),
    provenance: [summary.activeGoal.id]
  };
}

function node(id, label, status, meta, provenance = []) {
  return {
    id,
    label,
    status,
    tone: statusTone(status),
    meta,
    provenance,
    ...GRAPH_POSITIONS[id]
  };
}

function edge(source, target, label, provenance = []) {
  return { id: `${source}-${target}`, source, target, label, provenance };
}

async function fetchAgentMemoryGraph({ agentmemoryUrl, agentmemorySecret, query }) {
  if (!agentmemoryUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`${agentmemoryUrl.replace(/\/$/, "")}/agentmemory/graph/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(agentmemorySecret ? { Authorization: `Bearer ${agentmemorySecret}` } : {})
      },
      body: JSON.stringify({ query, maxDepth: 2 }),
      signal: controller.signal
    });
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}`, nodes: [], edges: [] };
    const body = await res.json();
    return {
      available: true,
      nodes: body.nodes || [],
      edges: body.edges || []
    };
  } catch (error) {
    return { available: false, reason: error.message || String(error), nodes: [], edges: [] };
  } finally {
    clearTimeout(timeout);
  }
}

function compact(text, max = 78) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function compactList(items, limit = 3, max = 140) {
  return (items || []).filter(Boolean).slice(0, limit).map((item) => compact(item, max));
}

function stableHash(value) {
  const text = JSON.stringify(value || {});
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildKernelSummary(packet) {
  const kernel = packet?.kernel || {};
  const strategy = String(kernel.currentStrategy || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    philosophy: compactList(kernel.philosophy, 3),
    strategy: compactList(strategy.length ? strategy : kernel.productPrinciples, 3),
    architecture: compactList(kernel.architecturePrinciples, 3),
    product: compactList(kernel.productPrinciples, 3),
    quality: compactList(kernel.nonNegotiables, 3),
    sourceRefs: ["PROJECT.md", "docs/architecture/principles.md", "docs/product/roadmap.md", "docs/quality/test-strategy.md", "docs/agents/roles.md"]
  };
}

function kgNode(id, label, kind, status = "done", meta = "", provenance = []) {
  return {
    id,
    label: compact(label, 34),
    kind,
    status,
    tone: statusTone(status),
    meta: compact(meta, 28),
    provenance: provenance.filter(Boolean)
  };
}

function addUniqueNode(nodes, seen, next) {
  if (!next?.id || seen.has(next.id)) return;
  seen.add(next.id);
  nodes.push(next);
}

function addUniqueEdge(edges, seen, source, target, label, provenance = []) {
  if (!source || !target) return;
  const id = `${source}-${target}-${label}`;
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, source, target, label, provenance: provenance.filter(Boolean) });
}

function layoutGraph(nodes, width = 420, height = 320) {
  const fixed = {
    project: { x: width / 2, y: 32 },
    kernel: { x: 80, y: 86 },
    goal: { x: width / 2, y: 92 },
    architecture: { x: width - 80, y: 86 },
    memory: { x: width / 2, y: 168 },
    handoff: { x: width / 2, y: height - 34 }
  };
  const free = nodes.filter((item) => !fixed[item.id]);
  const radiusX = width * 0.39;
  const radiusY = height * 0.28;
  free.forEach((item, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(free.length, 1) + Math.PI / 8;
    item.x = Math.round(width / 2 + Math.cos(angle) * radiusX);
    item.y = Math.round(174 + Math.sin(angle) * radiusY);
  });
  return nodes.map((item) => ({ ...item, ...(fixed[item.id] || { x: item.x, y: item.y }) }));
}

function buildKnowledgeGraph({ rawState, summary, packet, architecture, runtimeEvents = [], handoff, agentmemoryGraph }) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  const goal = summary.activeGoal;
  const kernelSummary = buildKernelSummary(packet);

  addUniqueNode(nodes, seenNodes, kgNode("project", summary.project || rawState?.project || "Project", "project", summary.initialized ? "done" : "pending", "source root", ["PROJECT.md"]));
  addUniqueNode(nodes, seenNodes, kgNode("kernel", "Project Kernel", "kernel", summary.initialized ? "done" : "pending", "philosophy/roles/quality", ["PROJECT.md", "docs/**"]));
  addUniqueEdge(edges, seenEdges, "project", "kernel", "defines", ["PROJECT.md"]);
  const kernelConcepts = [
    ["kernel:philosophy", "Philosophy", kernelSummary.philosophy[0], "PROJECT.md"],
    ["kernel:strategy", "Strategy", kernelSummary.strategy[0], "PROJECT.md"],
    ["kernel:architecture", "Architecture", kernelSummary.architecture[0], "docs/architecture/principles.md"],
    ["kernel:quality", "Quality", kernelSummary.quality[0], "docs/quality/test-strategy.md"]
  ];
  for (const [id, label, meta, ref] of kernelConcepts) {
    if (!meta) continue;
    addUniqueNode(nodes, seenNodes, kgNode(id, label, "kernelConcept", "done", meta, [ref]));
    addUniqueEdge(edges, seenEdges, "kernel", id, "contains", [ref]);
  }

  if (goal) {
    addUniqueNode(nodes, seenNodes, kgNode("goal", goal.objective, "goal", goal.status, goal.status, [goal.id]));
    addUniqueEdge(edges, seenEdges, "kernel", "goal", "frames", [goal.id]);
    for (const criterion of (goal.acceptanceCriteria || []).slice(0, 6)) {
      addUniqueNode(nodes, seenNodes, kgNode(criterion.id, criterion.statement, "acceptance", evidenceVerifies(summary.evidence || [], criterion.id) ? "done" : "pending", criterion.id, [goal.id]));
      addUniqueEdge(edges, seenEdges, "goal", criterion.id, "requires", [goal.id]);
    }
  }

  addUniqueNode(nodes, seenNodes, kgNode("memory", "Project Memory", "memory", (rawState?.memories || []).length ? "done" : "pending", `${rawState?.memories?.length || 0} item(s)`, [".project-agent/state.json"]));
  if (goal) addUniqueEdge(edges, seenEdges, "goal", "memory", "scopes", [goal.id]);
  for (const memory of (rawState?.memories || []).slice(-5)) {
    addUniqueNode(nodes, seenNodes, kgNode(memory.id, memory.content, "memory", "done", memory.kind, [memory.sourceId]));
    addUniqueEdge(edges, seenEdges, "memory", memory.id, "contains", [memory.id]);
    if (goal) addUniqueEdge(edges, seenEdges, memory.id, "goal", "recalls", [goal.id]);
  }

  for (const action of (summary.actions || []).slice(0, 6)) {
    addUniqueNode(nodes, seenNodes, kgNode(action.id, action.title, "action", action.status, action.activityClass, [action.id]));
    if (goal) addUniqueEdge(edges, seenEdges, "goal", action.id, "plans", [goal.id]);
  }

  for (const evidence of (summary.evidence || []).slice(0, 6)) {
    addUniqueNode(nodes, seenNodes, kgNode(evidence.id, evidence.summary, "evidence", "done", evidence.kind, [evidence.ref]));
    for (const target of evidence.verifies || []) addUniqueEdge(edges, seenEdges, evidence.id, target, "verifies", [evidence.id]);
  }

  for (const decision of (summary.decisions || []).slice(0, 4)) {
    addUniqueNode(nodes, seenNodes, kgNode(decision.id, decision.title || decision.decision, "decision", "done", "decision", [decision.id]));
    addUniqueEdge(edges, seenEdges, "kernel", decision.id, "records", [decision.id]);
  }

  addUniqueNode(nodes, seenNodes, kgNode("architecture", "Project Architecture", "architecture", "done", `${architecture?.totals?.files || 0} files`, ["project tree"]));
  addUniqueEdge(edges, seenEdges, "project", "architecture", "contains", ["project tree"]);
  for (const file of (architecture?.recentChanges || architecture?.files || []).slice(0, 8)) {
    const id = `file:${file.path}`;
    const meta = [file.kind || "file", file.summary].filter(Boolean).join(" ");
    addUniqueNode(nodes, seenNodes, kgNode(id, file.path, "file", file.status === "unchanged" ? "done" : file.status, meta, [file.path, file.hash]));
    addUniqueEdge(edges, seenEdges, "architecture", id, file.status === "unchanged" ? "contains" : file.status, [file.path]);
  }

  if ((runtimeEvents || []).length) {
    addUniqueNode(nodes, seenNodes, kgNode("session", "Agent Session", "session", "done", `${runtimeEvents.length} event(s)`, [".project-agent/runtime.json"]));
    addUniqueEdge(edges, seenEdges, "project", "session", "runs", [".project-agent/runtime.json"]);
    const firstEventByWorkstream = new Map();
    for (const event of runtimeEvents) {
      const workstream = detectWorkstream(event);
      if (!firstEventByWorkstream.has(workstream.id)) firstEventByWorkstream.set(workstream.id, { workstream, event });
    }
    for (const { workstream, event } of firstEventByWorkstream.values()) {
      const streamId = `workstream:${workstream.id}`;
      addUniqueNode(nodes, seenNodes, kgNode(streamId, workstream.label, "workstream", event.status === "current" ? "current" : "done", workstream.description, [event.id, event.source]));
      addUniqueEdge(edges, seenEdges, "session", streamId, "classifies", [event.id]);
    }
    const currentEvent = runtimeEvents.find((event) => event.status === "current");
    const graphEvents = [];
    const seenGraphEvents = new Set();
    for (const event of [currentEvent, runtimeEvents[0], ...runtimeEvents]) {
      if (!event || seenGraphEvents.has(event.id)) continue;
      seenGraphEvents.add(event.id);
      graphEvents.push(event);
      if (graphEvents.length >= 6) break;
    }
    for (const event of graphEvents) {
      const workstream = detectWorkstream(event);
      const streamId = `workstream:${workstream.id}`;
      addUniqueNode(nodes, seenNodes, kgNode(streamId, workstream.label, "workstream", event.status === "current" ? "current" : "done", workstream.description, [event.id, event.source]));
      addUniqueEdge(edges, seenEdges, "session", streamId, "classifies", [event.id]);
      const eventId = `event:${event.id}`;
      addUniqueNode(nodes, seenNodes, kgNode(eventId, event.title, "event", event.status, [event.phase, workstream.label, event.tool].filter(Boolean).join(" "), [event.id, event.source]));
      addUniqueEdge(edges, seenEdges, "session", eventId, "emits", [event.id]);
      addUniqueEdge(edges, seenEdges, eventId, streamId, "classified_as", [event.id]);
      if (event.goalId || goal) addUniqueEdge(edges, seenEdges, eventId, "goal", "updates", [event.goalId || goal?.id]);
      for (const file of event.files || []) {
        const fileId = `file:${file.path}`;
        addUniqueNode(nodes, seenNodes, kgNode(fileId, file.path, "file", file.status || "done", [file.kind || "file", file.summary].filter(Boolean).join(" "), [file.path, file.hash]));
        addUniqueEdge(edges, seenEdges, eventId, fileId, "touches", [event.id, file.path]);
      }
    }
  }

  if (handoff) {
    addUniqueNode(nodes, seenNodes, kgNode("handoff", "Handoff Packet", "handoff", "done", "ready", [handoff.id]));
    addUniqueEdge(edges, seenEdges, "goal", "handoff", "summarizes", [handoff.id]);
    addUniqueEdge(edges, seenEdges, "memory", "handoff", "persists", [handoff.id]);
  }

  if (agentmemoryGraph?.available && agentmemoryGraph.nodes.length) {
    addUniqueNode(nodes, seenNodes, kgNode("agentmemory", "AgentMemory Graph", "external", "done", `${agentmemoryGraph.nodes.length} node(s)`, agentmemoryGraph.nodes.slice(0, 4).map((item) => item.id)));
    addUniqueEdge(edges, seenEdges, "memory", "agentmemory", "syncs", agentmemoryGraph.nodes.slice(0, 4).map((item) => item.id));
  }

  return {
    nodes: layoutGraph(nodes),
    edges,
    readyCount: nodes.filter((item) => item.status !== "pending").length,
    totalCount: nodes.length,
    source: agentmemoryGraph?.available ? "project-agent+agentmemory" : "project-agent",
    legend: ["project", "kernel", "kernelConcept", "goal", "workstream", "memory", "evidence", "architecture", "file", "handoff"]
  };
}

const PHASE_ORDER = ["observe", "plan", "execute", "evidence", "audit", "handoff"];
const FRESH_EVENT_MS = 5 * 60 * 1000;
const INTERNAL_EVENT_FILES = new Set([
  ".project-agent/runtime.json",
  ".project-agent/memory-graph.json",
  ".project-agent/process-trace.json",
  ".project-agent/architecture-map.json",
  ".project-agent/takeover-packet.json",
  ".project-agent/continuity-audit.json",
  ".project-agent/governance-spec.json",
  ".project-agent/state-manifest.json",
  ".project-agent/agent-runbook.json",
  ".project-agent/continuity-contract.json",
  ".project-agent/continuity.json",
  ".project-agent/recovery.md",
  ".project-agent/resume.md",
  ".project-agent/next-agent-prompt.md"
]);

function eventAgeMs(event) {
  const timestamp = Date.parse(event?.at || "");
  if (!Number.isFinite(timestamp)) return Infinity;
  return Date.now() - timestamp;
}

function isFreshEvent(event) {
  return eventAgeMs(event) <= FRESH_EVENT_MS;
}

function isInternalGeneratedEvent(event = {}) {
  const files = Array.isArray(event.files) ? event.files : [];
  if (!files.length) return false;
  const allInternal = files.every((file) => INTERNAL_EVENT_FILES.has(file.path));
  return allInternal && /^(architecture|handoff|auto|agent-run)/.test(String(event.source || ""));
}

function normalizeEvent(event) {
  const files = Array.isArray(event.files) ? event.files : [];
  const normalized = {
    id: event.id,
    at: event.at,
    phase: event.phase || "observe",
    title: event.title || "Event",
    status: event.status || "done",
    detail: event.detail || files.map((file) => [file.path, file.summary].filter(Boolean).join(" ")).join(", "),
    refs: event.refs || [],
    files,
    agentId: event.agentId,
    goalId: event.goalId,
    tool: event.tool,
    source: event.source,
    spanId: event.spanId,
    parentId: event.parentId || event.parentEventId || event.parentSpanId,
    parentEventId: event.parentEventId || event.parentId || event.parentSpanId,
    runId: event.runId,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    durationMs: event.durationMs,
    cost: event.cost,
    error: event.error,
    artifactRefs: event.artifactRefs || [],
    data: event.data
  };
  return { ...normalized, workstream: detectWorkstream(normalized) };
}

function workstreamForPhase(phase) {
  if (phase === "observe") return workstreamMeta("discussion");
  if (phase === "plan") return workstreamMeta("strategy");
  if (phase === "audit") return workstreamMeta("qa_testing");
  if (phase === "handoff" || phase === "evidence") return workstreamMeta("governance");
  return workstreamMeta("implementation");
}

function buildWorkstreamSummary({ events, currentEvent, nextEvent }) {
  const counts = Object.fromEntries(WORKSTREAM_ORDER.map((id) => [id, 0]));
  const latestById = {};
  for (const event of events || []) {
    const stream = event.workstream || detectWorkstream(event);
    counts[stream.id] += 1;
    if (!latestById[stream.id]) latestById[stream.id] = event;
  }
  const active = currentEvent?.workstream || workstreamForPhase(currentEvent?.phase);
  const next = nextEvent?.workstream || workstreamForPhase(nextEvent?.phase);
  const lanes = WORKSTREAM_ORDER.map((id) => {
    const meta = workstreamMeta(id);
    const latest = latestById[id];
    return {
      ...meta,
      count: counts[id],
      status: id === active.id ? "current" : counts[id] ? "done" : "pending",
      latestTitle: latest?.title,
      latestAt: latest?.at
    };
  });
  return { active, next, lanes, counts };
}

function sameRuntimeOperation(current, later) {
  if (!current || !later) return false;
  if (current.id && later.id && current.id === later.id) return true;
  const sharedSource = current.source && later.source && current.source === later.source;
  const sharedTool = current.tool && later.tool && current.tool === later.tool;
  const sharedAgent = current.agentId && later.agentId && current.agentId === later.agentId;
  const titleContinues = later.title && current.title && later.title.startsWith(current.title);
  return Boolean((sharedSource && sharedTool && (sharedAgent || titleContinues)) || (sharedSource && sharedAgent && titleContinues));
}

function currentEventIsSuperseded(event, newerEvents) {
  if (event?.status !== "current") return false;
  return newerEvents.some((candidate) => ["done", "failed", "blocked"].includes(candidate.status) && sameRuntimeOperation(event, candidate));
}

function buildInterruptedWork({ process, agentLeases }) {
  const staleById = new Map((agentLeases || []).filter((agent) => agent.effectiveStatus === "stale").map((agent) => [agent.id, agent]));
  const events = process?.events || [];
  const items = events
    .map((event, index) => ({ event, newerEvents: events.slice(0, index) }))
    .filter(({ event, newerEvents }) => event.status === "current" && !currentEventIsSuperseded(event, newerEvents))
    .filter(({ event }) => event.agentId && staleById.has(event.agentId))
    .map(({ event }) => {
      const lease = staleById.get(event.agentId);
      const files = (event.files || []).map((file) => ({
        path: file.path,
        status: file.status,
        kind: file.kind,
        summary: file.summary,
        hash: file.hash
      }));
      return {
        id: event.id,
        agentId: event.agentId,
        leaseStatus: lease?.effectiveStatus || "unknown",
        leaseAgeSeconds: lease?.ageSeconds ?? null,
        phase: event.phase,
        status: event.status,
        title: event.title,
        detail: event.detail,
        workstream: event.workstream,
        at: event.at,
        tool: event.tool,
        source: event.source,
        refs: [...new Set([...(event.refs || []), ...files.map((file) => file.path)].filter(Boolean))].slice(0, 10),
        files,
        recoveryAction: "Inspect refs/files, decide whether to resume, mark failed, or replace with a new current event."
      };
    })
    .slice(0, 8);
  return {
    status: items.length ? "suspected_interruption" : "clear",
    tone: items.length ? "warn" : "ok",
    count: items.length,
    items,
    nextAction: items.length
      ? "Resolve interrupted work before starting unrelated edits; inspect each stale current event and its files."
      : "No stale current work detected."
  };
}

function buildProcessTrail({ flow, runtimeEvents, hookIngresses = [], terminalSnapshot, architecture }) {
  const liveEvent = terminalSnapshot?.currentCommand
    ? {
        id: "terminal-current",
        at: terminalSnapshot.currentCommand.startedAt || new Date().toISOString(),
        phase: "execute",
        title: "Command running",
        status: "current",
        detail: terminalSnapshot.currentCommand.command,
        refs: ["terminal-session"]
      }
    : null;
  const runtimeChangeKeys = new Set(
    (runtimeEvents || []).flatMap((event) =>
      (event.files || []).map((file) => [file.status, file.path, file.hash || ""].filter(Boolean).join(":"))
    )
  );
  const architectureEvents = ((architecture?.changes?.length ? architecture.changes : architecture?.recentChanges) || [])
    .filter((change) => !runtimeChangeKeys.has([change.status, change.path, change.hash || ""].filter(Boolean).join(":")))
    .slice(0, 6)
    .map((change, index) => ({
      id: `arch-${index}-${change.path}`,
      at: change.modifiedAt,
      phase: "execute",
      title: `File ${change.status}`,
      status: change.status === "deleted" ? "current" : "done",
      detail: [change.path, change.summary].filter(Boolean).join(" "),
      refs: [change.path, change.hash || change.previousHash].filter(Boolean)
    }));
  const events = [liveEvent, ...architectureEvents, ...(runtimeEvents || [])]
    .filter(Boolean)
    .map(normalizeEvent)
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
    .slice(0, 24);

  const liveCurrent = events.find((event) => event.id === "terminal-current");
  const latestEvent = events[0] || null;
  const activeCurrent = events.find((event, index) => event.status === "current" && !currentEventIsSuperseded(event, events.slice(0, index)));
  const currentEvent = liveCurrent || activeCurrent || latestEvent;
  const currentPhase = currentEvent?.phase || flow.find((step) => step.status === "current")?.id || "observe";
  const phaseIndex = Math.max(PHASE_ORDER.indexOf(currentPhase), 0);
  const previous = events.find((event) => event.id !== currentEvent?.id && PHASE_ORDER.indexOf(event.phase) <= phaseIndex) || null;
  const nextFlow = flow.find((step) => step.status === "current") || flow.find((step) => step.status === "pending") || flow[flow.length - 1];
  const nextEvent = nextFlow
    ? {
        id: `next-${nextFlow.id}`,
        phase: nextFlow.id,
        title: nextFlow.label,
        status: nextFlow.status,
        detail: nextFlow.detail,
        refs: nextFlow.provenance || [],
        workstream: nextFlow.workstream || workstreamForPhase(nextFlow.id)
      }
    : null;
  const fallbackCurrent = currentEvent || {
    id: nextFlow.id,
    at: new Date().toISOString(),
    phase: nextFlow.id,
    title: nextFlow.label,
    status: nextFlow.status,
    detail: nextFlow.detail,
    refs: nextFlow.provenance || [],
    workstream: nextFlow.workstream || workstreamForPhase(nextFlow.id)
  };
  const workstreams = buildWorkstreamSummary({ events, currentEvent: fallbackCurrent, nextEvent });

  return {
    previous,
    current: fallbackCurrent,
    next: nextEvent,
    workstream: workstreams.active,
    workstreams,
    phases: flow.map((step) => ({
      id: step.id,
      label: step.label,
      status: step.status,
      detail: step.detail,
      workstream: step.workstream || workstreamForPhase(step.id)
    })),
    events,
    hookIngresses: (hookIngresses || []).slice(0, 20)
  };
}

function buildEventCurrentStep(currentStep, process) {
  const event = process?.current;
  if (!event || (event.status !== "current" && !isFreshEvent(event))) return currentStep;
  return {
    label: event.status === "current" ? event.title : `Latest: ${event.title}`,
    body: event.detail || event.phase,
    tone: statusTone(event.status),
    source: [event.workstream?.label, event.source || "agent-event", event.tool || event.phase].filter(Boolean),
    workstream: event.workstream,
    provenance: [event.id, ...(event.refs || [])].filter(Boolean)
  };
}

function latestUniqueChanges(changes, limit = 12) {
  const seen = new Set();
  const unique = [];
  for (const change of changes || []) {
    if (!change?.path || seen.has(change.path)) continue;
    seen.add(change.path);
    unique.push(change);
    if (unique.length >= limit) break;
  }
  return unique;
}

function ageSeconds(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function takeoverCheck(id, label, status, detail, refs = []) {
  return { id, label, status, detail, refs: refs.filter(Boolean) };
}

function buildTakeoverReadiness({ goal, currentStep, kernelSummary, process, changedFiles, architecture, agentLeases, handoffSnapshot, stateRefs, interruptedWork }) {
  const snapshotAge = ageSeconds(handoffSnapshot?.updatedAt);
  const staleAgents = (agentLeases || []).filter((agent) => agent.effectiveStatus === "stale");
  const activeCursor = process?.current;
  const topFolders = architecture?.impact?.topFolders || architecture?.impact?.folders || [];
  const checks = [
    takeoverCheck(
      "goal",
      "Active Goal",
      goal ? "ok" : "bad",
      goal ? `${goal.status}: ${goal.objective}` : "No active goal found.",
      goal ? [goal.id] : []
    ),
    takeoverCheck(
      "cursor",
      "Current Cursor",
      activeCursor ? "ok" : "bad",
      activeCursor ? `${activeCursor.phase}/${activeCursor.status}: ${activeCursor.title}` : "No process cursor available.",
      activeCursor ? [activeCursor.id, ...(activeCursor.refs || [])] : []
    ),
    takeoverCheck(
      "snapshot",
      "Snapshot",
      handoffSnapshot?.status === "done" ? "ok" : handoffSnapshot?.status === "failed" ? "bad" : "warn",
      handoffSnapshot
        ? `${handoffSnapshot.status}${snapshotAge !== null ? `, ${snapshotAge}s old` : ""}${handoffSnapshot.reason ? `, ${handoffSnapshot.reason}` : ""}`
        : "No handoff snapshot recorded.",
      [handoffSnapshot?.resumeFile, handoffSnapshot?.recoveryFile]
    ),
    takeoverCheck(
      "kernel",
      "Project Kernel",
      kernelSummary?.philosophy?.length || kernelSummary?.architecture?.length ? "ok" : "warn",
      kernelSummary?.sourceRefs?.length ? `Loaded from ${kernelSummary.sourceRefs.slice(0, 3).join(", ")}` : "Kernel summary is missing.",
      kernelSummary?.sourceRefs || []
    ),
    takeoverCheck(
      "workstream",
      "Workstream",
      process?.workstream?.id ? "ok" : "warn",
      process?.workstream ? `${process.workstream.label}: ${process.workstream.description}` : "No workstream classification available.",
      []
    ),
    takeoverCheck(
      "architecture",
      "Architecture Impact",
      topFolders.length ? "ok" : "warn",
      topFolders.length ? `${topFolders.length} impacted folder(s); top ${topFolders[0].folder}` : "No impacted folders captured.",
      topFolders.slice(0, 3).map((folder) => folder.latestFile)
    ),
    takeoverCheck(
      "changed_files",
      "Changed Files",
      changedFiles.length ? "ok" : "warn",
      changedFiles.length ? `${changedFiles.length} changed file(s) to inspect first.` : "No changed files captured.",
      changedFiles.slice(0, 4).map((file) => file.path)
    ),
    takeoverCheck(
      "agent_leases",
      "Agent Leases",
      staleAgents.length ? "warn" : "ok",
      staleAgents.length ? `${staleAgents.length} stale agent(s) may indicate a crashed prior session.` : `${agentLeases?.length || 0} agent lease(s) known.`,
      staleAgents.slice(0, 3).map((agent) => agent.id)
    ),
    takeoverCheck(
      "interrupted_work",
      "Interrupted Work",
      interruptedWork?.count ? "warn" : "ok",
      interruptedWork?.count ? `${interruptedWork.count} stale current operation(s) need resolution.` : "No stale current work detected.",
      (interruptedWork?.items || []).flatMap((item) => [item.id, ...(item.refs || []).slice(0, 2)]).slice(0, 6)
    ),
    takeoverCheck(
      "state_refs",
      "Read-First Files",
      stateRefs?.length ? "ok" : "bad",
      stateRefs?.length ? `${stateRefs.length} read-first reference(s) listed.` : "No read-first files listed.",
      stateRefs || []
    )
  ];
  const bad = checks.filter((check) => check.status === "bad");
  const warn = checks.filter((check) => check.status === "warn");
  const ok = checks.filter((check) => check.status === "ok");
  const canTakeOver = bad.length === 0;
  return {
    status: canTakeOver ? "ready" : "blocked",
    tone: canTakeOver ? (warn.length ? "warn" : "ok") : "bad",
    canTakeOver,
    score: `${ok.length}/${checks.length}`,
    summary: canTakeOver
      ? warn.length
        ? `Ready with ${warn.length} warning(s).`
        : "Ready for a new agent to continue."
      : `Blocked by ${bad.length} missing required item(s).`,
    checks,
    readFirst: (stateRefs || []).slice(0, 6)
  };
}

function lifecycleCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 220),
    refs: refs.filter(Boolean).slice(0, 8)
  };
}

function buildHandoffLifecycle({ goal, handoff, handoffSnapshot, takeoverReadiness, interruptedWork, agentLeases = [], preEditRisk }) {
  const snapshotAge = ageSeconds(handoffSnapshot?.updatedAt);
  const staleAgents = (agentLeases || []).filter((agent) => agent.effectiveStatus === "stale");
  const ttlSeconds = 900;
  const snapshotExpired = snapshotAge !== null && snapshotAge > ttlSeconds;
  const hasSnapshot = handoffSnapshot?.status === "done";
  const canTakeOver = Boolean(takeoverReadiness?.canTakeOver);
  const blocked = Boolean(interruptedWork?.count || staleAgents.length || handoffSnapshot?.status === "failed" || !canTakeOver);
  const expired = snapshotExpired || Boolean(preEditRisk?.status === "blocked");
  const accepted = Boolean((handoff || hasSnapshot) && canTakeOver && !blocked && !expired);
  const status = blocked || expired
    ? "expired"
    : accepted
      ? "accepted"
      : canTakeOver
        ? "open"
        : "expired";
  const checks = [
    lifecycleCheck(
      "takeover_readiness",
      "Takeover Readiness",
      canTakeOver ? "ok" : "bad",
      takeoverReadiness?.summary || "Takeover readiness is not available.",
      takeoverReadiness?.readFirst || []
    ),
    lifecycleCheck(
      "handoff_snapshot",
      "Handoff Snapshot",
      handoffSnapshot?.status === "done" ? (snapshotExpired ? "warn" : "ok") : handoffSnapshot?.status === "failed" ? "bad" : "warn",
      handoffSnapshot
        ? `${handoffSnapshot.status}${snapshotAge !== null ? `, ${snapshotAge}s old` : ""}${snapshotExpired ? ", expired" : ""}`
        : "No generated handoff snapshot is available yet.",
      [handoffSnapshot?.resumeFile, handoffSnapshot?.recoveryFile, handoffSnapshot?.nextAgentPromptFile]
    ),
    lifecycleCheck(
      "interrupted_work",
      "Interrupted Work",
      interruptedWork?.count ? "bad" : "ok",
      interruptedWork?.count ? `${interruptedWork.count} stale current operation(s) must be closed before accepting the handoff.` : "No interrupted work blocks handoff acceptance.",
      (interruptedWork?.items || []).flatMap((item) => [item.id, ...(item.refs || [])])
    ),
    lifecycleCheck(
      "agent_leases",
      "Agent Leases",
      staleAgents.length ? "warn" : "ok",
      staleAgents.length ? `${staleAgents.length} stale lease(s) could mean the handoff is no longer fresh.` : `${agentLeases.length || 0} agent lease(s) known.`,
      staleAgents.map((agent) => agent.id)
    ),
    lifecycleCheck(
      "pre_edit_risk",
      "Pre-Edit Risk",
      preEditRisk?.status === "blocked" ? "bad" : ["high", "medium"].includes(preEditRisk?.status) ? "warn" : "ok",
      preEditRisk?.summary || "No pre-edit risk summary is available yet.",
      preEditRisk?.refs || []
    )
  ];
  return {
    schemaVersion: "project-agent.handoff-lifecycle.v1",
    status,
    stateOrder: ["open", "accepted", "expired", "cancelled"],
    handoffId: handoff?.id || null,
    goalId: goal?.id || null,
    openedAt: handoff?.createdAt || handoffSnapshot?.updatedAt || null,
    acceptedAt: status === "accepted" ? handoffSnapshot?.updatedAt || handoff?.createdAt || null : null,
    expiresAt: handoffSnapshot?.updatedAt ? new Date(Date.parse(handoffSnapshot.updatedAt) + ttlSeconds * 1000).toISOString() : null,
    ttlSeconds,
    ageSeconds: snapshotAge,
    summary:
      status === "accepted"
        ? "Handoff is accepted: durable snapshot, takeover readiness, and pre-edit checks are sufficient for a new agent."
        : status === "open"
          ? "Handoff is open: a new agent can resume, but no accepted handoff snapshot has been confirmed yet."
          : "Handoff is expired: refresh snapshot, close stale work, or restore takeover readiness before a new agent trusts it.",
    checks,
    refs: [
      ".project-agent/continuity.json",
      ".project-agent/agent-context-bundle.json",
      ".project-agent/resume.md",
      ".project-agent/recovery.md",
      ".project-agent/next-agent-prompt.md"
    ],
    nextAction:
      status === "accepted"
        ? "New agent should read the bundle, run verification, and record a fresh heartbeat before editing."
        : status === "open"
          ? "Generate or refresh a handoff snapshot, then run the takeover drill."
          : "Refresh resume/recovery/prompt files and resolve any stale current work before takeover."
  };
}

function freshnessCheck(id, label, status, detail, refs = [], observedAt = null, ttlSeconds = null) {
  const parsed = Date.parse(observedAt || "");
  const validUntil = Number.isFinite(parsed) && Number.isFinite(ttlSeconds)
    ? new Date(parsed + ttlSeconds * 1000).toISOString()
    : null;
  return {
    id,
    label,
    status,
    detail: compact(detail, 240),
    observedAt,
    validFrom: observedAt,
    validUntil,
    ageSeconds: ageSeconds(observedAt),
    refs: refs.filter(Boolean).slice(0, 8)
  };
}

function earliestIso(values = []) {
  const timestamps = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function latestIso(values = []) {
  const timestamps = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function runGit(projectDir, args = []) {
  if (!projectDir) return null;
  try {
    return execFileSync("git", ["-C", projectDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1200
    }).trim();
  } catch {
    return null;
  }
}

function parseGitStatusLine(line) {
  if (!line) return null;
  const code = line.slice(0, 2);
  const indexStatus = line.slice(0, 1);
  const worktreeStatus = line.slice(1, 2);
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  return {
    code,
    indexStatus,
    worktreeStatus,
    path: filePath,
    stateFile: filePath.startsWith(".project-agent/"),
    untracked: code === "??",
    staged: indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!",
    modified: code.includes("M"),
    deleted: code.includes("D")
  };
}

function buildGitFreshness(projectDir) {
  const checkedAt = new Date().toISOString();
  if (!projectDir || runGit(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return {
      schemaVersion: "project-agent.git-freshness.v1",
      status: "unavailable",
      checkedAt,
      summary: "Git freshness is unavailable; project state cannot be compared to a repository snapshot.",
      repo: { available: false },
      dirty: { entries: 0, tracked: 0, untracked: 0, stateFiles: 0, sourceFiles: 0 },
      changes: [],
      refs: [],
      nextAction: "Initialize or expose git metadata if repo-level freshness should gate handoff."
    };
  }
  const root = runGit(projectDir, ["rev-parse", "--show-toplevel"]);
  const branch = runGit(projectDir, ["branch", "--show-current"]) || "detached";
  const fullHead = runGit(projectDir, ["rev-parse", "HEAD"]);
  const shortHead = fullHead ? runGit(projectDir, ["rev-parse", "--short", "HEAD"]) : null;
  const statusText = runGit(projectDir, ["status", "--porcelain=v1"]) || "";
  const changes = statusText.split(/\r?\n/).map(parseGitStatusLine).filter(Boolean);
  const tracked = changes.filter((item) => !item.untracked);
  const untracked = changes.filter((item) => item.untracked);
  const stateFiles = changes.filter((item) => item.stateFile);
  const sourceFiles = changes.filter((item) => !item.stateFile);
  const status = changes.length ? "dirty" : fullHead ? "clean" : "unborn";
  return {
    schemaVersion: "project-agent.git-freshness.v1",
    status,
    checkedAt,
    summary:
      status === "clean"
        ? `Git tree is clean at ${shortHead || "HEAD"} on ${branch}.`
        : status === "unborn"
          ? `Git repository has no commit yet on ${branch}; handoff state has no commit anchor.`
          : `Git tree has ${changes.length} change(s): ${tracked.length} tracked, ${untracked.length} untracked.`,
    repo: {
      available: true,
      root,
      branch,
      head: shortHead,
      fullHead,
      hasHead: Boolean(fullHead)
    },
    dirty: {
      entries: changes.length,
      tracked: tracked.length,
      untracked: untracked.length,
      stateFiles: stateFiles.length,
      sourceFiles: sourceFiles.length
    },
    changes: changes.slice(0, 12),
    refs: [root ? ".git/HEAD" : null, ...changes.slice(0, 8).map((item) => item.path)].filter(Boolean),
    nextAction:
      status === "clean"
        ? "Use this commit anchor with the state manifest before trusting handoff artifacts."
        : status === "dirty"
          ? "Review or commit/stash dirty source files before claiming a reproducible handoff snapshot."
          : "Create an initial commit if handoff freshness must be tied to a git revision."
  };
}

function buildFreshnessGate({ projectDir = "", processTrace = {}, architectureTrace = {}, handoffLifecycle = {}, handoffSnapshot = null, preEditRisk = {}, agentLeases = [], interruptedWork = {} }) {
  const ttls = {
    processCursor: 900,
    architectureScan: 1800,
    handoffSnapshot: handoffLifecycle?.ttlSeconds || 900,
    preEditRisk: 900,
    gitSnapshot: 300
  };
  const currentObservedAt = processTrace?.current?.at || processTrace?.events?.[0]?.at || null;
  const architectureObservedAt = architectureTrace?.scannedAt || architectureTrace?.changedFiles?.find((file) => file.modifiedAt)?.modifiedAt || null;
  const handoffObservedAt = handoffSnapshot?.updatedAt || handoffLifecycle?.acceptedAt || handoffLifecycle?.openedAt || null;
  const preEditObservedAt = currentObservedAt || architectureObservedAt || handoffObservedAt;
  const staleAgents = (agentLeases || []).filter((agent) => agent.effectiveStatus === "stale");
  const gitFreshness = buildGitFreshness(projectDir || architectureTrace?.projectDir);
  const checks = [
    freshnessCheck(
      "process_cursor",
      "Process Cursor",
      processTrace?.current
        ? !currentObservedAt || ageSeconds(currentObservedAt) > ttls.processCursor ? "warn" : "ok"
        : "bad",
      processTrace?.current
        ? `${processTrace.current.phase}/${processTrace.current.status}: ${processTrace.current.title}${ageSeconds(currentObservedAt) !== null ? `, ${ageSeconds(currentObservedAt)}s old` : ""}.`
        : "No current process cursor is available.",
      [".project-agent/process-trace.json", processTrace?.current?.id],
      currentObservedAt,
      ttls.processCursor
    ),
    freshnessCheck(
      "architecture_scan",
      "Architecture Scan",
      architectureTrace?.totals?.files
        ? !architectureObservedAt || ageSeconds(architectureObservedAt) > ttls.architectureScan ? "warn" : "ok"
        : "bad",
      architectureTrace?.totals?.files
        ? `${architectureTrace.totals.files} file(s) scanned${ageSeconds(architectureObservedAt) !== null ? `, ${ageSeconds(architectureObservedAt)}s old` : ""}.`
        : "No architecture scan is available.",
      [".project-agent/architecture-map.json", architectureTrace?.topFolders?.[0]?.latestFile],
      architectureObservedAt,
      ttls.architectureScan
    ),
    freshnessCheck(
      "handoff_snapshot",
      "Handoff Snapshot",
      handoffLifecycle?.status === "expired"
        ? "warn"
        : handoffSnapshot?.status === "failed"
          ? "bad"
          : handoffSnapshot?.status === "done" || handoffLifecycle?.status === "accepted"
            ? !handoffObservedAt || ageSeconds(handoffObservedAt) > ttls.handoffSnapshot ? "warn" : "ok"
            : "warn",
      handoffLifecycle?.summary || handoffSnapshot?.reason || "No typed handoff lifecycle is available.",
      [".project-agent/continuity.json", ".project-agent/resume.md", ".project-agent/recovery.md"],
      handoffObservedAt,
      ttls.handoffSnapshot
    ),
    freshnessCheck(
      "pre_edit_risk",
      "Pre-Edit Risk",
      preEditRisk?.status === "blocked" ? "bad" : !preEditObservedAt || ["high", "medium"].includes(preEditRisk?.status) ? "warn" : "ok",
      preEditRisk?.summary || "No pre-edit risk summary is available.",
      preEditRisk?.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"],
      preEditObservedAt,
      ttls.preEditRisk
    ),
    freshnessCheck(
      "agent_activity",
      "Agent Activity",
      interruptedWork?.count ? "bad" : staleAgents.length ? "warn" : "ok",
      interruptedWork?.count
        ? `${interruptedWork.count} stale current operation(s) may make this state invalid.`
        : staleAgents.length
          ? `${staleAgents.length} stale agent lease(s) should be checked before trusting the handoff.`
          : `${agentLeases.length || 0} agent lease(s) known; no stale current work detected.`,
      [...staleAgents.map((agent) => agent.id), ...(interruptedWork?.items || []).flatMap((item) => [item.id, ...(item.refs || [])])],
      latestIso((agentLeases || []).map((agent) => agent.lastSeenAt || agent.createdAt)),
      ttls.processCursor
    ),
    freshnessCheck(
      "git_snapshot",
      "Git Snapshot",
      gitFreshness.status === "clean" ? "ok" : "warn",
      gitFreshness.summary,
      gitFreshness.refs || [],
      gitFreshness.checkedAt,
      ttls.gitSnapshot
    )
  ];
  const bad = checks.filter((check) => check.status === "bad");
  const warn = checks.filter((check) => check.status === "warn");
  const validUntil = earliestIso(checks.map((check) => check.validUntil));
  const observedAt = latestIso(checks.map((check) => check.observedAt));
  const validUntilAge = validUntil ? Date.parse(validUntil) - Date.now() : null;
  const status = bad.length
    ? "expired"
    : validUntilAge !== null && validUntilAge < 0
      ? "stale"
      : warn.length
        ? "watch"
        : "fresh";
  return {
    schemaVersion: "project-agent.freshness-gate.v1",
    status,
    summary:
      status === "fresh"
        ? "Project state is fresh enough for a new agent to trust after bundle verification."
        : status === "watch"
          ? `Project state is usable with ${warn.length} freshness warning(s); refresh the cited artifact before broad edits.`
          : status === "stale"
            ? "Project state has passed its freshness window; record a fresh event or refresh generated artifacts before editing."
            : `Project state has ${bad.length} invalid freshness check(s); repair those before takeover.`,
    observedAt,
    validity: {
      observedAt,
      validFrom: earliestIso(checks.map((check) => check.observedAt)),
      validUntil,
      expiredAt: ["stale", "expired"].includes(status) ? validUntil : null,
      ttlSeconds: ttls
    },
    checks,
    git: gitFreshness,
    staleChecks: checks.filter((check) => ["bad", "warn"].includes(check.status)).map((check) => check.id),
    refs: [
      ".project-agent/agent-context-bundle.json",
      ".project-agent/process-trace.json",
      ".project-agent/architecture-map.json",
      ".project-agent/state-manifest.json",
      ".project-agent/continuity.json"
    ],
    nextAction:
      status === "fresh"
        ? "Run bundle verification, then record the next current event before editing."
        : status === "watch"
          ? "Refresh the warning artifact or record a current event before editing a broad surface."
          : "Refresh process trace, architecture map, handoff snapshot, and state manifest before trusting this handoff."
  };
}

function evalCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 240),
    refs: refs.filter(Boolean).slice(0, 8)
  };
}

function runtimeSpanTone(status) {
  if (["failed", "blocked"].includes(status)) return "bad";
  if (["current", "pending"].includes(status)) return "warn";
  return "ok";
}

function eventParentId(event = {}) {
  return event.parentId || event.parentEventId || event.parentSpanId || event.data?.ingress?.parentId || null;
}

function eventRunId(event = {}) {
  return event.runId || event.data?.ingress?.runId || null;
}

function eventDurationMs(event = {}) {
  if (Number.isFinite(Number(event.durationMs))) return Math.max(0, Math.round(Number(event.durationMs)));
  const startedAt = Date.parse(event.startedAt || "");
  const endedAt = Date.parse(event.endedAt || "");
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
    return Math.round(endedAt - startedAt);
  }
  return null;
}

function eventError(event = {}) {
  if (event.error) return compact(typeof event.error === "string" ? event.error : event.error.message || JSON.stringify(event.error), 260);
  if (["failed", "blocked"].includes(event.status) && event.detail) return compact(event.detail, 260);
  return null;
}

function eventArtifactRefs(event = {}) {
  return [...new Set([...(event.artifactRefs || []), ...(event.outputFiles || [])].filter(Boolean).map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") return item.ref || item.path || item.url || item.id;
    return null;
  }).filter(Boolean))].slice(0, 10);
}

function phaseLedgerCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: (refs || []).filter(Boolean).slice(0, 8)
  };
}

function phaseTreeNode(span, childrenByParent, depth = 0, seen = new Set()) {
  if (!span || seen.has(span.spanId)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(span.spanId);
  const children = depth >= 3
    ? []
    : (childrenByParent.get(span.spanId) || [])
        .slice(0, 6)
        .map((child) => phaseTreeNode(child, childrenByParent, depth + 1, nextSeen))
        .filter(Boolean);
  return {
    spanId: span.spanId,
    eventId: span.eventId,
    parentSpanId: span.parentSpanId,
    runId: span.runId,
    phase: span.phase,
    status: span.status,
    title: span.title,
    tool: span.tool,
    source: span.source,
    durationMs: span.durationMs,
    error: span.error,
    refs: (span.refs || []).slice(0, 5),
    artifactRefs: (span.artifactRefs || []).slice(0, 5),
    children
  };
}

function buildPhaseLedger(processTrace = {}) {
  const seen = new Set();
  const sequence = [processTrace.previous, processTrace.current, processTrace.next, ...(processTrace.events || [])]
    .filter(Boolean)
    .filter((event, index) => {
      const id = event.spanId || event.id || `${event.label || event.phase}:${event.title}:${event.at}:${index}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 24);
  const spans = sequence.map((event, index) => {
    const spanId = event.spanId || event.id || `span_${stableHash({ title: event.title, at: event.at, index }).slice(0, 10)}`;
    const refs = [...new Set([...(event.refs || []), ...(event.files || []).map((file) => file.path)].filter(Boolean))].slice(0, 12);
    const artifactRefs = eventArtifactRefs(event);
    const durationMs = eventDurationMs(event);
    return {
      spanId,
      parentSpanId: eventParentId(event),
      runId: eventRunId(event),
      explicitRunId: Boolean(eventRunId(event)),
      label: event.label || "event",
      eventId: event.id || null,
      name: event.title || event.phase || "runtime event",
      title: event.title || event.phase || "runtime event",
      phase: event.phase || "observe",
      status: event.status || "unknown",
      tone: runtimeSpanTone(event.status),
      observedAt: event.at || null,
      startedAt: event.startedAt || null,
      endedAt: event.endedAt || null,
      durationMs,
      workstream: event.workstream || null,
      agentId: event.agentId || null,
      goalId: event.goalId || null,
      tool: event.tool || null,
      source: event.source || null,
      fileCount: event.files?.length || 0,
      refs,
      artifactRefs,
      cost: event.cost || null,
      error: eventError(event),
      children: []
    };
  });
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const childrenByParent = new Map();
  const danglingParents = [];
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    if (!byId.has(span.parentSpanId)) {
      danglingParents.push({ spanId: span.spanId, parentSpanId: span.parentSpanId });
      continue;
    }
    if (!childrenByParent.has(span.parentSpanId)) childrenByParent.set(span.parentSpanId, []);
    childrenByParent.get(span.parentSpanId).push(span);
  }
  for (const span of spans) {
    span.children = (childrenByParent.get(span.spanId) || []).map((child) => child.spanId);
  }
  const roots = spans.filter((span) => !span.parentSpanId || !byId.has(span.parentSpanId));
  const linkedCount = spans.filter((span) => span.parentSpanId && byId.has(span.parentSpanId)).length;
  const runIds = [...new Set(spans.map((span) => span.runId).filter(Boolean))];
  const timedCount = spans.filter((span) => span.durationMs !== null || span.startedAt || span.endedAt).length;
  const errorCount = spans.filter((span) => span.error || ["failed", "blocked"].includes(span.status)).length;
  const artifactRefs = [...new Set(spans.flatMap((span) => span.artifactRefs || []))];
  const fileRefCount = spans.reduce((total, span) => total + (span.fileCount || 0), 0);
  const status = !spans.length
    ? "missing"
    : danglingParents.length
      ? "watch"
      : linkedCount || runIds.length
        ? "linked"
        : "flat";
  const checks = [
    phaseLedgerCheck(
      "parent_links",
      "Parent Links",
      linkedCount ? "ok" : spans.length ? "warn" : "bad",
      linkedCount
        ? `${linkedCount} child span(s) are linked to a parent.`
        : spans.length
          ? "Runtime spans exist, but no parent-child links are recorded."
          : "No runtime spans are available.",
      [".project-agent/runtime.json", ".project-agent/process-trace.json"]
    ),
    phaseLedgerCheck(
      "run_groups",
      "Run Groups",
      runIds.length ? "ok" : spans.length ? "warn" : "bad",
      runIds.length ? `${runIds.length} run group(s) are visible.` : "No runId is attached to runtime spans.",
      runIds
    ),
    phaseLedgerCheck(
      "timing",
      "Timing",
      timedCount ? "ok" : spans.length ? "warn" : "bad",
      timedCount ? `${timedCount} span(s) include started/ended/duration timing.` : "No span timing is available.",
      spans.filter((span) => span.durationMs !== null || span.startedAt || span.endedAt).map((span) => span.spanId)
    ),
    phaseLedgerCheck(
      "artifact_refs",
      "Artifact Refs",
      artifactRefs.length || fileRefCount ? "ok" : spans.length ? "warn" : "bad",
      artifactRefs.length
        ? `${artifactRefs.length} explicit artifact ref(s) are linked.`
        : fileRefCount
          ? `${fileRefCount} file ref(s) are linked as trace artifacts.`
          : "No file or artifact refs are linked to spans.",
      [...artifactRefs, ...spans.flatMap((span) => span.refs || [])]
    ),
    phaseLedgerCheck(
      "error_surface",
      "Error Surface",
      errorCount ? "warn" : "ok",
      errorCount ? `${errorCount} failed/blocked/error span(s) are visible.` : "No failed or blocked span is active.",
      spans.filter((span) => span.error || ["failed", "blocked"].includes(span.status)).map((span) => span.spanId)
    ),
    phaseLedgerCheck(
      "dangling_parents",
      "Dangling Parents",
      danglingParents.length ? "bad" : "ok",
      danglingParents.length ? `${danglingParents.length} span(s) point at a missing parent.` : "All recorded parent links resolve.",
      danglingParents.map((item) => item.parentSpanId)
    )
  ];
  return {
    schemaVersion: "project-agent.phase-ledger.v1",
    status,
    summary:
      status === "linked"
        ? `Phase ledger links ${spans.length} span(s) across ${runIds.length || 1} run group(s).`
        : status === "flat"
          ? `Phase ledger reconstructed ${spans.length} flat span(s); add parentId/runId around tool calls for replayable traces.`
          : status === "watch"
            ? `Phase ledger has ${danglingParents.length} dangling parent reference(s).`
            : "No runtime spans are available for a phase ledger.",
    spanCount: spans.length,
    rootCount: roots.length,
    linkedCount,
    danglingParents,
    runCount: runIds.length,
    runIds: runIds.slice(0, 12),
    timedCount,
    errorCount,
    artifactRefCount: artifactRefs.length,
    fileRefCount,
    currentSpanId: spans.find((span) => span.label === "current" || span.status === "current")?.spanId || null,
    latestAt: latestIso(spans.map((span) => span.observedAt)),
    spans,
    tree: roots.slice(0, 8).map((span) => phaseTreeNode(span, childrenByParent)).filter(Boolean),
    checks,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.id),
    blockers: checks.filter((check) => check.status === "bad").map((check) => check.id),
    refs: [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"],
    nextAction:
      status === "linked"
        ? "Use the phase tree before replaying tool work; inspect errors, artifacts, and child spans together."
        : status === "flat"
          ? "Record runId plus parentId on related tool events so the next handoff can replay causality."
          : status === "watch"
            ? "Repair dangling parentId references or re-emit the missing parent span before relying on the trace."
            : "Record a current event before editing, then close it with a done/failed child span."
  };
}

function buildRuntimeSpans(processTrace = {}) {
  return buildPhaseLedger(processTrace).spans.map((span) => ({
    spanId: span.spanId,
    parentSpanId: span.parentSpanId || "run",
    eventId: span.eventId || null,
    name: span.name,
    label: span.label,
    phase: span.phase,
    status: span.status,
    tone: span.tone,
    observedAt: span.observedAt,
    workstream: span.workstream,
    tool: span.tool,
    source: span.source,
    fileCount: span.fileCount,
    refs: span.refs,
    runId: span.runId,
    durationMs: span.durationMs,
    error: span.error,
    artifactRefs: span.artifactRefs,
    children: span.children
  }));
}

function buildRuntimeEval({ processTrace = {}, phaseLedger = null, developmentTrail = {}, freshnessGate = {}, preEditRisk = {}, interruptedWork = {}, openTargets = [], changedFiles = [] }) {
  const ledger = phaseLedger || buildPhaseLedger(processTrace);
  const spans = ledger.spans || buildRuntimeSpans(processTrace);
  const eventStatuses = spans.map((span) => span.status);
  const failedSpans = spans.filter((span) => ["failed", "blocked"].includes(span.status));
  const currentSpans = spans.filter((span) => span.status === "current");
  const fileLinkedSteps = (developmentTrail.steps || []).filter((step) => step.files?.length || step.folders?.length);
  const fileCoverage = developmentTrail.steps?.length ? fileLinkedSteps.length / developmentTrail.steps.length : 0;
  const spanRefs = spans.flatMap((span) => span.refs || []);
  const checks = [
    evalCheck(
      "span_capture",
      "Span Capture",
      spans.length && processTrace?.current ? "ok" : spans.length ? "warn" : "bad",
      spans.length ? `${spans.length} runtime span(s) reconstructed from process trace.` : "No runtime spans can be reconstructed.",
      [".project-agent/runtime.json", ".project-agent/process-trace.json"]
    ),
    evalCheck(
      "phase_ledger",
      "Phase Ledger",
      ledger.status === "linked" ? "ok" : ledger.status === "missing" ? "bad" : "warn",
      ledger.summary || "No phase ledger summary is available.",
      ledger.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json"]
    ),
    evalCheck(
      "phase_coverage",
      "Phase Coverage",
      processTrace?.previous && processTrace?.current && processTrace?.next ? "ok" : processTrace?.current ? "warn" : "bad",
      processTrace?.previous && processTrace?.current && processTrace?.next
        ? "Previous, current, and next phases are visible."
        : "The trace does not expose a complete previous/current/next handoff path.",
      [processTrace?.previous?.id, processTrace?.current?.id, processTrace?.next?.id]
    ),
    evalCheck(
      "file_provenance",
      "File Provenance",
      fileCoverage >= 0.5 || changedFiles.length === 0 ? "ok" : developmentTrail.steps?.length ? "warn" : "bad",
      developmentTrail.steps?.length
        ? `${fileLinkedSteps.length}/${developmentTrail.steps.length} process step(s) link to files or folders.`
        : "No development trail steps are available for file provenance.",
      [".project-agent/development-trail.json", ".project-agent/architecture-map.json", ...spanRefs.slice(0, 4)]
    ),
    evalCheck(
      "acceptance_evidence",
      "Acceptance Evidence",
      openTargets.length ? "warn" : "ok",
      openTargets.length ? `${openTargets.length} acceptance target(s) still need evidence.` : "Acceptance targets have linked evidence or none are open.",
      openTargets.map((target) => target.id)
    ),
    evalCheck(
      "error_surface",
      "Error Surface",
      interruptedWork?.count ? "bad" : failedSpans.length ? "warn" : "ok",
      interruptedWork?.count
        ? `${interruptedWork.count} interrupted current operation(s) must be resolved.`
        : failedSpans.length
          ? `${failedSpans.length} failed/blocked span(s) are visible for review.`
          : "No failed or blocked runtime span is active.",
      [...failedSpans.map((span) => span.eventId), ...(interruptedWork?.items || []).map((item) => item.id)]
    ),
    evalCheck(
      "freshness",
      "Freshness",
      ["stale", "expired"].includes(freshnessGate?.status) ? "warn" : freshnessGate?.status ? "ok" : "warn",
      freshnessGate?.summary || "No freshness gate is available for this trace.",
      freshnessGate?.refs || [".project-agent/agent-context-bundle.json"]
    ),
    evalCheck(
      "pre_edit_gate",
      "Pre-Edit Gate",
      preEditRisk?.status === "blocked" ? "bad" : ["high", "medium"].includes(preEditRisk?.status) ? "warn" : "ok",
      preEditRisk?.summary || "No pre-edit risk gate is available for this trace.",
      preEditRisk?.refs || [".project-agent/development-trail.json", ".project-agent/architecture-map.json"]
    )
  ];
  const bad = checks.filter((check) => check.status === "bad");
  const warn = checks.filter((check) => check.status === "warn");
  const ok = checks.filter((check) => check.status === "ok");
  const status = bad.length ? "fail" : warn.length ? "watch" : "pass";
  return {
    schemaVersion: "project-agent.runtime-eval.v1",
    status,
    score: `${ok.length}/${checks.length}`,
    quality: checks.length ? Math.round((ok.length / checks.length) * 100) : 0,
    summary:
      status === "pass"
        ? "Runtime trace is evaluable: spans, phase handoff, provenance, and gates are aligned."
        : status === "watch"
          ? `Runtime trace is usable with ${warn.length} warning(s); inspect them before claiming completion.`
          : `Runtime trace has ${bad.length} blocking eval issue(s); repair them before takeover.`,
    trace: {
      spanCount: spans.length,
      currentSpanId: spans.find((span) => span.label === "current" || span.status === "current")?.spanId || null,
      latestAt: latestIso(spans.map((span) => span.observedAt)),
      ledgerStatus: ledger.status,
      parentLinkCount: ledger.linkedCount || 0,
      runCount: ledger.runCount || 0,
      danglingParentCount: ledger.danglingParents?.length || 0,
      artifactRefCount: ledger.artifactRefCount || 0,
      phases: [...new Set(spans.map((span) => span.phase).filter(Boolean))],
      statuses: [...new Set(eventStatuses.filter(Boolean))],
      failedSpanCount: failedSpans.length,
      currentSpanCount: currentSpans.length,
      fileRefCoverage: developmentTrail.steps?.length ? `${fileLinkedSteps.length}/${developmentTrail.steps.length}` : "0/0"
    },
    spans,
    checks,
    warnings: warn.map((check) => check.id),
    blockers: bad.map((check) => check.id),
    refs: [
      ".project-agent/runtime.json",
      ".project-agent/process-trace.json",
      ".project-agent/development-trail.json",
      ".project-agent/architecture-map.json",
      ".project-agent/agent-context-bundle.json"
    ],
    nextAction:
      status === "pass"
        ? "Keep recording current/done events around tool calls and link evidence to acceptance criteria."
        : status === "watch"
          ? "Inspect warning checks, then add missing file refs or evidence before completion."
          : "Restore runtime spans, close interrupted work, and refresh continuity before another agent resumes."
  };
}

function checkpointLedgerCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: (refs || []).filter(Boolean).slice(0, 8)
  };
}

function buildCheckpointLedger({ processTrace = {}, phaseLedger = {}, runtimeEval = {}, developmentTrail = {}, preEditRisk = {}, openTargets = [] }) {
  const spans = phaseLedger?.spans || buildPhaseLedger(processTrace).spans || [];
  const stepsByEventId = new Map((developmentTrail.steps || []).filter((step) => step?.id).map((step) => [step.id, step]));
  const checkpoints = spans.slice(0, 24).map((span, index) => {
    const step = stepsByEventId.get(span.eventId) || null;
    const refs = [...new Set([...(span.refs || []), ...(step?.refs || []), ...(step?.files || []).map((file) => file.path), ...(step?.folders || []).map((folder) => folder.folder)].filter(Boolean))].slice(0, 12);
    const artifactRefs = [...new Set([...(span.artifactRefs || []), ...refs.filter((ref) => /\.[a-z0-9]+$/i.test(ref))])].slice(0, 10);
    const pending = ["current", "pending", "waiting"].includes(span.status);
    const failed = ["failed", "blocked"].includes(span.status) || Boolean(span.error);
    return {
      checkpointId: `ckpt_${stableHash({ spanId: span.spanId, eventId: span.eventId, index }).slice(0, 12)}`,
      spanId: span.spanId,
      eventId: span.eventId,
      parentSpanId: span.parentSpanId || null,
      runId: span.runId || null,
      phase: span.phase || "observe",
      status: span.status || "unknown",
      title: span.title || span.name || "runtime checkpoint",
      tool: span.tool || null,
      source: span.source || null,
      observedAt: span.observedAt || null,
      durationMs: span.durationMs,
      pending,
      failed,
      resumable: pending || failed || index === 0,
      fileCount: step?.files?.length || span.fileCount || 0,
      folderCount: step?.folders?.length || 0,
      artifactRefs,
      refs,
      error: span.error || null,
      nextAction: failed
        ? "Inspect error detail and artifact refs before retrying this checkpoint."
        : pending
          ? "Close this checkpoint with done/failed/blocked before unrelated work."
          : "Use as replay context if the next step touches the same files."
    };
  });
  const runGroups = [...new Map(checkpoints.map((checkpoint) => [checkpoint.runId || `single:${checkpoint.checkpointId}`, []])).keys()]
    .map((runId) => {
      const items = checkpoints.filter((checkpoint) => (checkpoint.runId || `single:${checkpoint.checkpointId}`) === runId);
      return {
        runId: runId.startsWith("single:") ? null : runId,
        checkpointCount: items.length,
        pendingCount: items.filter((item) => item.pending).length,
        failedCount: items.filter((item) => item.failed).length,
        artifactCount: items.reduce((sum, item) => sum + item.artifactRefs.length, 0),
        latestAt: latestIso(items.map((item) => item.observedAt)),
        refs: items.flatMap((item) => item.refs || []).slice(0, 8)
      };
    })
    .slice(0, 12);
  const pending = checkpoints.filter((checkpoint) => checkpoint.pending);
  const failed = checkpoints.filter((checkpoint) => checkpoint.failed);
  const resumable = checkpoints.filter((checkpoint) => checkpoint.resumable).slice(0, 8);
  const artifactRefCount = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.artifactRefs.length, 0);
  const fileRefCount = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.fileCount, 0);
  const phaseCounts = checkpoints.reduce((acc, checkpoint) => {
    acc[checkpoint.phase] = (acc[checkpoint.phase] || 0) + 1;
    return acc;
  }, {});
  const statusCounts = checkpoints.reduce((acc, checkpoint) => {
    acc[checkpoint.status] = (acc[checkpoint.status] || 0) + 1;
    return acc;
  }, {});
  const checks = [
    checkpointLedgerCheck(
      "checkpoint_source",
      "Checkpoint Source",
      checkpoints.length ? "ok" : "bad",
      checkpoints.length ? `${checkpoints.length} checkpoint(s) reconstructed from runtime spans.` : "No runtime span can be converted into a checkpoint.",
      [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json#phaseLedger"]
    ),
    checkpointLedgerCheck(
      "resume_points",
      "Resume Points",
      resumable.length ? "ok" : checkpoints.length ? "warn" : "bad",
      resumable.length ? `${resumable.length} resumable checkpoint(s) are visible.` : "No current, failed, or latest checkpoint is marked resumable.",
      resumable.flatMap((checkpoint) => [checkpoint.checkpointId, checkpoint.eventId, ...checkpoint.refs])
    ),
    checkpointLedgerCheck(
      "pending_writes",
      "Pending Writes",
      pending.length ? "warn" : "ok",
      pending.length ? `${pending.length} checkpoint(s) are still current/pending.` : "No pending checkpoint blocks unrelated work.",
      pending.flatMap((checkpoint) => [checkpoint.eventId, ...checkpoint.refs])
    ),
    checkpointLedgerCheck(
      "artifact_refs",
      "Artifact Refs",
      artifactRefCount || fileRefCount ? "ok" : checkpoints.length ? "warn" : "bad",
      artifactRefCount
        ? `${artifactRefCount} artifact/file ref(s) are attached to checkpoints.`
        : fileRefCount
          ? `${fileRefCount} file ref(s) can act as checkpoint artifacts.`
          : "No artifact or file refs are attached to checkpoints.",
      checkpoints.flatMap((checkpoint) => checkpoint.artifactRefs || [])
    ),
    checkpointLedgerCheck(
      "runtime_eval_gate",
      "Runtime Eval Gate",
      runtimeEval.status === "fail" ? "bad" : runtimeEval.status === "watch" ? "warn" : runtimeEval.status ? "ok" : "warn",
      runtimeEval.summary || "No runtime eval gate is linked to checkpoints.",
      runtimeEval.refs || [".project-agent/agent-context-bundle.json"]
    ),
    checkpointLedgerCheck(
      "acceptance_gate",
      "Acceptance Gate",
      openTargets.length ? "warn" : "ok",
      openTargets.length ? `${openTargets.length} open acceptance target(s) remain after checkpoint replay.` : "No open acceptance target blocks checkpoint resume.",
      openTargets.map((target) => target.id)
    ),
    checkpointLedgerCheck(
      "pre_edit_gate",
      "Pre-Edit Gate",
      preEditRisk.status === "blocked" ? "bad" : ["high", "medium"].includes(preEditRisk.status) ? "warn" : preEditRisk.status ? "ok" : "warn",
      preEditRisk.summary || "No pre-edit gate is linked to checkpoints.",
      preEditRisk.refs || [".project-agent/pre-edit-risk", ".project-agent/architecture-map.json"]
    )
  ];
  const bad = checks.filter((check) => check.status === "bad");
  const warn = checks.filter((check) => check.status === "warn");
  const status = !checkpoints.length
    ? "missing"
    : bad.length
      ? "blocked"
      : pending.length || warn.length
        ? "watch"
        : "ready";
  return {
    schemaVersion: "project-agent.checkpoint-ledger.v1",
    status,
    summary:
      status === "ready"
        ? `Checkpoint ledger is ready with ${checkpoints.length} replayable checkpoint(s).`
        : status === "watch"
          ? `Checkpoint ledger is usable with ${pending.length + warn.length} pending/warning item(s).`
          : status === "blocked"
            ? `Checkpoint ledger is blocked by ${bad.length} failed gate(s).`
            : "No checkpoints can be reconstructed yet.",
    checkpointCount: checkpoints.length,
    resumableCount: resumable.length,
    pendingCount: pending.length,
    failedCount: failed.length,
    runCount: runGroups.length,
    artifactRefCount,
    fileRefCount,
    latestAt: latestIso(checkpoints.map((checkpoint) => checkpoint.observedAt)),
    checkpoints,
    resumable,
    pending,
    failed,
    runGroups,
    deltaChannels: {
      phases: phaseCounts,
      statuses: statusCounts,
      files: fileRefCount,
      artifacts: artifactRefCount,
      errors: failed.length,
      acceptanceOpen: openTargets.length
    },
    checks,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.id),
    blockers: checks.filter((check) => check.status === "bad").map((check) => check.id),
    refs: [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json#phaseLedger", ".project-agent/agent-context-bundle.json"],
    nextAction:
      pending[0]?.nextAction ||
      failed[0]?.nextAction ||
      (status === "ready"
        ? "Resume from the latest checkpoint, then record the next current/done span."
        : "Record a current event with files and artifact refs before relying on checkpoint resume.")
  };
}

function buildHookIngressAudit(process = {}) {
  const seen = new Set();
  const events = [process.current, ...(process.events || [])]
    .filter(Boolean)
    .filter((event) => {
      if (!event.id || seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  const ingressEvents = events.filter((event) => event.data?.ingress);
  const sanitizedEvents = ingressEvents.filter((event) => event.data.ingress.sanitized);
  const unknownTypeEvents = ingressEvents.filter((event) => event.data.ingress.typeStatus === "unknown");
  const extensionEvents = ingressEvents.filter((event) => event.data.ingress.typeStatus === "extension");
  const warningSet = new Set(ingressEvents.flatMap((event) => event.data.ingress.warnings || []));
  const attempts = process.hookIngresses || [];
  const saturatedAttempts = attempts.filter((attempt) => attempt.pressure?.status === "saturated" || attempt.httpStatus === 429);
  const throttledAttempts = attempts.filter((attempt) => attempt.pressure?.status === "throttled");
  const rejectedAttempts = attempts.filter((attempt) => (attempt.rejected || 0) > 0);
  const rejectedEvents = attempts.reduce((sum, attempt) => sum + (attempt.rejected || 0), 0);
  const status = saturatedAttempts.length
    ? "blocked"
    : throttledAttempts.length || rejectedAttempts.length
      ? "watch"
      : !ingressEvents.length
    ? "idle"
    : unknownTypeEvents.length || sanitizedEvents.length || warningSet.size
      ? "watch"
      : "clean";
  return {
    schemaVersion: "project-agent.hook-ingress-audit.v1",
    status,
    summary: saturatedAttempts.length
      ? `Hook ingress hit backpressure ${saturatedAttempts.length} time(s); latest returned 429.`
      : throttledAttempts.length || rejectedAttempts.length
        ? `Hook ingress accepted ${ingressEvents.length} event(s) with ${rejectedEvents} rejected/throttled event(s).`
        : !ingressEvents.length
      ? "No external hook events have entered through sanitized ingress yet."
      : `Sanitized ingress accepted ${ingressEvents.length} hook event(s), redacted ${sanitizedEvents.length}, normalized ${unknownTypeEvents.length} unknown type(s).`,
    acceptedEvents: ingressEvents.length,
    attempts: attempts.length,
    rejectedEvents,
    saturatedAttempts: saturatedAttempts.length,
    throttledAttempts: throttledAttempts.length,
    sanitizedEvents: sanitizedEvents.length,
    unknownTypeEvents: unknownTypeEvents.length,
    extensionEvents: extensionEvents.length,
    latestAt: ingressEvents[0]?.at || attempts[0]?.at || null,
    backpressure: {
      schemaVersion: "project-agent.hook-backpressure-audit.v1",
      status: saturatedAttempts.length ? "saturated" : throttledAttempts.length || rejectedAttempts.length ? "watch" : attempts.length ? "ok" : "idle",
      attempts: attempts.length,
      saturatedAttempts: saturatedAttempts.length,
      throttledAttempts: throttledAttempts.length,
      rejectedEvents,
      latestHttpStatus: attempts[0]?.httpStatus || null,
      latestPressure: attempts[0]?.pressure || null,
      retryAfterMs: attempts[0]?.retryAfterMs || attempts[0]?.pressure?.retryAfterMs || 0
    },
    recent: ingressEvents.slice(0, 6).map((event) => ({
      id: event.id,
      at: event.at,
      title: event.title,
      type: event.data.ingress.type,
      rawType: event.data.ingress.rawType,
      typeStatus: event.data.ingress.typeStatus,
      source: event.source || event.data.ingress.source,
      sanitized: Boolean(event.data.ingress.sanitized),
      redactedFindings: event.data.ingress.redactedFindings || 0,
      warnings: event.data.ingress.warnings || [],
      refs: (event.refs || []).slice(0, 6)
    })),
    recentAttempts: attempts.slice(0, 6).map((attempt) => ({
      id: attempt.id,
      at: attempt.at,
      status: attempt.status,
      accepted: attempt.accepted,
      rejected: attempt.rejected,
      totalItems: attempt.totalItems,
      httpStatus: attempt.httpStatus,
      pressureStatus: attempt.pressure?.status || null,
      blockers: attempt.blockers || []
    })),
    warnings: [...warningSet],
    blockers: saturatedAttempts.length ? ["hook_backpressure"] : [],
    refs: ["/api/hooks", "/api/events", ".project-agent/runtime.json"],
    nextAction: status === "blocked"
      ? "Reduce hook batch size or retry after backpressure clears before trusting capture completeness."
      : status === "idle"
      ? "Send external agent/tool events through /api/hooks or npm run event so runtime traces stay auditable."
      : "Keep hook payloads in the closed vocabulary; use x.* only for intentional extensions."
  };
}

function buildStartProtocol({ takeoverReadiness, goal, process, changedFiles, architecture, stateRefs, interruptedWork }) {
  const topFolders = architecture?.impact?.topFolders || architecture?.impact?.folders || [];
  const readFirst = [
    {
      path: ".project-agent/agent-context-bundle.json",
      why: "Single-file takeover index tying memory graph, process trace, architecture map, governance, audit, and manifest verification together.",
      lookFor: "quickStart, governance, memory.graph, process.trace, architecture.map, validation.stateManifestVerification, validation.freshnessGate"
    },
    {
      path: ".project-agent/governance-spec.json",
      why: "Product-level AI-native development contract; read this before interpreting state.",
      lookFor: "requirements, acceptance, operatingRules, influences, readFirst"
    },
    {
      path: ".project-agent/continuity-contract.json",
      why: "Agent-neutral takeover contract; start here before parsing the full state.",
      lookFor: "contractId, status, resume, capabilities, inspectOrder, proofChecklist"
    },
    {
      path: ".project-agent/agent-runbook.json",
      why: "Executable takeover steps, command templates, state transitions, and proof gates.",
      lookFor: "currentState, nextState, stateMachine, steps, proofGates"
    },
    {
      path: ".project-agent/memory-graph.json",
      why: "Durable memory knowledge graph with nodes, edges, and provenance.",
      lookFor: "nodes, edges, provenanceRefs, source, nodeCount, edgeCount"
    },
    {
      path: ".project-agent/process-trace.json",
      why: "Durable previous/current/next process trace and event inspect order.",
      lookFor: "current, previous, next, phases, events, inspectOrder, filesTouched"
    },
    {
      path: ".project-agent/development-trail.json",
      why: "Durable process-to-architecture trail linking steps to touched files, impacted folders, takeover risk, and inspect order.",
      lookFor: "steps, current, files, folders, risk, inspectOrder, nextAction"
    },
    {
      path: ".project-agent/architecture-map.json",
      why: "Durable architecture tree, file map, changed folders, and inspect order.",
      lookFor: "tree, files, recentChanges, impact, trace, inspectOrder"
    },
    {
      path: ".project-agent/state-manifest.json",
      why: "Hash manifest proving the handoff files belong to one readable state snapshot.",
      lookFor: "aggregateHash, files, sha256, schemaVersion, missing"
    },
    {
      path: ".project-agent/takeover-packet.json",
      why: "Concise next-agent startup index with cursor, next command, first reads, and first actions.",
      lookFor: "cursor, nextCommand, firstRead, firstActions, guardrails, interruptedWork"
    },
    {
      path: ".project-agent/continuity-audit.json",
      why: "Machine-readable audit proving whether handoff artifacts are complete enough for takeover.",
      lookFor: "status, canResume, score, checks, blockers, warnings, nextCommand"
    },
    {
      path: ".project-agent/takeover-acceptance-audit.json",
      why: "User-objective acceptance audit proving visible memory, dynamic process, managed architecture, and agent-neutral takeover.",
      lookFor: "rows, score, blockers, warnings, canResume"
    },
    {
      path: ".project-agent/continuity.json",
      why: "Machine-readable current state for every agent.",
      lookFor: "continuityContract, agentRunbook, memoryGraph, processTrace, architectureMap, takeoverReadiness, startProtocol, processCursor, workstreams, architectureTrace, architectureImpact, changedFiles"
    },
    {
      path: ".project-agent/next-agent-prompt.md",
      why: "Starter prompt that can be handed to a new coding agent without chat history.",
      lookFor: "Mission, Mandatory Read Order, Current Cursor, Required First Actions, Next Command"
    },
    {
      path: ".project-agent/resume.md",
      why: "Short human-readable packet for quick continuation.",
      lookFor: "Current Cursor, Process Trace, Takeover Readiness, Workstream Cursor, Architecture Trace, Architecture Impact"
    },
    {
      path: ".project-agent/recovery.md",
      why: "Full recovery brief when the prior session may have stopped mid-work.",
      lookFor: "Recent Events, Changed Files, Architecture Impact, Next Agent Instructions"
    },
    {
      path: ".project-agent/state.json",
      why: "Durable project goals, evidence, gates, decisions, risks, and memories.",
      lookFor: "active goal, acceptance criteria, evidence, handoffs"
    },
    {
      path: ".project-agent/runtime.json",
      why: "Live event stream, leases, snapshots, and architecture watcher state.",
      lookFor: "events, agents, handoffSnapshot, architectureChanges"
    },
    {
      path: "AGENTS.md",
      why: "Repo-level operating protocol for any agent.",
      lookFor: "continuity protocol, event reporting, evidence rules"
    },
    {
      path: "PROJECT.md",
      why: "Project philosophy and current strategy.",
      lookFor: "philosophy, current strategy"
    },
    {
      path: "docs/architecture/principles.md",
      why: "Architecture source of truth.",
      lookFor: "architecture principles and durable constraints"
    }
  ].filter((item) => !stateRefs?.length || stateRefs.includes(item.path));

  const interruptedAction = interruptedWork?.count
    ? [
        {
          action: "Resolve interrupted work before unrelated edits.",
          why: `${interruptedWork.count} stale current operation(s) belong to expired agent lease(s).`,
          refs: (interruptedWork.items || []).flatMap((item) => [item.id, ...(item.refs || []).slice(0, 2)]).filter(Boolean).slice(0, 6)
        }
      ]
    : [];

  const firstActions = [
    ...interruptedAction,
    {
      action: "Check takeover readiness.",
      why: takeoverReadiness?.canTakeOver ? takeoverReadiness.summary : "Do not continue until missing state is restored.",
      refs: ["takeoverReadiness"]
    },
    {
      action: "Resume from the current cursor, not from chat memory.",
      why: process?.current ? `${process.current.phase}/${process.current.status}: ${process.current.title}` : "No cursor available.",
      refs: [process?.current?.id, ...(process?.current?.refs || [])].filter(Boolean)
    },
    {
      action: "Inspect impacted folders and changed files before editing.",
      why: topFolders.length ? `Top impacted folder: ${topFolders[0].folder}` : "No architecture impact captured.",
      refs: [...topFolders.slice(0, 3).map((folder) => folder.latestFile), ...changedFiles.slice(0, 3).map((file) => file.path)].filter(Boolean)
    },
    {
      action: "Publish an agent heartbeat before work.",
      why: "A fresh lease lets future agents distinguish active work from a crashed session.",
      refs: [".project-agent/runtime.json"]
    },
    {
      action: "Record a current event before the first tool call and a done/failed event afterward.",
      why: "The UI, process timeline, and handoff packet depend on runtime events.",
      refs: ["/api/events", "npm run event"]
    }
  ];

  const guardrails = [
    "Do not rely on prior chat history as source of truth.",
    "Do not overwrite changed files until changedFiles and architectureImpact have been inspected.",
    "If interruptedWork has items, inspect those refs/files and either continue, mark failed, or replace the stale current event.",
    "Do not mark completion without evidence and audit coverage.",
    "Do not ignore stale active leases; treat them as possible crashed sessions.",
    "Regenerate resume/recovery or trigger a handoff snapshot before handing off again."
  ];

  return {
    status: takeoverReadiness?.status || "unknown",
    readFirst,
    firstActions,
    guardrails,
    resumeFrom: {
      goalId: goal?.id || null,
      objective: goal?.objective || null,
      cursor: process?.current || null,
      workstream: process?.workstream || null,
      impactedFolders: topFolders.slice(0, 5).map((folder) => ({
        folder: folder.folder,
        summary: folder.summary,
        latestFile: folder.latestFile,
        kinds: folder.kinds || []
      }))
    }
  };
}

function buildAgentRunbook({ goal, processTrace, architectureTrace, graphTrace, memoryGraph, takeoverReadiness, startProtocol, interruptedWork, changedFiles, stateRefs }) {
  const canTakeOver = Boolean(takeoverReadiness?.canTakeOver);
  const hasInterrupted = Boolean(interruptedWork?.count);
  const currentState = !canTakeOver ? "restore_required_state" : hasInterrupted ? "resolve_interrupted_work" : "ready_to_resume";
  const nextState = !canTakeOver ? "run_takeover_drill" : hasInterrupted ? "inspect_interrupted_refs" : "record_current_event";
  const changedRefs = (changedFiles || []).slice(0, 6).map((file) => file.path).filter(Boolean);
  const architectureRefs = (architectureTrace?.inspectOrder || []).slice(0, 6).map((item) => item.path).filter(Boolean);
  const interruptedRefs = (interruptedWork?.items || []).flatMap((item) => [item.id, ...(item.refs || [])]).filter(Boolean).slice(0, 8);
  const commandProject = "$PROJECT_DIR";
  const baseSteps = [
    {
      id: "read_context_bundle",
      state: "cold_start",
      label: "Read the agent context bundle",
      command: "cat .project-agent/agent-context-bundle.json",
      refs: [".project-agent/agent-context-bundle.json"],
      success: "quickStart, memory graph, process trace, architecture map, validation, and nextCommand are understood."
    },
    {
      id: "read_contract",
      state: "cold_start",
      label: "Read the agent-neutral contract",
      command: "cat .project-agent/continuity-contract.json",
      refs: [".project-agent/continuity-contract.json"],
      success: "contract.status, resume.current, inspectOrder, proofChecklist, and agentState are understood."
    },
    {
      id: "verify_state_manifest",
      state: "cold_start",
      label: "Verify the state manifest",
      command: `npm run manifest -- --project-dir "${commandProject}" --verify`,
      refs: [".project-agent/state-manifest.json"],
      success: "state-manifest verification reports ok before trusting handoff files."
    },
    {
      id: "run_takeover_drill",
      state: "validate_takeover",
      label: "Run the takeover drill",
      command: `npm run takeover -- --project-dir "${commandProject}" --json`,
      refs: [".project-agent/continuity.json", ".project-agent/continuity-contract.json"],
      success: "takeoverDrill.canResume is true, or every bad check is restored before editing."
    },
    {
      id: "resolve_interrupted_work",
      state: "resolve_interrupted_work",
      label: "Resolve stale current work",
      required: hasInterrupted,
      command: `npm run event -- --project-dir "${commandProject}" --phase execute --status failed --title "Resolved stale current event" --detail "replaced or closed stale interrupted work"`,
      refs: interruptedRefs,
      success: "Each interruptedWork item is inspected; the next event either continues it or records failed/done before unrelated edits."
    },
    {
      id: "inspect_architecture",
      state: "inspect_project_shape",
      label: "Inspect changed architecture and protected files",
      command: "cat .project-agent/continuity.json",
      refs: [...new Set([...architectureRefs, ...changedRefs])].slice(0, 10),
      success: "architectureTrace.inspectOrder, architectureImpact.topFolders, and changedFiles have been checked."
    },
    {
      id: "publish_heartbeat",
      state: "claim_work",
      label: "Publish a fresh agent lease",
      command: `npm run agent -- heartbeat --project-dir "${commandProject}" --agent-id "$AGENT_ID" --role coding_agent --goal "${goal?.id || "$GOAL_ID"}" --note "resuming from runbook" --lease-seconds 90`,
      refs: [".project-agent/runtime.json"],
      success: "agentLeases shows this agent as active and not stale."
    },
    {
      id: "record_current_event",
      state: "before_tool",
      label: "Record the next current event",
      command: `npm run event -- --project-dir "${commandProject}" --phase execute --status current --title "Next tool call" --detail "what the agent is about to do"`,
      refs: [processTrace?.current?.id, ...(processTrace?.current?.refs || [])].filter(Boolean),
      success: "processTrace.current changes to the new event before the tool call starts."
    },
    {
      id: "record_outcome",
      state: "after_tool",
      label: "Record done, failed, or blocked",
      command: `npm run event -- --project-dir "${commandProject}" --phase execute --status done --title "Tool call finished" --detail "what changed and where"`,
      refs: changedRefs,
      success: "The prior current event is superseded by a done, failed, or blocked event with file refs."
    },
    {
      id: "refresh_handoff",
      state: "handoff_refresh",
      label: "Refresh durable handoff files",
      command: `npm run resume -- --project-dir "${commandProject}" --role coding_agent --write`,
      refs: [".project-agent/agent-runbook.json", ".project-agent/continuity.json", ".project-agent/resume.md", ".project-agent/recovery.md"],
      success: "agent-runbook, continuity, resume, and recovery files reflect the latest cursor and architecture."
    }
  ];
  const activeStepId = !canTakeOver ? "run_takeover_drill" : hasInterrupted ? "resolve_interrupted_work" : "inspect_architecture";
  const activeIndex = Math.max(baseSteps.findIndex((step) => step.id === activeStepId), 0);
  const steps = baseSteps.map((step, index) => {
    const skipped = step.id === "resolve_interrupted_work" && !hasInterrupted;
    const status = skipped ? "skipped" : index < activeIndex ? "done" : index === activeIndex ? (!canTakeOver && step.id !== "run_takeover_drill" ? "blocked" : "current") : "pending";
    const tone = status === "done" || status === "skipped" ? "ok" : status === "current" ? "warn" : status === "blocked" ? "bad" : "muted";
    return {
      ...step,
      status,
      tone,
      isActive: step.id === activeStepId
    };
  });
  const activeStep = steps.find((step) => step.id === activeStepId) || steps[0] || null;
  const blockingReason = !canTakeOver ? takeoverReadiness?.summary || "Takeover readiness is blocked." : hasInterrupted ? interruptedWork?.nextAction : "";
  const stepSummary = steps.reduce(
    (summary, step) => {
      summary[step.status] = (summary[step.status] || 0) + 1;
      return summary;
    },
    { done: 0, current: 0, pending: 0, skipped: 0, blocked: 0 }
  );
  const proofGates = [
    {
      id: "memory_visible",
      status: graphTrace?.status === "traceable" && memoryGraph?.nodeCount ? "ok" : "warn",
      check: "memory-graph.json has nodes, edges, and provenance coverage.",
      refs: [".project-agent/memory-graph.json", ".project-agent/continuity.json"]
    },
    {
      id: "process_identified",
      status: processTrace?.current && processTrace?.inspectOrder?.length ? "ok" : "warn",
      check: "processTrace.current, previous, next, and inspectOrder are present.",
      refs: [".project-agent/process-trace.json", ".project-agent/runtime.json"]
    },
    {
      id: "architecture_managed",
      status: architectureTrace?.totals?.files && architectureTrace?.inspectOrder?.length ? "ok" : "warn",
      check: "architectureTrace.totals and inspectOrder are present.",
      refs: [".project-agent/architecture-map.json", ...architectureRefs].slice(0, 6)
    },
    {
      id: "handoff_portable",
      status: canTakeOver ? (hasInterrupted ? "warn" : "ok") : "bad",
      check: "continuity-contract, agent-runbook, resume, and recovery are refreshed.",
      refs: [".project-agent/continuity-contract.json", ".project-agent/agent-runbook.json", ".project-agent/resume.md", ".project-agent/recovery.md"]
    }
  ];

  return {
    schemaVersion: "project-agent.runbook.v1",
    status: currentState,
    currentState,
    nextState,
    canTakeOver,
    activeStepId,
    nextCommand: activeStep?.command || null,
    blockingReason,
    stepSummary,
    generatedFrom: {
      goalId: goal?.id || null,
      cursorId: processTrace?.current?.id || null,
      graphStatus: graphTrace?.status || null,
      architectureStatus: architectureTrace?.status || null,
      takeoverStatus: takeoverReadiness?.status || null
    },
    stateMachine: {
      initial: "cold_start",
      current: currentState,
      transitions: [
        { from: "cold_start", to: "validate_takeover", gate: "agent-context-bundle.json and continuity-contract.json are readable, and state-manifest verification is ok" },
        { from: "validate_takeover", to: hasInterrupted ? "resolve_interrupted_work" : "inspect_project_shape", gate: "takeoverDrill.canResume is true" },
        { from: "resolve_interrupted_work", to: "inspect_project_shape", gate: "interruptedWork items are closed, continued, or intentionally replaced" },
        { from: "inspect_project_shape", to: "claim_work", gate: "changedFiles and architectureTrace.inspectOrder are reviewed" },
        { from: "claim_work", to: "before_tool", gate: "fresh agent heartbeat is active" },
        { from: "before_tool", to: "after_tool", gate: "current event is recorded before tool execution" },
        { from: "after_tool", to: "handoff_refresh", gate: "done, failed, or blocked event is recorded" },
        { from: "handoff_refresh", to: "ready_to_resume", gate: "resume/recovery/continuity are refreshed" }
      ]
    },
    readFirst: (startProtocol?.readFirst || []).slice(0, 8),
    steps,
    proofGates,
    stateRefs: [...new Set([".project-agent/agent-runbook.json", ...(stateRefs || [])])]
  };
}

function governanceDomain(id, label, status, detail, refs = [], nextAction = "") {
  return {
    id,
    label,
    status,
    detail,
    refs: refs.filter(Boolean).slice(0, 8),
    nextAction
  };
}

function buildGovernanceMatrix({ kernelSummary, process, processTrace, changedFiles, architecture, architectureTrace, agentLeases, handoffSnapshot, takeoverReadiness, startProtocol, stateRefs, knowledgeGraph }) {
  const graphNodes = knowledgeGraph?.nodes || [];
  const graphEdges = knowledgeGraph?.edges || [];
  const graphProvenance = graphNodes.filter((node) => node.provenance?.length).length;
  const kernelCount = ["philosophy", "strategy", "architecture", "product", "quality"].reduce((sum, key) => sum + (kernelSummary?.[key]?.length || 0), 0);
  const topFolders = architecture?.impact?.topFolders || architecture?.impact?.folders || [];
  const topFolderLabel = topFolders[0]?.folder === "." ? "repo root" : topFolders[0]?.folder;
  const staleAgents = (agentLeases || []).filter((agent) => agent.effectiveStatus === "stale");
  const readFirst = startProtocol?.readFirst || [];
  const firstActions = startProtocol?.firstActions || [];
  const hasPreviousNowNext = Boolean(process?.previous && process?.current && process?.next);
  const hasProcessCursor = Boolean(process?.current);
  const hasSnapshot = handoffSnapshot?.status === "done";
  const canTakeOver = takeoverReadiness?.canTakeOver;

  const domains = [
    governanceDomain(
      "memory_visibility",
      "Memory Visible",
      graphNodes.length && graphEdges.length && kernelCount && stateRefs?.length ? (graphProvenance ? "ok" : "warn") : "bad",
      graphNodes.length
        ? `${graphNodes.length} graph node(s), ${graphEdges.length} edge(s), ${graphProvenance} provenance-backed node(s).`
        : "No project memory graph is available.",
      [...(kernelSummary?.sourceRefs || []), ".project-agent/state.json"],
      graphProvenance ? "Inspect graph nodes and provenance before trusting a remembered fact." : "Add provenance-backed nodes before treating memory as durable."
    ),
    governanceDomain(
      "process_recognition",
      "Process Recognized",
      hasPreviousNowNext ? "ok" : hasProcessCursor ? "warn" : "bad",
      hasProcessCursor
        ? `Cursor ${process.current.phase}/${process.current.status}: ${process.current.title}; ${process.events?.length || 0} runtime event(s).`
        : "No current process cursor is available.",
      [process?.previous?.id, process?.current?.id, process?.next?.id, ".project-agent/runtime.json"],
      processTrace?.nextAction || (hasPreviousNowNext ? "Continue from Now, then record done/failed so the trail stays live." : "Record a current event before the next tool call.")
    ),
    governanceDomain(
      "architecture_management",
      "Architecture Managed",
      architecture?.totals?.files && topFolders.length ? "ok" : architecture?.totals?.files ? "warn" : "bad",
      architecture?.totals?.files
        ? `${architecture.totals.files} file(s), ${topFolders.length} impacted folder(s), ${changedFiles.length} changed file(s).`
        : "No architecture scan is available.",
      [...topFolders.slice(0, 4).map((folder) => folder.latestFile), ...changedFiles.slice(0, 4).map((file) => file.path)],
      architectureTrace?.nextAction || (topFolders.length ? `Inspect ${topFolderLabel} before editing.` : "Run an architecture scan and capture changed folders.")
    ),
    governanceDomain(
      "agent_continuity",
      "Agent Continuity",
      canTakeOver ? (hasSnapshot && !staleAgents.length ? "ok" : "warn") : "bad",
      canTakeOver
        ? `${readFirst.length} read-first file(s), ${firstActions.length} first action(s), ${staleAgents.length} stale lease(s).`
        : takeoverReadiness?.summary || "A new agent cannot safely take over yet.",
      [handoffSnapshot?.resumeFile, handoffSnapshot?.recoveryFile, ...readFirst.slice(0, 4).map((item) => item.path)],
      canTakeOver ? "Run the takeover drill and follow startProtocol.firstActions." : "Restore missing handoff state before resuming."
    )
  ];
  const bad = domains.filter((item) => item.status === "bad");
  const warn = domains.filter((item) => item.status === "warn");
  const ok = domains.filter((item) => item.status === "ok");
  return {
    status: bad.length ? "blocked" : warn.length ? "watch" : "ready",
    tone: bad.length ? "bad" : warn.length ? "warn" : "ok",
    score: `${ok.length}/${domains.length}`,
    summary: bad.length ? `${bad.length} governance domain(s) blocked.` : warn.length ? `${warn.length} governance warning(s) need attention.` : "Project memory, process, architecture, and continuity are governed.",
    domains,
    operatingContract: [
      "Memory claims must be backed by graph provenance and source files.",
      "Process state must expose previous, current, and next events from runtime data.",
      "Architecture edits must be visible through changedFiles and architectureImpact before further edits.",
      "Any new agent must read continuity-contract.json, agent-runbook.json, continuity.json, then run the takeover drill before work."
    ],
    readFirst: (stateRefs || []).slice(0, 8)
  };
}

function decisionItems(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function decisionSourceHash(refs = [], architectureTrace = {}) {
  const changedByPath = new Map((architectureTrace.changedFiles || []).filter((file) => file?.path).map((file) => [file.path, file]));
  const sourceHashes = (refs || [])
    .map((ref) => changedByPath.get(ref)?.hash || changedByPath.get(ref)?.previousHash || null)
    .filter(Boolean);
  return stableHash({ refs: refs.slice(0, 12), sourceHashes });
}

function changedSourceRefs(refs = [], changedFiles = []) {
  const durableRefs = new Set((refs || []).filter((ref) => ref && !String(ref).startsWith(".project-agent/")));
  if (!durableRefs.size) return [];
  return (changedFiles || [])
    .filter((file) => file?.path && durableRefs.has(file.path))
    .map((file) => ({
      path: file.path,
      status: file.status,
      hash: file.hash || file.previousHash || null,
      modifiedAt: file.modifiedAt || null
    }))
    .slice(0, 8);
}

function decisionRecord({ id, title, statement, type, status = "valid", sourceRefs = [], observedAt = null, validFrom = null, validUntil = null, invalidatedBy = [], appliesTo = [], confidence = "medium", nextAction = "", architectureTrace = {}, changedFiles = [] }) {
  const refs = [...new Set((sourceRefs || []).filter(Boolean))].slice(0, 12);
  const changedSources = changedSourceRefs(refs, changedFiles);
  const invalidators = decisionItems(invalidatedBy).filter(Boolean).slice(0, 8);
  const effectiveStatus = invalidators.length
    ? "invalid"
    : status === "invalid" || status === "bad"
      ? "invalid"
      : changedSources.length || status === "watch" || status === "warn"
        ? "watch"
        : "valid";
  return {
    id,
    title: compact(title || statement || id, 140),
    statement: compact(statement || title || id, 360),
    type,
    status: effectiveStatus,
    confidence,
    observedAt,
    validFrom: validFrom || observedAt || null,
    validUntil: validUntil || null,
    invalidatedBy: invalidators,
    changedSources,
    appliesTo: [...new Set((appliesTo || []).filter(Boolean))].slice(0, 8),
    sourceRefs: refs,
    sourceHash: decisionSourceHash(refs, architectureTrace),
    nextAction: compact(nextAction || (effectiveStatus === "valid" ? "Use this decision, but verify cited refs before broad edits." : "Re-check this decision against changed source refs before relying on it."), 220)
  };
}

function decisionLedgerCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: (refs || []).filter(Boolean).slice(0, 8)
  };
}

function buildDecisionLedger({ summary = {}, governance = {}, processTrace = {}, architectureTrace = {}, changedFiles = [], stateRefs = [] }) {
  const explicit = (summary.decisions || []).slice(0, 12).map((decision, index) => {
    const refs = [
      ...decisionItems(decision.refs),
      ...decisionItems(decision.sourceRefs),
      decision.ref,
      decision.source,
      decision.evidence,
      ".project-agent/state.json"
    ].flat().filter(Boolean);
    return decisionRecord({
      id: decision.id || `decision_${index}`,
      title: decision.title || decision.decision || decision.summary || `Decision ${index + 1}`,
      statement: decision.decision || decision.statement || decision.detail || decision.summary || decision.title,
      type: "explicit_decision",
      status: decision.status || "valid",
      sourceRefs: refs,
      observedAt: decision.createdAt || decision.observedAt || summary.updatedAt || null,
      validFrom: decision.validFrom || decision.createdAt || null,
      validUntil: decision.validUntil || null,
      invalidatedBy: decision.invalidatedBy,
      appliesTo: decision.appliesTo || decision.files || [],
      confidence: decision.confidence || (refs.length ? "medium" : "low"),
      nextAction: decision.nextAction,
      architectureTrace,
      changedFiles
    });
  });
  const governanceDecisions = (governance.domains || []).map((domain) =>
    decisionRecord({
      id: `governance:${domain.id}`,
      title: domain.label,
      statement: domain.detail || domain.nextAction || domain.label,
      type: "governance_decision",
      status: domain.status === "bad" ? "invalid" : domain.status === "warn" ? "watch" : "valid",
      sourceRefs: [".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", ...(domain.refs || [])],
      observedAt: processTrace?.current?.at || architectureTrace?.scannedAt || summary.updatedAt || null,
      validFrom: processTrace?.current?.at || architectureTrace?.scannedAt || null,
      appliesTo: domain.refs || [],
      confidence: domain.refs?.length ? "high" : "medium",
      nextAction: domain.nextAction,
      architectureTrace,
      changedFiles
    })
  );
  const benchmarkDecisions = [
    decisionRecord({
      id: "product:agent_governance_workspace",
      title: "Agent Governance Workspace",
      statement: "Project Agent Terminal should bind memory, process, architecture, governance, handoff, terminal, and takeover readiness into one visible state contract.",
      type: "product_strategy",
      status: "valid",
      sourceRefs: ["docs/research/agent-governance-landscape.md", "PROJECT.md", ".project-agent/governance-spec.json"],
      observedAt: processTrace?.current?.at || architectureTrace?.scannedAt || summary.updatedAt || null,
      validFrom: architectureTrace?.scannedAt || summary.updatedAt || null,
      appliesTo: ["governance-kernel", "agent-context-bundle", "continuity-contract"],
      confidence: "high",
      nextAction: "Preserve the workbench as an evidence-backed takeover state machine, not a generic memory database.",
      architectureTrace,
      changedFiles
    }),
    decisionRecord({
      id: "product:temporal_provenance",
      title: "Temporal Provenance",
      statement: "Memory and decision claims should carry source refs, source hashes, observed time, and validity windows so stale or contradicted facts are visible.",
      type: "product_strategy",
      status: "valid",
      sourceRefs: ["docs/research/agent-governance-landscape.md", ".project-agent/state.json", ".project-agent/architecture-map.json"],
      observedAt: processTrace?.current?.at || architectureTrace?.scannedAt || summary.updatedAt || null,
      validFrom: architectureTrace?.scannedAt || summary.updatedAt || null,
      appliesTo: ["decision-ledger", "memory-graph", "provenance-ledger"],
      confidence: "high",
      nextAction: "Review decisionLedger before accepting remembered project rules or strategy claims.",
      architectureTrace,
      changedFiles
    })
  ];
  const decisions = [...explicit, ...governanceDecisions, ...benchmarkDecisions]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 24);
  const invalid = decisions.filter((item) => item.status === "invalid");
  const watch = decisions.filter((item) => item.status === "watch");
  const valid = decisions.filter((item) => item.status === "valid");
  const sourceBacked = decisions.filter((item) => item.sourceRefs?.length);
  const changedSourceCount = decisions.filter((item) => item.changedSources?.length).length;
  const withValidity = decisions.filter((item) => item.validFrom || item.validUntil);
  const status = !decisions.length
    ? "missing"
    : invalid.length
      ? "blocked"
      : watch.length || changedSourceCount
        ? "watch"
        : "traceable";
  const checks = [
    decisionLedgerCheck(
      "source_refs",
      "Source Refs",
      sourceBacked.length === decisions.length && decisions.length ? "ok" : decisions.length ? "warn" : "bad",
      decisions.length ? `${sourceBacked.length}/${decisions.length} decision(s) have source refs.` : "No decisions are available.",
      sourceBacked.flatMap((item) => item.sourceRefs || [])
    ),
    decisionLedgerCheck(
      "validity_windows",
      "Validity Windows",
      withValidity.length === decisions.length && decisions.length ? "ok" : decisions.length ? "warn" : "bad",
      decisions.length ? `${withValidity.length}/${decisions.length} decision(s) expose validFrom/validUntil metadata.` : "No validity windows are available.",
      decisions.map((item) => item.id)
    ),
    decisionLedgerCheck(
      "changed_sources",
      "Changed Sources",
      changedSourceCount ? "warn" : "ok",
      changedSourceCount ? `${changedSourceCount} decision(s) cite source files that changed recently.` : "No decision source refs are in the recent changed-file surface.",
      decisions.flatMap((item) => item.changedSources || []).map((item) => item.path)
    ),
    decisionLedgerCheck(
      "conflict_surface",
      "Conflict Surface",
      invalid.length ? "bad" : watch.length ? "warn" : "ok",
      invalid.length ? `${invalid.length} decision(s) are invalidated.` : watch.length ? `${watch.length} decision(s) need review.` : "No invalidated or conflicted decision is active.",
      [...invalid, ...watch].map((item) => item.id)
    )
  ];
  return {
    schemaVersion: "project-agent.decision-ledger.v1",
    status,
    summary:
      status === "traceable"
        ? `${valid.length} decision(s) are source-backed with validity metadata.`
        : status === "watch"
          ? `Decision ledger is usable with ${watch.length + changedSourceCount} review signal(s).`
          : status === "blocked"
            ? `${invalid.length} invalidated decision(s) must be resolved before relying on handoff claims.`
            : "No decision ledger could be built.",
    decisionCount: decisions.length,
    validCount: valid.length,
    watchCount: watch.length,
    invalidCount: invalid.length,
    changedSourceCount,
    decisions,
    checks,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.id),
    blockers: checks.filter((check) => check.status === "bad").map((check) => check.id),
    refs: [".project-agent/state.json", ".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", "docs/research/agent-governance-landscape.md", ...(stateRefs || []).slice(0, 4)],
    nextAction:
      status === "traceable"
        ? "Use decision sourceRefs and sourceHash before trusting product strategy or project rules."
        : "Review watch/invalid decisions against changed source refs before continuing broad edits."
  };
}

function temporalAuditCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: [...new Set((refs || []).filter(Boolean))].slice(0, 8)
  };
}

function temporalFact({ id, label, kind, status = "valid", detail = "", observedAt = null, validFrom = null, validUntil = null, sourceRefs = [], sourceHash = null, changedSources = [], invalidatedBy = [], nextAction = "", architectureTrace = {}, changedFiles = [] }) {
  const refs = [...new Set((sourceRefs || []).filter(Boolean))].slice(0, 12);
  const invalidators = decisionItems(invalidatedBy).filter(Boolean).slice(0, 8);
  const changed = (changedSources?.length ? changedSources : changedSourceRefs(refs, changedFiles)).slice(0, 8);
  const parsedUntil = Date.parse(validUntil || "");
  const expired = Number.isFinite(parsedUntil) && parsedUntil < Date.now();
  const effectiveStatus = invalidators.length || ["invalid", "bad", "blocked"].includes(status)
    ? "invalid"
    : expired || ["expired", "stale"].includes(status)
      ? "stale"
      : changed.length || ["watch", "warn"].includes(status)
        ? "watch"
        : "valid";
  return {
    id,
    label: compact(label || id, 140),
    kind,
    status: effectiveStatus,
    detail: compact(detail || label || id, 360),
    observedAt,
    validFrom: validFrom || observedAt || null,
    validUntil: validUntil || null,
    sourceRefs: refs,
    sourceHash: sourceHash || decisionSourceHash(refs, architectureTrace),
    changedSources: changed,
    invalidatedBy: invalidators,
    nextAction: compact(nextAction || (effectiveStatus === "valid" ? "Use this fact after checking source refs." : "Re-check this fact against source refs before relying on it."), 220)
  };
}

function buildTemporalProvenanceAudit({ memoryGraph = {}, graphTrace = {}, decisionLedger = {}, processTrace = {}, architectureTrace = {}, freshnessGate = {}, changedFiles = [], stateRefs = [] }) {
  const observedFallback = processTrace?.current?.at || architectureTrace?.scannedAt || freshnessGate?.validity?.observedAt || null;
  const decisionFacts = (decisionLedger.decisions || []).slice(0, 18).map((decision) =>
    temporalFact({
      id: `decision:${decision.id}`,
      label: decision.title || decision.id,
      kind: "decision",
      status: decision.status,
      detail: decision.statement || decision.title,
      observedAt: decision.observedAt || observedFallback,
      validFrom: decision.validFrom || decision.observedAt || observedFallback,
      validUntil: decision.validUntil || null,
      sourceRefs: decision.sourceRefs || [],
      sourceHash: decision.sourceHash || null,
      changedSources: decision.changedSources || [],
      invalidatedBy: decision.invalidatedBy || [],
      nextAction: decision.nextAction,
      architectureTrace,
      changedFiles
    })
  );
  const memoryNodeFacts = (memoryGraph.nodes || []).slice(0, 14).map((node) =>
    temporalFact({
      id: `memory:${node.id}`,
      label: node.label || node.id,
      kind: `memory_node:${node.kind || "unknown"}`,
      status: node.status === "pending" ? "watch" : "valid",
      detail: node.meta || node.label || node.id,
      observedAt: observedFallback,
      validFrom: observedFallback,
      sourceRefs: node.provenance || node.refs || [],
      architectureTrace,
      changedFiles
    })
  );
  const memoryEdgeFacts = (memoryGraph.edges || []).slice(0, 10).map((edgeItem) =>
    temporalFact({
      id: `memory-edge:${edgeItem.source}:${edgeItem.label}:${edgeItem.target}`,
      label: `${edgeItem.source} -${edgeItem.label}-> ${edgeItem.target}`,
      kind: "memory_edge",
      status: "valid",
      detail: `${edgeItem.source} ${edgeItem.label} ${edgeItem.target}`,
      observedAt: observedFallback,
      validFrom: observedFallback,
      sourceRefs: edgeItem.provenance || edgeItem.refs || [],
      architectureTrace,
      changedFiles
    })
  );
  const processFacts = [processTrace.current, processTrace.previous].filter(Boolean).slice(0, 2).map((event, index) =>
    temporalFact({
      id: `process:${event.id || index}`,
      label: event.title || event.phase || `process-${index}`,
      kind: "process_event",
      status: event.status === "failed" || event.status === "blocked" ? "watch" : "valid",
      detail: event.detail || event.title,
      observedAt: event.at || observedFallback,
      validFrom: event.at || observedFallback,
      sourceRefs: [".project-agent/runtime.json", ".project-agent/process-trace.json", event.id, ...(event.refs || [])],
      architectureTrace,
      changedFiles
    })
  );
  const freshnessFact = freshnessGate?.schemaVersion
    ? temporalFact({
        id: "freshness:state_snapshot",
        label: "State Snapshot Freshness",
        kind: "freshness_gate",
        status: ["expired", "stale"].includes(freshnessGate.status) ? "stale" : freshnessGate.status === "watch" ? "watch" : "valid",
        detail: freshnessGate.summary,
        observedAt: freshnessGate.validity?.observedAt || freshnessGate.observedAt || observedFallback,
        validFrom: freshnessGate.validity?.validFrom || freshnessGate.validity?.observedAt || observedFallback,
        validUntil: freshnessGate.validity?.validUntil || null,
        sourceRefs: freshnessGate.refs || [".project-agent/agent-context-bundle.json", ".project-agent/state-manifest.json"],
        architectureTrace,
        changedFiles
      })
    : null;
  const facts = [...decisionFacts, ...memoryNodeFacts, ...memoryEdgeFacts, ...processFacts, freshnessFact]
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 48);
  const withValidity = facts.filter((fact) => fact.validFrom || fact.validUntil);
  const withHash = facts.filter((fact) => fact.sourceHash);
  const sourceBacked = facts.filter((fact) => fact.sourceRefs?.length);
  const invalidFacts = facts.filter((fact) => fact.status === "invalid");
  const staleFacts = facts.filter((fact) => fact.status === "stale" || fact.changedSources?.length);
  const watchFacts = facts.filter((fact) => fact.status === "watch");
  const contradictionFacts = invalidFacts.filter((fact) => fact.invalidatedBy?.length || fact.changedSources?.length || fact.sourceRefs?.length);
  const contradictions = contradictionFacts.map((fact) => ({
    factId: fact.id,
    label: fact.label,
    status: fact.status,
    invalidatedBy: fact.invalidatedBy || [],
    refs: [...new Set([...(fact.sourceRefs || []), ...(fact.invalidatedBy || [])])].slice(0, 8),
    nextAction: fact.nextAction
  }));
  const freshnessIsStale = ["stale", "expired"].includes(freshnessGate?.status);
  const checks = [
    temporalAuditCheck(
      "source_refs",
      "Source Refs",
      facts.length && sourceBacked.length === facts.length ? "ok" : facts.length ? "warn" : "bad",
      facts.length ? `${sourceBacked.length}/${facts.length} temporal fact(s) cite source refs.` : "No temporal facts are available.",
      sourceBacked.flatMap((fact) => fact.sourceRefs || [])
    ),
    temporalAuditCheck(
      "validity_windows",
      "Validity Windows",
      facts.length && withValidity.length === facts.length ? "ok" : facts.length ? "warn" : "bad",
      facts.length ? `${withValidity.length}/${facts.length} temporal fact(s) expose validFrom or validUntil.` : "No validity windows are available.",
      facts.map((fact) => fact.id)
    ),
    temporalAuditCheck(
      "source_hashes",
      "Source Hashes",
      facts.length && withHash.length === facts.length ? "ok" : facts.length ? "warn" : "bad",
      facts.length ? `${withHash.length}/${facts.length} temporal fact(s) carry source hashes.` : "No source hashes are available.",
      facts.map((fact) => fact.sourceHash).filter(Boolean)
    ),
    temporalAuditCheck(
      "stale_sources",
      "Stale Sources",
      staleFacts.length || freshnessIsStale ? "warn" : "ok",
      staleFacts.length || freshnessIsStale ? `${staleFacts.length} fact(s) have stale/changed sources; freshness=${freshnessGate?.status || "unknown"}.` : "No temporal fact has expired or changed source refs.",
      staleFacts.flatMap((fact) => [...(fact.sourceRefs || []), ...(fact.changedSources || []).map((item) => item.path)])
    ),
    temporalAuditCheck(
      "contradictions",
      "Contradictions",
      contradictions.length ? "bad" : "ok",
      contradictions.length ? `${contradictions.length} invalidated temporal fact(s) require resolution.` : "No invalidated temporal facts or explicit contradictions are active.",
      contradictions.flatMap((item) => item.refs || [])
    )
  ];
  const blockers = checks.filter((check) => check.status === "bad").map((check) => check.id);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.id);
  const status = !facts.length
    ? "missing"
    : blockers.length
      ? "blocked"
      : warnings.length || watchFacts.length || staleFacts.length
        ? "watch"
        : "traceable";
  return {
    schemaVersion: "project-agent.temporal-provenance-audit.v1",
    status,
    summary:
      status === "traceable"
        ? `${facts.length} temporal fact(s) are source-backed, hashed, and inside validity windows.`
        : status === "watch"
          ? `Temporal provenance is usable with ${warnings.length + watchFacts.length + staleFacts.length} review signal(s).`
          : status === "blocked"
            ? `Temporal provenance has ${blockers.length} blocking contradiction/source check(s).`
            : "No temporal provenance facts could be built.",
    factCount: facts.length,
    validCount: facts.filter((fact) => fact.status === "valid").length,
    watchCount: watchFacts.length,
    staleCount: staleFacts.length,
    invalidCount: invalidFacts.length,
    contradictionCount: contradictions.length,
    sourceBackedCount: sourceBacked.length,
    hashedCount: withHash.length,
    validityWindowCount: withValidity.length,
    facts,
    staleFacts: staleFacts.slice(0, 12),
    watchFacts: watchFacts.slice(0, 12),
    invalidFacts: invalidFacts.slice(0, 12),
    contradictions,
    checks,
    warnings,
    blockers,
    refs: [
      ".project-agent/continuity.json#temporalProvenance",
      ".project-agent/memory-graph.json",
      ".project-agent/continuity.json#decisionLedger",
      ".project-agent/process-trace.json",
      ".project-agent/state-manifest.json",
      "docs/research/agent-governance-landscape.md",
      ...(stateRefs || []).slice(0, 4)
    ],
    nextAction:
      status === "traceable"
        ? "Use fact sourceRefs, sourceHash, and validity windows before trusting remembered project state."
        : "Review stale, watch, or invalid temporal facts before relying on memory, decisions, or handoff claims."
  };
}

function specRequirement(id, statement, status, evidence = [], acceptance = "", notes = "") {
  return {
    id,
    statement,
    status,
    evidence: evidence.filter(Boolean).slice(0, 12),
    acceptance,
    notes
  };
}

function buildGovernanceSpec({ goal, governance, memoryGraph, processTrace, architectureMap, agentRunbook, continuityContract, takeoverReadiness }) {
  const domains = governance?.domains || [];
  const domainStatus = (id) => domains.find((domain) => domain.id === id)?.status || "bad";
  const memoryStatus = memoryGraph?.nodes?.length && memoryGraph?.edges?.length ? domainStatus("memory_visibility") : "bad";
  const processStatus = processTrace?.previous && processTrace?.current && processTrace?.next ? "ok" : processTrace?.current ? "warn" : "bad";
  const architectureStatus = architectureMap?.tree?.length && architectureMap?.files?.length ? domainStatus("architecture_management") : "bad";
  const continuityStatus = takeoverReadiness?.canTakeOver && agentRunbook?.nextCommand && continuityContract?.sourceOfTruth ? domainStatus("agent_continuity") : "bad";
  const requirements = [
    specRequirement(
      "memory_visible_knowledge_graph",
      "Project memory must be visible as a provenance-backed knowledge graph, not only as raw logs or chat text.",
      memoryStatus,
      [".project-agent/memory-graph.json", ".project-agent/state.json", ...(memoryGraph?.provenanceRefs || []).slice(0, 5)],
      "memory-graph.json has nodes, edges, provenance coverage, and UI render data.",
      `${memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0} node(s), ${memoryGraph?.edgeCount || memoryGraph?.edges?.length || 0} edge(s).`
    ),
    specRequirement(
      "process_dynamic_previous_current_next",
      "Agent work must be represented as a dynamic previous/current/next process trace, not a single static status.",
      processStatus,
      [".project-agent/process-trace.json", ".project-agent/runtime.json", processTrace?.previous?.id, processTrace?.current?.id, processTrace?.next?.id],
      "process-trace.json exposes previous, current, next, inspectOrder, and files touched.",
      processTrace?.current ? `${processTrace.current.phase}/${processTrace.current.status}: ${processTrace.current.title}` : "No process cursor."
    ),
    specRequirement(
      "architecture_visible_managed",
      "Project architecture must be visible as folders, files, recent changes, impacted areas, and inspect order.",
      architectureStatus,
      [".project-agent/architecture-map.json", ...(architectureMap?.inspectOrder || []).slice(0, 5).map((item) => item.path)],
      "architecture-map.json has tree, files, recentChanges, impact, and inspectOrder.",
      `${architectureMap?.files?.length || 0} file(s), ${architectureMap?.recentChanges?.length || 0} recent change(s).`
    ),
    specRequirement(
      "agent_neutral_handoff",
      "A replacement agent must be able to resume from files without relying on prior chat history.",
      continuityStatus,
      [
        ".project-agent/governance-spec.json",
        ".project-agent/continuity-contract.json",
        ".project-agent/agent-runbook.json",
        ".project-agent/takeover-packet.json",
        ".project-agent/continuity-audit.json",
        ".project-agent/next-agent-prompt.md"
      ],
      "contract, runbook, takeover packet, audit, and starter prompt exist with next command and first actions.",
      agentRunbook?.nextCommand ? `Next command: ${agentRunbook.nextCommand}` : "No next command."
    )
  ];
  const bad = requirements.filter((item) => item.status === "bad");
  const warn = requirements.filter((item) => item.status === "warn");
  const ok = requirements.filter((item) => item.status === "ok");
  return {
    schemaVersion: "project-agent.governance-spec.v1",
    purpose: "AI-native project development contract: visible memory, dynamic process, managed architecture, and agent-neutral crash recovery.",
    objective: goal?.objective || null,
    status: bad.length ? "blocked" : warn.length ? "watch" : "ready",
    score: `${ok.length}/${requirements.length}`,
    requirements,
    influences: [
      {
        name: "neo4j-labs/agent-memory",
        pattern: "graph-native memory with short-term, long-term, and reasoning traces",
        url: "https://github.com/neo4j-labs/agent-memory"
      },
      {
        name: "neo4j-labs/create-context-graph",
        pattern: "interactive graph visualization, live tool-call timeline, and decision trace viewer",
        url: "https://github.com/neo4j-labs/create-context-graph"
      },
      {
        name: "memory-graph/memory-graph",
        pattern: "coding-agent memory graph with typed project knowledge and relationship tracking",
        url: "https://github.com/memory-graph/memory-graph"
      },
      {
        name: "Codebase-Memory",
        pattern: "persistent codebase knowledge graph with impact analysis and fewer exploratory tokens",
        url: "https://arxiv.org/abs/2603.27277"
      }
    ],
    operatingRules: [
      "The chat transcript is not source of truth after handoff; .project-agent files are.",
      "Every memory, process, architecture, and continuity claim must point to a durable file or runtime event.",
      "A stale current event is treated as interrupted work until an agent resolves it.",
      "Do not claim completion until continuity-audit.json proves no blockers remain."
    ],
    readFirst: [
      ".project-agent/governance-spec.json",
      ".project-agent/continuity-contract.json",
      ".project-agent/agent-runbook.json",
      ".project-agent/memory-graph.json",
      ".project-agent/process-trace.json",
      ".project-agent/architecture-map.json",
      ".project-agent/takeover-packet.json",
      ".project-agent/continuity-audit.json"
    ]
  };
}

function buildGraphTrace(knowledgeGraph = {}) {
  const nodes = knowledgeGraph.nodes || [];
  const edges = knowledgeGraph.edges || [];
  const provenanceBacked = nodes.filter((node) => node.provenance?.length);
  const byKind = nodes.reduce((acc, node) => {
    const kind = node.kind || "unknown";
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  const coreIds = ["project", "kernel", "goal", "architecture", "memory", "session", "handoff"];
  const coreNodes = coreIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter(Boolean)
    .map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      status: node.status,
      meta: node.meta,
      refs: (node.provenance || []).slice(0, 6)
    }));
  const keyRelations = edges
    .filter((edge) => coreIds.includes(edge.source) || coreIds.includes(edge.target) || edge.label === "verifies" || edge.label === "touches")
    .slice(0, 12)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label,
      refs: (edge.provenance || []).slice(0, 5)
    }));
  return {
    status: nodes.length && edges.length ? "traceable" : "missing",
    source: knowledgeGraph.source || "project-agent",
    nodeCount: nodes.length,
    edgeCount: edges.length,
    provenanceBacked: provenanceBacked.length,
    provenanceCoverage: nodes.length ? `${provenanceBacked.length}/${nodes.length}` : "0/0",
    byKind,
    coreNodes,
    keyRelations,
    nextAction: nodes.length ? "Inspect a node before trusting or editing related project memory." : "Build the knowledge graph before handoff."
  };
}

function buildMemoryGraphSnapshot(knowledgeGraph = {}, graphTrace = {}) {
  const nodes = knowledgeGraph.nodes || [];
  const edges = knowledgeGraph.edges || [];
  const provenanceRefs = [
    ...nodes.flatMap((node) => node.provenance || []),
    ...edges.flatMap((edgeItem) => edgeItem.provenance || [])
  ].filter(Boolean);
  return {
    schemaVersion: "project-agent.memory-graph.v1",
    source: knowledgeGraph.source || "project-agent",
    nodeCount: nodes.length,
    edgeCount: edges.length,
    readyCount: knowledgeGraph.readyCount || nodes.filter((item) => item.status !== "pending").length,
    totalCount: knowledgeGraph.totalCount || nodes.length,
    provenanceCoverage: graphTrace.provenanceCoverage || `${nodes.filter((node) => node.provenance?.length).length}/${nodes.length}`,
    legend: knowledgeGraph.legend || [],
    nodes,
    edges,
    provenanceRefs: [...new Set(provenanceRefs)].slice(0, 80),
    readFirst: [".project-agent/memory-graph.json", ".project-agent/continuity.json", ".project-agent/state.json"],
    nextAction: graphTrace.nextAction || "Use nodes, edges, and provenanceRefs to reconstruct project memory before editing."
  };
}

function buildArchitectureTrace(architecture = {}, changedFiles = []) {
  const topFolders = architecture?.impact?.topFolders || architecture?.impact?.folders || [];
  const changes = changedFiles.length ? changedFiles : latestUniqueChanges(architecture?.recentChanges || architecture?.changes || [], 12);
  const modules = architecture?.modules || [];
  const totals = architecture?.totals || {};
  const deleted = changes.filter((file) => file.status === "deleted");
  const modified = changes.filter((file) => file.status === "modified");
  const added = changes.filter((file) => file.status === "added");
  const inspectOrder = [
    ...topFolders.slice(0, 4).map((folder) => ({
      type: "folder",
      path: folder.folder,
      reason: folder.summary || `${folder.files || 0} changed file(s)`,
      latestFile: folder.latestFile,
      status: folder.deleted ? "deleted" : folder.modified ? "modified" : folder.added ? "added" : "changed",
      refs: [folder.latestFile, ...(folder.changes || []).slice(0, 3).map((change) => change.path)].filter(Boolean)
    })),
    ...changes.slice(0, 8).map((file) => ({
      type: "file",
      path: file.path,
      reason: [file.kind, file.summary].filter(Boolean).join(" "),
      latestFile: file.path,
      status: file.status,
      refs: [file.path, file.hash || file.previousHash].filter(Boolean)
    }))
  ];
  const codeGraph = buildCodeGraphTrace(architecture?.codeGraph, changes);
  return {
    status: totals.files ? (changes.length ? "changed" : "stable") : "missing",
    scannedAt: architecture?.scannedAt || null,
    root: architecture?.root || null,
    totals: {
      files: totals.files || 0,
      directories: totals.directories || 0,
      changed: changes.length,
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      tracked: Boolean(totals.tracked)
    },
    modules: modules.slice(0, 8),
    topFolders: topFolders.slice(0, 8).map((folder) => ({
      folder: folder.folder,
      summary: folder.summary,
      files: folder.files || 0,
      added: folder.added || 0,
      modified: folder.modified || 0,
      deleted: folder.deleted || 0,
      additions: folder.additions || 0,
      deletions: folder.deletions || 0,
      latestFile: folder.latestFile,
      kinds: folder.kinds || [],
      priority: folder.priority || 0,
      refs: (folder.changes || []).slice(0, 5).map((change) => change.path)
    })),
    changedFiles: changes.slice(0, 12).map((file) => ({
      path: file.path,
      status: file.status,
      kind: file.kind,
      summary: file.summary,
      additions: file.additions || 0,
      deletions: file.deletions || 0,
      lineCount: file.lineCount,
      previousLineCount: file.previousLineCount,
      hash: file.hash,
      previousHash: file.previousHash,
      modifiedAt: file.modifiedAt
    })),
    codeGraph,
    inspectOrder: inspectOrder.filter((item, index, all) => all.findIndex((candidate) => `${candidate.type}:${candidate.path}` === `${item.type}:${item.path}`) === index).slice(0, 12),
    nextAction: topFolders.length
      ? `Inspect ${topFolders[0].folder === "." ? "repo root" : topFolders[0].folder} and ${topFolders[0].latestFile || "recent files"} before editing.`
      : changes.length
        ? `Inspect ${changes[0].path} before editing.`
        : "Run architecture scan before editing."
  };
}

function buildCodeGraphTrace(codeGraph = {}, changedFiles = []) {
  if (!codeGraph || codeGraph.schemaVersion !== "project-agent.code-graph.v1") {
    return {
      schemaVersion: "project-agent.code-graph.v1",
      status: "missing",
      nodeCount: 0,
      edgeCount: 0,
      localEdgeCount: 0,
      packageEdgeCount: 0,
      unresolvedEdgeCount: 0,
      changedImpact: [],
      hotspots: [],
      packages: [],
      inspectOrder: [],
      summary: "No code dependency graph is available.",
      refs: [".project-agent/architecture-map.json"],
      nextAction: "Refresh architecture map before relying on dependency impact."
    };
  }
  const nodeByPath = new Map((codeGraph.nodes || []).filter((node) => node?.path).map((node) => [node.path, node]));
  const dependenciesByPath = codeGraph.dependenciesByPath || {};
  const dependentsByPath = codeGraph.dependentsByPath || {};
  const changedImpact = (changedFiles || [])
    .filter((file) => file?.path && (nodeByPath.has(file.path) || dependenciesByPath[file.path] || dependentsByPath[file.path] || /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(file.path)))
    .slice(0, 12)
    .map((file) => {
      const node = nodeByPath.get(file.path) || {};
      const dependencies = (dependenciesByPath[file.path] || node.imports || []).slice(0, 10);
      const dependents = (dependentsByPath[file.path] || node.importedBy || []).slice(0, 10);
      return {
        path: file.path,
        status: file.status || "changed",
        dependencies,
        dependents,
        packageImports: (node.packageImports || []).slice(0, 8),
        risk: dependents.length ? "fan_in" : dependencies.length ? "fan_out" : "isolated",
        refs: [file.path, ...dependents.slice(0, 4), ...dependencies.slice(0, 4)].filter(Boolean),
        nextAction: dependents.length
          ? `Inspect ${dependents.slice(0, 3).join(", ")} before editing ${file.path}.`
          : dependencies.length
            ? `Inspect imports used by ${file.path} before editing.`
            : `No local dependency edge is linked for ${file.path}; inspect manually.`
      };
    });
  const inspectOrder = [
    ...changedImpact
      .filter((item) => item.dependents.length || item.dependencies.length)
      .map((item) => ({
        type: "dependency",
        path: item.path,
        status: item.risk,
        reason: `${item.dependents.length} dependent(s), ${item.dependencies.length} dependency link(s)`,
        refs: item.refs
      })),
    ...(codeGraph.hotspots || []).slice(0, 8).map((item) => ({
      type: "hotspot",
      path: item.path,
      status: item.importedBy ? "fan_in" : "fan_out",
      reason: `${item.importedBy || 0} inbound / ${item.imports || 0} outbound import(s)`,
      refs: item.refs || [item.path]
    }))
  ].filter((item, index, all) => all.findIndex((candidate) => `${candidate.type}:${candidate.path}` === `${item.type}:${item.path}`) === index).slice(0, 12);
  return {
    schemaVersion: "project-agent.code-graph.v1",
    status: codeGraph.status || "missing",
    scannedAt: codeGraph.scannedAt || null,
    nodeCount: codeGraph.nodeCount || 0,
    edgeCount: codeGraph.edgeCount || 0,
    localEdgeCount: codeGraph.localEdgeCount || 0,
    packageEdgeCount: codeGraph.packageEdgeCount || 0,
    unresolvedEdgeCount: codeGraph.unresolvedEdgeCount || 0,
    nodes: (codeGraph.nodes || []).slice(0, 40),
    edges: (codeGraph.edges || []).slice(0, 80),
    packages: (codeGraph.packages || []).slice(0, 12),
    hotspots: (codeGraph.hotspots || []).slice(0, 10),
    dependenciesByPath,
    dependentsByPath,
    changedImpact,
    inspectOrder,
    warnings: codeGraph.warnings || [],
    summary: codeGraph.summary || `${codeGraph.nodeCount || 0} code node(s), ${codeGraph.edgeCount || 0} dependency edge(s).`,
    refs: codeGraph.refs || [".project-agent/architecture-map.json"],
    nextAction: changedImpact.find((item) => item.dependents.length)?.nextAction || codeGraph.nextAction || "Inspect dependency graph before editing imported files."
  };
}

function compactTree(nodes = [], depth = 0) {
  return (nodes || []).slice(0, depth > 2 ? 12 : 40).map((node) => {
    if (node.type === "file") {
      return {
        type: "file",
        name: node.name,
        path: node.path,
        kind: node.kind,
        status: node.status || "unchanged",
        lineCount: node.lineCount,
        hash: node.hash
      };
    }
    return {
      type: "dir",
      name: node.name,
      path: node.path,
      status: node.status || "unchanged",
      fileCount: node.fileCount || 0,
      children: compactTree(node.children || [], depth + 1)
    };
  });
}

function buildArchitectureMapSnapshot(architecture = {}, architectureTrace = {}) {
  const files = (architecture.files || []).slice(0, 200).map((file) => ({
    path: file.path,
    name: file.name,
    kind: file.kind,
    status: file.status,
    size: file.size,
    lineCount: file.lineCount,
    hash: file.hash,
    modifiedAt: file.modifiedAt
  }));
  return {
    schemaVersion: "project-agent.architecture-map.v1",
    root: architecture.root || null,
    scannedAt: architecture.scannedAt || architectureTrace.scannedAt || null,
    totals: architectureTrace.totals || architecture.totals || {},
    modules: architecture.modules || architectureTrace.modules || [],
    tree: compactTree(architecture.tree || []),
    files,
    recentChanges: (architecture.recentChanges || architecture.changes || []).slice(0, 40),
    impact: architecture.impact || { folders: [], topFolders: [], totals: {} },
    codeGraph: architectureTrace.codeGraph || architecture.codeGraph || null,
    trace: architectureTrace,
    inspectOrder: architectureTrace.inspectOrder || [],
    readFirst: [".project-agent/architecture-map.json", ".project-agent/process-trace.json", ".project-agent/continuity.json"],
    nextAction: architectureTrace.nextAction || "Inspect architecture-map.json before editing changed folders or files."
  };
}

function compactEventTrace(event, label) {
  if (!event) return null;
  return {
    label,
    id: event.id,
    at: event.at,
    phase: event.phase,
    title: event.title,
    status: event.status,
    detail: event.detail,
    workstream: event.workstream,
    refs: (event.refs || []).slice(0, 8),
    artifactRefs: (event.artifactRefs || []).slice(0, 8),
    files: (event.files || []).slice(0, 6).map((file) => ({
      path: file.path,
      status: file.status,
      kind: file.kind,
      summary: file.summary,
      hash: file.hash
    })),
    source: event.source,
    tool: event.tool,
    agentId: event.agentId,
    goalId: event.goalId,
    spanId: event.spanId,
    parentId: event.parentId || event.parentEventId || event.parentSpanId,
    parentEventId: event.parentEventId || event.parentId || event.parentSpanId,
    runId: event.runId,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    durationMs: event.durationMs,
    cost: event.cost,
    error: event.error,
    data: event.data?.ingress ? { ingress: event.data.ingress } : undefined
  };
}

function buildProcessTrace(process = {}) {
  const previous = compactEventTrace(process.previous, "previous");
  const current = compactEventTrace(process.current, "current");
  const next = compactEventTrace(process.next, "next");
  const events = (process.events || []).slice(0, 12).map((event, index) => compactEventTrace(event, index === 0 ? "latest" : "event")).filter(Boolean);
  const phases = (process.phases || []).map((phase) => ({
    id: phase.id,
    label: phase.label,
    status: phase.status,
    detail: phase.detail,
    workstream: phase.workstream
  }));
  const filesTouched = [];
  const seenFiles = new Set();
  for (const event of events) {
    for (const file of event.files || []) {
      if (!file.path || seenFiles.has(file.path)) continue;
      seenFiles.add(file.path);
      filesTouched.push(file);
    }
  }
  const inspectOrder = [current, previous, next, ...events]
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id && candidate.label === item.label) === index)
    .slice(0, 12)
    .map((item) => ({
      type: item.label === "next" ? "expected" : "event",
      id: item.id,
      phase: item.phase,
      status: item.status,
      title: item.title,
      workstream: item.workstream,
      refs: [...(item.refs || []), ...(item.files || []).map((file) => file.path)].filter(Boolean).slice(0, 8)
    }));
  return {
    schemaVersion: "project-agent.process-trace.v1",
    status: current ? "active" : "missing",
    current,
    previous,
    next,
    phases,
    events,
    eventCount: process.events?.length || 0,
    activeWorkstream: process.workstream || process.workstreams?.active || current?.workstream || null,
    nextWorkstream: process.workstreams?.next || next?.workstream || null,
    filesTouched: filesTouched.slice(0, 12),
    inspectOrder,
    nextAction: current
      ? `Resume from ${current.phase}/${current.status}: ${current.title}; record done/failed after the next tool call.`
      : "Record a current event before the next tool call.",
    readFirst: [".project-agent/process-trace.json", ".project-agent/runtime.json", ".project-agent/agent-runbook.json"]
  };
}

function fileFolder(relPath) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  if (!parts.length) return ".";
  if (parts[0] === ".project-agent") return ".project-agent";
  if (parts[0] === "docs" && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : ".";
}

function statusRisk(status) {
  if (["failed", "blocked", "deleted"].includes(status)) return "high";
  if (["current", "modified", "added", "watch", "warn"].includes(status)) return "medium";
  return "low";
}

function buildDevelopmentTrail({ processTrace = {}, architectureTrace = {}, changedFiles = [] }) {
  const architectureByPath = new Map((architectureTrace.changedFiles || changedFiles || []).map((file) => [file.path, file]));
  const folderByPath = new Map((architectureTrace.topFolders || []).map((folder) => [folder.folder, folder]));
  const sequence = [processTrace.previous, processTrace.current, processTrace.next, ...(processTrace.events || [])]
    .filter(Boolean)
    .filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id && candidate.label === event.label) === index)
    .slice(0, 10);
  const steps = sequence.map((event) => {
    const eventFiles = (event.files || []).filter((file) => file.path);
    const refFiles = (event.refs || [])
      .filter((ref) => typeof ref === "string" && !ref.startsWith(".project-agent/") && /\.[a-z0-9]+$/i.test(ref))
      .map((pathRef) => architectureByPath.get(pathRef) || { path: pathRef, status: "referenced" });
    const files = [...eventFiles, ...refFiles]
      .filter((file, index, all) => file.path && all.findIndex((candidate) => candidate.path === file.path) === index)
      .slice(0, 8);
    const folders = [...new Set(files.map((file) => fileFolder(file.path)))].slice(0, 5).map((folder) => {
      const impact = folderByPath.get(folder);
      return {
        folder,
        status: impact?.deleted ? "deleted" : impact?.modified ? "modified" : impact?.added ? "added" : files.some((file) => fileFolder(file.path) === folder && file.status !== "unchanged") ? "changed" : "referenced",
        summary: impact?.summary || `${files.filter((file) => fileFolder(file.path) === folder).length} touched/ref file(s)`,
        latestFile: impact?.latestFile || files.find((file) => fileFolder(file.path) === folder)?.path || null
      };
    });
    const risk = [statusRisk(event.status), ...files.map((file) => statusRisk(file.status)), ...folders.map((folder) => statusRisk(folder.status))]
      .includes("high")
      ? "high"
      : [statusRisk(event.status), ...files.map((file) => statusRisk(file.status)), ...folders.map((folder) => statusRisk(folder.status))]
          .includes("medium")
        ? "medium"
        : "low";
    return {
      id: event.id,
      label: event.label || "event",
      phase: event.phase,
      status: event.status,
      title: event.title,
      detail: event.detail,
      workstream: event.workstream,
      at: event.at || null,
      risk,
      files,
      folders,
      refs: [...new Set([...(event.refs || []), ...files.map((file) => file.path), ...folders.map((folder) => folder.folder)].filter(Boolean))].slice(0, 12),
      nextAction: event.label === "next"
        ? "Prepare or record this expected next event before the next tool call."
        : event.status === "current"
          ? "Finish, fail, or hand off this active step before starting unrelated edits."
          : "Review this step if its touched files overlap the next edit."
    };
  });
  const linkedSteps = steps.filter((step) => step.files.length || step.folders.length);
  const current = steps.find((step) => step.label === "current") || steps.find((step) => step.status === "current") || steps[0] || null;
  const previous = steps.find((step) => step.label === "previous") || null;
  const next = steps.find((step) => step.label === "next") || null;
  const fileCoverage = `${linkedSteps.length}/${steps.length || 0}`;
  return {
    schemaVersion: "project-agent.development-trail.v1",
    status: steps.length && current ? (linkedSteps.length ? "linked" : "unlinked") : "missing",
    summary: linkedSteps.length
      ? `${linkedSteps.length} process step(s) are linked to files or architecture folders.`
      : "No process step is linked to changed files or architecture folders yet.",
    current,
    previous,
    next,
    steps,
    fileCoverage,
    inspectOrder: steps
      .flatMap((step) => [
        { type: "process", id: step.id, title: step.title, status: step.status, reason: step.nextAction },
        ...step.folders.map((folder) => ({ type: "folder", path: folder.folder, status: folder.status, reason: folder.summary })),
        ...step.files.map((file) => ({ type: "file", path: file.path, status: file.status, reason: file.summary || step.title }))
      ])
      .filter((item, index, all) => all.findIndex((candidate) => `${candidate.type}:${candidate.id || candidate.path}` === `${item.type}:${item.id || item.path}`) === index)
      .slice(0, 16),
    nextAction: current?.nextAction || "Record a current process event with files before editing."
  };
}

function isTestLikePath(relPath) {
  return /\.test\./.test(relPath) || /\.spec\./.test(relPath) || /(^|\/)tests?\//.test(relPath) || /(^|\/)__tests__\//.test(relPath);
}

function riskCheck(id, label, status, detail, refs = [], action = "") {
  return {
    id,
    label,
    status,
    detail: compact(detail, 240),
    action: compact(action, 180),
    refs: refs.filter(Boolean).slice(0, 8)
  };
}

function buildPreEditRisk({ changedFiles = [], architectureTrace = {}, developmentTrail = {}, interruptedWork = {}, takeoverReadiness = {}, openTargets = [] }) {
  const topFolders = architectureTrace.topFolders || [];
  const codeGraph = architectureTrace.codeGraph || {};
  const highRiskSteps = (developmentTrail.steps || []).filter((step) => step.risk === "high");
  const currentRiskStep = (developmentTrail.steps || []).find((step) => step.status === "current" || step.label === "current") || developmentTrail.current;
  const editSurface = changedFiles.filter((file) => file.kind !== "state").slice(0, 10);
  const changedTestFiles = editSurface.filter((file) => file.kind === "test" || isTestLikePath(file.path));
  const changedCodeFiles = editSurface.filter((file) => ["code", "config", "kernel"].includes(file.kind) || /\.(js|jsx|ts|tsx|py|go|rs|java|rb|php)$/i.test(file.path));
  const dependencyImpact = (codeGraph.changedImpact || []).filter((item) => item.dependents?.length || item.dependencies?.length || item.packageImports?.length);
  const inboundDependencyImpact = dependencyImpact.filter((item) => item.dependents?.length);
  const testGap = Boolean(changedCodeFiles.length && !changedTestFiles.length);
  const folderGroups = new Map();
  for (const file of editSurface) {
    const folder = fileFolder(file.path);
    if (!folderGroups.has(folder)) folderGroups.set(folder, []);
    folderGroups.get(folder).push(file.path);
  }
  const coChangePartners = [...folderGroups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .slice(0, 5)
    .map(([folder, paths]) => ({
      folder,
      paths: paths.slice(0, 6),
      summary: `${paths.length} changed file(s) in ${folder === "." ? "repo root" : folder}`
    }));
  const checks = [
    riskCheck(
      "interrupted_work",
      "Interrupted Work",
      interruptedWork.count ? "bad" : "ok",
      interruptedWork.count ? `${interruptedWork.count} stale current operation(s) must be resolved first.` : "No stale current operation blocks the next edit.",
      (interruptedWork.items || []).flatMap((item) => [item.id, ...(item.refs || [])]),
      interruptedWork.count ? interruptedWork.nextAction || "Resolve interrupted work before editing unrelated files." : "Continue."
    ),
    riskCheck(
      "takeover_readiness",
      "Takeover Readiness",
      takeoverReadiness.canTakeOver ? "ok" : "bad",
      takeoverReadiness.summary || "No takeover readiness summary is available.",
      takeoverReadiness.readFirst || [],
      takeoverReadiness.canTakeOver ? "Use the runbook and record the next current event." : "Restore takeover blockers before editing."
    ),
    riskCheck(
      "current_step",
      "Current Step",
      highRiskSteps.length ? "bad" : currentRiskStep?.risk === "medium" ? "warn" : "ok",
      currentRiskStep?.title ? `${currentRiskStep.title}; risk ${currentRiskStep.risk || "unknown"}.` : "No process-linked edit risk is active.",
      currentRiskStep?.refs || [],
      currentRiskStep?.nextAction || "Review the development trail before editing."
    ),
    riskCheck(
      "edit_surface",
      "Edit Surface",
      editSurface.length > 8 ? "warn" : editSurface.length ? "warn" : "ok",
      editSurface.length ? `${editSurface.length} changed/recent file(s) should be inspected before editing.` : "No changed file surface is currently tracked.",
      editSurface.map((file) => file.path),
      editSurface[0]?.path ? `Inspect ${editSurface[0].path} and related files first.` : "Run or refresh architecture scan if the next edit has no file context."
    ),
    riskCheck(
      "architecture_impact",
      "Architecture Impact",
      topFolders.length > 3 ? "warn" : topFolders.length ? "warn" : "ok",
      topFolders.length ? `${topFolders.length} impacted folder(s); top ${topFolders[0].folder === "." ? "repo root" : topFolders[0].folder}.` : "No impacted folder is currently tracked.",
      topFolders.flatMap((folder) => [folder.folder, folder.latestFile]),
      topFolders[0]?.folder ? `Inspect ${topFolders[0].folder === "." ? "repo root" : topFolders[0].folder} before editing.` : "Refresh architecture impact before broad edits."
    ),
    riskCheck(
      "dependency_impact",
      "Dependency Impact",
      inboundDependencyImpact.length ? "warn" : codeGraph.nodeCount || !changedCodeFiles.length ? "ok" : "warn",
      inboundDependencyImpact.length
        ? `${inboundDependencyImpact.length} changed code file(s) have local dependents.`
        : dependencyImpact.length
          ? `${dependencyImpact.length} changed code file(s) have outbound dependency links.`
          : codeGraph.nodeCount
            ? "No changed file has an inbound local dependency edge."
            : "No code dependency graph is available for the changed code surface.",
      dependencyImpact.flatMap((item) => [item.path, ...(item.dependents || []), ...(item.dependencies || [])]),
      inboundDependencyImpact[0]?.nextAction || dependencyImpact[0]?.nextAction || (changedCodeFiles[0]?.path ? `Inspect dependency graph before editing ${changedCodeFiles[0].path}.` : "Continue.")
    ),
    riskCheck(
      "test_gap",
      "Test Gap",
      testGap ? "warn" : "ok",
      testGap ? `${changedCodeFiles.length} code/config file(s) changed without a changed test file.` : changedTestFiles.length ? `${changedTestFiles.length} changed test file(s) cover the edit surface.` : "No code edit surface needs a test pairing yet.",
      [...changedCodeFiles, ...changedTestFiles].map((file) => file.path),
      testGap ? "Run the relevant test command or add evidence before claiming completion." : "Keep test evidence linked to acceptance criteria."
    ),
    riskCheck(
      "acceptance_gaps",
      "Acceptance Gaps",
      openTargets.length ? "warn" : "ok",
      openTargets.length ? `${openTargets.length} acceptance target(s) still need evidence.` : "Acceptance targets have linked evidence or no targets are open.",
      openTargets.map((target) => target.id),
      openTargets[0]?.id ? `Collect evidence for ${openTargets[0].id}.` : "Do not claim completion without a final audit."
    )
  ];
  const bad = checks.filter((check) => check.status === "bad");
  const warn = checks.filter((check) => check.status === "warn");
  const status = bad.length ? "blocked" : warn.length >= 3 || highRiskSteps.length ? "high" : warn.length ? "medium" : "low";
  const firstChecks = checks
    .filter((check) => check.status !== "ok")
    .map((check) => ({ id: check.id, action: check.action, refs: check.refs }))
    .slice(0, 5);
  if (!firstChecks.length) {
    firstChecks.push({ id: "record_current_event", action: "Record a current event with files before the next edit.", refs: ["/api/events", "npm run event"] });
  }
  return {
    schemaVersion: "project-agent.pre-edit-risk.v1",
    status,
    score: `${checks.filter((check) => check.status === "ok").length}/${checks.length}`,
    summary: bad.length
      ? `Pre-edit risk is blocked by ${bad.length} required fix(es).`
      : warn.length
        ? `Pre-edit risk is ${status}; inspect ${warn.length} warning area(s) before editing.`
        : "Pre-edit risk is low; continue with the runbook and record the next event.",
    checks,
    firstChecks,
    changedFiles: editSurface,
    impactedFolders: topFolders.slice(0, 6),
    coChangePartners,
    testGap: {
      status: testGap ? "warn" : "ok",
      changedCodeFiles: changedCodeFiles.map((file) => file.path).slice(0, 8),
      changedTestFiles: changedTestFiles.map((file) => file.path).slice(0, 8)
    },
    refs: [
      ".project-agent/development-trail.json",
      ".project-agent/architecture-map.json",
      ".project-agent/process-trace.json",
      ".project-agent/continuity-contract.json"
    ],
    nextAction: firstChecks[0]?.action || "Record a current event with files before editing."
  };
}

function contractCapability(id, label, status, summary, refs = []) {
  return {
    id,
    label,
    status,
    summary: compact(summary, 260),
    refs: (refs || []).filter(Boolean).slice(0, 8)
  };
}

function boundaryLayer(id, label, role, refs = [], options = {}) {
  return {
    id,
    label,
    role,
    authority: options.authority || "project_agent",
    sourceOfTruth: Boolean(options.sourceOfTruth),
    derived: Boolean(options.derived),
    disclosure: Boolean(options.disclosure),
    mutable: options.mutable || "append_or_refresh",
    refs: [...new Set((refs || []).filter(Boolean))].slice(0, 14),
    derivedFrom: [...new Set((options.derivedFrom || []).filter(Boolean))].slice(0, 10),
    writes: [...new Set((options.writes || []).filter(Boolean))].slice(0, 8)
  };
}

function boundaryCheck(id, label, status, detail, refs = []) {
  return {
    id,
    label,
    status,
    detail: compact(detail, 260),
    refs: [...new Set((refs || []).filter(Boolean))].slice(0, 8)
  };
}

function buildStateBoundary({ stateRefs = [], processTrace = {}, memoryGraph = {}, architectureTrace = {}, decisionLedger = {}, checkpointLedger = {}, phaseLedger = {}, runtimeEval = {}, hookIngressAudit = {} }) {
  const hasRef = (ref) => stateRefs.includes(ref);
  const layers = [
    boundaryLayer(
      "raw_events",
      "Raw Events",
      "Append-only runtime and hook events; these are the first record of agent/tool activity.",
      [".project-agent/runtime.json", "/api/events", "/api/hooks"],
      {
        sourceOfTruth: true,
        authority: "event_ingress",
        mutable: "append_only",
        writes: ["npm run event", "/api/events", "/api/hooks"]
      }
    ),
    boundaryLayer(
      "durable_sources",
      "Durable Sources",
      "Human/project-authored durable memory and governance docs that should outrank generated summaries.",
      [".project-agent/state.json", "PROJECT.md", "AGENTS.md", "docs/architecture/principles.md", "docs/agents/roles.md"],
      {
        sourceOfTruth: true,
        authority: "repo_files",
        mutable: "human_or_agent_edit"
      }
    ),
    boundaryLayer(
      "derived_indexes",
      "Derived Indexes",
      "Generated query and navigation indexes that must point back to raw events or durable sources.",
      [
        ".project-agent/memory-graph.json",
        ".project-agent/process-trace.json",
        ".project-agent/development-trail.json",
        ".project-agent/architecture-map.json",
        ".project-agent/continuity.json#phaseLedger",
        ".project-agent/continuity.json#checkpointLedger",
        ".project-agent/continuity.json#decisionLedger",
        ".project-agent/continuity.json#runtimeEval"
      ],
      {
        derived: true,
        authority: "generated_index",
        derivedFrom: [".project-agent/runtime.json", ".project-agent/state.json", "PROJECT.md", "AGENTS.md"],
        mutable: "regenerate"
      }
    ),
    boundaryLayer(
      "disclosure_outputs",
      "Disclosure Outputs",
      "Bounded handoff and prompt artifacts; useful for takeover but not the source of truth.",
      [
        ".project-agent/agent-context-bundle.json",
        ".project-agent/takeover-packet.json",
        ".project-agent/next-agent-prompt.md",
        ".project-agent/context-starter-prompt.md",
        ".project-agent/resume.md",
        ".project-agent/recovery.md",
        ".project-agent/continuity-audit.json",
        ".project-agent/takeover-acceptance-audit.json"
      ],
      {
        disclosure: true,
        authority: "bounded_handoff",
        derivedFrom: [".project-agent/continuity.json", ".project-agent/continuity-contract.json", ".project-agent/state-manifest.json"],
        mutable: "refresh_before_handoff"
      }
    )
  ];
  const derivedLayer = layers.find((layer) => layer.id === "derived_indexes");
  const disclosureLayer = layers.find((layer) => layer.id === "disclosure_outputs");
  const sourceLayers = layers.filter((layer) => layer.sourceOfTruth);
  const sourceRefs = sourceLayers.flatMap((layer) => layer.refs);
  const derivedRefs = derivedLayer?.refs || [];
  const disclosureRefs = disclosureLayer?.refs || [];
  const checks = [
    boundaryCheck(
      "raw_events_declared",
      "Raw Events Declared",
      hasRef(".project-agent/runtime.json") && (processTrace?.eventCount || hookIngressAudit?.acceptedEvents || hookIngressAudit?.recentAttempts?.length) ? "ok" : "warn",
      `${processTrace?.eventCount || 0} process event(s), ${hookIngressAudit?.acceptedEvents || 0} accepted hook event(s), ${(hookIngressAudit?.recentAttempts || []).length} ingress attempt(s).`,
      [".project-agent/runtime.json", "/api/events", "/api/hooks"]
    ),
    boundaryCheck(
      "durable_sources_declared",
      "Durable Sources Declared",
      hasRef(".project-agent/state.json") && hasRef("PROJECT.md") ? "ok" : "bad",
      "Durable state and project docs are listed separately from generated indexes.",
      [".project-agent/state.json", "PROJECT.md", "AGENTS.md"]
    ),
    boundaryCheck(
      "derived_indexes_marked",
      "Derived Indexes Marked",
      memoryGraph?.schemaVersion && processTrace?.schemaVersion && architectureTrace?.schemaVersion ? "ok" : "warn",
      `${derivedRefs.length} derived index ref(s) map back to raw events or durable sources.`,
      derivedRefs
    ),
    boundaryCheck(
      "disclosure_outputs_separate",
      "Disclosure Outputs Separate",
      disclosureRefs.every((ref) => !sourceRefs.includes(ref)) ? "ok" : "bad",
      `${disclosureRefs.length} handoff/prompt artifact(s) are marked as disclosure outputs, not source-of-truth files.`,
      disclosureRefs
    ),
    boundaryCheck(
      "lineage_links_present",
      "Lineage Links Present",
      derivedLayer?.derivedFrom?.length && disclosureLayer?.derivedFrom?.length ? "ok" : "bad",
      "Derived indexes and disclosure outputs declare upstream raw/durable sources.",
      [...(derivedLayer?.derivedFrom || []), ...(disclosureLayer?.derivedFrom || [])]
    ),
    boundaryCheck(
      "prompt_not_authority",
      "Prompt Not Authority",
      disclosureRefs.includes(".project-agent/next-agent-prompt.md") && !sourceRefs.includes(".project-agent/next-agent-prompt.md") ? "ok" : "bad",
      "Starter prompts and resume briefs are bounded disclosures; agents must verify source refs before trusting them.",
      [".project-agent/next-agent-prompt.md", ".project-agent/agent-context-bundle.json"]
    )
  ];
  const blockers = checks.filter((check) => check.status === "bad").map((check) => check.id);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.id);
  const status = blockers.length ? "blocked" : warnings.length ? "watch" : "separated";
  const lineage = [
    {
      id: "events_to_process",
      output: ".project-agent/process-trace.json",
      kind: "derived_index",
      derivedFrom: [".project-agent/runtime.json", "/api/events", "/api/hooks"],
      status: processTrace?.current ? "ok" : "warn"
    },
    {
      id: "sources_to_memory",
      output: ".project-agent/memory-graph.json",
      kind: "derived_index",
      derivedFrom: [".project-agent/state.json", ".project-agent/runtime.json", "PROJECT.md"],
      status: memoryGraph?.nodeCount || memoryGraph?.nodes?.length ? "ok" : "warn"
    },
    {
      id: "files_to_architecture",
      output: ".project-agent/architecture-map.json",
      kind: "derived_index",
      derivedFrom: ["PROJECT.md", "AGENTS.md", "src/**", "server/**", "docs/**"],
      status: architectureTrace?.totals?.files ? "ok" : "warn"
    },
    {
      id: "bundle_to_prompt",
      output: ".project-agent/next-agent-prompt.md",
      kind: "disclosure_output",
      derivedFrom: [".project-agent/agent-context-bundle.json", ".project-agent/continuity-contract.json"],
      status: "ok"
    }
  ];
  return {
    schemaVersion: "project-agent.state-boundary-audit.v1",
    status,
    summary:
      status === "separated"
        ? "State boundaries are explicit: raw events and durable sources are separated from derived indexes and disclosure outputs."
        : status === "watch"
          ? `State boundary is usable with ${warnings.length} warning(s); verify lineage before trusting generated indexes.`
          : `State boundary is blocked by ${blockers.length} failed separation check(s).`,
    layers,
    checks,
    lineage,
    totals: {
      layers: layers.length,
      sourceRefs: [...new Set(sourceRefs)].length,
      derivedIndexes: derivedRefs.length,
      disclosureOutputs: disclosureRefs.length,
      lineageLinks: lineage.length
    },
    sourceOfTruthRefs: [...new Set(sourceRefs)].slice(0, 14),
    derivedIndexRefs: derivedRefs,
    disclosureOutputRefs: disclosureRefs,
    warnings,
    blockers,
    refs: [".project-agent/continuity.json#stateBoundary", ".project-agent/continuity-contract.json", ".project-agent/agent-context-bundle.json", "docs/research/agent-governance-landscape.md"],
    nextAction:
      status === "separated"
        ? "Use raw_events and durable_sources for authority; treat derived_indexes and disclosure_outputs as navigational aids."
        : "Repair bad boundary checks before trusting generated handoff or index artifacts."
  };
}

function buildContinuityContract({
  project,
  role,
  goal,
  kernelSummary,
  governance,
  graphTrace,
  memoryGraph,
  processTrace,
  architectureTrace,
  takeoverReadiness,
  startProtocol,
  changedFiles,
  agentLeases,
  handoffSnapshot,
  stateRefs,
  interruptedWork,
  agentRunbook,
  handoffLifecycle,
  freshnessGate,
  phaseLedger,
  decisionLedger,
  checkpointLedger,
  runtimeEval,
  hookIngressAudit,
  stateBoundary,
  temporalProvenance
}) {
  const domains = governance?.domains || [];
  const badDomains = domains.filter((domain) => domain.status === "bad");
  const warnDomains = domains.filter((domain) => domain.status === "warn");
  const staleAgents = (agentLeases || []).filter((agent) => agent.effectiveStatus === "stale");
  const graphRefs = [
    ...(graphTrace?.coreNodes || []).flatMap((node) => node.refs || []),
    ...(graphTrace?.keyRelations || []).flatMap((edgeItem) => edgeItem.refs || [])
  ];
  const codeGraph = architectureTrace?.codeGraph || {};
  const status = badDomains.length || !takeoverReadiness?.canTakeOver ? "blocked" : warnDomains.length || staleAgents.length || interruptedWork?.count ? "ready_with_warnings" : "ready";
  const readFirst = startProtocol?.readFirst || [];
  const firstActions = startProtocol?.firstActions || [];
  const capabilityRows = [
    contractCapability(
      "memory_visible",
      "Memory Visible",
      graphTrace?.status === "traceable" && memoryGraph?.nodeCount ? "ok" : "warn",
      `${memoryGraph?.nodeCount || graphTrace?.nodeCount || 0} node(s), ${memoryGraph?.edgeCount || graphTrace?.edgeCount || 0} edge(s), provenance ${memoryGraph?.provenanceCoverage || graphTrace?.provenanceCoverage || "0/0"}.`,
      [".project-agent/memory-graph.json", ".project-agent/state.json", ...graphRefs]
    ),
    contractCapability(
      "process_identified",
      "Process Identified",
      processTrace?.current ? "ok" : "bad",
      processTrace?.current
        ? `${processTrace.current.phase}/${processTrace.current.status}: ${processTrace.current.title}; ${processTrace.eventCount || 0} event(s).`
        : "No current process cursor is available.",
      [".project-agent/process-trace.json", processTrace?.current?.id, ".project-agent/runtime.json"]
    ),
    contractCapability(
      "architecture_managed",
      "Architecture Managed",
      architectureTrace?.totals?.files ? (architectureTrace.totals.changed ? "ok" : "warn") : "bad",
      architectureTrace?.totals?.files
        ? `${architectureTrace.totals.files} file(s), ${architectureTrace.totals.changed || 0} changed, ${architectureTrace.topFolders?.length || 0} impacted folder(s).`
        : "No architecture trace is available.",
      [".project-agent/architecture-map.json", ...(architectureTrace?.topFolders || []).map((folder) => folder.latestFile), ...(changedFiles || []).map((file) => file.path)]
    ),
    contractCapability(
      "code_graph",
      "Code Graph",
      codeGraph?.nodeCount ? (codeGraph.localEdgeCount || codeGraph.packageEdgeCount ? "ok" : "warn") : "warn",
      codeGraph?.nodeCount
        ? `${codeGraph.nodeCount} code node(s), ${codeGraph.localEdgeCount || 0} local edge(s), ${codeGraph.packageEdgeCount || 0} package edge(s), ${codeGraph.changedImpact?.length || 0} changed impact row(s).`
        : "No code dependency graph is available.",
      [".project-agent/architecture-map.json", ...(codeGraph?.changedImpact || []).flatMap((item) => [item.path, ...(item.dependents || []), ...(item.dependencies || [])])]
    ),
    contractCapability(
      "agent_continuity",
      "Agent Continuity",
      takeoverReadiness?.canTakeOver ? (staleAgents.length || interruptedWork?.count ? "warn" : "ok") : "bad",
      interruptedWork?.count
        ? `${interruptedWork.count} stale current operation(s) need resolution.`
        : takeoverReadiness?.summary || "No takeover readiness summary is available.",
      [".project-agent/continuity-contract.json", ".project-agent/continuity.json", ".project-agent/resume.md", ".project-agent/recovery.md"]
    ),
    contractCapability(
      "phase_ledger",
      "Phase Ledger",
      phaseLedger?.status === "linked" ? "ok" : phaseLedger?.status === "missing" ? "bad" : "warn",
      phaseLedger?.summary || "No phase ledger is available.",
      phaseLedger?.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json"]
    ),
    contractCapability(
      "checkpoint_ledger",
      "Checkpoint Ledger",
      checkpointLedger?.status === "ready" ? "ok" : checkpointLedger?.status === "missing" || checkpointLedger?.status === "blocked" ? "bad" : "warn",
      checkpointLedger?.summary || "No checkpoint ledger is available.",
      checkpointLedger?.refs || [".project-agent/runtime.json", ".project-agent/process-trace.json", ".project-agent/continuity.json#checkpointLedger"]
    ),
    contractCapability(
      "decision_ledger",
      "Decision Ledger",
      decisionLedger?.status === "traceable" ? "ok" : decisionLedger?.status === "missing" || decisionLedger?.status === "blocked" ? "bad" : "warn",
      decisionLedger?.summary || "No temporal decision ledger is available.",
      decisionLedger?.refs || [".project-agent/state.json", ".project-agent/governance-spec.json", "docs/research/agent-governance-landscape.md"]
    ),
    contractCapability(
      "temporal_provenance",
      "Temporal Provenance",
      temporalProvenance?.status === "traceable" ? "ok" : temporalProvenance?.status === "missing" || temporalProvenance?.status === "blocked" ? "bad" : "warn",
      temporalProvenance?.summary || "No temporal provenance audit is available.",
      temporalProvenance?.refs || [".project-agent/continuity.json#temporalProvenance", ".project-agent/memory-graph.json", ".project-agent/continuity.json#decisionLedger"]
    ),
    contractCapability(
      "hook_ingress",
      "Hook Ingress",
      hookIngressAudit?.status === "clean" ? "ok" : hookIngressAudit?.status === "watch" ? "warn" : "warn",
      hookIngressAudit?.summary || "No hook ingress audit is available.",
      hookIngressAudit?.refs || ["/api/hooks", "/api/events", ".project-agent/runtime.json"]
    ),
    contractCapability(
      "state_boundary",
      "State Boundary",
      stateBoundary?.status === "separated" ? "ok" : stateBoundary?.status === "blocked" ? "bad" : "warn",
      stateBoundary?.summary || "No source/index/disclosure boundary audit is available.",
      stateBoundary?.refs || [".project-agent/continuity.json#stateBoundary", ".project-agent/agent-context-bundle.json"]
    )
  ];
  const core = {
    project,
    goalId: goal?.id || null,
    cursorId: processTrace?.current?.id || null,
    architectureStatus: architectureTrace?.status || null,
    graphStatus: graphTrace?.status || null,
    codeGraphStatus: codeGraph?.status || null,
    governanceStatus: governance?.status || null,
    changedFiles: (changedFiles || []).map((file) => file.path).slice(0, 12)
  };
  const inspectProcess = (processTrace?.inspectOrder || []).slice(0, 8).map((item) => ({
    type: item.type,
    id: item.id,
    phase: item.phase,
    status: item.status,
    title: item.title,
    refs: item.refs || []
  }));
  const inspectArchitecture = (architectureTrace?.inspectOrder || []).slice(0, 8).map((item) => ({
    type: item.type,
    path: item.path,
    status: item.status,
    reason: item.reason,
    refs: item.refs || []
  }));
  const inspectCodeGraph = (codeGraph?.inspectOrder || []).slice(0, 8).map((item) => ({
    type: item.type,
    path: item.path,
    status: item.status,
    reason: item.reason,
    refs: item.refs || []
  }));
  const inspectMemory = [
    ...(graphTrace?.coreNodes || []).slice(0, 6).map((node) => ({
      type: "node",
      id: node.id,
      label: node.label,
      status: node.status,
      refs: node.refs || []
    })),
    ...(graphTrace?.keyRelations || []).slice(0, 4).map((edgeItem) => ({
      type: "relation",
      id: `${edgeItem.source}->${edgeItem.target}`,
      label: `${edgeItem.source} -${edgeItem.label}-> ${edgeItem.target}`,
      status: "traceable",
      refs: edgeItem.refs || []
    }))
  ].slice(0, 10);

  return {
    schemaVersion: "project-agent.continuity-contract.v1",
    contractId: `contract_${stableHash(core)}`,
    project,
    role: role || "unknown",
    status,
    purpose: "Portable project memory, process, architecture, and takeover contract for any coding agent.",
    entrypoint: ".project-agent/continuity-contract.json",
    sourceOfTruth: {
      contextBundle: ".project-agent/agent-context-bundle.json",
      governanceSpec: ".project-agent/governance-spec.json",
      contract: ".project-agent/continuity-contract.json",
      runbook: ".project-agent/agent-runbook.json",
      memoryGraph: ".project-agent/memory-graph.json",
      processTrace: ".project-agent/process-trace.json",
      developmentTrail: ".project-agent/development-trail.json",
      phaseLedger: ".project-agent/continuity.json#phaseLedger",
      checkpointLedger: ".project-agent/continuity.json#checkpointLedger",
      decisionLedger: ".project-agent/continuity.json#decisionLedger",
      temporalProvenance: ".project-agent/continuity.json#temporalProvenance",
      stateBoundary: ".project-agent/continuity.json#stateBoundary",
      architectureMap: ".project-agent/architecture-map.json",
      codeGraph: ".project-agent/architecture-map.json#codeGraph",
      stateManifest: ".project-agent/state-manifest.json",
      takeoverPacket: ".project-agent/takeover-packet.json",
      continuityAudit: ".project-agent/continuity-audit.json",
      takeoverAcceptanceAudit: ".project-agent/takeover-acceptance-audit.json",
      fullState: ".project-agent/continuity.json",
      durableMemory: ".project-agent/state.json",
      liveRuntime: ".project-agent/runtime.json",
      humanBrief: ".project-agent/resume.md",
      recoveryBrief: ".project-agent/recovery.md",
      starterPrompt: ".project-agent/next-agent-prompt.md"
    },
    resume: {
      goalId: goal?.id || null,
      objective: goal?.objective || null,
      goalStatus: goal?.status || null,
      current: processTrace?.current || null,
      previous: processTrace?.previous || null,
      next: processTrace?.next || null,
      activeWorkstream: processTrace?.activeWorkstream || null,
      nextAction: processTrace?.nextAction || null
    },
    capabilities: capabilityRows,
    governance: {
      status: governance?.status || "unknown",
      summary: governance?.summary || "",
      warnings: warnDomains.map((domain) => domain.label),
      blockers: badDomains.map((domain) => domain.label)
    },
    readFirst: readFirst.slice(0, 9),
    firstActions: firstActions.slice(0, 6),
    agentRunbook: agentRunbook
      ? {
          entrypoint: ".project-agent/agent-runbook.json",
          status: agentRunbook.status,
          currentState: agentRunbook.currentState,
          nextState: agentRunbook.nextState,
          activeStepId: agentRunbook.activeStepId,
          nextCommand: agentRunbook.nextCommand,
          stepSummary: agentRunbook.stepSummary,
          stepIds: (agentRunbook.steps || []).map((step) => step.id).slice(0, 8)
        }
      : null,
    inspectOrder: {
      process: inspectProcess,
      architecture: inspectArchitecture,
      codeGraph: inspectCodeGraph,
      memory: inspectMemory
    },
    protectedFiles: (changedFiles || []).slice(0, 10).map((file) => ({
      path: file.path,
      status: file.status,
      summary: file.summary,
      hash: file.hash,
      reason: "Changed or recently touched; inspect before editing."
    })),
    agentState: {
      activeLeases: (agentLeases || []).filter((agent) => agent.effectiveStatus === "active").map((agent) => agent.id).slice(0, 8),
      staleLeases: staleAgents.map((agent) => agent.id).slice(0, 8),
      interruptedWork: interruptedWork || { status: "clear", count: 0, items: [] },
      handoffSnapshot: handoffSnapshot
        ? {
            status: handoffSnapshot.status,
            updatedAt: handoffSnapshot.updatedAt,
            reason: handoffSnapshot.reason,
            resumeFile: handoffSnapshot.resumeFile,
            recoveryFile: handoffSnapshot.recoveryFile
          }
        : null
    },
    handoffLifecycle: handoffLifecycle
      ? {
          schemaVersion: handoffLifecycle.schemaVersion,
          status: handoffLifecycle.status,
          summary: handoffLifecycle.summary,
          openedAt: handoffLifecycle.openedAt,
          acceptedAt: handoffLifecycle.acceptedAt,
          expiresAt: handoffLifecycle.expiresAt,
          nextAction: handoffLifecycle.nextAction
        }
      : null,
    freshnessGate: freshnessGate
      ? {
          schemaVersion: freshnessGate.schemaVersion,
          status: freshnessGate.status,
          summary: freshnessGate.summary,
          validity: freshnessGate.validity,
          staleChecks: freshnessGate.staleChecks,
          git: freshnessGate.git
            ? {
                schemaVersion: freshnessGate.git.schemaVersion,
                status: freshnessGate.git.status,
                summary: freshnessGate.git.summary,
                repo: freshnessGate.git.repo,
                dirty: freshnessGate.git.dirty,
                nextAction: freshnessGate.git.nextAction
              }
            : null,
          nextAction: freshnessGate.nextAction
        }
      : null,
    runtimeEval: runtimeEval
      ? {
          schemaVersion: runtimeEval.schemaVersion,
          status: runtimeEval.status,
          score: runtimeEval.score,
          quality: runtimeEval.quality,
          summary: runtimeEval.summary,
          trace: runtimeEval.trace,
          warnings: runtimeEval.warnings,
          blockers: runtimeEval.blockers,
          nextAction: runtimeEval.nextAction
        }
      : null,
    phaseLedger: phaseLedger
      ? {
          schemaVersion: phaseLedger.schemaVersion,
          status: phaseLedger.status,
          summary: phaseLedger.summary,
          spanCount: phaseLedger.spanCount,
          linkedCount: phaseLedger.linkedCount,
          runCount: phaseLedger.runCount,
          rootCount: phaseLedger.rootCount,
          danglingParents: phaseLedger.danglingParents,
          nextAction: phaseLedger.nextAction
        }
      : null,
    checkpointLedger: checkpointLedger
      ? {
          schemaVersion: checkpointLedger.schemaVersion,
          status: checkpointLedger.status,
          summary: checkpointLedger.summary,
          checkpointCount: checkpointLedger.checkpointCount,
          resumableCount: checkpointLedger.resumableCount,
          pendingCount: checkpointLedger.pendingCount,
          failedCount: checkpointLedger.failedCount,
          runCount: checkpointLedger.runCount,
          latestAt: checkpointLedger.latestAt,
          nextAction: checkpointLedger.nextAction
        }
      : null,
    decisionLedger: decisionLedger
      ? {
          schemaVersion: decisionLedger.schemaVersion,
          status: decisionLedger.status,
          summary: decisionLedger.summary,
          decisionCount: decisionLedger.decisionCount,
          validCount: decisionLedger.validCount,
          watchCount: decisionLedger.watchCount,
          invalidCount: decisionLedger.invalidCount,
          changedSourceCount: decisionLedger.changedSourceCount,
          nextAction: decisionLedger.nextAction
        }
      : null,
    temporalProvenance: temporalProvenance
      ? {
          schemaVersion: temporalProvenance.schemaVersion,
          status: temporalProvenance.status,
          summary: temporalProvenance.summary,
          factCount: temporalProvenance.factCount,
          validCount: temporalProvenance.validCount,
          watchCount: temporalProvenance.watchCount,
          staleCount: temporalProvenance.staleCount,
          invalidCount: temporalProvenance.invalidCount,
          contradictionCount: temporalProvenance.contradictionCount,
          nextAction: temporalProvenance.nextAction
        }
      : null,
    hookIngressAudit: hookIngressAudit
      ? {
          schemaVersion: hookIngressAudit.schemaVersion,
          status: hookIngressAudit.status,
	          summary: hookIngressAudit.summary,
	          acceptedEvents: hookIngressAudit.acceptedEvents,
	          rejectedEvents: hookIngressAudit.rejectedEvents,
	          saturatedAttempts: hookIngressAudit.saturatedAttempts,
	          backpressure: hookIngressAudit.backpressure,
	          sanitizedEvents: hookIngressAudit.sanitizedEvents,
          unknownTypeEvents: hookIngressAudit.unknownTypeEvents,
          latestAt: hookIngressAudit.latestAt,
          nextAction: hookIngressAudit.nextAction
        }
      : null,
    stateBoundary: stateBoundary
      ? {
          schemaVersion: stateBoundary.schemaVersion,
          status: stateBoundary.status,
          summary: stateBoundary.summary,
          totals: stateBoundary.totals,
          sourceOfTruthRefs: stateBoundary.sourceOfTruthRefs,
          derivedIndexRefs: stateBoundary.derivedIndexRefs,
          disclosureOutputRefs: stateBoundary.disclosureOutputRefs,
          warnings: stateBoundary.warnings,
          blockers: stateBoundary.blockers,
          nextAction: stateBoundary.nextAction
        }
      : null,
    proofChecklist: [
      {
        id: "contract_read",
        statement: "Read this contract before using chat history.",
        refs: [".project-agent/continuity-contract.json"]
      },
      {
        id: "resume_cursor",
        statement: "Resume from contract.resume.current and record the next runtime event.",
        refs: [processTrace?.current?.id, "/api/events", "npm run event"].filter(Boolean)
      },
      {
        id: "resolve_interrupted",
        statement: "If agentState.interruptedWork has items, resolve them before unrelated edits.",
        refs: (interruptedWork?.items || []).map((item) => item.id).slice(0, 5)
      },
      {
        id: "inspect_architecture",
        statement: "Inspect protectedFiles and inspectOrder.architecture before editing.",
        refs: (changedFiles || []).slice(0, 5).map((file) => file.path)
      },
      {
        id: "verify_completion",
        statement: "Do not claim completion without acceptance evidence and audit.",
        refs: ["acceptanceCriteria", "evidence", "audit"]
      },
      {
        id: "handoff_refresh",
        statement: "Refresh resume/recovery or trigger handoff snapshot before stopping.",
        refs: [".project-agent/resume.md", ".project-agent/recovery.md"]
      },
      {
        id: "state_boundary",
        statement: "Treat raw events and durable sources as authority; treat indexes and prompts as derived/disclosure.",
        refs: [".project-agent/continuity.json#stateBoundary", ".project-agent/runtime.json", ".project-agent/state.json"]
      },
      {
        id: "temporal_provenance",
        statement: "Verify temporal facts against source refs, hashes, and validity windows before trusting memory or decisions.",
        refs: [".project-agent/continuity.json#temporalProvenance", ".project-agent/memory-graph.json", ".project-agent/continuity.json#decisionLedger"]
      }
    ],
    handoffRules: governance?.operatingContract || [],
    stateRefs: [...new Set([".project-agent/agent-context-bundle.json", ".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", ".project-agent/agent-runbook.json", ".project-agent/memory-graph.json", ".project-agent/process-trace.json", ".project-agent/architecture-map.json", ".project-agent/state-manifest.json", ".project-agent/takeover-packet.json", ".project-agent/continuity-audit.json", ".project-agent/next-agent-prompt.md", ".project-agent/continuity.json#temporalProvenance", ".project-agent/continuity.json#stateBoundary", ...(stateRefs || [])])]
  };
}

function coverageRow(id, label, status, evidence = [], nextAction = "") {
  return {
    id,
    label,
    status,
    evidence: evidence.filter(Boolean).slice(0, 10),
    nextAction
  };
}

function buildObjectiveCoverage({ goal, governanceSpec, memoryGraph, processTrace, architectureMap, agentRunbook, continuityAudit, agentContextBundle }) {
  const requirements = (governanceSpec?.requirements || []).map((item) =>
    coverageRow(
      item.id,
      item.statement,
      item.status,
      item.evidence || [],
      item.status === "ok" ? "Keep evidence fresh as files and process events change." : item.acceptance || "Restore the missing proof source before claiming coverage."
    )
  );
  const acceptance = (goal?.acceptanceCriteria || []).map((criterion) =>
    coverageRow(
      criterion.id,
      criterion.statement,
      criterion.verified ? "ok" : "warn",
      criterion.verifiedBy || [],
      criterion.verified ? "Verified by saved evidence." : "Save command or review evidence against this acceptance criterion."
    )
  );
  const proofSources = [
    coverageRow(
      "bundle_verification",
      "Single-file context bundle proves cold-start takeover readiness.",
      agentContextBundle?.validation?.agentContextBundleVerification?.canResume ? "ok" : agentContextBundle ? "bad" : "warn",
      [".project-agent/agent-context-bundle.json", ".project-agent/context-starter-prompt.md"],
      "Run npm run context -- --project-dir \"$PROJECT_DIR\" --verify before takeover."
    ),
    coverageRow(
      "durable_memory",
      "Memory graph is durable and visible.",
      memoryGraph?.nodes?.length && memoryGraph?.edges?.length ? "ok" : "bad",
      [".project-agent/memory-graph.json"],
      "Regenerate insights until memory graph nodes and edges are present."
    ),
    coverageRow(
      "dynamic_process",
      "Process trace exposes previous/current/next.",
      processTrace?.previous && processTrace?.current && processTrace?.next ? "ok" : processTrace?.current ? "warn" : "bad",
      [".project-agent/process-trace.json", ".project-agent/runtime.json"],
      "Record current/done events so previous/current/next can be reconstructed."
    ),
    coverageRow(
      "managed_architecture",
      "Architecture map exposes tree, files, changed folders, and inspect order.",
      architectureMap?.tree?.length && architectureMap?.files?.length ? "ok" : "bad",
      [".project-agent/architecture-map.json"],
      "Run architecture scan and inspect changed files before editing."
    ),
    coverageRow(
      "executable_runbook",
      "Agent runbook exposes the next executable action.",
      agentRunbook?.nextCommand ? "ok" : "bad",
      [".project-agent/agent-runbook.json"],
      "Refresh continuity so nextCommand and activeStepId are present."
    ),
    coverageRow(
      "handoff_audit",
      "Continuity audit can resume or lists precise blockers.",
      continuityAudit?.canResume ? (continuityAudit.status === "warn" ? "warn" : "ok") : continuityAudit ? "bad" : "warn",
      [".project-agent/continuity-audit.json"],
      "Run continuity audit and restore any bad handoff artifacts."
    )
  ];
  const rows = [...requirements, ...acceptance, ...proofSources];
  const bad = rows.filter((row) => row.status === "bad");
  const warn = rows.filter((row) => row.status === "warn");
  const ok = rows.filter((row) => row.status === "ok");
  return {
    schemaVersion: "project-agent.objective-coverage.v1",
    status: bad.length ? "blocked" : warn.length ? "watch" : "covered",
    score: `${ok.length}/${rows.length}`,
    summary: bad.length
      ? `${bad.length} objective coverage item(s) are blocked.`
      : warn.length
        ? `${warn.length} objective coverage item(s) need watching.`
        : "Objective coverage is fully backed by durable evidence.",
    requirements,
    acceptance,
    proofSources,
    blockers: bad.map((row) => row.id),
    warnings: warn.map((row) => row.id)
  };
}

function buildContinuity({ projectDir = "", summary, packet, currentStep, process, architecture, handoff, agentLeases = [], handoffSnapshot = null, knowledgeGraph = null }) {
  const goal = summary.activeGoal;
  const kernelSummary = buildKernelSummary(packet);
  const changedFiles = latestUniqueChanges(architecture?.recentChanges, 12).map((item) => ({
    path: item.path,
    status: item.status,
    kind: item.kind,
    modifiedAt: item.modifiedAt,
    hash: item.hash,
    previousHash: item.previousHash,
    additions: item.additions || 0,
    deletions: item.deletions || 0,
    lineCount: item.lineCount,
    previousLineCount: item.previousLineCount,
    summary: item.summary
  }));
  const openTargets = (goal?.acceptanceCriteria || [])
    .filter((criterion) => !evidenceVerifies(summary.evidence || [], criterion.id))
    .map((criterion) => ({ id: criterion.id, statement: criterion.statement }));
  const stateRefs = [
    ".project-agent/agent-context-bundle.json",
    ".project-agent/governance-spec.json",
    ".project-agent/continuity-contract.json",
    ".project-agent/agent-runbook.json",
    ".project-agent/memory-graph.json",
    ".project-agent/process-trace.json",
    ".project-agent/development-trail.json",
    ".project-agent/architecture-map.json",
    ".project-agent/state-manifest.json",
    ".project-agent/takeover-packet.json",
    ".project-agent/continuity-audit.json",
    ".project-agent/takeover-acceptance-audit.json",
    ".project-agent/next-agent-prompt.md",
    ".project-agent/continuity.json",
    ".project-agent/continuity.json#temporalProvenance",
    ".project-agent/continuity.json#stateBoundary",
    ".project-agent/resume.md",
    ".project-agent/recovery.md",
    ".project-agent/state.json",
    ".project-agent/runtime.json",
    "AGENTS.md",
    "PROJECT.md",
    "docs/architecture/principles.md",
    "docs/agents/roles.md"
  ];
  const interruptedWork = buildInterruptedWork({ process, agentLeases });
  const takeoverReadiness = buildTakeoverReadiness({
    goal,
    currentStep,
    kernelSummary,
    process,
    changedFiles,
    architecture,
    agentLeases,
    handoffSnapshot,
    stateRefs,
    interruptedWork
  });
  const startProtocol = buildStartProtocol({ takeoverReadiness, goal, process, changedFiles, architecture, stateRefs, interruptedWork });
  const graphTrace = buildGraphTrace(knowledgeGraph);
  const memoryGraph = buildMemoryGraphSnapshot(knowledgeGraph, graphTrace);
  const architectureTrace = buildArchitectureTrace(architecture, changedFiles);
  const processTrace = buildProcessTrace(process);
  const developmentTrail = buildDevelopmentTrail({ processTrace, architectureTrace, changedFiles });
  const preEditRisk = buildPreEditRisk({ changedFiles, architectureTrace, developmentTrail, interruptedWork, takeoverReadiness, openTargets });
  const handoffLifecycle = buildHandoffLifecycle({ goal, handoff, handoffSnapshot, takeoverReadiness, interruptedWork, agentLeases, preEditRisk });
  const freshnessGate = buildFreshnessGate({ projectDir: projectDir || architecture?.projectDir || "", processTrace, architectureTrace, handoffLifecycle, handoffSnapshot, preEditRisk, agentLeases, interruptedWork });
  const phaseLedger = buildPhaseLedger(processTrace);
  const runtimeEval = buildRuntimeEval({ processTrace, phaseLedger, developmentTrail, freshnessGate, preEditRisk, interruptedWork, openTargets, changedFiles });
  const checkpointLedger = buildCheckpointLedger({ processTrace, phaseLedger, runtimeEval, developmentTrail, preEditRisk, openTargets });
  const hookIngressAudit = buildHookIngressAudit(process);
  const architectureMap = buildArchitectureMapSnapshot(architecture, architectureTrace);
  const codeGraph = architectureTrace.codeGraph || architectureMap.codeGraph || architecture?.codeGraph || null;
  const governance = buildGovernanceMatrix({
    kernelSummary,
    process,
    processTrace,
    changedFiles,
    architecture,
    architectureTrace,
    agentLeases,
    handoffSnapshot,
    takeoverReadiness,
    startProtocol,
    stateRefs,
    knowledgeGraph
  });
  const agentRunbook = buildAgentRunbook({
    goal,
    processTrace,
    architectureTrace,
    graphTrace,
    memoryGraph,
    takeoverReadiness,
    startProtocol,
    interruptedWork,
    changedFiles,
    stateRefs
  });
  const decisionLedger = buildDecisionLedger({ summary, governance, processTrace, architectureTrace, changedFiles, stateRefs });
  const temporalProvenance = buildTemporalProvenanceAudit({
    memoryGraph,
    graphTrace,
    decisionLedger,
    processTrace,
    architectureTrace,
    freshnessGate,
    changedFiles,
    stateRefs
  });
  const stateBoundary = buildStateBoundary({
    stateRefs,
    processTrace,
    memoryGraph,
    architectureTrace,
    decisionLedger,
    checkpointLedger,
    phaseLedger,
    runtimeEval,
    hookIngressAudit
  });
  const continuityContract = buildContinuityContract({
    project: summary.project,
    role: packet?.role,
    goal,
    kernelSummary,
    governance,
    graphTrace,
    memoryGraph,
    processTrace,
    architectureTrace,
    takeoverReadiness,
    startProtocol,
    changedFiles,
    agentLeases,
    handoffSnapshot,
    stateRefs,
    interruptedWork,
    agentRunbook,
    handoffLifecycle,
    freshnessGate,
    phaseLedger,
    decisionLedger,
    checkpointLedger,
    runtimeEval,
    hookIngressAudit,
    stateBoundary,
    temporalProvenance
  });
  const governanceSpec = buildGovernanceSpec({
    goal,
    governance,
    memoryGraph,
    processTrace,
    architectureMap,
    agentRunbook,
    continuityContract,
    takeoverReadiness
  });
  const objectiveCoverage = buildObjectiveCoverage({
    goal,
    governanceSpec,
    memoryGraph,
    processTrace,
    architectureMap,
    agentRunbook,
    continuityAudit: null,
    agentContextBundle: null
  });
  return {
    project: summary.project,
    role: packet?.role,
    activeGoal: goal
      ? {
          id: goal.id,
          objective: goal.objective,
          status: goal.status,
          acceptanceCriteria: goal.acceptanceCriteria || []
        }
      : null,
    currentStep,
    kernelSummary,
    workstream: process.workstream,
    workstreams: process.workstreams,
    processCursor: process.current,
    previousEvent: process.previous,
    nextEvent: process.next,
    recentEvents: (process.events || []).slice(0, 12),
    openTargets,
    changedFiles,
    architectureImpact: architecture?.impact || { folders: [], topFolders: [], totals: {} },
    graphTrace,
    memoryGraph,
    architectureTrace,
    codeGraph,
    developmentTrail,
    preEditRisk,
    handoffLifecycle,
    freshnessGate,
    phaseLedger,
    checkpointLedger,
    decisionLedger,
    temporalProvenance,
    stateBoundary,
    runtimeEval,
    hookIngressAudit,
    architectureMap,
    processTrace,
    interruptedWork,
    agentRunbook,
    agentLeases: agentLeases.slice(0, 8),
    handoffSnapshot,
    architectureTotals: architecture?.totals || {},
    handoffId: handoff?.id || null,
    takeoverReadiness,
    governanceSpec,
    objectiveCoverage,
    governance,
    startProtocol,
    continuityContract,
    stateRefs,
    nextAgentInstructions: [
      "Start with .project-agent/continuity-contract.json; it is the agent-neutral takeover contract.",
      "Read .project-agent/governance-spec.json to understand the product-level requirements before editing.",
      "Read .project-agent/agent-runbook.json for executable takeover steps, commands, and proof gates.",
      "Follow startProtocol.readFirst and startProtocol.firstActions before editing.",
      "Read .project-agent/continuity.json after the runbook, then .project-agent/resume.md or .project-agent/recovery.md, then .project-agent/state.json.",
      "Check agentLeases; stale active agents may indicate a crashed prior session.",
      "Check handoffSnapshot; a recent done snapshot means resume.md and recovery.md are current.",
      "Check handoffLifecycle; accepted means a new agent may resume, open means refresh/check first, expired means do not trust the handoff.",
      "Check freshnessGate; fresh means timestamps are valid, watch means refresh the cited artifact, stale/expired means rebuild state before editing.",
      "Inspect phaseLedger before replaying tool work; linked means parent/child spans and run groups are available, flat means record parentId/runId first.",
      "Inspect checkpointLedger before resuming or retrying work; it lists resumable checkpoints, pending writes, failed gates, and artifact refs.",
      "Inspect decisionLedger before trusting project rules or product strategy; watch/invalid decisions must be rechecked against source refs.",
      "Inspect temporalProvenance before trusting memory or decisions; it lists fact validity windows, source hashes, stale sources, and contradictions.",
      "Inspect stateBoundary before trusting generated indexes or prompts; raw events and durable sources outrank derived/disclosure artifacts.",
      "Inspect runtimeEval before claiming completion; it scores spans, phase coverage, provenance, evidence, and active errors.",
      "Inspect hookIngressAudit before trusting external hook events; it records sanitized ingress, type normalization, and redactions.",
      "Inspect processTrace.inspectOrder before editing; it lists the event order and file refs a new agent should review.",
      "Inspect developmentTrail before editing; it links process steps to files, folders, and takeover risk.",
      "Inspect preEditRisk before editing; it summarizes changed files, impacted folders, test gaps, and interrupted work.",
      "Inspect codeGraph before editing imported files; changedImpact lists dependents and dependencies that should be reviewed first.",
      "Inspect takeoverAcceptanceAudit before claiming the user objective is satisfied.",
      "Inspect processCursor and previousEvent before taking action.",
      "Inspect architectureTrace.inspectOrder before editing; it lists the folder/file order a new agent should review.",
      "Inspect architectureImpact.topFolders before editing; these folders changed most recently or carry higher architectural priority.",
      "Check changedFiles before editing so half-finished work is not overwritten.",
      "Use acceptance criteria and evidence links before claiming completion."
    ]
  };
}

export async function buildInsights({
  projectDir = "",
  rawState,
  summary,
  packet,
  architecture,
  runtimeEvents = [],
  hookIngresses = [],
  agentLeases = [],
  handoffSnapshot = null,
  terminalSnapshot,
  agentmemoryUrl,
  agentmemorySecret
}) {
  const goal = summary.activeGoal;
  const goalId = goal?.id;
  const handoff = latestHandoffForGoal(rawState, goalId);
  const localMemory = latestMemoryForGoal(rawState, goalId);
  const audit = handoff?.audit || null;
  const hasKernel = Boolean(packet?.kernel);
  const hasGoal = Boolean(goal);
  const hasEvidence = (summary.evidence || []).length > 0;
  const hasCode = (summary.actions || []).length > 0 || hasEvidence;
  const auditPassed = Boolean(audit?.canComplete || goal?.status === "complete");
  const hasHandoff = Boolean(handoff);
  const hasMemory = Boolean(localMemory || (rawState?.memories || []).length);
  const visibleRuntimeEvents = (runtimeEvents || []).filter((event) => !isInternalGeneratedEvent(event));
  const agentmemoryGraph = await fetchAgentMemoryGraph({
    agentmemoryUrl,
    agentmemorySecret,
    query: goal?.objective || summary.project || rawState?.project || "project-agent"
  });

  const graphNodes = [
    node("kernel", "Kernel", hasKernel ? "done" : "pending", hasKernel ? "docs" : "missing", ["PROJECT.md", "docs/**"]),
    node("goal", "Goal", hasGoal ? goal.status : "pending", hasGoal ? goal.status : "none", goal ? [goal.id] : []),
    node(
      "code",
      "Code",
      hasCode ? "done" : "pending",
      (summary.actions || []).length ? `${summary.actions.length} step(s)` : `${summary.evidence?.length || 0} proof`,
      [...(summary.actions || []).map((item) => item.id), ...(summary.evidence || []).map((item) => item.id)]
    ),
    node("memory", "Memory", hasMemory ? "done" : "pending", `${(rawState?.memories || []).length} item(s)`, (rawState?.memories || []).map((item) => item.id)),
    node("evidence", "Evidence", hasEvidence ? "done" : "pending", `${summary.evidence?.length || 0} item(s)`, (summary.evidence || []).map((item) => item.id)),
    node("audit", "Audit", auditPassed ? "done" : audit ? "active" : "pending", auditPassed ? "pass" : audit ? "missing" : "not run", goal ? [goal.id] : []),
    node("handoff", "Handoff", hasHandoff ? "done" : goal?.status === "complete" ? "active" : "pending", hasHandoff ? "ready" : "waiting", handoff ? [handoff.id] : [])
  ];

  const graphEdges = [
    edge("kernel", "goal", "frames", ["PROJECT.md"]),
    edge("goal", "code", "drives", goal ? [goal.id] : []),
    edge("goal", "memory", "scopes", goal ? [goal.id] : []),
    edge("code", "evidence", "produces", (summary.evidence || []).map((item) => item.id)),
    edge("memory", "evidence", "grounds", (summary.evidence || []).map((item) => item.id)),
    edge("evidence", "audit", "verifies", (summary.evidence || []).map((item) => item.id)),
    edge("audit", "handoff", "permits", handoff ? [handoff.id] : [])
  ];

  if (agentmemoryGraph?.available && agentmemoryGraph.nodes.length) {
    graphNodes.push({
      id: "agentmemory",
      label: "AgentMemory",
      status: "done",
      tone: "ok",
      meta: `${agentmemoryGraph.nodes.length} node(s)`,
      provenance: agentmemoryGraph.nodes.slice(0, 5).map((item) => item.id),
      x: 318,
      y: 236
    });
    graphEdges.push(edge("memory", "agentmemory", "syncs", agentmemoryGraph.nodes.slice(0, 5).map((item) => item.id)));
  }

  const hasCommand = Boolean(
    terminalSnapshot?.currentCommand ||
      terminalSnapshot?.lastCommand ||
      hasEvidence ||
      (summary.actions || []).some((item) => item.status === "done")
  );
  const auditDetail = audit ? `${audit.passed?.length || 0} pass / ${audit.missing?.length || 0} missing` : auditPassed ? "pass" : "not run";
  const flow = [
    {
      id: "observe",
      label: "Observe",
      detail: summary.initialized ? "kernel loaded" : "load memory",
      status: summary.initialized ? "done" : "current",
      workstream: workstreamMeta("discussion"),
      provenance: hasKernel ? ["PROJECT.md", "docs/**"] : []
    },
    {
      id: "plan",
      label: "Plan",
      detail: hasGoal ? goal.objective : "set objective",
      status: hasGoal ? "done" : summary.initialized ? "current" : "pending",
      workstream: workstreamMeta("strategy"),
      provenance: goal ? [goal.id] : []
    },
    {
      id: "execute",
      label: "Execute",
      detail: terminalSnapshot?.currentCommand?.command || terminalSnapshot?.lastCommand?.command || "run command",
      status: hasCommand ? "done" : hasGoal ? "current" : "pending",
      workstream: workstreamMeta("implementation"),
      provenance: [...(summary.actions || []).map((item) => item.id), ...(summary.evidence || []).map((item) => item.id)]
    },
    {
      id: "evidence",
      label: "Evidence",
      detail: `${summary.evidence?.length || 0} saved`,
      status: hasEvidence ? "done" : hasCommand ? "current" : "pending",
      workstream: workstreamMeta("governance"),
      provenance: (summary.evidence || []).map((item) => item.id)
    },
    {
      id: "audit",
      label: "Audit",
      detail: auditDetail,
      status: auditPassed ? "done" : hasEvidence ? "current" : "pending",
      workstream: workstreamMeta("qa_testing"),
      provenance: goal ? [goal.id] : []
    },
    {
      id: "handoff",
      label: "Handoff",
      detail: hasHandoff ? "packet ready" : "waiting",
      status: hasHandoff ? "done" : auditPassed ? "current" : "pending",
      workstream: workstreamMeta("governance"),
      provenance: handoff ? [handoff.id] : []
    }
  ];

  const kernelSummary = buildKernelSummary(packet);
  const knowledgeGraph = buildKnowledgeGraph({ rawState, summary, packet, architecture, runtimeEvents: visibleRuntimeEvents, handoff, agentmemoryGraph });
  const process = buildProcessTrail({ flow, runtimeEvents: visibleRuntimeEvents, hookIngresses, terminalSnapshot, architecture });
  const current = buildEventCurrentStep(buildCurrentStep({ summary, audit, handoff, terminalSnapshot }), process);
  const continuity = buildContinuity({
    projectDir: projectDir || architecture?.projectDir || "",
    summary,
    packet,
    currentStep: current,
    process,
    architecture,
    handoff,
    agentLeases,
    handoffSnapshot,
    knowledgeGraph
  });
  return {
    generatedAt: new Date().toISOString(),
    currentStep: current,
    targets: buildTargets(summary),
    kernelSummary,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
      readyCount: graphNodes.filter((item) => item.status !== "pending").length,
      totalCount: graphNodes.length,
      source: agentmemoryGraph?.available ? "project-agent+agentmemory" : "project-agent"
    },
    knowledgeGraph,
    flow,
    process,
    architecture,
    graphTrace: continuity.graphTrace,
    processTrace: continuity.processTrace,
    architectureTrace: continuity.architectureTrace,
    governance: continuity.governance,
    continuityContract: continuity.continuityContract,
    continuity,
    memory: {
      localCount: (rawState?.memories || []).length,
      latest: localMemory,
      agentmemory: agentmemoryGraph
        ? {
            available: agentmemoryGraph.available,
            nodes: agentmemoryGraph.nodes.length,
            edges: agentmemoryGraph.edges.length,
            reason: agentmemoryGraph.reason
          }
        : { available: false, nodes: 0, edges: 0, reason: "AGENTMEMORY_URL not set" }
    },
    provenance: {
      sourceOfTruth: ".project-agent/state.json",
      kernel: hasKernel ? "project docs via project_agent.py kernel" : "not loaded",
      terminal: terminalSnapshot?.backend || "unknown"
    }
  };
}
