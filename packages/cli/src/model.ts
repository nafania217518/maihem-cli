import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { Ollama } from "ollama";
import { setTimeout as wait } from "node:timers/promises";
import { APICallError, RetryError, wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Definition } from "./definition.ts";
import type { Resolved } from "./providers.ts";

// Exponential backoff with "equal jitter": wait base/2 + random * base/2.
// Parallel sessions spread out yet still wait at least half the base; Retry-After raises the floor.
export const retry = {
  delays: [10000, 20000, 40000, 80000, 160000],
  random: Math.random,
  sleep: (ms: number, signal?: AbortSignal) => wait(ms, undefined, { signal }),
};

// 429, 5xx, a malformed 2xx body ("Failed to process successful response") and connection failures (no HTTP status) are worth retrying.
// ai-sdk-ollama wraps ollama's ResponseError (status_code) in OllamaError.cause.
const retryable = (e: unknown): boolean => {
  const status = APICallError.isInstance(e) ? e.statusCode : (e as { cause?: { status_code?: number } }).cause?.status_code;
  if (status !== undefined) return status === 429 || status >= 500 || (status >= 200 && status < 300);
  return APICallError.isInstance(e) ? e.isRetryable : e instanceof TypeError || /fetch failed|ECONNREFUSED/i.test(String(e));
};

const retryAfter = (e: unknown): number => {
  const h = APICallError.isInstance(e) ? e.responseHeaders : undefined;
  const ms = parseFloat(h?.["retry-after-ms"] ?? "");
  if (!isNaN(ms)) return ms;
  const s = h?.["retry-after"];
  return !s ? 0 : (isNaN(parseFloat(s)) ? Date.parse(s) - Date.now() : parseFloat(s) * 1000) || 0;
};

async function withRetries<T>(f: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const errors: unknown[] = [];
  for (;;) {
    try { return await f(); } catch (e) {
      if (signal?.aborted || !retryable(e)) throw e;
      errors.push(e);
      const base = retry.delays[errors.length - 1];
      if (base === undefined) throw new RetryError({ message: `Failed after ${errors.length} attempts. Last error: ${(e as Error).message}`, reason: "maxRetriesExceeded", errors });
      await retry.sleep(Math.max(base / 2 + retry.random() * base / 2, retryAfter(e)), signal);
    }
  }
}

// onAbort: ai-sdk-ollama drops the abort signal; the caller aborts the client itself.
const retrying = (model: LanguageModelV4, onAbort?: () => void): LanguageModel => wrapLanguageModel({
  model,
  middleware: {
    wrapGenerate: ({ doGenerate, params }) => withRetries(doGenerate, params.abortSignal),
    wrapStream: ({ doStream, params }) => {
      if (onAbort) params.abortSignal?.addEventListener("abort", onAbort, { once: true });
      return withRetries(doStream, params.abortSignal);
    },
  },
});

export function createModel(def: Definition, p: Resolved): LanguageModel {
  const opts = { baseURL: p.base_url, apiKey: p.api_key, headers: p.headers };
  switch (p.kind) {
    case "openai":
      return retrying(createOpenAI(opts).chat(def.model)); // chat completions: OpenAI-compatible servers have no /responses
    case "anthropic":
      return retrying(createAnthropic(opts)(def.model));
    case "ollama":
    {
      const client = new Ollama({ host: p.base_url, headers: p.headers });
      return retrying(createOllama({ client })(def.model), () => client.abort());
    }
  }
}
