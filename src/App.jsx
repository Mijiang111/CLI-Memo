import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Bot,
  Brain,
  BookOpen,
  CheckCircle2,
  Circle,
  CircleDot,
  ClipboardList,
  Code2,
  Command,
  Database,
  Eye,
  FileCheck2,
  FileText,
  GitBranch,
  Goal,
  History,
  Network,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  XCircle
} from "lucide-react";

const API = "/api";
const roles = ["coding_agent", "qa_agent", "architect", "product_strategist", "project_governor"];
const adoptedArchitecturePatterns = [
  {
    id: "tiered-disclosure",
    source: "axiomhq/agent-memory",
    pattern: "journal queue plus top-of-mind index note",
    product: "active goal, live cursor, architecture map, then concise handoff bundle",
    refs: [".project-agent/agent-context-bundle.json", ".project-agent/memory-graph.json"]
  },
  {
    id: "freshness-gate",
    source: "ravbyte-ai/agent-memory-system",
    pattern: "worklog plus freshness gate",
    product: "state manifest, acceptance audit, takeover packet",
    refs: [".project-agent/state-manifest.json", ".project-agent/takeover-acceptance-audit.json"]
  },
  {
    id: "source-ledger",
    source: "akitaonrails/ai-memory",
    pattern: "hook router, sanitizer, 429 backpressure, source/index split",
    product: "runtime log, hook pressure audit, durable state files, agent-neutral bundle",
    refs: [".project-agent/runtime.json", ".project-agent/continuity.json", "/api/hooks"]
  },
  {
    id: "temporal-provenance",
    source: "getzep/graphiti",
    pattern: "temporal context graph",
    product: "previous / current / next trace with provenance",
    refs: [".project-agent/process-trace.json", ".project-agent/memory-graph.json"]
  },
  {
    id: "code-intelligence",
    source: "repowise-dev/repowise",
    pattern: "multi-layer repo intelligence",
    product: "architecture, code graph, development trail, changed files, proof",
    refs: [".project-agent/architecture-map.json", ".project-agent/development-trail.json"]
  },
  {
    id: "shared-map",
    source: "CodeBoarding/CodeBoarding",
    pattern: "visual architecture as shared model",
    product: "Project map with process, memory, architecture, and dependency graph views",
    refs: [".project-agent/architecture-map.json"]
  },
  {
    id: "prompt-budget",
    source: "repomix / gitingest",
    pattern: "safe prompt packing and token accounting",
    product: "token, file, and byte bounded resume bundle with omitted refs",
    refs: [".project-agent/next-agent-prompt.md", ".project-agent/agent-context-bundle.json"]
  },
  {
    id: "checkpoint-ledger",
    source: "AgentOps / Phoenix / LangGraph",
    pattern: "spans, evals, durable checkpoints",
    product: "checkpoint ledger with resumable points, pending writes, failed gates, and artifact refs",
    refs: [".project-agent/continuity.json", ".project-agent/process-trace.json"]
  }
];

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json();
}

function statusTone(status) {
  if (["complete", "done", "passed"].includes(status)) return "ok";
  if (["blocked", "failed"].includes(status)) return "bad";
  if (["active", "pending"].includes(status)) return "warn";
  return "muted";
}

function drillTone(status) {
  if (status === "pass") return "ok";
  if (status === "fail") return "bad";
  if (status === "warn") return "warn";
  return "muted";
}

function gateTone(status) {
  if (["ok", "pass", "passed"].includes(status)) return "ok";
  if (["bad", "fail", "failed", "blocked"].includes(status)) return "bad";
  if (["warn", "watch"].includes(status)) return "warn";
  return "muted";
}

function riskTone(status) {
  if (["blocked", "high", "bad"].includes(status)) return "bad";
  if (["medium", "warn", "watch"].includes(status)) return "warn";
  if (["low", "ok", "ready"].includes(status)) return "ok";
  return "muted";
}

function lifecycleTone(status) {
  if (status === "accepted") return "ok";
  if (status === "open") return "warn";
  if (["expired", "cancelled"].includes(status)) return "bad";
  return "muted";
}

function freshnessTone(status) {
  if (["fresh", "ok"].includes(status)) return "ok";
  if (["watch", "stale", "warn"].includes(status)) return "warn";
  if (["expired", "bad", "blocked"].includes(status)) return "bad";
  return "muted";
}

function evalTone(status) {
  if (["pass", "ok"].includes(status)) return "ok";
  if (["watch", "warn"].includes(status)) return "warn";
  if (["fail", "bad", "blocked"].includes(status)) return "bad";
  return "muted";
}

function phaseTone(status) {
  if (["linked", "ok"].includes(status)) return "ok";
  if (["flat", "watch", "warn"].includes(status)) return "warn";
  if (["missing", "bad", "blocked"].includes(status)) return "bad";
  return "muted";
}

function checkpointTone(status) {
  if (["ready", "ok"].includes(status)) return "ok";
  if (["watch", "pending", "warn"].includes(status)) return "warn";
  if (["blocked", "missing", "bad"].includes(status)) return "bad";
  return "muted";
}

function hookTone(status) {
  if (["clean", "ok"].includes(status)) return "ok";
  if (["watch", "idle", "warn"].includes(status)) return "warn";
  if (["blocked", "bad"].includes(status)) return "bad";
  return "muted";
}

function provenanceTone(status) {
  if (["traceable", "ok"].includes(status)) return "ok";
  if (["watch", "warn"].includes(status)) return "warn";
  if (["blocked", "bad"].includes(status)) return "bad";
  return "muted";
}

function boundaryTone(status) {
  if (["separated", "ok"].includes(status)) return "ok";
  if (["watch", "warn"].includes(status)) return "warn";
  if (["blocked", "bad"].includes(status)) return "bad";
  return "muted";
}

function decisionTone(status) {
  if (["traceable", "valid", "ok"].includes(status)) return "ok";
  if (["watch", "warn"].includes(status)) return "warn";
  if (["blocked", "invalid", "missing", "bad"].includes(status)) return "bad";
  return "muted";
}

function codeGraphTone(status) {
  if (["linked", "external", "ok"].includes(status)) return "ok";
  if (["flat", "watch", "warn"].includes(status)) return "warn";
  if (["missing", "bad", "blocked"].includes(status)) return "bad";
  return "muted";
}

function attentionTone(status) {
  if (["ready", "ok"].includes(status)) return "ok";
  if (["watch", "over_budget", "warn"].includes(status)) return "warn";
  if (["blocked", "bad"].includes(status)) return "bad";
  return "muted";
}

function Pill({ children, tone = "muted" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function fileName(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || path;
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}mb`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}kb`;
  return `${bytes}b`;
}

function StateSourceStrip({ title = "Source of Truth", items = [] }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return (
    <section className="insight-section state-source-section">
      <div className="insight-heading">
        <span>{title}</span>
        <Pill tone="ok">durable</Pill>
      </div>
      <div className="state-source-grid">
        {visible.map((item, index) => (
          <div key={`${item.path}-${index}`} className={`state-source-card ${item.tone || "ok"}`}>
            <FileCheck2 size={13} />
            <div>
              <strong title={item.path}>{fileName(item.path)}</strong>
              <span>{item.metric || item.schema || "ready"}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IconButton({ icon: Icon, children, onClick, disabled, tone = "neutral", title }) {
  return (
    <button className={`icon-button ${tone}`} onClick={onClick} disabled={disabled} title={title || children}>
      {Icon ? <Icon size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

function Empty({ title, body }) {
  return (
    <div className="empty">
      <Sparkles size={18} />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function cleanLabel(value, fallback = "Unknown") {
  return String(value || fallback).replace(/[_-]+/g, " ");
}

function shortText(value, max = 96) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function InsightCard({ icon: Icon, label, value, detail, tone = "muted" }) {
  return (
    <div className={`insight-card ${tone}`}>
      <div>
        {Icon ? <Icon size={16} /> : null}
        <span>{label}</span>
      </div>
      <strong title={value}>{value}</strong>
      {detail ? <small title={detail}>{detail}</small> : null}
    </div>
  );
}

function DetailDisclosure({ title, meta, children, defaultOpen = false }) {
  if (!children) return null;
  return (
    <details className="detail-disclosure" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {meta ? <em>{meta}</em> : null}
      </summary>
      <div className="detail-disclosure-body">{children}</div>
    </details>
  );
}

function TerminalPane({ TerminalClass, FitAddonClass, config, onCommandCaptured, onTerminalSnapshot, onRefresh }) {
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [backend, setBackend] = useState("starting");
  const [terminalError, setTerminalError] = useState("");

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = await api("/terminal/snapshot");
      setSnapshot(snap);
      onTerminalSnapshot?.(snap);
      if (snap?.backend) setBackend(snap.backend);
      setTerminalError(snap?.backendReason || "");
    } catch {}
  }, []);

  useEffect(() => {
    if (!TerminalClass || !FitAddonClass || !terminalRef.current) return;
    let disposed = false;
    let frameOne = 0;
    let frameTwo = 0;
    let resizeTimer = 0;
    let settleTimer = 0;
    let socket = null;
    let dataDisposable = null;
    const term = new TerminalClass({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", "Roboto Mono", "Menlo", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#101316",
        foreground: "#d8dee6",
        cursor: "#7dd3fc",
        black: "#0b0f12",
        red: "#f87171",
        green: "#86efac",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#67e8f9",
        white: "#e5e7eb"
      }
    });
    const fit = new FitAddonClass();
    term.loadAddon(fit);
    const safeFit = () => {
      const box = terminalRef.current?.getBoundingClientRect();
      if (!box?.width || !box?.height) return;
      try {
        fit.fit();
      } catch {
        // xterm can race container layout during first paint; the next resize tick will retry.
      }
    };
    const resize = () => {
      safeFit();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    const startTerminal = () => {
      if (disposed || !terminalRef.current) return;
      term.open(terminalRef.current);
      termRef.current = term;
      fitRef.current = fit;
      safeFit();

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/terminal`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (disposed) return;
        setConnected(true);
        setTerminalError("");
        safeFit();
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        term.focus();
      });
      socket.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "meta") {
          setBackend(msg.backend || "starting");
          setTerminalError(msg.backendReason || "");
          const next = { backend: msg.backend, backendReason: msg.backendReason, lastCommand: msg.lastCommand };
          setSnapshot((prev) => ({ ...(prev || {}), ...next }));
          onTerminalSnapshot?.(next);
        }
        if (msg.type === "terminal-mode") {
          setBackend(msg.backend);
          setTerminalError(msg.reason || "");
          const next = { backend: msg.backend, backendReason: msg.reason || "" };
          setSnapshot((prev) => ({ ...(prev || {}), ...next }));
          onTerminalSnapshot?.(next);
        }
        if (msg.type === "terminal-error") {
          setBackend("failed");
          setTerminalError(msg.message || "Terminal failed.");
          term.write(`\r\n[terminal] ${msg.message || "Terminal failed."}\r\n`);
        }
        if (msg.type === "output") term.write(msg.data);
        if (msg.type === "command-start") {
          const next = { currentCommand: msg.command };
          setSnapshot((prev) => ({ ...(prev || {}), ...next }));
          onTerminalSnapshot?.(next);
        }
        if (msg.type === "command-captured") {
          const next = { currentCommand: null, lastCommand: msg.command };
          setSnapshot((prev) => ({ ...(prev || {}), ...next }));
          onTerminalSnapshot?.(next);
          onCommandCaptured?.(msg.command);
        }
        if (msg.type === "exit") {
          setBackend("stopped");
        }
      });
      socket.addEventListener("close", () => setConnected(false));
      dataDisposable = term.onData((data) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "input", data })));
      window.addEventListener("resize", resize);
      resizeTimer = window.setTimeout(resize, 120);
      settleTimer = window.setTimeout(resize, 420);
    };

    frameOne = window.requestAnimationFrame(() => {
      frameTwo = window.requestAnimationFrame(startTerminal);
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameOne);
      window.cancelAnimationFrame(frameTwo);
      clearTimeout(resizeTimer);
      clearTimeout(settleTimer);
      window.removeEventListener("resize", resize);
      dataDisposable?.dispose?.();
      socket?.close();
      term.dispose();
    };
  }, [TerminalClass, FitAddonClass, onCommandCaptured]);

  useEffect(() => {
    refreshSnapshot();
    const interval = setInterval(refreshSnapshot, 2500);
    return () => clearInterval(interval);
  }, [refreshSnapshot]);

  const capture = async () => {
    const result = await api("/evidence/last-command", {
      method: "POST",
      body: {
        goalId: null,
        verifies: []
      }
    });
    setSnapshot((prev) => ({ ...(prev || {}), lastCommand: result.command }));
    onRefresh();
  };

  const backendTone = backend === "pty" ? "ok" : backend === "pipe" ? "warn" : backend === "failed" ? "bad" : "muted";
  const connectionLabel = connected ? "connected" : backend === "pipe" ? "limited" : backend === "failed" ? "offline" : "starting";
  const connectionTone = connected ? "ok" : backend === "pipe" ? "warn" : backend === "failed" ? "bad" : "muted";
  const commandStripText =
    snapshot?.currentCommand?.command ||
    snapshot?.lastCommand?.command ||
    (backend === "pipe" ? "Limited terminal mode" : terminalError || "Run a command to capture evidence");

  return (
    <section className="terminal-shell">
      <div className="terminal-topbar">
        <div className="terminal-title">
          <TerminalSquare size={18} />
          <div>
            <strong>Terminal</strong>
            <span>{config?.projectDir || "project directory"}</span>
          </div>
        </div>
        <div className="terminal-actions">
          <Pill tone={connectionTone}>{connectionLabel}</Pill>
          <Pill tone={backendTone}>{backend}</Pill>
          <IconButton icon={Save} onClick={capture} disabled={!snapshot?.currentCommand && !snapshot?.lastCommand} title="Save last command as evidence">
            Save command
          </IconButton>
        </div>
      </div>
      <div className="terminal-frame" ref={terminalRef} />
      <div className="command-strip">
        <div className="command-meta">
          <Command size={15} />
          <span title={terminalError || undefined}>
            {commandStripText}
          </span>
        </div>
        <button className="text-button" onClick={refreshSnapshot}>
          <History size={15} />
          Refresh
        </button>
      </div>
    </section>
  );
}

function ProjectKernelPanel({ packet }) {
  if (!packet) return <Empty title="No kernel loaded" body="Initialize the project or create/select a goal." />;
  return (
    <div className="section-stack">
      <SectionTitle icon={BookOpen} title="Project Kernel" action={<Pill>{packet.role}</Pill>} />
      <TextCluster title="Philosophy" items={packet.kernel?.philosophy} />
      <TextCluster title="Architecture" items={packet.kernel?.architecturePrinciples} />
      <TextCluster title="Non-negotiables" items={packet.kernel?.nonNegotiables} />
    </div>
  );
}

function TextCluster({ title, items = [] }) {
  return (
    <div className="text-cluster">
      <span>{title}</span>
      <ul>
        {items.slice(0, 4).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, action }) {
  return (
    <div className="section-title">
      <div>
        <Icon size={17} />
        <strong>{title}</strong>
      </div>
      {action}
    </div>
  );
}

function GoalPanel({ state, activeGoalId, setActiveGoalId, onCreateGoal }) {
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("Kernel can be generated\nCompletion audit blocks missing evidence\nHandoff summarizes current state");

  const submit = async (event) => {
    event.preventDefault();
    if (!objective.trim()) return;
    await onCreateGoal({
      objective,
      acceptance: acceptance
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    });
    setObjective("");
  };

  return (
    <div className="section-stack">
      <SectionTitle icon={Goal} title="Goals" action={<Pill>{state.goals.length}</Pill>} />
      <select value={activeGoalId || ""} onChange={(event) => setActiveGoalId(event.target.value)} className="select">
        <option value="">Select goal</option>
        {state.goals.map((goal) => (
          <option key={goal.id} value={goal.id}>
            {goal.status} · {goal.objective}
          </option>
        ))}
      </select>
      {state.activeGoal ? (
        <div className="goal-brief">
          <div>
            <strong>{state.activeGoal.objective}</strong>
            <Pill tone={statusTone(state.activeGoal.status)}>{state.activeGoal.status}</Pill>
          </div>
          <ul>
            {state.activeGoal.acceptanceCriteria?.map((criterion) => (
              <li key={criterion.id}>
                <span>{criterion.id}</span>
                {criterion.statement}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty title="No goal yet" body="Create one and the terminal becomes evidence-aware." />
      )}
      <form className="compact-form" onSubmit={submit}>
        <input value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="New objective" />
        <textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} />
        <IconButton icon={Plus} tone="primary">
          Create goal
        </IconButton>
      </form>
    </div>
  );
}

function WorkPanel({ state, onAddAction, onSetAction, onAddGate, onRunGate }) {
  const [actionTitle, setActionTitle] = useState("");
  const [gateName, setGateName] = useState("Smoke test");
  const [gateCommand, setGateCommand] = useState("python3 -m unittest discover -s tests");

  const goalId = state.activeGoal?.id;

  return (
    <div className="section-stack">
      <SectionTitle icon={ClipboardList} title="Actions" action={<Pill>{state.actions.length}</Pill>} />
      <div className="rows">
        {state.actions.map((action) => (
          <div className="data-row" key={action.id}>
            <div>
              <strong>{action.title}</strong>
              <span>{action.activityClass} · {action.id}</span>
            </div>
            <button className={`status-chip ${statusTone(action.status)}`} onClick={() => onSetAction(action.id, action.status === "done" ? "active" : "done")}>
              {action.status}
            </button>
          </div>
        ))}
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (goalId && actionTitle.trim()) {
            onAddAction({ goalId, title: actionTitle, activity: "implementation", role: "coding_agent" });
            setActionTitle("");
          }
        }}
      >
        <input value={actionTitle} onChange={(event) => setActionTitle(event.target.value)} placeholder="Action title" disabled={!goalId} />
        <IconButton icon={Plus} disabled={!goalId || !actionTitle.trim()}>
          Add
        </IconButton>
      </form>

      <SectionTitle icon={ShieldCheck} title="Quality Gates" action={<Pill>{state.gates.length}</Pill>} />
      <div className="rows">
        {state.gates.map((gate) => (
          <div className="data-row" key={gate.id}>
            <div>
              <strong>{gate.name}</strong>
              <span>{gate.command || gate.type}</span>
            </div>
            <div className="row-actions">
              <Pill tone={statusTone(gate.status)}>{gate.status}</Pill>
              {gate.command ? (
                <button className="square-button" onClick={() => onRunGate(gate.id)} title="Run gate">
                  <Play size={15} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <form
        className="compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (goalId && gateName.trim()) onAddGate({ goalId, name: gateName, type: "test", command: gateCommand });
        }}
      >
        <input value={gateName} onChange={(event) => setGateName(event.target.value)} placeholder="Gate name" disabled={!goalId} />
        <input value={gateCommand} onChange={(event) => setGateCommand(event.target.value)} placeholder="Command" disabled={!goalId} />
        <IconButton icon={Plus} disabled={!goalId || !gateName.trim()}>
          Add gate
        </IconButton>
      </form>
    </div>
  );
}

function EvidencePanel({ state, terminalSnapshot, onSaveCommand, onAudit, audit, onComplete, onHandoff, handoff }) {
  const [verify, setVerify] = useState([]);
  const targets = useMemo(() => {
    const criteria = state.activeGoal?.acceptanceCriteria?.map((item) => ({ id: item.id, label: `${item.id}: ${item.statement}` })) || [];
    const actions = state.actions.map((item) => ({ id: item.id, label: `action: ${item.title}` }));
    return [...criteria, ...actions];
  }, [state.activeGoal, state.actions]);

  useEffect(() => {
    setVerify([]);
  }, [state.activeGoal?.id]);

  const toggle = (id) => {
    setVerify((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
  };

  return (
    <div className="section-stack">
      <SectionTitle icon={FileCheck2} title="Evidence" action={<Pill>{state.evidence.length}</Pill>} />
      <div className="capture-box">
        <span>Last command</span>
        <strong>{terminalSnapshot?.lastCommand?.command || terminalSnapshot?.currentCommand?.command || "No command captured"}</strong>
        <div className="check-list">
          {targets.slice(0, 5).map((target) => (
            <label key={target.id}>
              <input type="checkbox" checked={verify.includes(target.id)} onChange={() => toggle(target.id)} />
              <span>{target.label}</span>
            </label>
          ))}
        </div>
        <IconButton icon={Save} onClick={() => onSaveCommand(verify)} disabled={!state.activeGoal || (!terminalSnapshot?.lastCommand && !terminalSnapshot?.currentCommand)}>
          Save as evidence
        </IconButton>
      </div>
      <div className="rows">
        {state.evidence.slice(0, 5).map((item) => (
          <div className="data-row evidence-row" key={item.id}>
            <div>
              <strong>{item.summary}</strong>
              <span>{item.kind} · {item.ref}</span>
            </div>
            <Pill>{item.verifies?.join(", ") || "unmapped"}</Pill>
          </div>
        ))}
      </div>

      <SectionTitle icon={BadgeCheck} title="Audit" action={audit ? <Pill tone={audit.canComplete ? "ok" : "warn"}>{audit.canComplete ? "pass" : "not ready"}</Pill> : null} />
      <div className="audit-grid">
        <AuditMetric icon={CheckCircle2} label="Passed" value={audit?.passed?.length || 0} tone="ok" />
        <AuditMetric icon={XCircle} label="Missing" value={audit?.missing?.length || 0} tone="warn" />
        <AuditMetric icon={Activity} label="Weak" value={audit?.weak?.length || 0} tone="muted" />
      </div>
      <div className="button-row">
        <IconButton icon={RefreshCw} onClick={onAudit} disabled={!state.activeGoal}>
          Run audit
        </IconButton>
        <IconButton icon={CheckCircle2} tone="primary" onClick={onComplete} disabled={!state.activeGoal || !audit?.canComplete}>
          Mark complete
        </IconButton>
      </div>

      <SectionTitle icon={GitBranch} title="Handoff" />
      <IconButton icon={BookOpen} onClick={onHandoff} disabled={!state.activeGoal}>
        Generate handoff
      </IconButton>
      {handoff ? <pre className="handoff-preview">{handoff}</pre> : null}
    </div>
  );
}

function AuditMetric({ icon: Icon, label, value, tone }) {
  return (
    <div className={`audit-metric ${tone}`}>
      <Icon size={17} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function getCurrentStep(state, audit, handoff, terminalSnapshot) {
  if (!state.initialized) {
    return {
      label: "Initialize memory",
      body: "Project docs and structured state are not loaded yet.",
      tone: "warn",
      source: ["project"]
    };
  }
  if (!state.activeGoal) {
    return {
      label: "Seed a goal",
      body: "The agent needs an objective before memory can become a working map.",
      tone: "warn",
      source: ["memory"]
    };
  }
  if (state.activeGoal.status === "complete" && !handoff) {
    return {
      label: "Prepare handoff",
      body: "The goal is complete; generate a packet for the next agent.",
      tone: "ok",
      source: ["goal", "handoff"]
    };
  }
  if (terminalSnapshot?.currentCommand) {
    return {
      label: "Executing command",
      body: terminalSnapshot.currentCommand.command,
      tone: "warn",
      source: ["terminal", "goal"]
    };
  }
  if (terminalSnapshot?.lastCommand && !state.evidence.length) {
    return {
      label: "Bind command evidence",
      body: terminalSnapshot.lastCommand.command,
      tone: "warn",
      source: ["terminal", "acceptance"]
    };
  }
  if (!state.evidence.length) {
    return {
      label: "Collect evidence",
      body: "Run a command, review output, then save it against the goal.",
      tone: "muted",
      source: ["goal", "terminal"]
    };
  }
  if (!audit) {
    return {
      label: "Ready for audit",
      body: `${state.evidence.length} evidence item(s) are in memory.`,
      tone: "ok",
      source: ["evidence", "goal"]
    };
  }
  if (audit.canComplete && state.activeGoal.status !== "complete") {
    return {
      label: "Completion allowed",
      body: "The audit says the goal has enough evidence.",
      tone: "ok",
      source: ["audit", "evidence"]
    };
  }
  return {
    label: "Handoff ready",
    body: "Memory, evidence, audit, and handoff are connected.",
    tone: "ok",
    source: ["memory", "handoff"]
  };
}

function buildMemoryGraph(state, packet, audit, handoff) {
  const hasGoal = Boolean(state.activeGoal);
  const codeBacked = state.actions.length || state.evidence.length;
  const auditBacked = audit?.canComplete || state.activeGoal?.status === "complete";
  return {
    nodes: [
      { id: "kernel", label: "Kernel", x: 58, y: 78, status: packet ? "done" : "pending", meta: packet ? "docs" : "missing" },
      { id: "goal", label: "Goal", x: 190, y: 46, status: hasGoal ? state.activeGoal.status : "pending", meta: hasGoal ? state.activeGoal.status : "none" },
      { id: "code", label: "Code", x: 318, y: 86, status: codeBacked ? "done" : "pending", meta: state.actions.length ? `${state.actions.length} step(s)` : `${state.evidence.length} proof` },
      { id: "evidence", label: "Evidence", x: 82, y: 190, status: state.evidence.length ? "done" : "pending", meta: `${state.evidence.length} item(s)` },
      { id: "audit", label: "Audit", x: 214, y: 224, status: auditBacked ? "done" : audit ? "active" : "pending", meta: auditBacked ? "pass" : audit ? "missing" : "not run" },
      { id: "handoff", label: "Handoff", x: 326, y: 184, status: handoff ? "done" : state.activeGoal?.status === "complete" ? "active" : "pending", meta: handoff ? "ready" : "waiting" }
    ],
    edges: [
      ["kernel", "goal"],
      ["goal", "code"],
      ["goal", "evidence"],
      ["code", "evidence"],
      ["evidence", "audit"],
      ["audit", "handoff"]
    ]
  };
}

function flowStatus(done, current) {
  if (done) return "done";
  if (current) return "current";
  return "pending";
}

function buildCodeFlow(state, audit, handoff, terminalSnapshot) {
  const hasGoal = Boolean(state.activeGoal);
  const hasEvidence = state.evidence.length > 0;
  const hasCommand = Boolean(terminalSnapshot?.currentCommand || terminalSnapshot?.lastCommand || hasEvidence || state.actions.some((item) => item.status === "done"));
  const auditDone = Boolean(audit?.canComplete || state.activeGoal?.status === "complete");
  const auditDetail = audit ? `${audit.passed?.length || 0} pass / ${audit.missing?.length || 0} missing` : auditDone ? "pass" : "not run";
  return [
    { id: "observe", label: "Observe", detail: state.initialized ? "kernel loaded" : "load memory", status: flowStatus(state.initialized, !state.initialized), icon: Eye },
    { id: "plan", label: "Plan", detail: hasGoal ? state.activeGoal.objective : "set objective", status: flowStatus(hasGoal, state.initialized && !hasGoal), icon: Goal },
    {
      id: "execute",
      label: "Execute",
      detail: terminalSnapshot?.currentCommand?.command || terminalSnapshot?.lastCommand?.command || "run command",
      status: flowStatus(hasCommand, hasGoal && !hasCommand),
      icon: Code2
    },
    { id: "evidence", label: "Evidence", detail: `${state.evidence.length} saved`, status: flowStatus(hasEvidence, hasCommand && !hasEvidence), icon: FileCheck2 },
    { id: "audit", label: "Audit", detail: auditDetail, status: flowStatus(auditDone, hasEvidence && !auditDone), icon: ShieldCheck },
    { id: "handoff", label: "Handoff", detail: handoff ? "packet ready" : "waiting", status: flowStatus(Boolean(handoff), auditDone && !handoff), icon: GitBranch }
  ];
}

function ControlSummaryPanel({ step, memoryGraph, processTrace, architectureMap, continuity, acceptanceAudit }) {
  const memoryNodes = memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0;
  const memoryEdges = memoryGraph?.edgeCount || memoryGraph?.edges?.length || 0;
  const current = processTrace?.current || step;
  const previous = processTrace?.previous;
  const next = processTrace?.next;
  const changed = architectureMap?.totals?.changed || architectureMap?.recentChanges?.length || architectureMap?.changes?.length || 0;
  const files = architectureMap?.totals?.files || architectureMap?.files?.length || 0;
  const topFolder = architectureMap?.impact?.topFolders?.[0]?.folder || architectureMap?.impact?.folders?.[0]?.folder;
  const canResume = acceptanceAudit?.canResume ?? continuity?.takeoverReadiness?.canTakeOver ?? continuity?.continuityAudit?.canResume;
  const handoffTone = canResume === false ? "bad" : acceptanceAudit?.status === "warn" || continuity?.continuityAudit?.status === "warn" ? "warn" : "ok";
  const handoffValue = acceptanceAudit?.status === "pass" ? "Accepted" : canResume ? "Can resume" : "Needs attention";
  const handoffDetail =
    acceptanceAudit?.status === "pass"
      ? "Memory, process, architecture, and handoff are proven."
      : acceptanceAudit?.summary || continuity?.takeoverReadiness?.summary || "A new agent can start from durable handoff files.";
  const processDetail = [eventLabel(previous), eventLabel(current), eventLabel(next)].filter(Boolean).join(" -> ");
  return (
    <section className="insight-section control-summary" data-control-summary="user-readable-state">
      <div className="insight-heading">
        <span>Project Control</span>
        <Pill tone={handoffTone}>{handoffValue}</Pill>
      </div>
      <div className="control-summary-grid">
        <InsightCard
          icon={GitBranch}
          label="Agent takeover"
          value={acceptanceAudit?.score || continuity?.takeoverReadiness?.score || "ready"}
          detail={shortText(handoffDetail)}
          tone={handoffTone}
        />
        <InsightCard
          icon={Activity}
          label="AI is doing"
          value={shortText(eventLabel(current), 42)}
          detail={shortText(processDetail || eventDetail(current) || step?.body, 112)}
          tone={current?.status === "failed" || current?.status === "blocked" ? "bad" : current?.status === "current" ? "warn" : "ok"}
        />
        <InsightCard
          icon={Network}
          label="Architecture impact"
          value={`${changed} changed`}
          detail={`${files} files${topFolder ? ` · focus ${topFolder === "." ? "repo root" : topFolder}` : ""}`}
          tone={changed ? "warn" : "ok"}
        />
        <InsightCard
          icon={Brain}
          label="Memory graph"
          value={`${memoryNodes} nodes`}
          detail={`${memoryEdges} relationships with durable provenance`}
          tone={memoryNodes && memoryEdges ? "ok" : "warn"}
        />
      </div>
    </section>
  );
}

function HandoffPrimerPanel({ continuity, contract, acceptanceAudit }) {
  const contextBundle = continuity?.agentContextBundle;
  const startProtocol = continuity?.startProtocol;
  const takeoverPacket = continuity?.takeoverPacket || continuity?.takeoverDrill?.nextAgentBrief;
  const current = contextBundle?.quickStart?.currentCursor || takeoverPacket?.cursor || contract?.resume?.current;
  const firstActions = takeoverPacket?.firstActions || startProtocol?.firstActions || contract?.firstActions || [];
  const readFirst = contextBundle?.readOrder?.map((path) => ({ path })) || takeoverPacket?.firstRead || startProtocol?.readFirst || contract?.readFirst || [];
  const nextCommand = takeoverPacket?.nextCommand || contextBundle?.quickStart?.nextCommand || continuity?.continuityAudit?.nextCommand || "Read the context bundle first.";
  const tone = acceptanceAudit?.status === "fail" ? "bad" : acceptanceAudit?.status === "warn" ? "warn" : "ok";
  return (
    <section className="insight-section handoff-primer" data-handoff-primer="next-agent-start">
      <div className="insight-heading">
        <span>New Agent Start</span>
        <Pill tone={tone}>{acceptanceAudit?.status === "pass" ? "8/8 accepted" : cleanLabel(acceptanceAudit?.status || "ready")}</Pill>
      </div>
      <div className="handoff-primer-current">
        <span>Resume from</span>
        <strong>{current?.title || continuity?.activeGoal?.objective || "Current project state"}</strong>
        <small>{[current?.phase, current?.status, current?.workstream?.label].filter(Boolean).join(" · ") || "Read durable state before editing."}</small>
      </div>
      <div className="handoff-primer-command">
        <span>Next command</span>
        <code>{nextCommand}</code>
      </div>
      <div className="handoff-primer-grid">
        <div>
          <strong>Read first</strong>
          {(readFirst || []).slice(0, 4).map((item, index) => (
            <span key={`${item.path}-${index}`}>{item.path}</span>
          ))}
        </div>
        <div>
          <strong>Do first</strong>
          {firstActions.slice(0, 3).map((item, index) => (
            <span key={item.action || index}>{item.action || item}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function HandoffLifecyclePanel({ lifecycle }) {
  if (!lifecycle) return null;
  const tone = lifecycleTone(lifecycle.status);
  const checks = lifecycle.checks || [];
  return (
    <section className="insight-section handoff-lifecycle" data-handoff-lifecycle=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Handoff Lifecycle</span>
        <Pill tone={tone}>{lifecycle.status || "unknown"}</Pill>
      </div>
      <p>{lifecycle.summary || "No typed handoff lifecycle summary available."}</p>
      <div className="audit-counts">
        <span className={tone}>state {lifecycle.status || "unknown"}</span>
        <span className={lifecycle.expiresAt ? "ok" : "warn"}>ttl {lifecycle.ttlSeconds || 0}s</span>
        <span className={lifecycle.ageSeconds > lifecycle.ttlSeconds ? "warn" : "ok"}>age {Number.isFinite(lifecycle.ageSeconds) ? `${lifecycle.ageSeconds}s` : "n/a"}</span>
      </div>
      <div className="handoff-lifecycle-checks">
        {checks.slice(0, 5).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      <div className="acceptance-source">
        <span>next</span>
        <code>{lifecycle.nextAction || "Verify the bundle before editing."}</code>
      </div>
    </section>
  );
}

function FreshnessGatePanel({ gate }) {
  if (!gate) return null;
  const tone = freshnessTone(gate.status);
  const checks = gate.checks || [];
  const validity = gate.validity || {};
  return (
    <section className="insight-section freshness-gate" data-freshness-gate=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Freshness Gate</span>
        <Pill tone={tone}>{gate.status || "unknown"}</Pill>
      </div>
      <p>{gate.summary || "No temporal freshness summary available."}</p>
      <div className="freshness-timeline">
        <span title={validity.observedAt || gate.observedAt || ""}>observed {validity.observedAt || gate.observedAt || "unknown"}</span>
        <span title={validity.validUntil || ""}>valid until {validity.validUntil || "unknown"}</span>
        <span className={gate.staleChecks?.length ? "warn" : "ok"}>stale {gate.staleChecks?.length || 0}</span>
      </div>
      <div className="freshness-checks">
        {checks.slice(0, 5).map((check) => (
          <span key={check.id} className={check.status} title={[check.detail, check.validUntil ? `valid until ${check.validUntil}` : ""].filter(Boolean).join(" ")}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      <div className="acceptance-source">
        <span>next</span>
        <code>{gate.nextAction || "Verify freshness before editing."}</code>
      </div>
    </section>
  );
}

function RuntimeEvalPanel({ runtimeEval }) {
  if (!runtimeEval) return null;
  const tone = evalTone(runtimeEval.status);
  const checks = runtimeEval.checks || [];
  const spans = runtimeEval.spans || [];
  return (
    <section className="insight-section runtime-eval" data-runtime-eval=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Runtime Eval</span>
        <Pill tone={tone}>{runtimeEval.status || "unknown"}</Pill>
      </div>
      <p>{runtimeEval.summary || "No runtime trace evaluation available."}</p>
      <div className="audit-counts">
        <span className={tone}>score {runtimeEval.score || "0/0"}</span>
        <span className={tone}>quality {runtimeEval.quality || 0}</span>
        <span className={spans.length ? "ok" : "warn"}>spans {runtimeEval.trace?.spanCount || spans.length || 0}</span>
      </div>
      <div className="runtime-eval-checks">
        {checks.slice(0, 6).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      {spans.length ? (
        <div className="runtime-span-strip">
          {spans.slice(0, 5).map((span) => (
            <span key={span.spanId} className={span.tone} title={[span.phase, span.status, span.observedAt, (span.refs || []).join(", ")].filter(Boolean).join(" ")}>
              {span.phase}/{span.status}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{runtimeEval.nextAction || "Keep runtime events linked to evidence."}</code>
      </div>
    </section>
  );
}

function PhaseLedgerNode({ node, depth = 0 }) {
  if (!node) return null;
  const tone = phaseTone(node.status);
  const children = node.children || [];
  const depthClass = `depth-${Math.min(depth, 3)}`;
  return (
    <>
      <span className={`phase-ledger-node ${depthClass} ${tone}`} title={[node.spanId, node.parentSpanId, node.runId, node.tool, node.durationMs ? `${node.durationMs}ms` : ""].filter(Boolean).join(" ")}>
        {node.phase}/{node.status} · {node.title}
      </span>
      {children.slice(0, 4).map((child) => (
        <PhaseLedgerNode key={child.spanId} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

function PhaseLedgerPanel({ ledger }) {
  if (!ledger) return null;
  const tone = phaseTone(ledger.status);
  const checks = ledger.checks || [];
  const tree = ledger.tree || [];
  return (
    <section className="insight-section phase-ledger" data-phase-ledger=".project-agent/continuity.json#phaseLedger">
      <div className="insight-heading">
        <span>Phase Ledger</span>
        <Pill tone={tone}>{ledger.status || "unknown"}</Pill>
      </div>
      <p>{ledger.summary || "No phase ledger available."}</p>
      <div className="audit-counts">
        <span className={ledger.spanCount ? tone : "warn"}>spans {ledger.spanCount || 0}</span>
        <span className={ledger.linkedCount ? "ok" : "warn"}>linked {ledger.linkedCount || 0}</span>
        <span className={ledger.runCount ? "ok" : "warn"}>runs {ledger.runCount || 0}</span>
        <span className={ledger.danglingParents?.length ? "bad" : "ok"}>dangling {ledger.danglingParents?.length || 0}</span>
      </div>
      <div className="phase-ledger-checks">
        {checks.slice(0, 6).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      {tree.length ? (
        <div className="phase-ledger-tree">
          {tree.slice(0, 4).map((node) => (
            <PhaseLedgerNode key={node.spanId} node={node} />
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{ledger.nextAction || "Record parentId and runId around related tool calls."}</code>
      </div>
    </section>
  );
}

function CheckpointLedgerPanel({ ledger }) {
  if (!ledger) return null;
  const tone = checkpointTone(ledger.status);
  const checkpoints = ledger.resumable?.length ? ledger.resumable : ledger.checkpoints || [];
  const checks = ledger.checks || [];
  const runGroups = ledger.runGroups || [];
  return (
    <section className="insight-section checkpoint-ledger" data-checkpoint-ledger=".project-agent/continuity.json#checkpointLedger">
      <div className="insight-heading">
        <span>Checkpoint Ledger</span>
        <Pill tone={tone}>{ledger.status || "unknown"}</Pill>
      </div>
      <p>{ledger.summary || "No checkpoint ledger available."}</p>
      <div className="audit-counts">
        <span className={ledger.checkpointCount ? tone : "warn"}>checkpoints {ledger.checkpointCount || 0}</span>
        <span className={ledger.resumableCount ? "ok" : "warn"}>resumable {ledger.resumableCount || 0}</span>
        <span className={ledger.pendingCount ? "warn" : "ok"}>pending {ledger.pendingCount || 0}</span>
        <span className={ledger.failedCount ? "bad" : "ok"}>failed {ledger.failedCount || 0}</span>
      </div>
      <div className="checkpoint-ledger-checks">
        {checks.slice(0, 6).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      {checkpoints.length ? (
        <div className="checkpoint-ledger-grid">
          {checkpoints.slice(0, 6).map((checkpoint) => (
            <div key={checkpoint.checkpointId} className={`checkpoint-card ${checkpoint.failed ? "bad" : checkpoint.pending ? "warn" : "ok"}`}>
              <span>{checkpoint.phase}/{checkpoint.status}</span>
              <strong title={checkpoint.title}>{checkpoint.title}</strong>
              <small title={(checkpoint.refs || []).join(", ")}>{checkpoint.runId || checkpoint.eventId || checkpoint.checkpointId}</small>
            </div>
          ))}
        </div>
      ) : null}
      {runGroups.length ? (
        <div className="checkpoint-run-strip">
          {runGroups.slice(0, 5).map((run, index) => (
            <span key={run.runId || `run-${index}`} className={run.failedCount ? "bad" : run.pendingCount ? "warn" : "ok"} title={(run.refs || []).join(", ")}>
              {run.runId || "single"} · {run.checkpointCount} cp
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{ledger.nextAction || "Inspect resumable checkpoints before retrying work."}</code>
      </div>
    </section>
  );
}

function HookIngressPanel({ audit }) {
  if (!audit) return null;
  const tone = hookTone(audit.status);
  const recent = audit.recent || [];
  const recentAttempts = audit.recentAttempts || [];
  const backpressure = audit.backpressure || {};
  return (
    <section className="insight-section hook-ingress" data-hook-ingress="/api/hooks">
      <div className="insight-heading">
        <span>Hook Ingress</span>
        <Pill tone={tone}>{audit.status || "unknown"}</Pill>
      </div>
      <p>{audit.summary || "No sanitized hook ingress audit available."}</p>
      <div className="audit-counts">
        <span className={tone}>accepted {audit.acceptedEvents || 0}</span>
        <span className={audit.rejectedEvents ? "warn" : "ok"}>rejected {audit.rejectedEvents || 0}</span>
        <span className={backpressure.status === "saturated" ? "bad" : backpressure.status === "watch" ? "warn" : "ok"}>pressure {backpressure.status || "idle"}</span>
        <span className={audit.sanitizedEvents ? "warn" : "ok"}>redacted {audit.sanitizedEvents || 0}</span>
        <span className={audit.unknownTypeEvents ? "warn" : "ok"}>unknown {audit.unknownTypeEvents || 0}</span>
      </div>
      {recentAttempts.length ? (
        <div className="hook-ingress-attempts">
          {recentAttempts.slice(0, 5).map((attempt) => (
            <span key={attempt.id} className={attempt.httpStatus === 429 ? "bad" : attempt.rejected ? "warn" : "ok"} title={(attempt.blockers || []).join(", ") || attempt.pressureStatus || ""}>
              {attempt.httpStatus || 0} · {attempt.accepted || 0}/{attempt.totalItems || 0} accepted
            </span>
          ))}
        </div>
      ) : null}
      {recent.length ? (
        <div className="hook-ingress-events">
          {recent.slice(0, 5).map((event) => (
            <span key={event.id} className={event.sanitized || event.typeStatus === "unknown" ? "warn" : "ok"} title={[event.rawType, event.source, event.warnings?.join(", ")].filter(Boolean).join(" ")}>
              {event.type} · {event.title}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{audit.nextAction || "Send external events through sanitized hook ingress."}</code>
      </div>
    </section>
  );
}

function AttentionPackPanel({ pack }) {
  if (!pack) return null;
  const tone = attentionTone(pack.status);
  const budget = pack.budget || {};
  const items = pack.items || [];
  const readFirst = pack.readFirst || [];
  const tokenLabel = budget.budgetTokens ? `${budget.estimatedTokens || 0}/${budget.budgetTokens}` : `${budget.estimatedTokens || 0}`;
  return (
    <section className="insight-section attention-pack" data-attention-pack=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Attention Pack</span>
        <Pill tone={tone}>{pack.status || "unknown"}</Pill>
      </div>
      <p>{pack.summary || "No top-of-mind attention pack available."}</p>
      <div className="audit-counts">
        <span className={tone}>tokens {tokenLabel}</span>
        <span className={items.length ? "ok" : "warn"}>items {items.length}</span>
        <span className={readFirst.length ? "ok" : "warn"}>refs {readFirst.length}</span>
      </div>
      <div className="attention-item-grid">
        {items.slice(0, 6).map((item) => (
          <div key={item.id} className={`attention-item ${item.kind || "source"}`}>
            <span>#{item.rank || "?"} {item.kind || "item"}</span>
            <strong title={item.label}>{item.label}</strong>
            <small title={item.text}>{item.text}</small>
            <em title={(item.refs || []).join(", ")}>{item.refs?.[0] || "no ref"}</em>
          </div>
        ))}
      </div>
      {readFirst.length ? (
        <div className="attention-readfirst">
          {readFirst.slice(0, 5).map((item) => (
            <span key={item.ref} title={item.reason || item.ref}>
              {fileName(item.ref)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{pack.nextAction || "Start from this pack, then verify refs before editing."}</code>
      </div>
    </section>
  );
}

function ProvenanceLedgerPanel({ ledger }) {
  if (!ledger) return null;
  const tone = provenanceTone(ledger.status);
  const claims = ledger.claims || [];
  const sources = ledger.sources || [];
  const coverage = ledger.coverage || {};
  return (
    <section className="insight-section provenance-ledger" data-provenance-ledger=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Provenance Ledger</span>
        <Pill tone={tone}>{ledger.status || "unknown"}</Pill>
      </div>
      <p>{ledger.summary || "No source provenance ledger available."}</p>
      <div className="audit-counts">
        <span className={tone}>claims {coverage.sourcedClaims || 0}/{coverage.claims || 0}</span>
        <span className={coverage.hashedSources ? "ok" : "warn"}>hashed {coverage.hashedCoverage || "0/0"}</span>
        <span className={coverage.aggregateHash ? "ok" : "warn"}>manifest {(coverage.aggregateHash || "").slice(0, 8) || "none"}</span>
      </div>
      <div className="provenance-claim-grid">
        {claims.slice(0, 6).map((claim) => (
          <div key={claim.id} className={`provenance-claim ${claim.status}`}>
            <span>{claim.status}</span>
            <strong title={claim.label}>{claim.label}</strong>
            <small title={claim.summary}>{claim.sourceRefs?.[0] || "no source ref"}</small>
          </div>
        ))}
      </div>
      {sources.length ? (
        <div className="provenance-source-strip">
          {sources.slice(0, 6).map((source) => (
            <span key={source.ref} className={source.hash ? "ok" : "warn"} title={[source.ref, source.hash, source.schemaVersion].filter(Boolean).join(" ")}>
              {fileName(source.ref)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{ledger.nextAction || "Check sourceRefs and hashes before trusting claims."}</code>
      </div>
    </section>
  );
}

function StateBoundaryPanel({ boundary }) {
  if (!boundary) return null;
  const tone = boundaryTone(boundary.status);
  const layers = boundary.layers || [];
  const checks = boundary.checks || [];
  const lineage = boundary.lineage || [];
  const totals = boundary.totals || {};
  return (
    <section className="insight-section state-boundary" data-state-boundary=".project-agent/continuity.json#stateBoundary">
      <div className="insight-heading">
        <span>State Boundary</span>
        <Pill tone={tone}>{boundary.status || "unknown"}</Pill>
      </div>
      <p>{boundary.summary || "No source/index/disclosure boundary audit available."}</p>
      <div className="audit-counts">
        <span className={tone}>layers {totals.layers || layers.length}</span>
        <span className={totals.sourceRefs ? "ok" : "warn"}>sources {totals.sourceRefs || 0}</span>
        <span className={totals.derivedIndexes ? "ok" : "warn"}>indexes {totals.derivedIndexes || 0}</span>
        <span className={totals.disclosureOutputs ? "ok" : "warn"}>disclosures {totals.disclosureOutputs || 0}</span>
      </div>
      <div className="state-boundary-layers">
        {layers.slice(0, 4).map((layer) => (
          <div key={layer.id} className={`state-boundary-layer ${layer.sourceOfTruth ? "source" : layer.disclosure ? "disclosure" : "derived"}`}>
            <span>{layer.sourceOfTruth ? "source" : layer.disclosure ? "disclosure" : "derived"}</span>
            <strong title={layer.role}>{layer.label}</strong>
            <small title={(layer.refs || []).join(", ")}>{(layer.refs || []).slice(0, 2).map(fileName).join(", ") || "no refs"}</small>
          </div>
        ))}
      </div>
      <div className="state-boundary-checks">
        {checks.slice(0, 6).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      {lineage.length ? (
        <div className="state-boundary-lineage">
          {lineage.slice(0, 4).map((item) => (
            <span key={item.id} className={item.status || "ok"} title={(item.derivedFrom || []).join(", ")}>
              {fileName(item.output)} from {(item.derivedFrom || []).slice(0, 2).map(fileName).join(", ")}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{boundary.nextAction || "Verify source-of-truth refs before trusting derived indexes or prompts."}</code>
      </div>
    </section>
  );
}

function DecisionLedgerPanel({ ledger }) {
  if (!ledger) return null;
  const tone = decisionTone(ledger.status);
  const decisions = ledger.decisions || [];
  const checks = ledger.checks || [];
  return (
    <section className="insight-section decision-ledger" data-decision-ledger=".project-agent/continuity.json#decisionLedger">
      <div className="insight-heading">
        <span>Decision Ledger</span>
        <Pill tone={tone}>{ledger.status || "unknown"}</Pill>
      </div>
      <p>{ledger.summary || "No temporal decision ledger available."}</p>
      <div className="audit-counts">
        <span className={tone}>decisions {ledger.decisionCount || 0}</span>
        <span className="ok">valid {ledger.validCount || 0}</span>
        <span className={ledger.watchCount ? "warn" : "ok"}>watch {ledger.watchCount || 0}</span>
        <span className={ledger.invalidCount ? "bad" : "ok"}>invalid {ledger.invalidCount || 0}</span>
      </div>
      <div className="decision-ledger-checks">
        {checks.slice(0, 6).map((check) => (
          <span key={check.id} className={check.status} title={check.detail}>
            {check.status} {check.label}
          </span>
        ))}
      </div>
      {decisions.length ? (
        <div className="decision-ledger-grid">
          {decisions.slice(0, 6).map((decision) => (
            <div key={decision.id} className={`decision-ledger-card ${decisionTone(decision.status)}`}>
              <span>{decision.status}</span>
              <strong title={decision.statement}>{decision.title}</strong>
              <small title={(decision.sourceRefs || []).join(", ")}>{decision.validFrom || decision.sourceRefs?.[0] || "no source"}</small>
            </div>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{ledger.nextAction || "Verify decisions against source refs before relying on them."}</code>
      </div>
    </section>
  );
}

function CodeGraphPanel({ graph }) {
  if (!graph) return null;
  const tone = codeGraphTone(graph.status);
  const changedImpact = graph.changedImpact || [];
  const hotspots = graph.hotspots || [];
  const packages = graph.packages || [];
  const warnings = graph.warnings || [];
  return (
    <section className="insight-section code-graph" data-code-graph=".project-agent/architecture-map.json#codeGraph">
      <div className="insight-heading">
        <span>Code Graph</span>
        <Pill tone={tone}>{graph.status || "unknown"}</Pill>
      </div>
      <p>{graph.summary || "No code dependency graph available."}</p>
      <div className="audit-counts">
        <span className={graph.nodeCount ? tone : "warn"}>nodes {graph.nodeCount || 0}</span>
        <span className={graph.localEdgeCount ? "ok" : "warn"}>local {graph.localEdgeCount || 0}</span>
        <span className={graph.packageEdgeCount ? "ok" : "muted"}>packages {graph.packageEdgeCount || 0}</span>
        <span className={graph.unresolvedEdgeCount ? "warn" : "ok"}>unresolved {graph.unresolvedEdgeCount || 0}</span>
      </div>
      {changedImpact.length ? (
        <div className="code-graph-impact">
          {changedImpact.slice(0, 6).map((item) => (
            <div key={item.path} className={`code-graph-card ${item.dependents?.length ? "warn" : item.dependencies?.length ? "ok" : "muted"}`}>
              <span>{item.risk || "impact"}</span>
              <strong title={item.path}>{item.path}</strong>
              <small title={(item.dependents || []).join(", ")}>dependents {(item.dependents || []).length}</small>
              <small title={(item.dependencies || []).join(", ")}>deps {(item.dependencies || []).length}</small>
            </div>
          ))}
        </div>
      ) : null}
      {hotspots.length ? (
        <div className="code-graph-hotspots">
          {hotspots.slice(0, 6).map((item) => (
            <span key={item.path} title={(item.refs || []).join(", ")}>
              {fileName(item.path)} · in {item.importedBy || 0} / out {item.imports || 0}
            </span>
          ))}
        </div>
      ) : null}
      {packages.length ? (
        <div className="code-graph-packages">
          {packages.slice(0, 6).map((item) => (
            <span key={item.name} title={item.name}>
              {item.name} <b>{item.count}</b>
            </span>
          ))}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="code-graph-warnings">
          {warnings.slice(0, 5).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>next</span>
        <code>{graph.nextAction || "Inspect dependency graph before editing imported files."}</code>
      </div>
    </section>
  );
}

function DisclosureGatePanel({ gate }) {
  if (!gate) return null;
  const tone = gateTone(gate.status);
  const budget = gate.budget || {};
  const scope = gate.scope || {};
  const packing = gate.packing || {};
  const packingLimits = packing.limits || {};
  const packingTotals = packing.totals || {};
  const omittedRefs = packing.omittedRefs || [];
  const findings = gate.scan?.findings || [];
  const canPublish = gate.canPublish === undefined ? "unknown" : gate.canPublish ? "publishable" : "blocked";
  const tokenLabel = budget.budgetTokens ? `${budget.estimatedTokens || 0}/${budget.budgetTokens}` : `${budget.estimatedTokens || 0}`;
  return (
    <section className="insight-section disclosure-gate" data-disclosure-gate=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Disclosure Gate</span>
        <Pill tone={tone}>{canPublish}</Pill>
      </div>
      <p>{gate.summary || "No disclosure summary available."}</p>
      <div className="audit-counts">
        <span className={(budget.estimatedTokens || 0) > (budget.budgetTokens || Infinity) ? "warn" : "ok"}>
          tokens {tokenLabel}
        </span>
        <span className={scope.sourceFileCount ? "ok" : "warn"}>
          sources {scope.sourceFileCount || 0}
        </span>
        <span className={packing.status === "warn" ? "warn" : "ok"}>
          files {packingTotals.includedFiles || 0}/{packingLimits.maxFiles || 0}
        </span>
        <span className={(packingTotals.includedBytes || 0) > (packingLimits.maxBytes || Infinity) ? "warn" : "ok"}>
          bytes {formatBytes(packingTotals.includedBytes || 0)}/{formatBytes(packingLimits.maxBytes || 0)}
        </span>
        <span className={omittedRefs.length ? "warn" : "ok"}>
          omitted {packingTotals.omittedRefs || 0}
        </span>
        <span className={findings.length ? "bad" : "ok"}>
          secrets {findings.length}
        </span>
      </div>
      {gate.blockers?.length || gate.warnings?.length ? (
        <div className="disclosure-flags">
          {(gate.blockers || []).map((item) => (
            <span key={`blocker-${item}`} className="bad">blocker {item}</span>
          ))}
          {(gate.warnings || []).map((item) => (
            <span key={`warning-${item}`} className="warn">warning {item}</span>
          ))}
        </div>
      ) : null}
      {omittedRefs.length ? (
        <div className="disclosure-omitted">
          {omittedRefs.slice(0, 5).map((item, index) => (
            <span key={`${item.ref}-${index}`} className="warn" title={item.reason || "packing limit"}>
              omitted {item.ref}
            </span>
          ))}
        </div>
      ) : null}
      {findings.length ? (
        <div className="disclosure-findings">
          {findings.slice(0, 4).map((finding, index) => (
            <span key={`${finding.rule}-${index}`} className="bad" title={finding.label}>
              {finding.rule}: {finding.sample}
            </span>
          ))}
        </div>
      ) : null}
      <div className="acceptance-source">
        <span>source</span>
        <code>{gate.refs?.[0] || ".project-agent/agent-context-bundle.json"}</code>
      </div>
    </section>
  );
}

function PreEditRiskPanel({ risk }) {
  if (!risk) return null;
  const tone = riskTone(risk.status);
  const checks = [...(risk.checks || [])].sort((a, b) => {
    const order = { bad: 0, warn: 1, ok: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });
  const firstChecks = risk.firstChecks || [];
  const coChangePartners = risk.coChangePartners || [];
  return (
    <section className="insight-section pre-edit-risk" data-pre-edit-risk=".project-agent/agent-context-bundle.json">
      <div className="insight-heading">
        <span>Pre-Edit Risk</span>
        <Pill tone={tone}>{risk.status || "unknown"}</Pill>
      </div>
      <p>{risk.summary || "No pre-edit risk summary available."}</p>
      <div className="audit-counts">
        <span className={tone}>score {risk.score || "0/0"}</span>
        <span className={risk.testGap?.status === "warn" ? "warn" : "ok"}>tests {risk.testGap?.status || "unknown"}</span>
        <span className={risk.changedFiles?.length ? "warn" : "ok"}>files {risk.changedFiles?.length || 0}</span>
      </div>
      {firstChecks.length ? (
        <div className="pre-edit-first-checks">
          {firstChecks.slice(0, 4).map((item) => (
            <span key={item.id} title={(item.refs || []).join(" ")}>
              {item.action}
            </span>
          ))}
        </div>
      ) : null}
      {checks.length ? (
        <div className="pre-edit-check-grid">
          {checks.slice(0, 6).map((check) => (
            <div key={check.id} className={`pre-edit-check ${check.status}`}>
              <span>{check.status}</span>
              <strong title={check.label}>{check.label}</strong>
              <small title={check.detail || check.action}>{check.detail || check.action}</small>
            </div>
          ))}
        </div>
      ) : null}
      {coChangePartners.length ? (
        <div className="pre-edit-cochange">
          {coChangePartners.slice(0, 3).map((item) => (
            <span key={item.folder} title={(item.paths || []).join(", ")}>
              {item.summary}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CurrentStepPanel({ step, targets, selectedTargets, toggleTarget }) {
  return (
    <section className="insight-section current-step">
      <div className="insight-heading">
        <span>Current Step</span>
        <Pill tone={step.tone}>{step.label}</Pill>
      </div>
      {step.workstream ? (
        <div className="workstream-current">
          <span>{step.workstream.label}</span>
          <small>{step.workstream.description}</small>
        </div>
      ) : null}
      <p>{step.body}</p>
      <div className="source-row">
        {(step.source || []).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      {targets.length ? (
        <div className="target-chips">
          {targets.slice(0, 5).map((target) => (
            <button key={target.id} className={selectedTargets.includes(target.id) ? "target-chip selected" : "target-chip"} onClick={() => toggleTarget(target.id)}>
              {target.id}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GovernancePanel({ governance }) {
  const domains = governance?.domains || [];
  if (!domains.length) return null;
  return (
    <section className="insight-section governance-section">
      <div className="insight-heading">
        <span>Project Governance</span>
        <Pill tone={governance.tone || statusTone(governance.status)}>{governance.score || governance.status || "watch"}</Pill>
      </div>
      <p>{governance.summary}</p>
      <div className="governance-grid">
        {domains.slice(0, 4).map((domain) => (
          <div key={domain.id} className={`governance-domain ${domain.status}`}>
            <div>
              <strong>{domain.label}</strong>
              <span>{domain.status}</span>
            </div>
            <small>{domain.detail}</small>
            {domain.nextAction ? <em>{domain.nextAction}</em> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function GovernanceSpecPanel({ spec }) {
  if (!spec?.requirements?.length) return null;
  const bad = spec.requirements.filter((item) => item.status === "bad");
  const warn = spec.requirements.filter((item) => item.status === "warn");
  const ordered = [...bad, ...warn, ...spec.requirements.filter((item) => item.status === "ok")].slice(0, 4);
  return (
    <section className="insight-section governance-spec-section" data-governance-spec={spec.schemaVersion || "governance-spec"}>
      <div className="insight-heading">
        <span>Governance Spec</span>
        <Pill tone={spec.status === "blocked" ? "bad" : spec.status === "watch" ? "warn" : "ok"}>{spec.score || spec.status || "spec"}</Pill>
      </div>
      <p>{spec.purpose || "AI-native development contract for this project."}</p>
      <div className="spec-requirements">
        {ordered.map((item) => (
          <div key={item.id} className={`spec-requirement ${item.status}`}>
            <div>
              <strong>{item.id.replace(/_/g, " ")}</strong>
              <span>{item.status}</span>
            </div>
            <small>{item.statement}</small>
            {item.acceptance ? <em>{item.acceptance}</em> : null}
            <div className="spec-evidence">
              {(item.evidence || []).slice(0, 3).map((ref, index) => (
                <span key={`${item.id}-${ref}-${index}`} title={ref}>{ref}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {spec.influences?.length ? (
        <div className="spec-influences">
          {spec.influences.slice(0, 4).map((item) => (
            <span key={item.name} title={item.pattern}>{item.name}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ContinuityContractPanel({ contract }) {
  if (!contract) return null;
  const capabilities = contract.capabilities || [];
  const proof = contract.proofChecklist || [];
  const resume = contract.resume || {};
  return (
    <section className="insight-section contract-section" data-continuity-contract={contract.contractId || "contract"}>
      <div className="insight-heading">
        <span>Continuity Contract</span>
        <Pill tone={contract.status === "blocked" ? "bad" : contract.status === "ready_with_warnings" ? "warn" : "ok"}>
          {contract.status || "unknown"}
        </Pill>
      </div>
      <div className="contract-id-row">
        <strong>{contract.contractId || "contract"}</strong>
        <span>{contract.entrypoint || ".project-agent/continuity-contract.json"}</span>
      </div>
      {resume.current ? (
        <div className="contract-resume">
          <span>Resume</span>
          <strong>{resume.current.title}</strong>
          <small>{[resume.current.phase, resume.current.status, resume.activeWorkstream?.label].filter(Boolean).join(" · ")}</small>
        </div>
      ) : null}
      {capabilities.length ? (
        <div className="contract-capabilities">
          {capabilities.slice(0, 4).map((item) => (
            <div key={item.id} className={`contract-capability ${item.status}`}>
              <strong>{item.label}</strong>
              <span>{item.status}</span>
              <small>{item.summary}</small>
            </div>
          ))}
        </div>
      ) : null}
      {proof.length ? (
        <div className="contract-proof">
          {proof.slice(0, 4).map((item) => (
            <span key={item.id} title={item.statement}>{item.id}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MemoryGraph({ graph }) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const total = graph?.totalCount ?? nodes.length;
  const ready = graph?.readyCount ?? nodes.filter((node) => node.status !== "pending").length;
  const importantIds = new Set(["project", "kernel", "goal", "memory", "session", "architecture", "evidence", "handoff"]);
  const byKind = (kind) => nodes.filter((node) => node.kind === kind);
  const displayNodes = [
    ...["project", "kernel", "goal"].map((id) => nodes.find((node) => node.id === id)).filter(Boolean),
    ...byKind("kernelConcept").slice(0, 4),
    ...byKind("workstream").slice(0, 3),
    ...["session", "event"].flatMap((kind) => byKind(kind).filter((node) => node.status === "current").slice(0, kind === "event" ? 2 : 1)),
    nodes.find((node) => node.id === "architecture"),
    ...byKind("file").slice(0, 3),
    nodes.find((node) => node.id === "memory"),
    ...byKind("evidence").slice(0, 1),
    ...byKind("acceptance").slice(0, 1),
    nodes.find((node) => node.id === "handoff")
  ].filter(Boolean).filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index);
  const hidden = Math.max(0, nodes.length - displayNodes.length);
  const laneConfig = [
    { key: "foundation", y: 54, nodes: displayNodes.filter((node) => ["project", "kernel", "goal"].includes(node.id)) },
    { key: "kernel", y: 124, nodes: displayNodes.filter((node) => node.kind === "kernelConcept") },
    { key: "runtime", y: 194, nodes: displayNodes.filter((node) => node.kind === "workstream" || node.kind === "session" || node.kind === "event") },
    { key: "artifacts", y: 264, nodes: displayNodes.filter((node) => node.id === "architecture" || node.kind === "file") },
    { key: "proof", y: 334, nodes: displayNodes.filter((node) => node.kind === "memory" || node.kind === "evidence" || node.kind === "acceptance" || node.kind === "handoff") }
  ].filter((lane) => lane.nodes.length);
  const placedNodes = laneConfig.flatMap((lane) =>
    lane.nodes.map((node, index) => ({
      ...node,
      x: Math.round(((index + 1) * 420) / (lane.nodes.length + 1)),
      y: lane.y
    }))
  );
  const nodeById = Object.fromEntries(placedNodes.map((node) => [node.id, node]));
  const selectedNode = placedNodes.find((node) => node.id === selectedNodeId) || placedNodes.find((node) => node.id === "goal") || placedNodes[0];
  const selectedEdges = edges
    .map((rawEdge) => ({
      id: rawEdge.id || `${rawEdge.source || rawEdge[0]}-${rawEdge.target || rawEdge[1]}`,
      source: Array.isArray(rawEdge) ? rawEdge[0] : rawEdge.source,
      target: Array.isArray(rawEdge) ? rawEdge[1] : rawEdge.target,
      label: Array.isArray(rawEdge) ? "relates" : rawEdge.label,
      provenance: Array.isArray(rawEdge) ? [] : rawEdge.provenance || []
    }))
    .filter((edgeItem) => edgeItem.source === selectedNode?.id || edgeItem.target === selectedNode?.id)
    .slice(0, 5);
  const selectedRefs = [...new Set([...(selectedNode?.provenance || []), ...selectedEdges.flatMap((edgeItem) => edgeItem.provenance || [])].filter(Boolean))].slice(0, 8);
  const visibleLabel = (node) => {
    if (node.kind === "acceptance") return node.id;
    if (node.kind === "file") return node.label.split("/").pop();
    if (node.kind === "evidence") return "Evidence";
    if (node.kind === "memory" && node.id !== "memory") return "Memory";
    if (node.kind === "architecture") return "Architecture";
    if (node.kind === "kernelConcept") return node.label;
    if (node.kind === "workstream") return node.label;
    if (node.kind === "project") return "Project";
    if (node.kind === "handoff") return "Handoff";
    if (node.kind === "goal") return "Goal";
    return node.label;
  };
  const compact = (value, max = 16) => {
    const text = String(value || "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  return (
    <section className="insight-section graph-section">
      <div className="insight-heading">
        <span>Memory Knowledge Graph</span>
        <Pill>{ready}/{total}{hidden ? ` · ${placedNodes.length} shown` : ""}</Pill>
      </div>
      <svg className="memory-graph" viewBox="0 0 420 390" role="img" aria-label="Project memory knowledge graph">
        {laneConfig.map((lane) => (
          <line key={lane.key} x1="16" y1={lane.y + 35} x2="404" y2={lane.y + 35} className="graph-lane" />
        ))}
        {edges.map((rawEdge) => {
          const from = Array.isArray(rawEdge) ? rawEdge[0] : rawEdge.source;
          const to = Array.isArray(rawEdge) ? rawEdge[1] : rawEdge.target;
          const a = nodeById[from];
          const b = nodeById[to];
          if (!a || !b) return null;
          return (
            <g key={rawEdge.id || `${from}-${to}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="graph-edge" />
            </g>
          );
        })}
        {placedNodes.map((node) => (
          <g
            key={node.id}
            className={`graph-node ${node.status} ${node.kind || ""} ${selectedNode?.id === node.id ? "selected" : ""}`}
            role="button"
            tabIndex={0}
            data-node-id={node.id}
            aria-label={`Inspect ${node.label}`}
            onClick={() => setSelectedNodeId(node.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") setSelectedNodeId(node.id);
            }}
          >
            <rect x={node.x - 39} y={node.y - 18} width="78" height="38" rx="7" />
            <title>{`${node.label}${node.provenance?.length ? ` · ${node.provenance.join(", ")}` : ""}`}</title>
            <text x={node.x} y={node.y - 2} textAnchor="middle">
              {compact(visibleLabel(node))}
            </text>
            <text x={node.x} y={node.y + 14} textAnchor="middle" className="graph-meta">
              {compact(importantIds.has(node.id) ? node.kind || node.meta : node.meta, 18)}
            </text>
          </g>
        ))}
      </svg>
      {selectedNode ? (
        <div className="graph-inspector">
          <div className="graph-inspector-title">
            <div>
              <strong>{selectedNode.label}</strong>
              <span>{[selectedNode.kind, selectedNode.status, selectedNode.meta].filter(Boolean).join(" · ")}</span>
            </div>
            <Pill tone={statusTone(selectedNode.status)}>{selectedNode.kind || "node"}</Pill>
          </div>
          {selectedEdges.length ? (
            <div className="graph-relations">
              {selectedEdges.map((edgeItem) => {
                const neighborId = edgeItem.source === selectedNode.id ? edgeItem.target : edgeItem.source;
                const neighbor = nodes.find((node) => node.id === neighborId);
                return (
                  <span key={edgeItem.id} title={edgeItem.provenance?.join(", ")}>
                    {edgeItem.source === selectedNode.id ? "to" : "from"} {neighbor?.label || neighborId} · {edgeItem.label}
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="graph-provenance">
            {selectedRefs.length ? selectedRefs.map((ref, index) => <span key={`${ref}-${index}`}>{ref}</span>) : <span>no provenance</span>}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function KernelPanel({ kernel }) {
  if (!kernel) return null;
  const rows = [
    ["Philosophy", kernel.philosophy],
    ["Strategy", kernel.strategy],
    ["Architecture", kernel.architecture],
    ["Quality", kernel.quality]
  ].filter(([, items]) => items?.length);
  if (!rows.length) return null;
  return (
    <section className="insight-section kernel-section">
      <div className="insight-heading">
        <span>Project Kernel</span>
        <Pill tone="ok">docs</Pill>
      </div>
      <div className="kernel-grid">
        {rows.map(([label, items]) => (
          <div key={label} className="kernel-row">
            <span>{label}</span>
            <strong>{items[0]}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function GovernanceKernelPanel({
  state,
  processTrace,
  memoryGraph,
  architectureMap,
  continuity,
  continuityContract,
  takeoverAcceptanceAudit,
  governanceSpec,
  developmentTrail
}) {
  const contextBundle = continuity?.agentContextBundle || null;
  const stateManifest = contextBundle?.validation?.stateManifest || continuity?.stateManifest || null;
  const disclosureGate = contextBundle?.validation?.disclosureGate || null;
  const provenanceLedger = contextBundle?.validation?.provenanceLedger || null;
  const stateBoundary = continuity?.stateBoundary || contextBundle?.validation?.stateBoundary || continuity?.continuityContract?.stateBoundary || null;
  const decisionLedger = continuity?.decisionLedger || contextBundle?.validation?.decisionLedger || continuity?.continuityContract?.decisionLedger || null;
  const codeGraph = continuity?.codeGraph || contextBundle?.architecture?.codeGraph || architectureMap?.codeGraph || continuity?.architectureTrace?.codeGraph || null;
  const attentionPack = contextBundle?.validation?.attentionPack || null;
  const freshnessGate = continuity?.freshnessGate || contextBundle?.validation?.freshnessGate || continuity?.continuityContract?.freshnessGate || null;
  const phaseLedger = continuity?.phaseLedger || contextBundle?.validation?.phaseLedger || continuity?.continuityContract?.phaseLedger || null;
  const checkpointLedger = continuity?.checkpointLedger || contextBundle?.validation?.checkpointLedger || continuity?.continuityContract?.checkpointLedger || null;
  const runtimeEval = continuity?.runtimeEval || contextBundle?.validation?.runtimeEval || continuity?.continuityContract?.runtimeEval || null;
  const hookIngressAudit = continuity?.hookIngressAudit || contextBundle?.validation?.hookIngressAudit || continuity?.continuityContract?.hookIngressAudit || null;
  const preEditRisk = continuity?.preEditRisk || contextBundle?.validation?.preEditRisk || null;
  const sourceFiles = contextBundle?.validation?.sourceFiles || stateManifest?.files || [];
  const memoryNodes = memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0;
  const memoryEdges = memoryGraph?.edgeCount || memoryGraph?.edges?.length || 0;
  const processEvents = processTrace?.events?.length || continuity?.recentEvents?.length || state?.events?.length || 0;
  const changedFiles = architectureMap?.recentChanges?.length || architectureMap?.changes?.length || continuity?.changedFiles?.length || 0;
  const architectureFiles = architectureMap?.totals?.files || architectureMap?.files?.length || 0;
  const handoffReady = takeoverAcceptanceAudit?.status === "pass" || takeoverAcceptanceAudit?.canResume || continuity?.continuityAudit?.canResume;
  const lanes = [
    {
      id: "capture",
      label: "Capture",
      metric: phaseLedger?.spanCount ? `${phaseLedger.linkedCount || 0}/${phaseLedger.spanCount} linked` : hookIngressAudit?.acceptedEvents ? `${hookIngressAudit.acceptedEvents} hook(s)` : runtimeEval?.score ? `${runtimeEval.score} trace` : `${processEvents} event(s)`,
      detail: phaseLedger?.summary || (hookIngressAudit?.acceptedEvents ? hookIngressAudit.summary : runtimeEval?.summary || processTrace?.current?.title || continuity?.processCursor?.title || "runtime observations"),
      source: phaseLedger?.schemaVersion ? ".project-agent/continuity.json#phaseLedger" : hookIngressAudit?.acceptedEvents ? "/api/hooks" : ".project-agent/runtime.json",
      tone: phaseLedger ? phaseTone(phaseLedger.status) : hookIngressAudit?.acceptedEvents ? hookTone(hookIngressAudit.status) : runtimeEval ? evalTone(runtimeEval.status) : processEvents ? "ok" : "warn"
    },
    {
      id: "curate",
      label: "Curate",
      metric: decisionLedger?.decisionCount ? `${decisionLedger.validCount || 0}/${decisionLedger.decisionCount} decisions` : `${memoryNodes} node(s)`,
      detail: decisionLedger?.summary || `${memoryEdges} link(s), ${memoryGraph?.provenanceCoverage || "provenance pending"}`,
      source: decisionLedger?.schemaVersion ? ".project-agent/continuity.json#decisionLedger" : ".project-agent/memory-graph.json",
      tone: decisionLedger ? decisionTone(decisionLedger.status) : memoryNodes ? "ok" : "warn"
    },
    {
      id: "retrieve",
      label: "Retrieve",
      metric: attentionPack?.budget?.items ? `${attentionPack.budget.items} focus` : preEditRisk?.status ? `${preEditRisk.status} risk` : `${architectureFiles} file(s)`,
      detail: attentionPack?.summary || preEditRisk?.summary || developmentTrail?.fileCoverage || `${changedFiles} changed`,
      source: ".project-agent/agent-context-bundle.json",
      tone: attentionPack ? attentionTone(attentionPack.status) : preEditRisk ? riskTone(preEditRisk.status) : architectureFiles ? "ok" : "warn"
    },
    {
      id: "verify",
      label: "Verify",
      metric: stateBoundary?.totals ? `${stateBoundary.totals.sourceRefs || 0}/${stateBoundary.totals.derivedIndexes || 0} boundary` : provenanceLedger?.coverage?.hashedCoverage ? `${provenanceLedger.coverage.hashedCoverage} hashes` : freshnessGate?.status ? `${freshnessGate.status} freshness` : stateManifest?.fileCount ? `${stateManifest.fileCount} source(s)` : governanceSpec?.score || "gate",
      detail: stateBoundary?.summary || provenanceLedger?.summary || freshnessGate?.summary || (stateManifest?.missing?.length ? `${stateManifest.missing.length} missing` : "manifest and audit proof"),
      source: stateBoundary ? ".project-agent/continuity.json#stateBoundary" : ".project-agent/state-manifest.json",
      tone: stateBoundary ? boundaryTone(stateBoundary.status) : provenanceLedger ? provenanceTone(provenanceLedger.status) : freshnessGate ? freshnessTone(freshnessGate.status) : stateManifest?.missing?.length ? "bad" : sourceFiles.length ? "ok" : "warn"
    },
    {
      id: "disclose",
      label: "Disclose",
      metric: disclosureGate?.budget?.estimatedTokens ? `${disclosureGate.budget.estimatedTokens} tokens` : handoffReady ? "resume" : "handoff check",
      detail: disclosureGate?.summary || contextBundle?.quickStart?.nextCommand || continuity?.takeoverPacket?.nextCommand || "agent-neutral start",
      source: ".project-agent/agent-context-bundle.json",
      tone: disclosureGate ? gateTone(disclosureGate.status) : handoffReady ? "ok" : "warn"
    }
  ];
  const readyLanes = lanes.filter((lane) => lane.tone === "ok").length;
  const hot = [
    state?.activeGoal,
    processTrace?.current || continuity?.processCursor,
    attentionPack,
    changedFiles ? architectureMap : null,
    contextBundle?.quickStart?.nextCommand
  ].filter(Boolean).length;
  const warm = [memoryGraph, developmentTrail, governanceSpec, continuityContract].filter(Boolean).length;
  const cold = [stateManifest, continuity?.resumeBrief || continuity?.resume, continuity?.recoveryBrief || continuity?.recovery, continuity?.runtime].filter(Boolean).length;

  return (
    <section className="insight-section governance-kernel" data-governance-kernel="adopted-architecture-patterns">
      <div className="insight-heading">
        <span>Governance Kernel</span>
        <Pill tone={readyLanes === lanes.length ? "ok" : "warn"}>{readyLanes}/{lanes.length}</Pill>
      </div>
      <div className="kernel-lanes">
        {lanes.map((lane) => (
          <div key={lane.id} className={`kernel-lane ${lane.tone}`}>
            <span>{lane.label}</span>
            <strong title={lane.metric}>{lane.metric}</strong>
            <small title={lane.detail}>{lane.detail}</small>
            <em title={lane.source}>{lane.source}</em>
          </div>
        ))}
      </div>
      <div className="kernel-tier-grid" data-memory-tiers="hot-warm-cold">
        {[
          ["Hot", hot, "goal · now · changed"],
          ["Warm", warm, "graph · trail · contract"],
          ["Cold", cold, "manifest · recovery · logs"]
        ].map(([label, count, detail]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <div className="pattern-matrix">
        {adoptedArchitecturePatterns.map((item) => (
          <div key={item.id} className="pattern-row">
            <span>{item.source}</span>
            <strong>{item.pattern}</strong>
            <small title={item.product}>{item.product}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function eventLabel(event) {
  if (!event) return "Waiting";
  return event.title || event.label || event.phase || "Event";
}

function eventDetail(event) {
  if (!event) return "No event yet";
  return event.detail || event.body || "";
}

function WorkstreamPanel({ process }) {
  const workstreams = process?.workstreams;
  const lanes = workstreams?.lanes || [];
  if (!lanes.length) return null;
  const active = workstreams.active || process?.workstream;
  return (
    <section className="insight-section workstream-section">
      <div className="insight-heading">
        <span>Workstream Recognition</span>
        <Pill tone={active ? "ok" : "muted"}>{active?.label || "waiting"}</Pill>
      </div>
      <div className="workstream-grid">
        {lanes.map((lane) => (
          <div key={lane.id} className={`workstream-lane ${lane.status}`}>
            <strong>{lane.label}</strong>
            <span>{lane.count || 0} event(s)</span>
            <small>{lane.latestTitle || lane.description}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function DevelopmentTrailPanel({ trail }) {
  if (!trail?.steps?.length) return null;
  const tone = trail.status === "linked" ? "ok" : trail.status === "missing" ? "bad" : "warn";
  return (
    <div className="development-trail" data-development-trail="process-to-architecture">
      <div className="development-trail-title">
        <div>
          <strong>Development Trail</strong>
          <span>{trail.fileCoverage || "0/0"} · {trail.summary || "Process steps linked to files and architecture."}</span>
        </div>
        <Pill tone={tone}>{trail.status || "watch"}</Pill>
      </div>
      <div className="development-trail-steps">
        {trail.steps.slice(0, 5).map((step) => {
          const stepTone = step.risk === "high" ? "bad" : step.risk === "medium" || step.status === "current" ? "warn" : "ok";
          return (
            <div key={`${step.label}-${step.id}`} className={`development-step ${stepTone}`}>
              <span>{step.label || step.phase}</span>
              <strong title={step.title}>{step.title}</strong>
              <small title={step.detail || step.nextAction}>{step.nextAction || step.detail || "Review before editing."}</small>
              <div className="development-links">
                {(step.folders || []).slice(0, 3).map((folder) => (
                  <em key={`folder-${folder.folder}`} title={folder.summary}>folder: {folder.folder}</em>
                ))}
                {(step.files || []).slice(0, 4).map((file) => (
                  <em key={`file-${file.path}`} title={file.summary || file.path}>{file.status || "file"}: {file.path}</em>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {trail.inspectOrder?.length ? (
        <div className="development-inspect-order">
          {trail.inspectOrder.slice(0, 8).map((item) => (
            <span key={`${item.type}-${item.id || item.path}`} title={item.reason || item.title || item.path}>
              {item.type}: {item.title || item.path || item.id}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProcessTimeline({ process, steps = [], developmentTrail = null }) {
  const [selectedKey, setSelectedKey] = useState("");
  const current = process?.current || steps.find((step) => step.status === "current") || steps[steps.length - 1];
  const previous = process?.previous || null;
  const next = process?.next || steps.find((step) => step.status === "pending") || null;
  const events = process?.events || [];
  const cursorItems = [
    { key: "cursor:previous", label: "Previous", item: previous, tone: "muted" },
    { key: "cursor:current", label: "Now", item: current, tone: "current" },
    { key: "cursor:next", label: "Next", item: next, tone: "" }
  ];
  const phaseItems = steps.map((step) => ({
    key: `phase:${step.id}`,
    label: step.label,
    item: step,
    tone: step.status
  }));
  const eventItems = events.slice(0, 5).map((event) => ({
    key: `event:${event.id}`,
    label: event.workstream?.label || event.phase,
    item: event,
    tone: event.status
  }));
  const activeKey = selectedKey || "cursor:current";
  const activeItem =
    [...cursorItems, ...phaseItems, ...eventItems].find((entry) => entry.key === activeKey) ||
    cursorItems.find((entry) => entry.key === "cursor:current") ||
    eventItems[0] ||
    phaseItems[0];
  const active = activeItem?.item;
  const activeRefs = [
    ...(active?.refs || []),
    ...(active?.files || []).map((file) => file.path),
    ...(active?.provenance || [])
  ].filter(Boolean);
  return (
    <section className="insight-section">
      <div className="insight-heading">
        <span>Live Process</span>
        <Pill>{current?.workstream?.label || current?.phase || current?.id || "steady"}</Pill>
      </div>
      <div className="process-flowchart" data-process-flow="previous-current-next">
        {cursorItems.map((entry, index) => (
          <div key={entry.key} className="process-flow-slot">
            <button
              type="button"
              className={`process-node ${entry.tone} ${activeKey === entry.key ? "selected" : ""}`}
              onClick={() => setSelectedKey(entry.key)}
              data-process-card={entry.key}
            >
              <span>{entry.label}</span>
              <strong>{eventLabel(entry.item)}</strong>
              <small>{eventDetail(entry.item)}</small>
            </button>
            {index < cursorItems.length - 1 ? <div className="process-arrow" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>
      <div className="phase-rail">
        {steps.map((step) => (
          <button
            type="button"
            key={step.id}
            className={`phase-dot ${step.status} ${activeKey === `phase:${step.id}` ? "selected" : ""}`}
            onClick={() => setSelectedKey(`phase:${step.id}`)}
            data-process-phase={step.id}
          >
            <span>{step.label}</span>
          </button>
        ))}
      </div>
      {events.length ? (
        <div className="event-stream">
          {events.slice(0, 5).map((event) => (
            <button
              type="button"
              key={event.id}
              className={`event-row ${event.status} ${activeKey === `event:${event.id}` ? "selected" : ""}`}
              onClick={() => setSelectedKey(`event:${event.id}`)}
              data-process-event={event.id}
            >
              <span>{event.workstream?.label || event.phase}</span>
              <strong>{event.title}</strong>
              <small>{event.detail}</small>
            </button>
          ))}
        </div>
      ) : null}
      {active ? (
        <div className="process-inspector">
          <div className="process-inspector-title">
            <div>
              <strong>{eventLabel(active)}</strong>
              <span>{[active.phase || active.id, active.status, active.workstream?.label].filter(Boolean).join(" · ")}</span>
            </div>
            <Pill tone={statusTone(active.status)}>{activeItem?.label || "event"}</Pill>
          </div>
          <p>{eventDetail(active)}</p>
          <div className="process-inspector-refs">
            {activeRefs.length ? activeRefs.slice(0, 8).map((ref, index) => <span key={`${ref}-${index}`}>{ref}</span>) : <span>no refs</span>}
          </div>
          {active.files?.length ? (
            <div className="process-files">
              {active.files.slice(0, 6).map((file) => (
                <span key={file.path}>{file.status || "file"} {file.path} {file.summary || ""}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <DevelopmentTrailPanel trail={developmentTrail} />
    </section>
  );
}

function architectureFolderForPath(relPath) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  if (parts[0] === "docs" && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === ".project-agent") return ".project-agent";
  return parts[0];
}

function TreeNode({ node, depth = 0, selectedKey, onSelect }) {
  if (depth > 3) return null;
  const children = (node.children || []).slice(0, depth >= 2 ? 4 : 8);
  const key = `${node.type}:${node.path}`;
  return (
    <div className={`tree-node ${node.type} ${node.status || "unchanged"}`}>
      <button
        type="button"
        className={`tree-row ${selectedKey === key ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect?.(key)}
        data-arch-path={node.path}
      >
        <FileText size={13} />
        <span title={node.path}>{node.name}</span>
        {node.status && node.status !== "unchanged" ? <Pill tone={node.status === "deleted" ? "bad" : "warn"}>{node.status}</Pill> : null}
      </button>
      {children.length ? (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArchitecturePanel({ architecture }) {
  const [selectedKey, setSelectedKey] = useState("");
  if (!architecture) return null;
  const changes = architecture.recentChanges || architecture.changes || [];
  const impactFolders = architecture.impact?.topFolders || architecture.impact?.folders || [];
  const inspectOrder = architecture.inspectOrder || architecture.trace?.inspectOrder || [];
  const filesByPath = new Map((architecture.files || []).map((file) => [file.path, file]));
  const changesByPath = new Map(changes.map((file) => [file.path, file]));
  const folderByPath = new Map(impactFolders.map((folder) => [folder.folder, folder]));
  const fallbackKey = impactFolders[0]?.folder ? `folder:${impactFolders[0].folder}` : changes[0]?.path ? `file:${changes[0].path}` : architecture.tree?.[0] ? `${architecture.tree[0].type}:${architecture.tree[0].path}` : "";
  const activeKey = selectedKey || fallbackKey;
  const [activeType, activePath] = activeKey.split(/:(.*)/).filter(Boolean);
  const activeFolder = activeType === "folder" ? folderByPath.get(activePath) : null;
  const activeFile = activeType === "file" ? changesByPath.get(activePath) || filesByPath.get(activePath) : filesByPath.get(activePath);
  const activeTreeNode = !activeFolder && !activeFile ? { type: activeType, path: activePath } : null;
  const relatedChanges = activeFolder
    ? changes.filter((change) => architectureFolderForPath(change.path) === activeFolder.folder).slice(0, 6)
    : activeFile
      ? [changesByPath.get(activeFile.path) || activeFile].filter(Boolean)
      : [];
  const activeTitle = activeFolder?.folder || activeFile?.path || activeTreeNode?.path || architecture.root || "Architecture";
  const activeStatus = activeFolder
    ? activeFolder.deleted
      ? "deleted"
      : activeFolder.modified
        ? "modified"
        : activeFolder.added
          ? "added"
          : "changed"
    : activeFile?.status || "unchanged";
  const activeDetail = activeFolder
    ? activeFolder.summary || `${activeFolder.files || 0} file(s)`
    : activeFile
      ? [activeFile.kind, activeFile.summary, activeFile.modifiedAt].filter(Boolean).join(" · ")
      : activeTreeNode?.type || "project tree";
  return (
    <section className="insight-section architecture-section">
      <div className="insight-heading">
        <span>Project Architecture</span>
        <Pill tone={architecture.totals?.changed ? "warn" : "ok"}>{architecture.totals?.files || 0} files</Pill>
      </div>
      {inspectOrder.length ? (
        <div className="architecture-inspect-flow" data-architecture-flow="inspect-order">
          {inspectOrder.slice(0, 5).map((item, index) => (
            <button
              type="button"
              key={`${item.type || "file"}-${item.path}`}
              className={`architecture-inspect-step ${item.status || "changed"} ${activeKey === `${item.type || "file"}:${item.path}` ? "selected" : ""}`}
              onClick={() => setSelectedKey(`${item.type === "folder" ? "folder" : "file"}:${item.path}`)}
              title={item.reason || item.path}
            >
              <span>{index + 1}</span>
              <strong>{item.path === "." ? "repo root" : item.path}</strong>
              <small>{item.type || "file"} · {item.status || "inspect"}</small>
            </button>
          ))}
        </div>
      ) : null}
      {impactFolders.length ? (
        <div className="architecture-impact">
          {impactFolders.slice(0, 4).map((folder) => (
            <button
              type="button"
              key={folder.folder}
              className={`impact-row ${activeKey === `folder:${folder.folder}` ? "selected" : ""}`}
              onClick={() => setSelectedKey(`folder:${folder.folder}`)}
              data-arch-folder={folder.folder}
            >
              <strong>{folder.folder === "." ? "repo root" : folder.folder}</strong>
              <span>{folder.summary}</span>
              <small title={folder.latestFile}>
                {(folder.kinds || []).join(", ")} {folder.latestFile ? `· ${folder.latestFile}` : ""}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="module-strip">
        {(architecture.modules || []).slice(0, 5).map((module) => (
          <span key={module.kind}>
            {module.kind} <b>{module.count}</b>
          </span>
        ))}
      </div>
      <div className="architecture-tree">
        {(architecture.tree || []).slice(0, 6).map((node) => (
          <TreeNode key={node.path} node={node} selectedKey={activeKey} onSelect={setSelectedKey} />
        ))}
      </div>
      {changes.length ? (
        <div className="change-list">
          {changes.slice(0, 5).map((change) => (
            <button
              type="button"
              key={`${change.status}-${change.path}`}
              className={`change-row ${change.status} ${activeKey === `file:${change.path}` ? "selected" : ""}`}
              onClick={() => setSelectedKey(`file:${change.path}`)}
              data-arch-change={change.path}
            >
              <span>{change.status}</span>
              <strong title={change.path}>{change.path}</strong>
              {change.summary ? <small>{change.summary}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="architecture-inspector">
        <div className="architecture-inspector-title">
          <div>
            <strong title={activeTitle}>{activeTitle === "." ? "repo root" : activeTitle}</strong>
            <span>{activeDetail || "No detail captured"}</span>
          </div>
          <Pill tone={activeStatus === "deleted" ? "bad" : activeStatus === "unchanged" ? "muted" : "warn"}>{activeStatus}</Pill>
        </div>
        <div className="architecture-inspector-facts">
          {activeFolder ? <span>{activeFolder.files || 0} file(s)</span> : null}
          {activeFolder ? <span>+{activeFolder.additions || 0}/-{activeFolder.deletions || 0}</span> : null}
          {activeFile?.lineCount ? <span>{activeFile.lineCount} lines</span> : null}
          {activeFile?.hash ? <span>{activeFile.hash}</span> : null}
          {activeFile?.kind ? <span>{activeFile.kind}</span> : null}
        </div>
        {relatedChanges.length ? (
          <div className="architecture-related">
            {relatedChanges.map((change) => (
              <span key={`${change.status}-${change.path}`} title={change.path}>
                {change.status || "file"} {change.path} {change.summary || ""}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ObjectiveCoveragePanel({ coverage }) {
  if (!coverage) return null;
  const tone = coverage.status === "blocked" ? "bad" : coverage.status === "watch" ? "warn" : "ok";
  const order = { bad: 0, warn: 1, watch: 1, ok: 2, pass: 2, ready: 2 };
  const requirements = [...(coverage.requirements || [])].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).slice(0, 6);
  const proofSources = [...(coverage.proofSources || [])].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).slice(0, 8);
  const summary = coverage.summary || "Tracks whether memory, process, architecture, and handoff are proven by durable state.";

  return (
    <div className="objective-coverage" data-objective-coverage=".project-agent/agent-context-bundle.json">
      <div className="objective-coverage-title">
        <div>
          <strong>Objective Coverage</strong>
          <span>{coverage.score || "0/0"} · {summary}</span>
        </div>
        <Pill tone={tone}>{coverage.status || "watch"}</Pill>
      </div>
      {requirements.length ? (
        <div className="coverage-requirements">
          {requirements.map((item) => {
            const itemTone = item.status === "bad" || item.status === "blocked" ? "bad" : item.status === "ok" || item.status === "ready" || item.status === "pass" ? "ok" : "warn";
            const refs = item.refs || item.evidence || [];
            return (
              <div key={item.id || item.label} className={`coverage-row ${itemTone}`}>
                <span>{item.status || "watch"}</span>
                <strong title={item.id || item.label}>{item.label || item.id}</strong>
                <small title={item.detail || item.nextAction || ""}>{item.detail || item.nextAction || "Waiting for stronger proof."}</small>
                {refs.length ? (
                  <div className="coverage-refs">
                    {refs.slice(0, 3).map((ref, index) => (
                      <em key={`${ref}-${index}`} title={ref}>{fileName(ref)}</em>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {proofSources.length ? (
        <div className="coverage-proof-sources">
          {proofSources.map((item) => {
            const itemTone = item.status === "bad" || item.status === "blocked" ? "bad" : item.status === "ok" || item.status === "ready" || item.status === "pass" ? "ok" : "warn";
            return (
              <span key={item.id || item.label} className={itemTone} title={item.detail || item.id}>
                {item.label || item.id}: {item.status || "watch"}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TakeoverAcceptancePanel({ audit }) {
  if (!audit) return null;
  const tone = audit.status === "fail" ? "bad" : audit.status === "warn" ? "warn" : "ok";
  const rows = [
    ...(audit.rows || []).filter((item) => item.status === "bad"),
    ...(audit.rows || []).filter((item) => item.status === "warn"),
    ...(audit.rows || []).filter((item) => item.status === "ok")
  ].slice(0, 8);
  const primaryIds = [
    "memory_visible_knowledge_graph",
    "process_dynamic_previous_current_next",
    "architecture_visible_managed",
    "agent_neutral_handoff"
  ];
  const primaryRows = primaryIds
    .map((id) => (audit.rows || []).find((item) => item.id === id))
    .filter(Boolean);
  const labelFor = (id) =>
    ({
      memory_visible_knowledge_graph: "Memory is visible",
      process_dynamic_previous_current_next: "Process is live",
      architecture_visible_managed: "Architecture is managed",
      agent_neutral_handoff: "Agent can resume"
    })[id] || cleanLabel(id);
  return (
    <div className="takeover-acceptance" data-takeover-acceptance=".project-agent/takeover-acceptance-audit.json">
      <div className="takeover-acceptance-title">
        <div>
          <strong>Takeover Acceptance</strong>
          <span>{audit.score || "0/0"} · {audit.summary || "User objective acceptance audit."}</span>
        </div>
        <Pill tone={tone}>{audit.status === "pass" ? "accepted" : audit.status === "warn" ? "watch" : "not accepted"}</Pill>
      </div>
      <div className="acceptance-source">
        <span>source</span>
        <code>.project-agent/takeover-acceptance-audit.json</code>
      </div>
      <div className="acceptance-core-grid">
        {primaryRows.map((item) => {
          const rowTone = item.status === "bad" ? "bad" : item.status === "warn" ? "warn" : "ok";
          return (
            <div key={item.id} className={`acceptance-core-card ${rowTone}`}>
              <span>{item.status}</span>
              <strong>{labelFor(item.id)}</strong>
              <small title={item.detail || item.nextAction}>{item.detail || item.nextAction}</small>
            </div>
          );
        })}
      </div>
      <DetailDisclosure title="Acceptance proof rows" meta={audit.score || `${rows.length} checks`}>
        <div className="acceptance-rows">
          {rows.map((item) => {
            const rowTone = item.status === "bad" ? "bad" : item.status === "warn" ? "warn" : "ok";
            return (
              <div key={item.id} className={`acceptance-row ${rowTone}`}>
                <span>{item.status}</span>
                <strong title={item.requirement}>{item.id}</strong>
                <small title={item.detail || item.nextAction}>{item.detail || item.nextAction}</small>
                {item.refs?.length ? (
                  <div className="acceptance-refs">
                    {item.refs.slice(0, 4).map((ref, index) => (
                      <em key={`${ref}-${index}`} title={ref}>{fileName(ref)}</em>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </DetailDisclosure>
    </div>
  );
}

function ContinuityPanel({ continuity }) {
  if (!continuity?.stateRefs?.length) return null;
  const agents = continuity.agentLeases || [];
  const snapshot = continuity.handoffSnapshot;
  const readiness = continuity.takeoverReadiness;
  const startProtocol = continuity.startProtocol;
  const drill = continuity.takeoverDrill;
  const runbook = continuity.agentRunbook || continuity.continuityContract?.agentRunbook;
  const handoffLifecycle = continuity.handoffLifecycle || continuity.continuityContract?.handoffLifecycle;
  const interrupted = continuity.interruptedWork || continuity.continuityContract?.agentState?.interruptedWork;
  const interruptedItems = interrupted?.items || [];
  const takeoverPacket = continuity.takeoverPacket || drill?.nextAgentBrief;
  const continuityAudit = continuity.continuityAudit || takeoverPacket?.continuityAudit;
  const contextBundle = continuity.agentContextBundle;
  const contextBundleVerification = contextBundle?.validation?.agentContextBundleVerification;
  const disclosureGate = contextBundle?.validation?.disclosureGate;
  const provenanceLedger = contextBundle?.validation?.provenanceLedger;
  const stateBoundary = continuity.stateBoundary || contextBundle?.validation?.stateBoundary || continuity.continuityContract?.stateBoundary;
  const decisionLedger = continuity.decisionLedger || contextBundle?.validation?.decisionLedger || continuity.continuityContract?.decisionLedger;
  const codeGraph = continuity.codeGraph || contextBundle?.architecture?.codeGraph || continuity.architectureMap?.codeGraph || continuity.architectureTrace?.codeGraph;
  const attentionPack = contextBundle?.validation?.attentionPack;
  const freshnessGate = continuity.freshnessGate || contextBundle?.validation?.freshnessGate || continuity.continuityContract?.freshnessGate;
  const phaseLedger = continuity.phaseLedger || contextBundle?.validation?.phaseLedger || continuity.continuityContract?.phaseLedger;
  const checkpointLedger = continuity.checkpointLedger || contextBundle?.validation?.checkpointLedger || continuity.continuityContract?.checkpointLedger;
  const runtimeEval = continuity.runtimeEval || contextBundle?.validation?.runtimeEval || continuity.continuityContract?.runtimeEval;
  const hookIngressAudit = continuity.hookIngressAudit || contextBundle?.validation?.hookIngressAudit || continuity.continuityContract?.hookIngressAudit;
  const preEditRisk = continuity.preEditRisk || contextBundle?.validation?.preEditRisk;
  const objectiveCoverage = contextBundle?.validation?.objectiveCoverage || continuity.objectiveCoverage;
  const takeoverAcceptanceAudit = contextBundle?.validation?.takeoverAcceptanceAudit || continuity.takeoverAcceptanceAudit;
  const stateManifest = continuity.stateManifest;
  const stateManifestVerification = continuityAudit?.stateManifestVerification;
  const readinessChecks = readiness
    ? [
        ...readiness.checks.filter((check) => check.status !== "ok"),
        ...readiness.checks.filter((check) => check.status === "ok")
      ].slice(0, 7)
    : [];
  const drillChecks = drill
    ? [
        ...drill.checks.filter((check) => check.status !== "ok"),
        ...drill.checks.filter((check) => check.status === "ok")
      ].slice(0, 6)
    : [];
  const auditChecks = continuityAudit
    ? [
        ...(continuityAudit.checks || []).filter((check) => check.status === "bad"),
        ...(continuityAudit.checks || []).filter((check) => check.status === "warn"),
        ...(continuityAudit.checks || []).filter((check) => check.status === "ok")
      ].slice(0, 8)
    : [];
  return (
    <section className="insight-section continuity-section">
      <div className="insight-heading">
        <span>Crash Handoff</span>
        <Pill tone={drill ? drillTone(drill.status) : readiness?.tone || "ok"}>{drill?.status || readiness?.status || "ready"}</Pill>
      </div>
      <p>{continuity.activeGoal?.objective || "No active goal yet"}</p>
      {readiness ? (
        <div className="takeover-readiness">
          <div>
            <strong>Takeover Readiness</strong>
            <span>{readiness.score} · {readiness.summary}</span>
          </div>
          <div className="readiness-checks">
            {readinessChecks.map((check) => (
              <span key={check.id} className={check.status} title={check.detail}>
                {check.status} {check.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {contextBundle ? (
        <div className="state-manifest context-bundle" data-agent-context-bundle=".project-agent/agent-context-bundle.json">
          <div className="state-manifest-title">
            <div>
              <strong>Agent Context Bundle</strong>
              <span>{contextBundle.schemaVersion || "context"} · {(contextBundle.contentHash || "").slice(0, 12) || "no hash"}</span>
            </div>
            <Pill tone={contextBundleVerification?.canResume === false ? "bad" : contextBundleVerification?.status === "warn" ? "warn" : "ok"}>
              {contextBundleVerification?.canResume === false ? "blocked" : contextBundleVerification?.status === "warn" ? "verified warn" : "verified"}
            </Pill>
          </div>
          <div className="manifest-files">
            {[
              ["memory", `${contextBundle.memory?.graph?.nodes?.length || 0} nodes`],
              ["process", contextBundle.quickStart?.currentCursor?.title || "current cursor"],
              ["architecture", `${contextBundle.architecture?.map?.files?.length || 0} files`],
              ["graph", codeGraph ? `${codeGraph.status} ${codeGraph.localEdgeCount || 0}/${codeGraph.nodeCount || 0}` : "code graph"],
              ["lifecycle", contextBundle.handoff?.lifecycle?.status || handoffLifecycle?.status || "handoff lifecycle"],
              ["attention", attentionPack ? `${attentionPack.status} ${attentionPack.budget?.estimatedTokens || 0}/${attentionPack.budget?.budgetTokens || 0}` : "attention pack"],
              ["provenance", provenanceLedger ? `${provenanceLedger.status} ${provenanceLedger.coverage?.hashedCoverage || ""}` : "provenance ledger"],
              ["boundary", stateBoundary ? `${stateBoundary.status} ${stateBoundary.totals?.derivedIndexes || 0} indexes` : "state boundary"],
              ["decisions", decisionLedger ? `${decisionLedger.status} ${decisionLedger.validCount || 0}/${decisionLedger.decisionCount || 0}` : "decision ledger"],
              ["freshness", freshnessGate ? `${freshnessGate.status} ${freshnessGate.validity?.validUntil || ""}` : "freshness gate"],
              ["ledger", phaseLedger ? `${phaseLedger.status} ${phaseLedger.linkedCount || 0}/${phaseLedger.spanCount || 0}` : "phase ledger"],
              ["checkpoint", checkpointLedger ? `${checkpointLedger.status} ${checkpointLedger.resumableCount || 0}/${checkpointLedger.checkpointCount || 0}` : "checkpoint ledger"],
              ["trace", runtimeEval ? `${runtimeEval.status} ${runtimeEval.score || ""}` : "runtime eval"],
              ["hooks", hookIngressAudit ? `${hookIngressAudit.status} ${hookIngressAudit.acceptedEvents || 0} accepted` : "hook ingress"],
              ["risk", preEditRisk ? `${preEditRisk.status} ${preEditRisk.score || ""}` : "pre-edit risk"],
              ["bundle", contextBundleVerification?.summary || "bundle-only verification"],
              ["coverage", objectiveCoverage ? `${objectiveCoverage.status} ${objectiveCoverage.score}` : "objective coverage"],
              ["disclosure", disclosureGate ? `${disclosureGate.status} ${disclosureGate.budget?.estimatedTokens || 0}/${disclosureGate.budget?.budgetTokens || 0}` : "disclosure gate"],
              ["prompt", contextBundle.handoff?.contextStarterPrompt || ".project-agent/context-starter-prompt.md"],
              ["drill", contextBundle.handoff?.contextTakeoverDrill || ".project-agent/context-takeover-drill.json"],
              ["next", contextBundle.quickStart?.nextCommand || "next command"]
            ].map(([label, value]) => (
              <span key={label} title={value}>
                {label}: {value}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <HandoffLifecyclePanel lifecycle={contextBundle?.handoff?.lifecycle || handoffLifecycle} />
      <AttentionPackPanel pack={attentionPack} />
      <StateBoundaryPanel boundary={stateBoundary} />
      <ProvenanceLedgerPanel ledger={provenanceLedger} />
      <DecisionLedgerPanel ledger={decisionLedger} />
      <CodeGraphPanel graph={codeGraph} />
      <FreshnessGatePanel gate={freshnessGate} />
      <PhaseLedgerPanel ledger={phaseLedger} />
      <CheckpointLedgerPanel ledger={checkpointLedger} />
      <RuntimeEvalPanel runtimeEval={runtimeEval} />
      <HookIngressPanel audit={hookIngressAudit} />
      <PreEditRiskPanel risk={preEditRisk} />
      <DisclosureGatePanel gate={disclosureGate} />
      <DetailDisclosure title="Objective coverage" meta={objectiveCoverage?.score || objectiveCoverage?.status}>
        <ObjectiveCoveragePanel coverage={objectiveCoverage} />
      </DetailDisclosure>
      {stateManifest ? (
        <DetailDisclosure title="State Manifest" meta={stateManifestVerification?.ok === false ? "mismatch" : "hashed"}>
          <div className="state-manifest" data-state-manifest=".project-agent/state-manifest.json">
            <div className="state-manifest-title">
              <div>
                <strong>State Manifest</strong>
                <span>{stateManifest.fileCount || 0} file(s) · {(stateManifestVerification?.aggregateHash || stateManifest.aggregateHash)?.slice(0, 12) || "no hash"}</span>
              </div>
              <Pill tone={stateManifestVerification?.ok === false ? "bad" : stateManifest.missing?.length ? "warn" : "ok"}>
                {stateManifestVerification?.ok === false ? "mismatch" : stateManifest.missing?.length ? `${stateManifest.missing.length} missing` : "hashed"}
              </Pill>
            </div>
            <div className="manifest-files">
              {(stateManifest.files || []).filter((file) => file.exists).slice(0, 5).map((file) => (
                <span key={file.path} title={`${file.path} ${file.sha256 || ""}`}>
                  {file.path.replace(".project-agent/", "")} {file.schemaVersion || `${file.bytes || 0}b`}
                </span>
              ))}
            </div>
          </div>
        </DetailDisclosure>
      ) : null}
      {continuityAudit ? (
        <DetailDisclosure title="Continuity Audit" meta={continuityAudit.canResume === false ? "blocked" : "can resume"}>
          <div className="continuity-audit" data-continuity-audit=".project-agent/continuity-audit.json">
            <div className="continuity-audit-title">
              <div>
                <strong>Continuity Audit</strong>
                <span>{continuityAudit.score || "0/0"} · {continuityAudit.summary || "Audit current handoff artifacts before takeover."}</span>
              </div>
              <Pill tone={continuityAudit.canResume === false ? "bad" : continuityAudit.status === "warn" ? "warn" : "ok"}>
                {continuityAudit.canResume === false ? "blocked" : "can resume"}
              </Pill>
            </div>
            <div className="audit-counts">
              <span className={continuityAudit.blockers?.length ? "bad" : "ok"}>
                blockers {continuityAudit.blockers?.length || 0}
              </span>
              <span className={continuityAudit.warnings?.length ? "warn" : "ok"}>
                warnings {continuityAudit.warnings?.length || 0}
              </span>
              <span>{continuityAudit.sourceFiles?.length || 0} source files</span>
            </div>
            {continuityAudit.nextCommand ? (
              <div className="audit-command">
                <span>next command</span>
                <code>{continuityAudit.nextCommand}</code>
              </div>
            ) : null}
            <div className="audit-checks">
              {auditChecks.map((check) => (
                <span key={check.id} className={check.status} title={`${check.detail || ""} ${(check.refs || []).join(" ")}`}>
                  {check.status} {check.label}
                </span>
              ))}
            </div>
          </div>
        </DetailDisclosure>
      ) : null}
      {interrupted?.count ? (
        <div className="interrupted-work">
          <div className="interrupted-work-title">
            <div>
              <strong>Interrupted Work</strong>
              <span>{interrupted.nextAction || "Resolve stale current work before editing."}</span>
            </div>
            <Pill tone="warn">{interrupted.count} open</Pill>
          </div>
          <div className="interrupted-work-list">
            {interruptedItems.slice(0, 3).map((item) => (
              <div key={item.id || `${item.agentId}-${item.title}`} className="interrupted-work-item">
                <div>
                  <strong>{item.title || "Stale current event"}</strong>
                  <span>
                    {item.agentId || "unknown agent"} · {item.leaseStatus || "stale"}
                    {Number.isFinite(item.leaseAgeSeconds) ? ` · ${item.leaseAgeSeconds}s` : ""}
                  </span>
                </div>
                <small>{(item.refs || item.files?.map((file) => file.path) || []).slice(0, 3).join(" · ") || item.recoveryAction}</small>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {drill ? (
        <DetailDisclosure title="Takeover Drill" meta={drill.canResume ? "can resume" : "blocked"}>
          <div className="takeover-drill">
            <div className="takeover-drill-title">
              <div>
                <strong>Takeover Drill</strong>
                <span>{drill.score} · {drill.summary}</span>
              </div>
              <Pill tone={drillTone(drill.status)}>{drill.canResume ? "can resume" : "blocked"}</Pill>
            </div>
            <div className="drill-read-order">
              {(drill.nextAgentBrief?.firstRead || []).slice(0, 3).map((item, index) => (
                <span key={`${item.path}-${index}`} className={item.exists ? "ok" : "bad"} title={item.why || item.lookFor || item.path}>
                  {item.exists ? "read" : "missing"} {item.path}
                </span>
              ))}
            </div>
            <div className="readiness-checks drill-checks">
              {drillChecks.map((check) => (
                <span key={check.id} className={check.status} title={check.detail}>
                  {check.status} {check.label}
                </span>
              ))}
            </div>
          </div>
        </DetailDisclosure>
      ) : null}
      {takeoverPacket ? (
        <DetailDisclosure title="Next Agent Packet" meta={takeoverPacket.canResume === false ? "blocked" : "resume"}>
          <div className="next-agent-packet" data-takeover-packet={takeoverPacket.packetFile || ".project-agent/takeover-packet.json"}>
            <div className="next-agent-packet-title">
              <div>
                <strong>Next Agent Packet</strong>
                <span>{takeoverPacket.packetFile || ".project-agent/takeover-packet.json"}</span>
              </div>
              <Pill tone={takeoverPacket.canResume === false ? "bad" : takeoverPacket.status === "warn" ? "warn" : "ok"}>
                {takeoverPacket.canResume === false ? "blocked" : "resume"}
              </Pill>
            </div>
            <div className="packet-cursor">
              <span>{takeoverPacket.cursor?.phase || "cursor"} · {takeoverPacket.cursor?.status || "unknown"}</span>
              <strong>{takeoverPacket.cursor?.title || takeoverPacket.objective || "No cursor"}</strong>
              <small>{takeoverPacket.cursor?.detail || takeoverPacket.summary || ""}</small>
            </div>
            {takeoverPacket.nextCommand ? (
              <div className="packet-command">
                <span>next command</span>
                <code>{takeoverPacket.nextCommand}</code>
              </div>
            ) : null}
            {takeoverPacket.firstActions?.length ? (
              <div className="packet-actions">
                {takeoverPacket.firstActions.slice(0, 3).map((item, index) => (
                  <div key={item.action}>
                    <span>{index + 1}</span>
                    <strong>{item.action}</strong>
                    <small>{item.why}</small>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="packet-read-order">
              {(takeoverPacket.firstRead || []).slice(0, 5).map((item, index) => (
                <span key={`${item.path}-${index}`} className={item.exists === false ? "bad" : "ok"} title={item.why || item.lookFor}>
                  {item.exists === false ? "missing" : "read"} {item.path}
                </span>
              ))}
            </div>
          </div>
        </DetailDisclosure>
      ) : null}
      {startProtocol ? (
        <DetailDisclosure title="Start Protocol" meta={startProtocol.resumeFrom?.workstream?.label || startProtocol.status || "resume"}>
          <div className="start-protocol">
            <div className="start-protocol-title">
              <strong>New Agent Start Protocol</strong>
              <span>{startProtocol.resumeFrom?.workstream?.label || startProtocol.status || "resume"}</span>
            </div>
            <div className="start-actions">
              {(startProtocol.firstActions || []).slice(0, 3).map((item, index) => (
                <div key={item.action} className="start-action">
                  <span>{index + 1}</span>
                  <strong>{item.action}</strong>
                  <small>{item.why}</small>
                </div>
              ))}
            </div>
            <div className="handoff-refs protocol-refs">
              {(startProtocol.readFirst || []).slice(0, 4).map((item, index) => (
                <span key={`${item.path}-${index}`} title={item.why}>{item.path}</span>
              ))}
            </div>
          </div>
        </DetailDisclosure>
      ) : null}
      {runbook ? (
        <DetailDisclosure title="Agent Runbook" meta={runbook.status || "ready"}>
          <div className="agent-runbook">
            <div className="agent-runbook-title">
              <div>
                <strong>Agent Runbook</strong>
                <span>{runbook.currentState || runbook.status || "ready"}{" -> "}{runbook.nextState || "next"}</span>
              </div>
              <Pill tone={runbook.canTakeOver === false ? "bad" : runbook.status === "resolve_interrupted_work" ? "warn" : "ok"}>
                {runbook.status || "ready"}
              </Pill>
            </div>
            {runbook.steps?.length ? (
              <div className="runbook-steps">
                {runbook.steps.slice(0, 3).map((step, index) => (
                  <div key={step.id} className={[step.status || "pending", step.required ? "required" : "", step.isActive ? "active" : ""].filter(Boolean).join(" ")}>
                    <span>{index + 1}</span>
                    <strong>{step.label || step.id}<em>{step.status || "pending"}</em></strong>
                    <small>{step.command || step.success || ""}</small>
                  </div>
                ))}
              </div>
            ) : runbook.stepIds?.length ? (
              <div className="handoff-refs protocol-refs">
                {runbook.stepIds.slice(0, 6).map((step) => (
                  <span key={step}>{step}</span>
                ))}
              </div>
            ) : null}
          </div>
        </DetailDisclosure>
      ) : null}
      {agents.length ? (
        <div className="agent-lease-strip">
          {agents.slice(0, 3).map((agent) => (
            <span key={agent.id} className={agent.effectiveStatus || agent.status} title={`${agent.id} ${agent.note || ""}`}>
              {agent.effectiveStatus || agent.status} {agent.id} {Number.isFinite(agent.ageSeconds) ? `${agent.ageSeconds}s` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {snapshot ? (
        <div className="snapshot-strip">
          <span className={snapshot.status} title={snapshot.error || snapshot.updatedAt}>
            snapshot {snapshot.status} {snapshot.reason || ""}
          </span>
        </div>
      ) : null}
      {continuity.changedFiles?.length ? (
        <div className="handoff-changes">
          {continuity.changedFiles.slice(0, 3).map((file) => (
            <span key={`${file.status}-${file.path}`} title={file.path}>
              {file.status} {file.path.split("/").pop()} {file.summary || ""}
            </span>
          ))}
        </div>
      ) : null}
      <div className="handoff-refs">
        {continuity.stateRefs.slice(0, 4).map((ref, index) => (
          <span key={`${ref}-${index}`}>{ref}</span>
        ))}
      </div>
    </section>
  );
}

function GoalSeedPanel({ state, activeGoalId, setActiveGoalId, onCreateGoal }) {
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("Working memory graph exists\nCode flow reflects current evidence\nAudit can verify completion");
  const active = state.activeGoal;

  const submit = async (event) => {
    event.preventDefault();
    if (!objective.trim()) return;
    await onCreateGoal({
      objective,
      acceptance: acceptance
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    });
    setObjective("");
  };

  if (active) {
    return (
      <section className="insight-section goal-memory">
        <div className="insight-heading">
          <span>Goal Memory</span>
          <Pill tone={statusTone(active.status)}>{active.status}</Pill>
        </div>
        <select value={activeGoalId || active.id} onChange={(event) => setActiveGoalId(event.target.value)} className="select">
          {state.goals.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goal.status} · {goal.objective}
            </option>
          ))}
        </select>
        <div className="criteria-strip">
          {active.acceptanceCriteria?.slice(0, 4).map((criterion) => (
            <span key={criterion.id}>{criterion.id}</span>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="insight-section goal-memory">
      <div className="insight-heading">
        <span>Goal Memory</span>
        <Pill tone="warn">empty</Pill>
      </div>
      <form className="seed-form" onSubmit={submit}>
        <input value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Objective" />
        <textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} />
        <IconButton icon={Plus} tone="primary" disabled={!objective.trim()}>
          Create goal
        </IconButton>
      </form>
    </section>
  );
}

function SidecarLine({ title, value, meta, tone = "muted", onClick }) {
  return (
    <button type="button" className={`sidecar-line ${tone}`} onClick={onClick}>
      <strong title={value}>{value}</strong>
      <span>{title}</span>
      {meta ? <small title={meta}>{meta}</small> : null}
    </button>
  );
}

function RunContextSidecar({
  state,
  step,
  processTrace,
  process,
  flow,
  memoryGraph,
  architectureMap,
  architecture,
  continuity,
  developmentTrail,
  kernel,
  continuityContract,
  takeoverAcceptanceAudit,
  governanceSpec,
  role,
  setRole,
  activeGoalId,
  setActiveGoalId,
  onCreateGoal,
  canComplete,
  onComplete,
  onHandoff,
  onAudit
}) {
  const [openDrawer, setOpenDrawer] = useState("");
  const [mapView, setMapView] = useState("process");
  const current = processTrace?.current || step;
  const previous = processTrace?.previous;
  const next = processTrace?.next;
  const changedFiles = (architectureMap?.recentChanges || architectureMap?.changes || continuity?.changedFiles || []).slice(0, 4);
  const impactFolders = (architectureMap?.impact?.topFolders || architectureMap?.impact?.folders || []).slice(0, 3);
  const memoryCount = memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0;
  const acceptanceReady = takeoverAcceptanceAudit?.status === "pass" || takeoverAcceptanceAudit?.canResume;
  const contextBundle = continuity?.agentContextBundle || null;
  const handoffLifecycle = continuity?.handoffLifecycle || contextBundle?.handoff?.lifecycle || continuity?.continuityContract?.handoffLifecycle || null;
  const disclosureGate = contextBundle?.validation?.disclosureGate || null;
  const provenanceLedger = contextBundle?.validation?.provenanceLedger || null;
  const stateBoundary = continuity?.stateBoundary || contextBundle?.validation?.stateBoundary || continuity?.continuityContract?.stateBoundary || null;
  const decisionLedger = continuity?.decisionLedger || contextBundle?.validation?.decisionLedger || continuity?.continuityContract?.decisionLedger || null;
  const attentionPack = contextBundle?.validation?.attentionPack || null;
  const freshnessGate = continuity?.freshnessGate || contextBundle?.validation?.freshnessGate || continuity?.continuityContract?.freshnessGate || null;
  const phaseLedger = continuity?.phaseLedger || contextBundle?.validation?.phaseLedger || continuity?.continuityContract?.phaseLedger || null;
  const checkpointLedger = continuity?.checkpointLedger || contextBundle?.validation?.checkpointLedger || continuity?.continuityContract?.checkpointLedger || null;
  const runtimeEval = continuity?.runtimeEval || contextBundle?.validation?.runtimeEval || continuity?.continuityContract?.runtimeEval || null;
  const hookIngressAudit = continuity?.hookIngressAudit || contextBundle?.validation?.hookIngressAudit || continuity?.continuityContract?.hookIngressAudit || null;
  const preEditRisk = continuity?.preEditRisk || contextBundle?.validation?.preEditRisk || null;
  const disclosureTone = disclosureGate ? gateTone(disclosureGate.status) : "warn";
  const disclosureLabel = disclosureGate?.status === "bad"
    ? "Disclosure blocked"
    : disclosureGate?.budget?.estimatedTokens
      ? `${disclosureGate.budget.estimatedTokens} token gate`
      : "Disclosure gate";
  const sourceFiles = contextBundle?.validation?.sourceFiles || contextBundle?.validation?.stateManifest?.files || [];
  const kernelSignals = [
    processTrace?.current || process?.current || step,
    memoryCount ? memoryGraph : null,
    architectureMap || architecture,
    sourceFiles.length ? sourceFiles : null,
    contextBundle || continuity?.takeoverPacket
  ].filter(Boolean).length;
  const nextCommand =
    continuity?.takeoverPacket?.nextCommand ||
    continuity?.agentContextBundle?.quickStart?.nextCommand ||
    continuity?.continuityAudit?.nextCommand ||
    "cat .project-agent/continuity.json";
  const changedSummary = changedFiles.length
    ? `${changedFiles.length} recent file${changedFiles.length === 1 ? "" : "s"}`
    : impactFolders.length
      ? `${impactFolders.length} changed area${impactFolders.length === 1 ? "" : "s"}`
      : "No tracked changes";
  const actionLabel = canComplete ? "Complete" : "Handoff";
  const openProjectMap = (view) => {
    setMapView(view);
    setOpenDrawer("map");
  };
  const openHandoff = () => setOpenDrawer("handoff");
  const toggleDrawer = (drawer) => (event) => {
    if (event.currentTarget.open) {
      setOpenDrawer(drawer);
      return;
    }
    setOpenDrawer((currentOpen) => (currentOpen === drawer ? "" : currentOpen));
  };
  const runAuditAndShow = async () => {
    await onAudit?.();
    setOpenDrawer("handoff");
  };
  const runPrimaryAction = async () => {
    if (canComplete) {
      await onComplete?.();
      return;
    }
    await onHandoff?.();
    setOpenDrawer("handoff");
  };

  return (
    <aside className="agent-panel sidecar-panel">
      <div className="sidecar-top">
        <div>
          <strong>{eventLabel(current)}</strong>
          <span>{state.activeGoal?.objective || "No active goal"}</span>
        </div>
        <Pill tone={acceptanceReady ? "ok" : "warn"}>{acceptanceReady ? "ready" : "watch"}</Pill>
      </div>

      <button type="button" className="sidecar-now" onClick={() => openProjectMap("process")}>
        <p>{eventDetail(current) || step?.body || "Waiting for the next command."}</p>
        <div className="sidecar-chain">
          {[eventLabel(previous), eventLabel(current), eventLabel(next)].filter(Boolean).map((item, index) => (
            <em key={`${item}-${index}`}>{item}</em>
          ))}
        </div>
      </button>

      <div className="sidecar-lines">
        <SidecarLine
          title="Kernel"
          value={`${kernelSignals}/5 layers`}
          meta={contextBundle?.readOrder?.[0] || ".project-agent/agent-context-bundle.json"}
          tone={kernelSignals >= 4 ? "ok" : "warn"}
          onClick={() => openProjectMap("kernel")}
        />
        <SidecarLine
          title="Changed"
          value={preEditRisk?.status ? `${preEditRisk.status} pre-edit risk` : changedSummary}
          meta={preEditRisk?.nextAction || (impactFolders[0]?.folder ? `Focus ${impactFolders[0].folder === "." ? "repo root" : impactFolders[0].folder}` : changedFiles[0]?.path)}
          tone={preEditRisk ? riskTone(preEditRisk.status) : changedFiles.length || impactFolders.length ? "warn" : "ok"}
          onClick={() => openProjectMap("architecture")}
        />
        <SidecarLine
          title="Graph"
          value={codeGraph?.nodeCount ? `${codeGraph.status} ${codeGraph.localEdgeCount || 0}/${codeGraph.nodeCount}` : "Code graph"}
          meta={codeGraph?.changedImpact?.[0]?.nextAction || codeGraph?.summary || "Dependency impact"}
          tone={codeGraph ? codeGraphTone(codeGraph.status) : "warn"}
          onClick={() => openProjectMap("graph")}
        />
        <SidecarLine
          title="Memory"
          value={`${memoryCount} nodes`}
          meta={memoryGraph?.edgeCount || memoryGraph?.edges?.length ? `${memoryGraph?.edgeCount || memoryGraph?.edges?.length} links` : "graph ready"}
          tone={memoryCount ? "ok" : "warn"}
          onClick={() => openProjectMap("memory")}
        />
        <SidecarLine
          title="Focus"
          value={attentionPack?.status ? `${attentionPack.status} pack` : "Attention pack"}
          meta={attentionPack?.items?.[0]?.label || attentionPack?.summary || "Top-of-mind handoff context"}
          tone={attentionPack ? attentionTone(attentionPack.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Decisions"
          value={decisionLedger?.decisionCount ? `${decisionLedger.status} ${decisionLedger.validCount || 0}/${decisionLedger.decisionCount}` : "Decision ledger"}
          meta={decisionLedger?.nextAction || decisionLedger?.summary || "Temporal decision refs"}
          tone={decisionLedger ? decisionTone(decisionLedger.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Boundary"
          value={stateBoundary?.status ? `${stateBoundary.status} state` : "State boundary"}
          meta={stateBoundary?.nextAction || stateBoundary?.summary || "Source/index/disclosure split"}
          tone={stateBoundary ? boundaryTone(stateBoundary.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Resume"
          value={handoffLifecycle?.status ? `Handoff ${handoffLifecycle.status}` : acceptanceReady ? "Another agent can continue" : "Needs a handoff check"}
          meta={handoffLifecycle?.nextAction || takeoverAcceptanceAudit?.score || continuity?.continuityAudit?.score || nextCommand}
          tone={handoffLifecycle ? lifecycleTone(handoffLifecycle.status) : acceptanceReady ? "ok" : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Fresh"
          value={freshnessGate?.status ? `${freshnessGate.status} state` : "Freshness gate"}
          meta={freshnessGate?.validity?.validUntil ? `valid until ${freshnessGate.validity.validUntil}` : freshnessGate?.summary || "Check state timestamps"}
          tone={freshnessGate ? freshnessTone(freshnessGate.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Ledger"
          value={phaseLedger?.status ? `${phaseLedger.status} ${phaseLedger.linkedCount || 0}/${phaseLedger.spanCount || 0}` : "Phase ledger"}
          meta={phaseLedger?.nextAction || phaseLedger?.summary || "Parent/child span trace"}
          tone={phaseLedger ? phaseTone(phaseLedger.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Checkpoint"
          value={checkpointLedger?.status ? `${checkpointLedger.status} ${checkpointLedger.resumableCount || 0}/${checkpointLedger.checkpointCount || 0}` : "Checkpoint ledger"}
          meta={checkpointLedger?.nextAction || checkpointLedger?.summary || "Resumable run points"}
          tone={checkpointLedger ? checkpointTone(checkpointLedger.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Hooks"
          value={hookIngressAudit?.acceptedEvents ? `${hookIngressAudit.acceptedEvents} accepted` : "Hook ingress"}
          meta={hookIngressAudit?.summary || "Sanitized external events"}
          tone={hookIngressAudit ? hookTone(hookIngressAudit.status) : "warn"}
          onClick={openHandoff}
        />
        <SidecarLine
          title="Disclose"
          value={disclosureLabel}
          meta={disclosureGate?.summary || "Check prompt budget and secret-like content"}
          tone={disclosureTone}
          onClick={openHandoff}
        />
      </div>

      {changedFiles.length ? (
        <div className="sidecar-changes">
          {changedFiles.map((file) => (
            <button type="button" key={`${file.status}-${file.path}`} title={file.path} onClick={() => openProjectMap("architecture")}>
              {file.path}
            </button>
          ))}
        </div>
      ) : null}

      <details className="sidecar-drawer" open={openDrawer === "map"} onToggle={toggleDrawer("map")}>
        <summary>Project map</summary>
        <div className="sidecar-map">
          <div className="sidecar-map-tabs" role="tablist" aria-label="Project map view">
            {[
              ["kernel", "Kernel"],
              ["process", "Process"],
              ["memory", "Memory"],
              ["graph", "Graph"],
              ["architecture", "Architecture"]
            ].map(([id, label]) => (
              <button type="button" key={id} className={mapView === id ? "active" : ""} onClick={() => setMapView(id)}>
                {label}
              </button>
            ))}
          </div>
          {mapView === "kernel" ? (
            <GovernanceKernelPanel
              state={state}
              processTrace={processTrace || process}
              memoryGraph={memoryGraph}
              architectureMap={architectureMap || architecture}
              continuity={continuity}
              continuityContract={continuityContract}
              takeoverAcceptanceAudit={takeoverAcceptanceAudit}
              governanceSpec={governanceSpec}
              developmentTrail={developmentTrail}
            />
          ) : null}
          {mapView === "memory" ? <MemoryGraph graph={memoryGraph} /> : null}
          {mapView === "process" ? <ProcessTimeline process={processTrace || process} steps={flow} developmentTrail={developmentTrail} /> : null}
          {mapView === "graph" ? <CodeGraphPanel graph={codeGraph} /> : null}
          {mapView === "architecture" ? <ArchitecturePanel architecture={architectureMap || architecture} /> : null}
        </div>
      </details>

      <details className="sidecar-drawer" open={openDrawer === "handoff"} onToggle={toggleDrawer("handoff")}>
        <summary>Handoff packet</summary>
        <div className="sidecar-map">
          <HandoffPrimerPanel continuity={continuity} contract={continuityContract} acceptanceAudit={takeoverAcceptanceAudit} />
          <HandoffLifecyclePanel lifecycle={handoffLifecycle} />
          <AttentionPackPanel pack={attentionPack} />
          <StateBoundaryPanel boundary={stateBoundary} />
          <ProvenanceLedgerPanel ledger={provenanceLedger} />
          <DecisionLedgerPanel ledger={decisionLedger} />
          <CodeGraphPanel graph={codeGraph} />
          <FreshnessGatePanel gate={freshnessGate} />
          <PhaseLedgerPanel ledger={phaseLedger} />
          <CheckpointLedgerPanel ledger={checkpointLedger} />
          <RuntimeEvalPanel runtimeEval={runtimeEval} />
          <HookIngressPanel audit={hookIngressAudit} />
          <PreEditRiskPanel risk={preEditRisk} />
          <DisclosureGatePanel gate={disclosureGate} />
          <TakeoverAcceptancePanel audit={takeoverAcceptanceAudit} />
          <ContinuityPanel continuity={continuity} />
        </div>
      </details>

      <details className="sidecar-drawer quiet" open={openDrawer === "settings"} onToggle={toggleDrawer("settings")}>
        <summary>Settings</summary>
        <div className="sidecar-settings">
          <select className="select compact" value={role} onChange={(event) => setRole(event.target.value)}>
            {roles.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
          <GoalSeedPanel state={state} activeGoalId={activeGoalId} setActiveGoalId={setActiveGoalId} onCreateGoal={onCreateGoal} />
          <DetailDisclosure title="Governance details" meta={governanceSpec?.score || governanceSpec?.status}>
            <GovernanceSpecPanel spec={governanceSpec} />
            <ContinuityContractPanel contract={continuityContract} />
          </DetailDisclosure>
        </div>
      </details>

      <div className="sidecar-actions">
        <IconButton icon={ShieldCheck} onClick={runAuditAndShow} disabled={!state.activeGoal}>
          Audit
        </IconButton>
        {canComplete ? (
          <IconButton icon={CheckCircle2} tone="primary" onClick={runPrimaryAction}>
            {actionLabel}
          </IconButton>
        ) : (
          <IconButton icon={FileText} tone="primary" onClick={runPrimaryAction} disabled={!state.activeGoal}>
            {actionLabel}
          </IconButton>
        )}
      </div>
    </aside>
  );
}

function AgentStatePanel({
  state,
  packet,
  audit,
  handoff,
  insights,
  terminalSnapshot,
  role,
  setRole,
  activeGoalId,
  setActiveGoalId,
  onCreateGoal,
  onSaveCommand,
  onAudit,
  onComplete,
  onHandoff
}) {
  const [verify, setVerify] = useState([]);
  const [activeView, setActiveView] = useState("overview");
  const fallbackTargets = useMemo(() => {
    const criteria = state.activeGoal?.acceptanceCriteria?.map((item) => ({ id: item.id, label: item.statement })) || [];
    const actions = state.actions.map((item) => ({ id: item.id, label: item.title }));
    return [...criteria, ...actions];
  }, [state.activeGoal, state.actions]);

  useEffect(() => {
    setVerify([]);
  }, [state.activeGoal?.id]);

  const fallbackGraph = useMemo(() => buildMemoryGraph(state, packet, audit, handoff), [state, packet, audit, handoff]);
  const step = insights?.currentStep || getCurrentStep(state, audit, handoff, terminalSnapshot);
  const targets = insights?.targets || fallbackTargets;
  const process = insights?.process || null;
  const architecture = insights?.architecture || null;
  const continuity = insights?.continuity || null;
  const memoryGraph = continuity?.memoryGraph || insights?.memoryGraph || insights?.knowledgeGraph || insights?.graph || fallbackGraph;
  const processTrace = continuity?.processTrace || insights?.processTrace || process;
  const developmentTrail = continuity?.developmentTrail || continuity?.agentContextBundle?.process?.developmentTrail || null;
  const architectureMap = continuity?.architectureMap || insights?.architectureMap || architecture;
  const codeGraph = continuity?.codeGraph || continuity?.agentContextBundle?.architecture?.codeGraph || architectureMap?.codeGraph || continuity?.architectureTrace?.codeGraph || null;
  const flow = processTrace?.phases || insights?.flow || buildCodeFlow(state, audit, handoff, terminalSnapshot);
  const governance = insights?.governance || continuity?.governance || null;
  const governanceSpec = continuity?.governanceSpec || null;
  const continuityContract = insights?.continuityContract || continuity?.continuityContract || null;
  const contextBundle = continuity?.agentContextBundle || null;
  const objectiveCoverage = contextBundle?.validation?.objectiveCoverage || continuity?.objectiveCoverage || null;
  const takeoverAcceptanceAudit = contextBundle?.validation?.takeoverAcceptanceAudit || continuity?.takeoverAcceptanceAudit || null;
  const kernel = insights?.kernelSummary || continuity?.kernelSummary || null;
  const hasCommand = Boolean(terminalSnapshot?.lastCommand || terminalSnapshot?.currentCommand);
  const canComplete = Boolean(state.activeGoal && audit?.canComplete && state.activeGoal.status !== "complete");

  return (
    <RunContextSidecar
      state={state}
      step={step}
      processTrace={processTrace}
      process={process}
      flow={flow}
      memoryGraph={memoryGraph}
      architectureMap={architectureMap}
      architecture={architecture}
      continuity={continuity}
      developmentTrail={developmentTrail}
      kernel={kernel}
      continuityContract={continuityContract}
      takeoverAcceptanceAudit={takeoverAcceptanceAudit}
      governanceSpec={governanceSpec}
      role={role}
      setRole={setRole}
      activeGoalId={activeGoalId}
      setActiveGoalId={setActiveGoalId}
      onCreateGoal={onCreateGoal}
      canComplete={canComplete}
      onComplete={onComplete}
      onHandoff={onHandoff}
      onAudit={onAudit}
    />
  );

  const views = [
    { id: "overview", label: "Overview", icon: ClipboardList },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "process", label: "Process", icon: Activity },
    { id: "architecture", label: "Architecture", icon: Network },
    { id: "handoff", label: "Handoff", icon: GitBranch }
  ];

  const toggleTarget = (id) => {
    setVerify((items) => (items.includes(id) ? items.filter((item) => item !== id) : [...items, id]));
  };

  const renderActiveView = () => {
    if (activeView === "memory") {
      return (
        <>
          <MemoryGraph graph={memoryGraph} />
          <KernelPanel kernel={kernel} />
          <GoalSeedPanel state={state} activeGoalId={activeGoalId} setActiveGoalId={setActiveGoalId} onCreateGoal={onCreateGoal} />
          <DetailDisclosure title="Memory source" meta=".project-agent/memory-graph.json">
            <StateSourceStrip
              title="Memory Source"
              items={[
                {
                  path: ".project-agent/memory-graph.json",
                  schema: memoryGraph?.schemaVersion,
                  metric: `${memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0} nodes · ${memoryGraph?.edgeCount || memoryGraph?.edges?.length || 0} edges`
                }
              ]}
            />
          </DetailDisclosure>
        </>
      );
    }
    if (activeView === "process") {
      return (
        <>
          <CurrentStepPanel step={step} targets={targets} selectedTargets={verify} toggleTarget={toggleTarget} />
          <WorkstreamPanel process={process} />
          <ProcessTimeline process={processTrace || process} steps={flow} developmentTrail={developmentTrail} />
          <DetailDisclosure title="Process source" meta="trace, runbook, development trail">
            <StateSourceStrip
              title="Process Source"
              items={[
                {
                  path: ".project-agent/process-trace.json",
                  schema: processTrace?.schemaVersion,
                  metric: `${processTrace?.current?.phase || "current"} · ${processTrace?.current?.status || "unknown"}`
                },
                {
                  path: ".project-agent/agent-runbook.json",
                  metric: continuity?.agentRunbook?.activeStepId || continuity?.agentRunbook?.status || "runbook"
                },
                {
                  path: ".project-agent/development-trail.json",
                  schema: developmentTrail?.schemaVersion,
                  metric: developmentTrail?.status ? `${developmentTrail.status} · ${developmentTrail.fileCoverage || "0/0"}` : "development trail"
                }
              ]}
            />
          </DetailDisclosure>
        </>
      );
    }
    if (activeView === "architecture") {
      return (
        <>
          <ArchitecturePanel architecture={architectureMap || architecture} />
          <CodeGraphPanel graph={codeGraph} />
          <DetailDisclosure title="Architecture source" meta=".project-agent/architecture-map.json">
            <StateSourceStrip
              title="Architecture Source"
              items={[
                {
                  path: ".project-agent/architecture-map.json",
                  schema: architectureMap?.schemaVersion,
                  metric: `${architectureMap?.totals?.files || architectureMap?.files?.length || 0} files · ${architectureMap?.totals?.changed || architectureMap?.recentChanges?.length || 0} changed · ${codeGraph?.localEdgeCount || 0} edges`
                }
              ]}
            />
          </DetailDisclosure>
        </>
      );
    }
    if (activeView === "handoff") {
      return (
        <>
          <ControlSummaryPanel
            step={step}
            memoryGraph={memoryGraph}
            processTrace={processTrace || process}
            architectureMap={architectureMap || architecture}
            continuity={continuity}
            acceptanceAudit={takeoverAcceptanceAudit}
          />
          <HandoffPrimerPanel continuity={continuity} contract={continuityContract} acceptanceAudit={takeoverAcceptanceAudit} />
          <TakeoverAcceptancePanel audit={takeoverAcceptanceAudit} />
          <DetailDisclosure title="Supporting handoff state" meta={continuity?.continuityAudit?.canResume === false ? "blocked" : "can resume"}>
            <ContinuityPanel continuity={continuity} />
          </DetailDisclosure>
          <DetailDisclosure title="Takeover Sources" meta="durable files">
            <StateSourceStrip
              title="Takeover Sources"
              items={(continuityContract?.readFirst || continuity?.startProtocol?.readFirst || [])
                .filter((item) => [".project-agent/agent-context-bundle.json", ".project-agent/governance-spec.json", ".project-agent/continuity-contract.json", ".project-agent/agent-runbook.json", ".project-agent/memory-graph.json", ".project-agent/process-trace.json", ".project-agent/architecture-map.json", ".project-agent/state-manifest.json", ".project-agent/takeover-packet.json", ".project-agent/continuity-audit.json", ".project-agent/next-agent-prompt.md"].includes(item.path))
                .slice(0, 10)
                .map((item) => ({ path: item.path, metric: "read first" }))}
            />
          </DetailDisclosure>
          <DetailDisclosure title="Governance details" meta={governanceSpec?.score || governanceSpec?.status}>
            <GovernanceSpecPanel spec={governanceSpec} />
            <ContinuityContractPanel contract={continuityContract} />
          </DetailDisclosure>
        </>
      );
    }
    return (
      <>
        <ControlSummaryPanel
          step={step}
          memoryGraph={memoryGraph}
          processTrace={processTrace || process}
          architectureMap={architectureMap || architecture}
          continuity={continuity}
          acceptanceAudit={takeoverAcceptanceAudit}
        />
        <CurrentStepPanel step={step} targets={targets} selectedTargets={verify} toggleTarget={toggleTarget} />
        <GovernancePanel governance={governance} />
        <DetailDisclosure title="Durable state files" meta="agent-neutral">
          <StateSourceStrip
            title="Agent-Neutral State"
            items={[
              { path: ".project-agent/agent-context-bundle.json", metric: continuity?.agentContextBundle?.quickStart?.nextCommand || "portable context" },
              { path: ".project-agent/memory-graph.json", metric: `${memoryGraph?.nodeCount || memoryGraph?.nodes?.length || 0} nodes` },
              { path: ".project-agent/process-trace.json", metric: processTrace?.current?.title || "process" },
              { path: ".project-agent/architecture-map.json", metric: `${architectureMap?.totals?.files || architectureMap?.files?.length || 0} files` }
            ]}
          />
        </DetailDisclosure>
        <DetailDisclosure title="Governance details" meta={objectiveCoverage?.score || governanceSpec?.score || "proof"}>
          <GovernanceSpecPanel spec={governanceSpec} />
          <ContinuityContractPanel contract={continuityContract} />
        </DetailDisclosure>
      </>
    );
  };

  return (
    <aside className="agent-panel insight-panel">
      <div className="insight-header">
        <div>
          <Bot size={18} />
          <strong>AI State</strong>
        </div>
        <select className="select compact" value={role} onChange={(event) => setRole(event.target.value)}>
          {roles.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div className="insight-tabs" role="tablist" aria-label="AI state views">
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <button
              type="button"
              key={view.id}
              className={`insight-tab ${activeView === view.id ? "active" : ""}`}
              onClick={() => setActiveView(view.id)}
              role="tab"
              aria-selected={activeView === view.id}
              data-state-view={view.id}
            >
              <Icon size={14} />
              <span>{view.label}</span>
            </button>
          );
        })}
      </div>

      <div className="insight-view" data-active-state-view={activeView}>
        {renderActiveView()}
      </div>

      <div className="insight-actions">
        <IconButton icon={Database} onClick={() => onSaveCommand(verify)} disabled={!state.activeGoal || !hasCommand}>
          Save Evidence
        </IconButton>
        <IconButton icon={ShieldCheck} onClick={onAudit} disabled={!state.activeGoal}>
          Run Audit
        </IconButton>
        {canComplete ? (
          <IconButton icon={CheckCircle2} tone="primary" onClick={onComplete}>
            Complete
          </IconButton>
        ) : (
          <IconButton icon={FileText} onClick={onHandoff} disabled={!state.activeGoal}>
            Handoff
          </IconButton>
        )}
      </div>
    </aside>
  );
}

export default function App({ TerminalClass, FitAddonClass }) {
  const [config, setConfig] = useState(null);
  const [state, setState] = useState({
    initialized: false,
    goals: [],
    activeGoal: null,
    actions: [],
    gates: [],
    evidence: [],
    decisions: [],
    risks: []
  });
  const [role, setRole] = useState("coding_agent");
  const [activeGoalId, setActiveGoalId] = useState("");
  const [packet, setPacket] = useState(null);
  const [insights, setInsights] = useState(null);
  const [audit, setAudit] = useState(null);
  const [handoff, setHandoff] = useState("");
  const [terminalSnapshot, setTerminalSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshAllRef = useRef(null);

  const loadState = useCallback(async () => {
    const [cfg, nextState] = await Promise.all([api("/config"), api("/state")]);
    setConfig(cfg);
    setState(nextState);
    const selected = activeGoalId || nextState.activeGoal?.id || "";
    if (!activeGoalId && selected) setActiveGoalId(selected);
    return { cfg, nextState, selected };
  }, [activeGoalId]);

  const loadKernel = useCallback(async () => {
    if (!state.initialized) return;
    const goal = activeGoalId || state.activeGoal?.id || "";
    const query = new URLSearchParams({ role });
    if (goal) query.set("goal", goal);
    const [nextPacket, nextInsights] = await Promise.all([api(`/kernel?${query.toString()}`), api(`/insights?${query.toString()}`)]);
    setPacket(nextPacket);
    setInsights(nextInsights);
  }, [activeGoalId, role, state.initialized, state.activeGoal?.id]);

  const refreshInsights = useCallback(async () => {
    const goal = activeGoalId || state.activeGoal?.id || "";
    const query = new URLSearchParams({ role });
    if (goal) query.set("goal", goal);
    setInsights(await api(`/insights?${query.toString()}`));
  }, [activeGoalId, role, state.activeGoal?.id]);

  const refreshAll = useCallback(async () => {
    try {
      setError("");
      const { nextState, selected } = await loadState();
      if (nextState.initialized) {
        const query = new URLSearchParams({ role });
        if (selected) query.set("goal", selected);
        setPacket(await api(`/kernel?${query.toString()}`));
        setInsights(await api(`/insights?${query.toString()}`));
      } else {
        setInsights(await api("/insights"));
      }
      setTerminalSnapshot(await api("/terminal/snapshot"));
    } catch (err) {
      setError(err.message);
    }
  }, [loadState, role]);

  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    loadKernel().catch((err) => setError(err.message));
  }, [loadKernel]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshInsights().catch(() => {});
    }, 2200);
    return () => clearInterval(interval);
  }, [refreshInsights]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/events`);
    let debounce = null;
    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!["runtime-event", "runtime-events", "agent-heartbeat", "handoff-snapshot"].includes(message.type)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        refreshAllRef.current?.().catch(() => {});
      }, 120);
    };
    return () => {
      if (debounce) clearTimeout(debounce);
      socket.close();
    };
  }, []);

  const withBusy = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refreshAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const init = () => withBusy(() => api("/init", { method: "POST", body: { name: "terminal-project" } }));
  const createGoal = (body) => withBusy(() => api("/goals", { method: "POST", body }));
  const addAction = (body) => withBusy(() => api("/actions", { method: "POST", body }));
  const setAction = (id, status) => withBusy(() => api(`/actions/${id}`, { method: "POST", body: { status } }));
  const addGate = (body) => withBusy(() => api("/gates", { method: "POST", body }));
  const runGate = (id) => withBusy(() => api(`/gates/${id}/run`, { method: "POST", body: {} }));
  const saveCommand = (verifies) =>
    withBusy(() =>
      api("/evidence/last-command", {
        method: "POST",
        body: {
          goalId: activeGoalId || state.activeGoal?.id,
          verifies
        }
      })
    );
  const runAudit = () =>
    withBusy(async () => {
      const goal = activeGoalId || state.activeGoal?.id;
      setAudit(await api(`/audit/${goal}`));
    });
  const completeGoal = () => withBusy(() => api(`/audit/${activeGoalId || state.activeGoal?.id}/complete`, { method: "POST" }));
  const generateHandoff = () =>
    withBusy(async () => {
      const result = await api(`/handoff/${activeGoalId || state.activeGoal?.id}`);
      setHandoff(result.markdown);
    });

  const selectedGoal = useMemo(() => {
    if (!activeGoalId) return state.activeGoal;
    return state.goals.find((goal) => goal.id === activeGoalId) || state.activeGoal;
  }, [activeGoalId, state]);

  const panelState = useMemo(() => {
    if (!selectedGoal || selectedGoal.id === state.activeGoal?.id) return state;
    return {
      ...state,
      activeGoal: selectedGoal,
      actions: state.actions.filter((item) => item.goalId === selectedGoal.id),
      gates: state.gates.filter((item) => item.goalId === selectedGoal.id),
      evidence: state.evidence.filter((item) => selectedGoal.evidence?.includes(item.id))
    };
  }, [selectedGoal, state]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Command size={19} />
          </div>
          <div>
            <strong>Project Agent Terminal</strong>
            <span>PTY wrapper with evidence-bound project governance</span>
          </div>
        </div>
        <div className="header-controls">
          <IconButton icon={RefreshCw} onClick={refreshAll} disabled={busy}>
            Sync
          </IconButton>
          <IconButton icon={Sparkles} tone={state.initialized ? "neutral" : "primary"} onClick={init} disabled={busy}>
            {state.initialized ? "Rebuild docs" : "Initialize"}
          </IconButton>
        </div>
      </header>

      {error ? <div className="error-bar">{error}</div> : null}

      <main className="workspace">
        <TerminalPane
          TerminalClass={TerminalClass}
          FitAddonClass={FitAddonClass}
          config={config}
          onCommandCaptured={setTerminalSnapshot}
          onTerminalSnapshot={setTerminalSnapshot}
          onRefresh={refreshAll}
        />
        <AgentStatePanel
          state={panelState}
          packet={packet}
          audit={audit}
          handoff={handoff}
          insights={insights}
          terminalSnapshot={terminalSnapshot}
          role={role}
          setRole={setRole}
          activeGoalId={activeGoalId}
          setActiveGoalId={setActiveGoalId}
          onCreateGoal={createGoal}
          onSaveCommand={saveCommand}
          onAudit={runAudit}
          onComplete={completeGoal}
          onHandoff={generateHandoff}
        />
      </main>
    </div>
  );
}
