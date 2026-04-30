import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { MoonpiController } from "./modes.js";

interface LoadedContextFile {
  path: string;
  relativePath: string;
  content: string;
}

interface PickerNode {
  type: "dir" | "file";
  name: string;
  path: string;
  relativePath: string;
  children: PickerNode[];
  expanded: boolean;
  loaded: boolean;
  parent?: PickerNode;
}

interface VisiblePickerNode {
  node: PickerNode;
  depth: number;
}

interface PickResult {
  confirmed: boolean;
  selectedPaths: string[];
}

interface ScanStats {
  scannedEntries: number;
  truncatedByEntryLimit: boolean;
  truncatedByDepthLimit: boolean;
  truncatedByDefaultFileLimit: boolean;
}

interface DefaultContextFileDiscovery {
  paths: string[];
  stats: ScanStats;
}

interface PickerTreeResult {
  root: PickerNode;
  stats: ScanStats;
}

function createScanStats(): ScanStats {
  return {
    scannedEntries: 0,
    truncatedByEntryLimit: false,
    truncatedByDepthLimit: false,
    truncatedByDefaultFileLimit: false,
  };
}

function isInsideRoot(root: string, filePath: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(filePath);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${sep}`);
}

function sortEntries(left: PickerNode, right: PickerNode): number {
  if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function safeReadDir(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // Permission errors and other inaccessible folders are intentionally skipped.
    return [];
  }
}

function shouldSkipDir(name: string, ignoredDirs: Set<string>): boolean {
  return ignoredDirs.has(name);
}

function isPickableFile(name: string, pickable: Set<string>): boolean {
  if (pickable.has(name)) return true;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex >= 0) return pickable.has(name.slice(dotIndex));
  return false;
}

function canScanMore(stats: ScanStats, maxScannedEntries: number): boolean {
  if (stats.scannedEntries < maxScannedEntries) return true;
  stats.truncatedByEntryLimit = true;
  return false;
}

function findDefaultContextFilePaths(cwd: string, controller: MoonpiController): DefaultContextFileDiscovery {
  const config = controller.config.contextFiles;
  const stats = createScanStats();
  if (!config.enabled || !existsSync(cwd)) return { paths: [], stats };

  if (config.maxDefaultFiles <= 0) {
    stats.truncatedByDefaultFileLimit = true;
    return { paths: [], stats };
  }

  const fileNames = new Set(config.fileNames);
  const ignoredDirs = new Set(config.ignoreDirs);
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    const entries = safeReadDir(current.dir).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!canScanMore(stats, config.maxScannedEntries)) break;
      stats.scannedEntries += 1;
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, ignoredDirs)) continue;
        if (current.depth >= config.maxDepth) {
          stats.truncatedByDepthLimit = true;
          continue;
        }
        stack.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (entry.isFile() && fileNames.has(entry.name)) {
        found.push(relative(cwd, fullPath));
        if (found.length >= config.maxDefaultFiles) {
          stats.truncatedByDefaultFileLimit = true;
          stack.length = 0;
          break;
        }
      }
    }
  }

  found.sort((left, right) => left.localeCompare(right));
  return { paths: found, stats };
}

function getEffectiveSelectedContextFilePaths(cwd: string, controller: MoonpiController): string[] {
  if (!controller.config.contextFiles.enabled || !existsSync(cwd)) return [];
  const selected = controller.state.selectedContextFilePaths;
  return selected === undefined ? findDefaultContextFilePaths(cwd, controller).paths : [...selected].sort((left, right) => left.localeCompare(right));
}

function loadContextFiles(cwd: string, controller: MoonpiController): LoadedContextFile[] {
  const config = controller.config.contextFiles;
  if (!config.enabled || !existsSync(cwd)) return [];

  const selected = getEffectiveSelectedContextFilePaths(cwd, controller);
  const loaded: LoadedContextFile[] = [];
  let totalBytes = 0;

  for (const relativePath of selected) {
    const filePath = resolve(cwd, relativePath);
    if (!isInsideRoot(cwd, filePath)) continue;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (totalBytes >= config.maxTotalBytes) break;
      const remaining = config.maxTotalBytes - totalBytes;
      const raw = readFileSync(filePath, "utf-8");
      const content = raw.length > remaining ? raw.slice(0, remaining) : raw;
      totalBytes += content.length;
      loaded.push({ path: filePath, relativePath, content });
    } catch {
      // Deleted, unreadable, or binary-hostile paths are skipped instead of breaking the turn.
    }
  }

  return loaded;
}

function loadPickerChildren(cwd: string, controller: MoonpiController, node: PickerNode, stats: ScanStats): void {
  if (node.type !== "dir" || node.loaded) return;

  const config = controller.config.contextFiles;
  const ignoredDirs = new Set(config.ignoreDirs);
  const pickableExtensions = new Set(config.pickableExtensions);
  for (const entry of safeReadDir(node.path)) {
    if (!canScanMore(stats, config.maxScannedEntries)) break;
    stats.scannedEntries += 1;
    if (entry.isSymbolicLink()) continue;

    const filePath = join(node.path, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, ignoredDirs)) continue;
      node.children.push({
        type: "dir",
        name: entry.name,
        path: filePath,
        relativePath: relative(cwd, filePath),
        children: [],
        expanded: false,
        loaded: false,
        parent: node,
      });
    } else if (entry.isFile()) {
      if (!isPickableFile(entry.name, pickableExtensions)) continue;
      node.children.push({
        type: "file",
        name: entry.name,
        path: filePath,
        relativePath: relative(cwd, filePath),
        children: [],
        expanded: false,
        loaded: true,
        parent: node,
      });
    }
  }

  node.children.sort(sortEntries);
  node.loaded = true;
}

function buildPickerTree(cwd: string, controller: MoonpiController): PickerTreeResult {
  const stats = createScanStats();
  const root: PickerNode = {
    type: "dir",
    name: ".",
    path: cwd,
    relativePath: "",
    children: [],
    expanded: true,
    loaded: false,
  };
  loadPickerChildren(cwd, controller, root, stats);
  return { root, stats };
}

function formatScanLimitMessage(stats: ScanStats): string | undefined {
  const limits: string[] = [];
  if (stats.truncatedByEntryLimit) limits.push("entry limit");
  if (stats.truncatedByDepthLimit) limits.push("depth limit");
  if (stats.truncatedByDefaultFileLimit) limits.push("default-file limit");
  if (limits.length === 0) return undefined;
  return `scan truncated by ${limits.join(", ")} after ${stats.scannedEntries} entries`;
}

function collectVisibleNodes(root: PickerNode): VisiblePickerNode[] {
  const visible: VisiblePickerNode[] = [];
  function visit(node: PickerNode, depth: number): void {
    visible.push({ node, depth });
    if (node.type === "dir" && node.expanded) {
      for (const child of node.children) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return visible;
}

function collectFilePaths(node: PickerNode): string[] {
  if (node.type === "file") return [node.relativePath];
  const paths: string[] = [];
  for (const child of node.children) paths.push(...collectFilePaths(child));
  return paths;
}

function selectedState(node: PickerNode, selected: Set<string>): "none" | "partial" | "all" {
  const filePaths = collectFilePaths(node);
  if (filePaths.length === 0) {
    if (node.type === "dir" && !node.loaded) {
      const prefix = node.relativePath ? `${node.relativePath}/` : "";
      return [...selected].some((path) => path.startsWith(prefix)) ? "partial" : "none";
    }
    return "none";
  }
  const selectedCount = filePaths.filter((path) => selected.has(path)).length;
  if (selectedCount === 0) return "none";
  if (selectedCount === filePaths.length) return "all";
  return "partial";
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function installContextFiles(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.registerCommand("pick", {
    description: "Choose project files injected into the agent prompt",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pick requires the interactive UI.", "error");
        return;
      }
      if (!controller.config.contextFiles.enabled) {
        ctx.ui.notify("moonpi context file injection is disabled in /moonpi:settings.", "warning");
      }

      const tree = buildPickerTree(ctx.cwd, controller);
      const root = tree.root;
      const selected = new Set(getEffectiveSelectedContextFilePaths(ctx.cwd, controller));
      let scanLimitMessage = formatScanLimitMessage(tree.stats);
      if (scanLimitMessage) ctx.ui.notify(`/pick ${scanLimitMessage}. Narrow contextFiles limits or add ignored directories if needed.`, "warning");

      const result = await ctx.ui.custom<PickResult>((tui, theme, _kb, done) => {
        let cursorIndex = 0;
        let scrollOffset = 0;
        let cachedLines: string[] | undefined;
        const maxTreeRows = 24;

        function invalidate(): void {
          cachedLines = undefined;
          tui.requestRender();
        }

        function visibleRows(): VisiblePickerNode[] {
          return collectVisibleNodes(root);
        }

        function ensureCursorVisible(): void {
          const rows = visibleRows();
          cursorIndex = Math.min(Math.max(cursorIndex, 0), Math.max(0, rows.length - 1));
          if (cursorIndex < scrollOffset) scrollOffset = cursorIndex;
          if (cursorIndex >= scrollOffset + maxTreeRows) scrollOffset = cursorIndex - maxTreeRows + 1;
          scrollOffset = Math.min(Math.max(scrollOffset, 0), Math.max(0, rows.length - maxTreeRows));
        }

        function loadPickerDescendants(dirNode: PickerNode): void {
          loadPickerChildren(ctx.cwd, controller, dirNode, tree.stats);
          for (const child of dirNode.children) {
            if (child.type === "dir") loadPickerDescendants(child);
          }
        }

        function toggleNode(node: PickerNode): void {
          if (node.type === "dir") {
            loadPickerDescendants(node);
            scanLimitMessage = formatScanLimitMessage(tree.stats);
          }
          const paths = collectFilePaths(node);
          if (paths.length === 0) return;
          const allSelected = paths.every((path) => selected.has(path));
          for (const path of paths) {
            if (allSelected) selected.delete(path);
            else selected.add(path);
          }
        }

        function handleInput(data: string): void {
          const rows = visibleRows();
          const current = rows[cursorIndex]?.node;

          if (matchesKey(data, Key.up)) {
            cursorIndex = Math.max(0, cursorIndex - 1);
            ensureCursorVisible();
            invalidate();
            return;
          }
          if (matchesKey(data, Key.down)) {
            cursorIndex = Math.min(rows.length - 1, cursorIndex + 1);
            ensureCursorVisible();
            invalidate();
            return;
          }
          if (matchesKey(data, Key.right)) {
            if (current?.type === "dir") {
              loadPickerChildren(ctx.cwd, controller, current, tree.stats);
              scanLimitMessage = formatScanLimitMessage(tree.stats);
              current.expanded = true;
            }
            ensureCursorVisible();
            invalidate();
            return;
          }
          if (matchesKey(data, Key.left)) {
            if (current?.type === "dir" && current.expanded) {
              current.expanded = false;
            } else if (current?.parent) {
              const parentIndex = rows.findIndex((row) => row.node === current.parent);
              if (parentIndex >= 0) cursorIndex = parentIndex;
            }
            ensureCursorVisible();
            invalidate();
            return;
          }
          if (matchesKey(data, Key.space)) {
            if (current) toggleNode(current);
            invalidate();
            return;
          }
          if (data === "d" || data === "D") {
            selected.clear();
            invalidate();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            done({ confirmed: true, selectedPaths: [...selected].sort((left, right) => left.localeCompare(right)) });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done({ confirmed: false, selectedPaths: [] });
          }
        }

        function renderNode(row: VisiblePickerNode, isCursor: boolean, width: number): string {
          const { node, depth } = row;
          const state = selectedState(node, selected);
          const box = state === "all" ? theme.fg("success", "☑") : state === "partial" ? theme.fg("warning", "◩") : theme.fg("dim", "☐");
          const cursor = isCursor ? theme.fg("accent", "> ") : "  ";
          const indent = "  ".repeat(depth);
          const icon = node.type === "dir" ? (node.expanded ? "▾" : "▸") : " ";
          const name = node.type === "dir" ? `${node.name}/` : node.name;
          const label = isCursor ? theme.fg("accent", name) : node.type === "dir" ? theme.fg("text", name) : theme.fg("muted", name);
          return truncateToWidth(`${cursor}${indent}${box} ${icon} ${label}`, width);
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          ensureCursorVisible();
          const rows = visibleRows();
          const visible = rows.slice(scrollOffset, scrollOffset + maxTreeRows);
          const selectedCount = selected.size;
          const totalFiles = collectFilePaths(root).length;
          const lines: string[] = [];
          const add = (line: string) => lines.push(truncateToWidth(line, width));

          add(theme.fg("accent", theme.bold("Pick moonpi context files")));
          add(theme.fg("dim", `${selectedCount}/${totalFiles} files selected for prompt injection`));
          if (scanLimitMessage) add(theme.fg("warning", scanLimitMessage));
          add(theme.fg("dim", "↑/↓ move • ←/→ close/open • Space select • D deselect all • Enter confirm • Esc cancel"));
          lines.push("");

          for (let i = 0; i < visible.length; i += 1) {
            const absoluteIndex = scrollOffset + i;
            const row = visible[i];
            if (row) lines.push(renderNode(row, absoluteIndex === cursorIndex, width));
          }

          if (rows.length > maxTreeRows) {
            const end = Math.min(rows.length, scrollOffset + maxTreeRows);
            lines.push("");
            add(theme.fg("dim", `Showing ${scrollOffset + 1}-${end} of ${rows.length}`));
          }

          cachedLines = lines;
          return lines;
        }

        return { render, invalidate, handleInput };
      });

      if (!result.confirmed) {
        ctx.ui.notify("moonpi context selection cancelled", "info");
        return;
      }

      controller.state.selectedContextFilePaths = result.selectedPaths;
      controller.persist();
      const limitSuffix = scanLimitMessage ? ` (${scanLimitMessage})` : "";
      const summary = result.selectedPaths.length === 0 ? `No files selected for prompt injection.${limitSuffix}` : `Selected ${result.selectedPaths.length} context file(s).${limitSuffix}`;
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("context", {
    description: "Show files selected for prompt injection",
    handler: async (_args, ctx) => {
      if (!controller.config.contextFiles.enabled) {
        ctx.ui.notify("moonpi context file injection is disabled in /moonpi:settings.", "warning");
        return;
      }

      const paths = getEffectiveSelectedContextFilePaths(ctx.cwd, controller);
      const isManual = controller.state.selectedContextFilePaths !== undefined;

      if (paths.length === 0) {
        ctx.ui.notify(isManual ? "No files selected for prompt injection. Use /pick to select files." : "No default context files found. Use /pick to select files.", "info");
        return;
      }

      const fileList = paths.map((p) => `  ${p}`).join("\n");
      const source = isManual ? "manually selected with /pick" : "auto-discovered (use /pick to change)";
      ctx.ui.notify(`${paths.length} file(s) ${source}:\n${fileList}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    controller.restoreFromSession(ctx);
    const discovery = controller.state.selectedContextFilePaths === undefined ? findDefaultContextFilePaths(ctx.cwd, controller) : undefined;
    const paths = discovery ? discovery.paths : getEffectiveSelectedContextFilePaths(ctx.cwd, controller);
    const scanLimitMessage = discovery ? formatScanLimitMessage(discovery.stats) : undefined;
    if (paths.length === 0) {
      if (scanLimitMessage) ctx.ui.notify(`moonpi default context file ${scanLimitMessage}.`, "warning");
      return;
    }
    const fileList = paths.map((p) => `  ${p}`).join("\n");
    const scanNotice = scanLimitMessage ? `\n\nNote: default context file ${scanLimitMessage}.` : "";
    ctx.ui.notify(`moonpi context files selected for injection (/pick to change):\n${fileList}${scanNotice}`, "info");
  });

  pi.on("before_agent_start", async (event) => {
    const files = loadContextFiles(event.systemPromptOptions.cwd, controller);
    if (files.length === 0) return undefined;
    const rendered = files
      .map((file) => `<context-file path="${escapeAttribute(file.relativePath)}">\n${file.content}\n</context-file>`)
      .join("\n\n");

    return {
      systemPrompt: `${event.systemPrompt}

## Project Context Files

The files selected with /pick are injected below. Keep relevant README.md, SPECS.md, SPRINT.md, and other selected project documents up to date when your work changes setup, behavior, commands, architecture, or project expectations.

${rendered}`,
    };
  });
}
