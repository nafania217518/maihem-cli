import { describe, it, expect, vi } from "vitest";
import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { createAgent } from "../src/agent.ts";
import type { AgentEvent } from "../src/protocol.ts";

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
type Reason = "stop" | "tool-calls" | "length" | "content-filter" | "other";
const use = (i: number, o: number) => ({ inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: o, text: o, reasoning: 0 } });
const finish = (reason: Reason, u = usage, raw: string = reason) => ({ type: "finish" as const, finishReason: { unified: reason, raw }, usage: u });
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
    expect(events.map((e) => e.type)).toEqual(["user", "step", "tool", "tool-result", "context", "step", "text", "context", "done"]);
    expect(events[2]).toMatchObject({ name: "echo", input: { s: "hi" } });
    expect(events[3]).toMatchObject({ name: "echo", ok: true, id: "c1", output: "echo:hi" });
    expect(events[8]).toMatchObject({ usage: { inputTokens: 6, outputTokens: 4 } });
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
  it("stream errors are not dumped to the console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } });
    await expect(createAgent({ model, tools, maxSteps: 2 }).run("t", () => {})).rejects.toThrow("boom");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
  const summary = { doGenerate: async () => ({ content: [{ type: "text" as const, text: "SUMMARY" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) };
  const overflowErr = () => new APICallError({ message: "prompt is too long", url: "x", requestBodyValues: {}, statusCode: 400, isRetryable: false });
  const roles = (call: { prompt: { role: string }[] }) => call.prompt.map((m) => m.role);
  const big = "original-task " + "x".repeat(2000);
  const toolStepU = (i: number, o: number) => stream([{ type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ s: "hi" }) }, finish("tool-calls", use(i, o))]);
  it("the next turn still sees tool calls and results of earlier steps", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), textStep("a"), textStep("b")] });
    const agent = createAgent({ model, tools, maxSteps: 5 });
    await agent.run("one", () => {});
    await agent.run("two", () => {});
    expect(roles(model.doStreamCalls[2])).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  });
  it("thinking deltas become thinking events", async () => {
    const model = new MockLanguageModelV4({ doStream: [stream([{ type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "hmm" }, { type: "reasoning-end", id: "r" }, finish("stop")])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e));
    expect(events.find((e) => e.type === "thinking")).toMatchObject({ delta: "hmm" });
  });
  it("context event reports the last step's input plus output", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStepU(10, 5), stream([finish("stop", use(20, 7))])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 3, context: 1000 }).run("t", (e) => events.push(e));
    expect(events.filter((e) => e.type === "context")).toMatchObject([{ used: 15, budget: 1000 }, { used: 27, budget: 1000 }]);
  });
  it("reasoning is passed to the model", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("a")] });
    await createAgent({ model, tools, maxSteps: 2, reasoning: "high" }).run("t", () => {});
    expect((model.doStreamCalls[0] as { reasoning?: string }).reasoning).toBe("high");
  });
  it("proactive compaction runs between steps and emits compacted", async () => {
    const model = new MockLanguageModelV4({ ...summary, doStream: [toolStepU(80, 5), textStep("ok")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 3, context: 100 }).run(big, (e) => events.push(e));
    const types = events.map((e) => e.type);
    expect(types.indexOf("compacted")).toBeLessThan(types.lastIndexOf("step"));
    expect(types.indexOf("compacted")).toBeGreaterThan(types.indexOf("tool-result"));
    expect(events.find((e) => e.type === "compacted")).toMatchObject({ before: 85 });
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("SUMMARY");
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).not.toContain("original-task");
  });
  it("the next turn sends the compacted conversation", async () => {
    const model = new MockLanguageModelV4({ ...summary, doStream: [toolStepU(80, 5), stream([finish("stop", use(10, 1))]), textStep("b")] });
    const agent = createAgent({ model, tools, maxSteps: 3, context: 100 });
    await agent.run(big, () => {});
    await agent.run("two", () => {});
    const p = JSON.stringify(model.doStreamCalls[2].prompt);
    expect(p).toContain("SUMMARY");
    expect(p).not.toContain("original-task");
  });
  it("fail policy ends the turn as context full without another model call", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => toolStepU(95, 5) });
    const agent = createAgent({ model, tools, maxSteps: 5, context: 100, onContextFull: "fail" });
    const events: AgentEvent[] = [];
    await agent.run("t", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "context full" });
    expect(model.doStreamCalls.length).toBe(1);
    await agent.run("t2", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "context full" });
    expect(model.doStreamCalls.length).toBe(1);
  });
  it("an overflow error compacts and retries once", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({ ...summary, doStream: async () => { n++; if (n === 1) return toolStep(); if (n === 2) throw overflowErr(); return textStep("ok"); } });
    const events: AgentEvent[] = [];
    const text = await createAgent({ model, tools, maxSteps: 5 }).run(big, (e) => events.push(e));
    expect(text).toBe("ok");
    expect(events.some((e) => e.type === "compacted")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain("SUMMARY");
  });
  it("a second overflow error is reported as an error", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({ ...summary, doStream: async () => { if (n++ === 0) return toolStep(); throw overflowErr(); } });
    const events: AgentEvent[] = [];
    await expect(createAgent({ model, tools, maxSteps: 5 }).run(big, (e) => events.push(e))).rejects.toThrow("prompt is too long");
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400 });
    expect(events.filter((e) => e.type === "compacted").length).toBe(1);
  });
  const doneOf = async (s: ReturnType<typeof stream>) => {
    const events: AgentEvent[] = [];
    await createAgent({ model: new MockLanguageModelV4({ doStream: [s] }), tools, maxSteps: 3, onContextFull: "fail" }).run("t", (e) => events.push(e));
    return events.at(-1);
  };
  it("finish reason length marks the turn as output limit", async () => {
    expect(await doneOf(stream([finish("length")]))).toMatchObject({ type: "done", incomplete: "output limit" });
  });
  it("content filter marks the turn as content filter", async () => {
    expect(await doneOf(stream([finish("content-filter")]))).toMatchObject({ type: "done", incomplete: "content filter" });
  });
  it("raw model_context_window_exceeded marks the turn as context full", async () => {
    expect(await doneOf(stream([finish("other", usage, "model_context_window_exceeded")]))).toMatchObject({ type: "done", incomplete: "context full" });
  });
  it("chat step limit ends the turn as step limit", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => toolStep() });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "step limit", steps: 2 });
  });
  it("one-shot step limit adds a final step without tools", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), toolStep(), textStep("summary")] });
    const events: AgentEvent[] = [];
    const text = await createAgent({ model, tools, maxSteps: 2, oneShot: true }).run("t", (e) => events.push(e));
    expect(text).toBe("summary");
    expect(model.doStreamCalls.length).toBe(3);
    expect(model.doStreamCalls[2].toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(model.doStreamCalls[2].prompt.at(-1))).toContain("step limit");
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "step limit", steps: 2 });
  });
  it("an empty final step marks a one-shot turn as no output", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), stream([finish("stop")])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 5, requireOutput: true }).run("t", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "no output" });
  });
  it("requireOutput off keeps an empty final step complete", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep(), stream([finish("stop")])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 5 }).run("t", (e) => events.push(e));
    expect(events.at(-1)).not.toHaveProperty("incomplete");
  });
  it("step limit keeps priority over no output", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => toolStep() });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 2, requireOutput: true }).run("t", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done", incomplete: "step limit" });
  });
  it("error events carry status and attempts", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 503, responseHeaders: { "retry-after-ms": "0" } }); } });
    const events: AgentEvent[] = [];
    await expect(createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e))).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ type: "error", message: "overloaded", status: 503, attempts: 3 });
  });
  it("finished steps stay after an error", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({ doStream: async () => { n++; if (n === 1) return toolStep(); if (n === 2) throw new Error("boom"); return textStep("ok"); } });
    const agent = createAgent({ model, tools, maxSteps: 5 });
    await expect(agent.run("one", () => {})).rejects.toThrow("boom");
    await agent.run("two", () => {});
    expect(roles(model.doStreamCalls[2])).toEqual(["user", "assistant", "tool", "user"]);
  });
  it("rate limits come from response headers", async () => {
    const headers = { "x-ratelimit-remaining-requests": "9", "anthropic-ratelimit-input-tokens-remaining": "100", "content-type": "x" };
    const model = new MockLanguageModelV4({ doStream: [{ ...textStep("a"), response: { headers } }] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e));
    expect((events.at(-1) as { rateLimits?: object }).rateLimits).toEqual({ "x-ratelimit-remaining-requests": "9", "anthropic-ratelimit-input-tokens-remaining": "100" });
  });
  it("a mid-stream error is retried", async () => {
    const err = new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 503 });
    const model = new MockLanguageModelV4({ doStream: [stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "par" }, { type: "error", error: err }]), textStep("full")] });
    const events: AgentEvent[] = [];
    await createAgent({ model, tools, maxSteps: 2 }).run("t", (e) => events.push(e));
    expect(model.doStreamCalls.length).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
  it("done reports generation speed over the turn's steps", async () => {
    const slow = { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "a" }, { type: "text-delta", id: "t", delta: "b" }, { type: "text-end", id: "t" }, finish("stop")], chunkDelayInMs: 10 }) };
    const model = new MockLanguageModelV4({ doStream: [slow] });
    const events: AgentEvent[] = [];
    await createAgent({ model, system: "s", tools, maxSteps: 5 }).run("t", (e) => events.push(e));
    const done = events.at(-1) as { tps?: number };
    expect(done.tps).toBeGreaterThan(0);
  });
  it("tps is omitted when no generation time is measured", async () => {
    const model = new MockLanguageModelV4({ doStream: [stream([finish("stop")])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, system: "s", tools, maxSteps: 5 }).run("t", (e) => events.push(e));
    expect(events.at(-1)).not.toHaveProperty("tps");
  });
  it("context event carries the step's generation speed", async () => {
    const slow = { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "a" }, { type: "text-delta", id: "t", delta: "b" }, { type: "text-end", id: "t" }, finish("stop")], chunkDelayInMs: 10 }) };
    const model = new MockLanguageModelV4({ doStream: [slow] });
    const events: AgentEvent[] = [];
    await createAgent({ model, system: "s", tools, maxSteps: 5 }).run("t", (e) => events.push(e));
    const ctx = events.find((e) => e.type === "context") as { tps?: number };
    expect(ctx.tps).toBeGreaterThan(0);
  });
  it("thinking text does not change the context used", async () => {
    const model = new MockLanguageModelV4({ doStream: [stream([{ type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "x".repeat(40000) }, { type: "reasoning-end", id: "r" }, finish("stop", use(20, 7))])] });
    const events: AgentEvent[] = [];
    await createAgent({ model, system: "s", tools, maxSteps: 5, context: 1000 }).run("t", (e) => events.push(e));
    expect(events.filter((e) => e.type === "context")).toEqual([expect.objectContaining({ used: 27 })]);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });
});
