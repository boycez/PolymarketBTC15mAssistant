export const TRADING_MODES = Object.freeze({
  PAPER: "paper",
  LIVE: "live"
});

export function resolveTradingMode({ argv = process.argv.slice(2), env = process.env } = {}) {
  let cliMode = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--mode=")) {
      cliMode = argument.slice("--mode=".length);
      break;
    }
    if (argument === "--mode") {
      cliMode = argv[index + 1] ?? "";
      break;
    }
  }

  const mode = String(cliMode ?? env.TRADING_MODE ?? TRADING_MODES.PAPER).trim().toLowerCase();
  if (!Object.values(TRADING_MODES).includes(mode)) {
    throw new Error(`Invalid trading mode "${mode || "(empty)"}". Expected "paper" or "live".`);
  }

  return mode;
}
