import { describe, expect, it } from "vitest";
import { HttpError } from "./http";
import { validateDisplayName } from "./security";

describe("security validation", () => {
  it("trims a valid display name", () => {
    expect(validateDisplayName(" agent-white ")).toBe("agent-white");
  });

  it("rejects empty display names with invalid_display_name", () => {
    expect(() => validateDisplayName("   ")).toThrow(HttpError);
    try {
      validateDisplayName("   ");
    } catch (error) {
      expect((error as HttpError).code).toBe("invalid_display_name");
    }
  });

  it("rejects overlong display names", () => {
    expect(() => validateDisplayName("x".repeat(65))).toThrow("display_name must be 1-64 characters");
  });
});
