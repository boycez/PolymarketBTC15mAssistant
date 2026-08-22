const ENGINE_ACTIONS = new Set(["start", "stop", "restart", "status", "logs"]);
const TRADING_MODES = new Set(["paper", "live"]);

export const POLY_HELP = `Polymarket BTC 15m Assistant

Usage:
  poly start [paper|live]
  poly engine start|stop|restart|status|logs
  poly dashboard
  poly doctor
  poly version
  sudo poly install
`;

export function parsePolyCommand(argv) {
  const [command = "help", argument, ...extra] = argv;
  if (extra.length) throw new Error("Too many command arguments.");

  if (command === "help" || command === "--help" || command === "-h") {
    if (argument) throw new Error("Help does not accept an argument.");
    return { command: "help" };
  }
  if (command === "version" || command === "--version" || command === "-v") {
    if (argument) throw new Error("Version does not accept an argument.");
    return { command: "version" };
  }
  if (["dashboard", "doctor", "install"].includes(command)) {
    if (argument) throw new Error(`${command} does not accept an argument.`);
    return { command };
  }
  if (command === "start") {
    const mode = argument ?? "paper";
    if (!TRADING_MODES.has(mode)) throw new Error(`Invalid trading mode: ${mode}.`);
    return { command, mode };
  }
  if (command === "engine") {
    if (!ENGINE_ACTIONS.has(argument)) {
      throw new Error(`Invalid engine action: ${argument ?? "missing"}.`);
    }
    return { command, action: argument };
  }
  throw new Error(`Unknown command: ${command}.`);
}

export function foregroundInvocation(mode, { nodeExecutable, repositoryRoot }) {
  return {
    command: nodeExecutable,
    args: [`${repositoryRoot}/src/index.js`, `--mode=${mode}`],
    privileged: false
  };
}

export function engineInvocation(action) {
  if (!ENGINE_ACTIONS.has(action)) throw new Error(`Invalid engine action: ${action}.`);
  if (action === "logs") {
    return {
      command: "journalctl",
      args: ["-u", "polymarket-engine.service", "-f"],
      privileged: true
    };
  }
  return {
    command: "systemctl",
    args: action === "status"
      ? ["status", "polymarket-engine.service", "--no-pager"]
      : [action, "polymarket-engine.service"],
    privileged: action !== "status"
  };
}