import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { Ollama } from "ollama";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";

export function createModel(def: Definition, apiKey: string | undefined): LanguageModel {
  const baseURL = def.base_url;
  switch (def.provider) {
    case "openai":
      return createOpenAI({ apiKey, baseURL })(def.model);
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(def.model);
    case "ollama":
    {
      // ai-sdk-ollama drops the abort signal; abort the client ourselves.
      const client = new Ollama({ host: baseURL });
      return wrapLanguageModel({
        model: createOllama({ client })(def.model),
        middleware: {
          wrapStream: async ({ doStream, params }) => {
            params.abortSignal?.addEventListener("abort", () => client.abort(), { once: true });
            return doStream();
          },
        },
      });
    }
  }
}
