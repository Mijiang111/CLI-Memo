#!/usr/bin/env node
import path from "node:path";
import { defaultContextQuery, readContextRef, searchContext } from "./grep-context.js";

const args = process.argv.slice(2);

function valueAfter(flag, fallback = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function has(flag) {
  return args.includes(flag);
}

function positionalQuery() {
  const skip = new Set(["--project-dir", "--query", "--read", "--limit", "--max-bytes", "--max-files", "--max-file-bytes"]);
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (skip.has(item)) {
      index += 1;
      continue;
    }
    if (item.startsWith("--")) continue;
    values.push(item);
  }
  return values.join(" ").trim();
}

function usage() {
  return `Usage:
  node server/grep-context-cli.js --project-dir /path/to/project --query "takeover budget"
  node server/grep-context-cli.js --project-dir /path/to/project --read ".project-agent/process-trace.json:1-40"

Options:
  --project-dir PATH       Project root containing .project-agent. Defaults to cwd.
  --query TEXT             Grep-first query. Defaults to the active takeover summary.
  --read REF               Read a returned ref or JSON selector.
  --limit N                Result count. Defaults to 10.
  --max-bytes N            Max bytes for --read output. Defaults to 12000.
  --json                   Print raw JSON.
`;
}

if (has("--help") || has("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectDir = path.resolve(valueAfter("--project-dir", process.env.PROJECT_DIR || process.cwd()));
const maxBytes = Number(valueAfter("--max-bytes", 12000));

try {
  const readRef = valueAfter("--read");
  if (readRef) {
    const result = readContextRef(projectDir, readRef, { maxBytes });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const query = valueAfter("--query") || positionalQuery() || defaultContextQuery(projectDir);
  const result = searchContext(projectDir, {
    query,
    limit: Number(valueAfter("--limit", 10)),
    maxFiles: Number(valueAfter("--max-files", 500)),
    maxFileBytes: Number(valueAfter("--max-file-bytes", 1024 * 1024))
  });

  if (has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Grep context: ${JSON.stringify(result.query)}`);
  console.log(`mode=${result.mode} llmCalls=${result.budget.llmCalls} files=${result.budget.scannedFiles} bytes=${result.budget.scannedBytes}`);
  for (const item of result.results) {
    console.log(`\n${item.rank}. ${item.ref} score=${item.score}`);
    console.log(item.snippet);
  }
  if (result.results[0]) {
    console.log(`\nRead detail: node server/grep-context-cli.js --project-dir ${JSON.stringify(projectDir)} --read ${JSON.stringify(result.results[0].ref)}`);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(error.status || 1);
}
