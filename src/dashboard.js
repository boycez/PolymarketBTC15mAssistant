import { pathToFileURL } from "node:url";

import { SnapshotSocketClient } from "./dashboard/snapshotSocketClient.js";
import { renderTerminalDashboard } from "./dashboard/terminalRenderer.js";
import { defaultSnapshotSocketPath } from "./engine/snapshotSocketServer.js";

function screenWidth(stdout) {
  const width = Number(stdout?.columns);
  return Number.isFinite(width) && width >= 40 ? width : 80;
}

export function runDashboard({
  socketPath = process.env.POLYMARKET_ENGINE_SOCKET?.trim() || defaultSnapshotSocketPath(),
  stdin = process.stdin,
  stdout = process.stdout
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw new Error("Terminal dashboard requires an interactive TTY.");
  }

  let alternateScreenActive = false;
  let latestSnapshot = null;
  let connectionState = "CONNECTING";
  let connectionMessage = "Waiting for Engine";
  let stopped = false;

  const renderText = (text) => {
    if (!alternateScreenActive) {
      stdout.write("\x1b[?1049h\x1b[?25l");
      alternateScreenActive = true;
    }
    stdout.write(`\x1b[H\x1b[2J${text}`);
  };

  const restoreScreen = () => {
    if (!alternateScreenActive) return;
    stdout.write("\x1b[?25h\x1b[?1049l");
    alternateScreenActive = false;
  };

  const render = () => {
    if (!latestSnapshot) {
      renderText([
        "POLYMARKET BTC 15M ASSISTANT",
        "",
        `Engine Link: ${connectionState}`,
        `Socket:      ${socketPath}`,
        `Status:      ${connectionMessage}`,
        ""
      ].join("\n"));
      return;
    }

    const snapshotAgeMs = Math.max(0, Date.now() - Date.parse(latestSnapshot.generatedAt));
    const snapshot = {
      ...latestSnapshot,
      session: {
        ...latestSnapshot.session,
        engineConnection: connectionState,
        snapshotAgeMs
      }
    };
    renderText(renderTerminalDashboard(snapshot, { width: screenWidth(stdout) }));
  };

  const client = new SnapshotSocketClient({
    socketPath,
    onSnapshot: (snapshot) => {
      latestSnapshot = snapshot;
      connectionState = "CONNECTED";
      connectionMessage = "Receiving snapshots";
      render();
    },
    onStatus: (status) => {
      if (status.state === "INVALID_SNAPSHOT") {
        connectionState = "PROTOCOL ERROR";
      } else {
        connectionState = status.state;
      }
      connectionMessage = status.message ?? (status.state === "CONNECTING" ? "Waiting for Engine" : status.state);
      render();
    }
  });

  const refreshTimer = setInterval(render, 1_000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(refreshTimer);
    client.stop();
    restoreScreen();
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit();
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit();
  });

  render();
  client.start();
  return { client, stop };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    runDashboard();
  } catch (error) {
    console.error(`Dashboard Startup Error: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}