import { describe, expect, it } from "vitest";

import { parseAuthSession } from "./auth-session";

describe("parseAuthSession", () => {
  it("accepts a non-expired Supabase password session", () => {
    expect(parseAuthSession({
      access_token: "jwt-value",
      expires_at: 2_000,
      user: { id: "e30ed00e-61a6-4685-8b3b-35f0fd65c65e" },
    }, 1_000_000)).toEqual({
      accessToken: "jwt-value",
      expiresAt: 2_000_000,
      userId: "e30ed00e-61a6-4685-8b3b-35f0fd65c65e",
    });
  });

  it("rejects an expired or malformed session", () => {
    expect(parseAuthSession({ access_token: "jwt-value", expires_at: 1, user: { id: "user" } }, 2_000)).toBeUndefined();
  });
});
