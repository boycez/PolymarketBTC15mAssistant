import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function defaultSnapshotSocketPath() {
  const userId = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `polymarket-btc15m-${userId}.sock`);
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
  constructor({ socketPath = defaultSnapshotSocketPath() } = {}) {
    this.socketPath = socketPath;
    this.server = null;
    this.clients = new Set();
    this.ownsSocket = false;
    this.latestMessage = null;
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
      client.once("close", () => this.clients.delete(client));
      client.once("error", () => this.clients.delete(client));
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
    await fs.chmod(this.socketPath, 0o600);
  }

  publish(snapshot) {
    const message = `${JSON.stringify(snapshot)}\n`;
    this.latestMessage = message;
    if (!this.server) return;
    for (const client of this.clients) {
      if (!client.destroyed) client.write(message);
    }
  }

  async close() {
    for (const client of this.clients) client.destroy();
    this.clients.clear();

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