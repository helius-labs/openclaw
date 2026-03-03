import { callGateway } from "../gateway/call.js";
import { normalizeDeliveryContext, type DeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel } from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { AGENT_LANE_NESTED } from "./lanes.js";

const ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const ACP_RUN_ANNOUNCE_BACK_WAIT_SLICE_MS = 20_000;
const ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS = 24_000;

type AcpAnnounceOutcome =
  | { status: "ok"; outputText?: string }
  | { status: "error"; error?: string; outputText?: string }
  | { status: "timeout" };

const ACTIVE_RUN_ANNOUNCE_BACK = new Set<string>();

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
  const { outcome, output, task } = params;
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

/**
 * Wait for an ACP run to complete via agent.wait.
 * agent.wait now returns outputText alongside status, so we get the
 * output directly from the agent-job event cache — no side-channel needed.
 */
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
      const result = await callGateway<{
        status?: string;
        error?: string;
        outputText?: string;
      }>({
        method: "agent.wait",
        params: { runId: params.runId, timeoutMs: sliceMs },
        timeoutMs: sliceMs + 5_000,
      });
      if (result?.status === "ok") {
        return { status: "ok", outputText: result.outputText };
      }
      if (result?.status === "error") {
        return { status: "error", error: result.error, outputText: result.outputText };
      }
    } catch {
      // Continue polling
    }
  }
  return { status: "timeout" };
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
    });
}

async function runAnnounceBack(params: AcpRunAnnounceRegistration): Promise<void> {
  const startedAt = Date.now();
  const outcome = await waitForRunCompletion({
    runId: params.runId,
    timeoutMs: ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS,
  });

  // Output comes directly from agent.wait (via the agent-job event cache)
  const rawOutput =
    outcome.status !== "timeout" ? outcome.outputText?.trim() || undefined : undefined;

  const elapsedMs = Date.now() - startedAt;
  const message = buildCompletionMessage({
    outcome,
    output: rawOutput
      ? truncateMessage(rawOutput, ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS)
      : undefined,
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
