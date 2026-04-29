import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { MoonpiConfig, MoonpiMode } from "./types.js";

export const DEFAULT_CONFIG: MoonpiConfig = {
  defaultMode: "auto",
  preserveExternalTools: false,
  contextFiles: {
    enabled: true,
    fileNames: ["README.md", "SPECS.md", "SPRINT.md"],
    maxTotalBytes: 120_000,
    ignoreDirs: [".git", ".pi", "node_modules", "dist", "build", "coverage", ".next", ".turbo"],
  },
  guards: {
    cwdOnly: true,
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

  if (isMode(raw.defaultMode)) next.defaultMode = raw.defaultMode;
  if (typeof raw.preserveExternalTools === "boolean") next.preserveExternalTools = raw.preserveExternalTools;

  if (isRecord(raw.contextFiles)) {
    const context = raw.contextFiles;
    if (typeof context.enabled === "boolean") next.contextFiles.enabled = context.enabled;
    next.contextFiles.fileNames = readStringArray(context.fileNames, next.contextFiles.fileNames);
    next.contextFiles.ignoreDirs = readStringArray(context.ignoreDirs, next.contextFiles.ignoreDirs);
    if (typeof context.maxTotalBytes === "number" && Number.isFinite(context.maxTotalBytes)) {
      next.contextFiles.maxTotalBytes = Math.max(0, Math.floor(context.maxTotalBytes));
    }
  }

  if (isRecord(raw.guards)) {
    if (typeof raw.guards.cwdOnly === "boolean") next.guards.cwdOnly = raw.guards.cwdOnly;
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
