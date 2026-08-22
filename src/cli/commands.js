const ENGINE_SERVICE = "polymarket-btc-assistant.service";
const ENGINE_ACTIONS = new Set(["start", "stop", "restart", "status", "logs"]);
const TRADING_MODES = new Set(["paper", "live"]);

export const POLY_HELP = `Polymarket BTC Assistant

Usage:
  poly start [paper|live]
  poly engine start|stop|restart|status|logs
  poly dashboard
  poly doctor
  poly version
  sudo poly install
  sudo poly update
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
  if (["dashboard", "doctor", "install", "update"].includes(command)) {
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
      args: ["-u", ENGINE_SERVICE, "-f"],
      privileged: true
    };
  }
  return {
    command: "systemctl",
    args: action === "status"
      ? ["status", ENGINE_SERVICE, "--no-pager"]
      : [action, ENGINE_SERVICE],
    privileged: action !== "status"
  };
}

export function updateInvocations({ nodeExecutable, repositoryRoot }) {
  return [
    { command: "systemctl", args: ["stop", ENGINE_SERVICE] },
    { command: "git", args: ["pull", "--ff-only"] },
    { command: "npm", args: ["ci", "--omit=dev"] },
    { command: "npm", args: ["test"] },
    { command: "npm", args: ["link"] },
    { command: nodeExecutable, args: [`${repositoryRoot}/src/cli.js`, "install"] }
  ];
}