import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Throttle status line updates during streaming (ms). */
const UPDATE_INTERVAL_MS = 200;
/** Rough chars-per-token ratio for real-time estimation. */
const CHARS_PER_TOKEN = 4;

let agentStartMs: number | null = null;
let lastUpdateMs = 0;
/** Output tokens estimated from text/thinking deltas during the current streaming message. */
let estimatedOutputTokens = 0;
/** Accurate usage accumulated from completed messages in this agent run. */
let accumulatedInput = 0;
let accumulatedOutput = 0;
let accumulatedCacheRead = 0;
let accumulatedCacheWrite = 0;
let accumulatedTotalTokens = 0;

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1);
  return `${m}m${rem}s`;
}

function updateStatusLine(ctx: ExtensionContext): void {
  if (!ctx.hasUI || agentStartMs === null) return;

  const elapsedMs = Date.now() - agentStartMs;
  if (elapsedMs <= 0) return;

  const totalOutput = accumulatedOutput + estimatedOutputTokens;
  if (totalOutput <= 0 && accumulatedInput <= 0) return;

  const elapsedSeconds = elapsedMs / 1000;
  const tps = totalOutput > 0 ? totalOutput / elapsedSeconds : 0;

  // Build cache string, only showing non-zero values
  const cacheParts: string[] = [];
  if (accumulatedCacheRead > 0) cacheParts.push(`${formatNum(accumulatedCacheRead)}↓`);
  if (accumulatedCacheWrite > 0) cacheParts.push(`${formatNum(accumulatedCacheWrite)}↑`);
  const cacheStr = cacheParts.length > 0 ? ` | cache ${cacheParts.join(" ")}` : "";

  const inputStr = accumulatedInput > 0 ? `${formatNum(accumulatedInput)} → ` : "";
  const tpsStr = tps > 0 ? `${tps.toFixed(1)} tok/s | ` : "";
  const total = accumulatedTotalTokens + estimatedOutputTokens;
  const stats = `${tpsStr}${inputStr}${formatNum(totalOutput)}${cacheStr} | total ${formatNum(total)} | ${formatDuration(elapsedMs)}`;
  ctx.ui.setStatus("moonpi-stats", ctx.ui.theme.fg("dim", stats));
}

function onAgentStart(): void {
  agentStartMs = Date.now();
  lastUpdateMs = 0;
  estimatedOutputTokens = 0;
  accumulatedInput = 0;
  accumulatedOutput = 0;
  accumulatedCacheRead = 0;
  accumulatedCacheWrite = 0;
  accumulatedTotalTokens = 0;
}

function onMessageUpdate(event: { assistantMessageEvent: { type: string; delta?: string } }, ctx: ExtensionContext): void {
  if (agentStartMs === null) return;

  const assistantEvent = event.assistantMessageEvent;
  if ((assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") && assistantEvent.delta) {
    estimatedOutputTokens += Math.ceil(assistantEvent.delta.length / CHARS_PER_TOKEN);
  }

  // Throttled update
  const now = Date.now();
  if (now - lastUpdateMs >= UPDATE_INTERVAL_MS) {
    lastUpdateMs = now;
    updateStatusLine(ctx);
  }
}

function onMessageEnd(event: { message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } } }, ctx: ExtensionContext): void {
  if (agentStartMs === null) return;

  const msg = event.message;
  if (msg.role !== "assistant") return;

  // Incorporate the accurate usage from the completed message
  accumulatedInput += msg.usage?.input ?? 0;
  accumulatedOutput += msg.usage?.output ?? 0;
  accumulatedCacheRead += msg.usage?.cacheRead ?? 0;
  accumulatedCacheWrite += msg.usage?.cacheWrite ?? 0;
  accumulatedTotalTokens += msg.usage?.totalTokens ?? 0;

  // Reset the estimated tokens since the real ones are now in accumulated
  estimatedOutputTokens = 0;

  // Immediate update on message end
  lastUpdateMs = Date.now();
  updateStatusLine(ctx);
}

function onAgentEnd(_event: { messages: Array<{ role: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } }> }, ctx: ExtensionContext): void {
  if (agentStartMs === null) return;

  // Ensure final accurate update
  lastUpdateMs = 0; // Force update bypassing throttle
  updateStatusLine(ctx);

  agentStartMs = null;
}

export function installStats(pi: ExtensionAPI): void {
  pi.on("agent_start", onAgentStart);
  pi.on("message_update", onMessageUpdate);
  pi.on("message_end", onMessageEnd);
  pi.on("agent_end", onAgentEnd);
}
