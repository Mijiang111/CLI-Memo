import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readRuntime, recordEvents } from "./runtime-state.js";

const TEXT_FILE_RE = /(?:^|[\s"'`])((?:\.?[\w.-]+\/)+[\w.@-]+\.[A-Za-z0-9_-]+|AGENTS\.md|CLAUDE\.md|PROJECT\.md|README\.md|package\.json|pyproject\.toml)(?=$|[\s"'`,):])/g;
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
const VALID_PHASES = new Set(["observe", "plan", "execute", "evidence", "audit", "handoff"]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function compact(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stableId(source, file, lineNumber, payload) {
  return `log_${hash(`${source}:${file || "inline"}:${lineNumber}:${JSON.stringify(payload).slice(0, 1000)}`)}`;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return asText(value.content);
  if (typeof value.input === "string") return value.input;
  if (typeof value.command === "string") return value.command;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractToolName(item) {
  return (
    item.tool ||
    item.toolName ||
    item.name ||
    item.function?.name ||
    item.tool_call?.name ||
    item.message?.name ||
    item.message?.tool_name ||
    item.message?.content?.find?.((part) => part?.type === "tool_use")?.name ||
    null
  );
}

function normalizeFilePath(rawPath) {
  const value = String(rawPath || "").trim().replace(/^["'`]|["'`]$/g, "");
  if (!value || value.startsWith("http://") || value.startsWith("https://")) return null;
  return value.replace(/\\/g, "/");
}

function extractFilesFromText(text, defaults = {}) {
  const files = new Map();
  let match;
  while ((match = PATCH_FILE_RE.exec(text))) {
    const filePath = normalizeFilePath(match[1]);
    if (filePath) files.set(filePath, { path: filePath, status: defaults.status || "modified", summary: defaults.summary });
  }
  while ((match = TEXT_FILE_RE.exec(text))) {
    const filePath = normalizeFilePath(match[1]);
    if (filePath && !files.has(filePath)) files.set(filePath, { path: filePath, status: defaults.status, summary: defaults.summary });
  }
  return [...files.values()];
}

function normalizeFiles(files, fallbackText, defaults = {}) {
  const values = Array.isArray(files) ? files : files ? [files] : [];
  const normalized = values
    .map((file) => {
      if (typeof file === "string") return { path: normalizeFilePath(file), status: defaults.status, summary: defaults.summary };
      if (!file || typeof file !== "object") return null;
      return {
        path: normalizeFilePath(file.path || file.file || file.name),
        status: file.status || defaults.status,
        kind: file.kind,
        summary: file.summary || defaults.summary,
        additions: file.additions,
        deletions: file.deletions,
        hash: file.hash
      };
    })
    .filter((file) => file?.path);
  if (normalized.length) return normalized;
  return extractFilesFromText(fallbackText || "", defaults);
}

function timestampOf(item) {
  return item.at || item.timestamp || item.createdAt || item.created_at || item.time || item.message?.created_at || undefined;
}

function eventFromGeneric(item, context) {
  if (!item || typeof item !== "object") return null;
  if (!item.phase && !item.title && !item.status && !item.files) return null;
  const detail = item.detail || item.summary || asText(item.content || item.message || item.text);
  return {
    id: item.id || stableId(context.source, context.file, context.lineNumber, item),
    at: timestampOf(item),
    phase: VALID_PHASES.has(item.phase) ? item.phase : "observe",
    status: item.status || "done",
    title: item.title || "Imported event",
    detail,
    refs: item.refs || item.references || [],
    files: normalizeFiles(item.files || item.changedFiles, detail),
    agentId: item.agentId || context.agentId,
    goalId: item.goalId || context.goalId,
    tool: item.tool,
    source: context.source,
    data: { importFormat: context.format, lineNumber: context.lineNumber }
  };
}

function eventFromTool(item, context) {
  const tool = extractToolName(item);
  const type = String(item.type || item.event || item.kind || "").toLowerCase();
  const hasToolSignal = Boolean(tool || type.includes("tool") || type.includes("function_call"));
  if (!hasToolSignal) return null;
  const payloadText = asText(item.input || item.arguments || item.args || item.tool_input || item.message?.content || item);
  const failed = type.includes("error") || item.status === "failed" || item.error;
  const completed = type.includes("result") || type.includes("output") || item.status === "done" || item.status === "completed";
  return {
    id: item.id || stableId(context.source, context.file, context.lineNumber, item),
    at: timestampOf(item),
    phase: "execute",
    status: failed ? "failed" : completed ? "done" : item.status || "current",
    title: `${completed ? "Tool completed" : failed ? "Tool failed" : "Tool running"}${tool ? `: ${tool}` : ""}`,
    detail: compact(payloadText || item.result || item.output || ""),
    refs: item.refs || [],
    files: normalizeFiles(item.files, payloadText, { status: "modified" }),
    agentId: item.agentId || context.agentId,
    goalId: item.goalId || context.goalId,
    tool,
    source: context.source,
    data: { importFormat: context.format, lineNumber: context.lineNumber }
  };
}

function eventFromMessage(item, context) {
  const role = item.role || item.message?.role || item.type;
  const text = asText(item.content || item.message?.content || item.text);
  if (!text) return null;
  const lowerRole = String(role || "").toLowerCase();
  const phase = lowerRole.includes("user") ? "observe" : "plan";
  const title = lowerRole.includes("user") ? "User instruction" : "Agent note";
  return {
    id: item.id || stableId(context.source, context.file, context.lineNumber, item),
    at: timestampOf(item),
    phase,
    status: "done",
    title,
    detail: compact(text),
    refs: [],
    files: normalizeFiles(item.files, text),
    agentId: item.agentId || context.agentId,
    goalId: item.goalId || context.goalId,
    source: context.source,
    data: { importFormat: context.format, lineNumber: context.lineNumber }
  };
}

function eventsFromClaudeMessage(item, context) {
  const content = item.message?.content || item.content;
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const [partIndex, part] of content.entries()) {
    const partContext = { ...context, lineNumber: `${context.lineNumber}.${partIndex + 1}` };
    if (part?.type === "tool_use") {
      events.push(
        eventFromTool(
          {
            id: part.id,
            type: "tool_use",
            name: part.name,
            input: part.input,
            agentId: item.agentId,
            goalId: item.goalId,
            at: timestampOf(item)
          },
          partContext
        )
      );
    } else if (part?.type === "tool_result") {
      events.push(
        eventFromTool(
          {
            id: part.tool_use_id,
            type: "tool_result",
            name: "tool_result",
            input: part.content,
            status: part.is_error ? "failed" : "done",
            at: timestampOf(item)
          },
          partContext
        )
      );
    } else if (part?.type === "text" && part.text) {
      events.push(eventFromMessage({ ...item, content: part.text }, partContext));
    }
  }
  return events.filter(Boolean);
}

export function eventsFromSessionItems(items, options = {}) {
  const source = options.source || `${options.format || "auto"}-session-log`;
  const contextBase = {
    format: options.format || "auto",
    file: options.file || "",
    agentId: options.agentId,
    goalId: options.goalId,
    source
  };
  const events = [];
  for (const [index, item] of items.entries()) {
    const context = { ...contextBase, lineNumber: index + 1 };
    const claudeEvents = eventsFromClaudeMessage(item, context);
    if (claudeEvents.length) {
      events.push(...claudeEvents);
      continue;
    }
    events.push(eventFromGeneric(item, context) || eventFromTool(item, context) || eventFromMessage(item, context));
  }
  return events.filter(Boolean).slice(0, options.limit || 200);
}

export function readJsonl(filePath) {
  const text = readFileSync(filePath, "utf8");
  const items = [];
  const errors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  }
  return { items, errors };
}

export function importSessionLog(projectDir, options = {}) {
  let items = options.items || [];
  let errors = [];
  let file = options.file || "";
  if (file) {
    const resolved = path.resolve(projectDir, file);
    if (!existsSync(resolved)) throw new Error(`Session log not found: ${resolved}`);
    file = resolved;
    const parsed = readJsonl(resolved);
    items = parsed.items;
    errors = parsed.errors;
  }
  const before = new Set((readRuntime(projectDir).events || []).map((event) => event.id));
  const events = eventsFromSessionItems(items, { ...options, file });
  const newEvents = events.filter((event) => !before.has(event.id));
  const runtime = recordEvents(projectDir, newEvents);
  return {
    imported: newEvents.length,
    parsed: items.length,
    skipped: errors.length,
    errors,
    events: newEvents,
    total: runtime.events.length
  };
}
