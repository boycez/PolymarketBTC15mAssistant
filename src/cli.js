#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { engineInvocation, foregroundInvocation, POLY_HELP, parsePolyCommand } from "./cli/commands.js";

const SERVICE_NAME = "polymarket-engine.service";
const SERVICE_SOCKET = "/run/polymarket-btc15m/engine.sock";
const SERVICE_ENV = "/etc/polymarket-btc15m/engine.env";
const SERVICE_UNIT = `/etc/systemd/system/${SERVICE_NAME}`;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, { privileged = false, inherit = true, allowFailure = false } = {}) {
  const needsSudo = privileged && typeof process.getuid === "function" && process.getuid() !== 0;
  const executable = needsSudo ? "sudo" : command;
  const commandArgs = needsSudo ? [command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: REPOSITORY_ROOT,
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
    env: process.env
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
  return result;
}

function runEngineAction(action) {
  const invocation = engineInvocation(action);
  run(invocation.command, invocation.args, { privileged: invocation.privileged });
}

function installService() {
  if (process.platform !== "linux") {
    throw new Error("poly install is supported only on Linux with systemd.");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("poly install requires root. Run: sudo poly install");
  }
  if (REPOSITORY_ROOT !== "/opt/polymarket-btc15m") {
    throw new Error("Deploy the repository at /opt/polymarket-btc15m before running poly install.");
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) throw new Error("poly install requires Node.js 24 or newer.");

  const account = run("id", ["-u", "polymarket"], { inherit: false, allowFailure: true });
  if (account.status !== 0) {
    run("useradd", ["--system", "--home", "/nonexistent", "--shell", "/usr/sbin/nologin", "polymarket"]);
  }

  run("install", ["-d", "-o", "root", "-g", "polymarket", "-m", "0750", "/etc/polymarket-btc15m"]);
  run("install", ["-d", "-o", "polymarket", "-g", "polymarket", "-m", "0700", path.join(REPOSITORY_ROOT, "logs")]);
  run("chown", ["-R", "root:polymarket", REPOSITORY_ROOT]);
  run("chown", ["polymarket:polymarket", path.join(REPOSITORY_ROOT, "logs")]);
  run("chmod", ["0700", path.join(REPOSITORY_ROOT, "logs")]);

  if (!fs.existsSync(SERVICE_ENV)) {
    run("install", ["-m", "0600", path.join(REPOSITORY_ROOT, "deploy/systemd/engine.env.example"), SERVICE_ENV]);
  }
  run("install", ["-m", "0644", path.join(REPOSITORY_ROOT, "deploy/systemd/polymarket-engine.service"), SERVICE_UNIT]);

  const operator = String(process.env.SUDO_USER ?? "").trim();
  if (operator && operator !== "root") run("usermod", ["-aG", "polymarket", operator]);

  run("systemctl", ["daemon-reload"]);
  const analyzer = run("systemd-analyze", ["verify", SERVICE_UNIT], { allowFailure: true });
  if (analyzer.status !== 0) throw new Error("systemd service verification failed.");
  run("systemctl", ["enable", "--now", SERVICE_NAME]);

  process.stdout.write("Paper Engine installed and started.\n");
  if (operator && operator !== "root") {
    process.stdout.write(`User ${operator} was added to group polymarket; sign out and back in before running poly dashboard.\n`);
  }
}

function doctor() {
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(nodeMajor >= 24, "Node.js", process.version);
  add(fs.existsSync(path.join(REPOSITORY_ROOT, "package.json")), "Application", REPOSITORY_ROOT);

  if (process.platform === "linux") {
    add(fs.existsSync(SERVICE_UNIT), "systemd unit", SERVICE_UNIT);
    const active = run("systemctl", ["is-active", "--quiet", SERVICE_NAME], { inherit: false, allowFailure: true });
    add(active.status === 0, "Engine service", active.status === 0 ? "active" : "inactive");
    add(fs.existsSync(SERVICE_SOCKET), "Engine socket", SERVICE_SOCKET);
    if (fs.existsSync(SERVICE_SOCKET)) {
      const mode = fs.statSync(SERVICE_SOCKET).mode & 0o777;
      add(mode === 0o660 || mode === 0o600, "Socket permissions", mode.toString(8).padStart(4, "0"));
      try {
        fs.accessSync(SERVICE_SOCKET, fs.constants.R_OK | fs.constants.W_OK);
        add(true, "Dashboard access", "current user can access the socket");
      } catch {
        add(false, "Dashboard access", "sign out and back in to refresh group membership");
      }
    }
  } else {
    const localSocket = process.env.POLYMARKET_ENGINE_SOCKET?.trim();
    add(true, "systemd", "not used on this platform");
    if (localSocket) add(fs.existsSync(localSocket), "Engine socket", localSocket);
  }

  for (const check of checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function runDashboardCommand() {
  if (!process.env.POLYMARKET_ENGINE_SOCKET && process.platform === "linux" && fs.existsSync(SERVICE_SOCKET)) {
    process.env.POLYMARKET_ENGINE_SOCKET = SERVICE_SOCKET;
  }
  const { runDashboard } = await import("./dashboard.js");
  runDashboard();
}

export async function runPolyCli(argv = process.argv.slice(2)) {
  const parsed = parsePolyCommand(argv);
  if (parsed.command === "help") {
    process.stdout.write(POLY_HELP);
    return 0;
  }
  if (parsed.command === "version") {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (parsed.command === "start") {
    const invocation = foregroundInvocation(parsed.mode, {
      nodeExecutable: process.execPath,
      repositoryRoot: REPOSITORY_ROOT
    });
    return run(invocation.command, invocation.args).status ?? 1;
  }
  if (parsed.command === "engine") {
    runEngineAction(parsed.action);
    return 0;
  }
  if (parsed.command === "dashboard") {
    await runDashboardCommand();
    return 0;
  }
  if (parsed.command === "doctor") return doctor();
  if (parsed.command === "install") {
    installService();
    return 0;
  }
  return 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    process.exitCode = await runPolyCli();
  } catch (error) {
    process.stderr.write(`poly: ${error?.message ?? String(error)}\n\n${POLY_HELP}`);
    process.exitCode = 1;
  }
}
