import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const SYNTHETIC_REASONING_EFFORT_MAP = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
} as const;

export const SYNTHETIC_MODELS_FALLBACK: ProviderModelConfig[] = [
  {
    id: "hf:zai-org/GLM-4.7",
    name: "zai-org/GLM-4.7",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 0.45,
      output: 2.19,
      cacheRead: 0.45,
      cacheWrite: 0,
    },
    contextWindow: 202752,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-5",
    name: "zai-org/GLM-5",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 1,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
    },
    contextWindow: 196608,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-5.1",
    name: "zai-org/GLM-5.1",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
      supportsDeveloperRole: false,
    },
    input: ["text"],
    cost: {
      input: 1,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
    },
    contextWindow: 196608,
    maxTokens: 65536,
  },
  {
    id: "hf:zai-org/GLM-4.7-Flash",
    name: "zai-org/GLM-4.7-Flash",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.1,
      cacheWrite: 0,
    },
    contextWindow: 196608,
    maxTokens: 65536,
  },
  {
    id: "hf:meta-llama/Llama-3.3-70B-Instruct",
    name: "meta-llama/Llama-3.3-70B-Instruct",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.88,
      output: 0.88,
      cacheRead: 0.88,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-R1-0528",
    name: "deepseek-ai/DeepSeek-R1-0528",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 3,
      output: 8,
      cacheRead: 3,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 128000,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3.2",
    name: "deepseek-ai/DeepSeek-V3.2",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.56,
      output: 1.68,
      cacheRead: 0.56,
      cacheWrite: 0,
    },
    contextWindow: 162816,
    maxTokens: 8000,
  },
  {
    id: "hf:openai/gpt-oss-120b",
    name: "openai/gpt-oss-120b",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.1,
      cacheRead: 0.1,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
    name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 2,
      output: 2,
      cacheRead: 2,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:moonshotai/Kimi-K2.5",
    name: "moonshotai/Kimi-K2.5",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text", "image"],
    cost: {
      input: 0.45,
      output: 3.4,
      cacheRead: 0.45,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:nvidia/Kimi-K2.5-NVFP4",
    name: "nvidia/Kimi-K2.5-NVFP4",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text", "image"],
    cost: {
      input: 0.45,
      output: 3.4,
      cacheRead: 0.45,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-V3",
    name: "deepseek-ai/DeepSeek-V3",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.25,
      output: 1.25,
      cacheRead: 1.25,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 128000,
  },
  {
    id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    name: "Qwen/Qwen3-235B-A22B-Thinking-2507",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 0.65,
      output: 3,
      cacheRead: 0.65,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 32000,
  },
  {
    id: "hf:Qwen/Qwen3.5-397B-A17B",
    name: "Qwen/Qwen3.5-397B-A17B",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3.6,
      cacheRead: 0.6,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "hf:MiniMaxAI/MiniMax-M2.5",
    name: "MiniMaxAI/MiniMax-M2.5",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.4,
      output: 2,
      cacheRead: 0.4,
      cacheWrite: 0,
    },
    contextWindow: 191488,
    maxTokens: 65536,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
      maxTokensField: "max_completion_tokens",
    },
  },
  {
    id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    reasoning: true,
    compat: {
      supportsReasoningEffort: true,
      reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
    },
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
];

interface SyntheticModelResponse {
  id: string;
  name: string;
  input_modalities: string[];
  output_modalities: string[];
  context_length: number;
  max_output_length: number;
  pricing: {
    prompt: string;
    completion: string;
    image: string;
    request: string;
    input_cache_reads: string;
    input_cache_writes: string;
  };
  supported_features: string[];
  quantization?: string;
}

const MODEL_COMPAT_OVERRIDES: Record<string, Partial<NonNullable<ProviderModelConfig["compat"]>>> = {
  "hf:zai-org/GLM-5.1": {
    supportsDeveloperRole: false,
  },
  "hf:MiniMaxAI/MiniMax-M2.5": {
    maxTokensField: "max_completion_tokens",
  },
};

function parsePricingValue(value: string): number {
  if (!value || value === "0") return 0;
  const num = parseFloat(value.replace(/^\$/, ""));
  if (Number.isNaN(num)) return 0;
  return num * 1_000_000;
}

export function parseSyntheticModels(data: SyntheticModelResponse[]): ProviderModelConfig[] {
  return data.map((model) => {
    const hasReasoning = model.supported_features?.includes("reasoning") ?? false;
    const input: ("text" | "image")[] = [];
    if (model.input_modalities?.includes("text")) input.push("text");
    if (model.input_modalities?.includes("image")) input.push("image");
    if (input.length === 0) input.push("text");

    const config: ProviderModelConfig = {
      id: model.id,
      name: model.name,
      reasoning: hasReasoning,
      input,
      cost: {
        input: parsePricingValue(model.pricing?.prompt ?? "0"),
        output: parsePricingValue(model.pricing?.completion ?? "0"),
        cacheRead: parsePricingValue(model.pricing?.input_cache_reads ?? "0"),
        cacheWrite: parsePricingValue(model.pricing?.input_cache_writes ?? "0"),
      },
      contextWindow: model.context_length ?? 128000,
      maxTokens: model.max_output_length ?? 4096,
    };

    const overrides = MODEL_COMPAT_OVERRIDES[model.id];
    if (hasReasoning) {
      config.compat = {
        supportsReasoningEffort: true,
        reasoningEffortMap: SYNTHETIC_REASONING_EFFORT_MAP,
        ...overrides,
      };
    } else if (overrides) {
      config.compat = { ...overrides };
    }

    return config;
  });
}
