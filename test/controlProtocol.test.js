import assert from "node:assert/strict";
import test from "node:test";

import { executeControlCommand, parseControlCommand } from "../src/engine/controlProtocol.js";

function command(action, id = "request-1") {
  return parseControlCommand(JSON.stringify({ type: "control", version: 1, id, action }));
}

function fakeRuntime(mode) {
  let state = mode === "live" ? "DISARMED" : "UNAVAILABLE";
  return {
    mode,
    requestArm() {
      if (state !== "DISARMED") return false;
      state = "PENDING_CONFIRMATION";
      return true;
    },
    confirmArm() {
      if (state !== "PENDING_CONFIRMATION") return false;
      state = "ARMED";
      return true;
    },
    cancelArm() {
      if (state !== "PENDING_CONFIRMATION") return false;
      state = "DISARMED";
      return true;
    },
    async disarm() {
      const changed = state !== "DISARMED";
      state = "DISARMED";
      return changed;
    },
    async cancelAll() {},
    getControlState() {
      return { state, text: state };
    }
  };
}

test("strictly validates versioned control commands", () => {
  assert.equal(command("request-arm").action, "request-arm");
  assert.throws(() => parseControlCommand("not-json"), /valid JSON/);
  assert.throws(() => parseControlCommand(JSON.stringify({ type: "control", version: 99, id: "x", action: "stop" })), /Unsupported/);
  assert.throws(() => parseControlCommand(JSON.stringify({ type: "control", version: 1, id: "x", action: "arm-now" })), /Unsupported/);
  assert.throws(() => parseControlCommand(JSON.stringify({ type: "control", version: 1, id: "x", action: "stop", extra: true })), /Unknown/);
});

test("rejects every control action in Paper mode", async () => {
  const runtime = fakeRuntime("paper");
  for (const action of ["request-arm", "confirm-arm", "cancel-arm", "stop", "cancel-all"]) {
    const response = await executeControlCommand(runtime, command(action, action));
    assert.equal(response.ok, false);
    assert.equal(response.code, "MODE_NOT_LIVE");
    assert.equal(response.control.state, "UNAVAILABLE");
  }
});

test("requires request-arm before confirm-arm", async () => {
  const runtime = fakeRuntime("live");
  const premature = await executeControlCommand(runtime, command("confirm-arm", "premature"));
  assert.equal(premature.code, "INVALID_STATE");
  assert.equal(premature.control.state, "DISARMED");

  const requested = await executeControlCommand(runtime, command("request-arm", "request"));
  assert.equal(requested.ok, true);
  assert.equal(requested.control.state, "PENDING_CONFIRMATION");

  const confirmed = await executeControlCommand(runtime, command("confirm-arm", "confirm"));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.control.state, "ARMED");
});

test("stop returns an armed runtime to DISARMED", async () => {
  const runtime = fakeRuntime("live");
  await executeControlCommand(runtime, command("request-arm", "request"));
  await executeControlCommand(runtime, command("confirm-arm", "confirm"));

  const stopped = await executeControlCommand(runtime, command("stop", "stop"));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.control.state, "DISARMED");

  const repeated = await executeControlCommand(runtime, command("stop", "stop-again"));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.control.state, "DISARMED");
});
