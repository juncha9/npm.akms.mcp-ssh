import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerExecTools } from "./exec-tools";
import { registerFileTools } from "./file-tools";
import { registerHostTools } from "./host-tools";
import { registerSessionTools } from "./session-tools";
import type { ToolContext } from "./tool-context";

export { registerHostTools } from "./host-tools";
export { registerSessionTools } from "./session-tools";
export { registerExecTools } from "./exec-tools";
export { registerFileTools } from "./file-tools";

export {
    textResult,
    errorResult,
    describeError,
    toToolError,
    resolveProfile,
    withHostConnection,
} from "./tool-context";
export type { ToolContext } from "./tool-context";

export {
    formatHostProfile,
    formatExecResult,
    formatGuardRejection,
    formatSessionList,
    formatDirectoryListing,
} from "./format";

/** Registers every tool this server exposes, in the order the model should discover them. */
export function registerAllTools(server: McpServer, context: ToolContext): void {
    registerHostTools(server, context);
    registerSessionTools(server, context);
    registerExecTools(server, context);
    registerFileTools(server, context);
}
