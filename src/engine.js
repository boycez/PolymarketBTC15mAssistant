import { SnapshotSocketServer, defaultSnapshotSocketPath } from "./engine/snapshotSocketServer.js";
import { executeControlCommand } from "./engine/controlProtocol.js";
import { runApplication } from "./index.js";

const socketPath = process.env.POLYMARKET_ENGINE_SOCKET?.trim() || defaultSnapshotSocketPath();
const snapshotServer = new SnapshotSocketServer({ socketPath });

try {
  await snapshotServer.start();
  console.log(`Engine snapshot socket: ${socketPath}`);
  await runApplication({
    renderDashboard: false,
    onSnapshot: (snapshot) => snapshotServer.publish(snapshot),
    onShutdown: () => snapshotServer.close(),
    onRuntimeReady: (runtime) => {
      snapshotServer.setControlHandler((command) => executeControlCommand(runtime, command));
    },
    externalControlsEnabled: true
  });
} catch (error) {
  await snapshotServer.close().catch(() => {});
  console.error(`Engine Startup Error: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}