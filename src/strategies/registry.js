import { validateStrategyPlugin } from "./contract.js";
import { taEdgeV12Strategy } from "./taEdgeV12.js";

const plugins = [taEdgeV12Strategy].map(validateStrategyPlugin);
const aliases = new Map();

for (const plugin of plugins) {
  aliases.set(plugin.id, plugin);
  aliases.set(`${plugin.id}@${plugin.version}`, plugin);
  if (plugin.legacyName) aliases.set(plugin.legacyName, plugin);
}

export function listStrategyPlugins() {
  return [...plugins];
}

export function resolveStrategyPlugin(name = taEdgeV12Strategy.legacyName) {
  const key = String(name ?? "").trim();
  const plugin = aliases.get(key);
  if (!plugin) {
    throw new Error(`Unknown strategy "${key}". Available strategies: ${plugins.map((item) => item.legacyName ?? item.id).join(", ")}.`);
  }
  return plugin;
}