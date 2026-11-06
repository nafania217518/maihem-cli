import { APICallError, RetryError, generateText } from "ai";
import type { LanguageModel, ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import { SKILL_TOOL } from "./skills.ts";

export const SUMMARY_PROMPT = `Summarise the conversation so far concisely. You (the agent) will use this summary to continue the work. Cover:
- the user's goals
- the latest user request, verbatim
- decisions made
- files changed
- commands run and their results
- open problems
- the next step`;

export function estimate(ms: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(ms).length / 4);
}

export function splitPoint(ms: ModelMessage[], keepTokens: number): number | undefined {
  let i = ms.length - 1;
  let sum = estimate([ms[i]]);
  while (i > 0 && sum + estimate([ms[i - 1]]) <= keepTokens) sum += estimate([ms[--i]]);
  while (i > 0 && ms[i].role === "tool") i--;
  return i <= 0 ? undefined : i;
}

const OVERFLOW = /context_length_exceeded|prompt is too long/i;
function overflow(e: unknown): boolean {
  return APICallError.isInstance(e) && e.statusCode === 400 && (OVERFLOW.test(e.message) || OVERFLOW.test(e.responseBody ?? ""));
}

export function isOverflow(e: unknown): boolean {
  return overflow(e) || (RetryError.isInstance(e) && overflow(e.lastError));
}

export async function compact(model: LanguageModel, ms: ModelMessage[], keepTokens: number, signal?: AbortSignal): Promise<ModelMessage[] | undefined> {
  const i = splitPoint(ms, keepTokens);
  if (i === undefined) return undefined;
  const { text } = await generateText({ model, system: SUMMARY_PROMPT, prompt: JSON.stringify(ms.slice(0, i)), abortSignal: signal, maxRetries: 0 });
  return [{ role: "user", content: "[Summary of earlier conversation]\n" + text }, ...keptSkills(ms.slice(0, i)), ...ms.slice(i)];
}

// The latest loaded result per skill name and file, as one call message and one result message.
function keptSkills(ms: ModelMessage[]): ModelMessage[] {
  const results = new Map<string, ToolResultPart>();
  for (const m of ms) {
    if (m.role !== "tool") continue;
    for (const p of m.content) if (p.type === "tool-result" && p.toolName === SKILL_TOOL) results.set(p.toolCallId, p);
  }
  const calls = new Map<string, ToolCallPart>();
  for (const m of ms) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type !== "tool-call" || p.toolName !== SKILL_TOOL || !results.has(p.toolCallId)) continue;
      const { name, file } = p.input as { name?: string; file?: string };
      const key = JSON.stringify([name, file]);
      calls.delete(key);
      calls.set(key, p);
    }
  }
  if (calls.size === 0) return [];
  const kept = [...calls.values()];
  return [{ role: "assistant", content: kept }, { role: "tool", content: kept.map((c) => results.get(c.toolCallId)!) }];
}
