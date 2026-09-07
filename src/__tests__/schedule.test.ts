import { describe, it, expect } from "vitest";
import { toApiDate } from "../coros-api.js";

describe("toApiDate", () => {
  it("accepts YYYY-MM-DD and YYYYMMDD", () => {
    expect(toApiDate("2026-09-08")).toBe("20260908");
    expect(toApiDate("20260908")).toBe("20260908");
  });

  it("rejects anything else", () => {
    expect(() => toApiDate("2026-9-8")).toThrow(/Invalid date/);
    expect(() => toApiDate("08/09/2026")).toThrow(/Invalid date/);
    expect(() => toApiDate("")).toThrow(/Invalid date/);
  });
});
