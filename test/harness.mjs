import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moonpi = (await import("../.test-dist/index.js")).default;

export async function createTempProject(config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "moonpi-test-cwd-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "moonpi.json"), JSON.stringify(config));
  return cwd;
}

export function createMockExtensionRuntime(cwd, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const sentUserMessages = [];
  const notifications = [];
  const compactions = [];
  let activeTools = [];
  let headerFactory;
  let editorFactory;
  let terminalInputHandler;
  let status;
  const widgets = new Map();

  const ui = {
    theme: {
      fg: (_name, value) => value,
      bold: (value) => value,
    },
    setHeader: (factory) => {
      headerFactory = factory;
    },
    setEditorComponent: (factory) => {
      editorFactory = factory;
    },
    setStatus: (key, value) => {
      status = { key, value };
    },
    setWidget: (key, value, opts) => {
      widgets.set(key, { value, opts });
    },
    notify: (message, level = "info") => notifications.push({ message, level }),
    onTerminalInput: (handler) => {
      terminalInputHandler = handler;
      return () => {
        if (terminalInputHandler === handler) terminalInputHandler = undefined;
      };
    },
    getEditorText: () => options.editorText ?? "",
    select: async (_title, choices) => options.selectResult ?? choices[0],
    editor: async () => options.editorResult ?? "",
    confirm: async () => options.confirmResult ?? true,
    input: async () => options.inputResult ?? "",
    custom: async (...args) => {
      if (options.customResult !== undefined) return options.customResult;
      if (typeof options.custom === "function") return options.custom(...args);
      return { confirmed: false, selectedPaths: [] };
    },
  };

  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    ui,
    signal: undefined,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
    compact: (request) => {
      compactions.push(request);
      request?.onComplete?.();
    },
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
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results;
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

  async function callTool(name, params, extra = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} tool should be registered`);
    return tool.execute(`${name}-call`, params, extra.signal, extra.onUpdate, ctx);
  }

  async function runCommand(name, args = "") {
    const command = commands.get(name);
    assert.ok(command, `${name} command should be registered`);
    return command.handler(args, ctx);
  }

  return {
    pi,
    ctx,
    commands,
    tools,
    entries,
    notifications,
    sentUserMessages,
    compactions,
    widgets,
    emit,
    buildInjectedPrompt,
    callTool,
    runCommand,
    get activeTools() {
      return activeTools;
    },
    get status() {
      return status;
    },
    get terminalInputHandler() {
      return terminalInputHandler;
    },
    get headerFactory() {
      return headerFactory;
    },
    get editorFactory() {
      return editorFactory;
    },
  };
}

export async function createMoonpiHarness({ config, runtimeOptions } = {}) {
  const cwd = await createTempProject(config ?? { contextFiles: { enabled: false }, guards: { cwdOnly: false, readBeforeWrite: false } });
  const runtime = createMockExtensionRuntime(cwd, runtimeOptions);

  const previousSyntheticKey = process.env.SYNTHETIC_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  delete process.env.SYNTHETIC_API_KEY;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network access in Moonpi tests");
  };

  try {
    await moonpi(runtime.pi);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSyntheticKey === undefined) delete process.env.SYNTHETIC_API_KEY;
    else process.env.SYNTHETIC_API_KEY = previousSyntheticKey;
  }

  assert.equal(fetchCalls, 0, "Moonpi tests must not touch the Synthetic API");
  await runtime.emit("session_start");

  return {
    pi: runtime.pi,
    ctx: runtime.ctx,
    commands: runtime.commands,
    tools: runtime.tools,
    entries: runtime.entries,
    notifications: runtime.notifications,
    sentUserMessages: runtime.sentUserMessages,
    compactions: runtime.compactions,
    widgets: runtime.widgets,
    emit: runtime.emit,
    buildInjectedPrompt: runtime.buildInjectedPrompt,
    callTool: runtime.callTool,
    runCommand: runtime.runCommand,
    cwd,
    get activeTools() {
      return runtime.activeTools;
    },
    get status() {
      return runtime.status;
    },
    get terminalInputHandler() {
      return runtime.terminalInputHandler;
    },
    get headerFactory() {
      return runtime.headerFactory;
    },
    get editorFactory() {
      return runtime.editorFactory;
    },
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
}
