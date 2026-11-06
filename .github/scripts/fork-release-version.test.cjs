const assert = require("node:assert/strict");
const test = require("node:test");

const { nextForkVersion } = require("./fork-release-version.cjs");

test("targets the patch after the newest stable tag", () => {
  assert.equal(nextForkVersion(["v0.1.7"]), "0.1.8-fork.1");
  assert.equal(nextForkVersion(["v0.1.9", "v0.1.10", "v0.0.99"]), "0.1.11-fork.1");
});

test("counts up from existing fork releases of that patch", () => {
  assert.equal(
    nextForkVersion(["v0.1.7", "v0.1.8-fork.1", "v0.1.8-fork.9", "v0.1.8-fork.10"]),
    "0.1.8-fork.11",
  );
});

test("restarts the count once upstream ships that patch", () => {
  assert.equal(nextForkVersion(["v0.1.7", "v0.1.8-fork.3", "v0.1.8"]), "0.1.9-fork.1");
});

test("ignores tags that are not stable or fork releases", () => {
  assert.equal(
    nextForkVersion(["v0.1.7", "v0.2.0-rc.1", "v0.1.8-nightly.20261105.4218"]),
    "0.1.8-fork.1",
  );
});

test("refuses to guess without a stable tag", () => {
  assert.throws(() => nextForkVersion(["v0.1.8-fork.1"]), /stable/);
});
