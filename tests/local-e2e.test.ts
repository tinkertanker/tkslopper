import { describe, expect, it } from "vitest";

import { validateLocalOrigin } from "../tools/local-origin";

describe("local E2E origin guard", () => {
  it.each([
    "http://127.0.0.1:8787",
    "https://localhost:8788",
    "http://[::1]:8787",
  ])("accepts loopback origin %s", (origin) => {
    expect(validateLocalOrigin(origin)).toBe(origin);
  });

  it.each([
    "https://control.example.com",
    "http://control.example.com",
    "https://127.0.0.2:8787",
    "https://localhost:8787/admin",
    "https://user@localhost:8787",
  ])("rejects non-local or decorated origin %s", (origin) => {
    expect(() => validateLocalOrigin(origin)).toThrow(/loopback origins/u);
  });
});
