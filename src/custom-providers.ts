import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// =========================================================================
// models.json helpers
// =========================================================================

/** The API types that custom providers can use. */
const KNOWN_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
  "azure-openai-responses",
  "openai-codex-responses",
] as const;

/** APIs that are OpenAI-compatible and support the /v1/models endpoint. */
const OPENAI_COMPAT_APIS = new Set([
  "openai-completions",
  "openai-responses",
]);

interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

function getModelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): ModelsConfig {
  const filePath = getModelsJsonPath();
  if (!existsSync(filePath)) {
    return { providers: {} };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    // Strip // line comments (same as pi's model-registry.ts)
    const stripped = raw
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
    return JSON.parse(stripped) as ModelsConfig;
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(config: ModelsConfig): void {
  const filePath = getModelsJsonPath();
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// =========================================================================
// Command: /custom-provider:add-provider
// =========================================================================

async function addProviderCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const config = readModelsJson();

  // 1. Provider name
  const providerName = await ctx.ui.input("Provider name (e.g. my-vllm)", "my-provider");
  if (!providerName?.trim()) {
    ctx.ui.notify("Cancelled: no provider name given.", "warning");
    return;
  }
  const name = providerName.trim();

  if (config.providers[name]) {
    const overwrite = await ctx.ui.confirm(
      `Provider "${name}" already exists. Overwrite?`,
      `Existing provider has baseUrl: ${config.providers[name]!.baseUrl ?? "none"}, api: ${config.providers[name]!.api ?? "none"}`,
    );
    if (!overwrite) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
  }

  // 2. API type
  const selectedApi = await ctx.ui.select("Select API type", [...KNOWN_APIS]);
  if (!selectedApi) {
    ctx.ui.notify("Cancelled: no API type selected.", "warning");
    return;
  }

  // 3. Base URL
  const defaultBaseUrl = selectedApi === "anthropic-messages"
    ? "https://api.anthropic.com"
    : selectedApi === "google-generative-ai"
      ? "https://generativelanguage.googleapis.com"
      : "";
  const baseUrl = await ctx.ui.input("Base URL", defaultBaseUrl || "http://localhost:8000/v1");
  if (!baseUrl?.trim()) {
    ctx.ui.notify("Cancelled: no base URL given.", "warning");
    return;
  }

  // 4. API key
  const apiKey = await ctx.ui.input("API key (or env var name like MY_API_KEY)", "none");
  if (!apiKey?.trim()) {
    ctx.ui.notify("Cancelled: no API key given.", "warning");
    return;
  }

  // Build the provider config
  const providerConfig: ProviderConfig = {
    baseUrl: baseUrl.trim(),
    api: selectedApi,
    apiKey: apiKey.trim(),
    models: [],
  };

  config.providers[name] = providerConfig;
  writeModelsJson(config);

  ctx.ui.notify(
    `Provider "${name}" added to models.json.\n` +
    `  API: ${selectedApi}\n` +
    `  Base URL: ${baseUrl.trim()}\n` +
    `  API Key: ${apiKey.trim()}\n\n` +
    `Use /custom-provider:add-model to add models, or /custom-provider:scan-models to auto-detect them.\n` +
    `Run /reload to refresh pi's model registry.`,
    "info",
  );
}

// =========================================================================
// Command: /custom-provider:add-model
// =========================================================================

async function addModelCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const config = readModelsJson();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    ctx.ui.notify(
      "No custom providers found. Use /custom-provider:add-provider first.",
      "warning",
    );
    return;
  }

  // 1. Select provider
  const selectedProvider = await ctx.ui.select("Select provider to add model to", providerNames);
  if (!selectedProvider) {
    ctx.ui.notify("Cancelled: no provider selected.", "warning");
    return;
  }

  const provider = config.providers[selectedProvider]!;

  // 2. Model ID
  const modelId = await ctx.ui.input("Model ID (e.g. Qwen/Qwen3-27B)", "");
  if (!modelId?.trim()) {
    ctx.ui.notify("Cancelled: no model ID given.", "warning");
    return;
  }

  // Check for duplicates
  const existingModels = provider.models ?? [];
  if (existingModels.some((m) => m.id === modelId.trim())) {
    ctx.ui.notify(`Model "${modelId.trim()}" already exists in provider "${selectedProvider}".`, "warning");
    return;
  }

  // 3. Optional fields
  const modelName = await ctx.ui.input("Model display name (optional, press Enter to skip)", modelId.trim());

  const wantsAdvanced = await ctx.ui.confirm("Configure advanced options?", "Context window, max tokens, reasoning, input types");
  const modelDef: ModelDefinition = {
    id: modelId.trim(),
    ...(modelName?.trim() && modelName.trim() !== modelId.trim() ? { name: modelName.trim() } : {}),
  };

  if (wantsAdvanced) {
    // API override
    const overrideApi = await ctx.ui.confirm("Override API type for this model?", `Provider default: ${provider.api ?? "unknown"}`);
    if (overrideApi) {
      const modelApi = await ctx.ui.select("Select model API type", [...KNOWN_APIS]);
      if (modelApi) modelDef.api = modelApi;
    }

    // Reasoning
    const reasoning = await ctx.ui.confirm("Does this model support reasoning/thinking?", "");
    modelDef.reasoning = reasoning;

    // Context window
    const ctxWindow = await ctx.ui.input("Context window (tokens)", "128000");
    if (ctxWindow?.trim()) {
      const val = parseInt(ctxWindow.trim(), 10);
      if (!Number.isNaN(val) && val > 0) modelDef.contextWindow = val;
    }

    // Max tokens
    const maxTokens = await ctx.ui.input("Max output tokens", "16384");
    if (maxTokens?.trim()) {
      const val = parseInt(maxTokens.trim(), 10);
      if (!Number.isNaN(val) && val > 0) modelDef.maxTokens = val;
    }

    // Input types
    const hasImage = await ctx.ui.confirm("Supports image input?", "");
    modelDef.input = hasImage ? ["text", "image"] : ["text"];
  }

  // Add model to provider
  if (!provider.models) provider.models = [];
  provider.models.push(modelDef);
  writeModelsJson(config);

  const summary = [
    `Model "${modelDef.id}" added to provider "${selectedProvider}" in models.json.`,
  ];
  if (modelDef.name) summary.push(`  Display name: ${modelDef.name}`);
  if (modelDef.reasoning !== undefined) summary.push(`  Reasoning: ${modelDef.reasoning}`);
  if (modelDef.contextWindow) summary.push(`  Context window: ${modelDef.contextWindow}`);
  if (modelDef.maxTokens) summary.push(`  Max tokens: ${modelDef.maxTokens}`);
  summary.push("");
  summary.push("Run /reload to refresh pi's model registry.");

  ctx.ui.notify(summary.join("\n"), "info");
}

// =========================================================================
// Command: /custom-provider:scan-models
// =========================================================================

interface RemoteModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  max_model_len?: number;
}

interface ModelsListResponse {
  object: string;
  data: RemoteModel[];
}

async function scanModelsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const config = readModelsJson();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    ctx.ui.notify(
      "No custom providers found. Use /custom-provider:add-provider first.",
      "warning",
    );
    return;
  }

  // Filter to providers that are OpenAI-compatible
  const compatProviders = providerNames.filter((name) => {
    const api = config.providers[name]!.api;
    return !api || OPENAI_COMPAT_APIS.has(api);
  });

  if (compatProviders.length === 0) {
    ctx.ui.notify(
      "No OpenAI-compatible providers found. Scan requires providers using openai-completions or openai-responses API.",
      "warning",
    );
    return;
  }

  // 1. Select provider
  const selectedProvider = await ctx.ui.select(
    "Select provider to scan for models",
    compatProviders,
  );
  if (!selectedProvider) {
    ctx.ui.notify("Cancelled: no provider selected.", "warning");
    return;
  }

  const provider = config.providers[selectedProvider]!;
  const baseUrl = provider.baseUrl?.replace(/\/+$/, "");

  if (!baseUrl) {
    ctx.ui.notify(`Provider "${selectedProvider}" has no base URL configured.`, "error");
    return;
  }

  // 2. Fetch models from /v1/models or /models
  const modelsEndpoint = baseUrl.endsWith("/v1") || baseUrl.endsWith("/v1/")
    ? `${baseUrl}/models`
    : `${baseUrl}/v1/models`;

  ctx.ui.notify(`Scanning ${modelsEndpoint}...`, "info");

  let response: ModelsListResponse;
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (provider.apiKey && provider.apiKey !== "none") {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    const res = await fetch(modelsEndpoint, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      ctx.ui.notify(
        `Failed to fetch models: HTTP ${res.status} ${res.statusText}\n` +
        `Endpoint: ${modelsEndpoint}`,
        "error",
      );
      return;
    }
    const body = await res.json() as ModelsListResponse;
    if (!body.data || !Array.isArray(body.data)) {
      ctx.ui.notify(
        `Unexpected response format. Expected { "data": [...] }.\n` +
        `Got: ${JSON.stringify(body).slice(0, 500)}`,
        "error",
      );
      return;
    }
    response = body;
  } catch (err) {
    ctx.ui.notify(
      `Failed to connect to ${modelsEndpoint}: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  if (response.data.length === 0) {
    ctx.ui.notify("No models found at the endpoint.", "info");
    return;
  }

  // 3. Show discovered models and let user select which to add
  const existingIds = new Set((provider.models ?? []).map((m) => m.id));
  const modelOptions = response.data.map((m) => {
    const exists = existingIds.has(m.id) ? " [already added]" : "";
    const maxLen = m.max_model_len ? ` (ctx: ${m.max_model_len})` : "";
    const owner = m.owned_by ? ` - ${m.owned_by}` : "";
    return `${m.id}${maxLen}${owner}${exists}`;
  });

  // Select which models to add
  const selectedModels = await ctx.ui.custom<string[]>((tui, theme, _kb, done) => {
    let cursorIndex = 0;
    const selected = new Set<number>();
    let cachedLines: string[] | undefined;
    // Only allow selecting models that aren't already added
    const addableIndices = response.data
      .map((m, i) => ({ i, alreadyAdded: existingIds.has(m.id) }))
      .filter((x) => !x.alreadyAdded)
      .map((x) => x.i);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        cursorIndex = Math.max(0, cursorIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        cursorIndex = Math.min(modelOptions.length - 1, cursorIndex + 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.space)) {
        if (addableIndices.includes(cursorIndex)) {
          if (selected.has(cursorIndex)) {
            selected.delete(cursorIndex);
          } else {
            selected.add(cursorIndex);
          }
        }
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        // If nothing selected, select all addable models
        const toAdd = selected.size > 0
          ? [...selected]
          : addableIndices;
        const ids = toAdd
          .sort((a, b) => a - b)
          .map((i) => response.data[i]!.id);
        done(ids);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done([]);
      }
      // a/A to select/deselect all
      if (data === "a") {
        for (const i of addableIndices) selected.add(i);
        refresh();
        return;
      }
      if (data === "A") {
        selected.clear();
        refresh();
        return;
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("text", ` Found ${response.data.length} models at ${selectedProvider}`));
      lines.push("");

      for (let i = 0; i < modelOptions.length; i++) {
        const isCursor = i === cursorIndex;
        const isAddable = addableIndices.includes(i);
        const isChecked = selected.has(i);
        const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
        const box = isAddable
          ? (isChecked ? theme.fg("success", "☑") : theme.fg("dim", "☐"))
          : theme.fg("dim", "■");
        const label = isAddable
          ? theme.fg("text", modelOptions[i]!)
          : theme.fg("dim", modelOptions[i]!);
        add(`${prefix}${box} ${label}`);
      }

      lines.push("");
      const selectedCount = selected.size;
      if (selectedCount > 0) {
        add(theme.fg("dim", ` ${selectedCount} selected • Space toggle • Enter confirm • a/A select/deselect all • Esc cancel`));
      } else {
        add(theme.fg("dim", ` Enter to add all new models • Space toggle • a/A select/deselect all • Esc cancel`));
      }

      add(theme.fg("accent", "─".repeat(width)));
      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => { cachedLines = undefined; },
      handleInput,
    };
  });

  if (selectedModels.length === 0) {
    ctx.ui.notify("No models selected. Cancelled.", "info");
    return;
  }

  // 4. Add selected models to provider
  if (!provider.models) provider.models = [];

  let addedCount = 0;
  let skippedCount = 0;
  for (const modelId of selectedModels) {
    if (existingIds.has(modelId)) {
      skippedCount++;
      continue;
    }
    const remoteModel = response.data.find((m) => m.id === modelId);
    const modelDef: ModelDefinition = {
      id: modelId,
      ...(remoteModel?.max_model_len ? { contextWindow: remoteModel.max_model_len } : {}),
    };
    provider.models.push(modelDef);
    existingIds.add(modelId);
    addedCount++;
  }

  writeModelsJson(config);

  ctx.ui.notify(
    `Scan complete for "${selectedProvider}".\n` +
    `  Added: ${addedCount} model(s)\n` +
    (skippedCount > 0 ? `  Skipped (already existing): ${skippedCount}\n` : "") +
    `\nRun /reload to refresh pi's model registry.`,
    "info",
  );
}

// =========================================================================
// Command: /custom-provider:remove-provider
// =========================================================================

async function removeProviderCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const config = readModelsJson();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    ctx.ui.notify(
      "No custom providers found in models.json.",
      "warning",
    );
    return;
  }

  // 1. Select provider to remove
  const selectedProvider = await ctx.ui.select("Select provider to remove", providerNames);
  if (!selectedProvider) {
    ctx.ui.notify("Cancelled: no provider selected.", "warning");
    return;
  }

  // 2. Confirm deletion
  const provider = config.providers[selectedProvider]!;
  const modelCount = provider.models?.length ?? 0;
  const confirmMessage = modelCount > 0
    ? `Remove provider "${selectedProvider}" and its ${modelCount} model(s)?`
    : `Remove provider "${selectedProvider}"?`;

  const confirmed = await ctx.ui.confirm(
    confirmMessage,
    `This will update models.json. Run /reload after to refresh pi's model registry.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  // 3. Remove provider
  delete config.providers[selectedProvider];
  writeModelsJson(config);

  ctx.ui.notify(
    `Provider "${selectedProvider}" removed from models.json.\n` +
    `Run /reload to refresh pi's model registry.`,
    "info",
  );
}

// =========================================================================
// Command: /custom-provider:remove-model
// =========================================================================

async function removeModelCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const config = readModelsJson();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    ctx.ui.notify(
      "No custom providers found in models.json.",
      "warning",
    );
    return;
  }

  // 1. Select provider
  const selectedProvider = await ctx.ui.select("Select provider to remove a model from", providerNames);
  if (!selectedProvider) {
    ctx.ui.notify("Cancelled: no provider selected.", "warning");
    return;
  }

  const provider = config.providers[selectedProvider]!;
  const models = provider.models ?? [];

  if (models.length === 0) {
    ctx.ui.notify(
      `Provider "${selectedProvider}" has no models.`,
      "warning",
    );
    return;
  }

  // 2. Select model to remove
  const modelLabels = models.map((m) => m.name ? `${m.id} (${m.name})` : m.id);
  const selectedModelLabel = await ctx.ui.select("Select model to remove", modelLabels);
  if (!selectedModelLabel) {
    ctx.ui.notify("Cancelled: no model selected.", "warning");
    return;
  }

  const selectedIndex = modelLabels.indexOf(selectedModelLabel);
  if (selectedIndex === -1) {
    ctx.ui.notify("Cancelled: could not resolve model.", "warning");
    return;
  }

  const modelToRemove = models[selectedIndex]!;

  // 3. Confirm
  const confirmed = await ctx.ui.confirm(
    `Remove model "${modelToRemove.id}" from provider "${selectedProvider}"?`,
    "This will update models.json. Run /reload after to refresh pi's model registry.",
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  // 4. Remove model
  provider.models = models.filter((_, i) => i !== selectedIndex);
  writeModelsJson(config);

  ctx.ui.notify(
    `Model "${modelToRemove.id}" removed from provider "${selectedProvider}" in models.json.\n` +
    `Run /reload to refresh pi's model registry.`,
    "info",
  );
}

// =========================================================================
// Install all custom-provider commands
// =========================================================================

export function installCustomProviderCommands(pi: ExtensionAPI): void {
  pi.registerCommand("custom-provider:add-provider", {
    description: "Add a custom provider to models.json (interactive wizard)",
    handler: addProviderCommand,
  });

  pi.registerCommand("custom-provider:add-model", {
    description: "Add a model to an existing custom provider in models.json",
    handler: addModelCommand,
  });

  pi.registerCommand("custom-provider:scan-models", {
    description: "Scan an OpenAI-compatible provider endpoint for available models and add them to models.json",
    handler: scanModelsCommand,
  });

  pi.registerCommand("custom-provider:remove-provider", {
    description: "Remove a custom provider and all its models from models.json",
    handler: removeProviderCommand,
  });

  pi.registerCommand("custom-provider:remove-model", {
    description: "Remove a model from an existing custom provider in models.json",
    handler: removeModelCommand,
  });
}
