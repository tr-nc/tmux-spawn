import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// short memorable words for auto-generated agent names
const NAME_POOL = [
  "nova", "flux", "echo", "volt", "dune", "mode", "beam",
  "grid", "loop", "spin", "glow", "dash", "vibe", "byte",
  "node", "peak", "zinc", "luna", "mars", "bolt", "seek",
  "rift", "surf", "drift", "prism", "shard", "ember", "crest",
];

function parseName(input: string): { name: string; prompt: string } {
  if (!input) return { name: pickName(), prompt: "" };
  const parts = input.split(/\s+/);
  const first = parts[0]!;
  // first word is a name if it looks like an identifier
  if (/^[a-zA-Z0-9_-]{3,16}$/.test(first)) {
    return { name: first, prompt: parts.slice(1).join(" ") };
  }
  return { name: pickName(), prompt: input };
}

let nameIndex = 0;
function pickName(): string {
  const idx = nameIndex++ % NAME_POOL.length;
  const suffix = Math.floor(nameIndex / NAME_POOL.length);
  return suffix > 0 ? `${NAME_POOL[idx]}${suffix}` : NAME_POOL[idx]!;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spawn", {
    description: "Spawn a named pi session in a tmux pane (below if tall, right if wide)",
    handler: async (args, ctx) => {
      const rawInput = (args as string).trim();
      const { name, prompt } = parseName(rawInput);

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

      // resolve pi's absolute path and its node binary directory.
      // tmux runs commands via `$SHELL -c`, which is non-interactive
      // and may not source .bashrc/.zshrc (nvm PATH setup).
      const whichPi = await pi.exec("which", ["pi"]);
      const whichNode = await pi.exec("which", ["node"]);
      if (whichPi.code !== 0 || whichNode.code !== 0) {
        ctx.ui.notify("pi or node not found on PATH", "error");
        return;
      }
      const piBin = whichPi.stdout.trim();
      const nodeDir = join(whichNode.stdout.trim(), "..");
      const cargoDir = join(homedir(), ".cargo", "bin");


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
        const escaped = prompt.replace(/'/g, "'\\''");
        shellCmd = [
          `export PATH="${nodeDir}:${cargoDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          `${piBin} '${escaped}'`,
        ].join("; ");
      } else {
        shellCmd = [
          `export PATH="${nodeDir}:${cargoDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          piBin,
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
    },
  });
}
