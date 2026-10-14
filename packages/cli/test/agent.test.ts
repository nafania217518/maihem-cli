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
    expect(events.map((e) => e.type)).toEqual(["user", "step", "tool", "tool-result", "step", "text", "done"]);
    expect(events[2]).toMatchObject({ name: "echo", input: { s: "hi" } });
    expect(events[3]).toMatchObject({ name: "echo", ok: true, id: "c1", output: "echo:hi" });
    expect(events[6]).toMatchObject({ usage: { inputTokens: 6, outputTokens: 4 } });
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
    expect(events[3]).toMatchObject({ type: "tool-result", ok: false, id: "c1", output: expect.stringContaining("nope") });
  });
  it("model error emits error event and rethrows", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } });
    const agent = createAgent({ model, tools, maxSteps: 2 });
    const events: AgentEvent[] = [];
    await expect(agent.run("t", (e) => events.push(e))).rejects.toThrow("boom");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "boom" });
  });
  it("error stream part emits error event", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => stream([{ type: "error", error: "bad" }]) });
    const events: AgentEvent[] = [];
    await expect(createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e))).rejects.toThrow("bad");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "bad" });
  });
  it("events carry a timestamp", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("x")] });
    const events: AgentEvent[] = [];
    const before = Date.now();
    await createAgent({ model, tools, maxSteps: 3 }).run("t", (e) => events.push(e));
    for (const e of events) expect((e as { at: number }).at).toBeGreaterThanOrEqual(before);
  });
  it("tool call and result share an id", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("x")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 3 }).run("t", (e) => events.push(e));
    expect(events.find((e) => e.type === "tool")).toMatchObject({ id: "c1" });
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ id: "c1" });
  });
  it("tool-result carries the full output capped at 16000 chars", async () => {
    const big = { echo: tool({ description: "e", inputSchema: z.object({ s: z.string() }), execute: async () => "a\n" + "x".repeat(20000) }) };
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("x")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools: big, maxSteps: 3 }).run("t", (e) => events.push(e));
    const r = events.find((e) => e.type === "tool-result") as { output: string; preview?: string };
    expect(r.output).toBe(("a\n" + "x".repeat(20000)).slice(0, 16000));
    expect(r.preview).toBeUndefined();
  });
  it("start of each step emits a step event", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("x")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 3 }).run("t", (e) => events.push(e));
    expect(events.filter((e) => e.type === "step").length).toBe(2);
  });
  const slowText = () => ({ stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: "text-start", id: "t" }, ...Array.from({ length: 50 }, () => ({ type: "text-delta" as const, id: "t", delta: "z" })), { type: "text-end", id: "t" }, finish("stop")], chunkDelayInMs: 20 }) });
  it("interrupt ends the turn with done interrupted", async () => {
    const model = new MockLanguageModelV4({ doStream: [slowText()] });
    const agent = createAgent({ model, tools, maxSteps: 3 });
    agent.interrupt();
    const events: AgentEvent[] = [];
    await agent.run("t", (e) => { events.push(e); if (e.type === "text") agent.interrupt(); });
    expect(events.at(-1)).toMatchObject({ type: "done", interrupted: true });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
  it("after an interrupt the next turn still sees the finished steps", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), slowText(), textStep("ok")] });
    const agent = createAgent({ model, tools, maxSteps: 3 });
    await agent.run("first", (e) => { if (e.type === "text") agent.interrupt(); });
    await agent.run("second", () => {});
    const prompt = JSON.stringify(model.doStreamCalls[2].prompt);
    expect(prompt).toContain("first");
    expect(prompt).toContain("tool-call");
    expect(prompt).toContain("echo:hi");
    expect(prompt).not.toContain("zz");
  });
});
