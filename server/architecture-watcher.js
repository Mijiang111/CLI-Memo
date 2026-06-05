import { createHash } from "node:crypto";
import { buildArchitecture } from "./architecture.js";

function eventId(change) {
  const key = [change.status, change.path, change.hash || change.previousHash || change.modifiedAt].filter(Boolean).join(":");
  return `arch_${createHash("sha256").update(key).digest("hex").slice(0, 14)}`;
}

export function architectureEventsFromChanges(changes = [], source = "architecture-scan") {
  return changes.map((change) => ({
    id: eventId(change),
    at: change.modifiedAt,
    phase: "execute",
    title: `File ${change.status}`,
    status: change.status === "deleted" ? "current" : "done",
    detail: [change.path, change.summary].filter(Boolean).join(" "),
    refs: [change.path, change.hash || change.previousHash].filter(Boolean),
    files: [
      {
        path: change.path,
        status: change.status,
        kind: change.kind,
        summary: change.summary,
        additions: change.additions || 0,
        deletions: change.deletions || 0,
        hash: change.hash
      }
    ],
    source
  }));
}

export function startArchitectureWatcher(projectDir, { intervalMs = 1200, onEvents } = {}) {
  let timer = null;
  let closed = false;
  let scanning = false;

  const schedule = () => {
    if (!closed) timer = setTimeout(scan, intervalMs);
  };

  const scan = () => {
    if (closed || scanning) {
      schedule();
      return;
    }
    scanning = true;
    try {
      const architecture = buildArchitecture(projectDir);
      const events = architectureEventsFromChanges(architecture.changes || [], "architecture-watcher");
      if (events.length) onEvents?.(events, architecture);
    } catch (error) {
      onEvents?.(
        [
          {
            phase: "observe",
            title: "Architecture watcher failed",
            status: "failed",
            detail: error.message || String(error),
            source: "architecture-watcher"
          }
        ],
        null
      );
    } finally {
      scanning = false;
      schedule();
    }
  };

  schedule();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    }
  };
}
