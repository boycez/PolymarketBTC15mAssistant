export function validateStrategyPlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new Error("Strategy plugin must be an object.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(plugin.id ?? ""))) {
    throw new Error("Strategy plugin id must use lowercase letters, numbers, and hyphens.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(plugin.version ?? ""))) {
    throw new Error(`Strategy plugin ${plugin.id} must use a semantic version.`);
  }
  if (typeof plugin.resolveConfig !== "function") {
    throw new Error(`Strategy plugin ${plugin.id} must define resolveConfig().`);
  }
  if (typeof plugin.evaluate !== "function") {
    throw new Error(`Strategy plugin ${plugin.id} must define evaluate().`);
  }
  return plugin;
}

export function strategyKey(plugin) {
  return `${plugin.id}@${plugin.version}`;
}