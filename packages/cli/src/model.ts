import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
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
      return createOllama({ baseURL })(def.model);
  }
}
