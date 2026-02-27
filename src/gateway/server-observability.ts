import { execSync } from "node:child_process";
/**
 * Agent Observability API endpoints.
 * Reads JSONL session transcripts and workspace memory files.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveSessionTranscriptsDir } from "../config/sessions/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SessionSummary {
  id: string;
  file: string;
  startTime: string;
  lastActivity: string;
  model: string | null;
  provider: string | null;
  channel: string | null;
  messageCount: number;
  tokenUsage: { input: number; output: number; cacheRead: number; total: number };
  cost: number;
  subAgents: Array<{ task: string; model: string | null; timestamp: string }>;
}

interface TranscriptEntry {
  type: string;
  timestamp: string;
  content?: string;
  toolName?: string;
  toolArgs?: string;
  result?: string;
  model?: string;
  role?: string;
}

interface CommandEntry {
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  toolName: string;
  args: string;
  resultPreview: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function parseJsonl(filePath: string): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------
function parseSessionSummary(filePath: string): SessionSummary | null {
  const entries = parseJsonl(filePath);
  if (!entries.length || entries[0].type !== "session") {
    return null;
  }
  const first = entries[0];
  let model: string | null = null;
  let provider: string | null = null;
  let channel: string | null = null;
  let lastTs = first.timestamp as string;
  let msgCount = 0;
  const tok = { input: 0, output: 0, cacheRead: 0, total: 0 };
  let cost = 0;
  const subAgents: SessionSummary["subAgents"] = [];

  for (const e of entries) {
    const ts = e.timestamp as string | undefined;
    if (ts && ts > lastTs) {
      lastTs = ts;
    }
    if (e.type === "model_change") {
      model = (e.modelId as string) ?? model;
      provider = (e.provider as string) ?? provider;
    }
    if (e.type === "custom" && e.customType === "model-snapshot") {
      const data = e.data as Record<string, unknown> | undefined;
      if (data) {
        model = (data.modelId as string) ?? model;
        provider = (data.provider as string) ?? provider;
      }
    }
    if (e.type === "message") {
      msgCount++;
      const msg = e.message as Record<string, unknown> | undefined;
      if (!msg) {
        continue;
      }
      if (!channel && msg.channel) {
        channel = msg.channel as string;
      }
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) {
        tok.input += (usage.input as number) ?? 0;
        tok.output += (usage.output as number) ?? 0;
        tok.cacheRead += (usage.cacheRead as number) ?? 0;
        tok.total += (usage.totalTokens as number) ?? 0;
        const costObj = usage.cost as Record<string, unknown> | undefined;
        if (costObj?.total) {
          cost += costObj.total as number;
        }
      }
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === "toolCall" &&
            (block.toolName === "sessions_spawn" || block.toolName === "subagents")
          ) {
            const args = (block.args as Record<string, unknown>) ?? {};
            subAgents.push({
              task: truncate(
                (args.task as string) ?? (args.message as string) ?? JSON.stringify(args),
                200,
              ),
              model: (args.model as string) ?? null,
              timestamp: ts ?? lastTs,
            });
          }
        }
      }
    }
  }

  return {
    id: (first.id as string) ?? path.basename(filePath, ".jsonl"),
    file: path.basename(filePath),
    startTime: first.timestamp as string,
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

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------
function parseTranscript(filePath: string): TranscriptEntry[] {
  const entries = parseJsonl(filePath);
  const result: TranscriptEntry[] = [];

  for (const e of entries) {
    const ts = (e.timestamp as string) ?? "";
    if (e.type === "model_change") {
      result.push({
        type: "model_change",
        timestamp: ts,
        content: "Model → " + ((e.provider as string) ?? "") + "/" + ((e.modelId as string) ?? ""),
      });
      continue;
    }
    if (e.type !== "message") {
      continue;
    }
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) {
      continue;
    }
    const role = msg.role as string;
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
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && (block.text as string)?.trim()) {
        result.push({
          type: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
          timestamp: ts,
          role,
          content: truncate(block.text as string, 2000),
        });
      } else if (block.type === "toolCall") {
        result.push({
          type: "tool_call",
          timestamp: ts,
          toolName: block.toolName as string,
          toolArgs: truncate(JSON.stringify((block.args as Record<string, unknown>) ?? {}), 1000),
        });
      } else if (block.type === "toolResult") {
        let preview = "";
        const rc = block.content;
        if (typeof rc === "string") {
          preview = rc;
        } else if (Array.isArray(rc)) {
          for (const item of rc as Array<Record<string, unknown>>) {
            if (item.type === "text") {
              preview += (item.text as string) ?? "";
            }
          }
        }
        result.push({
          type: "tool_result",
          timestamp: ts,
          toolName: block.toolName as string,
          result: truncate(preview, 500),
        });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Commands extraction
// ---------------------------------------------------------------------------
function extractCommands(sessionsDir: string, maxFiles = 20, maxCmds = 200): CommandEntry[] {
  const cmds: CommandEntry[] = [];
  let files: string[];
  try {
    files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
      .map((f) => ({ name: f, mt: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .toSorted((a, b) => b.mt - a.mt)
      .slice(0, maxFiles)
      .map((f) => f.name);
  } catch {
    return [];
  }

  for (const file of files) {
    const entries = parseJsonl(path.join(sessionsDir, file));
    const sid = (entries[0]?.id as string) ?? file.replace(".jsonl", "");
    for (const e of entries) {
      if (e.type !== "message") {
        continue;
      }
      const msg = e.message as Record<string, unknown> | undefined;
      if (!msg || !Array.isArray(msg.content)) {
        continue;
      }
      const calls = new Map<string, { name: string; args: string; ts: string }>();
      const results = new Map<string, string>();
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === "toolCall") {
          calls.set((block.toolCallId as string) ?? "", {
            name: block.toolName as string,
            args: truncate(JSON.stringify((block.args as Record<string, unknown>) ?? {}), 500),
            ts: (e.timestamp as string) ?? "",
          });
        }
        if (block.type === "toolResult") {
          let p = "";
          const rc = block.content;
          if (typeof rc === "string") {
            p = rc;
          } else if (Array.isArray(rc)) {
            for (const item of rc as Array<Record<string, unknown>>) {
              if (item.type === "text") {
                p += (item.text as string) ?? "";
              }
            }
          }
          results.set((block.toolCallId as string) ?? "", truncate(p, 300));
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

// ---------------------------------------------------------------------------
// Memory workspace
// ---------------------------------------------------------------------------
const MEMORY_DIRS = ["bugs", "decisions", "diary", "gotchas", "guide", "patterns"];

function getMemoryState(workspaceDir: string) {
  const directories: Record<
    string,
    Array<{ file: string; modifiedAt: string; sizeBytes: number }>
  > = {};
  for (const dir of MEMORY_DIRS) {
    const dp = path.join(workspaceDir, dir);
    try {
      directories[dir] = fs
        .readdirSync(dp)
        .filter((f) => !f.startsWith("."))
        .map((f) => {
          const s = fs.statSync(path.join(dp, f));
          return { file: f, modifiedAt: s.mtime.toISOString(), sizeBytes: s.size };
        })
        .toSorted((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));
    } catch {
      directories[dir] = [];
    }
  }
  const recentChanges: Array<{ hash: string; message: string; timestamp: string }> = [];
  try {
    const log = execSync('git log --pretty=format:"%H|%s|%aI" -20 --no-merges', {
      cwd: workspaceDir,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const line of log.split("\n").filter((l) => l.trim())) {
      const [hash, message, timestamp] = line.split("|");
      if (hash && message && timestamp) {
        recentChanges.push({ hash: hash.slice(0, 8), message, timestamp });
      }
    }
  } catch {
    // git not available
  }
  return { directories, recentChanges };
}

function getMemoryFileContent(workspaceDir: string, filePath: string): string | null {
  const norm = path.normalize(filePath);
  if (norm.startsWith("..") || path.isAbsolute(norm)) {
    return null;
  }
  const parts = norm.split(path.sep);
  if (!MEMORY_DIRS.includes(parts[0])) {
    return null;
  }
  try {
    return fs.readFileSync(path.join(workspaceDir, norm), "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
const PREFIX = "/__openclaw/api/observability";

export function handleObservabilityRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  if (!url.pathname.startsWith(PREFIX)) {
    return false;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  const route = url.pathname.slice(PREFIX.length);
  const sessionsDir = resolveSessionTranscriptsDir();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/home/ubuntu";
  const workspaceDir = path.join(home, ".openclaw", "workspace");

  // GET /sessions
  if (route === "/sessions" || route === "/sessions/") {
    let files: string[];
    try {
      files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."));
    } catch {
      sendJson(res, 200, { sessions: [] });
      return true;
    }
    const withMt = files
      .map((f) => {
        try {
          return { name: f, mt: fs.statSync(path.join(sessionsDir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ name: string; mt: number }>;
    withMt.sort((a, b) => b.mt - a.mt);
    const sessions = withMt
      .slice(0, 30)
      .map((x) => parseSessionSummary(path.join(sessionsDir, x.name)))
      .filter(Boolean);
    sessions.sort((a, b) => ((b?.lastActivity ?? "") > (a?.lastActivity ?? "") ? 1 : -1));
    sendJson(res, 200, { sessions });
    return true;
  }

  // GET /session/:ref/transcript
  const txMatch = route.match(/^\/session\/([^/]+)\/transcript$/);
  if (txMatch) {
    const ref = decodeURIComponent(txMatch[1]).replace(/[^a-zA-Z0-9._-]/g, "");
    let fp: string | undefined;
    if (ref.endsWith(".jsonl")) {
      fp = path.join(sessionsDir, ref);
    } else {
      try {
        const m = fs
          .readdirSync(sessionsDir)
          .find((f) => f.startsWith(ref) && f.endsWith(".jsonl"));
        if (m) {
          fp = path.join(sessionsDir, m);
        }
      } catch {
        // ignore
      }
    }
    if (!fp || !fs.existsSync(fp)) {
      sendJson(res, 404, { error: "Not found" });
      return true;
    }
    const resolved = path.resolve(fp);
    if (!resolved.startsWith(path.resolve(sessionsDir))) {
      sendJson(res, 403, { error: "Forbidden" });
      return true;
    }
    sendJson(res, 200, { entries: parseTranscript(resolved) });
    return true;
  }

  // GET /commands
  if (route === "/commands" || route === "/commands/") {
    sendJson(res, 200, { commands: extractCommands(sessionsDir) });
    return true;
  }

  // GET /memory
  if (route === "/memory" || route === "/memory/") {
    sendJson(res, 200, getMemoryState(workspaceDir));
    return true;
  }

  // GET /memory/file/:path
  const mfMatch = route.match(/^\/memory\/file\/(.+)$/);
  if (mfMatch) {
    const content = getMemoryFileContent(workspaceDir, decodeURIComponent(mfMatch[1]));
    if (content === null) {
      sendJson(res, 404, { error: "Not found" });
      return true;
    }
    sendJson(res, 200, { path: decodeURIComponent(mfMatch[1]), content });
    return true;
  }

  sendJson(res, 404, { error: "Unknown observability route" });
  return true;
}
