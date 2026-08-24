import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStar, validateStarEvent } from "../src/star.ts";
import { GitHubClient, type GitHubIssue } from "../src/github.ts";
import { makeIssue, makeRepository, jsonResponse, queuedFetch, requestBody } from "./helpers.ts";

function starEvent(oldBody: string, newBody: string, issueOverrides: Partial<GitHubIssue> = {}) {
  return {
    action: "edited",
    repository: { full_name: "owner/starback", owner: { login: "owner", type: "User" } },
    issue: makeIssue(7, "StarBack Inbox · August 2026", newBody, issueOverrides),
    changes: { body: { from: oldBody } },
  };
}

describe("star workflow", () => {
  it("stars an unchecked target when the API returns 204", async () => {
    const oldBody = "- [ ] alice/target — TypeScript";
    const newBody = "- [x] alice/target — TypeScript";
    const mock = queuedFetch([
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", newBody)),
      jsonResponse(makeRepository("target")),
      jsonResponse({ message: "Not Found" }, 404),
      jsonResponse(undefined, 204),
    ]);

    await runStar({
      client: new GitHubClient("github-token", mock.fetch),
      starClient: new GitHubClient("pat", mock.fetch),
      repository: "owner/starback",
      event: starEvent(oldBody, newBody),
      log: () => undefined,
    });

    assert.equal(mock.calls.length, 4);
    assert.equal(mock.calls[3].init?.method, "PUT");
    assert.equal(requestBody(mock.calls[3]), "");
  });

  it("keeps an already-starred target checked without PUT", async () => {
    const oldBody = "- [ ] alice/target";
    const newBody = "- [x] alice/target";
    const mock = queuedFetch([
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", newBody)),
      jsonResponse(makeRepository("target")),
      jsonResponse(undefined, 204),
    ]);

    await runStar({
      client: new GitHubClient("github-token", mock.fetch),
      starClient: new GitHubClient("pat", mock.fetch),
      repository: "owner/starback",
      event: starEvent(oldBody, newBody),
      log: () => undefined,
    });

    assert.equal(mock.calls.length, 3);
    assert.equal(mock.calls.some((call) => call.init?.method === "PUT"), false);
  });

  it("skips a target that the user unchecked before processing", async () => {
    const oldBody = "- [ ] alice/target";
    const eventBody = "- [x] alice/target";
    const latestBody = "- [ ] alice/target";
    const mock = queuedFetch([jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", latestBody))]);

    await runStar({
      client: new GitHubClient("github-token", mock.fetch),
      starClient: new GitHubClient("pat", mock.fetch),
      repository: "owner/starback",
      event: starEvent(oldBody, eventBody),
      log: () => undefined,
    });

    assert.equal(mock.calls.length, 1);
  });

  it("continues after a target failure and restores only failed rows in the latest body", async () => {
    const oldBody = "- [ ] alice/success\n- [ ] alice/fail";
    const eventBody = "- [x] alice/success\n- [x] alice/fail";
    const latestBody = "A note edited later\n- [x] alice/success\n- [x] alice/fail\n- [x] owner/other";
    const mock = queuedFetch([
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", eventBody)),
      jsonResponse(makeRepository("success")),
      jsonResponse({ message: "Not Found" }, 404),
      jsonResponse(undefined, 204),
      jsonResponse({ message: "Not Found" }, 404),
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", latestBody)),
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", latestBody)),
    ]);

    await assert.rejects(
      runStar({
        client: new GitHubClient("github-token", mock.fetch),
        starClient: new GitHubClient("pat", mock.fetch),
        repository: "owner/starback",
        event: starEvent(oldBody, eventBody),
        log: () => undefined,
      }),
      /alice\/fail/,
    );

    const patch = mock.calls.find((call) => call.init?.method === "PATCH");
    assert.notEqual(patch, undefined);
    const body = requestBody(patch!);
    assert.match(body, /A note edited later/);
    assert.match(body, /- \[x\] alice\/success/);
    assert.match(body, /- \[ \] alice\/fail/);
    assert.match(body, /- \[x\] owner\/other/);
  });

  it("restores a selected row when STARBACK_TOKEN is missing", async () => {
    const oldBody = "- [ ] alice/target";
    const newBody = "- [x] alice/target";
    const mock = queuedFetch([
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", newBody)),
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", newBody)),
      jsonResponse(makeIssue(7, "StarBack Inbox · August 2026", newBody)),
    ]);

    await assert.rejects(
      runStar({
        client: new GitHubClient("github-token", mock.fetch),
        repository: "owner/starback",
        event: starEvent(oldBody, newBody),
        log: () => undefined,
      }),
      /STARBACK_TOKEN/,
    );

    const patch = mock.calls.find((call) => call.init?.method === "PATCH");
    assert.notEqual(patch, undefined);
    assert.match(requestBody(patch!), /- \[ \] alice\/target/);
  });

  it("does not act on invalid repository paths", async () => {
    const body = "- [ ] alice/has/too-many-parts";
    const mock = queuedFetch([]);

    await runStar({
      client: new GitHubClient("github-token", mock.fetch),
      starClient: new GitHubClient("pat", mock.fetch),
      repository: "owner/starback",
      event: starEvent(body, body.replace("[ ]", "[x]")),
      log: () => undefined,
    });

    assert.equal(mock.calls.length, 0);
  });

  it("rejects non-owner Inbox edits before using the user token", () => {
    const issue = makeIssue(7, "StarBack Inbox · August 2026", "", {
      user: { login: "someone-else", type: "User" },
    });

    assert.throws(
      () => validateStarEvent(starEvent("", "", { user: issue.user }), "owner/starback"),
      /repository owner/,
    );
  });
});
