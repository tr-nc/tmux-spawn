import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
      const { name, prompt } = await parseWithLLM(rawInput, piBin, pi);

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
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

      // build shell command that launches pi interactively with the initial prompt,
      // properly escaped for shell single-quote safety
      let shellCmd: string;
      if (prompt) {
        // inject context so the subagent knows where it came from
        const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "";
        const cwd = process.cwd();
        const contextualized = [
          "[context from parent]",
          `parent session: ${sessionFile}`,
          `cwd: ${cwd}`,
          `agent name: ${name}`,
          "",
          prompt,
        ].join("\n");

        const escaped = contextualized.replace(/'/g, "'\\''");
        shellCmd = [
          `export PATH="${nodeDir}:${cargoDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          `${piBin} --model deepseek/deepseek-v4-flash --thinking off '${escaped}'`,
        ].join("; ");
      } else {
        shellCmd = [
          `export PATH="${nodeDir}:${cargoDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          `${piBin} --model deepseek/deepseek-v4-flash --thinking off`,
        ].join("; ");
      }

      const result = await pi.exec("tmux", [
        "split-window", "-P", "-F", "#{pane_id}",
        splitArg,
        shellCmd,
      ]);

      if (result.code !== 0) {
        ctx.ui.notify(
          `Failed to spawn pane: ${result.stderr || "unknown error"}`,
          "error",
        );
        return;
      }

      const paneId = result.stdout.trim();

      // set the pane title so the name sticks to the top bar
      await pi.exec("tmux", [
        "select-pane", "-t", paneId, "-T", name,
      ]);

      ctx.ui.notify(`Spawned "${name}" ${direction}`, "info");
      if (prompt) ctx.ui.notify(`Task Given: ${prompt}`, "info");
    },
  });
}
