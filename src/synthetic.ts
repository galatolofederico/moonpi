import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { SYNTHETIC_MODELS_FALLBACK, parseSyntheticModels } from "./synthetic-models.js";

const SYNTHETIC_PROVIDER = "synthetic";
const SYNTHETIC_API_KEY_ENV = "SYNTHETIC_API_KEY";
const SYNTHETIC_OPENAI_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_MODELS_URL = "https://api.synthetic.new/openai/v1/models";
const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
const FETCH_TIMEOUT_MS = 15_000;

type QuotasErrorKind = "cancelled" | "timeout" | "config" | "http" | "network";

type QuotasResult =
  | { success: true; data: { quotas: QuotasResponse } }
  | { success: false; error: { message: string; kind: QuotasErrorKind } };

interface QuotasResponse {
  subscription?: {
    limit: number;
    requests: number;
    renewsAt: string;
  };
  search?: {
    hourly?: {
      limit: number;
      requests: number;
      renewsAt: string;
    };
  };
  freeToolCalls?: {
    limit: number;
    requests: number;
    renewsAt: string;
  };
  weeklyTokenLimit?: {
    nextRegenAt: string;
    percentRemaining: number;
    maxCredits: string;
    remainingCredits: string;
    nextRegenCredits: string;
  };
  rollingFiveHourLimit?: {
    nextTickAt: string;
    tickPercent: number;
    remaining: number;
    max: number;
    limited: boolean;
  };
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === "TimeoutError") ||
    (reason instanceof Error && reason.name === "TimeoutError")
  );
}

// ANSI color helpers
const ANSI_BLUE = "\x1b[34m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";

// Fixed regeneration cadences (from Synthetic docs)
const WEEKLY_REGEN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 2% every 3 hours
const ROLLING_REGEN_INTERVAL_MS = 3 * 60 * 1000; // 5% every 3 minutes

/** Parse a credit string that may contain commas or formatting into a number */
function parseCredits(value: string): number {
	const cleaned = value.replace(/[^0-9.eE+-]/g, "");
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : 0;
}

/** Format a duration in milliseconds as a human-readable string like "1d 3h 30m" */
function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "<1m";
}

/** Render a colored progress bar using ANSI block characters */
function renderBar(ratio: number, width: number, color: string): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
  return `${color}${bar}${ANSI_RESET}`;
}

function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt);
  const diffMs = date.getTime() - Date.now();
  if (Number.isNaN(date.getTime())) return resetAt;
  if (diffMs <= 0) return "soon";
  return `in ${formatDuration(diffMs)}`;
}

function formatSyntheticQuotas(quotas: QuotasResponse): string {
  const lines: string[] = [];
  const BAR_WIDTH = 24;

  if (quotas.weeklyTokenLimit) {
    const wt = quotas.weeklyTokenLimit;
    const remaining = parseCredits(wt.remainingCredits);
    const max = parseCredits(wt.maxCredits);
    const ratio = max > 0 ? remaining / max : 0;
    const regenCredits = parseCredits(wt.nextRegenCredits);
    const regenTimeStr = formatResetTime(wt.nextRegenAt);

    // Weekly regenerates 2% every 3 hours at a fixed cadence.
    // First regen arrives at nextRegenAt, subsequent regens every 3h.
    let fullRegenStr = "N/A";
    if (regenCredits > 0 && remaining < max) {
      const creditsNeeded = max - remaining;
      const intervalsNeeded = Math.ceil(creditsNeeded / regenCredits);
      const regenDate = new Date(wt.nextRegenAt);
      const firstIntervalMs = Math.max(0, regenDate.getTime() - Date.now());
      // First interval is time-to-next-tick, rest use fixed 3h cadence
      const fullRegenMs = firstIntervalMs + WEEKLY_REGEN_INTERVAL_MS * (intervalsNeeded - 1);
      fullRegenStr = formatDuration(fullRegenMs);
    } else if (remaining >= max) {
      fullRegenStr = "full";
    }

    lines.push(`${ANSI_BOLD}Weekly Tokens${ANSI_RESET}`);
    lines.push(
      `  ${remaining.toLocaleString()}/${max.toLocaleString()} credits  ${ANSI_DIM}(${(ratio * 100).toFixed(1)}%)${ANSI_RESET}`,
    );
    lines.push(`  ${renderBar(ratio, BAR_WIDTH, ANSI_BLUE)}`);
    lines.push(
      `  Regen +${regenCredits.toLocaleString()} ${regenTimeStr}  ${ANSI_DIM}Full: ${fullRegenStr}${ANSI_RESET}`,
    );
  }

  if (quotas.rollingFiveHourLimit) {
    const rf = quotas.rollingFiveHourLimit;
    const remainingInt = Math.round(rf.remaining);
    const maxInt = Math.round(rf.max);
    const ratio = rf.max > 0 ? rf.remaining / rf.max : 0;
    const state = rf.limited ? `${ANSI_DIM}limited${ANSI_RESET}` : `${ANSI_GREEN}available${ANSI_RESET}`;
    const tickTimeStr = formatResetTime(rf.nextTickAt);

    // Rolling 5h regenerates 5% of max every 3 minutes at a fixed cadence.
    // First regen arrives at nextTickAt, subsequent regens every 3 min.
    const regenPerTick = Math.max(1, Math.round(rf.max * 0.05));
    let fullRegenStr = "N/A";
    if (remainingInt < maxInt) {
      const needed = maxInt - remainingInt;
      const ticksNeeded = Math.ceil(needed / regenPerTick);
      const tickDate = new Date(rf.nextTickAt);
      const firstTickMs = Math.max(0, tickDate.getTime() - Date.now());
      // First tick is time-to-next-tick, rest use fixed 3 min cadence
      const fullRegenMs = firstTickMs + ROLLING_REGEN_INTERVAL_MS * (ticksNeeded - 1);
      fullRegenStr = formatDuration(fullRegenMs);
    } else {
      fullRegenStr = "full";
    }

    lines.push(`${ANSI_BOLD}Rolling 5h${ANSI_RESET}`);
    lines.push(
      `  ${remainingInt}/${maxInt} requests  ${state}  ${ANSI_DIM}(tick ${(rf.tickPercent * 100).toFixed(0)}%)${ANSI_RESET}`,
    );
    lines.push(`  ${renderBar(ratio, BAR_WIDTH, ANSI_GREEN)}`);
    lines.push(
      `  Regen +${regenPerTick} ${tickTimeStr}  ${ANSI_DIM}Full: ${fullRegenStr}${ANSI_RESET}`,
    );
  }

  if (lines.length === 0) {
    lines.push(JSON.stringify(quotas, null, 2));
  }

  return lines.join("\n");
}

async function fetchSyntheticQuotas(apiKey: string, signal?: AbortSignal): Promise<QuotasResult> {
  if (apiKey.length === 0) {
    return {
      success: false,
      error: { message: `No API key configured. Set ${SYNTHETIC_API_KEY_ENV} or run /login synthetic.`, kind: "config" },
    };
  }

  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combinedSignal = AbortSignal.any(signals);

  try {
    const response = await fetch(SYNTHETIC_QUOTAS_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "moonpi",
      },
      signal: combinedSignal,
    });

    if (!response.ok) {
      let message = response.statusText;
      const body = await response.text();
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
          else if (typeof parsed.message === "string") message = parsed.message;
          else message = body;
        } catch {
          message = body;
        }
      }
      return { success: false, error: { message, kind: "http" } };
    }

    return { success: true, data: { quotas: (await response.json()) as QuotasResponse } };
  } catch (error: unknown) {
    const aborted = combinedSignal.aborted || (error instanceof DOMException && error.name === "AbortError");
    if (aborted) {
      if (isTimeoutReason(combinedSignal.reason)) {
        return { success: false, error: { message: "Request timed out", kind: "timeout" } };
      }
      return { success: false, error: { message: "Request cancelled", kind: "cancelled" } };
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: { message, kind: "network" } };
  }
}

async function getSyntheticApiKey(ctx: ExtensionCommandContext): Promise<string> {
  const storedKey = await ctx.modelRegistry.authStorage.getApiKey(SYNTHETIC_PROVIDER, { includeFallback: false });
  return storedKey ?? process.env[SYNTHETIC_API_KEY_ENV] ?? "";
}

async function fetchSyntheticModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  if (!apiKey) return null;

  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combinedSignal = AbortSignal.any(signals);

  try {
    const headers: Record<string, string> = {
      "X-Title": "moonpi",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(SYNTHETIC_MODELS_URL, {
      headers,
      signal: combinedSignal,
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const models = Array.isArray(payload) ? payload : payload.data;
    if (!Array.isArray(models)) return null;

    return parseSyntheticModels(models);
  } catch {
    return null;
  }
}

async function handleQuotasCommand(ctx: ExtensionCommandContext): Promise<void> {
  const apiKey = await getSyntheticApiKey(ctx);
  const result = await fetchSyntheticQuotas(apiKey, ctx.signal);
  if (!result.success) {
    ctx.ui.notify(`Synthetic quotas failed: ${result.error.message}`, result.error.kind === "config" ? "warning" : "error");
    return;
  }

  ctx.ui.notify(formatSyntheticQuotas(result.data.quotas), "info");
}

export async function installSynthetic(pi: ExtensionAPI): Promise<void> {
  const apiKey = process.env[SYNTHETIC_API_KEY_ENV] ?? "";
  const fetchedModels = await fetchSyntheticModels(apiKey);
  const models = fetchedModels ?? SYNTHETIC_MODELS_FALLBACK;

  pi.registerProvider(SYNTHETIC_PROVIDER, {
    baseUrl: SYNTHETIC_OPENAI_BASE_URL,
    apiKey: SYNTHETIC_API_KEY_ENV,
    api: "openai-completions",
    headers: {
      Referer: "https://github.com/myname/moonpi",
      "X-Title": "moonpi",
    },
    models,
  });

  pi.registerCommand("synthetic:quotas", {
    description: "Show Synthetic weekly token and rolling 5h usage quotas",
    handler: async (_args, ctx) => {
      await handleQuotasCommand(ctx);
    },
  });
}
