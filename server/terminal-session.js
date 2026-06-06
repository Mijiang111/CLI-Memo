import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pythonPtyBridge = path.join(__dirname, "python-pty-bridge.py");

function cleanCommand(command) {
  return stripResidualTrackingTokens(stripTrackingControlSequences(command))
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

function stripBracketedPasteMarkers(data) {
  return String(data || "")
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\[200~/g, "")
    .replace(/\[201~/g, "");
}

function stripTrackingControlSequences(data) {
  return stripBracketedPasteMarkers(data)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1bO[ -~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>]/g, "");
}

function stripResidualTrackingTokens(command) {
  return String(command || "")
    .replace(/\[20[01]~/g, "")
    .replace(/\[(?:I|O)/g, "")
    .replace(/\[\d+;\d+R/g, "")
    .replace(/\[\?[\d;]*c/g, "")
    .replace(/\]\d+;[^\s\\]*(?:\\)?/g, "");
}

function firstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    return candidate;
  }
  return os.platform() === "win32" ? "powershell.exe" : "/bin/sh";
}

function resolveShell(preferred) {
  if (os.platform() === "win32") return preferred || process.env.ComSpec || "powershell.exe";
  return firstExisting([preferred, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"]);
}

function pipeShellArgs(shell) {
  const name = path.basename(shell).toLowerCase();
  if (name.includes("powershell")) return ["-NoLogo"];
  if (name === "cmd.exe") return [];
  if (["zsh", "bash", "sh"].includes(name)) return ["-i"];
  return ["-i"];
}

export class TerminalSession {
  constructor({ projectDir, shell, onEvent }) {
    this.projectDir = projectDir;
    this.shell = resolveShell(shell);
    this.cols = 96;
    this.rows = 28;
    this.clients = new Set();
    this.inputBuffer = "";
    this.currentCommand = null;
    this.lastCommand = null;
    this.commandHistory = [];
    this.outputBuffer = "";
    this.startedAt = null;
    this.pty = null;
    this.pipe = null;
    this.pipeMode = "";
    this.backend = "stopped";
    this.backendReason = "";
    this.onEvent = onEvent;
  }

  start() {
    if (this.pty || this.pipe) return;
    const ptyError = this.startPty();
    if (ptyError) {
      const bridgeError = this.startPythonPty(ptyError);
      if (bridgeError) this.startPipe(bridgeError);
    }
  }

  env() {
    const stateDir = path.join(this.projectDir, ".project-agent");
    mkdirSync(stateDir, { recursive: true });
    return {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PROJECT_AGENT_TERMINAL: "1",
      HISTFILE: path.join(stateDir, "terminal-history")
    };
  }

  startPty() {
    try {
      this.pty = pty.spawn(this.shell, [], {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: this.projectDir,
        env: this.env()
      });
    } catch (error) {
      this.pty = null;
      this.backend = "starting";
      this.backendReason = error.message || String(error);
      return error;
    }
    this.backend = "pty";
    this.backendReason = "";
    this.broadcast({ type: "terminal-mode", backend: this.backend, shell: path.basename(this.shell) });
    this.pty.onData((data) => {
      this.handleOutput(data);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.broadcast({ type: "exit", exitCode, signal });
      this.pty = null;
      this.backend = "stopped";
    });
    return null;
  }

  startPipe(ptyError) {
    const reason = ptyError?.message || String(ptyError || "PTY unavailable");
    this.backend = "pipe";
    this.backendReason = reason;
    this.pipeMode = "shell";
    this.pipe = spawn(this.shell, pipeShellArgs(this.shell), {
      cwd: this.projectDir,
      env: this.env(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.broadcast({ type: "terminal-mode", backend: this.backend, reason, shell: path.basename(this.shell) });
    this.broadcast({
      type: "output",
      data:
        `\r\n[Project Agent Terminal] PTY unavailable (${reason}).\r\n` +
        "[Project Agent Terminal] Running pipe shell mode: commands and evidence capture work; full-screen interactive apps are limited.\r\n"
    });
    this.pipe.stdout.on("data", (data) => this.handleOutput(data.toString()));
    this.pipe.stderr.on("data", (data) => this.handleOutput(data.toString()));
    this.pipe.on("error", (error) => {
      this.backend = "failed";
      this.backendReason = error.message || String(error);
      this.broadcast({ type: "terminal-error", message: this.backendReason });
      this.pipe = null;
      this.pipeMode = "";
    });
    this.pipe.on("exit", (exitCode, signal) => {
      this.broadcast({ type: "exit", exitCode, signal });
      this.pipe = null;
      this.pipeMode = "";
      this.backend = "stopped";
    });
  }

  startPythonPty(ptyError) {
    if (!existsSync(pythonPtyBridge)) return ptyError || new Error("Python PTY bridge is missing.");
    const reason = ptyError?.message || String(ptyError || "node-pty unavailable");
    this.backend = "python-pty";
    this.backendReason = `node-pty unavailable: ${reason}`;
    this.pipeMode = "python-pty";
    try {
      this.pipe = spawn("python3", [
        pythonPtyBridge,
        "--shell",
        this.shell,
        "--cwd",
        this.projectDir,
        "--cols",
        String(this.cols),
        "--rows",
        String(this.rows)
      ], {
        cwd: this.projectDir,
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.pipe = null;
      this.pipeMode = "";
      return error;
    }
    this.broadcast({ type: "terminal-mode", backend: this.backend, reason: this.backendReason, shell: path.basename(this.shell) });
    this.broadcast({
      type: "output",
      data:
        `\r\n[Project Agent Terminal] node-pty unavailable (${reason}).\r\n` +
        "[Project Agent Terminal] Running Python PTY bridge: interactive CLI agents receive a real TTY.\r\n"
    });
    this.pipe.stdout.on("data", (data) => this.handleOutput(data.toString()));
    this.pipe.stderr.on("data", (data) => this.handleOutput(data.toString()));
    this.pipe.on("error", (error) => {
      this.backend = "failed";
      this.backendReason = error.message || String(error);
      this.broadcast({ type: "terminal-error", message: this.backendReason });
      this.pipe = null;
      this.pipeMode = "";
    });
    this.pipe.on("exit", (exitCode, signal) => {
      this.broadcast({ type: "exit", exitCode, signal });
      this.pipe = null;
      this.pipeMode = "";
      this.backend = "stopped";
    });
    return null;
  }

  handleOutput(data) {
    if (this.currentCommand) {
      this.outputBuffer += data;
      if (this.outputBuffer.length > 20000) this.outputBuffer = this.outputBuffer.slice(-20000);
    }
    this.broadcast({ type: "output", data });
  }

  attach(ws) {
    this.clients.add(ws);
    this.start();
    ws.send(
      JSON.stringify({
        type: "meta",
        projectDir: this.projectDir,
        shell: path.basename(this.shell),
        backend: this.backend,
        backendReason: this.backendReason,
        lastCommand: this.lastCommand
      })
    );
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input") this.write(msg.data || "");
      if (msg.type === "resize") this.resize(msg.cols, msg.rows);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
    });
  }

  write(data) {
    if (!this.pty) this.start();
    const writableData = stripBracketedPasteMarkers(data);
    this.trackInput(data);
    if (!writableData) return;
    if (this.pty) {
      this.pty.write(writableData);
      return;
    }
    if (!this.pipe || !this.pipe.stdin.writable) return;
    if (this.pipeMode === "python-pty") {
      this.pipe.stdin.write(writableData);
      return;
    }
    if (writableData.includes("\x03")) {
      this.echoPipeInput(writableData);
      this.pipe.kill("SIGINT");
      return;
    }
    this.echoPipeInput(writableData);
    this.pipe.stdin.write(writableData.replace(/\r/g, "\n"));
  }

  resize(cols, rows) {
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
  }

  echoPipeInput(data) {
    let rendered = "";
    for (const char of data) {
      if (char === "\r") rendered += "\r\n";
      else if (char === "\u007f" || char === "\b") rendered += "\b \b";
      else if (char === "\x03") rendered += "^C\r\n";
      else if (char >= " " && char <= "~") rendered += char;
    }
    if (rendered) this.handleOutput(rendered);
  }

  trackInput(data) {
    for (const char of stripTrackingControlSequences(data)) {
      if (char === "\x03" || char === "\x15") {
        this.inputBuffer = "";
        continue;
      }
      if (char === "\r") {
        const command = cleanCommand(this.inputBuffer);
        this.inputBuffer = "";
        if (!command) return;
        this.currentCommand = {
          command,
          startedAt: new Date().toISOString()
        };
        this.startedAt = Date.now();
        this.outputBuffer = "";
        this.emitEvent({
          phase: "execute",
          title: "Command started",
          status: "current",
          detail: command,
          refs: ["terminal-session"],
          source: "terminal-session"
        });
        this.broadcast({ type: "command-start", command: this.currentCommand });
        return;
      }
      if (char === "\u007f" || char === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        continue;
      }
      if (char >= " " && char <= "~") {
        this.inputBuffer += char;
      }
    }
  }

  captureLastCommand() {
    if (this.currentCommand) {
      const captured = {
        ...this.currentCommand,
        finishedAt: new Date().toISOString(),
        output: this.outputBuffer
      };
      this.lastCommand = captured;
      this.commandHistory.unshift(captured);
      this.commandHistory = this.commandHistory.slice(0, 30);
      this.currentCommand = null;
      this.outputBuffer = "";
      this.emitEvent({
        phase: "execute",
        title: "Command completed",
        status: "done",
        detail: captured.command,
        refs: ["terminal-session"],
        source: "terminal-session"
      });
      this.broadcast({ type: "command-captured", command: captured });
      return captured;
    }
    return this.lastCommand;
  }

  getSnapshot() {
    return {
      projectDir: this.projectDir,
      shell: path.basename(this.shell),
      backend: this.backend,
      backendReason: this.backendReason,
      currentCommand: this.currentCommand,
      lastCommand: this.currentCommand
        ? {
            ...this.currentCommand,
            output: this.outputBuffer
          }
        : this.lastCommand,
      history: this.commandHistory.slice(0, 10)
    };
  }

  broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(raw);
    }
  }

  emitEvent(event) {
    try {
      this.onEvent?.(event);
    } catch {}
  }
}
