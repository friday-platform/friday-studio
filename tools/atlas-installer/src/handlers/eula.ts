import * as fs from "node:fs";
import * as path from "node:path";
import type { IPCHandler } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger("EulaHandler");

/**
 * Get EULA text
 */
export const getEulaTextHandler: IPCHandler<[], string> = async (): Promise<string> => {
  const eulaPath = path.join(__dirname, "..", "..", "eula.txt");

  try {
    return fs.readFileSync(eulaPath, "utf8");
  } catch (error) {
    logger.error("Failed to read EULA file", error);
    throw new Error(
      `Failed to read EULA file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
