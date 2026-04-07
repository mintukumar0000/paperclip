import { describe, expect, it } from "vitest";
import { detectClaudeCreditLow } from "./parse.js";

describe("claude_local credit-low detection", () => {
  it("detects low-credit text variants without 'is'", () => {
    const detection = detectClaudeCreditLow({
      parsed: {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Credit balance too low for this request.",
      },
      stdout: "",
      stderr: "",
    });

    expect(detection.creditLow).toBe(true);
    expect(detection.detail).toContain("Credit balance too low");
  });

  it("detects structured low-credit error codes", () => {
    const detection = detectClaudeCreditLow({
      parsed: {
        type: "result",
        subtype: "success",
        is_error: true,
        errors: [{ code: "credit_balance_too_low" }],
      },
      stdout: "",
      stderr: "",
    });

    expect(detection.creditLow).toBe(true);
    expect(detection.detail).toContain("credit_balance_too_low");
  });

  it("does not flag unrelated failures as credit-low", () => {
    const detection = detectClaudeCreditLow({
      parsed: {
        type: "result",
        subtype: "error_other",
        is_error: true,
        result: "Authentication required",
      },
      stdout: "",
      stderr: "",
    });

    expect(detection.creditLow).toBe(false);
    expect(detection.detail).toBeNull();
  });
});
