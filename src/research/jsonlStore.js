import fs from "node:fs";
import path from "node:path";

export function dailyJsonlPath(basePath, timestampMs = Date.now()) {
  const parsed = path.parse(basePath);
  const date = new Date(timestampMs).toISOString().slice(0, 10);
  const extension = parsed.ext || ".jsonl";
  return path.join(parsed.dir, `${parsed.name}-${date}${extension}`);
}

export function appendDailyJsonl(basePath, event, timestampMs = Date.now()) {
  const filePath = dailyJsonlPath(basePath, timestampMs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return filePath;
}

export function listJsonlFiles(basePath) {
  const parsed = path.parse(basePath);
  if (!fs.existsSync(parsed.dir)) return [];
  const extension = parsed.ext || ".jsonl";
  const escapedName = parsed.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const datedName = new RegExp(`^${escapedName}-\\d{4}-\\d{2}-\\d{2}${escapedExtension}$`);
  return fs.readdirSync(parsed.dir)
    .filter((name) => name === parsed.base || datedName.test(name))
    .map((name) => path.join(parsed.dir, name))
    .sort();
}

export function forEachJsonlEvent(filePaths, onEvent) {
  let malformedRows = 0;
  for (const filePath of filePaths) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line), { filePath, line: index + 1 });
      } catch {
        malformedRows += 1;
      }
    });
  }
  return { malformedRows };
}

export function readJsonlFiles(filePaths) {
  const events = [];
  const errors = [];
  for (const filePath of filePaths) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        errors.push({ filePath, line: index + 1, error: error?.message ?? String(error) });
      }
    });
  }
  return { events, errors };
}