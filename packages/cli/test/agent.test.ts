import { describe, it, expect, vi } from "vitest";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { createAgent } from "../src/agent.ts";
import type { AgentEvent } from "../src/protocol.ts";

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const finish = (reason: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified: reason, raw: reason }, usage });
const stream = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
const toolStep = () => stream([{ type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ s: "hi" }) }, finish("tool-calls")]);
const textStep = (t: string) => stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }, finish("stop")]);

const echo = vi.fn(async ({ s }: { s: string }) => `echo:${s}`);
const tools = { echo: tool({ description: "echo", inputSchema: z.object({ s: z.string() }), execute: echo }) };

describe("agent", () => {
  it("executes a tool step then returns final text, events in order", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("done!")] });
    const agent = createAgent({ model, system: "sys", tools, maxSteps: 5 });
    const events: AgentEvent[] = [];
    const text = await agent.run("task", (e) => events.push(e));
    expect(text).toBe("done!");
    expect(echo).toHaveBeenCalledWith({ s: "hi" }, expect.anything());
    expect(events.map((e) => e.type)).toEqual(["user", "tool", "tool-result", "text", "done"]);
    expect(events[1]).toMatchObject({ name: "echo", input: { s: "hi" } });
    expect(events[2]).toMatchObject({ name: "echo", ok: true, preview: "echo:hi" });
    expect(events[4]).toMatchObject({ usage: { inputTokens: 6, outputTokens: 4 } });
    expect(agent.history).toEqual(events);
  });
  it("stops at maxSteps", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => toolStep() });
    await createAgent({ model, tools, maxSteps: 3 }).run("t", () => {});
    expect(model.doStreamCalls.length).toBe(3);
  });
  it("second run includes prior messages", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => textStep("a") });
    const agent = createAgent({ model, tools, maxSteps: 2 });
    await agent.run("one", () => {});
    await agent.run("two", () => {});
    expect(model.doStreamCalls[1].prompt.length).toBeGreaterThan(model.doStreamCalls[0].prompt.length);
  });
  it("tool error becomes a failed tool-result", async () => {
    const bad = { echo: tool({ description: "e", inputSchema: z.object({ s: z.string() }), execute: async (_i: { s: string }): Promise<string> => { throw new Error("nope"); } }) };
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("x")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools: bad, maxSteps: 3 }).run("t", (e) => events.push(e));
    expect(events[2]).toMatchObject({ type: "tool-result", ok: false, preview: expect.stringContaining("nope") });
  });
  it("model error emits error event and rethrows", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } });
    const agent = createAgent({ model, tools, maxSteps: 2 });
    const events: AgentEvent[] = [];
    await expect(agent.run("t", (e) => events.push(e))).rejects.toThrow("boom");
    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
  });
  it("error stream part emits error event", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => stream([{ type: "error", error: "bad" }]) });
    const events: AgentEvent[] = [];
    await expect(createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e))).rejects.toThrow("bad");
    expect(events.at(-1)).toEqual({ type: "error", message: "bad" });
  });
});
