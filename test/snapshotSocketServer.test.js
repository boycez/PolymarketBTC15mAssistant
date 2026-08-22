import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SnapshotSocketServer } from "../src/engine/snapshotSocketServer.js";

async function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

async function readLine(client) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    client.once("error", reject);
  });
}

test("broadcasts newline-delimited snapshots with owner-only permissions", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const server = new SnapshotSocketServer({ socketPath });
  context.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  const mode = (await fs.stat(socketPath)).mode & 0o777;
  assert.equal(mode, 0o600);

  const client = await connect(socketPath);
  context.after(() => client.destroy());
  const received = readLine(client);
  const snapshot = { version: 1, trading: { mode: "paper" } };
  server.publish(snapshot);

  assert.deepEqual(JSON.parse(await received), snapshot);
});

test("refuses to replace a socket owned by an active engine", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const first = new SnapshotSocketServer({ socketPath });
  const second = new SnapshotSocketServer({ socketPath });
  context.after(async () => {
    await second.close();
    await first.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await first.start();
  await assert.rejects(() => second.start(), /already in use/);
});