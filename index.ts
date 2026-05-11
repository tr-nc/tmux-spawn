import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spawn", {
    description: "Spawn a pi session in a tmux pane (below if tall, right if wide)",
    handler: async (args, ctx) => {
      const initialPrompt = args as string;

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
      if (initialPrompt) {
        const escaped = initialPrompt.replace(/'/g, "'\\''");
        shellCmd = [
          `export PATH="${nodeDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          `${piBin} '${escaped}'`,
        ].join("; ");
      } else {
        shellCmd = [
          `export PATH="${nodeDir}:$PATH"`,
          `export PI_CODING_AGENT_DIR="${configDir}"`,
          piBin,
        ].join("; ");
      }

      const result = await pi.exec("tmux", [
        "split-window",
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

      ctx.ui.notify(`New pane spawned ${direction}`, "info");
    },
  });
}
