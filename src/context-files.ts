import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MoonpiController } from "./modes.js";

interface LoadedContextFile {
  path: string;
  relativePath: string;
  content: string;
}

function findContextFiles(
  dir: string,
  root: string,
  fileNames: Set<string>,
  ignoredDirs: Set<string>,
  results: string[],
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) findContextFiles(fullPath, root, fileNames, ignoredDirs, results);
      continue;
    }
    if (entry.isFile() && fileNames.has(entry.name)) results.push(fullPath);
  }
}

function loadContextFiles(cwd: string, controller: MoonpiController): LoadedContextFile[] {
  const config = controller.config.contextFiles;
  if (!config.enabled || !existsSync(cwd)) return [];

  const paths: string[] = [];
  findContextFiles(cwd, cwd, new Set(config.fileNames), new Set(config.ignoreDirs), paths);
  paths.sort((left, right) => left.localeCompare(right));

  const loaded: LoadedContextFile[] = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;
    if (totalBytes >= config.maxTotalBytes) break;
    const remaining = config.maxTotalBytes - totalBytes;
    const raw = readFileSync(filePath, "utf-8");
    const content = raw.length > remaining ? raw.slice(0, remaining) : raw;
    totalBytes += content.length;
    loaded.push({
      path: filePath,
      relativePath: relative(cwd, filePath),
      content,
    });
  }
  return loaded;
}

export function installContextFiles(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.on("before_agent_start", async (event) => {
    const files = loadContextFiles(event.systemPromptOptions.cwd, controller);
    if (files.length === 0) return undefined;
    const rendered = files
      .map((file) => `<moonpi-context-file path="${file.relativePath}">\n${file.content}\n</moonpi-context-file>`)
      .join("\n\n");

    return {
      systemPrompt: `${event.systemPrompt}

## Moonpi Project Context Files

README.md and SPECS.md files discovered under the current working directory are injected below. Keep these files up to date when your work changes setup, behavior, commands, architecture, or project expectations.

${rendered}`,
    };
  });
}
