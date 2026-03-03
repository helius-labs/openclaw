/**
 * ACP Announce-Back for Run-Mode Sessions
 *
 * When an ACP session is spawned in `mode="run"`, this module monitors the
 * session for completion and pushes the final output back to the parent/requester
 * agent session — mirroring the subagent announce-back pipeline.
 *
 * Without this, the parent agent never learns that the ACP session finished,
 * because `dispatch-acp.ts` only routes replies to the originating channel/thread,
 * not back into the requester session.
 */

import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

const ACP_ANNOUNCE_POLL_INTERVAL_MS = 5_000;
const ACP_ANNOUNCE_MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes
const ACP_ANNOUNCE_TIMEOUT_MS = 30_000;

interface AcpRunAnnounceRegistration {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  task: string;
  label?: string;
}

/**
 * Register an announce-back watcher for an ACP run-mode session.
 * Starts a background poll loop that waits for the session to complete,
 * then injects the result into the requester agent session.
 */
export function registerAcpRunAnnounceBack(params: AcpRunAnnounceRegistration): void {
  // Fire and forget — the poll loop runs in the background
  pollAndAnnounce(params).catch((err) => {
    logVerbose(
      `acp-announce-back: error in announce loop for ${params.childSessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function pollAndAnnounce(params: AcpRunAnnounceRegistration): Promise<void> {
  const startedAt = Date.now();
  const { runId, childSessionKey, requesterSessionKey, requesterOrigin, task, label } = params;

  logVerbose(
    `acp-announce-back: watching run=${runId} child=${childSessionKey} requester=${requesterSessionKey}`,
  );

  let completed = false;

  // Poll loop: try agent.wait, then fall back to history polling
  while (Date.now() - startedAt < ACP_ANNOUNCE_MAX_WAIT_MS) {
    try {
      const waitResult = await callGateway<{ status?: string }>({
        method: "agent.wait",
        params: {
          runId,
          timeoutMs: ACP_ANNOUNCE_POLL_INTERVAL_MS,
        },
        timeoutMs: ACP_ANNOUNCE_POLL_INTERVAL_MS + 5_000,
      });

      if (waitResult?.status === "ok") {
        completed = true;
        break;
      }
    } catch {
      // agent.wait may not support ACP runs — fall through to polling
    }

    // Fallback: poll session history to detect output stabilization
    try {
      const reply = await readLatestAssistantReply({ sessionKey: childSessionKey });
      if (reply?.trim()) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const secondReply = await readLatestAssistantReply({ sessionKey: childSessionKey });
        if (secondReply === reply) {
          completed = true;
          break;
        }
      }
    } catch {
      // Session may not exist yet — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, ACP_ANNOUNCE_POLL_INTERVAL_MS));
  }

  if (!completed) {
    logVerbose(
      `acp-announce-back: timed out waiting for run=${runId} child=${childSessionKey} after ${Date.now() - startedAt}ms`,
    );
  }

  // Read the final output
  let replyText: string | undefined;
  try {
    replyText = await readLatestAssistantReply({ sessionKey: childSessionKey });
  } catch (err) {
    logVerbose(
      `acp-announce-back: failed to read reply from ${childSessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!replyText?.trim()) {
    logVerbose(`acp-announce-back: no output from child=${childSessionKey}, skipping announce`);
    return;
  }

  // Build completion message
  const elapsedMs = Date.now() - startedAt;
  const elapsedSec = Math.round(elapsedMs / 1000);
  const labelPart = label ? ` (${label})` : "";
  const taskSnippet = task.length > 200 ? task.slice(0, 200) + "..." : task;

  const announceMessage = [
    `[System Message] ACP session${labelPart} completed (${elapsedSec}s).`,
    `Task: ${taskSnippet}`,
    `Session: ${childSessionKey}`,
    "",
    "Result:",
    replyText,
  ].join("\n");

  // Inject result into the requester agent session
  try {
    await callGateway({
      method: "agent",
      params: {
        sessionKey: requesterSessionKey,
        message: announceMessage,
        channel: requesterOrigin?.channel,
        accountId: requesterOrigin?.accountId,
        to: requesterOrigin?.to,
        threadId: requesterOrigin?.threadId,
        deliver: !!requesterOrigin?.channel,
      },
      timeoutMs: ACP_ANNOUNCE_TIMEOUT_MS,
    });

    logVerbose(
      `acp-announce-back: announced run=${runId} back to ${requesterSessionKey} (${elapsedSec}s, ${replyText.length} chars)`,
    );
  } catch (err) {
    logVerbose(
      `acp-announce-back: failed to announce to ${requesterSessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
