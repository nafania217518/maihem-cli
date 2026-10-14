import { ToolLoopAgent, isStepCount } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { AgentEvent } from "./protocol.ts";

export interface Agent {
  run(task: string, onEvent: (e: AgentEvent) => void): Promise<string>;
  interrupt(): void;
  history: AgentEvent[];
}

export function createAgent(opts: { model: LanguageModel; system?: string; tools: ToolSet; maxSteps: number }): Agent {
  const loop = new ToolLoopAgent({ model: opts.model, instructions: opts.system, tools: opts.tools, stopWhen: isStepCount(opts.maxSteps) });
  const messages: ModelMessage[] = [];
  const history: AgentEvent[] = [];
  let ctrl: AbortController | undefined;
  return {
    history,
    interrupt() { ctrl?.abort(); },
    async run(task, onEvent) {
      const emit = (e: AgentEvent): void => { const s = { ...e, at: Date.now() } as AgentEvent; history.push(s); onEvent(s); };
      emit({ type: "user", text: task });
      messages.push({ role: "user", content: task });
      let text = "";
      ctrl = new AbortController();
      // a finished step's response.messages holds every message of the finished steps so far; on abort the partial step is dropped
      let finished: ModelMessage[] = [];
      const interrupted = (): string => { messages.push(...finished); emit({ type: "done", interrupted: true }); return text; };
      try {
        const result = await loop.stream({ messages, abortSignal: ctrl.signal, onStepEnd: (step) => { finished = step.response.messages; } });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") { text += part.text; emit({ type: "text", delta: part.text }); }
          else if (part.type === "start-step") emit({ type: "step" });
          else if (part.type === "tool-call") emit({ type: "tool", id: part.toolCallId, name: part.toolName, input: part.input });
          else if (part.type === "tool-result") emit({ type: "tool-result", id: part.toolCallId, name: part.toolName, ok: true, output: String(part.output).slice(0, 16000) });
          else if (part.type === "tool-error") emit({ type: "tool-result", id: part.toolCallId, name: part.toolName, ok: false, output: String(part.error).slice(0, 16000) });
          else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        if (ctrl.signal.aborted) return interrupted();
        messages.push(...(await result.response).messages);
        const u = await result.totalUsage;
        emit({ type: "done", usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens } });
      } catch (e) {
        if (ctrl.signal.aborted) return interrupted();
        emit({ type: "error", message: (e as Error).message });
        throw e;
      } finally {
        ctrl = undefined;
      }
      return text;
    },
  };
}
