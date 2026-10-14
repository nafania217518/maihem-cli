import { ToolLoopAgent, isStepCount } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { AgentEvent } from "./protocol.ts";

export interface Agent {
  run(task: string, onEvent: (e: AgentEvent) => void): Promise<string>;
  history: AgentEvent[];
}

export function createAgent(opts: { model: LanguageModel; system?: string; tools: ToolSet; maxSteps: number }): Agent {
  const loop = new ToolLoopAgent({ model: opts.model, instructions: opts.system, tools: opts.tools, stopWhen: isStepCount(opts.maxSteps) });
  const messages: ModelMessage[] = [];
  const history: AgentEvent[] = [];
  return {
    history,
    async run(task, onEvent) {
      const emit = (e: AgentEvent): void => { history.push(e); onEvent(e); };
      emit({ type: "user", text: task });
      messages.push({ role: "user", content: task });
      let text = "";
      try {
        const result = await loop.stream({ messages });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") { text += part.text; emit({ type: "text", delta: part.text }); }
          else if (part.type === "tool-call") emit({ type: "tool", name: part.toolName, input: part.input });
          else if (part.type === "tool-result") emit({ type: "tool-result", name: part.toolName, ok: true, preview: String(part.output).slice(0, 80) });
          else if (part.type === "tool-error") emit({ type: "tool-result", name: part.toolName, ok: false, preview: String(part.error).slice(0, 80) });
          else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        messages.push(...(await result.response).messages);
        const u = await result.totalUsage;
        emit({ type: "done", usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens } });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
        throw e;
      }
      return text;
    },
  };
}
