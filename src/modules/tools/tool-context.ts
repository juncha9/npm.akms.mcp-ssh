import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshHostProfile } from "@/_types";
import { GuardRejectionError } from "@/modules/guard";
import { SshConnection, SshSession, SshSessionManager } from "@/modules/ssh";

import { formatGuardRejection } from "./format";

/**
 * Ceiling on simultaneous one-off connections, which the session manager never sees.
 * Matched to the session cap: an MCP client can dispatch a whole tool batch at once, and
 * a limit low enough to reject an ordinary batch is worse than the fan-out it prevents.
 */
const MAX_EPHEMERAL_CONNECTIONS = 32;

let activeEphemeralCount = 0;

/** Everything the tool handlers share: the configured host and the live sessions. */
export interface ToolContext {
    /** The host from the `SSH_*` variables, or null when none is registered. */
    profile: SshHostProfile | null;
    sessions: SshSessionManager;
}

export function textResult(text: string): CallToolResult {
    return { content: [{ type: "text", text: text }] };
}

/** Marked `isError` so the model sees the call failed rather than reading it as output. */
export function errorResult(message: string): CallToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

/**
 * Renders a failure for the model, separating the two cases it must treat differently:
 * a guard rejection is a policy decision not worth retrying, anything else is an
 * operational failure that might succeed on a second attempt.
 */
export function toToolError(error: unknown, toolName: string, action: string): CallToolResult {
    const _logger = $logger.child({ context: toolName });

    if (error instanceof GuardRejectionError) {
        _logger.warn("rejected by the guard", { reason: error.verdict.reason, action: action });

        const rendered = formatGuardRejection(action, error.verdict);
        return errorResult(rendered);
    }

    _logger.error(error, `${toolName} failed`);
    return errorResult(`${toolName} failed: ${describeError(error)}`);
}

/**
 * Resolves the optional `session` argument to a host, without connecting.
 *
 * A session carries the profile it was opened against, so it is preferred when supplied;
 * otherwise the one configured host is used. There is no host argument — this server
 * fronts exactly the host in its own env block, which is what keeps the model from being
 * able to name one.
 *
 * @throws {Error} If no host is registered, or the session id is not open.
 */
export function resolveProfile(
    context: ToolContext,
    args: { session?: string }
): { profile: SshHostProfile; session: SshSession | null } {
    const hasSession = args.session != null && args.session.trim() !== "";
    if (hasSession == true) {
        const session = context.sessions.require((args.session as string).trim());
        return { profile: session.profile, session: session };
    }

    if (context.profile == null) {
        throw new Error(`no host is registered — set ${SINGLE_HOST_ENV.HOST} / ${SINGLE_HOST_ENV.USER} in this server's env block, then restart it`);
    }

    return { profile: context.profile, session: null };
}

/**
 * Runs `operation` against the resolved host.
 *
 * A session routes through `runExclusive`, which serializes work and keeps the idle
 * sweeper away; without one a one-off connection is opened and closed around the call.
 * The connection is created but not dialled — `exec` / `withSftp` connect on demand, so a
 * command the guard refuses never costs a handshake.
 *
 * @throws {Error} If the one-off connection ceiling is reached.
 */
export async function withHostConnection<T>(
    profile: SshHostProfile,
    session: SshSession | null,
    operation: (connection: SshConnection) => Promise<T>
): Promise<T> {
    if (session != null) {
        return await session.runExclusive(operation);
    }

    if (activeEphemeralCount >= MAX_EPHEMERAL_CONNECTIONS) {
        throw new Error(`too many concurrent one-off connections (${MAX_EPHEMERAL_CONNECTIONS}); open a session with ssh_connect and reuse it`);
    }

    activeEphemeralCount += 1;
    const connection = new SshConnection(profile);

    try {
        return await operation(connection);
    }
    finally {
        // Nested finally: a throwing disconnect must not leak the slot, or the ceiling
        // ratchets down until every call fails.
        try {
            connection.disconnect();
        }
        finally {
            activeEphemeralCount -= 1;
        }
    }
}
