import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { acquireLivePrivateKey, acquireLiveRelayerApiKey } from "../src/security/terminalSecret.js";

function fakeTerminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  input.resume = () => {};
  input.pause = () => {};

  let displayed = "";
  const output = {
    isTTY: true,
    write(value) {
      displayed += String(value);
    }
  };
  return { input, output, displayed: () => displayed };
}

test("reads a valid Live private key without echoing it", async () => {
  const terminal = fakeTerminal();
  const privateKey = `0x${"a".repeat(64)}`;
  const resultPromise = acquireLivePrivateKey({
    mode: "live",
    enabled: true,
    input: terminal.input,
    output: terminal.output,
    nodeVersion: "24.0.0"
  });

  terminal.input.emit("data", `${privateKey}\r`);

  assert.equal(await resultPromise, privateKey);
  assert.equal(terminal.displayed().includes(privateKey), false);
  assert.equal(terminal.input.isRaw, false);
});

test("reads a Live Relayer API key without echoing it", async () => {
  const terminal = fakeTerminal();
  const apiKey = "relayer-api-key";
  const resultPromise = acquireLiveRelayerApiKey({
    mode: "live",
    enabled: true,
    input: terminal.input,
    output: terminal.output
  });

  terminal.input.emit("data", `${apiKey}\r`);

  assert.equal(await resultPromise, apiKey);
  assert.equal(terminal.displayed().includes(apiKey), false);
  assert.equal(terminal.input.isRaw, false);
});

test("does not request a private key when Live trading is not enabled", async () => {
  assert.equal(await acquireLivePrivateKey({ mode: "live", enabled: false }), "");
  assert.equal(await acquireLivePrivateKey({ mode: "paper", enabled: true }), "");
  assert.equal(await acquireLiveRelayerApiKey({ mode: "live", enabled: false }), "");
  assert.equal(await acquireLiveRelayerApiKey({ mode: "paper", enabled: true }), "");
});

test("rejects a malformed private key before SDK authentication", async () => {
  const terminal = fakeTerminal();
  const resultPromise = acquireLivePrivateKey({
    mode: "live",
    enabled: true,
    input: terminal.input,
    output: terminal.output,
    nodeVersion: "24.0.0"
  });

  terminal.input.emit("data", "not-a-private-key\r");

  await assert.rejects(resultPromise, /0x followed by 64 hexadecimal characters/);
  assert.equal(terminal.displayed().includes("not-a-private-key"), false);
  assert.equal(terminal.input.isRaw, false);
});

test("fails closed without an interactive terminal", async () => {
  await assert.rejects(
    acquireLivePrivateKey({
      mode: "live",
      enabled: true,
      input: { isTTY: false },
      output: { isTTY: false },
      nodeVersion: "24.0.0"
    }),
    /requires an interactive terminal/
  );
});