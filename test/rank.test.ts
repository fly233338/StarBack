import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankRepositories, scoreRepository } from "../src/rank.ts";
import { makeRepository } from "./helpers.ts";

const now = new Date("2026-08-24T00:00:00Z");

describe("repository ranking", () => {
  it("filters repositories that cannot be recommended", () => {
    const repositories = [
      makeRepository("valid"),
      makeRepository("fork", { fork: true }),
      makeRepository("archived", { archived: true }),
      makeRepository("disabled", { disabled: true }),
      makeRepository("empty", { size: 0 }),
      makeRepository("never-pushed", { pushed_at: null }),
      makeRepository("private", { private: true }),
    ];

    assert.deepEqual(
      rankRepositories(repositories, now).map(({ repository }) => repository.name),
      ["empty", "valid"],
    );
  });

  it("applies the complete 100-point score to a current maximum repository", () => {
    const repository = makeRepository("complete", {
      stargazers_count: 100,
      forks_count: 20,
      description: "A project",
      topics: ["typescript"],
      homepage: "https://example.com",
    });

    assert.equal(scoreRepository(repository, 100, 20, now), 100);
  });

  it("keeps zero maxima finite and gives no activity points at 365 days", () => {
    const old = makeRepository("old", {
      pushed_at: "2025-08-24T00:00:00Z",
    });
    const score = scoreRepository(old, 0, 0, now);

    assert.equal(score, 0);
    assert.equal(Number.isFinite(score), true);
  });

  it("uses star count, pushed time, then name as tie-breakers", () => {
    const repositories = [
      makeRepository("zeta", { stargazers_count: 2, pushed_at: "2026-08-20T00:00:00Z" }),
      makeRepository("alpha", { stargazers_count: 2, pushed_at: "2026-08-20T00:00:00Z" }),
      makeRepository("newer", { stargazers_count: 1, pushed_at: "2026-08-23T00:00:00Z" }),
    ];
    const ranked = rankRepositories(repositories, now);

    assert.deepEqual(ranked.map(({ repository }) => repository.name), ["alpha", "zeta", "newer"]);
  });
});
