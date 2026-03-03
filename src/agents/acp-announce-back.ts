import { callGateway } from "../gateway/call.js";
import { normalizeDeliveryContext, type DeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel } from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { AGENT_LANE_NESTED } from "./lanes.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

const ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const ACP_RUN_ANNOUNCE_BACK_WAIT_SLICE_MS = 20_000;
const ACP_RUN_ANNOUNCE_BACK_OUTPUT_RETRY_MS = 8_000;
const ACP_RUN_ANNOUNCE_BACK_OUTPUT_POLL_MS = 250;
const ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS = 24_000;

type AcpAnnounceOutcome =
  | { status: "ok" }
  | { status: "error"; error?: string }
  | { status: "timeout" };

const ACTIVE_RUN_ANNOUNCE_BACK = new Set<string>();

/**
 * In-memory store for ACP session output.
 * dispatch-acp.ts writes here; announce-back reads from here.
 * Keyed by session key.
 */
const ACP_SESSION_OUTPUT = new Map<string, string>();

export function storeAcpSessionOutput(sessionKey: string, text: string): void {
  ACP_SESSION_OUTPUT.set(sessionKey, text);
}

export function readAcpSessionOutput(sessionKey: string): string | undefined {
  return ACP_SESSION_OUTPUT.get(sessionKey);
}

export function clearAcpSessionOutput(sessionKey: string): void {
  ACP_SESSION_OUTPUT.delete(sessionKey);
}

function _normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function truncateMessage(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n\n...(truncated)";
  const keep = Math.max(0, maxChars - suffix.length);
  return text.slice(0, keep) + suffix;
}

function buildCompletionMessage(params: {
  outcome: AcpAnnounceOutcome;
  output?: string;
  task: string;
  label?: string;
  childSessionKey: string;
  elapsedMs: number;
}): string {
  const { outcome, output, task, label: _label, childSessionKey: _childSessionKey } = params;
  const statusIcon =
    outcome.status === "ok" ? "\u2705" : outcome.status === "timeout" ? "\u23f0" : "\u274c";
  const header = `${statusIcon} ACP finished`;

  if (output?.trim()) {
    const taskSnippet = task.length > 200 ? task.slice(0, 200) + "..." : task;
    return `${header}\n\n${output}\n\nTask:\n${taskSnippet}`;
  }
  if (task) {
    return `${header}\n\n(no output)\n\nTask:\n${task}`;
  }
  return `${header}\n\n(no output)`;
}

async function waitForRunCompletion(params: {
  runId: string;
  timeoutMs: number;
}): Promise<AcpAnnounceOutcome> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const sliceMs = Math.min(
      ACP_RUN_ANNOUNCE_BACK_WAIT_SLICE_MS,
      params.timeoutMs - (Date.now() - startedAt),
    );
    if (sliceMs <= 0) {
      break;
    }
    try {
      const result = await callGateway<{ status?: string }>({
        method: "agent.wait",
        params: { runId: params.runId, timeoutMs: sliceMs },
        timeoutMs: sliceMs + 5_000,
      });
      if (result?.status === "ok") {
        return { status: "ok" };
      }
    } catch {
      // Continue polling
    }
  }
  return { status: "timeout" };
}

async function readOutput(params: {
  sessionKey: string;
  maxWaitMs: number;
}): Promise<string | undefined> {
  const startedAt = Date.now();

  // First try the in-memory store (written by dispatch-acp.ts)
  const stored = readAcpSessionOutput(params.sessionKey);
  if (stored?.trim()) {
    clearAcpSessionOutput(params.sessionKey);
    return stored;
  }

  // Fall back to chat history (may work for some session types)
  let last = await readLatestAssistantReply({ sessionKey: params.sessionKey, limit: 120 });
  if (last?.trim()) {
    return last;
  }

  // Retry loop
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= params.maxWaitMs) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, ACP_RUN_ANNOUNCE_BACK_OUTPUT_POLL_MS));

    // Check in-memory store again
    const storedRetry = readAcpSessionOutput(params.sessionKey);
    if (storedRetry?.trim()) {
      clearAcpSessionOutput(params.sessionKey);
      return storedRetry;
    }

    last = await readLatestAssistantReply({ sessionKey: params.sessionKey, limit: 120 });
    if (last?.trim()) {
      return last;
    }
  }
  return undefined;
}

interface AcpRunAnnounceRegistration {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  task: string;
  label?: string;
}

export function registerAcpRunAnnounceBack(params: AcpRunAnnounceRegistration): void {
  const key = params.childSessionKey;
  if (ACTIVE_RUN_ANNOUNCE_BACK.has(key)) {
    return;
  }
  ACTIVE_RUN_ANNOUNCE_BACK.add(key);

  runAnnounceBack(params)
    .catch(() => {})
    .finally(() => {
      ACTIVE_RUN_ANNOUNCE_BACK.delete(key);
      clearAcpSessionOutput(key);
    });
}

async function runAnnounceBack(params: AcpRunAnnounceRegistration): Promise<void> {
  const startedAt = Date.now();
  const outcome = await waitForRunCompletion({
    runId: params.runId,
    timeoutMs: ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS,
  });

  const output = await readOutput({
    sessionKey: params.childSessionKey,
    maxWaitMs: ACP_RUN_ANNOUNCE_BACK_OUTPUT_RETRY_MS,
  });

  const elapsedMs = Date.now() - startedAt;
  const message = buildCompletionMessage({
    outcome,
    output: output ? truncateMessage(output, ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS) : undefined,
    task: params.task,
    label: params.label,
    childSessionKey: params.childSessionKey,
    elapsedMs,
  });

  const origin = normalizeDeliveryContext(params.requesterOrigin);
  const deliver = !!(origin?.channel && isDeliverableMessageChannel(origin.channel));
  const idempotencyKey = buildAnnounceIdempotencyKey(
    `acp-announce:${params.childSessionKey}:${params.runId}`,
  );

  try {
    await callGateway({
      method: "agent",
      params: {
        sessionKey: params.requesterSessionKey,
        message,
        channel: deliver ? origin?.channel : INTERNAL_MESSAGE_CHANNEL,
        accountId: deliver ? origin?.accountId : undefined,
        to: deliver ? origin?.to : undefined,
        threadId: deliver ? origin?.threadId : undefined,
        deliver,
        lane: AGENT_LANE_NESTED,
        idempotencyKey,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.childSessionKey,
          sourceTool: "acp_announce_back",
        },
      },
      timeoutMs: 30_000,
    });
  } catch {
    // Best-effort
  }
}
