import net from "node:net";

import { RUNTIME_SNAPSHOT_VERSION } from "./runtimeSnapshot.js";
import { defaultSnapshotSocketPath } from "../engine/snapshotSocketServer.js";
import { CONTROL_PROTOCOL_VERSION, createControlCommand } from "../engine/controlProtocol.js";

const MAX_BUFFER_BYTES = 1_000_000;

function validateSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Snapshot must be a JSON object.");
  }
  if (value.version !== RUNTIME_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version: ${value.version ?? "missing"}.`);
  }
  if (!Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("Snapshot generatedAt must be a valid timestamp.");
  }
  return value;
}

function validateControlResult(value) {
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new Error(`Unsupported control response version: ${value.version ?? "missing"}.`);
  }
  if (value.id !== null && (typeof value.id !== "string" || value.id.length > 64)) {
    throw new Error("Control response id is invalid.");
  }
  if (typeof value.ok !== "boolean" || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new Error("Control response is malformed.");
  }
  return value;
}

export class SnapshotSocketClient {
  constructor({
    socketPath = defaultSnapshotSocketPath(),
    reconnectDelayMs = 1_000,
    onSnapshot = () => {},
    onStatus = () => {},
    onControlResult = () => {}
  } = {}) {
    this.socketPath = socketPath;
    this.reconnectDelayMs = reconnectDelayMs;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.onControlResult = onControlResult;
    this.socket = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.buffer = "";
    this.controlSequence = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.socket) return;
    this.onStatus({ state: "CONNECTING", socketPath: this.socketPath });

    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.buffer = "";
    let lastError = null;

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      this.onStatus({ state: "CONNECTED", socketPath: this.socketPath });
    });
    socket.on("data", (chunk) => this.consume(chunk, socket));
    socket.once("error", (error) => {
      lastError = error;
      socket.destroy();
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.buffer = "";
      if (this.stopped) return;
      this.onStatus({
        state: "DISCONNECTED",
        socketPath: this.socketPath,
        message: lastError?.message ?? "Engine connection closed."
      });
      this.scheduleReconnect();
    });
  }

  consume(chunk, socket) {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_BUFFER_BYTES) {
      this.onStatus({ state: "INVALID_SNAPSHOT", message: "Snapshot frame exceeds 1 MB." });
      socket.destroy();
      return;
    }

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  consumeLine(line) {
    try {
      const value = JSON.parse(line);
      if (value?.type === "control-result") {
        this.onControlResult(validateControlResult(value));
        return;
      }
      this.onSnapshot(validateSnapshot(value));
    } catch (error) {
      this.onStatus({ state: "INVALID_SNAPSHOT", message: error?.message ?? String(error) });
    }
  }

  sendControl(action) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      this.onStatus({ state: "CONTROL_UNAVAILABLE", message: "Engine is not connected." });
      return null;
    }
    this.controlSequence += 1;
    const id = `${Date.now().toString(36)}-${this.controlSequence.toString(36)}`;
    const command = createControlCommand({ id, action });
    this.socket.write(`${JSON.stringify(command)}\n`);
    return id;
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.destroy();
    this.buffer = "";
    this.onStatus({ state: "STOPPED", socketPath: this.socketPath });
  }
}