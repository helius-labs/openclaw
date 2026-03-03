import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeDeliveryContext, type DeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel } from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { AGENT_LANE_NESTED } from "./lanes.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

const ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour (best-effort; non-blocking)
const ACP_RUN_ANNOUNCE_BACK_WAIT_SLICE_MS = 20_000;
const ACP_RUN_ANNOUNCE_BACK_OUTPUT_RETRY_MS = 8_000;
const ACP_RUN_ANNOUNCE_BACK_OUTPUT_POLL_MS = 250;
const ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS = 24_000;

type AcpAnnounceOutcome =
  | { status: "ok" }
  | { status: "error"; error?: string }
  | { status: "timeout" };

const ACTIVE_RUN_ANNOUNCE_BACK = new Set<string>();

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function truncateMessage(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n\n…(truncated)";
  const keep = Math.max(0, maxChars - suffix.length);
  return text.slice(0, keep) + suffix;
}

function buildCompletionMessage(params: {
  outcome: AcpAnnounceOutcome;
  label?: string;
  task: string;
  output?: string;
}): string {
  const label = normalizeText(params.label);
  const labelSuffix = label ? ` (${label})` : "";
  const header =
    params.outcome.status === "ok"
      ? `✅ ACP finished${labelSuffix}`
      : params.outcome.status === "timeout"
        ? `⏱️ ACP timed out${labelSuffix}`
        : `❌ ACP failed${labelSuffix}`;

  const output = normalizeText(params.output);
  if (output) {
    return `${header}\n\n${output}`;
  }

  const task = normalizeText(params.task);
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
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= params.timeoutMs) {
      return { status: "timeout" };
    }

    const sliceMs = Math.max(
      1,
      Math.min(ACP_RUN_ANNOUNCE_BACK_WAIT_SLICE_MS, params.timeoutMs - elapsed),
    );

    try {
      const wait = await callGateway<{
        status?: string;
        error?: string;
      }>({
        method: "agent.wait",
        params: { runId: params.runId, timeoutMs: sliceMs },
        timeoutMs: sliceMs + 2000,
      });
      const status = normalizeText(wait?.status);
      if (status === "ok") {
        return { status: "ok" };
      }
      if (status === "error") {
        const error = normalizeText(wait?.error);
        return { status: "error", ...(error ? { error } : {}) };
      }
    } catch (err) {
      defaultRuntime.log(
        `[warn] acp-announce-back: agent.wait failed for ${params.runId}: ${String(err)}`,
      );
    }
  }
}

async function readLatestAssistantReplyWithRetry(params: {
  sessionKey: string;
  maxWaitMs: number;
}): Promise<string | undefined> {
  const startedAt = Date.now();
  let last = await readLatestAssistantReply({ sessionKey: params.sessionKey, limit: 120 });
  if (last?.trim()) {
    return last;
  }
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= params.maxWaitMs) {
      return last;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ACP_RUN_ANNOUNCE_BACK_OUTPUT_POLL_MS));
    last = await readLatestAssistantReply({ sessionKey: params.sessionKey, limit: 120 });
    if (last?.trim()) {
      return last;
    }
  }
}

async function announceBack(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  task: string;
  label?: string;
  idempotencyKey: string;
}): Promise<void> {
  const requesterDepth = getSubagentDepthFromSessionStore(params.requesterSessionKey);
  const requesterIsSubagent = requesterDepth >= 1;
  const origin = normalizeDeliveryContext(params.requesterOrigin);
  const canDeliver =
    !requesterIsSubagent &&
    Boolean(origin?.channel && origin?.to) &&
    isDeliverableMessageChannel(origin?.channel ?? "");

  const outcome = await waitForRunCompletion({
    runId: params.runId,
    timeoutMs: ACP_RUN_ANNOUNCE_BACK_TIMEOUT_MS,
  });
  const output = await readLatestAssistantReplyWithRetry({
    sessionKey: params.childSessionKey,
    maxWaitMs: ACP_RUN_ANNOUNCE_BACK_OUTPUT_RETRY_MS,
  });

  const completionMessage = truncateMessage(
    buildCompletionMessage({
      outcome,
      label: params.label,
      task: params.task,
      output,
    }),
    ACP_RUN_ANNOUNCE_BACK_MAX_MESSAGE_CHARS,
  );

  await callGateway({
    method: "agent",
    params: {
      sessionKey: params.requesterSessionKey,
      message: completionMessage,
      idempotencyKey: params.idempotencyKey,
      lane: AGENT_LANE_NESTED,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.childSessionKey,
        sourceTool: "acp_announce_back",
      },
      channel: canDeliver ? origin?.channel : INTERNAL_MESSAGE_CHANNEL,
      accountId: canDeliver ? origin?.accountId : undefined,
      to: canDeliver ? origin?.to : undefined,
      threadId: canDeliver ? origin?.threadId : undefined,
      deliver: canDeliver,
    },
    timeoutMs: 20_000,
  });
}

export function registerAcpRunAnnounceBack(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  task: string;
  label?: string;
}): void {
  const runId = normalizeText(params.runId);
  const childSessionKey = normalizeText(params.childSessionKey);
  const requesterSessionKey = normalizeText(params.requesterSessionKey);
  if (!runId || !childSessionKey || !requesterSessionKey) {
    return;
  }

  const idempotencyKey = buildAnnounceIdempotencyKey(
    `acp:v1:${childSessionKey}:${runId}:${requesterSessionKey}`,
  );
  if (ACTIVE_RUN_ANNOUNCE_BACK.has(idempotencyKey)) {
    return;
  }
  ACTIVE_RUN_ANNOUNCE_BACK.add(idempotencyKey);

  void announceBack({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterOrigin: params.requesterOrigin,
    task: params.task,
    label: params.label,
    idempotencyKey,
  })
    .catch((err) => {
      defaultRuntime.log(
        `[warn] acp-announce-back: announce-back failed for ${runId} (${childSessionKey}): ${String(err)}`,
      );
    })
    .finally(() => {
      ACTIVE_RUN_ANNOUNCE_BACK.delete(idempotencyKey);
    });
}
