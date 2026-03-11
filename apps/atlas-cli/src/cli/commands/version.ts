import { getVersionInfo } from "@atlas/utils";
import { define } from "gunshi";

export const versionCommand = define({
  name: "version",
  description: "Show Atlas version information",
  args: {
    json: { type: "boolean", description: "Output version information as JSON", default: false },
    remote: {
      type: "boolean",
      description: "Check for newer version from remote server",
      default: false,
    },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const info = getVersionInfo();

    if (ctx.values.remote) {
      if (ctx.values.json) {
        if (info.isDev) {
          const result = {
            ...info,
            remote: {
              hasUpdate: false,
              skipped: true,
              reason: "Remote version checking is disabled for development builds",
            },
          };
          console.log(JSON.stringify(result, null, 2));
        } else {
          const { checkForUpdates } = await import("../../utils/version-checker.ts");
          const updateCheck = await checkForUpdates(true);
          const result = {
            ...info,
            remote: {
              hasUpdate: updateCheck.hasUpdate,
              latestVersion: updateCheck.latestVersion,
              errorMessage: updateCheck.errorMessage,
              fromCache: updateCheck.fromCache,
            },
          };
          console.log(JSON.stringify(result, null, 2));
        }
      } else {
        const channel = info.isNightly ? "nightly" : info.isCompiled ? "stable" : "edge";
        console.log(`atlas v${info.version} (${channel})`);
        console.log();

        if (info.isDev) {
          console.log("Remote version checking is disabled for development builds");
        } else {
          console.log("Checking for updates...");
          const { checkForUpdates } = await import("../../utils/version-checker.ts");
          const updateCheck = await checkForUpdates(true);

          if (updateCheck.errorMessage) {
            console.log(`Error checking for updates: ${updateCheck.errorMessage}`);
          } else if (updateCheck.hasUpdate && updateCheck.latestVersion) {
            console.log(`A newer version is available: ${updateCheck.latestVersion}`);
            console.log(`Current version: ${updateCheck.currentVersion}`);
          } else {
            console.log(`You are running the latest version (${updateCheck.currentVersion})`);
          }

          if (updateCheck.fromCache) {
            console.log("(cached result)");
          }
        }
      }
    } else if (ctx.values.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      const channel = info.isNightly ? "nightly" : info.isCompiled ? "stable" : "edge";
      console.log(`atlas v${info.version} (${channel})`);
    }
  },
});
