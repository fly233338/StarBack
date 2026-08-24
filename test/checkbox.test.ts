import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findCheckboxTransitions } from "../src/checkbox.ts";

describe("checkbox diff", () => {
  it("finds one and multiple strict unchecked-to-checked transitions", () => {
    const oldBody = "- [ ] alice/one — TypeScript\n- [ ] alice/two — JavaScript";
    const newBody = "- [x] alice/one — TypeScript\n- [x] alice/two — JavaScript";

    assert.deepEqual(
      findCheckboxTransitions(oldBody, newBody).map((transition) => transition.repository.key),
      ["alice/one", "alice/two"],
    );
  });

  it("ignores ordinary edits, cancellation, invalid paths, and uppercase X", () => {
    const oldBody = "Notes\n- [ ] alice/valid\n- [ ] alice/invalid/path\n- [ ] alice/upper";
    const newBody = "Updated notes\n- [x] alice/valid\n- [x] alice/invalid/path\n- [X] alice/upper";

    assert.deepEqual(
      findCheckboxTransitions(oldBody, newBody).map((transition) => transition.repository.key),
      ["alice/valid"],
    );
    assert.deepEqual(findCheckboxTransitions("- [ ] alice/repo", "- [ ] alice/repo"), []);
    assert.deepEqual(findCheckboxTransitions("- [x] alice/repo", "- [ ] alice/repo"), []);
  });

  it("matches a checkbox after an unrelated line is inserted", () => {
    assert.deepEqual(
      findCheckboxTransitions(
        "- [ ] alice/repo — TypeScript",
        "New note\n- [x] alice/repo — TypeScript",
      ).map((transition) => transition.repository.key),
      ["alice/repo"],
    );
  });
});
