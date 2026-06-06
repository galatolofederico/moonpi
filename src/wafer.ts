import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { WAFER_MODELS_FALLBACK, mergeWithFallback, parseWaferModels, readCachedModels, writeCachedModels } from "./wafer-models.js";
import type { MoonpiController } from "./modes.js";

const WAFER_PROVIDER = "wafer";
const WAFER_API_KEY_ENV = "WAFER_API_KEY";
const WAFER_OPENAI_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MODELS_URL = "https://pass.wafer.ai/v1/models";
const FETCH_TIMEOUT_MS = 15_000;

interface WaferModelsListResponse {
  object: string;
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    max_model_len?: number;
  }>;
}

async function fetchWaferModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  if (!apiKey) return null;

  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combinedSignal = AbortSignal.any(signals);

  try {
    const headers: Record<string, string> = {
      "X-Title": "moonpi",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(WAFER_MODELS_URL, {
      headers,
      signal: combinedSignal,
    });

    if (!response.ok) return null;

    const payload = await response.json() as WaferModelsListResponse;
    const models = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
    if (!models) return null;

    return parseWaferModels(models, WAFER_MODELS_FALLBACK);
  } catch {
    return null;
  }
}

async function getWaferApiKey(ctx: ExtensionContext): Promise<string> {
  const storedKey = await ctx.modelRegistry?.getApiKeyForProvider(WAFER_PROVIDER);
  return storedKey ?? process.env[WAFER_API_KEY_ENV] ?? "";
}

const WAFER_PROVIDER_CONFIG = {
  baseUrl: WAFER_OPENAI_BASE_URL,
  apiKey: `$${WAFER_API_KEY_ENV}`,
  api: "openai-completions" as const,
  headers: {
    "X-Title": "moonpi",
  },
};

function registerWaferProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(WAFER_PROVIDER, {
    ...WAFER_PROVIDER_CONFIG,
    models,
  });
}

/**
 * Fetch live models, persist to cache, and re-register the provider.
 * Returns the fetched models (or null on failure).
 */
async function refreshLiveModels(pi: ExtensionAPI, apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[] | null> {
  const fetchedModels = await fetchWaferModels(apiKey, signal);
  if (fetchedModels) {
    writeCachedModels(fetchedModels);
    registerWaferProvider(pi, fetchedModels);
  }
  return fetchedModels;
}

export async function installWafer(pi: ExtensionAPI, controller: MoonpiController): Promise<void> {
  if (!controller.config.wafer.enabled) return;

  // Fast path: read cached models from disk (synchronous, no network).
  const cachedModels = readCachedModels();
  const initialModels = cachedModels
    ? mergeWithFallback(cachedModels, WAFER_MODELS_FALLBACK)
    : WAFER_MODELS_FALLBACK;

  registerWaferProvider(pi, initialModels);

  // Background: fetch live models from the API and update the provider + cache.
  const apiKey = process.env[WAFER_API_KEY_ENV] ?? "";
  if (apiKey) {
    // Fire and forget – we already registered with cached/fallback models,
    // so startup isn't blocked on the network request.
    refreshLiveModels(pi, apiKey).catch(() => {
      // Silently ignore – the initialModels registration is still valid.
    });
  }

  // On session start, resolve the API key from auth storage (supports /login)
  // and refresh the model list from the live API.
  pi.on("session_start", async (_event, ctx) => {
    if (!controller.config.wafer.enabled) return;

    const apiKey = await getWaferApiKey(ctx);
    // Fire-and-forget: don't block session startup on the network request.
    refreshLiveModels(pi, apiKey, ctx.signal).catch(() => {});
  });
}
