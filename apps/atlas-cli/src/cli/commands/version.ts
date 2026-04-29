import { getVersionInfo } from "@atlas/utils";
import { define } from "gunshi";

export const versionCommand = define({
  name: "version",
  description: "Show Atlas version information",
  args: {
    json: { type: "boolean", description: "Output version information as JSON", default: false },
  },
  rendering: { header: null },
  run: (ctx) => {
    const info = getVersionInfo();

    if (ctx.values.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      const channel = info.isNightly ? "nightly" : info.isCompiled ? "stable" : "edge";
      console.log(`atlas v${info.version} (${channel})`);
    }
  },
});
