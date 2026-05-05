import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMoonpiHarness } from "./harness.mjs";

const stableMoonpiTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "todo", "question", "end_conversation", "end_phase"];

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
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
  } finally {
    await harness.cleanup();
  }
});

const modeCases = [
  {
    name: "plan",
    setup: (harness) => setMode(harness, "plan"),
    expectedState: /Current Moonpi runtime state: moonpi:plan\./,
  },
  {
    name: "act",
    setup: (harness) => setMode(harness, "act"),
    expectedState: /Current Moonpi runtime state: moonpi:act\./,
  },
  {
    name: "auto plan",
    setup: async () => undefined,
    expectedState: /Current Moonpi runtime state: moonpi:auto plan\./,
  },
  {
    name: "auto act",
    setup: async (harness) => {
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expectedState: /Current Moonpi runtime state: moonpi:auto act\./,
  },
  {
    name: "fast",
    setup: (harness) => setMode(harness, "fast"),
    expectedState: /Current Moonpi runtime state: moonpi:fast\./,
  },
  {
    name: "sprint plan",
    setup: (harness) => enterSprintPlan(harness),
    expectedState: /Current Moonpi runtime state: moonpi:sprint plan, sprint 1, phase 1\./,
  },
  {
    name: "sprint act",
    setup: async (harness) => {
      await enterSprintPlan(harness);
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expectedState: /Current Moonpi runtime state: moonpi:sprint act, sprint 1, phase 1\./,
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
        assert.match(prompt, /You are moonpi/);
        assert.match(prompt, /## Moonpi Mode/);
        assert.match(prompt, /same advertised tool set across modes/);
        assert.match(prompt, /TODO state is not embedded in the system prompt/);
        assert.match(prompt, modeCase.expectedState);
        assert.doesNotMatch(prompt, /Current TODO state:/);
        assert.doesNotMatch(prompt, /Implement the planned change/);
      } finally {
        await harness.cleanup();
      }
    });
  }
});
