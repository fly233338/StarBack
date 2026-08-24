import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDiscover } from "../src/discover.ts";
import { GitHubClient } from "../src/github.ts";
import { formatRecommendation } from "../src/inbox.ts";
import { makeIssue, makeRepository, jsonResponse, queuedFetch, requestBody } from "./helpers.ts";

const now = new Date("2026-08-24T12:00:00Z");

function watchEvent() {
  return {
    action: "started",
    repository: { full_name: "owner/starback", owner: { login: "owner", type: "User" } },
    sender: { login: "alice", type: "User" },
  };
}

describe("discover workflow", () => {
  it("closes old Inbox pages, creates a missing label, ranks and deduplicates recommendations", async () => {
    const oldIssue = makeIssue(1, "StarBack Inbox · July 2026", "", { user: { login: "owner", type: "User" } });
    const currentIssue = makeIssue(2, "StarBack Inbox · August 2026", "- [ ] alice/already — TypeScript");
    const fresh = makeRepository("fresh", {
      stargazers_count: 10,
      description: "fresh",
      topics: ["tool"],
      homepage: "https://example.com",
    });
    const already = makeRepository("already", { stargazers_count: 100 });
    const mock = queuedFetch([
      jsonResponse({ message: "Not Found" }, 404),
      jsonResponse({ name: "starback-inbox", color: "0969da", description: "Managed by StarBack" }, 201),
      jsonResponse([oldIssue, currentIssue]),
      jsonResponse({ ...oldIssue, state: "closed" }),
      jsonResponse([currentIssue]),
      jsonResponse([already, fresh]),
      jsonResponse({ ...currentIssue, body: `${currentIssue.body}\n${formatRecommendation(fresh, "run-1")}` }),
    ]);
    const client = new GitHubClient("github-token", mock.fetch);

    await runDiscover({
      client,
      repository: "owner/starback",
      runId: "run-1",
      eventName: "watch",
      event: watchEvent(),
      now,
      log: () => undefined,
    });

    const patchCalls = mock.calls.filter((call) => call.init?.method === "PATCH");
    assert.equal(patchCalls.length, 2);
    assert.match(requestBody(patchCalls[0]), /"state":"closed"/);
    const updatedBody = JSON.parse(requestBody(patchCalls[1])).body as string;
    assert.match(updatedBody, /alice\/fresh/);
    assert.doesNotMatch(updatedBody, /alice\/already.*starback-run/);
    assert.equal(mock.calls[1].init?.method, "POST");
    assert.match(requestBody(mock.calls[1]), /"color":"0969da"/);
  });

  it("only closes legal old Inbox titles during schedule maintenance", async () => {
    const oldIssue = makeIssue(1, "StarBack Inbox · July 2026", "");
    const invalid = makeIssue(2, "Inbox · July 2026", "");
    const current = makeIssue(3, "StarBack Inbox · August 2026", "");
    const future = makeIssue(4, "StarBack Inbox · September 2026", "");
    const wrongLabel = makeIssue(5, "StarBack Inbox · July 2026", "", { labels: [{ name: "other" }] });
    const mock = queuedFetch([
      jsonResponse([oldIssue, invalid, current, future, wrongLabel]),
      jsonResponse({ ...oldIssue, state: "closed" }),
    ]);

    await runDiscover({
      client: new GitHubClient("token", mock.fetch),
      repository: "owner/starback",
      runId: "schedule-run",
      eventName: "schedule",
      event: {},
      now,
      log: () => undefined,
    });

    const patches = mock.calls.filter((call) => call.init?.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.match(String(patches[0].input), /\/issues\/1$/);
  });

  it("exits idempotently when the current run marker already exists", async () => {
    const marked = makeIssue(2, "StarBack Inbox · August 2026", "- [ ] alice/project <!-- starback-run:run-2 -->");
    const mock = queuedFetch([
      jsonResponse({ name: "starback-inbox" }),
      jsonResponse([marked]),
      jsonResponse([marked]),
    ]);

    await runDiscover({
      client: new GitHubClient("token", mock.fetch),
      repository: "owner/starback",
      runId: "run-2",
      eventName: "watch",
      event: watchEvent(),
      now,
      log: () => undefined,
    });

    assert.equal(mock.calls.length, 3);
  });

  it("creates a second page when the current page already has 100 generated rows", async () => {
    const existingBody = Array.from({ length: 100 }, (_, index) =>
      formatRecommendation(makeRepository(`existing-${index}`), "old-run").replace("[ ]", "[x]"),
    ).join("\n");
    const current = makeIssue(10, "StarBack Inbox · August 2026", existingBody);
    const firstPage = Array.from({ length: 100 }, (_, index) => makeRepository(`new-${index}`));
    const secondPage: ReturnType<typeof makeRepository>[] = [];
    const mock = queuedFetch([
      jsonResponse({ name: "starback-inbox" }),
      jsonResponse([current]),
      jsonResponse([current]),
      jsonResponse(firstPage, 200, {
        link: '<https://api.github.com/users/alice/repos?page=2>; rel="next"',
      }),
      jsonResponse(secondPage),
      jsonResponse(makeIssue(11, "StarBack Inbox · August 2026 · #2", ""), 201),
    ]);

    await runDiscover({
      client: new GitHubClient("token", mock.fetch),
      repository: "owner/starback",
      runId: "new-run",
      eventName: "watch",
      event: watchEvent(),
      now,
      log: () => undefined,
    });

    const createCall = mock.calls.find((call) => call.init?.method === "POST" && String(call.input).endsWith("/issues"));
    assert.notEqual(createCall, undefined);
    assert.match(requestBody(createCall!), /StarBack Inbox · August 2026 · #2/);
    assert.match(requestBody(createCall!), /alice\/new-/);
  });
});
