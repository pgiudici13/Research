import { describe, expect, it } from "vitest";

export function sum(a: number, b: number): number {
  return a + b;
}

describe("smoke", () => {
  it("vitest è configurato e funzionante", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
