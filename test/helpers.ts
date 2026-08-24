import type {
  FetchImplementation,
  GitHubIssue,
  GitHubRepository,
} from "../src/github.ts";

export function makeRepository(
  name: string,
  overrides: Partial<GitHubRepository> = {},
): GitHubRepository {
  return {
    full_name: `alice/${name}`,
    name,
    owner: { login: "alice", type: "User" },
    private: false,
    visibility: "public",
    fork: false,
    archived: false,
    disabled: false,
    size: 10,
    pushed_at: "2026-08-24T00:00:00Z",
    stargazers_count: 0,
    forks_count: 0,
    description: null,
    topics: [],
    homepage: null,
    language: "TypeScript",
    ...overrides,
  };
}

export function makeIssue(
  number: number,
  title: string,
  body: string,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    number,
    title,
    body,
    state: "open",
    user: { login: "owner", type: "User" },
    labels: [{ name: "starback-inbox" }],
    ...overrides,
  };
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function queuedFetch(responses: readonly Response[]): {
  fetch: FetchImplementation;
  calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }>;
} {
  let index = 0;
  const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
  const fetch: FetchImplementation = async (input, init) => {
    calls.push({ input, init });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`Unexpected fetch call ${index}`);
    }
    return response;
  };
  return { fetch, calls };
}

export function requestBody(call: { init: RequestInit | undefined }): string {
  if (typeof call.init?.body !== "string") {
    throw new Error("Expected a string request body");
  }
  return call.init.body;
}
