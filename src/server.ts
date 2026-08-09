import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshHostProfile } from "@/_types";
import { loadHostProfile } from "@/modules/config";
import { SshSessionManager } from "@/modules/ssh";
import { registerAllTools } from "@/modules/tools";
import type { ToolContext } from "@/modules/tools";

export interface SshMcpServerInstance {
    server: McpServer;
    sessions: SshSessionManager;
    /** The host read from the `SSH_*` variables at startup, or null when none is set. */
    readonly profile: SshHostProfile | null;
    /** Stops the sweeper and closes every open session. Call before the process exits. */
    shutdown(): void;
}

/** Handed to the client on connect, so the model knows the workflow before its first call. */
const SERVER_INSTRUCTIONS = [
    "This server runs shell commands and transfers files on one remote host over SSH.",
    "The host is fixed in this server's own environment — there is no host argument, and no other machine is reachable through it.",
    "",
    "ssh_list_hosts shows which host this is and what it permits. Call it before assuming anything about access.",
    "",
    "Workflow:",
    "1. One command: ssh_exec with just 'command'.",
    "2. Several commands in a row: ssh_connect once, then ssh_exec with 'session' (the working directory persists across calls), then ssh_disconnect.",
    "3. Files: ssh_list_dir, ssh_read_file, ssh_write_file, ssh_upload, ssh_download — prefer these over shell equivalents; no quoting to get wrong.",
    "",
    "What is permitted: ordinary administration, without asking — package installs, service restarts, sudo, interpreters, config edits, deployments.",
    "Refused always, and only these: operations that destroy the machine or cut this connection — wiping the filesystem root or a system directory, deleting a file the host cannot boot without, formatting a disk, writing raw bytes to a block device, rebooting or powering off, flushing the firewall, removing every cron job.",
    "The host may add its own limits (read-only, an allow-list, deny patterns, path restrictions). ssh_list_hosts shows which apply.",
    "",
    "Commands run with no terminal and with stdin closed, so anything that waits for input fails immediately instead of hanging: use non-interactive flags (apt-get -y, sudo -n), 'top -bn1' rather than 'top', and ssh_write_file rather than an editor.",
    "A job that may outlive its timeout should be started detached (nohup … &, tmux new -d) and polled through its log.",
    "",
    "A guard rejection is a policy decision, not a transient failure — do not retry the same command; report it and ask before working around it.",
    "A non-zero exit code is returned as normal output; read it and stderr to judge what happened.",
    "You still carry the judgement the guards do not: this is a real host, and an irreversible action deserves a check with the operator first.",
].join("\n");

/**
 * Builds the MCP server: reads the host from the environment, wires the session manager,
 * registers tools.
 *
 * Transport is deliberately left to the caller — `cli.ts` attaches stdio, tests can attach
 * an in-memory pair.
 *
 * @throws {Error} If the `SSH_*` variables are malformed (a bad policy value must not
 *                 silently degrade into "no guard").
 */
export function createSshMcpServer(): SshMcpServerInstance {
    const _logger = $logger.child({ context: "createSshMcpServer" });

    const profile = loadHostProfile();

    const sessions = new SshSessionManager();
    sessions.startIdleSweeper();

    const server = new McpServer(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            instructions: SERVER_INSTRUCTIONS,
        }
    );

    const context: ToolContext = {
        profile: profile,
        sessions: sessions,
    };

    registerAllTools(server, context);

    _logger.info("mcp server built", { profile: profile?.name ?? null });

    return {
        server: server,
        sessions: sessions,
        profile: profile,
        shutdown(): void {
            sessions.stopIdleSweeper();
            sessions.closeAll();
        },
    };
}
