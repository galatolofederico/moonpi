import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMoonpiHarness } from "./harness.mjs";

const defaultConfig = {
  contextFiles: { enabled: false },
  guards: { cwdOnly: false, readBeforeWrite: false },
};

/**
 * Create a harness with PI_CODING_AGENT_DIR set to a temp directory
 * so that models.json reads/writes go to a known location.
 */
async function createProviderHarness(runtimeOptions = {}) {
  // The test harness creates a temp cwd; we reuse its parent for the agent dir.
  const harness = await createMoonpiHarness({ config: defaultConfig, runtimeOptions });

  // Create a separate temp dir for the agent config (models.json)
  const agentDir = join(harness.cwd, ".pi-agent-dir");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  return { harness, agentDir, cleanup: async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await harness.cleanup();
  } };
}

function readModelsJson(agentDir) {
  const filePath = join(agentDir, "models.json");
  if (!existsSync(filePath)) return { providers: {} };
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// Synchronous version for assertion convenience already imported above

test("custom-provider commands are registered", async () => {
  const { harness, cleanup } = await createProviderHarness();
  try {
    const expectedCommands = [
      "custom-provider:add-provider",
      "custom-provider:add-model",
      "custom-provider:scan-models",
      "custom-provider:remove-provider",
      "custom-provider:remove-model",
    ];
    for (const cmd of expectedCommands) {
      assert.ok(harness.commands.has(cmd), `${cmd} should be registered`);
    }
  } finally {
    await cleanup();
  }
});

test("add-provider writes provider to models.json", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    inputResults: ["my-vllm", "http://localhost:8000/v1", "none"],
    selectResult: "openai-completions",
  });
  try {
    // input("Provider name") -> "my-vllm"
    // select("API type") -> "openai-completions"
    // input("Base URL") -> "http://localhost:8000/v1"
    // input("API key") -> "none"
    await harness.runCommand("custom-provider:add-provider", "");

    const config = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    assert.ok(config.providers["my-vllm"], "provider should exist in models.json");
    assert.equal(config.providers["my-vllm"].api, "openai-completions");
    assert.equal(config.providers["my-vllm"].apiKey, "none");
    assert.ok(config.providers["my-vllm"].baseUrl);
    assert.deepEqual(config.providers["my-vllm"].models, []);
  } finally {
    await cleanup();
  }
});

test("add-provider with overwrite confirms before replacing existing provider", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    inputResults: ["existing", "http://new:8000/v1", "none"],
    selectResult: "openai-completions",
    confirmResult: true,
  });
  try {
    // Pre-populate models.json with an existing provider
    const config = { providers: { existing: { baseUrl: "http://old:8000/v1", api: "openai-completions", apiKey: "old-key", models: [] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:add-provider", "");

    const updated = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    assert.ok(updated.providers["existing"]);
    // The provider should have been overwritten (confirm was true)
    assert.equal(updated.providers["existing"].apiKey, "none");
  } finally {
    await cleanup();
  }
});

test("add-provider cancelled when no provider name given", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    inputResult: "",  // empty name -> cancelled
  });
  try {
    await harness.runCommand("custom-provider:add-provider", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no provider name given/i);
  } finally {
    await cleanup();
  }
});

test("add-model adds a model to an existing provider", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResult: "my-vllm",
    inputResults: ["Qwen/Qwen3-27B", "Qwen3-27B"], // model ID, display name
    confirmResult: false, // skip advanced options
  });
  try {
    // Pre-populate models.json
    const config = { providers: { "my-vllm": { baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "none", models: [] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:add-model", "");

    const updated = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    const models = updated.providers["my-vllm"].models;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "Qwen/Qwen3-27B");
  } finally {
    await cleanup();
  }
});

test("add-model with no providers shows warning", async () => {
  const { harness, cleanup } = await createProviderHarness();
  try {
    await harness.runCommand("custom-provider:add-model", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no custom providers found/i);
  } finally {
    await cleanup();
  }
});

test("add-model detects duplicate model ids", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResult: "my-vllm",
    inputResults: ["Qwen/Qwen3-27B"],
  });
  try {
    const config = { providers: { "my-vllm": { baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "none", models: [{ id: "Qwen/Qwen3-27B" }] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:add-model", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /already exists/);
  } finally {
    await cleanup();
  }
});

test("remove-provider deletes provider from models.json", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResult: "my-vllm",
    confirmResult: true,
  });
  try {
    const config = { providers: { "my-vllm": { baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "none", models: [{ id: "model-a" }] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:remove-provider", "");

    const updated = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    assert.ok(!updated.providers["my-vllm"], "provider should be removed");
  } finally {
    await cleanup();
  }
});

test("remove-provider with no providers shows warning", async () => {
  const { harness, cleanup } = await createProviderHarness();
  try {
    await harness.runCommand("custom-provider:remove-provider", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no custom providers found/i);
  } finally {
    await cleanup();
  }
});

test("remove-provider cancelled when confirmation denied", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResult: "my-vllm",
    confirmResult: false,
  });
  try {
    const config = { providers: { "my-vllm": { baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "none", models: [] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:remove-provider", "");

    const updated = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    assert.ok(updated.providers["my-vllm"], "provider should still exist after cancel");
  } finally {
    await cleanup();
  }
});

test("remove-model deletes a model from a provider", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResults: ["my-vllm", "model-a"], // provider, then model
    confirmResult: true,
  });
  try {
    const config = {
      providers: {
        "my-vllm": {
          baseUrl: "http://localhost:8000/v1",
          api: "openai-completions",
          apiKey: "none",
          models: [{ id: "model-a" }, { id: "model-b" }],
        },
      },
    };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:remove-model", "");

    const updated = JSON.parse(await readFile(join(agentDir, "models.json"), "utf-8"));
    const models = updated.providers["my-vllm"].models;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "model-b");
  } finally {
    await cleanup();
  }
});

test("remove-model with no providers shows warning", async () => {
  const { harness, cleanup } = await createProviderHarness();
  try {
    await harness.runCommand("custom-provider:remove-model", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no custom providers found/i);
  } finally {
    await cleanup();
  }
});

test("remove-model with provider having no models shows warning", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness({
    selectResult: "my-vllm",
  });
  try {
    const config = { providers: { "my-vllm": { baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "none", models: [] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:remove-model", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /has no models/i);
  } finally {
    await cleanup();
  }
});

test("scan-models with no providers shows warning", async () => {
  const { harness, cleanup } = await createProviderHarness();
  try {
    await harness.runCommand("custom-provider:scan-models", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no custom providers found/i);
  } finally {
    await cleanup();
  }
});

test("scan-models with no OpenAI-compatible providers shows warning", async () => {
  const { harness, agentDir, cleanup } = await createProviderHarness();
  try {
    const config = { providers: { "my-anthropic": { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "key", models: [] } } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify(config));

    await harness.runCommand("custom-provider:scan-models", "");
    const lastNotif = harness.notifications.at(-1);
    assert.match(lastNotif.message, /no openai-compatible providers found/i);
  } finally {
    await cleanup();
  }
});
