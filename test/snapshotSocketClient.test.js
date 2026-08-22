import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SnapshotSocketClient } from "../src/dashboard/snapshotSocketClient.js";
import { SnapshotSocketServer } from "../src/engine/snapshotSocketServer.js";

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for socket client state."));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function snapshot(sequence) {
  return {
    version: 1,
    generatedAt: `2026-08-22T06:30:0${sequence}.000Z`,
    market: {},
    signal: {},
    readiness: {},
    trading: {},
    session: { sequence }
  };
}

test("receives the cached snapshot and rejects unsupported versions", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-dashboard-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const server = new SnapshotSocketServer({ socketPath });
  const received = [];
  const statuses = [];
  const client = new SnapshotSocketClient({
    socketPath,
    reconnectDelayMs: 20,
    onSnapshot: (value) => received.push(value),
    onStatus: (value) => statuses.push(value)
  });
  context.after(async () => {
    client.stop();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  server.publish({ ...snapshot(1), version: 99 });
  client.start();
  await waitFor(() => statuses.some((value) => value.state === "INVALID_SNAPSHOT"));
  assert.equal(received.length, 0);

  server.publish(snapshot(2));
  await waitFor(() => received.length === 1);
  assert.equal(received[0].session.sequence, 2);
});

test("reconnects and receives snapshots after the engine restarts", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-dashboard-test-"));
  const socketPath = path.join(directory, "engine.sock");
  let server = new SnapshotSocketServer({ socketPath });
  const received = [];
  const client = new SnapshotSocketClient({
    socketPath,
    reconnectDelayMs: 20,
    onSnapshot: (value) => received.push(value)
  });
  context.after(async () => {
    client.stop();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  client.start();
  await waitFor(() => client.socket?.readyState === "open");
  server.publish(snapshot(1));
  await waitFor(() => received.length === 1);

  await server.close();
  await waitFor(() => client.socket === null);
  server = new SnapshotSocketServer({ socketPath });
  await server.start();
  server.publish(snapshot(2));

  await waitFor(() => received.length === 2);
  assert.deepEqual(received.map((value) => value.session.sequence), [1, 2]);
});