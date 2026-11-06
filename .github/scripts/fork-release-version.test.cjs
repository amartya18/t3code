const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveVersion } = require("./fork-release-version.cjs");

const next = (tags) => resolveVersion(tags, "");

test("targets the patch after the newest stable tag", () => {
  assert.equal(next(["v0.1.7"]), "0.1.8-fork.1");
  assert.equal(next(["v0.1.9", "v0.1.10", "v0.0.99"]), "0.1.11-fork.1");
});

test("counts up from the newest fork release", () => {
  assert.equal(next(["v0.1.7", "v0.1.8-fork.9", "v0.1.8-fork.10"]), "0.1.8-fork.11");
  assert.equal(next(["v0.1.7", "v0.1.9-fork.2"]), "0.1.9-fork.3");
});

test("restarts the count once upstream ships that patch", () => {
  assert.equal(next(["v0.1.7", "v0.1.8-fork.3", "v0.1.8"]), "0.1.9-fork.1");
});

test("ignores tags that are not stable or fork releases", () => {
  assert.equal(
    next([
      "v0.1.7",
      "v0.1.8-fork.2-hotfix",
      "v0.1.8-fork.2.1",
      "v0.2.0-rc.1",
      "v0.1.8-nightly.20261105.4218",
    ]),
    "0.1.8-fork.1",
  );
});

test("refuses to guess without a release tag", () => {
  assert.throws(() => next([]), /release tag/);
});

test("rejects a fork version other than the next one", () => {
  for (const [tags, requested] of [
    [["v0.1.7"], "0.1.7-fork.1"],
    [["v0.1.7"], "0.1.9-fork.1"],
    [["v0.1.7"], "0.1.8-fork.3"],
    [["v0.1.7"], "0.1.8-fork.01"],
    [["v0.1.7"], "0.01.8-fork.1"],
    [["v0.1.7", "v0.1.8-fork.2"], "0.1.8-fork.1"],
  ]) {
    assert.throws(() => resolveVersion(tags, requested), /not the next/);
  }
});

test("accepts the next fork version, including its own pushed tag", () => {
  assert.equal(resolveVersion(["v0.1.7"], "0.1.8-fork.1"), "0.1.8-fork.1");
  assert.equal(resolveVersion(["v0.1.7", "v0.1.8-fork.1"], "0.1.8-fork.1"), "0.1.8-fork.1");
  assert.equal(resolveVersion(["v0.1.7", "v0.1.8-fork.1"], "0.1.8-fork.2"), "0.1.8-fork.2");
});

test("passes other versions through", () => {
  assert.equal(resolveVersion(["v0.1.8-fork.1"], "0.1.8"), "0.1.8");
  assert.equal(resolveVersion([], "0.1.8-rc.1"), "0.1.8-rc.1");
});
