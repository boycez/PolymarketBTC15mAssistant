import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SnapshotSocketServer, parseSnapshotSocketMode } from "../src/engine/snapshotSocketServer.js";

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

test("supports trusted-group socket access without world permissions", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const server = new SnapshotSocketServer({ socketPath, socketMode: parseSnapshotSocketMode("0660") });
  context.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o660);
  assert.throws(() => parseSnapshotSocketMode("0666"), /0600 or 0660/);
});

test("sends the latest snapshot immediately to a newly attached client", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const server = new SnapshotSocketServer({ socketPath });
  context.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  const snapshot = { version: 1, generatedAt: "2026-08-22T06:30:00.000Z" };
  server.publish(snapshot);

  const client = await connect(socketPath);
  context.after(() => client.destroy());
  assert.deepEqual(JSON.parse(await readLine(client)), snapshot);
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

test("parses and responds to a control command", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  const commands = [];
  const server = new SnapshotSocketServer({
    socketPath,
    onControlCommand: async (command) => {
      commands.push(command);
      return {
        type: "control-result",
        version: 1,
        id: command.id,
        action: command.action,
        ok: true,
        code: "OK",
        message: "done",
        control: { state: "PENDING_CONFIRMATION", text: "Confirm" }
      };
    }
  });
  context.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  const client = await connect(socketPath);
  context.after(() => client.destroy());
  const response = readLine(client);
  client.write(`${JSON.stringify({ type: "control", version: 1, id: "arm-1", action: "request-arm" })}\n`);

  assert.equal((await response).includes("control-result"), true);
  assert.equal(commands[0].action, "request-arm");
});

test("rejects malformed control input without calling the handler", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "poly-engine-test-"));
  const socketPath = path.join(directory, "engine.sock");
  let calls = 0;
  const server = new SnapshotSocketServer({
    socketPath,
    onControlCommand: async () => {
      calls += 1;
    }
  });
  context.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await server.start();
  const client = await connect(socketPath);
  context.after(() => client.destroy());
  const response = readLine(client);
  client.write("not-json\n");

  assert.equal(JSON.parse(await response).code, "INVALID_COMMAND");
  assert.equal(calls, 0);
});