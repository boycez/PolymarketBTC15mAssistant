import assert from "node:assert/strict";
import test from "node:test";

test("exports the application loop without starting it on import", async () => {
  const application = await import("../src/index.js");
  assert.equal(typeof application.runApplication, "function");
});