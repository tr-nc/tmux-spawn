import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spawn", {
    description: "Spawn a new tmux pane (below if tall, right if wide)",
    handler: async (_args, ctx) => {
      // Get current tmux window dimensions
      const dims = await pi.exec("tmux", [
        "display-message",
        "-p",
        "#{window_height}:#{window_width}",
      ]);

      if (dims.code !== 0) {
        ctx.ui.notify("Not running inside tmux", "error");
        return;
      }

      const [heightStr, widthStr] = dims.stdout.trim().split(":");
      const height = parseInt(heightStr, 10);
      const width = parseInt(widthStr, 10);

      if (isNaN(height) || isNaN(width)) {
        ctx.ui.notify("Failed to parse tmux window dimensions", "error");
        return;
      }

      // height > width: split vertically (new pane below)
      // otherwise: split horizontally (new pane to the right)
      const splitArg = height > width ? "-v" : "-h";
      const direction = height > width ? "below" : "right";

      const result = await pi.exec("tmux", ["split-window", splitArg]);

      if (result.code === 0) {
        ctx.ui.notify(`New pane spawned ${direction}`, "info");
      } else {
        ctx.ui.notify(
          `Failed to spawn pane: ${result.stderr || "unknown error"}`,
          "error",
        );
      }
    },
  });
}
