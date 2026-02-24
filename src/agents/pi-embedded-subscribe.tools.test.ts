import { describe, expect, it } from "vitest";
import {
  extractMessagingToolSend,
  extractToolErrorMessage,
} from "./pi-embedded-subscribe.tools.js";

describe("extractMessagingToolSend", () => {
  it("extracts target from 'to' field", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      to: "C123",
      channel: "slack",
    });
    expect(result).toBeDefined();
    expect(result!.to).toBe("C123");
    expect(result!.provider).toBe("slack");
  });

  it("extracts target from 'target' field when 'to' is absent", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      target: "C456",
      channel: "slack",
    });
    expect(result).toBeDefined();
    expect(result!.to).toBe("C456");
    expect(result!.provider).toBe("slack");
  });

  it("prefers 'to' over 'target' when both present", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      to: "C111",
      target: "C222",
      channel: "slack",
    });
    expect(result).toBeDefined();
    expect(result!.to).toBe("C111");
  });

  it("falls back to context when no explicit target", () => {
    const result = extractMessagingToolSend(
      "message",
      { action: "send", message: "hello" },
      { provider: "slack", channelId: "C789" },
    );
    expect(result).toBeDefined();
    expect(result!.to).toBe("C789");
    expect(result!.provider).toBe("slack");
  });

  it("returns undefined when no target and no fallback", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      message: "hello",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-send actions", () => {
    const result = extractMessagingToolSend("message", {
      action: "react",
      to: "C123",
    });
    expect(result).toBeUndefined();
  });
});

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });
});
