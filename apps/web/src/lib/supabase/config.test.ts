import { describe, expect, it } from "vitest";

import { readSupabasePublicConfig } from "./config";

describe("readSupabasePublicConfig", () => {
  it("returns ready only when both public Supabase values are configured", () => {
    expect(
      readSupabasePublicConfig({
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toEqual({
      status: "ready",
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("returns a recoverable state when a public value is missing or blank", () => {
    expect(
      readSupabasePublicConfig({ VITE_SUPABASE_URL: " " }),
    ).toEqual({ status: "missing_configuration" });
  });

  it("does not treat a malformed public URL as ready to connect", () => {
    expect(
      readSupabasePublicConfig({
        VITE_SUPABASE_URL: "not-a-url",
        VITE_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toEqual({ status: "missing_configuration" });
  });
});
