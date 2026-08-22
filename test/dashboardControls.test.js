import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runDashboard } from "../src/dashboard.js";

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.raw = false;
  }

  setRawMode(value) {
    this.raw = value;
  }

  setEncoding() {}
  resume() {}
  pause() {}
}

class FakeProcess extends EventEmitter {
  exit() {}
}

test("maps Live dashboard keys to two-step control commands", () => {
  const stdin = new FakeInput();
  const stdout = { isTTY: true, columns: 80, write() {} };
  const processRef = new FakeProcess();
  const sent = [];
  let callbacks;
  const dashboard = runDashboard({
    stdin,
    stdout,
    processRef,
    createClient: (options) => {
      callbacks = options;
      return {
        start() {},
        stop() {},
        sendControl(action) {
          sent.push(action);
        }
      };
    }
  });

  callbacks.onStatus({ state: "CONNECTED" });
  callbacks.onSnapshot({
    version: 1,
    generatedAt: "2026-08-22T06:30:00.000Z",
    market: {},
    signal: {},
    readiness: {},
    trading: { mode: "live", control: { state: "DISARMED", text: "Stopped" } },
    session: {}
  });
  stdin.emit("data", "a");
  stdin.emit("data", "\r");
  stdin.emit("data", "\u001b");
  stdin.emit("data", "s");
  stdin.emit("data", "x");

  assert.deepEqual(sent, ["request-arm", "confirm-arm", "cancel-arm", "stop", "cancel-all"]);
  dashboard.stop();
  assert.equal(stdin.raw, false);
});

test("does not send control commands for Paper snapshots", () => {
  const stdin = new FakeInput();
  const stdout = { isTTY: true, columns: 80, write() {} };
  const processRef = new FakeProcess();
  const sent = [];
  let callbacks;
  const dashboard = runDashboard({
    stdin,
    stdout,
    processRef,
    createClient: (options) => {
      callbacks = options;
      return { start() {}, stop() {}, sendControl: (action) => sent.push(action) };
    }
  });

  callbacks.onStatus({ state: "CONNECTED" });
  callbacks.onSnapshot({
    version: 1,
    generatedAt: "2026-08-22T06:30:00.000Z",
    trading: { mode: "paper" }
  });
  stdin.emit("data", "a");

  assert.deepEqual(sent, []);
  dashboard.stop();
});