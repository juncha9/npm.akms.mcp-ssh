import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { $logger } from "@/_libs";

import { formatHostProfile } from "./format";
import { textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerHostTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "ssh_list_hosts",
        {
            title: "Show the SSH host",
            description: [
                "Show the SSH host this server connects to, with its guard policy.",
                "Call this first: it is the only reachable host, and its policy decides what the other tools will accept.",
                "Credentials are never returned — only which auth method the host uses.",
            ].join(" "),
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            const _logger = $logger.child({ context: "ssh_list_hosts" });

            try {
                const listing = formatHostProfile(context.profile);
                _logger.debug("host profile returned", { profile: context.profile?.name });
                return textResult(listing);
            }
            catch (ex) {
                return toToolError(ex, "ssh_list_hosts", "show the host");
            }
        }
    );
}
