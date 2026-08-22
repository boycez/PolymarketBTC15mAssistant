import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CONTROL_PROTOCOL_VERSION, parseControlCommand } from "./controlProtocol.js";

const MAX_CONTROL_BUFFER_BYTES = 65_536;

export function defaultSnapshotSocketPath() {
  const userId = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `polymarket-btc-assistant-${userId}.sock`);
}

export function parseSnapshotSocketMode(value = "0600") {
  const text = String(value).trim();
  if (text !== "0600" && text !== "0660") {
    throw new Error("POLYMARKET_ENGINE_SOCKET_MODE must be 0600 or 0660.");
  }
  return Number.parseInt(text, 8);
}

async function socketIsActive(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

export class SnapshotSocketServer {
  constructor({ socketPath = defaultSnapshotSocketPath(), socketMode = 0o600, onControlCommand = null } = {}) {
    this.socketPath = socketPath;
    this.socketMode = socketMode;
    this.server = null;
    this.clients = new Set();
    this.ownsSocket = false;
    this.latestMessage = null;
    this.onControlCommand = onControlCommand;
    this.clientBuffers = new Map();
    this.commandQueue = Promise.resolve();
  }

  async start() {
    if (this.server) return;

    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      await fs.lstat(this.socketPath);
      if (await socketIsActive(this.socketPath)) {
        throw new Error(`Engine socket is already in use: ${this.socketPath}`);
      }
      await fs.unlink(this.socketPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const server = net.createServer((client) => {
      client.setEncoding("utf8");
      this.clients.add(client);
      this.clientBuffers.set(client, "");
      client.on("data", (chunk) => this.consumeControlData(client, chunk));
      client.once("close", () => {
        this.clients.delete(client);
        this.clientBuffers.delete(client);
      });
      client.once("error", () => {
        this.clients.delete(client);
        this.clientBuffers.delete(client);
      });
      if (this.latestMessage) client.write(this.latestMessage);
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.ownsSocket = true;
    await fs.chmod(this.socketPath, this.socketMode);
  }

  publish(snapshot) {
    const message = `${JSON.stringify(snapshot)}\n`;
    this.latestMessage = message;
    if (!this.server) return;
    for (const client of this.clients) {
      if (!client.destroyed) client.write(message);
    }
  }

  setControlHandler(handler) {
    this.onControlCommand = typeof handler === "function" ? handler : null;
  }

  consumeControlData(client, chunk) {
    let buffer = (this.clientBuffers.get(client) ?? "") + chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_BUFFER_BYTES) {
      this.writeControlError(client, null, "INVALID_COMMAND", "Control command exceeds 64 KB.");
      client.destroy();
      return;
    }

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) this.enqueueControlCommand(client, line);
      newline = buffer.indexOf("\n");
    }
    this.clientBuffers.set(client, buffer);
  }

  enqueueControlCommand(client, line) {
    this.commandQueue = this.commandQueue.then(async () => {
      let command;
      try {
        command = parseControlCommand(line);
      } catch (error) {
        this.writeControlError(client, null, "INVALID_COMMAND", error?.message ?? String(error));
        return;
      }
      if (!this.onControlCommand) {
        this.writeControlError(client, command, "CONTROL_UNAVAILABLE", "Engine controls are unavailable.");
        return;
      }

      const response = await this.onControlCommand(command);
      if (!client.destroyed) client.write(`${JSON.stringify(response)}\n`);
    }).catch(() => {
      this.writeControlError(client, null, "ACTION_FAILED", "Control action failed.");
    });
  }

  writeControlError(client, command, code, message) {
    if (client.destroyed) return;
    client.write(`${JSON.stringify({
      type: "control-result",
      version: CONTROL_PROTOCOL_VERSION,
      id: command?.id ?? null,
      action: command?.action ?? null,
      ok: false,
      code,
      message,
      control: null
    })}\n`);
  }

  async close() {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.clientBuffers.clear();

    const server = this.server;
    this.server = null;
    this.latestMessage = null;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (this.ownsSocket) {
      this.ownsSocket = false;
      await fs.unlink(this.socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}