import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

let agentStartMs: number | null = null;

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

function onAgentStart(): void {
  agentStartMs = Date.now();
}

function onAgentEnd(event: { messages: Array<{ role: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } }> }, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (agentStartMs === null) return;

  const elapsedMs = Date.now() - agentStartMs;
  agentStartMs = null;
  if (elapsedMs <= 0) return;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;

  for (const message of event.messages) {
    if (message.role !== "assistant") continue;
    input += message.usage?.input ?? 0;
    output += message.usage?.output ?? 0;
    cacheRead += message.usage?.cacheRead ?? 0;
    cacheWrite += message.usage?.cacheWrite ?? 0;
    totalTokens += message.usage?.totalTokens ?? 0;
  }

  if (output <= 0) return;

  const elapsedSeconds = elapsedMs / 1000;
  const tps = output / elapsedSeconds;

  // Build cache string, only showing non-zero values
  const cacheParts: string[] = [];
  if (cacheRead > 0) cacheParts.push(`${formatNum(cacheRead)}↓`);
  if (cacheWrite > 0) cacheParts.push(`${formatNum(cacheWrite)}↑`);
  const cacheStr = cacheParts.length > 0 ? ` | cache ${cacheParts.join(" ")}` : "";

  const stats = `${tps.toFixed(1)} tok/s | ${formatNum(input)} → ${formatNum(output)}${cacheStr} | total ${formatNum(totalTokens)} | ${formatDuration(elapsedMs)}`;
  ctx.ui.setStatus("moonpi-stats", ctx.ui.theme.fg("dim", stats));
}

export function installStats(pi: ExtensionAPI): void {
  pi.on("agent_start", onAgentStart);
  pi.on("agent_end", onAgentEnd);
}
