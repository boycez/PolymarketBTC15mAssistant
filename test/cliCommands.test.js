import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { engineInvocation, foregroundInvocation, parsePolyCommand } from "../src/cli/commands.js";

test("parses the public poly command surface", () => {
  assert.deepEqual(parsePolyCommand([]), { command: "help" });
  assert.deepEqual(parsePolyCommand(["start"]), { command: "start", mode: "paper" });
  assert.deepEqual(parsePolyCommand(["start", "live"]), { command: "start", mode: "live" });
  assert.deepEqual(parsePolyCommand(["engine", "restart"]), { command: "engine", action: "restart" });
  assert.deepEqual(parsePolyCommand(["dashboard"]), { command: "dashboard" });
  assert.deepEqual(parsePolyCommand(["doctor"]), { command: "doctor" });
  assert.deepEqual(parsePolyCommand(["install"]), { command: "install" });
  assert.deepEqual(parsePolyCommand(["version"]), { command: "version" });
});

test("rejects unknown commands, actions, modes, and extra arguments", () => {
  assert.throws(() => parsePolyCommand(["gateway", "start"]), /Unknown command/);
  assert.throws(() => parsePolyCommand(["engine", "enable"]), /Invalid engine action/);
  assert.throws(() => parsePolyCommand(["start", "production"]), /Invalid trading mode/);
  assert.throws(() => parsePolyCommand(["dashboard", "extra"]), /does not accept/);
});

test("maps foreground and systemd commands without shell strings", () => {
  assert.deepEqual(foregroundInvocation("live", {
    nodeExecutable: "/usr/bin/node",
    repositoryRoot: "/opt/polymarket-btc-assistant"
  }), {
    command: "/usr/bin/node",
    args: ["/opt/polymarket-btc-assistant/src/index.js", "--mode=live"],
    privileged: false
  });
  assert.deepEqual(engineInvocation("restart"), {
    command: "systemctl",
    args: ["restart", "polymarket-btc-assistant.service"],
    privileged: true
  });
  assert.deepEqual(engineInvocation("logs"), {
    command: "journalctl",
    args: ["-u", "polymarket-btc-assistant.service", "-f"],
    privileged: true
  });
});

test("runs the CLI when invoked through an npm-style symbolic link", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-cli-"));
  const linkedCli = path.join(temporaryDirectory, "poly");
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  try {
    fs.symlinkSync(cliPath, linkedCli);
    const result = spawnSync(linkedCli, ["version"], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.1.0\n");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});