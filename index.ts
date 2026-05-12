import { createHash } from "node:crypto";
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

const DEFAULT_FAST_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_STRONG_MODEL = "gpt5.5";
const DEFAULT_MODEL_SELECTION: SpawnModelSelection = "auto";

let nameIndex = 0;
function pickName(): string {
  const idx = nameIndex++ % NAME_POOL.length;
  const suffix = Math.floor(nameIndex / NAME_POOL.length);
  return suffix > 0 ? `${NAME_POOL[idx]}${suffix}` : NAME_POOL[idx]!;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type SpawnModelTier = "fast" | "strong";
type SpawnModelSelection = "auto" | "explicit";
type SpawnContextMode = "none" | "current" | "entry";

type SpawnModelConfig = {
  fastModel: string;
  strongModel: string;
  modelSelection: SpawnModelSelection;
};

type ParentReport = {
  type: string;
  agentName: string;
  timestamp: number;
  report?: unknown;
  note?: string;
  text?: string;
  json?: unknown;
};

type CompletedAgentNotice = {
  agentName: string;
  task: string;
  completedAt: number;
  reports: ParentReport[];
  error?: string;
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
  model?: string;
  modelTier?: SpawnModelTier;
  pendingTask?: string;
  pendingSince?: number;
  pendingReportOffset?: number;
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
    .map((agent) => `- ${agent.name}${agent.pendingTask ? " [running]" : ""}${agent.modelTier ? ` [${agent.modelTier}]` : ""}${agent.task ? `: ${agent.task}` : ""}`)
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

function formatCompletedNotices(notices: CompletedAgentNotice[]): string {
  if (notices.length === 0) return "";
  return notices
    .map((notice) => {
      const status = notice.error ? `failed: ${notice.error}` : "finished";
      return [
        `- ${notice.agentName} ${status}${notice.task ? `: ${notice.task}` : ""}`,
        notice.reports.length > 0 ? formatReports(notice.reports) : undefined,
      ].filter((line): line is string => !!line).join("\n");
    })
    .join("\n\n");
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function applySpawnConfig(settings: Record<string, unknown> | undefined, config: SpawnModelConfig): void {
  const section = settings?.tmuxSpawn;
  if (!section || typeof section !== "object" || Array.isArray(section)) return;
  const values = section as Record<string, unknown>;
  if (typeof values.fastModel === "string" && values.fastModel.trim()) config.fastModel = values.fastModel.trim();
  if (typeof values.strongModel === "string" && values.strongModel.trim()) config.strongModel = values.strongModel.trim();
  if (values.modelSelection === "auto" || values.modelSelection === "explicit") config.modelSelection = values.modelSelection;
}

function getSpawnModelConfig(ctx?: ExtensionContext): SpawnModelConfig {
  const config: SpawnModelConfig = { fastModel: DEFAULT_FAST_MODEL, strongModel: DEFAULT_STRONG_MODEL, modelSelection: DEFAULT_MODEL_SELECTION };
  applySpawnConfig(readJsonFile(join(homedir(), ".pi", "agent", "settings.json")), config);
  if (ctx?.cwd) applySpawnConfig(readJsonFile(join(ctx.cwd, ".pi", "settings.json")), config);
  if (process.env.PI_SPAWN_FAST_MODEL?.trim()) config.fastModel = process.env.PI_SPAWN_FAST_MODEL.trim();
  if (process.env.PI_SPAWN_STRONG_MODEL?.trim()) config.strongModel = process.env.PI_SPAWN_STRONG_MODEL.trim();
  if (process.env.PI_SPAWN_MODEL_SELECTION === "auto" || process.env.PI_SPAWN_MODEL_SELECTION === "explicit") {
    config.modelSelection = process.env.PI_SPAWN_MODEL_SELECTION;
  }
  return config;
}

function resolveSpawnModel(tier: SpawnModelTier, ctx?: ExtensionContext): string {
  const config = getSpawnModelConfig(ctx);
  return tier === "strong" ? config.strongModel : config.fastModel;
}

function explicitSpawnModelTier(text: string): SpawnModelTier | undefined {
  if (/\b(strong|gpt\s*-?\s*5(?:\.5)?|gpt5(?:\.5)?)\b/i.test(text)) return "strong";
  if (/\b(fast|quick|deepseek|v4\s*flash|flash)\b/i.test(text)) return "fast";
  return undefined;
}

function inferSpawnModelTier(text: string): SpawnModelTier {
  if (explicitSpawnModelTier(text)) return explicitSpawnModelTier(text)!;
  return /\b(complex|hard|difficult|research|analy[sz]e|design|architect|implement|code|debug|review|plan|refactor|security)\b/i.test(text)
    ? "strong"
    : "fast";
}

function formatSessionEntryForSpawn(entry: unknown): string {
  const value = entry as any;
  if (value?.type === "message") {
    return JSON.stringify({ id: value.id, role: value.message?.role, content: value.message?.content }, null, 2);
  }
  if (value?.type === "compaction" || value?.type === "branch_summary") {
    return JSON.stringify({ id: value.id, type: value.type, summary: value.summary }, null, 2);
  }
  if (value?.type === "custom_message") {
    return JSON.stringify({ id: value.id, type: value.type, customType: value.customType, content: value.content }, null, 2);
  }
  return JSON.stringify(value, null, 2);
}

function buildSpawnContext(ctx: ExtensionContext, mode: SpawnContextMode = "none", entryId?: string): string {
  if (mode === "none") return "";
  const leafId = mode === "entry" ? entryId?.trim() : ctx.sessionManager.getLeafId();
  if (!leafId) return "";
  if (!ctx.sessionManager.getEntry(leafId)) throw new Error(`Unknown context entry id "${leafId}"`);
  const branch = ctx.sessionManager.getBranch(leafId);
  return branch.map(formatSessionEntryForSpawn).join("\n\n");
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
      "--model", DEFAULT_FAST_MODEL,
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
  const loadedRegistryFiles = new Set<string>();
  const completedNotices: CompletedAgentNotice[] = [];
  let mainPaneId = process.env.TMUX_PANE;
  let spawnQueue: Promise<void> = Promise.resolve();
  let spawnSequence = 0;

  // Future reference: focus/click auto-resize was prototyped with a tmux
  // after-select-pane hook and a generated resize script. Disabled for now
  // because pane layout should remain stable: main pane stays at 60%, spawned
  // agents share the remaining 40%.

  function oppositeSplitArg(splitArg: "-h" | "-v"): "-h" | "-v" {
    return splitArg === "-h" ? "-v" : "-h";
  }

  function nextSpawnCreatedAt(): number {
    spawnSequence = (spawnSequence + 1) % 1000;
    return Date.now() * 1000 + spawnSequence;
  }

  function registryFileFor(ctx?: ExtensionContext): string {
    const key = ctx?.sessionManager?.getSessionFile?.() || `${ctx?.cwd || process.cwd()}:${mainPaneId || process.env.TMUX_PANE || process.pid}`;
    const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
    return join(tmpdir(), `pi-spawn-registry-${hash}.json`);
  }

  function isSpawnedAgent(value: unknown): value is SpawnedAgent {
    const agent = value as Partial<SpawnedAgent>;
    return typeof agent?.name === "string"
      && typeof agent.paneId === "string"
      && typeof agent.signalId === "string"
      && typeof agent.reportFile === "string"
      && typeof agent.configDir === "string"
      && (agent.splitArg === "-h" || agent.splitArg === "-v");
  }

  function loadRegistry(ctx?: ExtensionContext): void {
    const file = registryFileFor(ctx);
    if (loadedRegistryFiles.has(file)) return;
    loadedRegistryFiles.add(file);

    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        const agents = Array.isArray(parsed?.agents) ? parsed.agents : [];
        for (const agent of agents) {
          if (isSpawnedAgent(agent) && !spawnedAgents.has(agent.name)) spawnedAgents.set(agent.name, agent);
        }
      } catch {
        // Ignore corrupt/old registry files; session history can still recover agents.
      }
    }

    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return;
    try {
      for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        const message = entry?.message;
        if (entry?.type !== "message" || message?.role !== "toolResult") continue;
        const toolName = message.toolName;
        const agent = message.details?.agent;
        if (toolName === "spawn_agent" && isSpawnedAgent(agent) && !spawnedAgents.has(agent.name)) {
          spawnedAgents.set(agent.name, agent);
        }
        if (toolName === "kill_spawned_agent" && isSpawnedAgent(agent)) {
          spawnedAgents.delete(agent.name);
        }
      }
    } catch {
      // Session recovery is best effort.
    }
  }

  function saveRegistry(ctx?: ExtensionContext): void {
    const file = registryFileFor(ctx);
    loadedRegistryFiles.add(file);
    writeFileSync(file, JSON.stringify({ agents: [...spawnedAgents.values()] }, null, 2) + "\n");
  }

  async function paneExists(paneId: string): Promise<boolean> {
    const result = await pi.exec("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"]);
    return result.code === 0;
  }

  function withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = spawnQueue.then(fn, fn);
    spawnQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  type LiveSpawnPane = {
    paneId: string;
    name: string;
    splitArg: "-h" | "-v";
    width: number;
    height: number;
    left: number;
    top: number;
    createdAt?: number;
  };

  async function resolveMainPaneId(): Promise<string> {
    if (mainPaneId && await paneExists(mainPaneId)) return mainPaneId;
    const current = await pi.exec("tmux", ["display-message", "-p", "#{pane_id}"]);
    if (current.code !== 0) throw new Error("Failed to resolve main tmux pane");
    mainPaneId = current.stdout.trim();
    return mainPaneId;
  }

  async function listLiveSpawnPanes(): Promise<LiveSpawnPane[]> {
    const owner = await resolveMainPaneId();
    const listed = await pi.exec("tmux", [
      "list-panes",
      "-F",
      "#{pane_id}\t#{@pi_spawn_owner}\t#{@pi_spawn_agent_name}\t#{@pi_spawn_split_arg}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{@pi_spawn_created_at}",
    ]);
    if (listed.code !== 0) return [];

    const live = listed.stdout
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line): LiveSpawnPane[] => {
        const [paneId, paneOwner, name, splitArg, width, height, left, top, createdAtRaw] = line.split("\t");
        if (paneOwner !== owner || !paneId || !name || (splitArg !== "-h" && splitArg !== "-v")) return [];
        const registryCreatedAt = findAgent(spawnedAgents, name)?.createdAt;
        const optionCreatedAt = parseInt(createdAtRaw || "", 10);
        const createdAt = Number.isFinite(optionCreatedAt) ? optionCreatedAt : registryCreatedAt;
        return [{
          paneId,
          name,
          splitArg,
          width: parseInt(width || "0", 10),
          height: parseInt(height || "0", 10),
          left: parseInt(left || "0", 10),
          top: parseInt(top || "0", 10),
          createdAt,
        }];
      });

    return live;
  }

  async function markSpawnPane(agent: SpawnedAgent): Promise<void> {
    const owner = await resolveMainPaneId();
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_owner", owner]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_agent_name", agent.name]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_split_arg", agent.splitArg]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_signal_id", agent.signalId]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_report_file", agent.reportFile]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_config_dir", agent.configDir]);
    await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_created_at", String(agent.createdAt)]);
    if (agent.model) await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_model", agent.model]);
    if (agent.modelTier) await pi.exec("tmux", ["set-option", "-p", "-t", agent.paneId, "@pi_spawn_model_tier", agent.modelTier]);
  }

  function sortLivePanesByCreation(panes: LiveSpawnPane[]): LiveSpawnPane[] {
    return [...panes].sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER));
  }

  async function getSpawnLayout(defaultSplitArg: "-h" | "-v"): Promise<{
    targetPaneId: string;
    splitArg: "-h" | "-v";
    percent: string;
  }> {
    const livePanes = await listLiveSpawnPanes();

    if (livePanes.length === 0) {
      return { targetPaneId: await resolveMainPaneId(), splitArg: defaultSplitArg, percent: "40" };
    }

    const first = sortLivePanesByCreation(livePanes)[0]!;
    const target = [...livePanes].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0]!;
    return {
      targetPaneId: target.paneId,
      splitArg: oppositeSplitArg(first.splitArg),
      percent: "50",
    };
  }

  async function normalizeSpawnPaneSizes(): Promise<void> {
    const livePanes = await listLiveSpawnPanes();
    if (livePanes.length <= 1) return;

    const first = sortLivePanesByCreation(livePanes)[0]!;
    const splitArg = oppositeSplitArg(first.splitArg);
    const sorted = [...livePanes].sort((a, b) => splitArg === "-h" ? a.left - b.left : a.top - b.top);
    const total = sorted.reduce((sum, pane) => sum + (splitArg === "-h" ? pane.width : pane.height), 0);
    if (total <= 0) return;

    const base = Math.floor(total / sorted.length);
    const remainder = total % sorted.length;
    const sizeFlag = splitArg === "-h" ? "-x" : "-y";
    for (let i = 0; i < sorted.length; i++) {
      const size = base + (i < remainder ? 1 : 0);
      await pi.exec("tmux", ["resize-pane", "-t", sorted[i]!.paneId, sizeFlag, String(size)]);
    }
  }

  async function killAgent(name: string, ctx?: ExtensionContext): Promise<{ agent: SpawnedAgent; wasRunning: boolean }> {
    loadRegistry(ctx);
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
    await normalizeSpawnPaneSizes();
    saveRegistry(ctx);
    return { agent, wasRunning };
  }

  async function killAllAgents(ctx?: ExtensionContext): Promise<void> {
    for (const agent of [...spawnedAgents.values()]) {
      try {
        const pane = await pi.exec("tmux", ["display-message", "-p", "-t", agent.paneId, "#{pane_id}"]);
        if (pane.code === 0) await pi.exec("tmux", ["kill-pane", "-t", agent.paneId]);
        await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      } catch {
        // best effort during shutdown
      } finally {
        spawnedAgents.delete(agent.name);
      }
    }
    saveRegistry(ctx);
  }

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "quit" || event.reason === "new") await killAllAgents(ctx);
  });

  async function sendToAgent(
    name: string,
    task: string,
    ctx: ExtensionContext,
    options: { wait?: boolean; reportKeys?: string[]; reportInstructions?: string } = {},
  ): Promise<{ agent: SpawnedAgent; reports: ParentReport[] }> {
    loadRegistry(ctx);
    const agent = findAgent(spawnedAgents, name);
    if (!agent) {
      throw new Error(`Unknown spawned agent "${name}".\n${formatAgents(spawnedAgents)}`);
    }

    const wait = options.wait ?? false;
    if (agent.pendingTask && !wait) {
      throw new Error(`Agent "${agent.name}" is already running: ${agent.pendingTask}. Use wait_for_spawned_agent or collect_spawned_reports before sending another task.`);
    }

    const pane = await pi.exec("tmux", ["display-message", "-p", "-t", agent.paneId, "#{pane_id}"]);
    if (pane.code !== 0) {
      throw new Error(`Agent "${agent.name}" pane is gone (${agent.paneId}); reports can still be read with collect_spawned_reports.`);
    }

    const beforeReportCount = readReports(agent).length;
    const taskToSend = withReportRequest(task, options.reportKeys, options.reportInstructions);
    const lock = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
    if (lock.code !== 0) throw new Error(`Failed to lock wait channel: ${lock.stderr}`);

    const literal = await pi.exec("tmux", ["send-keys", "-t", agent.paneId, "-l", taskToSend]);
    if (literal.code !== 0) {
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      throw new Error(`Failed to send task to ${agent.name}: ${literal.stderr}`);
    }

    const enter = await pi.exec("tmux", ["send-keys", "-t", agent.paneId, "Enter"]);
    if (enter.code !== 0) {
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      throw new Error(`Failed to submit task to ${agent.name}: ${enter.stderr}`);
    }

    agent.task = task;
    agent.pendingTask = task;
    agent.pendingSince = Date.now();
    agent.pendingReportOffset = beforeReportCount;

    if (wait) {
      const done = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      if (done.code !== 0) throw new Error(`Failed waiting for ${agent.name}: ${done.stderr}`);
      const reports = readReports(agent).slice(beforeReportCount);
      delete agent.pendingTask;
      delete agent.pendingSince;
      delete agent.pendingReportOffset;
      saveRegistry(ctx);
      return { agent, reports };
    }

    saveRegistry(ctx);
    watchAgentCompletion(agent, task, beforeReportCount, ctx);
    return { agent, reports: [] };
  }

  async function waitForAgent(name: string, ctx?: ExtensionContext): Promise<{ agent: SpawnedAgent; reports: ParentReport[]; wasPending: boolean }> {
    loadRegistry(ctx);
    const agent = findAgent(spawnedAgents, name);
    if (!agent) {
      throw new Error(`Unknown spawned agent "${name}".\n${formatAgents(spawnedAgents)}`);
    }

    const pane = await pi.exec("tmux", ["display-message", "-p", "-t", agent.paneId, "#{pane_id}"]);
    const offset = agent.pendingReportOffset ?? 0;
    const wasPending = agent.pendingTask !== undefined;
    if (wasPending && pane.code === 0) {
      const done = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      if (done.code !== 0) throw new Error(`Failed waiting for ${agent.name}: ${done.stderr}`);
    }

    const reports = readReports(agent).slice(offset);
    if (wasPending && pane.code !== 0 && reports.length === 0) {
      spawnedAgents.delete(agent.name);
      saveRegistry(ctx);
      throw new Error(`Agent "${agent.name}" pane is gone (${agent.paneId}) and no report was found.`);
    }
    delete agent.pendingTask;
    delete agent.pendingSince;
    delete agent.pendingReportOffset;
    saveRegistry(ctx);
    return { agent, reports, wasPending };
  }

  function collectReports(name?: string, ctx?: ExtensionContext): { agents: SpawnedAgent[]; reports: ParentReport[] } {
    loadRegistry(ctx);
    const agents = name ? [findAgent(spawnedAgents, name)].filter((agent): agent is SpawnedAgent => !!agent) : [...spawnedAgents.values()];
    if (name && agents.length === 0) throw new Error(`Unknown spawned agent "${name}".\n${formatAgents(spawnedAgents)}`);
    return { agents, reports: agents.flatMap((agent) => readReports(agent)) };
  }

  function rememberCompletion(notice: CompletedAgentNotice): void {
    completedNotices.push(notice);
    completedNotices.splice(0, Math.max(0, completedNotices.length - 20));
  }

  function sendCompletionToMainAgent(notice: CompletedAgentNotice, ctx: ExtensionContext): void {
    const resultText = notice.error
      ? `The spawned agent failed: ${notice.error}`
      : `The spawned agent finished.\n\nReport:\n${formatReports(notice.reports)}`;
    const prompt = [
      "[spawned-agent completion]",
      `Agent: ${notice.agentName}`,
      `Task: ${notice.task || "(no task)"}`,
      resultText,
      "",
      "Parse this spawned-agent result and reply to the user as the main interface. Be concise. If the result answers an earlier user request, provide the answer now; do not merely say that the agent finished.",
    ].join("\n");
    try {
      pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } catch {
      // If a non-interactive/runtime mode rejects synthetic user messages, the
      // completion still remains available in completedNotices for the next turn.
    }
  }

  function watchAgentCompletion(agent: SpawnedAgent, task: string, reportOffset: number, ctx: ExtensionContext): void {
    void (async () => {
      let reports: ParentReport[] = [];
      try {
        const done = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
        await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
        if (done.code !== 0) throw new Error(done.stderr || `Failed waiting for ${agent.name}`);
        reports = readReports(agent).slice(reportOffset);
        if (agent.pendingReportOffset === reportOffset) {
          delete agent.pendingTask;
          delete agent.pendingSince;
          delete agent.pendingReportOffset;
        }
        const notice = { agentName: agent.name, task, completedAt: Date.now(), reports };
        rememberCompletion(notice);
        saveRegistry(ctx);
        ctx.ui.notify(`Agent "${agent.name}" finished${reports.length > 0 ? " with a report" : ""}. Asking main agent to parse it...`, "info");
        sendCompletionToMainAgent(notice, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notice = { agentName: agent.name, task, completedAt: Date.now(), reports, error: message };
        rememberCompletion(notice);
        saveRegistry(ctx);
        ctx.ui.notify(`Agent "${agent.name}" failed: ${message}. Asking main agent to handle it...`, "error");
        sendCompletionToMainAgent(notice, ctx);
      }
    })();
  }

  async function spawnParsedAgent(
    name: string,
    prompt: string,
    ctx: ExtensionContext,
    options: { wait?: boolean; reportKeys?: string[]; reportInstructions?: string; modelTier?: SpawnModelTier; contextMode?: SpawnContextMode; contextEntryId?: string } = {},
  ): Promise<{ agent: SpawnedAgent; direction: string; reports: ParentReport[]; requestedName: string }> {
    loadRegistry(ctx);
    const spawned = await withSpawnLock(async () => {
    const requestedName = name;
    name = uniqueAgentName(spawnedAgents, name);

    const whichPi = await pi.exec("which", ["pi"]);
    const whichNode = await pi.exec("which", ["node"]);
    if (whichPi.code !== 0 || whichNode.code !== 0) throw new Error("pi or node not found on PATH");

    if (options.modelTier !== "fast" && options.modelTier !== "strong") {
      throw new Error("spawnParsedAgent requires an explicit model tier");
    }
    const piBin = whichPi.stdout.trim();
    const modelTier = options.modelTier;
    const spawnModel = resolveSpawnModel(modelTier, ctx);
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
      "    const { CustomEditor } = await import('@earendil-works/pi-coding-agent');",
      "    class PaneAwareEditor extends CustomEditor {",
      "      render(_width: number): string[] {",
      "        return [];",
      "      }",
      "    }",
      "    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PaneAwareEditor(tui, theme, keybindings));",
      "    ctx.ui.setStatus('spawn-agent-name', ctx.ui.theme.fg('accent', `> ${agentName}`));",
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
    const wait = options.wait ?? false;
    const task = withReportRequest(prompt, options.reportKeys, options.reportInstructions);
    const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "";
    const parentContext = buildSpawnContext(ctx, options.contextMode ?? "none", options.contextEntryId);
    const contextLines = ["[context from parent]", `parent session: ${sessionFile}`, `cwd: ${ctx.cwd}`, `agent name: ${name}`];
    if (parentContext) contextLines.push("", "[selected parent context tree]", parentContext);
    const contextualized = task
      ? [...contextLines, "", task].join("\n")
      : (parentContext ? contextLines.join("\n") : "");

    const shellParts = [
      `export PATH=${shellQuote(nodeDir)}:${shellQuote(cargoDir)}:${shellQuote(agentBinDir)}:$PATH`,
      `export PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
      `export PI_SPAWN_SIGNAL_ID=${shellQuote(signalId)}`,
      `export PI_SPAWN_AGENT_NAME=${shellQuote(name)}`,
      `export PI_SPAWN_REPORT_FILE=${shellQuote(reportFile)}`,
      `trap 'tmux wait-for -U "$PI_SPAWN_SIGNAL_ID" 2>/dev/null || true' EXIT`,
      task
        ? `${shellQuote(piBin)} --model ${shellQuote(spawnModel)} --thinking off ${shellQuote(contextualized)}`
        : `${shellQuote(piBin)} --model ${shellQuote(spawnModel)} --thinking off`,
    ];
    const shellCmd = shellParts.join("; ");

    if (task) {
      const lock = await pi.exec("tmux", ["wait-for", "-L", signalId]);
      if (lock.code !== 0) throw new Error(`Failed to lock tmux wait channel: ${lock.stderr}`);
    }

    const layout = await getSpawnLayout(splitArg);
    const direction = layout.splitArg === "-v" ? "below" : "right";
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
    const agent: SpawnedAgent = { name, paneId, signalId, task: prompt, configDir, reportFile, splitArg: layout.splitArg, createdAt: nextSpawnCreatedAt(), model: spawnModel, modelTier };
    if (task && !wait) {
      agent.pendingTask = prompt;
      agent.pendingSince = Date.now();
      agent.pendingReportOffset = 0;
    }
    spawnedAgents.set(name, agent);
    saveRegistry(ctx);
    await markSpawnPane(agent);
    await normalizeSpawnPaneSizes();
    await pi.exec("tmux", ["select-pane", "-t", paneId, "-T", name]);
    if (mainPaneId && await paneExists(mainPaneId)) {
      await pi.exec("tmux", ["select-pane", "-t", mainPaneId]);
    }

    saveRegistry(ctx);

    return { agent, direction, requestedName, task, wait };
    });

    const { agent, direction, requestedName, task, wait } = spawned;
    let reports: ParentReport[] = [];
    if (task && !wait) watchAgentCompletion(agent, agent.task, 0, ctx);
    if (task && wait) {
      const done = await pi.exec("tmux", ["wait-for", "-L", agent.signalId]);
      await pi.exec("tmux", ["wait-for", "-U", agent.signalId]);
      if (done.code !== 0) throw new Error(`Failed while waiting for agent "${agent.name}": ${done.stderr}`);
      reports = readReports(agent);
      delete agent.pendingTask;
      delete agent.pendingSince;
      delete agent.pendingReportOffset;
      saveRegistry(ctx);
    }

    return { agent, direction, reports, requestedName };
  }

  pi.registerTool({
    name: "kill_spawned_agent",
    label: "Kill Spawned Agent",
    description: "Terminate a named /spawn tmux subagent and remove it from the known spawned-agent list.",
    promptSnippet: "Kill a named /spawn tmux subagent pane",
    promptGuidelines: [
      "Use kill_spawned_agent when the user asks to despawn, kill, fire, nuke, stop, close, terminate, or remove a named spawned agent.",
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agent, wasRunning } = await killAgent(params.name, ctx);
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
      "Use tell_spawned_agent when the user asks to tell, ask, or delegate work to an existing named spawned agent such as bob.",
      "If the requested agent does not exist, use spawn_agent with that name and task instead.",
      "By default, tasks run in background and notify when complete. Set wait=true only when the current answer must include the result.",
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
        wait: {
          type: "boolean",
          description: "Whether to block until the subagent finishes this task. Defaults to false so the main agent stays responsive; set true only when the current answer depends on the result."
        },
      },
      required: ["name", "task"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const wait = typeof params.wait === "boolean" ? params.wait : false;
      const { agent, reports } = await sendToAgent(params.name, params.task, ctx, {
        wait,
        reportKeys: Array.isArray(params.reportKeys) ? params.reportKeys : undefined,
        reportInstructions: typeof params.reportInstructions === "string" ? params.reportInstructions : undefined,
      });
      return {
        content: [{ type: "text", text: wait
          ? `Sent to ${agent.name} and waited for completion.\n\nReport:\n${formatReports(reports)}`
          : `Sent to ${agent.name} in background. I will notify you when it finishes; use collect_spawned_reports later if you need the report.` }],
        details: { agent, reports, wait },
      };
    },
  });

  pi.registerTool({
    name: "wait_for_spawned_agent",
    label: "Wait For Spawned Agent",
    description: "Block until a spawned agent's current background task finishes, then return reports produced by that task.",
    promptSnippet: "Wait for a background spawned-agent task and read its report",
    promptGuidelines: [
      "Use wait_for_spawned_agent when a previous spawn_agent/tell_spawned_agent call used wait=false and its result is now needed.",
      "This is the join operation for background delegated work.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Spawned agent name, for example bob" },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agent, reports, wasPending } = await waitForAgent(params.name, ctx);
      return {
        content: [{ type: "text", text: `${wasPending ? `Waited for ${agent.name}.` : `${agent.name} did not have a tracked background task.`}\n\nReport:\n${formatReports(reports)}` }],
        details: { agent, reports, wasPending },
      };
    },
  });

  pi.registerTool({
    name: "collect_spawned_reports",
    label: "Collect Spawned Reports",
    description: "Read reports that spawned agents have already written without blocking.",
    promptSnippet: "Collect available reports from spawned agents without waiting",
    promptGuidelines: [
      "Use collect_spawned_reports to check available background-agent results without blocking.",
      "Use wait_for_spawned_agent instead when the main answer depends on the background task being complete.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional spawned agent name. If omitted, collect reports from all spawned agents." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents, reports } = collectReports(typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined, ctx);
      return {
        content: [{ type: "text", text: `Reports from ${agents.map((agent) => agent.name).join(", ") || "no agents"}:\n${formatReports(reports)}` }],
        details: { agents, reports },
      };
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn a new named Pi subagent in a tmux pane. This is the tool equivalent of /spawn and preserves the /spawn command behavior.",
    promptSnippet: "Spawn a named Pi subagent in a tmux pane for delegated work",
    promptGuidelines: [
      "Use spawn_agent when the user asks in plain text to spawn, hire, create an agent, create a subagent, make an agent, start, launch, or add a named agent/subagent.",
      "For requests like 'spawn bob and ask about his model', set name to 'bob' and task to 'Ask/report what model you are using.'.",
      "For requests like 'ask bob to get the weather', if bob does not already exist, set name to 'bob' and task to 'Get the weather'.",
      "The selected model is fixed for that subagent after spawn.",
      "If model selection is explicit and the user did not specify fast or strong, ask the user which tier to use before calling spawn_agent. If model selection is auto, you may omit modelTier and the extension will choose from the task.",
      "Set contextMode=none/current/entry to decide which parent context tree to inject. Use current for the active branch, entry with contextEntryId for a specific tree node, or none for a clean subagent.",
      "By default, initial tasks run in background and notify when complete. Set wait=true only when the current answer must include the result.",
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
        modelTier: {
          type: "string",
          enum: ["fast", "strong"],
          description: "Model tier for the new subagent. Required only when tmuxSpawn.modelSelection is explicit; in auto mode it can be omitted and inferred from the task. Cannot be changed after spawn.",
        },
        contextMode: {
          type: "string",
          enum: ["none", "current", "entry"],
          description: "Which parent context tree to inject into the new subagent. Defaults to none. Use current for the active branch, entry for a specific entry id.",
        },
        contextEntryId: {
          type: "string",
          description: "Entry id to use when contextMode is entry.",
        },
        wait: {
          type: "boolean",
          description: "When task is provided, whether to block until it finishes. Defaults to false so the main agent stays responsive; set true only when the current answer depends on the result.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = String(params.name || "").trim();
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!name) throw new Error("spawn_agent requires a name");

      const wait = typeof params.wait === "boolean" ? params.wait : false;
      const spawnConfig = getSpawnModelConfig(ctx);
      if (params.modelTier !== "fast" && params.modelTier !== "strong" && spawnConfig.modelSelection === "explicit") {
        throw new Error("spawn_agent requires modelTier because tmuxSpawn.modelSelection is explicit. Ask the user whether to use fast or strong for this subagent unless they already specified it.");
      }
      const modelTier: SpawnModelTier = params.modelTier === "fast" || params.modelTier === "strong"
        ? params.modelTier
        : inferSpawnModelTier(`${name}\n${task}`);
      const contextMode: SpawnContextMode = params.contextMode === "current" || params.contextMode === "entry" ? params.contextMode : "none";
      const { agent, direction, reports, requestedName } = await spawnParsedAgent(name, task, ctx, {
        wait,
        reportKeys: Array.isArray(params.reportKeys) ? params.reportKeys : undefined,
        reportInstructions: typeof params.reportInstructions === "string" ? params.reportInstructions : undefined,
        modelTier,
        contextMode,
        contextEntryId: typeof params.contextEntryId === "string" ? params.contextEntryId : undefined,
      });
      return {
        content: [{ type: "text", text: `Spawned ${agent.name} ${direction}${agent.name !== requestedName ? ` (requested ${requestedName}; renamed to avoid collision)` : ""} using ${agent.modelTier ?? "fast"} model${agent.model ? ` (${agent.model})` : ""}.${task ? (wait ? `\n\nReport:\n${formatReports(reports)}` : "\n\nTask is running in background. I will notify you when it finishes; use collect_spawned_reports later if you need the report.") : ""}` }],
        details: { agent, direction, reports, requestedName, wait },
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
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      loadRegistry(ctx);
      return {
        content: [{ type: "text", text: formatAgents(spawnedAgents) }],
        details: { agents: [...spawnedAgents.values()] },
      };
    },
  });

  pi.on("before_agent_start", (event) => {
    const completedContext = completedNotices.length > 0
      ? `\n\nRecently completed spawned-agent tasks:\n${formatCompletedNotices(completedNotices)}\nUse these results when relevant to the user's next message.`
      : "";
    completedNotices.length = 0;
    const spawnedContext = spawnedAgents.size > 0
      ? `\n\nSpawned tmux subagents:\n${formatAgents(spawnedAgents)}`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}${spawnedContext}${completedContext}`,
    };
  });

  pi.on("input", async (event, ctx) => {
    loadRegistry(ctx);
    const killMatch = event.text.match(/^\s*(?:despawn|kill|fire|nuke|stop|close|terminate|remove)\s+(?:an?\s+)?(?:agent\s+|subagent\s+)?([A-Za-z0-9_.-]+)\s*$/i);
    if (killMatch && findAgent(spawnedAgents, killMatch[1]!)) {
      try {
        const { agent, wasRunning } = await killAgent(killMatch[1]!, ctx);
        ctx.ui.notify(`${wasRunning ? "Killed" : "Removed stale"} agent "${agent.name}"`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return { action: "handled" };
    }

    const match = event.text.match(/^\s*(?:tell|ask)\s+([A-Za-z0-9_.-]+)\s+to\s+([\s\S]+)$/i);
    if (!match || !findAgent(spawnedAgents, match[1]!)) return { action: "continue" };

    const name = match[1]!;
    const task = match[2]!.trim();
    if (!task) return { action: "continue" };

    try {
      ctx.ui.notify(`Sending to ${name}...`, "info");
      const { agent } = await sendToAgent(name, task, ctx, { wait: false });
      ctx.ui.notify(`Sent to agent "${agent.name}" in background. I will notify you when it finishes.`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.registerCommand("agents", {
    description: "List spawned tmux agents",
    handler: async (_args, ctx) => {
      loadRegistry(ctx);
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
        const { agent, wasRunning } = await killAgent(name, ctx);
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
        const { agent } = await sendToAgent(match[1]!, match[2]!.trim(), ctx, { wait: false });
        ctx.ui.notify(`Sent to agent "${agent.name}" in background. I will notify you when it finishes.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("spawn", {
    description: "Spawn a named pi session in a tmux pane (below if tall, right if wide)",
    handler: async (args, ctx) => {
      loadRegistry(ctx);
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
      const spawned = await withSpawnLock(async () => {
      const requestedName = parsed.name;
      const name = uniqueAgentName(spawnedAgents, requestedName);
      const prompt = parsed.prompt;
      const spawnConfig = getSpawnModelConfig(ctx);
      const explicitTier = explicitSpawnModelTier(rawInput);
      const selectedTier = explicitTier
        ?? (spawnConfig.modelSelection === "auto"
          ? inferSpawnModelTier(rawInput)
          : await ctx.ui.select("Spawn model", ["fast", "strong"], { placeholder: "Choose model tier for this subagent" }));
      if (selectedTier !== "fast" && selectedTier !== "strong") {
        ctx.ui.notify("Spawn cancelled: model tier is required", "info");
        return;
      }
      const modelTier: SpawnModelTier = selectedTier;
      const spawnModel = resolveSpawnModel(modelTier, ctx);

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
        "    const { CustomEditor } = await import('@earendil-works/pi-coding-agent');",
        "    class PaneAwareEditor extends CustomEditor {",
        "      render(_width: number): string[] {",
        "        return [];",
        "      }",
        "    }",
        "    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PaneAwareEditor(tui, theme, keybindings));",
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
          `${shellQuote(piBin)} --model ${shellQuote(spawnModel)} --thinking off ${shellQuote(contextualized)}`,
        ].join("; ");
      } else {
        shellCmd = [
          `export PATH=${shellQuote(nodeDir)}:${shellQuote(cargoDir)}:${shellQuote(agentBinDir)}:$PATH`,
          `export PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
          `export PI_SPAWN_SIGNAL_ID=${shellQuote(signalId)}`,
          `export PI_SPAWN_AGENT_NAME=${shellQuote(name)}`,
          `export PI_SPAWN_REPORT_FILE=${shellQuote(reportFile)}`,
          `trap 'tmux wait-for -U "$PI_SPAWN_SIGNAL_ID" 2>/dev/null || true' EXIT`,
          `${shellQuote(piBin)} --model ${shellQuote(spawnModel)} --thinking off`,
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
      const direction = layout.splitArg === "-v" ? "below" : "right";
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
      const agent: SpawnedAgent = {
        name,
        paneId,
        signalId,
        task: prompt,
        configDir,
        reportFile,
        splitArg: layout.splitArg,
        createdAt: nextSpawnCreatedAt(),
        model: spawnModel,
        modelTier,
      };
      if (prompt) {
        agent.pendingTask = prompt;
        agent.pendingSince = Date.now();
        agent.pendingReportOffset = 0;
      }
      spawnedAgents.set(name, agent);
      saveRegistry(ctx);
      await markSpawnPane(agent);
      await normalizeSpawnPaneSizes();

      // set the pane title so the name sticks to the top bar
      await pi.exec("tmux", [
        "select-pane", "-t", paneId, "-T", name,
      ]);
      if (mainPaneId && await paneExists(mainPaneId)) {
        await pi.exec("tmux", ["select-pane", "-t", mainPaneId]);
      }

      const renamed = name !== requestedName ? ` (requested "${requestedName}"; renamed to avoid collision)` : "";
      const modelNote = ` using ${modelTier} model (${spawnModel})`;
      const note = prompt
        ? `Spawned "${name}" ${direction}${renamed}${modelNote}\nTask assigned in background: ${prompt}`
        : `Spawned "${name}" ${direction}${renamed}${modelNote}`;
      ctx.ui.notify(note, "info");
      return { agent, prompt };
      });
      if (!spawned) return;

      if (spawned.prompt) watchAgentCompletion(spawned.agent, spawned.prompt, 0, ctx);
    },
  });
}
