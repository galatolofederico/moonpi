import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const WAFER_REASONING_EFFORT_MAP = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
} as const;

export const WAFER_MODELS_FALLBACK: ProviderModelConfig[] = [
  {
    id: "Qwen3.5-397B-A17B",
    name: "Qwen3.5 397B A17B",
    reasoning: true,
    compat: {
      thinkingFormat: "zai",
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      reasoningEffortMap: WAFER_REASONING_EFFORT_MAP,
    },
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3.6,
      cacheRead: 0.06,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "GLM-5.1",
    name: "GLM 5.1",
    reasoning: true,
    compat: {
      thinkingFormat: "zai",
      zaiToolStream: true,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      reasoningEffortMap: WAFER_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 1.5,
      output: 4.5,
      cacheRead: 0.15,
      cacheWrite: 0,
    },
    contextWindow: 202752,
    maxTokens: 65536,
  },
];

// =========================================================================
// Model cache – persists live API models to disk for fast startup
// =========================================================================

const CACHE_FILE_NAME = "wafer-models-cache.json";

/** Maximum age in milliseconds before cached models are considered stale (12h). */
const CACHE_STALE_MS = 12 * 60 * 60 * 1000;

interface WaferModelsCache {
  /** ISO timestamp of when the cache was last written. */
  updatedAt: string;
  /** Model configs from the live Wafer API. */
  models: ProviderModelConfig[];
}

/** Resolve the cache file path (always inside the agent config dir). */
export function getCacheFilePath(): string {
  return join(getAgentDir(), CACHE_FILE_NAME);
}

/**
 * Read cached Wafer models from disk.
 * Returns `undefined` when the cache is missing, corrupt, or older than `maxAgeMs`.
 */
export function readCachedModels(maxAgeMs: number = CACHE_STALE_MS): ProviderModelConfig[] | undefined {
  const filePath = getCacheFilePath();
  if (!existsSync(filePath)) return undefined;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const cache = JSON.parse(raw) as WaferModelsCache;
    if (!Array.isArray(cache.models) || cache.models.length === 0) return undefined;

    // Check staleness
    const updated = new Date(cache.updatedAt).getTime();
    if (Number.isNaN(updated) || Date.now() - updated > maxAgeMs) return undefined;

    return cache.models;
  } catch {
    return undefined;
  }
}

/** Write Wafer models to the cache file. Failures are silently ignored. */
export function writeCachedModels(models: ProviderModelConfig[]): void {
  const filePath = getCacheFilePath();
  const cache: WaferModelsCache = {
    updatedAt: new Date().toISOString(),
    models,
  };
  try {
    writeFileSync(filePath, JSON.stringify(cache), "utf-8");
  } catch {
    // Cache writes are best-effort; don't block startup on permission errors, etc.
  }
}

/**
 * Merge cached models with the hardcoded fallback list.
 *
 * Cached models win on id collisions (they're fresher from the API).
 * Models present only in the fallback list are kept so nothing disappears
 * if the cache is partial.
 */
export function mergeWithFallback(cached: ProviderModelConfig[], fallback: ProviderModelConfig[]): ProviderModelConfig[] {
  const byId = new Map<string, ProviderModelConfig>();
  for (const m of fallback) byId.set(m.id, m);
  for (const m of cached) byId.set(m.id, m); // cached wins on collision
  return [...byId.values()];
}

// =========================================================================
// API response parsing
// =========================================================================

interface WaferModelResponse {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  max_model_len?: number;
}

/**
 * Parse models from the Wafer /v1/models endpoint response.
 * Uses fallback config for known models and creates basic configs for new ones.
 */
export function parseWaferModels(data: WaferModelResponse[], fallback: ProviderModelConfig[]): ProviderModelConfig[] {
  const fallbackById = new Map<string, ProviderModelConfig>();
  for (const m of fallback) fallbackById.set(m.id, m);

  return data.map((model) => {
    const existing = fallbackById.get(model.id);
    if (existing) {
      // Update context window from live data if available
      if (model.max_model_len) {
        return { ...existing, contextWindow: model.max_model_len };
      }
      return { ...existing };
    }

    // Unknown model – create a basic config
    const config: ProviderModelConfig = {
      id: model.id,
      name: model.id,
      reasoning: true,
      compat: {
        thinkingFormat: "zai",
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        reasoningEffortMap: WAFER_REASONING_EFFORT_MAP,
      },
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: model.max_model_len ?? 128000,
      maxTokens: 32768,
    };

    return config;
  });
}
