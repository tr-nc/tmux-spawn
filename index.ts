import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// fallback word pool for auto-generated names when the LLM is unavailable
const NAME_POOL = [
  "nova", "flux", "echo", "volt", "dune", "mode", "beam",
  "grid", "loop", "spin", "glow", "dash", "vibe", "byte",
  "node", "peak", "zinc", "luna", "mars", "bolt", "seek",
  "rift", "surf", "drift", "prism", "shard", "ember", "crest",
];

let nameIndex = 0;
function pickName(): string {
  const idx = nameIndex++ % NAME_POOL.length;
  const suffix = Math.floor(nameIndex / NAME_POOL.length);
  return suffix > 0 ? `${NAME_POOL[idx]}${suffix}` : NAME_POOL[idx]!;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type ParentReport = {
  type: string;
  agentName: string;
  timestamp: number;
  report?: unknown;
  note?: string;
  text?: string;
  json?: unknown;
};

type SpawnedAgent = {
  name: string;
  paneId: string;
  signalId: string;
  task: string;
  configDir: string;
  reportFile: string;
  splitArg: "-h" | "-v";
  createdAt: number;
};

function findAgent(agents: Map<string, SpawnedAgent>, name: string): SpawnedAgent | undefined {
  const exact = agents.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return [...agents.values()].find((agent) => agent.name.toLowerCase() === lower);
}

function hasAgentName(agents: Map<string, SpawnedAgent>, name: string): boolean {
  return findAgent(agents, name) !== undefined;
}

function normalizeAgentName(name: string): string {
  return (name || pickName())
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, 32) || pickName();
}

function uniqueAgentName(agents: Map<string, SpawnedAgent>, requested: string): string {
  const base = normalizeAgentName(requested);
  if (!hasAgentName(agents, base)) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    if (!hasAgentName(agents, candidate)) return candidate;
  }

  while (true) {
    const candidate = normalizeAgentName(`${base}-${pickName()}`);
    if (!hasAgentName(agents, candidate)) return candidate;
  }
}

function formatAgents(agents: Map<string, SpawnedAgent>): string {
  if (agents.size === 0) return "No spawned agents.";
  return [...agents.values()]
    .map((agent) => `- ${agent.name}${agent.task ? `: ${agent.task}` : ""}`)
    .join("\n");
}

function readReports(agent: SpawnedAgent): ParentReport[] {
  if (!existsSync(agent.reportFile)) return [];
  return readFileSync(agent.reportFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ParentReport];
      } catch {
        return [];
      }
    });
}

function formatReports(reports: ParentReport[]): string {
  if (reports.length === 0) return "No report returned.";
  return reports
    .map((report) => {
      if (report.report !== undefined) return JSON.stringify(report.report, null, 2);
      if (report.json !== undefined) return JSON.stringify(report.json, null, 2);
      if (report.text) return report.text;
      return JSON.stringify(report, null, 2);
    })
    .join("\n\n");
}

function withReportRequest(task: string, reportKeys?: string[], reportInstructions?: string): string {
  if (!reportKeys?.length && !reportInstructions?.trim()) return task;
  const lines = [
    task,
    "",
    "[report to parent]",
    "When you have a result, call the report_to_parent tool so the main agent can receive a structured report.",
  ];
  if (reportKeys?.length) {
    lines.push(`The report JSON object must use these keys: ${reportKeys.join(", ")}.`);
    lines.push("Use null or a concise explanation for keys that do not apply.");
  }
  if (reportInstructions?.trim()) lines.push(reportInstructions.trim());
  return lines.join("\n");
}

// use the LLM to extract agent name + task from natural language
async function parseWithLLM(
  input: string,
  piBin: string,
  pi: ExtensionAPI,
): Promise<{ name: string; prompt: string }> {
  if (!input) return { name: pickName(), prompt: "" };

  const systemMsg = [
    "Extract and reinterpret the instruction below into two things:",
    "1) name: a short single-word identifier for the agent (3-12 chars)",
    "2) task: what the subagent should DO, rewritten to be clear and concise",
    "",
    "Important: phrases like 'create an agent that X' / 'spawn an agent that X' / 'make an agent that X'",
    "mean the subagent's job IS X. Strip the meta-layer: translate 'a agent that says hi' -> just 'Say hi'.",
    "The subagent is already created — its task is the action it performs, not creating anything.",
    "",
    "If no name is explicitly given, pick a short memorable single word.",
    "If the input is only a name (no task/prompt), set task to empty string.",
    "Return ONLY a JSON object like {\"name\":\"bob\",\"task\":\"build auth module\"}.",
    "No markdown, no code fences, no explanation.",
  ].join("\n");

  try {
    const result = await pi.exec(piBin, [
      "-p", "--no-session",
      "--no-context-files", "--no-extensions",
      "--model", "deepseek/deepseek-v4-flash",
      "--thinking", "off",
      "--system-prompt", systemMsg,
      input,
    ]);

    if (result.code === 0) {
      const text = result.stdout.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          name: String(parsed.name || pickName())
            .replace(/\s+/g, "-").slice(0, 32),
          prompt: String(parsed.task || parsed.prompt || "").trim(),
        };
      }
    }
  } catch {
    // LLM call failed — fall through to simple fallback
  }

  // fallback: first word as name, rest as prompt
  const parts = input.split(/\s+/);
  const first = parts[0]!;
  return {
    name: first.length >= 3 ? first : pickName(),
    prompt: parts.slice(1).join(" "),
  };
}

export default function (pi: ExtensionAPI) {
  const spawnedAgents = new Map<string, SpawnedAgent>();
  let mainPaneId = process.env.TMUX_PANE;
  let firstSubagentSplitArg: "-h" | "-v" | undefined;

  // Future reference: focus/click auto-resize was prototyped with a tmux
  // after-select-pane hook and a generated resize script. Disabled for now
  // because pane layout should remain stable: main pane stays at 60%, spawned
  // agents share the remaining 40%.

  function oppositeSplitArg(splitArg: "-h" | "-v"): "-h" | "-v" {
    return splitArg === "-h" ? "-v" : "-h";
  }

  async function paneExists(paneId: string): Promise<boolean> {
    const result = await pi.exec("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"]);
    return result.code === 0;
  }

  async function getSpawnLayout(defaultSplitArg: "-h" | "-v"): Promise<{
    targetPaneId: string;
    splitArg: "-h" | "-v";
    percent: string;
  }> {
    const liveAgents: SpawnedAgent[] = [];
    for (const agent of spawnedAgents.values()) {
      if (await paneExists(agent.paneId)) liveAgents.push(agent);
      else spawnedAgents.delete(agent.name);
    }

    if (liveAgents.length === 0) {
      firstSubagentSplitArg = defaultSplitArg;
      if (!mainPaneId || !(await paneExists(mainPaneId))) {
        const current = await pi.exec("tmux", ["display-message", "-p", "#{pane_id}"]);
        if (current.code !== 0) throw new Error("Failed to resolve main tmux pane");
        mainPaneId = current.stdout.trim();
      }
      return { targetPaneId: mainPaneId, splitArg: defaultSplitArg, percent: "40" };
    }

    return {
      targetPaneId: liveAgents[0]!.paneId,
      splitArg: oppositeSplitArg(firstSubagentSplitArg ?? liveAgents[0]!.splitArg),
      percent: "50",
    };
  }

  async function killAgent(name: string): Promise<{ agent: SpawnedAgent; wasRunning: boolean }> {
    const agent = findAgent(spawnedAgents, name);
    if (!agent) {
      throw new Error(`Unknown spawned agent "${name}".\n${formatAgents(spawnedAgents)}`);
    }

    const pane = await pi.exec("tmux", ["display-message", "-p", "-t", agent.paneId, "#{pane_id}"]);
    const wasRunning = pane.code === 0;
    if (wasRunning) {
      const killed = await pi.exec("tmux", ["kill-pane", "-t", agent.paneId]);
      if (killed.code !== 0) throw new Error(`Failed to kill ${agent.name}: ${killed.stderr}`);
    }

    await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
    spawnedAgents.delete(agent.name);
    if (spawnedAgents.size === 0) firstSubagentSplitArg = undefined;
    return { agent, wasRunning };
  }

  async function sendToAgent(
    name: string,
    task: string,
    ctx: ExtensionContext,
    options: { wait?: boolean; reportKeys?: string[]; reportInstructions?: string } = {},
  ): Promise<{ agent: SpawnedAgent; reports: ParentReport[] }> {
    const agent = findAgent(spawnedAgents, name);
    if (!agent) {
      throw new Error(`Unknown spawned agent "${name}".\n${formatAgents(spawnedAgents)}`);
    }

    const pane = await pi.exec("tmux", ["display-message", "-p", "-t", agent.paneId, "#{pane_id}"]);
    if (pane.code !== 0) {
      spawnedAgents.delete(agent.name);
      throw new Error(`Agent "${agent.name}" pane is gone (${agent.paneId})`);
    }

    const wait = options.wait ?? true;
    const beforeReportCount = readReports(agent).length;
    const taskToSend = withReportRequest(task, options.reportKeys, options.reportInstructions);
    if (wait) {
      const lock = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
      if (lock.code !== 0) throw new Error(`Failed to lock wait channel: ${lock.stderr}`);
    }

    const literal = await pi.exec("tmux", ["send-keys", "-t", agent.paneId, "-l", taskToSend]);
    if (literal.code !== 0) {
      if (wait) await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      throw new Error(`Failed to send task to ${agent.name}: ${literal.stderr}`);
    }

    const enter = await pi.exec("tmux", ["send-keys", "-t", agent.paneId, "Enter"]);
    if (enter.code !== 0) {
      if (wait) await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      throw new Error(`Failed to submit task to ${agent.name}: ${enter.stderr}`);
    }

    if (wait) {
      const done = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      if (done.code !== 0) throw new Error(`Failed waiting for ${agent.name}: ${done.stderr}`);
    }

    agent.task = task;
    return { agent, reports: readReports(agent).slice(beforeReportCount) };
  }

  async function spawnParsedAgent(
    name: string,
    prompt: string,
    ctx: ExtensionContext,
    options: { reportKeys?: string[]; reportInstructions?: string } = {},
  ): Promise<{ agent: SpawnedAgent; direction: string; reports: ParentReport[]; requestedName: string }> {
    const requestedName = name;
    name = uniqueAgentName(spawnedAgents, name);

    const whichPi = await pi.exec("which", ["pi"]);
    const whichNode = await pi.exec("which", ["node"]);
    if (whichPi.code !== 0 || whichNode.code !== 0) throw new Error("pi or node not found on PATH");

    const piBin = whichPi.stdout.trim();
    const nodeDir = join(whichNode.stdout.trim(), "..");
    const cargoDir = join(homedir(), ".cargo", "bin");

    const dims = await pi.exec("tmux", [
      "display-message",
      "-p",
      "#{window_height}:#{window_width}:#{window_cell_height}:#{window_cell_width}",
    ]);
    if (dims.code !== 0) throw new Error("Not running inside tmux");

    const parts = dims.stdout.trim().split(":");
    const height = parseInt(parts[0], 10);
    const width = parseInt(parts[1], 10);
    const cellH = parseInt(parts[2], 10);
    const cellW = parseInt(parts[3], 10);
    if (isNaN(height) || isNaN(width) || isNaN(cellH) || isNaN(cellW)) {
      throw new Error("Failed to parse tmux window dimensions");
    }

    const pixelHeight = height * cellH;
    const pixelWidth = width * cellW;
    const splitArg = pixelHeight > pixelWidth ? "-v" : "-h";
    const direction = pixelHeight > pixelWidth ? "below" : "right";

    const configDir = join(tmpdir(), `pi-spawn-config-${Date.now()}`);
    mkdirSync(configDir, { recursive: true });

    const agentDir = join(homedir(), ".pi", "agent");
    const agentBinDir = join(agentDir, "bin");
    const configBinDir = join(configDir, "bin");
    mkdirSync(configBinDir, { recursive: true });
    for (const tool of ["fd", "rg"]) {
      const found = await pi.exec("which", [tool]);
      const src = found.code === 0 ? found.stdout.trim() : "";
      if (src && existsSync(src)) {
        const dest = join(configBinDir, tool);
        copyFileSync(src, dest);
        chmodSync(dest, 0o755);
      }
    }
    for (const file of ["settings.json", "auth.json"]) {
      const src = join(agentDir, file);
      if (existsSync(src)) copyFileSync(src, join(configDir, file));
    }

    const settingsFile = join(configDir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    settings.quietStartup = true;

    const extDir = join(configDir, "extensions");
    mkdirSync(extDir, { recursive: true });
    const signalExtPath = join(extDir, "spawn-signal.ts");
    const reportFile = join(configDir, "spawn-reports.jsonl");
    writeFileSync(signalExtPath, [
      'import { appendFileSync } from "node:fs";',
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "export default function (pi: ExtensionAPI) {",
      "  const agentName = process.env.PI_SPAWN_AGENT_NAME || 'subagent';",
      "  const reportFile = process.env.PI_SPAWN_REPORT_FILE;",
      "  let toolReportsThisTurn = 0;",
      "  function appendReport(entry: Record<string, unknown>) {",
      "    if (!reportFile) return;",
      "    appendFileSync(reportFile, JSON.stringify({ agentName, timestamp: Date.now(), ...entry }) + '\\n');",
      "  }",
      "  function extractJson(text: string): unknown | undefined {",
      "    const trimmed = text.trim();",
      "    const fenced = trimmed.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);",
      "    const candidates = [fenced?.[1], trimmed, trimmed.match(/\\{[\\s\\S]*\\}/)?.[0]].filter((v): v is string => typeof v === 'string');",
      "    for (const candidate of candidates) {",
      "      try { return JSON.parse(candidate); } catch {}",
      "    }",
      "    return undefined;",
      "  }",
      '  pi.on("session_start", async (_event, ctx) => {',
      "    if (!ctx.hasUI) return;",
      "    ctx.ui.setTitle(`pi - ${agentName}`);",
      '    ctx.ui.setHeader((_tui, theme) => ({',
      "      invalidate() {},",
      "      render(_width: number): string[] {",
      '        return [theme.fg("accent", `> ${agentName}`)];',
      "      },",
      "    }));",
      "  });",
      "  pi.registerTool({",
      "    name: 'report_to_parent',",
      "    label: 'Report To Parent',",
      "    description: 'Send a structured JSON report back to the parent/main agent that spawned this pane.',",
      "    promptSnippet: 'Report structured JSON back to the parent/main agent',",
      "    parameters: {",
      "      type: 'object',",
      "      properties: {",
      "        report: { type: 'object', description: 'JSON report object for the parent/main agent', additionalProperties: true },",
      "        note: { type: 'string', description: 'Optional short note about this report' },",
      "      },",
      "      required: ['report'],",
      "      additionalProperties: false,",
      "    } as any,",
      "    async execute(_toolCallId, params) {",
      "      toolReportsThisTurn++;",
      "      appendReport({ type: 'tool_report', report: params.report, note: params.note });",
      "      return { content: [{ type: 'text', text: 'Report sent to parent.' }] };",
      "    },",
      "  });",
      "  async function release() {",
      '    const id = process.env.PI_SPAWN_SIGNAL_ID;',
      "    if (!id) return;",
      '    await pi.exec("tmux", ["wait-for", "-U", id]);',
      '    await pi.exec("tmux", ["wait-for", "-S", id]);',
      "  }",
      '  pi.on("agent_end", async (event) => {',
      "    if (toolReportsThisTurn === 0) {",
      "      let text = '';",
      "      for (let i = event.messages.length - 1; i >= 0; i--) {",
      "        const message = event.messages[i];",
      "        if (message?.role !== 'assistant') continue;",
      "        const part = message.content.find((part: any) => part.type === 'text') as { text?: string } | undefined;",
      "        text = part?.text || '';",
      "        break;",
      "      }",
      "      if (text) appendReport({ type: 'agent_end', text, json: extractJson(text) });",
      "    }",
      "    toolReportsThisTurn = 0;",
      "    await release();",
      "  });",
      '  pi.on("session_shutdown", release);',
      "}",
      "",
    ].join("\n"));
    const exts = Array.isArray(settings.extensions)
      ? settings.extensions.filter((ext): ext is string => typeof ext === "string")
      : [];
    settings.extensions = [...new Set([...exts, signalExtPath])];
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

    const signalId = `pi-spawn-idle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const task = withReportRequest(prompt, options.reportKeys, options.reportInstructions);
    const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "";
    const contextualized = task
      ? ["[context from parent]", `parent session: ${sessionFile}`, `cwd: ${ctx.cwd}`, `agent name: ${name}`, "", task].join("\n")
      : "";

    const shellParts = [
      `export PATH=${shellQuote(nodeDir)}:${shellQuote(cargoDir)}:${shellQuote(agentBinDir)}:$PATH`,
      `export PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
      `export PI_SPAWN_SIGNAL_ID=${shellQuote(signalId)}`,
      `export PI_SPAWN_AGENT_NAME=${shellQuote(name)}`,
      `export PI_SPAWN_REPORT_FILE=${shellQuote(reportFile)}`,
      `trap 'tmux wait-for -U "$PI_SPAWN_SIGNAL_ID" 2>/dev/null || true' EXIT`,
      task
        ? `${shellQuote(piBin)} --model deepseek/deepseek-v4-flash --thinking off ${shellQuote(contextualized)}`
        : `${shellQuote(piBin)} --model deepseek/deepseek-v4-flash --thinking off`,
    ];
    const shellCmd = shellParts.join("; ");

    if (task) {
      const lock = await pi.exec("tmux", ["wait-for", "-L", signalId]);
      if (lock.code !== 0) throw new Error(`Failed to lock tmux wait channel: ${lock.stderr}`);
    }

    const layout = await getSpawnLayout(splitArg);
    const result = await pi.exec("tmux", [
      "split-window", "-t", layout.targetPaneId, "-P", "-F", "#{pane_id}",
      layout.splitArg, "-p", layout.percent,
      shellCmd,
    ]);
    if (result.code !== 0) {
      if (task) await pi.exec("tmux", ["wait-for", "-U", signalId]);
      throw new Error(`Failed to spawn pane: ${result.stderr || "unknown error"}`);
    }

    const paneId = result.stdout.trim();
    const agent: SpawnedAgent = { name, paneId, signalId, task: prompt, configDir, reportFile, splitArg: layout.splitArg, createdAt: Date.now() };
    spawnedAgents.set(name, agent);
    await pi.exec("tmux", ["select-pane", "-t", paneId, "-T", name]);

    let reports: ParentReport[] = [];
    if (task) {
      const wait = await pi.exec("tmux", ["wait-for", "-L", signalId]);
      await pi.exec("tmux", ["wait-for", "-U", signalId]);
      if (wait.code !== 0) throw new Error(`Failed while waiting for agent "${name}": ${wait.stderr}`);
      reports = readReports(agent);
    }

    return { agent, direction, reports, requestedName };
  }

  pi.registerTool({
    name: "kill_spawned_agent",
    label: "Kill Spawned Agent",
    description: "Terminate a named /spawn tmux subagent and remove it from the known spawned-agent list.",
    promptSnippet: "Kill a named /spawn tmux subagent pane",
    promptGuidelines: [
      "Use kill_spawned_agent when the user asks to kill, stop, close, terminate, or remove a named spawned agent.",
      "Use list_spawned_agents first if you need to know which spawned agents exist.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Spawned agent name, for example bob" },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const { agent, wasRunning } = await killAgent(params.name);
      return {
        content: [{ type: "text", text: `${wasRunning ? "Killed" : "Removed stale"} spawned agent ${agent.name}.` }],
        details: { agent, wasRunning },
      };
    },
  });

  pi.registerTool({
    name: "tell_spawned_agent",
    label: "Tell Spawned Agent",
    description: "Send a follow-up task to an existing /spawn tmux subagent by name, preserving that subagent's Pi session/context.",
    promptSnippet: "Send a task to an existing named /spawn subagent in its tmux pane",
    promptGuidelines: [
      "Use tell_spawned_agent when the user asks to tell, ask, or delegate work to a named spawned agent such as bob.",
      "Set reportKeys when you want the spawned agent to report structured JSON back to you with keys you choose.",
      "Use list_spawned_agents first if you need to know which spawned agents exist.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Spawned agent name, for example bob" },
        task: { type: "string", description: "Follow-up instruction to send to that agent" },
        reportKeys: {
          type: "array",
          items: { type: "string" },
          description: "Optional JSON report keys the subagent should send back to the main agent, chosen by the main agent",
        },
        reportInstructions: {
          type: "string",
          description: "Optional extra instructions for the subagent's structured report",
        },
      },
      required: ["name", "task"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agent, reports } = await sendToAgent(params.name, params.task, ctx, {
        wait: true,
        reportKeys: Array.isArray(params.reportKeys) ? params.reportKeys : undefined,
        reportInstructions: typeof params.reportInstructions === "string" ? params.reportInstructions : undefined,
      });
      return {
        content: [{ type: "text", text: `Sent to ${agent.name} and waited for completion.\n\nReport:\n${formatReports(reports)}` }],
        details: { agent, reports },
      };
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn a new named Pi subagent in a tmux pane. This is the tool equivalent of /spawn and preserves the /spawn command behavior.",
    promptSnippet: "Spawn a named Pi subagent in a tmux pane for delegated work",
    promptGuidelines: [
      "Use spawn_agent when the user asks in plain text to spawn, create, or start a named agent/subagent.",
      "For requests like 'spawn bob and ask about his model', set name to 'bob' and task to 'Ask/report what model you are using.'.",
      "spawn_agent starts the tmux subagent immediately; /spawn remains available as a manual slash command.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the spawned agent, for example bob" },
        task: { type: "string", description: "Optional initial task for the spawned agent" },
        reportKeys: {
          type: "array",
          items: { type: "string" },
          description: "Optional JSON report keys the subagent should send back to the main agent",
        },
        reportInstructions: {
          type: "string",
          description: "Optional extra instructions for the subagent's structured report",
        },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = String(params.name || "").trim();
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!name) throw new Error("spawn_agent requires a name");

      const { agent, direction, reports, requestedName } = await spawnParsedAgent(name, task, ctx, {
        reportKeys: Array.isArray(params.reportKeys) ? params.reportKeys : undefined,
        reportInstructions: typeof params.reportInstructions === "string" ? params.reportInstructions : undefined,
      });
      return {
        content: [{ type: "text", text: `Spawned ${agent.name} ${direction}${agent.name !== requestedName ? ` (requested ${requestedName}; renamed to avoid collision)` : ""}.${task ? `\n\nReport:\n${formatReports(reports)}` : ""}` }],
        details: { agent, direction, reports, requestedName },
      };
    },
  });

  pi.registerTool({
    name: "list_spawned_agents",
    label: "List Spawned Agents",
    description: "List currently known /spawn tmux subagents.",
    promptSnippet: "List named /spawn tmux subagents available for follow-up tasks",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      return {
        content: [{ type: "text", text: formatAgents(spawnedAgents) }],
        details: { agents: [...spawnedAgents.values()] },
      };
    },
  });

  pi.on("before_agent_start", (event) => {
    const spawnedContext = spawnedAgents.size > 0
      ? `\n\nSpawned tmux subagents available for delegation:\n${formatAgents(spawnedAgents)}\nWhen the user says something like "tell bob to ...", call tell_spawned_agent with name "bob" and the requested task. If you need a structured report back from the subagent, set reportKeys to the JSON keys you want in its report. If the user asks to stop/kill/close a spawned agent, call kill_spawned_agent.`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\nYou can spawn new tmux subagents with the spawn_agent tool when the user asks in plain text to spawn/create/start an agent. You can kill them with kill_spawned_agent.${spawnedContext}`,
    };
  });

  pi.on("input", async (event, ctx) => {
    const match = event.text.match(/^\s*(?:tell|ask)\s+([A-Za-z0-9_.-]+)\s+to\s+([\s\S]+)$/i);
    if (!match || !findAgent(spawnedAgents, match[1]!)) return { action: "continue" };

    const name = match[1]!;
    const task = match[2]!.trim();
    if (!task) return { action: "continue" };

    try {
      ctx.ui.notify(`Sending to ${name}...`, "info");
      const { agent } = await sendToAgent(name, task, ctx, { wait: true });
      ctx.ui.notify(`Agent "${agent.name}" finished`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.registerCommand("agents", {
    description: "List spawned tmux agents",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatAgents(spawnedAgents), "info");
    },
  });

  pi.registerCommand("kill-agent", {
    description: "Kill a spawned tmux agent: /kill-agent bob",
    handler: async (args, ctx) => {
      const name = (args as string).trim();
      if (!name) {
        ctx.ui.notify("Usage: /kill-agent <agent>", "error");
        return;
      }
      try {
        const { agent, wasRunning } = await killAgent(name);
        ctx.ui.notify(`${wasRunning ? "Killed" : "Removed stale"} agent "${agent.name}"`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("tell", {
    description: "Send a follow-up task to a spawned agent: /tell bob to say hi",
    handler: async (args, ctx) => {
      const text = (args as string).trim();
      const match = text.match(/^([A-Za-z0-9_.-]+)(?:\s+to)?\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("Usage: /tell <agent> to <task>", "error");
        return;
      }
      try {
        const { agent } = await sendToAgent(match[1]!, match[2]!.trim(), ctx, { wait: true });
        ctx.ui.notify(`Agent "${agent.name}" finished`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("spawn", {
    description: "Spawn a named pi session in a tmux pane (below if tall, right if wide)",
    handler: async (args, ctx) => {
      const rawInput = (args as string).trim();

      // resolve pi's absolute path and its node binary directory early
      // so we can use the LLM for natural-language parsing
      const whichPi = await pi.exec("which", ["pi"]);
      const whichNode = await pi.exec("which", ["node"]);
      if (whichPi.code !== 0 || whichNode.code !== 0) {
        ctx.ui.notify("pi or node not found on PATH", "error");
        return;
      }
      const piBin = whichPi.stdout.trim();
      const nodeDir = join(whichNode.stdout.trim(), "..");
      const cargoDir = join(homedir(), ".cargo", "bin");

      // use the LLM to parse name + task from the user's natural language
      ctx.ui.notify("Parsing...", "info");
      const parsed = await parseWithLLM(rawInput, piBin, pi);
      const requestedName = parsed.name;
      const name = uniqueAgentName(spawnedAgents, requestedName);
      const prompt = parsed.prompt;

      // Get current tmux window dimensions in characters and cell pixel sizes
      const dims = await pi.exec("tmux", [
        "display-message",
        "-p",
        "#{window_height}:#{window_width}:#{window_cell_height}:#{window_cell_width}",
      ]);

      if (dims.code !== 0) {
        ctx.ui.notify("Not running inside tmux", "error");
        return;
      }

      const parts = dims.stdout.trim().split(":");
      const height = parseInt(parts[0], 10);
      const width = parseInt(parts[1], 10);
      const cellH = parseInt(parts[2], 10);
      const cellW = parseInt(parts[3], 10);

      if (isNaN(height) || isNaN(width) || isNaN(cellH) || isNaN(cellW)) {
        ctx.ui.notify("Failed to parse tmux window dimensions", "error");
        return;
      }

      // compare visual pixel dimensions, not raw char counts
      const pixelHeight = height * cellH;
      const pixelWidth = width * cellW;
      const splitArg = pixelHeight > pixelWidth ? "-v" : "-h";
      const direction = pixelHeight > pixelWidth ? "below" : "right";

      // copy the user's real pi config (settings + auth) into a temp dir and
      // add quietStartup so the spawned instance has credentials but no banner
      const configDir = join(tmpdir(), `pi-spawn-config-${Date.now()}`);
      mkdirSync(configDir, { recursive: true });

      const agentDir = join(homedir(), ".pi", "agent");
      const agentBinDir = join(agentDir, "bin");
      const configBinDir = join(configDir, "bin");
      mkdirSync(configBinDir, { recursive: true });
      for (const tool of ["fd", "rg"]) {
        const found = await pi.exec("which", [tool]);
        const src = found.code === 0 ? found.stdout.trim() : "";
        if (src && existsSync(src)) {
          const dest = join(configBinDir, tool);
          copyFileSync(src, dest);
          chmodSync(dest, 0o755);
        }
      }
      for (const file of ["settings.json", "auth.json"]) {
        const src = join(agentDir, file);
        if (existsSync(src)) {
          copyFileSync(src, join(configDir, file));
        }
      }

      const settingsFile = join(configDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsFile)) {
        settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      }
      settings.quietStartup = true;

      // write a signal extension so the subagent notifies us when idle.
      // It is auto-discovered from PI_CODING_AGENT_DIR/extensions and also
      // added by absolute path to avoid cwd-relative settings resolution.
      const extDir = join(configDir, "extensions");
      mkdirSync(extDir, { recursive: true });
      const signalExtPath = join(extDir, "spawn-signal.ts");
      const reportFile = join(configDir, "spawn-reports.jsonl");
      writeFileSync(signalExtPath, [
        'import { appendFileSync } from "node:fs";',
        'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
        "export default function (pi: ExtensionAPI) {",
        "  const agentName = process.env.PI_SPAWN_AGENT_NAME || 'subagent';",
        "  const reportFile = process.env.PI_SPAWN_REPORT_FILE;",
        "  let toolReportsThisTurn = 0;",
        "  function appendReport(entry: Record<string, unknown>) {",
        "    if (!reportFile) return;",
        "    appendFileSync(reportFile, JSON.stringify({ agentName, timestamp: Date.now(), ...entry }) + '\\n');",
        "  }",
        "  function extractJson(text: string): unknown | undefined {",
        "    const trimmed = text.trim();",
        "    const fenced = trimmed.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);",
        "    const candidates = [fenced?.[1], trimmed, trimmed.match(/\\{[\\s\\S]*\\}/)?.[0]].filter((v): v is string => typeof v === 'string');",
        "    for (const candidate of candidates) {",
        "      try { return JSON.parse(candidate); } catch {}",
        "    }",
        "    return undefined;",
        "  }",
        '  pi.on("session_start", async (_event, ctx) => {',
        "    if (!ctx.hasUI) return;",
        "    ctx.ui.setTitle(`pi - ${agentName}`);",
        '    ctx.ui.setHeader((_tui, theme) => ({',
        "      invalidate() {},",
        "      render(_width: number): string[] {",
        '        return [theme.fg("accent", `> ${agentName}`)];',
        "      },",
        "    }));",
        "  });",
        "  pi.registerTool({",
        "    name: 'report_to_parent',",
        "    label: 'Report To Parent',",
        "    description: 'Send a structured JSON report back to the parent/main agent that spawned this pane.',",
        "    promptSnippet: 'Report structured JSON back to the parent/main agent',",
        "    parameters: {",
        "      type: 'object',",
        "      properties: {",
        "        report: { type: 'object', description: 'JSON report object for the parent/main agent', additionalProperties: true },",
        "        note: { type: 'string', description: 'Optional short note about this report' },",
        "      },",
        "      required: ['report'],",
        "      additionalProperties: false,",
        "    } as any,",
        "    async execute(_toolCallId, params) {",
        "      toolReportsThisTurn++;",
        "      appendReport({ type: 'tool_report', report: params.report, note: params.note });",
        "      return { content: [{ type: 'text', text: 'Report sent to parent.' }] };",
        "    },",
        "  });",
        "  async function release() {",
        '    const id = process.env.PI_SPAWN_SIGNAL_ID;',
        "    if (!id) return;",
        '    await pi.exec("tmux", ["wait-for", "-U", id]);',
        '    await pi.exec("tmux", ["wait-for", "-S", id]);',
        "  }",
        '  pi.on("agent_end", async (event) => {',
        "    if (toolReportsThisTurn === 0) {",
        "      let text = '';",
        "      for (let i = event.messages.length - 1; i >= 0; i--) {",
        "        const message = event.messages[i];",
        "        if (message?.role !== 'assistant') continue;",
        "        const part = message.content.find((part: any) => part.type === 'text') as { text?: string } | undefined;",
        "        text = part?.text || '';",
        "        break;",
        "      }",
        "      if (text) appendReport({ type: 'agent_end', text, json: extractJson(text) });",
        "    }",
        "    toolReportsThisTurn = 0;",
        "    await release();",
        "  });",
        '  pi.on("session_shutdown", release);',
        "}",
        "",
      ].join("\n"));
      const exts = Array.isArray(settings.extensions)
        ? settings.extensions.filter((ext): ext is string => typeof ext === "string")
        : [];
      settings.extensions = [...new Set([...exts, signalExtPath])];

      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

      // build shell command with a signal for when the subagent becomes idle
      const signalId = `pi-spawn-idle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let shellCmd: string;
      if (prompt) {
        const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "";
        const cwd = ctx.cwd;
        const contextualized = [
          "[context from parent]",
          `parent session: ${sessionFile}`,
          `cwd: ${cwd}`,
          `agent name: ${name}`,
          "",
          prompt,
        ].join("\n");

        shellCmd = [
          `export PATH=${shellQuote(nodeDir)}:${shellQuote(cargoDir)}:${shellQuote(agentBinDir)}:$PATH`,
          `export PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
          `export PI_SPAWN_SIGNAL_ID=${shellQuote(signalId)}`,
          `export PI_SPAWN_AGENT_NAME=${shellQuote(name)}`,
          `export PI_SPAWN_REPORT_FILE=${shellQuote(reportFile)}`,
          `trap 'tmux wait-for -U "$PI_SPAWN_SIGNAL_ID" 2>/dev/null || true' EXIT`,
          `${shellQuote(piBin)} --model deepseek/deepseek-v4-flash --thinking off ${shellQuote(contextualized)}`,
        ].join("; ");
      } else {
        shellCmd = [
          `export PATH=${shellQuote(nodeDir)}:${shellQuote(cargoDir)}:${shellQuote(agentBinDir)}:$PATH`,
          `export PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
          `export PI_SPAWN_SIGNAL_ID=${shellQuote(signalId)}`,
          `export PI_SPAWN_AGENT_NAME=${shellQuote(name)}`,
          `export PI_SPAWN_REPORT_FILE=${shellQuote(reportFile)}`,
          `trap 'tmux wait-for -U "$PI_SPAWN_SIGNAL_ID" 2>/dev/null || true' EXIT`,
          `${shellQuote(piBin)} --model deepseek/deepseek-v4-flash --thinking off`,
        ].join("; ");
      }

      // Race-free block: pre-lock the channel before spawn. The injected
      // subagent extension unlocks it on agent_end; then this command's second
      // -L call returns and the parent can notify completion.
      if (prompt) {
        const lock = await pi.exec("tmux", ["wait-for", "-L", signalId]);
        if (lock.code !== 0) {
          ctx.ui.notify(`Failed to lock tmux wait channel: ${lock.stderr}`, "error");
          return;
        }
      }

      const layout = await getSpawnLayout(splitArg);
      const result = await pi.exec("tmux", [
        "split-window", "-t", layout.targetPaneId, "-P", "-F", "#{pane_id}",
        layout.splitArg, "-p", layout.percent,
        shellCmd,
      ]);

      if (result.code !== 0) {
        if (prompt) await pi.exec("tmux", ["wait-for", "-U", signalId]);
        ctx.ui.notify(
          `Failed to spawn pane: ${result.stderr || "unknown error"}`,
          "error",
        );
        return;
      }

      const paneId = result.stdout.trim();
      spawnedAgents.set(name, {
        name,
        paneId,
        signalId,
        task: prompt,
        configDir,
        reportFile,
        splitArg: layout.splitArg,
        createdAt: Date.now(),
      });

      // set the pane title so the name sticks to the top bar
      await pi.exec("tmux", [
        "select-pane", "-t", paneId, "-T", name,
      ]);

      const renamed = name !== requestedName ? ` (requested "${requestedName}"; renamed to avoid collision)` : "";
      const note = prompt
        ? `Spawned "${name}" ${direction}${renamed}\nTask Assigned: ${prompt}`
        : `Spawned "${name}" ${direction}${renamed}`;
      ctx.ui.notify(note, "info");

      // wait for the subagent to finish its initial task
      if (prompt) {
        const wait = await pi.exec("tmux", ["wait-for", "-L", signalId]);
        await pi.exec("tmux", ["wait-for", "-U", signalId]);
        if (wait.code === 0) {
          ctx.ui.notify(`Agent "${name}" finished`, "info");
        } else {
          ctx.ui.notify(`Failed while waiting for agent "${name}": ${wait.stderr}`, "error");
        }
      }
    },
  });
}
