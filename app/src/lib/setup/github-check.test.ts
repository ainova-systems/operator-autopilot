import { describe, expect, it } from "vitest";
import { checkGitHubToken } from "./github-check.js";

interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  /** When true, `res.json()` rejects — a truncated or non-JSON payload. */
  readonly unparsable?: boolean;
}

/**
 * Minimal `fetch` stand-in keyed by URL suffix. Returning a hand-built
 * object keeps the test free of network access and of `undici` internals;
 * only `status`, `ok`, and `json()` are read by the module under test.
 */
function stubFetch(routes: Record<string, StubResponse | Error>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers["Authorization"]?.startsWith("Bearer ")) {
      throw new Error("missing bearer token");
    }
    const match = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!match) throw new Error(`unrouted url: ${url}`);
    const [, outcome] = match;
    if (outcome instanceof Error) throw outcome;
    return {
      status: outcome.status,
      ok: outcome.status >= 200 && outcome.status < 300,
      json: async () => {
        if (outcome.unparsable) throw new Error("invalid json");
        return outcome.body ?? {};
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OK_USER: StubResponse = { status: 200, body: { login: "octocat" } };
const OK_REPO: StubResponse = { status: 200, body: { permissions: { push: true } } };

describe("checkGitHubToken — token identity", () => {
  it("passes and reports the login when no repository is given", async () => {
    const { fetchImpl, calls } = stubFetch({ "/user": OK_USER });
    const result = await checkGitHubToken({ token: "t" }, { fetchImpl });
    expect(result.status).toBe("pass");
    expect(result.login).toBe("octocat");
    expect(result.detail).toContain("octocat");
    expect(calls).toHaveLength(1);
  });

  it("fails on 401 with a regeneration hint", async () => {
    const { fetchImpl } = stubFetch({ "/user": { status: 401 } });
    const result = await checkGitHubToken({ token: "bad" }, { fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("401");
    expect(result.hint).toContain("repo scope");
  });

  it("warns rather than fails on an unexpected status", async () => {
    const { fetchImpl } = stubFetch({ "/user": { status: 500 } });
    const result = await checkGitHubToken({ token: "t" }, { fetchImpl });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("500");
  });

  it("warns when the host is unreachable", async () => {
    const { fetchImpl } = stubFetch({ "/user": new Error("getaddrinfo ENOTFOUND") });
    const result = await checkGitHubToken({ token: "t" }, { fetchImpl });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("ENOTFOUND");
  });

  it("still passes when the user payload cannot be parsed", async () => {
    const { fetchImpl } = stubFetch({ "/user": { status: 200, unparsable: true } });
    const result = await checkGitHubToken({ token: "t" }, { fetchImpl });
    expect(result.status).toBe("pass");
    expect(result.login).toBeUndefined();
  });
});

describe("checkGitHubToken — repository access", () => {
  it("passes when the token can push", async () => {
    const { fetchImpl, calls } = stubFetch({ "/user": OK_USER, "/repos/owner/sample": OK_REPO });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Write access");
    expect(calls).toHaveLength(2);
  });

  it("fails on 404 and explains that GitHub hides inaccessible repositories", async () => {
    const { fetchImpl } = stubFetch({ "/user": OK_USER, "/repos/owner/sample": { status: 404 } });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.hint).toContain("404");
    expect(result.login).toBe("octocat");
  });

  it("fails on read-only access because the operator has to push branches", async () => {
    const { fetchImpl } = stubFetch({
      "/user": OK_USER,
      "/repos/owner/sample": { status: 200, body: { permissions: { push: false } } },
    });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Read-only");
  });

  it("fails when the repository payload carries no permissions block", async () => {
    const { fetchImpl } = stubFetch({
      "/user": OK_USER,
      "/repos/owner/sample": { status: 200, unparsable: true },
    });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Read-only");
  });

  it("warns on an unexpected repository status", async () => {
    const { fetchImpl } = stubFetch({ "/user": OK_USER, "/repos/owner/sample": { status: 502 } });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("502");
  });

  it("warns when the repository call throws", async () => {
    const { fetchImpl } = stubFetch({
      "/user": OK_USER,
      "/repos/owner/sample": new Error("socket hang up"),
    });
    const result = await checkGitHubToken({ token: "t", repoSlug: "owner/sample" }, { fetchImpl });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("socket hang up");
  });

  it("honors an enterprise API base url", async () => {
    const { fetchImpl, calls } = stubFetch({ "/user": OK_USER });
    await checkGitHubToken({ token: "t" }, { fetchImpl, apiBaseUrl: "https://ghe.example.com/api/v3" });
    expect(calls[0]).toBe("https://ghe.example.com/api/v3/user");
  });
});
