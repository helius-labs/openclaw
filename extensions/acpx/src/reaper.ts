import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { spawnAndCollect } from "./runtime-internals/process.js";
import { asTrimmedString, deriveAgentFromSessionKey } from "./runtime-internals/shared.js";

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
/** Grace period (ms) after session creation before orphan detection kicks in. */
const ORPHAN_GRACE_PERIOD_MS = 10_000;
const FALLBACK_AGENT = "codex";

type SessionRecord = {
  id: string;
  name: string;
  closed: boolean;
  lastUsedAt: string | null;
};

/** Extended fields needed for orphan detection. */
type SessionRecordFull = SessionRecord & {
  /** Agent OS process PID (absent when session is closed). */
  agentPid: number | null;
  /** ACP session ID (the 'sessionId' field in the JSON file). Used to locate the queue owner lock. */
  acpxSessionId: string | null;
  /** Session creation time — used for startup grace period in orphan detection. */
  createdAt: string | null;
  /** Agent command string — for informational logging. */
  agentCommand: string | null;
};

function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const id = asTrimmedString(rec.id);
  const name = asTrimmedString(rec.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    closed: rec.closed === true,
    lastUsedAt: typeof rec.lastUsedAt === "string" ? rec.lastUsedAt : null,
  };
}

function parseSessionRecordFull(value: unknown): SessionRecordFull | null {
  const base = parseSessionRecord(value);
  if (!base) return null;
  const rec = value as Record<string, unknown>;
  const agentPid =
    typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : null;
  const acpxSessionId =
    typeof rec.sessionId === "string" && rec.sessionId.trim() ? rec.sessionId.trim() : null;
  const agentCommand =
    typeof rec.agentCommand === "string" && rec.agentCommand.trim()
      ? rec.agentCommand.trim()
      : null;
  const createdAt =
    typeof rec.createdAt === "string" && rec.createdAt.trim() ? rec.createdAt.trim() : null;
  return { ...base, agentPid, acpxSessionId, agentCommand, createdAt };
}

/** Check if a process is running by sending signal 0. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/**
 * Compute the queue owner lock file path for a given ACP session ID.
 * Mirrors the acpx CLI: sha256(sessionId).slice(0, 24) + ".lock".
 */
function queueOwnerLockPath(queuesDir: string, acpxSessionId: string): string {
  const key = createHash("sha256").update(acpxSessionId).digest("hex").slice(0, 24);
  return join(queuesDir, `${key}.lock`);
}

/**
 * Return true if the queue owner for the given session is currently alive.
 * Reads the lock file and checks that its recorded PID is still running.
 * Returns false if the lock file is absent, unreadable, or the PID is dead.
 */
async function isQueueOwnerAlive(queuesDir: string, acpxSessionId: string): Promise<boolean> {
  const lockPath = queueOwnerLockPath(queuesDir, acpxSessionId);
  try {
    const raw = await readFile(lockPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const pid = (data as Record<string, unknown>).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    return isProcessAlive(pid);
  } catch {
    // Lock file absent or unreadable → queue owner is not running.
    return false;
  }
}

export type SessionReaperOptions = {
  command: string;
  cwd: string;
  /** Sessions idle beyond this many seconds are forcibly closed. */
  ttlSeconds: number;
  /** How often to scan for stale sessions. Defaults to 60 seconds. */
  checkIntervalMs?: number;
  /** Override the acpx sessions directory (default: ~/.acpx/sessions). */
  sessionsDir?: string;
  /** Override the acpx queues directory (default: ~/.acpx/queues). */
  queuesDir?: string;
  logger?: PluginLogger;
};

/**
 * SessionReaper periodically scans the acpx sessions directory and forcibly
 * closes any session whose backing agent process has been left running after
 * the queue-owner TTL expired without an explicit close() call.
 *
 * This covers three leak scenarios:
 *   1. CLI sessions abandoned by the user (no `sessions close` was issued).
 *   2. Gateway sessions where the gateway crashed or lost track before calling close().
 *   3. Orphaned agent subprocesses whose queue-owner was killed (SIGKILL, OOM)
 *      before the agent could be terminated — the equivalent of PR_SET_PDEATHSIG
 *      implemented as a polling reaper rather than a kernel-level death signal.
 *
 * The reaper calls `acpx {agent} sessions close {name}` for each stale session,
 * which terminates both the queue-owner process (if still alive) and the backing
 * agent subprocess (claude-agent-acp, codex-acp, etc.) via PID.
 */
export class SessionReaper {
  private timer: NodeJS.Timeout | null = null;
  private reaping = false;
  private readonly checkIntervalMs: number;
  private readonly sessionsDir: string;
  private readonly queuesDir: string;

  constructor(private readonly opts: SessionReaperOptions) {
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".acpx", "sessions");
    this.queuesDir = opts.queuesDir ?? join(homedir(), ".acpx", "queues");
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.reap().catch((err) => {
        this.opts.logger?.warn?.(`acpx reaper: scan error: ${String(err)}`);
      });
    }, this.checkIntervalMs);
    // Do not prevent the process from exiting if nothing else is pending.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scan for stale/orphaned sessions and close them.
   * Returns the number of sessions that were closed.
   * Safe to call at any time; errors on individual files are logged and skipped.
   *
   * Runs two passes:
   *   1. Orphan pass: close agent processes whose queue-owner has died,
   *      regardless of idle time (PR_SET_PDEATHSIG equivalent).
   *   2. TTL pass: close sessions that have been idle longer than ttlSeconds.
   */
  async reap(): Promise<number> {
    if (this.reaping) return 0;
    this.reaping = true;
    try {
      let total = 0;
      total += await this.reapOrphanedAgents();
      total += await this.reapIdleSessions();
      return total;
    } finally {
      this.reaping = false;
    }
  }

  /**
   * Detect sessions where the queue-owner process is dead but the agent subprocess
   * is still running, then close those sessions immediately.
   *
   * This is the Node.js equivalent of PR_SET_PDEATHSIG: instead of asking the
   * kernel to signal the child when its parent dies, we poll for the condition and
   * act on it ourselves. The queue-owner lock file is used to determine whether
   * the queue owner is still alive — if the lock is absent or holds a dead PID,
   * the agent is considered orphaned and closed regardless of idle time.
   */
  private async reapOrphanedAgents(): Promise<number> {
    let count = 0;

    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch {
      // Sessions directory does not exist yet — nothing to reap.
      return 0;
    }

    for (const file of files) {
      if (!file.endsWith(".json") || file.includes(".stream.")) {
        continue;
      }

      try {
        const raw = await readFile(join(this.sessionsDir, file), "utf8");
        const record = parseSessionRecordFull(JSON.parse(raw) as unknown);

        if (!record || record.closed) {
          continue;
        }

        const { agentPid, acpxSessionId, name } = record;
        // Need both the agent PID and the ACP session ID to perform orphan detection.
        if (!agentPid || !acpxSessionId) {
          continue;
        }

        // Skip sessions created very recently — the queue owner lock file
        // may not have been written yet (startup race window).
        if (record.createdAt) {
          const age = Date.now() - new Date(record.createdAt).getTime();
          if (age < ORPHAN_GRACE_PERIOD_MS) continue;
        }
        // Skip if the agent process is no longer running.
        if (!isProcessAlive(agentPid)) {
          continue;
        }

        // Check whether the queue owner is still alive via its lock file.
        const queueAlive = await isQueueOwnerAlive(this.queuesDir, acpxSessionId);
        if (queueAlive) {
          continue;
        }

        // Queue owner is dead (absent or stale lock file), agent is alive —
        // this is an orphaned process.
        const agent = deriveAgentFromSessionKey(name, FALLBACK_AGENT);
        await this.closeSession(agent, name);
        count += 1;
        this.opts.logger?.info?.(
          `acpx reaper: reaped orphaned agent pid=${agentPid} name=${name} agent=${agent} command="${record.agentCommand ?? "unknown"}"`,
        );
      } catch (err) {
        this.opts.logger?.warn?.(`acpx reaper: orphan check failed for ${file}: ${String(err)}`);
      }
    }

    return count;
  }

  /**
   * Close sessions that have not been used for longer than ttlSeconds.
   */
  private async reapIdleSessions(): Promise<number> {
    const now = Date.now();
    const ttlMs = this.opts.ttlSeconds * 1_000;
    let closedCount = 0;

    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch {
      // Sessions directory does not exist yet — nothing to reap.
      return 0;
    }

    for (const file of files) {
      // Skip stream logs and non-JSON files.
      if (!file.endsWith(".json") || file.includes(".stream.")) {
        continue;
      }

      try {
        const raw = await readFile(join(this.sessionsDir, file), "utf8");
        const record = parseSessionRecord(JSON.parse(raw) as unknown);

        if (!record || record.closed) {
          continue;
        }

        const lastUsedAt = record.lastUsedAt ? new Date(record.lastUsedAt).getTime() : NaN;
        if (Number.isNaN(lastUsedAt) || now - lastUsedAt < ttlMs) {
          continue;
        }

        const agent = deriveAgentFromSessionKey(record.name, FALLBACK_AGENT);
        await this.closeSession(agent, record.name);
        closedCount += 1;
        this.opts.logger?.info?.(
          `acpx reaper: reaped session name=${record.name} agent=${agent} idle=${Math.round((now - lastUsedAt) / 1_000)}s`,
        );
      } catch (err) {
        this.opts.logger?.warn?.(`acpx reaper: failed to process ${file}: ${String(err)}`);
      }
    }

    return closedCount;
  }

  private async closeSession(agent: string, sessionName: string): Promise<void> {
    await spawnAndCollect({
      command: this.opts.command,
      args: [
        "--format",
        "json",
        "--json-strict",
        "--cwd",
        this.opts.cwd,
        agent,
        "sessions",
        "close",
        sessionName,
      ],
      cwd: this.opts.cwd,
    });
  }
}
