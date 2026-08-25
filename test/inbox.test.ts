import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendRecommendations,
  formatInboxTitle,
  formatRecommendation,
  parseInboxTitle,
  restoreFailedRepositories,
} from "../src/inbox.ts";
import { makeRepository } from "./helpers.ts";

describe("Inbox formatting", () => {
  it("uses UTC month names and validates page titles", () => {
    const date = new Date("2026-08-01T00:30:00Z");

    assert.equal(formatInboxTitle(date), "StarBack Inbox · August 2026");
    assert.equal(formatInboxTitle(date, 2), "StarBack Inbox · August 2026 · #2");
    assert.deepEqual(parseInboxTitle("StarBack Inbox · August 2026 · #2"), {
      year: 2026,
      month: 8,
      page: 2,
    });
    assert.equal(parseInboxTitle("StarBack Inbox · August 2026 · #1"), null);
  });

  it("formats a recommendation with its run marker", () => {
    const recommendation = formatRecommendation(
      makeRepository("project", { language: "TypeScript", stargazers_count: 126 }),
      "12345",
    );

    assert.equal(
      recommendation,
      "- [ ] [alice/project](https://github.com/alice/project) — TypeScript · ★126 <!-- starback-run:12345 -->",
    );
  });

  it("appends without overwriting body text and restores only failed rows", () => {
    const body = "Notes\n- [x] alice/failed — TypeScript\n- [x] alice/kept — TypeScript";
    const updated = restoreFailedRepositories(body, new Set(["alice/failed"]));

    assert.equal(updated, "Notes\n- [ ] alice/failed — TypeScript\n- [x] alice/kept — TypeScript");
    assert.equal(appendRecommendations("Notes", ["row"]), "Notes\nrow");
  });
});
