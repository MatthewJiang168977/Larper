import { afterEach, expect, it, vi } from "vitest";
import { assertDesignLab } from "./assert-design-lab";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["production", "development"],
  [undefined, "production"],
])("returns a 404 with VERCEL_ENV=%s and NODE_ENV=%s", (vercel, node) => {
  vi.stubEnv("VERCEL_ENV", vercel);
  vi.stubEnv("NODE_ENV", node);
  expect(assertDesignLab).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

it.each([
  ["preview", "production"],
  [undefined, "development"],
])("allows rendering with VERCEL_ENV=%s and NODE_ENV=%s", (vercel, node) => {
  vi.stubEnv("VERCEL_ENV", vercel);
  vi.stubEnv("NODE_ENV", node);
  expect(assertDesignLab).not.toThrow();
});
