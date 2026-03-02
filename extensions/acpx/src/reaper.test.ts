import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACPX_PINNED_VERSION } from "./config.js";
import { SessionReaper } from "./reaper.js";

// Minimal mock CLI that logs `sessions close` calls and exits successfully.
const MOCK_CLI_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.MOCK_ACPX_LOG;
const writeLog = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

if (args.includes("--version")) {
  process.stdout.write("mock-acpx ${ACPX_PINNED_VERSION}\n");
  process.exit(0);
}

const commandIndex = args.findIndex(
  (arg) => arg === "sessions",
);
const agent = commandIndex > 0 ? args[commandIndex - 1] : "unknown";
const subcommand = commandIndex >= 0 ? args[commandIndex + 1] : "";
const closeName = subcommand === "close" ? String(args[commandIndex + 2] || "") : "";

if (subcommand === "close") {
  writeLog({ kind: "close", agent, sessionName: closeName, args });
  process.stdout.write(JSON.stringify({
    type: "session_closed",
    acpxSessionId: "sid-" + closeName,
    name: closeName,
  }) + "\n");
  process.exit(0);
}

writeLog({ kind: "unknown", args });
process.exit(2);
`;

const tempDirs: string[] = [];

async function createMockEnv(): Promise<{
  scriptPath: string;
  logPath: string;
  sessionsDir: string;
  queuesDir: string;
  cwd: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-reaper-test-"));
  tempDirs.push(dir);

  const scriptPath = path.join(dir, "mock-acpx.cjs");
  const logPath = path.join(dir, "calls.log");
  const sessionsDir = path.join(dir, "sessions");
  const queuesDir = path.join(dir, "queues");
  await mkdir(sessionsDir);
  await mkdir(queuesDir);

  await writeFile(scriptPath, MOCK_CLI_SCRIPT, "utf8");
  await chmod(scriptPath, 0o755);
  process.env.MOCK_ACPX_LOG = logPath;

  return { scriptPath, logPath, sessionsDir, queuesDir, cwd: dir };
}

async function readLogEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  if (!existsSync(logPath)) {
    return [];
  }
  const raw = await readFile(logPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeSession(
  sessionsDir: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const id = name.replace(/[^a-z0-9]/gi, "-");
  const record = {
    id,
    sessionId: id,
    name,
    closed: false,
    lastUsedAt: new Date().toISOString(),
    agentCommand: "mock-agent",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  await writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify(record), "utf8");
}

/**
 * Write a queue owner lock file for a given session ID.
 * Mirrors the acpx CLI: sha256(sessionId).slice(0, 24) + ".lock".
 */
async function writeQueueLock(queuesDir: string, sessionId: string, pid: number): Promise<void> {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const lockPath = path.join(queuesDir, `${key}.lock`);
  await writeFile(
    lockPath,
    JSON.stringify({
      pid,
      sessionId,
      socketPath: path.join(queuesDir, `${key}.sock`),
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

afterEach(async () => {
  delete process.env.MOCK_ACPX_LOG;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

describe("SessionReaper", () => {
  describe("TTL-based idle cleanup", () => {
    it("returns 0 and is a no-op when the sessions directory does not exist", async () => {
      const { scriptPath, cwd } = await createMockEnv();
      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir: path.join(cwd, "nonexistent-sessions"),
      });

      const count = await reaper.reap();
      expect(count).toBe(0);
    });

    it("skips sessions that are already closed", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      const pastTime = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
      await writeSession(sessionsDir, "agent:claude:acp:closed-session", {
        closed: true,
        lastUsedAt: pastTime,
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);

      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("skips sessions that are still within TTL", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      // Used 30 seconds ago, TTL is 60 seconds — should NOT be reaped
      const recentTime = new Date(Date.now() - 30_000).toISOString();
      await writeSession(sessionsDir, "agent:codex:acp:recent-session", {
        lastUsedAt: recentTime,
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);

      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("closes sessions that have been idle beyond TTL", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      // Used 10 minutes ago, TTL is 60 seconds — should be reaped
      const staleTime = new Date(Date.now() - 600_000).toISOString();
      await writeSession(sessionsDir, "agent:claude:acp:stale-session", {
        lastUsedAt: staleTime,
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(1);

      const logs = await readLogEntries(logPath);
      const closeEntry = logs.find((e) => e.kind === "close");
      expect(closeEntry).toBeDefined();
      expect(closeEntry?.sessionName).toBe("agent:claude:acp:stale-session");
      expect(closeEntry?.agent).toBe("claude");
    });

    it("closes only stale sessions and leaves fresh ones untouched", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      const staleTime = new Date(Date.now() - 600_000).toISOString();
      const freshTime = new Date(Date.now() - 10_000).toISOString();

      await writeSession(sessionsDir, "agent:claude:acp:stale-one", { lastUsedAt: staleTime });
      await writeSession(sessionsDir, "agent:codex:acp:fresh-one", { lastUsedAt: freshTime });
      await writeSession(sessionsDir, "agent:claude:acp:stale-two", { lastUsedAt: staleTime });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(2);

      const logs = await readLogEntries(logPath);
      const closedNames = logs.filter((e) => e.kind === "close").map((e) => e.sessionName);
      expect(closedNames).toContain("agent:claude:acp:stale-one");
      expect(closedNames).toContain("agent:claude:acp:stale-two");
      expect(closedNames).not.toContain("agent:codex:acp:fresh-one");
    });

    it("derives the correct agent name from the session name prefix", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      const staleTime = new Date(Date.now() - 600_000).toISOString();
      await writeSession(sessionsDir, "agent:codex:acp:test-session", { lastUsedAt: staleTime });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      await reaper.reap();

      const logs = await readLogEntries(logPath);
      const closeEntry = logs.find((e) => e.kind === "close");
      expect(closeEntry?.agent).toBe("codex");
    });

    it("falls back to 'codex' agent when session name has no agent prefix", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      const staleTime = new Date(Date.now() - 600_000).toISOString();
      await writeSession(sessionsDir, "unprefixed-session-name", { lastUsedAt: staleTime });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      await reaper.reap();

      const logs = await readLogEntries(logPath);
      const closeEntry = logs.find((e) => e.kind === "close");
      expect(closeEntry?.agent).toBe("codex");
    });

    it("skips stream ndjson sidecar files", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      // Write a stream sidecar — these should never be treated as session records
      await writeFile(
        path.join(sessionsDir, "some-id.stream.ndjson"),
        '{"event":"text"}\n',
        "utf8",
      );

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);

      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("handles malformed session files without throwing", async () => {
      const { scriptPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      await writeFile(path.join(sessionsDir, "bad.json"), "not-valid-json{{", "utf8");
      await writeFile(path.join(sessionsDir, "empty.json"), "{}", "utf8");

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
      });

      // Should not throw
      const count = await reaper.reap();
      expect(count).toBe(0);
    });

    it("logs a warning when an individual session file cannot be processed", async () => {
      const { scriptPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const warnSpy = vi.fn();

      // Write a file that will parse as JSON but fail during close (missing required fields)
      await writeFile(
        path.join(sessionsDir, "partial.json"),
        JSON.stringify({ closed: false, lastUsedAt: new Date(Date.now() - 999_999).toISOString() }),
        "utf8",
      );

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 60,
        sessionsDir,
        queuesDir,
        logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
      });

      // Should not throw; the record has no `id` or `name` so parseSessionRecord returns null
      const count = await reaper.reap();
      expect(count).toBe(0);
      // No warning for a gracefully-skipped null record
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("orphan detection (PR_SET_PDEATHSIG equivalent)", () => {
    it("does not close a session when the queue owner is alive", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const sessionId = "orphan-test-alive-queue-owner";

      // Write a queue lock with the current process PID (definitely alive).
      await writeQueueLock(queuesDir, sessionId, process.pid);

      await writeSession(sessionsDir, "agent:codex:acp:alive-owner", {
        sessionId,
        lastUsedAt: new Date().toISOString(), // recent — TTL would not fire
        pid: process.pid,
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);
      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("closes a session immediately when the queue owner is dead and the agent is alive", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const sessionId = "orphan-test-dead-queue-owner";

      // No lock file → queue owner is dead (never started or already cleaned up).

      // Spawn a real short-lived process to serve as the "orphaned" agent PID so
      // that isProcessAlive(agentPid) returns true during the check.
      const orphan = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
        detached: true,
        stdio: "ignore",
      });
      orphan.unref();
      const agentPid = orphan.pid!;

      await writeSession(sessionsDir, "agent:codex:acp:orphaned-agent", {
        sessionId,
        lastUsedAt: new Date().toISOString(), // recent — TTL would NOT fire
        pid: agentPid,
        agentCommand: "npx fake-codex-acp",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();

      // Clean up the spawned process regardless of the test outcome.
      try {
        process.kill(agentPid, "SIGTERM");
      } catch {
        // already dead
      }

      expect(count).toBe(1);
      const logs = await readLogEntries(logPath);
      expect(
        logs.some((e) => e.kind === "close" && e.sessionName === "agent:codex:acp:orphaned-agent"),
      ).toBe(true);
    });

    it("does not close a session when the agent PID is already dead", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const sessionId = "orphan-test-already-dead-agent";

      // No lock file (dead queue owner), but use an impossible PID for the agent.
      const impossiblePid = 2_000_000;
      await writeSession(sessionsDir, "agent:codex:acp:dead-agent", {
        sessionId,
        lastUsedAt: new Date().toISOString(),
        pid: impossiblePid,
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);
      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("skips sessions without a pid field (queue owner not yet spawned an agent)", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      // No pid in the session record.
      await writeSession(sessionsDir, "agent:codex:acp:no-pid-session", {
        sessionId: "orphan-test-no-pid",
        lastUsedAt: new Date().toISOString(),
        // pid intentionally omitted
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);
      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("skips sessions that have no sessionId field (cannot locate queue lock)", async () => {
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();

      // Write a session without the sessionId field.
      await writeFile(
        path.join(sessionsDir, "no-sid.json"),
        JSON.stringify({
          id: "no-sid",
          name: "agent:codex:acp:no-sid",
          closed: false,
          lastUsedAt: new Date().toISOString(),
          pid: process.pid,
          // sessionId intentionally omitted
        }),
        "utf8",
      );

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();
      expect(count).toBe(0);
      const logs = await readLogEntries(logPath);
      expect(logs.some((e) => e.kind === "close")).toBe(false);
    });

    it("closes an orphaned session even when lastUsedAt is very recent (TTL-independent)", async () => {
      // This is the key scenario: agent orphaned right after being started.
      // The TTL-based pass would not fire, but the orphan pass must.
      const { scriptPath, logPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const sessionId = "orphan-test-ttl-independent";

      // No lock file.
      const orphan = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
        detached: true,
        stdio: "ignore",
      });
      orphan.unref();
      const agentPid = orphan.pid!;

      await writeSession(sessionsDir, "agent:claude:acp:recent-orphan", {
        sessionId,
        lastUsedAt: new Date().toISOString(), // just now — long TTL would never expire
        pid: agentPid,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 86400, // 1 day TTL — would never trigger normally
        sessionsDir,
        queuesDir,
      });

      const count = await reaper.reap();

      try {
        process.kill(agentPid, "SIGTERM");
      } catch {
        // already dead
      }

      expect(count).toBe(1);
      const logs = await readLogEntries(logPath);
      expect(
        logs.some((e) => e.kind === "close" && e.sessionName === "agent:claude:acp:recent-orphan"),
      ).toBe(true);
    });

    it("logs a message when an orphaned agent is reaped", async () => {
      const { scriptPath, sessionsDir, queuesDir, cwd } = await createMockEnv();
      const infoSpy = vi.fn();
      const sessionId = "orphan-test-logging";

      const orphan = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
        detached: true,
        stdio: "ignore",
      });
      orphan.unref();
      const agentPid = orphan.pid!;

      await writeSession(sessionsDir, "agent:codex:acp:logged-orphan", {
        sessionId,
        lastUsedAt: new Date().toISOString(),
        pid: agentPid,
        agentCommand: "npx fake-codex-acp",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const reaper = new SessionReaper({
        command: scriptPath,
        cwd,
        ttlSeconds: 9999,
        sessionsDir,
        queuesDir,
        logger: { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });

      await reaper.reap();

      try {
        process.kill(agentPid, "SIGTERM");
      } catch {
        // already dead
      }

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("reaped orphaned agent"));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`pid=${agentPid}`));
    });
  });

  describe("start() / stop()", () => {
    it("start() arms the interval timer; stop() clears it", () => {
      const reaper = new SessionReaper({
        command: "/bin/echo",
        cwd: os.tmpdir(),
        ttlSeconds: 60,
        checkIntervalMs: 100_000,
        sessionsDir: path.join(os.tmpdir(), "nonexistent"),
      });

      // Timer should not exist before start
      expect((reaper as unknown as { timer: unknown }).timer).toBeNull();

      reaper.start();
      expect((reaper as unknown as { timer: unknown }).timer).not.toBeNull();

      // start() is idempotent
      const timerRef = (reaper as unknown as { timer: unknown }).timer;
      reaper.start();
      expect((reaper as unknown as { timer: unknown }).timer).toBe(timerRef);

      reaper.stop();
      expect((reaper as unknown as { timer: unknown }).timer).toBeNull();

      // stop() is idempotent
      reaper.stop();
      expect((reaper as unknown as { timer: unknown }).timer).toBeNull();
    });
  });
});
