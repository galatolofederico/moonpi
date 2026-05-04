import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { MoonpiConfig, MoonpiMode } from "./types.js";

export const DEFAULT_PICKABLE_EXTENSIONS = [
	// JavaScript / TypeScript
	".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
	// Python
	".py", ".pyw", ".pyi",
	// Ruby
	".rb", ".erb",
	// Go
	".go",
	// Rust
	".rs",
	// C / C++
	".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx",
	// Java / Kotlin / Scala / Clojure
	".java", ".kt", ".kts", ".scala", ".clj", ".cljs",
	// C#
	".cs", ".csx",
	// Swift / Objective-C
	".swift", ".m", ".mm",
	// Other languages
	".zig", ".dart", ".lua", ".r", ".R", ".php", ".pl", ".pm", ".ex", ".exs", ".erl", ".hs", ".ml",
	// Shell
	".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
	// Web
	".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".svg",
	// Query / schema
	".sql", ".graphql", ".gql", ".prisma", ".proto",
	// Data / config
	".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg", ".conf", ".csv",
	// Docs
	".md", ".mdx", ".txt", ".rst", ".adoc", ".tex",
	// Common extensionless filenames
	"Dockerfile", "Makefile", "Gemfile", "Rakefile", ".gitignore", ".gitattributes", ".editorconfig",
];

export const DEFAULT_CONFIG: MoonpiConfig = {
  defaultMode: "auto",
  preserveExternalTools: false,
  contextFiles: {
    enabled: true,
    fileNames: ["README.md", "SPECS.md", "SPRINT.md"],
    maxTotalBytes: 120_000,
    maxDepth: 4,
    maxScannedEntries: 10_000,
    maxDefaultFiles: 25,
    pickableExtensions: DEFAULT_PICKABLE_EXTENSIONS,
    ignoreDirs: [
      // Version control
      ".git", ".hg", ".svn",
      // Pi config
      ".pi",
      // Node.js
      "node_modules", ".next", ".turbo", ".nuxt", "bower_components",
      // Python
      ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", "site-packages", ".eggs",
      // Rust
      "target",
      // Go
      "vendor",
      // Java / Kotlin
      ".gradle", "out",
      // Ruby
      "vendor", "bundle",
      // Elixir / Erlang
      "_build", "deps",
      // Build output
      "dist", "build", "coverage", ".cache", ".output",
      // Docker / env
      ".env",
      // IDE / editor
      ".idea", ".vscode", ".vs",
      // OS
      "__MACOSX",
      // Infra
      ".terraform", ".serverless",
      // Misc
      ".parcel-cache",
    ],
  },
  guards: {
    cwdOnly: true,
    allowedPaths: [],
    readBeforeWrite: true,
  },
  keybindings: {
    cycleNext: "tab",
    cyclePrevious: "",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is MoonpiMode {
  return value === "plan" || value === "act" || value === "auto" || value === "fast";
}

/** User-selectable modes for config defaults (excludes sprint internal modes). */
function isSelectableMode(value: unknown): value is MoonpiMode {
  return value === "plan" || value === "act" || value === "auto" || value === "fast";
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : fallback;
}

function mergeConfig(base: MoonpiConfig, raw: Record<string, unknown> | undefined): MoonpiConfig {
  if (!raw) return base;
  const next: MoonpiConfig = {
    defaultMode: base.defaultMode,
    preserveExternalTools: base.preserveExternalTools,
    contextFiles: { ...base.contextFiles },
    guards: { ...base.guards },
    keybindings: { ...base.keybindings },
  };

  if (isSelectableMode(raw.defaultMode)) next.defaultMode = raw.defaultMode;
  if (typeof raw.preserveExternalTools === "boolean") next.preserveExternalTools = raw.preserveExternalTools;

  if (isRecord(raw.contextFiles)) {
    const context = raw.contextFiles;
    if (typeof context.enabled === "boolean") next.contextFiles.enabled = context.enabled;
    next.contextFiles.fileNames = readStringArray(context.fileNames, next.contextFiles.fileNames);
    next.contextFiles.pickableExtensions = readStringArray(context.pickableExtensions, next.contextFiles.pickableExtensions);
    next.contextFiles.ignoreDirs = readStringArray(context.ignoreDirs, next.contextFiles.ignoreDirs);
    if (typeof context.maxTotalBytes === "number" && Number.isFinite(context.maxTotalBytes)) {
      next.contextFiles.maxTotalBytes = Math.max(0, Math.floor(context.maxTotalBytes));
    }
    if (typeof context.maxDepth === "number" && Number.isFinite(context.maxDepth)) {
      next.contextFiles.maxDepth = Math.max(0, Math.floor(context.maxDepth));
    }
    if (typeof context.maxScannedEntries === "number" && Number.isFinite(context.maxScannedEntries)) {
      next.contextFiles.maxScannedEntries = Math.max(0, Math.floor(context.maxScannedEntries));
    }
    if (typeof context.maxDefaultFiles === "number" && Number.isFinite(context.maxDefaultFiles)) {
      next.contextFiles.maxDefaultFiles = Math.max(0, Math.floor(context.maxDefaultFiles));
    }
  }

  if (isRecord(raw.guards)) {
    if (typeof raw.guards.cwdOnly === "boolean") next.guards.cwdOnly = raw.guards.cwdOnly;
    next.guards.allowedPaths = readStringArray(raw.guards.allowedPaths, next.guards.allowedPaths);
    if (typeof raw.guards.readBeforeWrite === "boolean") {
      next.guards.readBeforeWrite = raw.guards.readBeforeWrite;
    }
  }

  if (isRecord(raw.keybindings)) {
    if (typeof raw.keybindings.cycleNext === "string") next.keybindings.cycleNext = raw.keybindings.cycleNext;
    if (typeof raw.keybindings.cyclePrevious === "string") {
      next.keybindings.cyclePrevious = raw.keybindings.cyclePrevious;
    }
  }

  return next;
}

export function loadMoonpiConfig(cwd: string): MoonpiConfig {
  const globalConfig = readJsonFile(join(getAgentDir(), "moonpi.json"));
  const projectConfig = readJsonFile(join(cwd, ".pi", "moonpi.json"));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export function formatConfig(config: MoonpiConfig): string {
  return JSON.stringify(config, null, 2);
}
