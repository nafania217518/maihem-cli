import { APICallError, RetryError, streamText } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { AgentEvent, Incomplete } from "./protocol.ts";
import type { Reasoning } from "./definition.ts";
import { compact, estimate, isOverflow } from "./compact.ts";

export interface Agent {
  run(task: string, onEvent: (e: AgentEvent) => void): Promise<string>;
  interrupt(): void;
  history: AgentEvent[];
}

export interface AgentOptions {
  model: LanguageModel;
  system?: string;
  tools: ToolSet;
  maxSteps: number;
  reasoning?: Reasoning;
  context?: number;
  onContextFull?: "compact" | "fail";
  compactAt?: number;
  oneShot?: boolean;
}

const WRAP_UP = "You reached the step limit. Do not call tools. Summarise what you did, what is left, and stop.";
const EXCEEDED = "model_context_window_exceeded";
const RATE_KEYS = ["x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-input-tokens-remaining", "anthropic-ratelimit-output-tokens-remaining"];
type Usage = { inputTokens?: number; outputTokens?: number };
const total = (u: Usage): number => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);

export function createAgent(opts: AgentOptions): Agent {
  const budget = opts.context;
  const fail = opts.onContextFull === "fail";
  let messages: ModelMessage[] = [];
  const history: AgentEvent[] = [];
  let used = 0;
  let ctrl: AbortController | undefined;
  return {
    history,
    interrupt() { ctrl?.abort(); },
    async run(task, onEvent) {
      const emit = (e: AgentEvent): void => { const s = { ...e, at: Date.now() } as AgentEvent; history.push(s); onEvent(s); };
      emit({ type: "user", text: task });
      messages.push({ role: "user", content: task });
      // saved = everything the model has seen plus every finished step; survives errors and interrupts
      let saved = [...messages];
      const commit = (): void => { messages = saved; };
      if (fail && budget && used >= budget) { commit(); emit({ type: "done", incomplete: "context full" }); return ""; }
      let text = "";
      const usage = { inputTokens: 0, outputTokens: 0 };
      let count = 0, wrap = false, full = false;
      let last: { finishReason: string; rawFinishReason?: string; response: { headers?: Record<string, string> } } | undefined;
      const pending: AgentEvent[] = [];
      ctrl = new AbortController();
      const signal = ctrl.signal;
      const shrink = async (ms: ModelMessage[], keep: number, before: number): Promise<ModelMessage[] | undefined> => {
        const c = await compact(opts.model, ms, Math.floor(keep * 0.25), signal);
        if (c) { used = estimate(c); pending.push({ type: "compacted", before, after: used }); }
        return c;
      };
      const flush = (): void => { pending.splice(0).forEach(emit); };
      const pass = async (): Promise<void> => {
        const result = streamText({
          model: opts.model, instructions: opts.system, tools: opts.tools, messages: saved, abortSignal: signal, reasoning: opts.reasoning, streamRetries: 2,
          onError: () => {}, // the default handler dumps the error to the console; the error part still reaches fullStream
          stopWhen: ({ steps }) => (full = fail && !!budget && total(steps.at(-1)!.usage) >= budget) || steps.length >= opts.maxSteps + (opts.oneShot ? 1 : 0),
          prepareStep: async ({ messages: ms, stepNumber }) => {
            saved = ms;
            let override: ModelMessage[] | undefined;
            if (!fail && budget && used >= (opts.compactAt ?? 0.8) * budget) override = await shrink(ms, budget, used);
            if (override) saved = override;
            if (opts.oneShot && stepNumber === opts.maxSteps) {
              wrap = true;
              saved = [...saved, { role: "user", content: WRAP_UP }];
              return { messages: saved, toolChoice: "none" }; // ponytail: Ollama ignores toolChoice
            }
            return override && { messages: override };
          },
          onStepEnd: (step) => { saved = [...saved, ...step.response.messages]; used = total(step.usage); },
        });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") { text += part.text; emit({ type: "text", delta: part.text }); }
          else if (part.type === "reasoning-delta") emit({ type: "thinking", delta: part.text });
          else if (part.type === "start-step") { flush(); emit({ type: "step" }); }
          else if (part.type === "finish-step") {
            count++; last = part;
            usage.inputTokens += part.usage.inputTokens ?? 0; usage.outputTokens += part.usage.outputTokens ?? 0;
            emit({ type: "context", used: total(part.usage), budget });
          }
          else if (part.type === "tool-call") emit({ type: "tool", id: part.toolCallId, name: part.toolName, input: part.input });
          else if (part.type === "tool-result") emit({ type: "tool-result", id: part.toolCallId, name: part.toolName, ok: true, output: String(part.output).slice(0, 16000) });
          else if (part.type === "tool-error") emit({ type: "tool-result", id: part.toolCallId, name: part.toolName, ok: false, output: String(part.error).slice(0, 16000) });
          else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      };
      const interrupted = (): string => { commit(); flush(); emit({ type: "done", interrupted: true }); return text; };
      let retried = false;
      const reactive = async (): Promise<boolean> => {
        if (retried || fail) return false;
        retried = true;
        const before = estimate(saved);
        const c = await shrink(saved, budget ?? before, before);
        if (c) saved = c;
        flush();
        return !!c;
      };
      try {
        for (;;) {
          try { await pass(); }
          catch (e) { if (!signal.aborted && isOverflow(e) && await reactive()) continue; throw e; }
          if (signal.aborted) return interrupted();
          if (last?.rawFinishReason === EXCEEDED && await reactive()) continue;
          break;
        }
      } catch (e) {
        if (signal.aborted) return interrupted();
        commit(); flush();
        const err = RetryError.isInstance(e) ? e.lastError : e;
        emit({
          type: "error", message: err instanceof Error ? err.message : String(err),
          ...(APICallError.isInstance(err) && { status: err.statusCode }),
          ...(RetryError.isInstance(e) && { attempts: e.errors.length }),
        });
        throw e;
      } finally {
        ctrl = undefined;
      }
      commit(); flush();
      const steps = count - (wrap ? 1 : 0);
      const fr = last?.finishReason;
      const incomplete: Incomplete | undefined = full ? "context full"
        : wrap || (fr === "tool-calls" && steps >= opts.maxSteps) ? "step limit"
        : last?.rawFinishReason === EXCEEDED ? "context full"
        : fr === "length" ? "output limit"
        : fr === "content-filter" ? "content filter" : undefined;
      const headers = last?.response.headers ?? {};
      const rateLimits = Object.fromEntries(RATE_KEYS.filter((k) => headers[k] !== undefined).map((k) => [k, headers[k]]));
      emit({ type: "done", usage, steps, ...(incomplete && { incomplete }), ...(Object.keys(rateLimits).length && { rateLimits }) });
      return text;
    },
  };
}
