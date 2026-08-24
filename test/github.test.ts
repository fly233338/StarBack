import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitHubApiError, GitHubClient } from "../src/github.ts";
import { jsonResponse, queuedFetch, requestBody } from "./helpers.ts";

describe("GitHub REST client", () => {
  it("follows Link pagination and sends the required headers", async () => {
    const first = jsonResponse([{ full_name: "alice/one" }], 200, {
      link: '<https://api.github.com/users/alice/repos?page=2>; rel="next"',
    });
    const second = jsonResponse([{ full_name: "alice/two" }]);
    const mock = queuedFetch([first, second]);
    const client = new GitHubClient("token", mock.fetch);

    const repositories = await client.listUserRepositories("alice");

    assert.equal(repositories.length, 2);
    const headers = new Headers(mock.calls[0].init?.headers);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(headers.get("user-agent"), "StarBack/0.1.0");
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(String(mock.calls[1].input), "https://api.github.com/users/alice/repos?page=2");
  });

  it("treats 404 as not starred and requires an empty-body 204 for Star", async () => {
    const mock = queuedFetch([jsonResponse({ message: "Not Found" }, 404), jsonResponse(undefined, 204)]);
    const client = new GitHubClient("pat", mock.fetch);

    assert.equal(await client.isStarred("alice/project"), false);
    await client.star("alice/project");
    assert.equal(mock.calls[1].init?.method, "PUT");
    assert.equal(requestBody(mock.calls[1]), "");
  });

  it("surfaces non-success responses", async () => {
    const mock = queuedFetch([jsonResponse({ message: "Bad credentials" }, 401)]);
    const client = new GitHubClient("bad", mock.fetch);

    await assert.rejects(
      client.getRepository("alice/project"),
      (error: unknown) => error instanceof GitHubApiError && error.status === 401,
    );
  });
});
