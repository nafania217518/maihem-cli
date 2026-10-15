import { describe, it, expect } from "vitest";
import { APICallError, RetryError } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { estimate, splitPoint, isOverflow, compact, SUMMARY_PROMPT } from "../src/compact.ts";

const u = (t: string): ModelMessage => ({ role: "user", content: t });
const a = (t: string): ModelMessage => ({ role: "assistant", content: t });
const tr = (): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "x", output: { type: "text", value: "r" } }] });
const apiErr = (statusCode: number, message: string, responseBody?: string) =>
  new APICallError({ message, url: "u", requestBodyValues: {}, statusCode, responseBody });

describe("compact", () => {
  it("estimate is chars divided by 4", () => {
    const ms = [u("hello")];
    expect(estimate(ms)).toBe(Math.ceil(JSON.stringify(ms).length / 4));
  });

  it("split never starts the kept part with a tool message", () => {
    const ms = [u("x".repeat(400)), a("y".repeat(400)), tr(), tr()];
    const i = splitPoint(ms, estimate([tr()]) * 2)!;
    expect(i).toBe(1);
    expect(ms[i].role).not.toBe("tool");
  });

  it("split keeps at least the last message", () => {
    expect(splitPoint([u("a"), u("b".repeat(1000))], 1)).toBe(1);
  });

  it("split returns undefined when nothing can be summarised", () => {
    expect(splitPoint([u("a"), a("b")], 10000)).toBeUndefined();
    expect(splitPoint([a("x"), tr()], 1)).toBeUndefined();
  });

  it("isOverflow detects OpenAI and Anthropic overflow errors and ignores 429", () => {
    const openai = apiErr(400, "Bad request", '{"error":{"code":"context_length_exceeded"}}');
    const anthropic = apiErr(400, "prompt is too long: 210000 tokens > 200000 maximum");
    expect(isOverflow(openai)).toBe(true);
    expect(isOverflow(anthropic)).toBe(true);
    expect(isOverflow(new RetryError({ message: "r", reason: "maxRetriesExceeded", errors: [anthropic] }))).toBe(true);
    expect(isOverflow(apiErr(429, "prompt is too long"))).toBe(false);
    expect(isOverflow(new Error("prompt is too long"))).toBe(false);
  });

  it("compact returns the summary message followed by the kept tail", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "SUM" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }),
    });
    const ms = [u("x".repeat(400)), a("y".repeat(400)), u("last")];
    const out = await compact(model, ms, 10);
    expect(out).toEqual([{ role: "user", content: "[Summary of earlier conversation]\nSUM" }, u("last")]);
    const call = model.doGenerateCalls[0];
    expect(call.tools ?? []).toEqual([]);
    expect(JSON.stringify(call.prompt[0])).toContain(JSON.stringify(SUMMARY_PROMPT).slice(1, 40));
    expect(await compact(model, [u("a")], 10000)).toBeUndefined();
  });
});
