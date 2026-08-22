import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function strategyConfigFingerprint(config) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(config))).digest("hex").slice(0, 16);
}

export function resolveCodeCommit(repositoryRoot = process.cwd()) {
  const explicit = String(process.env.APP_COMMIT ?? "").trim();
  if (explicit) return explicit;

  try {
    const gitPath = path.join(repositoryRoot, ".git");
    const stat = fs.statSync(gitPath);
    const gitDirectory = stat.isDirectory()
      ? gitPath
      : path.resolve(repositoryRoot, fs.readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\s*/, ""));
    const head = fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head || null;
    const ref = head.slice(5);
    try {
      return fs.readFileSync(path.join(gitDirectory, ref), "utf8").trim() || null;
    } catch {
      const packedRefs = fs.readFileSync(path.join(gitDirectory, "packed-refs"), "utf8");
      const match = packedRefs.split("\n").find((line) => line.endsWith(` ${ref}`));
      return match ? match.split(" ")[0] : null;
    }
  } catch {
    return null;
  }
}