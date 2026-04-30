import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMoonpiHarness } from "./harness.mjs";

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
