import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Component and hook tests in jsdom. Next's own compiler isn't involved: esbuild
// handles TSX with the automatic runtime, and "@/..." resolves like tsconfig's paths.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
