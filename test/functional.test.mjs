import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMockExtensionRuntime, createMoonpiHarness, flushImmediate } from "./harness.mjs";

const defaultConfig = {
  contextFiles: { enabled: false },
  guards: { cwdOnly: false, readBeforeWrite: false },
};

const stableMoonpiTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "todo", "question", "end_conversation", "end_phase"];

function textOf(result) {
  return result.content.map((item) => item.text ?? "").join("\n");
}

test("registers the expected commands, tools, UI, status, and default active tool set", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    for (const command of ["moonpi:mode", "moonpi:settings", "pick", "context", "context:clear", "sprint:init", "sprint:loop", "custom-provider:add-provider", "custom-provider:add-model", "custom-provider:scan-models", "custom-provider:remove-provider", "custom-provider:remove-model"]) {
      assert.ok(harness.commands.has(command), `${command} command should be registered`);
    }
    assert.deepEqual([...harness.tools.keys()].sort(), ["end_conversation", "end_phase", "question", "todo"].sort());
    assert.ok(harness.headerFactory, "startup installs a custom header");
    assert.ok(harness.editorFactory, "startup installs a custom editor");
    assert.deepEqual(harness.status, { key: "moonpi", value: "moonpi auto:plan 0/0" });
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
  } finally {
    await harness.cleanup();
  }
});

test("mode command keeps the cache-stable tool set and rejects internal or unknown modes", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    await harness.runCommand("moonpi:mode", "fast");
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
    assert.equal(harness.notifications.at(-1).message, "moonpi mode: fast");

    await harness.runCommand("moonpi:mode", "sprint:plan");
    assert.match(harness.notifications.at(-1).message, /cannot be set manually/);
    assert.equal(harness.notifications.at(-1).level, "error");

    await harness.runCommand("moonpi:mode", "nonsense");
    assert.match(harness.notifications.at(-1).message, /Unknown moonpi mode/);
  } finally {
    await harness.cleanup();
  }
});

test("todo tool mutates, persists, renders status, and triggers Auto Act transition", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    let result = await harness.callTool("todo", { action: "add", text: "First", notes: "note" });
    assert.match(textOf(result), /Auto planning is complete/);
    assert.equal(result.terminate, true);
    assert.match(harness.widgets.get("moonpi-todos").value.join("\n"), /First \(note\)/);
    assert.equal(harness.entries.at(-1).customType, "moonpi-state");

    result = await harness.callTool("todo", { action: "update", id: 1, status: "in_progress", notes: "working" });
    assert.match(textOf(result), /\[~\] First \(working\)/);

    result = await harness.callTool("todo", { action: "remove", id: 99 });
    assert.match(textOf(result), /Current TODO list/);

    await harness.emit("agent_end", { messages: [] });
    await flushImmediate();
    assert.match(harness.sentUserMessages.at(-1), /^Auto mode is switching to Act phase\. Execute the TODO list now\.\n\n#1 \[/);
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
  } finally {
    await harness.cleanup();
  }
});

test("end_conversation terminates Auto planning without switching to Act", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    const result = await harness.callTool("end_conversation", { reason: "answered" });
    assert.equal(result.terminate, true);
    assert.match(textOf(result), /Conversation ended without an Act phase/);
    await harness.emit("agent_end", { messages: [] });
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("question tool supports open, single custom, multiple, disabled, and non-UI paths", async () => {
  const openHarness = await createMoonpiHarness({ config: defaultConfig, runtimeOptions: { inputResult: "free text" } });
  try {
    const open = await openHarness.callTool("question", { type: "open", question: "Why?" });
    assert.deepEqual(open.details, { type: "open", answer: "free text", answers: ["free text"], customAnswers: ["free text"] });
  } finally {
    await openHarness.cleanup();
  }

  const singleHarness = await createMoonpiHarness({
    config: defaultConfig,
    runtimeOptions: { selectResult: "Other (type your answer)", inputResult: "custom" },
  });
  try {
    const single = await singleHarness.callTool("question", { type: "single", question: "Pick", options: ["A"] });
    assert.deepEqual(single.details.answers, ["custom"]);
    assert.deepEqual(single.details.customAnswers, ["custom"]);
  } finally {
    await singleHarness.cleanup();
  }

  const multiHarness = await createMoonpiHarness({
    config: defaultConfig,
    runtimeOptions: { customResult: { answers: ["A", "custom"], customAnswers: ["custom"], cancelled: false } },
  });
  try {
    const multi = await multiHarness.callTool("question", { type: "multiple", question: "Pick", options: ["A", "B"] });
    assert.equal(multi.details.answer, "A, custom");
  } finally {
    await multiHarness.cleanup();
  }

  const noUiHarness = await createMoonpiHarness({ config: defaultConfig, runtimeOptions: { hasUI: false } });
  try {
    const noUi = await noUiHarness.callTool("question", { type: "open", question: "Why?" });
    assert.match(textOf(noUi), /interactive UI is not available/);
  } finally {
    await noUiHarness.cleanup();
  }

  const fastHarness = await createMoonpiHarness({ config: defaultConfig });
  try {
    await fastHarness.runCommand("moonpi:mode", "fast");
    const disabled = await fastHarness.callTool("question", { type: "open", question: "Why?" });
    assert.match(textOf(disabled), /disabled/);
  } finally {
    await fastHarness.cleanup();
  }
});

test("guards enforce cwd-only access and read-before-write tracking", async () => {
  const harness = await createMoonpiHarness({ config: { contextFiles: { enabled: false }, guards: { cwdOnly: true, readBeforeWrite: true } } });
  try {
    const inside = join(harness.cwd, "file.txt");
    const outside = join(harness.cwd, "..", "outside.txt");
    await writeFile(inside, "content");
    await writeFile(outside, "content");

    let results = await harness.emit("tool_call", { toolName: "read", input: { path: outside } });
    assert.equal(results.find(Boolean).block, true);
    assert.match(results.find(Boolean).reason, /outside the current working directory/);

    await harness.runCommand("moonpi:mode", "act");
    results = await harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } });
    assert.equal(results.find(Boolean).block, true);
    assert.match(results.find(Boolean).reason, /read the file first/);

    await harness.emit("tool_result", { toolName: "read", input: { path: "file.txt" }, isError: false });
    results = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });
    assert.equal(results.find(Boolean), undefined);

    results = await harness.emit("tool_call", { toolName: "write", input: { path: "new.txt" } });
    assert.equal(results.find(Boolean), undefined, "new files do not require a prior read");

    await harness.runCommand("moonpi:mode", "plan");
    results = await harness.emit("tool_call", { toolName: "bash", input: { command: "pwd" } });
    assert.equal(results.find(Boolean).block, true);
    assert.match(results.find(Boolean).reason, /read-only/);

    results = await harness.emit("tool_call", { toolName: "write", input: { path: "new.txt" } });
    assert.equal(results.find(Boolean).block, true);
    assert.match(results.find(Boolean).reason, /read-only/);
  } finally {
    await harness.cleanup();
  }
});

test("context files are discovered, injected, selectable with /pick, truncated, and kept inside cwd", async () => {
  const harness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md", "SPECS.md"], maxTotalBytes: 12, ignoreDirs: ["ignored"] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
    runtimeOptions: { customResult: { confirmed: true, selectedPaths: ["SPECS.md", "../outside.md"] } },
  });
  try {
    await writeFile(join(harness.cwd, "README.md"), "readme-content");
    await writeFile(join(harness.cwd, "SPECS.md"), "specs-content-long");
    await mkdir(join(harness.cwd, "ignored"));
    await writeFile(join(harness.cwd, "ignored", "README.md"), "ignored");
    await writeFile(resolve(harness.cwd, "..", "outside.md"), "outside");

    let prompt = await harness.buildInjectedPrompt("BASE");
    assert.match(prompt, /<context-file path="README.md">\nreadme-conte/);
    assert.doesNotMatch(prompt, /ignored/);

    await harness.runCommand("pick", "");
    assert.match(harness.notifications.at(-1).message, /Selected 2 context file/);
    prompt = await harness.buildInjectedPrompt("BASE");
    assert.match(prompt, /<context-file path="SPECS.md">\nspecs-conten/);
    assert.doesNotMatch(prompt, /outside/);
    assert.doesNotMatch(prompt, /<context-file path="README.md">/);
  } finally {
    await harness.cleanup();
  }
});

test("/pick lazily loads folders as they are opened", async () => {
  const harness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 10_000, maxDepth: 4, maxScannedEntries: 100, maxDefaultFiles: 10, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
    runtimeOptions: {
      custom: async (factory) => {
        let result;
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_name, value) => value, bold: (value) => value },
          undefined,
          (value) => {
            result = value;
          },
        );

        let rendered = component.render(120).join("\n");
        assert.doesNotMatch(rendered, /nested\.md/, "nested files are not indexed before opening their folder");

        component.handleInput("\x1b[B"); // docs/
        component.handleInput("\x1b[C"); // open docs/ and load direct children
        rendered = component.render(120).join("\n");
        assert.match(rendered, /nested\.md/, "opening a folder loads and renders its direct children");

        component.handleInput("\x1b[B"); // nested.md
        component.handleInput(" ");
        component.handleInput("\r");
        return result;
      },
    },
  });
  try {
    await mkdir(join(harness.cwd, "docs"));
    await writeFile(join(harness.cwd, "docs", "nested.md"), "nested");

    await harness.runCommand("pick", "");
    assert.deepEqual(harness.entries.at(-1).data.selectedContextFilePaths, ["docs/nested.md"]);
  } finally {
    await harness.cleanup();
  }
});

test("/context shows selected files and their source", async () => {
  // Auto-discovered files
  const autoHarness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 10_000, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
  });
  try {
    await writeFile(join(autoHarness.cwd, "README.md"), "readme");
    await autoHarness.runCommand("context", "");
    assert.match(autoHarness.notifications.at(-1).message, /1 file\(s\) auto-discovered/);
    assert.match(autoHarness.notifications.at(-1).message, /README\.md/);
  } finally {
    await autoHarness.cleanup();
  }

  // Manually selected files
  const pickHarness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 10_000, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
    runtimeOptions: { customResult: { confirmed: true, selectedPaths: ["README.md"] } },
  });
  try {
    await writeFile(join(pickHarness.cwd, "README.md"), "readme");
    await pickHarness.runCommand("pick", "");
    await pickHarness.runCommand("context", "");
    assert.match(pickHarness.notifications.at(-1).message, /1 file\(s\) manually selected with \/pick/);
  } finally {
    await pickHarness.cleanup();
  }

  // No files selected
  const emptyHarness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["UNLIKELY.md"], maxTotalBytes: 10_000, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
  });
  try {
    await emptyHarness.runCommand("context", "");
    assert.match(emptyHarness.notifications.at(-1).message, /No default context files found/);
  } finally {
    await emptyHarness.cleanup();
  }
});

test("/context:clear deselects all context files", async () => {
  // Clear auto-discovered files
  const autoHarness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 10_000, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
  });
  try {
    await writeFile(join(autoHarness.cwd, "README.md"), "readme");
    let prompt = await autoHarness.buildInjectedPrompt("BASE");
    assert.match(prompt, /<context-file path="README.md">/);

    await autoHarness.runCommand("context:clear", "");
    assert.match(autoHarness.notifications.at(-1).message, /Cleared context file selection/);
    assert.match(autoHarness.notifications.at(-1).message, /1 file\(s\) deselected/);

    prompt = await autoHarness.buildInjectedPrompt("BASE");
    assert.doesNotMatch(prompt, /<context-file path="README.md">/);
  } finally {
    await autoHarness.cleanup();
  }

  // Clear manually selected files
  const pickHarness = await createMoonpiHarness({
    config: {
      contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 10_000, ignoreDirs: [] },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
    runtimeOptions: { customResult: { confirmed: true, selectedPaths: ["README.md"] } },
  });
  try {
    await writeFile(join(pickHarness.cwd, "README.md"), "readme");
    await pickHarness.runCommand("pick", "");
    await pickHarness.runCommand("context:clear", "");
    assert.match(pickHarness.notifications.at(-1).message, /Cleared context file selection/);
    assert.match(pickHarness.notifications.at(-1).message, /1 file\(s\) deselected/);

    let prompt = await pickHarness.buildInjectedPrompt("BASE");
    assert.doesNotMatch(prompt, /<context-file path="README.md">/);

    // Verify context after clear
    await pickHarness.runCommand("context", "");
    assert.match(pickHarness.notifications.at(-1).message, /No files selected for prompt injection/);
  } finally {
    await pickHarness.cleanup();
  }
});

test("context file discovery is bounded by depth, scan, and default-file limits", async () => {
  const harness = await createMoonpiHarness({
    config: {
      contextFiles: {
        enabled: true,
        fileNames: ["README.md"],
        maxTotalBytes: 10_000,
        maxDepth: 1,
        maxScannedEntries: 100,
        maxDefaultFiles: 1,
        ignoreDirs: [],
      },
      guards: { cwdOnly: false, readBeforeWrite: false },
    },
    runtimeOptions: { customResult: { confirmed: true, selectedPaths: [] } },
  });
  try {
    await writeFile(join(harness.cwd, "README.md"), "root");
    await mkdir(join(harness.cwd, "one", "two"), { recursive: true });
    await writeFile(join(harness.cwd, "one", "README.md"), "one");
    await writeFile(join(harness.cwd, "one", "two", "README.md"), "too-deep");
    for (let i = 0; i < 20; i += 1) {
      await writeFile(join(harness.cwd, `file-${i}.txt`), "x");
    }

    await harness.emit("session_start");
    assert.match(harness.notifications.map((n) => n.message).join("\n"), /scan truncated/);

    const prompt = await harness.buildInjectedPrompt("BASE");
    const injected = [...prompt.matchAll(/<context-file path=/g)];
    assert.equal(injected.length, 1, "maxDefaultFiles caps automatic context injection");
    assert.doesNotMatch(prompt, /too-deep/);
  } finally {
    await harness.cleanup();
  }
});

test("sprint:init creates sprint directory, stores loop state, and sends planning instructions", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig, runtimeOptions: { editorResult: "Ship feature" } });
  try {
    await harness.runCommand("sprint:init", "");
    assert.match(harness.sentUserMessages.at(-1), /Create the sprint files for Sprint 1/);
    assert.match(harness.sentUserMessages.at(-1), /Sprint objective: Ship feature/);
    assert.equal(harness.entries.at(-1).data.sprintLoop.sprintNumber, 1);
  } finally {
    await harness.cleanup();
  }
});

test("sprint:loop enters sprint plan, end_phase completes phases, compacts, and finishes sprint", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
    await writeFile(
      join(harness.cwd, "sprints", "1", "TASKS.md"),
      "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n\n## Phase 2: Finish\n\n- [ ] Implement finish\n\n**Verification:**\n- Verify finish\n",
    );

    await harness.runCommand("sprint:loop", "");
    assert.match(harness.sentUserMessages.at(-1), /Sprint 1, Phase 1: Setup/);
    assert.deepEqual(harness.activeTools, stableMoonpiTools);

    let result = await harness.callTool("end_phase", { summary: "setup done" });
    assert.equal(result.terminate, true);
    assert.match(textOf(result), /continue with phase 2/);
    let tasks = await readFile(join(harness.cwd, "sprints", "1", "TASKS.md"), "utf-8");
    assert.match(tasks, /- \[x\] Implement setup/);
    assert.match(tasks, /Completion notes: setup done/);

    await harness.emit("agent_end", { messages: [] });
    assert.equal(harness.compactions.length, 1);
    assert.match(harness.sentUserMessages.at(-1), /Sprint 1, Phase 2: Finish/);

    result = await harness.callTool("end_phase", { phaseId: "2", summary: "finish done" });
    assert.equal(result.terminate, true);
    assert.match(textOf(result), /Sprint 1 is complete/);
    assert.deepEqual(harness.activeTools, stableMoonpiTools);
  } finally {
    await harness.cleanup();
  }
});

test("sprint default contextAction is clear and uses aggressive compaction instructions", async () => {
  const harness = await createMoonpiHarness({ config: defaultConfig });
  try {
    await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
    await writeFile(
      join(harness.cwd, "sprints", "1", "TASKS.md"),
      "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n\n## Phase 2: Finish\n\n- [ ] Implement finish\n\n**Verification:**\n- Verify finish\n",
    );

    await harness.runCommand("sprint:loop", "");
    await harness.callTool("end_phase", { summary: "setup done" });
    await harness.emit("agent_end", { messages: [] });

    assert.equal(harness.compactions.length, 1);
    const instructions = harness.compactions[0].customInstructions;
    assert.match(instructions, /minimal summary/i);
    assert.doesNotMatch(instructions, /Preserve the sprint goal/);
  } finally {
    await harness.cleanup();
  }
});

test("sprint contextAction compact uses preserving compaction instructions", async () => {
  const harness = await createMoonpiHarness({ config: { ...defaultConfig, sprint: { contextAction: "compact", autoCommit: false } } });
  try {
    await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
    await writeFile(
      join(harness.cwd, "sprints", "1", "TASKS.md"),
      "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n\n## Phase 2: Finish\n\n- [ ] Implement finish\n\n**Verification:**\n- Verify finish\n",
    );

    await harness.runCommand("sprint:loop", "");
    const result = await harness.callTool("end_phase", { summary: "setup done" });
    assert.match(textOf(result), /compacted/);
    await harness.emit("agent_end", { messages: [] });

    assert.equal(harness.compactions.length, 1);
    const instructions = harness.compactions[0].customInstructions;
    assert.match(instructions, /Preserve the sprint goal/);
  } finally {
    await harness.cleanup();
  }
});

test("sprint autoCommit calls git when in a git repo", async () => {
  const execResults = [
    { stdout: "true\n", stderr: "", code: 0, killed: false },  // git rev-parse --is-inside-work-tree
    { stdout: "M file.txt\n", stderr: "", code: 0, killed: false }, // git status --porcelain
    { stdout: "", stderr: "", code: 0, killed: false },            // git add -A
    { stdout: "", stderr: "", code: 0, killed: false },            // git commit -m
  ];
  const harness = await createMoonpiHarness({ config: { ...defaultConfig, sprint: { contextAction: "clear", autoCommit: true } }, runtimeOptions: { execResults } });
  try {
    await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
    await writeFile(
      join(harness.cwd, "sprints", "1", "TASKS.md"),
      "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n\n## Phase 2: Finish\n\n- [ ] Implement finish\n\n**Verification:**\n- Verify finish\n",
    );

    await harness.runCommand("sprint:loop", "");
    await harness.callTool("end_phase", { summary: "setup done" });

    // Verify git was called: rev-parse, status, add, commit
    assert.equal(harness.execCalls.length, 4);
    assert.equal(harness.execCalls[0].command, "git");
    assert.deepEqual(harness.execCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);
    assert.deepEqual(harness.execCalls[2].args, ["add", "-A"]);
    assert.match(harness.execCalls[3].args[2], /Sprint 1 Phase 1/);
  } finally {
    await harness.cleanup();
  }
});

test("sprint autoCommit disabled does not call git", async () => {
  const harness = await createMoonpiHarness({ config: { ...defaultConfig, sprint: { contextAction: "clear", autoCommit: false } } });
  try {
    await mkdir(join(harness.cwd, "sprints", "1"), { recursive: true });
    await writeFile(
      join(harness.cwd, "sprints", "1", "TASKS.md"),
      "## Phase 1: Setup\n\n- [ ] Implement setup\n\n**Verification:**\n- Verify setup\n\n## Phase 2: Finish\n\n- [ ] Implement finish\n\n**Verification:**\n- Verify finish\n",
    );

    await harness.runCommand("sprint:loop", "");
    await harness.callTool("end_phase", { summary: "setup done" });

    assert.equal(harness.execCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("session snapshots restore mode, todos, selected context files, and read guards", async () => {
  const first = await createMoonpiHarness({
    config: { contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 1000 }, guards: { cwdOnly: true, readBeforeWrite: true } },
  });
  try {
    await writeFile(join(first.cwd, "README.md"), "docs");
    await writeFile(join(first.cwd, "file.txt"), "content");
    await first.callTool("todo", { action: "set", items: [{ text: "Persist me", status: "blocked", notes: "because" }] });
    await first.emit("tool_result", { toolName: "read", input: { path: "file.txt" }, isError: false });
    first.entries.push({
      type: "custom",
      customType: "moonpi-state",
      data: { ...first.entries.at(-1).data, selectedContextFilePaths: ["README.md"] },
    });

    const restored = await createMoonpiHarness({
      config: { contextFiles: { enabled: true, fileNames: ["README.md"], maxTotalBytes: 1000 }, guards: { cwdOnly: true, readBeforeWrite: true } },
    });
    await restored.cleanup();

    // Reuse the same cwd and copied entries to simulate pi session resume.
    const runtime = createMockExtensionRuntime(first.cwd);
    const moonpi = (await import("../.test-dist/index.js")).default;
    await moonpi(runtime.pi);
    runtime.entries.push(...first.entries);
    await runtime.emit("session_start");

    const prompt = await runtime.buildInjectedPrompt("BASE");
    assert.doesNotMatch(prompt, /Persist me \(because\)/);
    const list = await runtime.callTool("todo", { action: "list" });
    assert.match(textOf(list), /Persist me \(because\)/);
    assert.match(prompt, /<context-file path="README.md">\ndocs/);
    await runtime.runCommand("moonpi:mode", "act");
    const guardResults = await runtime.emit("tool_call", { toolName: "write", input: { path: "file.txt" } });
    assert.equal(guardResults.find(Boolean), undefined);
  } finally {
    await first.cleanup();
  }
});

