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
    expected: /## Plan Mode/,
  },
  {
    name: "act",
    setup: (harness) => setMode(harness, "act"),
    expected: /## Act Mode/,
  },
  {
    name: "auto plan",
    setup: async () => undefined,
    expected: /## Auto Mode/,
  },
  {
    name: "auto act",
    setup: async (harness) => {
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expected: /## Auto Mode/,
  },
  {
    name: "fast",
    setup: (harness) => setMode(harness, "fast"),
    expected: /## Fast Mode/,
  },
  {
    name: "sprint plan",
    setup: (harness) => enterSprintPlan(harness),
    expected: /## Sprint Plan Mode/,
  },
  {
    name: "sprint act",
    setup: async (harness) => {
      await enterSprintPlan(harness);
      await createTodoList(harness);
      await advanceAgentEnd(harness);
    },
    expected: /## Sprint Act Mode/,
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
        assert.match(prompt, modeCase.expected);
        assert.doesNotMatch(prompt, /Current Moonpi runtime state:/);
        assert.doesNotMatch(prompt, /Current TODO state:/);
        assert.doesNotMatch(prompt, /Implement the planned change/);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("Moonpi Auto Plan and Auto Act share the same injected prompt", async () => {
  const planHarness = await createMoonpiHarness();
  const actHarness = await createMoonpiHarness();
  try {
    const planPrompt = await planHarness.buildInjectedPrompt();
    await createTodoList(actHarness);
    await advanceAgentEnd(actHarness);
    const actPrompt = await actHarness.buildInjectedPrompt();

    assert.equal(actPrompt, planPrompt);
    assert.match(planPrompt, /Auto mode uses this same system prompt for both Plan and Act phases/);
    assert.match(planPrompt, /Auto mode is switching to Act phase\. Execute the TODO list now\./);
  } finally {
    await planHarness.cleanup();
    await actHarness.cleanup();
  }
});
