import { describe, expect, it, vi } from "vitest";
import { ApiError, FemtoClient } from "../src/client";

const KEY = "fcms_admin_SECRETSECRETSECRETSECRETSECRET12";

function client(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(String(input), init ?? {}),
  );
  return { c: new FemtoClient({ url: "https://cms.test", key: KEY }, fetchImpl as typeof fetch), fetchImpl };
}

describe("FemtoClient", () => {
  it("an API error becomes an ApiError with issues", async () => {
    const c = new FemtoClient({ url: "https://cms.test", key: "k" }, async () =>
      Response.json(
        { error: { code: "validation_failed", message: "bad", issues: [{ path: "data.title", message: "required" }], hint: "fix it" } },
        { status: 422 },
      ),
    );
    const err = await c.request("POST", "/api/news", { json: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "bad",
      hint: "fix it",
      issues: [{ path: "data.title", message: "required" }],
    });
  });

  it("adds Bearer auth and normalizes the trailing slash of the URL and the leading slash of the path", async () => {
    const { c, fetchImpl } = client(() => Response.json({ ok: true }));
    const c2 = new FemtoClient({ url: "https://cms.test///", key: KEY }, fetchImpl as typeof fetch);
    await c2.request("GET", "api/keys");
    await c.request("GET", "/api/keys");
    const [u1, i1] = fetchImpl.mock.calls[0]!;
    expect(String(u1)).toBe("https://cms.test/api/keys");
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://cms.test/api/keys");
    expect(new Headers(i1!.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("adds query parameters, leaving out undefined ones", async () => {
    const { c, fetchImpl } = client(() => Response.json({}));
    await c.request("GET", "/api/news", { query: { limit: "5", status: undefined, q: "a b" } });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://cms.test/api/news?limit=5&q=a+b");
  });

  it("sends JSON when json is given", async () => {
    const { c, fetchImpl } = client(() => Response.json({ id: "e_1" }, { status: 201 }));
    const out = await c.request<{ id: string }>("POST", "/api/news", { json: { data: { title: "x" } } });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ data: { title: "x" } }));
    expect(out).toEqual({ id: "e_1" });
  });

  it("passes body and headers through as they are (no Content-Type without json)", async () => {
    const { c, fetchImpl } = client(() => Response.json({}));
    const body = new Uint8Array([1, 2, 3]);
    await c.request("PUT", "/api/media/m_1", { body, headers: { "Content-Type": "image/png" } });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");
  });

  it("204 returns undefined", async () => {
    const { c } = client(() => new Response(null, { status: 204 }));
    expect(await c.request("DELETE", "/api/news/e_1")).toBeUndefined();
  });

  it("a non-JSON error response becomes an ApiError with code http_<status>", async () => {
    const { c } = client(() => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(c.request("GET", "/api/news")).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("a JSON error response without an error object also gets http_<status>", async () => {
    const { c } = client(() => Response.json({ nope: 1 }, { status: 500 }));
    await expect(c.request("GET", "/api/news")).rejects.toMatchObject({ status: 500, code: "http_500" });
  });

  it("a network failure gives a clear error that includes the URL but not the key", async () => {
    const c = new FemtoClient({ url: "https://cms.test/", key: KEY }, async () => {
      throw new TypeError("fetch failed");
    });
    const err: Error = await c.request("GET", "/api/news").then(() => new Error("no error"), (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.message).toContain("https://cms.test");
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("SECRET");
  });

  it("returns the text when a successful response is not JSON", async () => {
    const { c } = client(() => new Response("hello", { headers: { "content-type": "text/plain" } }));
    expect(await c.request("GET", "/x")).toBe("hello");
  });
});
