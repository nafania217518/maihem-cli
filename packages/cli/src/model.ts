import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { Ollama } from "ollama";
import { RetryError, wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";
import type { Resolved } from "./providers.ts";

export const retryDelays = [2000, 4000];

// Connection failures (no HTTP status) and 5xx are worth retrying.
// ai-sdk-ollama wraps ollama's ResponseError (status_code) in OllamaError.cause.
const retryable = (e: unknown): boolean => {
  const status = (e as { cause?: { status_code?: number } }).cause?.status_code;
  return status === undefined ? e instanceof TypeError || /fetch failed|ECONNREFUSED/i.test(String(e)) : status >= 500;
};

export function createModel(def: Definition, p: Resolved): LanguageModel {
  const opts = { baseURL: p.base_url, apiKey: p.api_key, headers: p.headers };
  switch (p.kind) {
    case "openai":
      return createOpenAI(opts)(def.model);
    case "anthropic":
      return createAnthropic(opts)(def.model);
    case "ollama":
    {
      // ai-sdk-ollama drops the abort signal; abort the client ourselves.
      const client = new Ollama({ host: p.base_url, headers: p.headers });
      return wrapLanguageModel({
        model: createOllama({ client })(def.model),
        middleware: {
          wrapStream: async ({ doStream, params }) => {
            params.abortSignal?.addEventListener("abort", () => client.abort(), { once: true });
            const errors: unknown[] = [];
            for (let i = 0; ; i++) {
              try { return await doStream(); } catch (e) {
                if (params.abortSignal?.aborted || !retryable(e)) throw e;
                errors.push(e);
                if (i >= retryDelays.length) throw new RetryError({ message: `Failed after ${errors.length} attempts. Last error: ${(e as Error).message}`, reason: "maxRetriesExceeded", errors });
                await new Promise((r) => setTimeout(r, retryDelays[i]));
              }
            }
          },
        },
      });
    }
  }
}
