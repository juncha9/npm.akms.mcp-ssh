import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger } from "@/_libs";
import type { SshExecResult } from "@/_types";

import { formatExecResult } from "./format";
import { resolveProfile, textResult, toToolError, withHostConnection } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerExecTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "ssh_exec",
        {
            title: "Run a command over SSH",
            description: [
                "Run a shell command on the configured SSH host and return stdout, stderr and the exit code.",
                "Pass 'session' to reuse an open session, which remembers its working directory; omit it and a one-off connection is opened and closed around the call.",
                "A non-zero exit code is reported as normal output, not as a tool error — read the exit code and stderr to judge the outcome.",
                "Almost everything is permitted: package installs, service restarts, sudo, interpreters. Only catastrophic operations are refused outright (wiping the filesystem root, formatting a disk, rebooting, flushing the firewall), and the host may add its own limits.",
            ].join(" "),
            inputSchema: {
                command: z.string().min(1).describe("Shell command, exactly as it would be typed in a terminal. Chaining with ';', '&&', '||' and pipes is allowed; each part is screened separately."),
                session: z.string().optional().describe("Session id from ssh_connect. Reuses that connection and keeps the working directory across calls."),
                cwd: z.string().optional().describe("Absolute directory to run in, with no shell metacharacters. With a session, the session also moves there."),
                timeoutMs: z.number().int().positive().optional().describe("Lowers the command timeout for this call; it cannot exceed the profile's own limit. The channel is closed when it elapses; the remote process may survive."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ command, session, cwd, timeoutMs }) => {
            let _logger = $logger.child({ context: "ssh_exec" });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });
                _logger = _logger.child({ profile: profile.name, session_id: openSession?.sessionId });

                // Clamped, not defaulted: a per-call override that could exceed the profile
                // ceiling would make the ceiling advisory.
                const requestedTimeoutMs = timeoutMs ?? profile.policy.execTimeoutMs;
                const effectiveTimeoutMs = Math.min(requestedTimeoutMs, profile.policy.execTimeoutMs);

                // An empty string is "not specified", not "the root of nowhere" — passing it
                // through would silently reset a session's tracked directory.
                let requestedCwd: string | undefined = undefined;
                if (cwd != null && cwd.trim() !== "") {
                    requestedCwd = cwd.trim();
                }

                _logger.debug("running command", { command: command, timeout_ms: effectiveTimeoutMs });

                let result: SshExecResult;
                if (openSession != null) {
                    result = await openSession.exec(command, { cwd: requestedCwd, timeoutMs: effectiveTimeoutMs });
                }
                else {
                    result = await withHostConnection(profile, null, async (connection) => {
                        return await connection.exec({
                            command: command,
                            cwd: requestedCwd,
                            timeoutMs: effectiveTimeoutMs,
                            maxOutputCharacters: profile.policy.maxOutputCharacters,
                            trackCwd: false,
                        });
                    });
                }

                _logger.info("command executed", {
                    exit_code: result.exitCode,
                    duration_ms: result.durationMs,
                    timed_out: result.timedOut,
                });

                const rendered = formatExecResult(result, effectiveTimeoutMs);
                return textResult(rendered);
            }
            catch (ex) {
                return toToolError(ex, "ssh_exec", command);
            }
        }
    );
}
