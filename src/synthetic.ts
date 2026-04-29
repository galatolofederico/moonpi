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

function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt);
  const diffMs = date.getTime() - Date.now();
  if (Number.isNaN(date.getTime())) return resetAt;
  if (diffMs <= 0) return "soon";

  const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffHours < 24) return `in ${diffHours}h`;
  if (diffDays < 7) return `in ${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatCount(requests: number, limit: number): string {
  return `${requests}/${limit}`;
}

function formatSyntheticQuotas(quotas: QuotasResponse): string {
  const lines = ["Synthetic quotas:"];

  if (quotas.subscription) {
    lines.push(
      `Subscription: ${formatCount(quotas.subscription.requests, quotas.subscription.limit)} resets ${formatResetTime(
        quotas.subscription.renewsAt,
      )}`,
    );
  }

  if (quotas.weeklyTokenLimit) {
    lines.push(
      `Weekly tokens: ${quotas.weeklyTokenLimit.remainingCredits}/${quotas.weeklyTokenLimit.maxCredits} credits remaining (${formatPercent(
        quotas.weeklyTokenLimit.percentRemaining,
      )}), regenerates ${quotas.weeklyTokenLimit.nextRegenCredits} ${formatResetTime(quotas.weeklyTokenLimit.nextRegenAt)}`,
    );
  }

  if (quotas.rollingFiveHourLimit) {
    const state = quotas.rollingFiveHourLimit.limited ? "limited" : "available";
    lines.push(
      `Rolling 5h: ${quotas.rollingFiveHourLimit.remaining}/${quotas.rollingFiveHourLimit.max} ${state}, next tick ${formatResetTime(
        quotas.rollingFiveHourLimit.nextTickAt,
      )}`,
    );
  }

  if (quotas.search?.hourly) {
    lines.push(
      `Search hourly: ${formatCount(quotas.search.hourly.requests, quotas.search.hourly.limit)} resets ${formatResetTime(
        quotas.search.hourly.renewsAt,
      )}`,
    );
  }

  if (quotas.freeToolCalls) {
    lines.push(
      `Free tool calls: ${formatCount(quotas.freeToolCalls.requests, quotas.freeToolCalls.limit)} resets ${formatResetTime(
        quotas.freeToolCalls.renewsAt,
      )}`,
    );
  }

  if (lines.length === 1) {
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
    description: "Show Synthetic subscription and usage quotas",
    handler: async (_args, ctx) => {
      await handleQuotasCommand(ctx);
    },
  });
}
