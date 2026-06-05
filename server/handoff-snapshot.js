import { buildNextAgentPrompt } from "./next-agent-prompt.js";
import { buildAgentContextPrompt } from "./agent-context-prompt.js";
import { writeAgentContextDrill } from "./agent-context-drill.js";
import { refreshTakeoverAcceptanceAudit } from "./takeover-acceptance-audit.js";
import { buildContinuityAudit, writeContinuityAudit } from "./continuity-audit.js";
import { readContinuity, readRuntime, writeContinuity, writeRuntime } from "./runtime-state.js";

function nowIso() {
  return new Date().toISOString();
}

function snapshotStatus(reason, status, extra = {}) {
  return {
    reason,
    status,
    updatedAt: nowIso(),
    ...extra
  };
}

export function createAutoHandoffSnapshot(projectDir, { role = "coding_agent", delayMs = 750, terminalSnapshot, onSnapshot } = {}) {
  let timer = null;
  let running = false;
  let pendingReason = null;

  function updateRuntime(status) {
    const runtime = readRuntime(projectDir);
    runtime.handoffSnapshot = status;
    writeRuntime(projectDir, runtime);
    onSnapshot?.(status);
    return status;
  }

  async function writeSnapshot(reason) {
    if (running) {
      pendingReason = reason;
      return null;
    }
    running = true;
    updateRuntime(snapshotStatus(reason, "writing"));
    const doneStatus = snapshotStatus(reason, "done");
    try {
      const result = await buildNextAgentPrompt(projectDir, {
        role,
        writeFile: true,
        writeResume: true,
        writeRecovery: true,
        persistArchitecture: false,
        handoffSnapshot: doneStatus,
        terminalSnapshot: typeof terminalSnapshot === "function" ? terminalSnapshot() : terminalSnapshot
      });
      let continuity = writeContinuity(projectDir, readContinuity(projectDir) || result.continuity || {});
      const continuityAudit = buildContinuityAudit(projectDir, continuity, {
        expectedFiles: [".project-agent/continuity-audit.json", ".project-agent/takeover-acceptance-audit.json", ".project-agent/state-manifest.json"]
      });
      writeContinuityAudit(projectDir, continuityAudit);
      const takeoverAcceptance = refreshTakeoverAcceptanceAudit(projectDir, {
        ...continuity,
        continuityAudit
      });
      continuity = takeoverAcceptance.continuity;
      const contextPrompt = buildAgentContextPrompt(projectDir, { writeFile: true });
      const contextDrill = writeAgentContextDrill(projectDir);
      return updateRuntime(
        {
          ...doneStatus,
          nextAgentPromptFile: result.file,
          contextStarterPromptFile: contextPrompt.file,
          contextTakeoverDrillFile: contextDrill.file,
          takeoverAcceptanceAuditFile: takeoverAcceptance.file,
          resumeFile: result.resumeFile,
          recoveryFile: result.recoveryFile,
          continuityGeneratedAt: continuity?.generatedAt || result.continuity?.generatedAt
        }
      );
    } catch (error) {
      return updateRuntime(snapshotStatus(reason, "failed", { error: error.message || String(error) }));
    } finally {
      running = false;
      if (pendingReason) {
        const nextReason = pendingReason;
        pendingReason = null;
        schedule(nextReason);
      }
    }
  }

  function schedule(reason = "runtime-change") {
    pendingReason = reason;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const nextReason = pendingReason || reason;
      pendingReason = null;
      writeSnapshot(nextReason);
    }, delayMs);
  }

  return {
    schedule,
    writeNow: writeSnapshot,
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingReason = null;
    }
  };
}
