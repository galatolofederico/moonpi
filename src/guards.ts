import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { MoonpiController } from "./modes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expandPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function normalizePath(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isInsideCwd(filePath: string, cwd: string): boolean {
  const cwdReal = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  const target = normalizePath(filePath, cwdReal);
  const rel = relative(cwdReal, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathFromToolCall(event: ToolCallEvent): string | undefined {
  const input: Record<string, unknown> = isRecord(event.input) ? (event.input as Record<string, unknown>) : {};
  const value = input.path;
  if (typeof value === "string") return value;
  return undefined;
}

function shouldCheckPath(toolName: string): boolean {
  return toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "grep" || toolName === "find" || toolName === "ls";
}

function shouldRequirePriorRead(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

export function installGuards(pi: ExtensionAPI, controller: MoonpiController): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!shouldCheckPath(event.toolName)) return undefined;
    const rawPath = pathFromToolCall(event) ?? ".";

    if (controller.config.guards.cwdOnly && !isInsideCwd(rawPath, ctx.cwd)) {
      return {
        block: true,
        reason: `moonpi blocked ${event.toolName}: path is outside the current working directory: ${rawPath}`,
      };
    }

    if (!controller.config.guards.readBeforeWrite || !shouldRequirePriorRead(event.toolName)) return undefined;
    const absolute = normalizePath(rawPath, ctx.cwd);
    if (!existsSync(absolute)) return undefined;
    if (controller.state.hasRead(absolute)) return undefined;

    return {
      block: true,
      reason: `moonpi blocked ${event.toolName}: read the file first before modifying it: ${rawPath}`,
    };
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
    if (!rawPath) return undefined;
    controller.state.markRead(normalizePath(rawPath, ctx.cwd));
    controller.persist();
    return undefined;
  });
}
