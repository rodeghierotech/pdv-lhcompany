import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, requestJson } from "./api-client";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("requestJson", () => {
  it("returns JSON and routes development requests through /api", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ quantity: 4 }));
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson("/products")).toEqual({ quantity: 4 });
    expect(fetch).toHaveBeenCalledWith("/api/products", expect.objectContaining({ headers: expect.any(Headers) }));
  });

  it("uses the configured API base and preserves caller options", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/");
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await requestJson("/products", { method: "POST", body: "{}", headers: { "X-Operation": "one" } });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/products", expect.objectContaining({ method: "POST", body: "{}" }));
    const headers = fetch.mock.calls[0]?.[1].headers as Headers;
    expect(headers.get("X-Operation")).toBe("one");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it.each([new Response(null, { status: 204 }), new Response("")])("accepts an empty successful response", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await requestJson("/products")).toBeUndefined();
  });

  it("normalizes a structured conflict without exposing its server message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "PRODUCT_CONFLICT", message: "postgres://user:secret@db/private" }, { status: 409 })));
    const error = await requestJson("/products").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "PRODUCT_CONFLICT" });
    expect(String(error)).toContain("SKU");
    expect(String(error)).not.toMatch(/postgres|secret|private/);
  });

  it.each([
    new Response("<html>postgres://user:secret@db/private</html>", { status: 500 }),
    Response.json({ code: "postgres://user:secret@db/private", message: "secret" }, { status: 500 }),
  ])("keeps unrecognized server failures safe", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await requestJson("/products").catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 500, code: "HTTP_ERROR" });
    expect(JSON.stringify(error)).not.toMatch(/postgres|secret|private|html/);
    expect(String(error)).not.toMatch(/postgres|secret|private|html/);
  });

  it("normalizes network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("postgres://user:secret@db/private")));
    await expect(requestJson("/products")).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR", message: expect.stringMatching(/conexão/i) });
  });

  it("rejects malformed successful JSON with a safe error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret invalid json")));
    await expect(requestJson("/products")).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: expect.not.stringContaining("secret") });
  });

  it("requires explicit production configuration", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_BASE_URL", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("/products")).rejects.toMatchObject({ code: "API_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
