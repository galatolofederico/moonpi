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

function findContextFiles(dir: string, root: string, fileNames: Set<string>, ignoredDirs: Set<string>, results: string[]): void {
  for (const entry of safeReadDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) findContextFiles(fullPath, root, fileNames, ignoredDirs, results);
      continue;
    }
    if (entry.isFile() && fileNames.has(entry.name)) results.push(fullPath);
  }
}

function findDefaultContextFilePaths(cwd: string, controller: MoonpiController): string[] {
  const config = controller.config.contextFiles;
  if (!config.enabled || !existsSync(cwd)) return [];

  const paths: string[] = [];
  findContextFiles(cwd, cwd, new Set(config.fileNames), new Set(config.ignoreDirs), paths);
  paths.sort((left, right) => left.localeCompare(right));

  return paths.map((fullPath) => relative(cwd, fullPath));
}

function getEffectiveSelectedContextFilePaths(cwd: string, controller: MoonpiController): string[] {
  if (!controller.config.contextFiles.enabled || !existsSync(cwd)) return [];
  const selected = controller.state.selectedContextFilePaths;
  return selected === undefined ? findDefaultContextFilePaths(cwd, controller) : [...selected].sort((left, right) => left.localeCompare(right));
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

function buildPickerTree(cwd: string, controller: MoonpiController): PickerNode {
  const ignoredDirs = new Set(controller.config.contextFiles.ignoreDirs);

  function buildDir(dir: string, name: string, parent?: PickerNode): PickerNode {
    const node: PickerNode = {
      type: "dir",
      name,
      path: dir,
      relativePath: relative(cwd, dir),
      children: [],
      expanded: parent === undefined,
      ...(parent ? { parent } : {}),
    };

    for (const entry of safeReadDir(dir)) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        node.children.push(buildDir(join(dir, entry.name), entry.name, node));
      } else if (entry.isFile()) {
        const filePath = join(dir, entry.name);
        node.children.push({
          type: "file",
          name: entry.name,
          path: filePath,
          relativePath: relative(cwd, filePath),
          children: [],
          expanded: false,
          parent: node,
        });
      }
    }

    node.children.sort(sortEntries);
    return node;
  }

  return buildDir(cwd, ".");
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
  if (filePaths.length === 0) return "none";
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

      const root = buildPickerTree(ctx.cwd, controller);
      const allVisibleFilePaths = new Set(collectFilePaths(root));
      const selected = new Set(getEffectiveSelectedContextFilePaths(ctx.cwd, controller).filter((path) => allVisibleFilePaths.has(path)));

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

        function toggleNode(node: PickerNode): void {
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
            if (current?.type === "dir") current.expanded = true;
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
          const totalFiles = allVisibleFilePaths.size;
          const lines: string[] = [];
          const add = (line: string) => lines.push(truncateToWidth(line, width));

          add(theme.fg("accent", theme.bold("Pick moonpi context files")));
          add(theme.fg("dim", `${selectedCount}/${totalFiles} files selected for prompt injection`));
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
      const summary = result.selectedPaths.length === 0 ? "No files selected for prompt injection." : `Selected ${result.selectedPaths.length} context file(s).`;
      ctx.ui.notify(summary, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    controller.restoreFromSession(ctx);
    const paths = getEffectiveSelectedContextFilePaths(ctx.cwd, controller);
    if (paths.length === 0) return;
    const fileList = paths.map((p) => `  ${p}`).join("\n");
    ctx.ui.notify(`moonpi context files selected for injection (/pick to change):\n${fileList}`, "info");
  });

  pi.on("before_agent_start", async (event) => {
    const files = loadContextFiles(event.systemPromptOptions.cwd, controller);
    if (files.length === 0) return undefined;
    const rendered = files
      .map((file) => `<moonpi-context-file path="${escapeAttribute(file.relativePath)}">\n${file.content}\n</moonpi-context-file>`)
      .join("\n\n");

    return {
      systemPrompt: `${event.systemPrompt}

## Moonpi Project Context Files

The files selected with /pick are injected below. Keep relevant README.md, SPECS.md, SPRINT.md, and other selected project documents up to date when your work changes setup, behavior, commands, architecture, or project expectations.

${rendered}`,
    };
  });
}
