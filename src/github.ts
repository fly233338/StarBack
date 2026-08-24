import { splitRepositoryName } from "./identifiers.ts";

export const GITHUB_API_VERSION = "2026-03-10";
export const STARBACK_USER_AGENT = "StarBack/0.1.0";

export interface GitHubUser {
  login: string;
  type?: string;
}

export interface GitHubRepository {
  full_name: string;
  name: string;
  owner: GitHubUser;
  private?: boolean;
  visibility?: string | null;
  fork?: boolean;
  archived?: boolean;
  disabled?: boolean;
  size: number;
  pushed_at: string | null;
  stargazers_count: number;
  forks_count: number;
  description: string | null;
  topics?: string[];
  homepage: string | null;
  language: string | null;
}

export interface GitHubLabel {
  name: string;
  color?: string;
  description?: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GitHubUser | null;
  labels: Array<GitHubLabel | string>;
  pull_request?: unknown;
}

export interface IssueUpdate {
  body?: string;
  state?: "open" | "closed";
}

export interface IssueCreate {
  title: string;
  body: string;
  labels: string[];
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly responseBody: string;

  constructor(
    status: number,
    method: string,
    url: string,
    responseBody: string,
  ) {
    super(`GitHub API ${method} ${url} failed with ${status}: ${responseBody}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = responseBody;
  }
}

interface RequestResult<T> {
  data: T;
  response: Response;
}

export type FetchImplementation = typeof fetch;

export class GitHubClient {
  private readonly fetchImplementation: FetchImplementation;
  private readonly token: string;

  constructor(
    token: string,
    fetchImplementation: FetchImplementation = globalThis.fetch,
  ) {
    this.token = token;
    this.fetchImplementation = fetchImplementation;
  }

  private async requestWithResponse<T>(
    path: string,
    init: RequestInit = {},
    expectedStatuses?: readonly number[],
  ): Promise<RequestResult<T>> {
    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
    headers.set("User-Agent", STARBACK_USER_AGENT);
    headers.set("Authorization", `Bearer ${this.token}`);

    const response = await this.fetchImplementation(url, {
      ...init,
      headers,
    });
    const responseBody = await response.text();

    if (!response.ok || (expectedStatuses !== undefined && !expectedStatuses.includes(response.status))) {
      throw new GitHubApiError(response.status, init.method ?? "GET", url, responseBody);
    }

    let data: T;
    if (responseBody.length === 0) {
      data = undefined as T;
    } else {
      data = JSON.parse(responseBody) as T;
    }

    return { data, response };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const result = await this.requestWithResponse<T>(path, init);
    return result.data;
  }

  private async list<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let nextPath: string | null = path;

    while (nextPath !== null) {
      const result = await this.requestWithResponse<T[]>(nextPath);
      values.push(...result.data);
      nextPath = getNextLink(result.response.headers.get("link"));
    }

    return values;
  }

  async listUserRepositories(username: string): Promise<GitHubRepository[]> {
    return this.list<GitHubRepository>(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&direction=desc&per_page=100`,
    );
  }

  async getRepository(repository: string): Promise<GitHubRepository> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubRepository>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    );
  }

  async listInboxIssues(repository: string, state: "open" | "all" = "open"): Promise<GitHubIssue[]> {
    const parsed = splitRepositoryName(repository);
    return this.list<GitHubIssue>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues?state=${state}&labels=${encodeURIComponent("starback-inbox")}&per_page=100`,
    );
  }

  async getIssue(repository: string, issueNumber: number): Promise<GitHubIssue> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubIssue>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${issueNumber}`,
    );
  }

  async getLabel(repository: string, label: string): Promise<GitHubLabel> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubLabel>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/labels/${encodeURIComponent(label)}`,
    );
  }

  async createLabel(repository: string, label: GitHubLabel): Promise<GitHubLabel> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubLabel>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/labels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(label),
      },
    );
  }

  async createIssue(repository: string, issue: IssueCreate): Promise<GitHubIssue> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubIssue>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(issue),
      },
    );
  }

  async updateIssue(repository: string, issueNumber: number, update: IssueUpdate): Promise<GitHubIssue> {
    const parsed = splitRepositoryName(repository);
    return this.request<GitHubIssue>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      },
    );
  }

  async isStarred(repository: string): Promise<boolean> {
    const parsed = splitRepositoryName(repository);
    try {
      const result = await this.requestWithResponse<undefined>(
        `/user/starred/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      );
      return result.response.status === 204;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async star(repository: string): Promise<void> {
    const parsed = splitRepositoryName(repository);
    await this.requestWithResponse<undefined>(
      `/user/starred/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      {
        method: "PUT",
        body: "",
      },
      [204],
    );
  }
}

function getNextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) {
    return null;
  }

  for (const link of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(link.trim());
    if (match?.[2] === "next") {
      return match[1];
    }
  }

  return null;
}
