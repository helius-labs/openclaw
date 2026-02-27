#!/usr/bin/env node
import { execSync } from "node:child_process";
/**
 * Agent Observability Dashboard — standalone server.
 * Reads OpenClaw session JSONL files and workspace memory directly.
 * Binds to 127.0.0.1 only (access via SSH port forwarding).
 *
 * Usage: node server.mjs [--port 9111]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "9111", 10);
const HOME = process.env.HOME ?? "/home/ubuntu";
const SESSIONS_DIR = path.join(HOME, ".openclaw", "agents", "main", "sessions");
const WORKSPACE_DIR = path.join(HOME, ".openclaw", "workspace");
const MEMORY_DIRS = ["bugs", "decisions", "diary", "gotchas", "guide", "patterns"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function parseJsonl(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------
function parseSessionSummary(filePath) {
  const entries = parseJsonl(filePath);
  if (!entries.length || entries[0].type !== "session") {
    return null;
  }
  const first = entries[0];
  let model = null,
    provider = null,
    channel = null,
    lastTs = first.timestamp;
  let msgCount = 0;
  const tok = { input: 0, output: 0, cacheRead: 0, total: 0 };
  let cost = 0;
  const subAgents = [];
  for (const e of entries) {
    if (e.timestamp && e.timestamp > lastTs) {
      lastTs = e.timestamp;
    }
    if (e.type === "model_change") {
      model = e.modelId ?? model;
      provider = e.provider ?? provider;
    }
    if (e.type === "custom" && e.customType === "model-snapshot" && e.data) {
      model = e.data.modelId ?? model;
      provider = e.data.provider ?? provider;
    }
    if (e.type === "message") {
      msgCount++;
      const msg = e.message;
      if (!msg) {
        continue;
      }
      if (!channel && msg.channel) {
        channel = msg.channel;
      }
      if (msg.usage) {
        tok.input += msg.usage.input ?? 0;
        tok.output += msg.usage.output ?? 0;
        tok.cacheRead += msg.usage.cacheRead ?? 0;
        tok.total += msg.usage.totalTokens ?? 0;
        if (msg.usage.cost?.total) {
          cost += msg.usage.cost.total;
        }
      }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (
            b.type === "toolCall" &&
            (b.toolName === "sessions_spawn" || b.toolName === "subagents")
          ) {
            const a = b.args ?? {};
            subAgents.push({
              task: truncate(a.task ?? a.message ?? JSON.stringify(a), 200),
              model: a.model ?? null,
              timestamp: e.timestamp ?? lastTs,
            });
          }
        }
      }
    }
  }
  return {
    id: first.id ?? path.basename(filePath, ".jsonl"),
    file: path.basename(filePath),
    startTime: first.timestamp,
    lastActivity: lastTs,
    model,
    provider,
    channel,
    messageCount: msgCount,
    tokenUsage: tok,
    cost,
    subAgents,
  };
}

function parseTranscript(filePath) {
  const entries = parseJsonl(filePath);
  const result = [];
  for (const e of entries) {
    const ts = e.timestamp ?? "";
    if (e.type === "model_change") {
      result.push({
        type: "model_change",
        timestamp: ts,
        content: `Model → ${e.provider ?? ""}/${e.modelId ?? ""}`,
      });
      continue;
    }
    if (e.type !== "message" || !e.message) {
      continue;
    }
    const msg = e.message;
    const role = msg.role;
    const content = msg.content;
    if (typeof content === "string") {
      result.push({
        type: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
        timestamp: ts,
        role,
        content: truncate(content, 2000),
      });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        result.push({
          type: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
          timestamp: ts,
          role,
          content: truncate(b.text, 2000),
        });
      } else if (b.type === "toolCall") {
        result.push({
          type: "tool_call",
          timestamp: ts,
          toolName: b.toolName,
          toolArgs: truncate(JSON.stringify(b.args ?? {}), 1000),
        });
      } else if (b.type === "toolResult") {
        let preview = "";
        if (typeof b.content === "string") {
          preview = b.content;
        } else if (Array.isArray(b.content)) {
          for (const rc of b.content) {
            if (rc.type === "text") {
              preview += rc.text ?? "";
            }
          }
        }
        result.push({
          type: "tool_result",
          timestamp: ts,
          toolName: b.toolName,
          result: truncate(preview, 500),
        });
      }
    }
  }
  return result;
}

function extractCommands(maxFiles = 20, maxCmds = 200) {
  const cmds = [];
  let files;
  try {
    files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
      .map((f) => ({ name: f, mt: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .toSorted((a, b) => b.mt - a.mt)
      .slice(0, maxFiles)
      .map((f) => f.name);
  } catch {
    return [];
  }
  for (const file of files) {
    const entries = parseJsonl(path.join(SESSIONS_DIR, file));
    const sid = entries[0]?.id ?? file.replace(".jsonl", "");
    for (const e of entries) {
      if (e.type !== "message" || !e.message || !Array.isArray(e.message.content)) {
        continue;
      }
      const calls = new Map(),
        results = new Map();
      for (const b of e.message.content) {
        if (b.type === "toolCall") {
          calls.set(b.toolCallId ?? "", {
            name: b.toolName,
            args: truncate(JSON.stringify(b.args ?? {}), 500),
            ts: e.timestamp ?? "",
          });
        }
        if (b.type === "toolResult") {
          let p = "";
          if (typeof b.content === "string") {
            p = b.content;
          } else if (Array.isArray(b.content)) {
            for (const rc of b.content) {
              if (rc.type === "text") {
                p += rc.text ?? "";
              }
            }
          }
          results.set(b.toolCallId ?? "", truncate(p, 300));
        }
      }
      for (const [id, c] of calls) {
        cmds.push({
          sessionId: sid,
          sessionFile: file,
          timestamp: c.ts,
          toolName: c.name,
          args: c.args,
          resultPreview: results.get(id) ?? "",
        });
      }
    }
    if (cmds.length >= maxCmds) {
      break;
    }
  }
  cmds.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
  return cmds.slice(0, maxCmds);
}

function getMemory() {
  const dirs = {};
  for (const d of MEMORY_DIRS) {
    const dp = path.join(WORKSPACE_DIR, d);
    try {
      dirs[d] = fs
        .readdirSync(dp)
        .filter((f) => !f.startsWith("."))
        .map((f) => {
          const s = fs.statSync(path.join(dp, f));
          return { file: f, modifiedAt: s.mtime.toISOString(), sizeBytes: s.size };
        })
        .toSorted((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));
    } catch {
      dirs[d] = [];
    }
  }
  const changes = [];
  try {
    execSync('git log --pretty=format:"%H|%s|%aI" -20 --no-merges', {
      cwd: WORKSPACE_DIR,
      encoding: "utf-8",
      timeout: 5000,
    })
      .split("\n")
      .filter((l) => l.trim())
      .forEach((l) => {
        const [h, m, t] = l.split("|");
        if (h && m && t) {
          changes.push({ hash: h.slice(0, 8), message: m, timestamp: t });
        }
      });
  } catch {}
  return { directories: dirs, recentChanges: changes };
}

function getMemoryFile(fp) {
  const norm = path.normalize(fp);
  if (norm.startsWith("..") || path.isAbsolute(norm)) {
    return null;
  }
  const parts = norm.split(path.sep);
  if (!MEMORY_DIRS.includes(parts[0])) {
    return null;
  }
  try {
    return fs.readFileSync(path.join(WORKSPACE_DIR, norm), "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf-8"));
    return;
  }

  if (!p.startsWith("/api/")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const route = p.slice(4); // strip /api

  if (route === "/sessions") {
    let files;
    try {
      files = fs
        .readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."));
    } catch {
      sendJson(res, 200, { sessions: [] });
      return;
    }
    const withMt = files
      .map((f) => {
        try {
          return { name: f, mt: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    withMt.sort((a, b) => b.mt - a.mt);
    const sessions = withMt
      .slice(0, 30)
      .map((x) => parseSessionSummary(path.join(SESSIONS_DIR, x.name)))
      .filter(Boolean);
    sessions.sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : -1));
    sendJson(res, 200, { sessions });
    return;
  }

  const txMatch = route.match(/^\/session\/([^/]+)\/transcript$/);
  if (txMatch) {
    const ref = decodeURIComponent(txMatch[1]).replace(/[^a-zA-Z0-9._-]/g, "");
    let fp;
    if (ref.endsWith(".jsonl")) {
      fp = path.join(SESSIONS_DIR, ref);
    } else {
      try {
        const m = fs
          .readdirSync(SESSIONS_DIR)
          .find((f) => f.startsWith(ref) && f.endsWith(".jsonl"));
        if (m) {
          fp = path.join(SESSIONS_DIR, m);
        }
      } catch {}
    }
    if (!fp || !fs.existsSync(fp)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, { entries: parseTranscript(fp) });
    return;
  }

  if (route === "/commands") {
    sendJson(res, 200, { commands: extractCommands() });
    return;
  }
  if (route === "/memory") {
    sendJson(res, 200, getMemory());
    return;
  }

  const mfMatch = route.match(/^\/memory\/file\/(.+)$/);
  if (mfMatch) {
    const content = getMemoryFile(decodeURIComponent(mfMatch[1]));
    if (content === null) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, { path: decodeURIComponent(mfMatch[1]), content });
    return;
  }

  sendJson(res, 404, { error: "Unknown route" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🔭 Agent Observability Dashboard: http://127.0.0.1:${PORT}`);
  console.log(`   Access via: ssh -L ${PORT}:127.0.0.1:${PORT} ubuntu@<host>`);
});
