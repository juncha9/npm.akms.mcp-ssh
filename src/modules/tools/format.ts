import { SINGLE_HOST_ENV } from "@/_defs";
import { formatBytes } from "@/_libs";
import type {
    GuardVerdict,
    SshExecResult,
    SshHostProfile,
    SshRemoteEntry,
    SshSessionInfo,
} from "@/_types";
import { toHostSummary } from "@/modules/config";
import type { RemoteDirectoryListing } from "@/modules/ssh";

const ENTRY_TYPE_MARKERS: Record<SshRemoteEntry["type"], string> = {
    file: "-",
    directory: "d",
    symlink: "l",
    other: "?",
};

/**
 * Renders the configured host for `ssh_list_hosts`, or setup instructions when none is
 * registered. Credential fields never appear — only which auth method is in use.
 */
export function formatHostProfile(profile: SshHostProfile | null): string {
    if (profile == null) {
        return [
            "No SSH host is registered.",
            "",
            "Put the connection in this server's MCP entry — one server entry per host:",
            "",
            `    "env": {`,
            `        "${SINGLE_HOST_ENV.HOST}": "10.0.0.5",`,
            `        "${SINGLE_HOST_ENV.USER}": "deploy",`,
            `        "${SINGLE_HOST_ENV.KEY}": "~/.ssh/id_ed25519"`,
            "    }",
            "",
            `${SINGLE_HOST_ENV.HOST} and ${SINGLE_HOST_ENV.USER} are the whole minimum.`,
            "Restart this server after changing it — environment variables are fixed for the life of the process.",
        ].join("\n");
    }

    const summary = toHostSummary(profile);

    let accessLabel = "writable";
    if (summary.readonly == true) {
        accessLabel = "READ-ONLY";
    }

    let sudoLabel = "sudo=disabled";
    if (summary.allowSudo == true) {
        sudoLabel = "sudo=enabled";
    }

    const lines: string[] = [];
    lines.push(`${summary.name}  →  ${summary.username}@${summary.host}:${summary.port}  auth=${summary.authMethod}  ${accessLabel}  ${sudoLabel}`);

    if (summary.description != null) {
        lines.push(`    ${summary.description}`);
    }

    if (summary.allowedPaths.length > 0) {
        // Scope stated explicitly: allowedPaths binds the SFTP tools only, and reading
        // it as a filesystem-wide restriction would be a dangerous misunderstanding —
        // ssh_exec can still `cat` anything the remote account can read.
        lines.push(`    file tools limited to: ${summary.allowedPaths.join(", ")} (does not restrict ssh_exec)`);
    }

    if (summary.allowCommands.length > 0) {
        lines.push(`    commands limited to: ${summary.allowCommands.join(", ")}`);
    }

    return lines.join("\n");
}

/**
 * Renders a command result: a status line (exit code, duration, cwd), any timeout or
 * truncation notice, then the stdout and stderr sections.
 *
 * @param timeoutMs The limit that applied, quoted in the timeout notice.
 */
export function formatExecResult(result: SshExecResult, timeoutMs: number): string {
    const headerParts: string[] = [];

    if (result.exitCode != null) {
        headerParts.push(`exit code: ${result.exitCode}`);
    }
    else {
        headerParts.push("exit code: none (killed)");
    }

    if (result.signal != null) {
        headerParts.push(`signal: ${result.signal}`);
    }

    headerParts.push(`${result.durationMs}ms`);

    if (result.cwd != null) {
        headerParts.push(`cwd: ${result.cwd}`);
    }

    const lines: string[] = [headerParts.join("  ·  ")];

    if (result.timedOut == true) {
        lines.push(`TIMED OUT after ${timeoutMs}ms — the channel was closed, but the remote process may still be running.`);
    }

    if (result.truncated == true) {
        lines.push("Output was truncated; narrow the command (grep / head / tail) or raise maxOutputCharacters for this profile.");
    }

    lines.push("");
    lines.push("--- stdout ---");
    if (result.stdout === "") {
        lines.push("(empty)");
    }
    else {
        lines.push(result.stdout);
    }

    if (result.stderr !== "") {
        lines.push("");
        lines.push("--- stderr ---");
        lines.push(result.stderr);
    }

    return lines.join("\n");
}

/** Rejection message: what was blocked, why, and what would make it legal. */
export function formatGuardRejection(action: string, verdict: GuardVerdict): string {
    const lines: string[] = [`Blocked by the host profile's guard policy: ${verdict.reason}`];

    if (verdict.offendingText != null && verdict.offendingText !== action) {
        lines.push(`Offending part: ${verdict.offendingText}`);
    }

    lines.push(`Requested: ${action}`);
    lines.push("Nothing was sent to the remote host. Adjust the request, or relax the profile's policy in the config file.");

    return lines.join("\n");
}

/** Renders open sessions with host, working directory, command count and idle time. */
export function formatSessionList(sessions: SshSessionInfo[]): string {
    if (sessions.length === 0) {
        return "No open SSH sessions. Open one with ssh_connect, or pass 'target' to run a one-off command.";
    }

    const lines: string[] = [`${sessions.length} open SSH session(s):`];
    const now = Date.now();

    for (const session of sessions) {
        const idleSeconds = Math.round((now - new Date(session.lastUsedAt).getTime()) / 1000);
        lines.push("");
        lines.push(`${session.sessionId}  →  ${session.username}@${session.host}  profile: ${session.profileName}`);
        lines.push(`    cwd: ${session.cwd}  ·  ${session.execCount} command(s)  ·  idle ${idleSeconds}s  ·  opened ${session.openedAt}`);
    }

    return lines.join("\n");
}

/**
 * Renders a directory listing as one row per entry (type, mode, size, mtime, name),
 * noting the true total when the listing was capped.
 */
export function formatDirectoryListing(remotePath: string, listing: RemoteDirectoryListing): string {
    if (listing.totalCount === 0) {
        return `${remotePath} is empty.`;
    }

    let header = `${remotePath} — ${listing.totalCount} entrie(s):`;
    if (listing.truncated == true) {
        header = `${remotePath} — ${listing.totalCount} entrie(s), showing the first ${listing.entries.length}:`;
    }

    const lines: string[] = [header, ""];

    for (const entry of listing.entries) {
        const marker = ENTRY_TYPE_MARKERS[entry.type];
        const size = formatBytes(entry.sizeBytes).padStart(9);

        let name = entry.name;
        if (entry.type === "directory") {
            name = `${entry.name}/`;
        }

        lines.push(`${marker}  ${entry.mode}  ${size}  ${entry.modifiedAt}  ${name}`);
    }

    if (listing.truncated == true) {
        lines.push("");
        lines.push("Listing was capped; narrow the path or filter with ssh_exec if you need the rest.");
    }

    return lines.join("\n");
}
