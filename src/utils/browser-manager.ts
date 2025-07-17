import { exists } from "@std/fs";
import { join } from "@std/path";

export async function checkAndDownloadBrowsers() {
  const atlasHome = join(Deno.env.get("HOME")!, ".atlas");
  const browsersPath = join(atlasHome, "browsers");

  if (!(await exists(browsersPath))) {
    console.log("Playwright browsers not found. Downloading...");
    try {
      const command = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-all",
          "npm:playwright@latest",
          "install",
          "chromium",
        ],
        env: {
          ...Deno.env.toObject(),
          PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        },
      });
      const { success, stdout, stderr } = await command.output();
      if (!success) {
        console.error("Failed to download Playwright browsers.");
        console.error(new TextDecoder().decode(stderr));
      } else {
        console.log("Playwright browsers downloaded successfully.");
      }
    } catch (error) {
      console.error("Failed to download Playwright browsers:", error);
    }
  }
}
