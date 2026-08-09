import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger } from "@/_libs";

import { formatSessionList } from "./format";
import { errorResult, resolveProfile, textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerSessionTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "ssh_connect",
        {
            title: "Open an SSH session",
            description: [
                "Open a reusable SSH session to the configured host and return its session id.",
                "Prefer this over one-off calls when running several commands: it pays the handshake once and remembers the working directory, so a 'cd' in one ssh_exec still applies to the next.",
                "Close it with ssh_disconnect when done; idle sessions are reaped automatically, and a session whose connection drops reports that rather than silently reconnecting.",
            ].join(" "),
            inputSchema: {
                cwd: z.string().optional().describe("Absolute directory to start in, with no shell metacharacters. Defaults to SSH_CWD, else the login shell's directory."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ cwd }) => {
            let _logger = $logger.child({ context: "ssh_connect" });

            // Tracked outside the try so a probe that *throws* still tears the session
            // down — leaking it would burn one of the 32 slots until the sweeper ran.
            let openedSessionId: string | null = null;

            try {
                const { profile } = resolveProfile(context, {});
                const session = await context.sessions.open(profile);
                openedSessionId = session.sessionId;
                _logger = _logger.child({ session_id: session.sessionId });

                if (cwd != null && cwd.trim() !== "") {
                    session.cwd = cwd.trim();
                }

                // One `pwd` settles the real starting directory (and proves `cwd` exists),
                // so the session reports a concrete path instead of "login default".
                const probe = await session.exec("pwd");

                // `exitCode === null` means the channel closed with no exit status — the
                // probe never proved anything, so it counts as a failure rather than a pass.
                const probeSucceeded = probe.exitCode === 0 && probe.timedOut == false;
                if (probeSucceeded == false) {
                    context.sessions.close(session.sessionId);
                    openedSessionId = null;
                    _logger.warn("session probe failed, closing the session", {
                        exit_code: probe.exitCode,
                        timed_out: probe.timedOut,
                        stderr: probe.stderr,
                    });
                    return errorResult(`ssh_connect failed: could not confirm the starting directory.\n${probe.stderr.trim()}`);
                }

                const lines: string[] = [
                    `Opened session ${session.sessionId} → ${profile.username}@${profile.host}:${profile.port}`,
                    `cwd: ${session.cwd}`,
                ];

                if (profile.policy.readonly == true) {
                    lines.push("This host is READ-ONLY: writes, redirections and uploads will be rejected.");
                }

                lines.push(`Run commands with ssh_exec({ session: "${session.sessionId}", command: "..." }).`);

                _logger.info("session opened via tool", { cwd: session.cwd });
                return textResult(lines.join("\n"));
            }
            catch (ex) {
                if (openedSessionId != null) {
                    context.sessions.close(openedSessionId);
                }

                return toToolError(ex, "ssh_connect", "connect to the configured host");
            }
        }
    );

    server.registerTool(
        "ssh_disconnect",
        {
            title: "Close an SSH session",
            description: "Close an open SSH session and release its connection.",
            inputSchema: {
                session: z.string().describe("Session id returned by ssh_connect."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ session }) => {
            const _logger = $logger.child({ context: "ssh_disconnect", session_id: session });

            try {
                const closed = context.sessions.close(session);
                if (closed == false) {
                    return errorResult(`no open session with id '${session}'. Call ssh_list_sessions to see what is open.`);
                }

                _logger.info("session closed via tool");
                return textResult(`Closed session ${session}.`);
            }
            catch (ex) {
                return toToolError(ex, "ssh_disconnect", `close ${session}`);
            }
        }
    );

    server.registerTool(
        "ssh_list_sessions",
        {
            title: "List open SSH sessions",
            description: "List every open SSH session with its host, working directory and idle time.",
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            try {
                const sessions = context.sessions.list();
                const rendered = formatSessionList(sessions);
                return textResult(rendered);
            }
            catch (ex) {
                return toToolError(ex, "ssh_list_sessions", "list sessions");
            }
        }
    );
}
