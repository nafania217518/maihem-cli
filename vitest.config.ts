import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/cli/src/**/*.ts", "packages/worker/src/routes.ts"],
      thresholds: { lines: 90, functions: 90, statements: 90 },
    },
  },
});
