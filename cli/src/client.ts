import type { Issue } from "../../worker/src/core/errors";

export class ApiError extends Error {
  readonly issues?: Issue[];
  readonly hint?: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    opts?: { issues?: Issue[]; hint?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.issues = opts?.issues;
    this.hint = opts?.hint;
  }
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

export class FemtoClient {
  private readonly base: string;

  constructor(
    private readonly p: { url: string; key: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = p.url.replace(/\/+$/, "");
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers = new Headers(opts.headers);
    headers.set("Authorization", `Bearer ${this.p.key}`);
    let body: BodyInit | undefined = opts.body;
    if (opts.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(opts.json);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (e) {
      // The message must never include the key: only the URL and the underlying reason.
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not connect to ${url.href} (${reason}). Check the URL and your network`);
    }

    if (res.status === 204) return undefined as T;
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    const text = await res.text();

    if (!res.ok) throw toApiError(res, isJson ? text : "");
    if (text === "") return undefined as T;
    return (isJson ? JSON.parse(text) : text) as T;
  }
}

function toApiError(res: Response, jsonText: string): ApiError {
  try {
    const e = (JSON.parse(jsonText) as { error?: Record<string, unknown> }).error;
    if (e && typeof e.code === "string" && typeof e.message === "string") {
      return new ApiError(res.status, e.code, e.message, {
        issues: Array.isArray(e.issues) ? (e.issues as Issue[]) : undefined,
        hint: typeof e.hint === "string" ? e.hint : undefined,
      });
    }
  } catch {
    // not JSON: fall through
  }
  return new ApiError(res.status, `http_${res.status}`, `HTTP ${res.status} ${res.statusText}`.trim());
}
