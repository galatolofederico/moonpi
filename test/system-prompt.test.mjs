import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moonpi = (await import("../.test-dist/index.js")).default;

async function createTempProject() {
  const cwd = await mkdtemp(join(tmpdir(), "moonpi-prompt-cwd-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "moonpi.json"),
    JSON.stringify({ contextFiles: { enabled: false }, guards: { cwdOnly: false, readBeforeWrite: false } }),
  );
  return cwd;
}

function createMockExtensionRuntime(cwd) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const sentUserMessages = [];
  let activeTools = [];

  const ui = {
    theme: { fg: (_name, value) => value },
    setHeader: () => undefined,
    setEditorComponent: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    getEditorText: () => "",
    select: async (_title, options) => options[0],
    editor: async () => "",
    confirm: async () => true,
    input: async () => "",
    custom: async () => ({ confirmed: false, selectedPaths: [] }),
  };

  const ctx = {
    cwd,
    hasUI: true,
    ui,
    signal: undefined,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
    compact: () => undefined,
  };

  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerProvider: () => undefined,
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    setActiveTools: (toolNames) => {
      activeTools = [...toolNames];
    },
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (message) => sentUserMessages.push(message),
  };

  async function emit(event, payload = {}) {
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event, ...payload }, ctx);
    }
  }

  async function buildInjectedPrompt(basePrompt = "BASE SYSTEM PROMPT") {
    let systemPrompt = basePrompt;
    for (const handler of handlers.get("before_agent_start") ?? []) {
      const result = await handler(
        {
          type: "before_agent_start",
          prompt: "test prompt",
          systemPrompt,
          systemPromptOptions: { cwd },
        },
        ctx,
      );
      if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
    }
    return systemPrompt;
  }

  return {
    pi,
    ctx,
    commands,
    tools,
    sentUserMessages,
    emit,
    buildInjectedPrompt,
    get activeTools() {
      return activeTools;
    },
  };
}

async function createMoonpiHarness() {
  const cwd = await createTempProject();
  const runtime = createMockExtensionRuntime(cwd);

  const previousSyntheticKey = process.env.SYNTHETIC_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  delete process.env.SYNTHETIC_API_KEY;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network access in Moonpi prompt tests");
  };

  try {
    await moonpi(runtime.pi);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSyntheticKey === undefined) delete process.env.SYNTHETIC_API_KEY;
    else process.env.SYNTHETIC_API_KEY = previousSyntheticKey;
  }

  assert.equal(fetchCalls, 0, "prompt tests must not touch the Synthetic API");
  await runtime.emit("session_start");

  return {
    ...runtime,
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function setMode(harness, mode) {
  const command = harness.commands.get("moonpi:mode");
  assert.ok(command, "moonpi:mode command should be registered");
  await command.handler(mode, harness.ctx);
}

async function createTodoList(harness) {
  const todo = harness.tools.get("todo");
  assert.ok(todo, "todo tool should be registered");
  await todo.execute(
    "todo-call",
    { action: "set", items: [{ text: "Implement the planned change", status: "todo" }] },
    undefined,
    undefined,
    harness.ctx,
  );
}

async function advanceAgentEnd(harness) {
  await harness.emit("agent_end", { messages: [] });
}

async function enterSprintPlan(harness) {
  await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
  await writeFile(
    join(harness.cwd, "sprints", "1", "TASKS.md"),
    "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n",
  );

  const command = harness.commands.get("sprint:loop");
  assert.ok(command, "sprint:loop command should be registered");
  await command.handler("", harness.ctx);
}

test("Moonpi prompt setup does not use Synthetic API keys or network", async () => {
  const harness = await createMoonpiHarness();
  try {
    const todo = harness.tools.get("todo");
    const endConversation = harness.tools.get("end_conversation");

    assert.ok(todo, "todo tool should be registered");
    assert.ok(endConversation, "end_conversation tool should be registered");
    assert.match(todo.promptGuidelines.join("\n"), /When Moonpi Auto mode is in Plan phase/);
    assert.match(endConversation.promptGuidelines.join("\n"), /Use end_conversation only in Moonpi Auto Plan mode/);
    assert.deepEqual(harness.activeTools, ["read", "grep", "find", "ls", "todo", "question", "end_conversation"]);
  } finally {
    await harness.cleanup();
  }
});

const modeCases = [
  {
    name: "plan",
    setup: (harness) => setMode(harness, "plan"),
    expected: /Moonpi Plan mode is active/,
  },
  {
    name: "act",
    setup: (harness) => setMode(harness, "act"),
    expected: /Moonpi Act mode is active/,
  },
  {
    name: "auto plan",
    setup: async () => undefined,
    expected: /Moonpi Auto mode is in Plan phase/,
  },
  {
    name: "auto act",
    setup: async (harness) => {
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expected: /Moonpi Auto mode is in Act phase/,
  },
  {
    name: "fast",
    setup: (harness) => setMode(harness, "fast"),
    expected: /Moonpi Fast mode is active/,
    hasTodoState: false,
  },
  {
    name: "sprint plan",
    setup: (harness) => enterSprintPlan(harness),
    expected: /Moonpi Sprint Plan mode is active/,
  },
  {
    name: "sprint act",
    setup: async (harness) => {
      await enterSprintPlan(harness);
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expected: /Moonpi Sprint Act mode is active/,
  },
];

test("Moonpi mode prompts are injected for every mode", async (t) => {
  for (const modeCase of modeCases) {
    await t.test(modeCase.name, async () => {
      const harness = await createMoonpiHarness();
      try {
        await modeCase.setup(harness);
        const prompt = await harness.buildInjectedPrompt();

        assert.match(prompt, /^BASE SYSTEM PROMPT/);
        assert.match(prompt, /## Moonpi Mode/);
        assert.match(prompt, modeCase.expected);
        if (modeCase.hasTodoState === false) {
          assert.doesNotMatch(prompt, /Current TODO state:/);
        } else {
          assert.match(prompt, /Current TODO state:/);
        }
      } finally {
        await harness.cleanup();
      }
    });
  }
});
