import type { CommandRule } from "./command-rules";

/**
 * Local paths the file tools may never read or write, whatever the profile allows.
 *
 * Deliberately narrow — two categories only:
 *
 * 1. **Credentials.** Uploading these exfiltrates the operator's keys to a remote host.
 * 2. **Files that define the guards themselves** — the MCP client configuration, which is
 *    where this server's `SSH_*` variables live, plus autostart locations. Downloading
 *    onto one of these replaces the policy that governs the next run, so the guard would
 *    be self-defeating without it.
 *
 * Ordinary operational files are intentionally *not* here. `.env` uploads, `.bashrc`
 * backups and cron fetches are normal deployment work, and blocking them broke real tasks
 * to stop an attack that a `python3 -c` one-liner performs anyway.
 *
 * Matched against the **real** path (symlinks resolved) with `\` normalized to `/`.
 */
export const PROTECTED_LOCAL_PATH_RULES: CommandRule[] = [
    {
        pattern: /(^|\/)\.ssh(\/|$)/i,
        reason: "SSH key directory",
    },
    {
        pattern: /(^|\/)authorized_keys$/i,
        reason: "SSH authorized_keys",
    },
    {
        pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i,
        reason: "private key file",
    },
    {
        pattern: /\.(pem|ppk|p12|pfx|key)$/i,
        reason: "private key or certificate file",
    },
    {
        pattern: /(^|\/)\.gnupg(\/|$)/i,
        reason: "GPG keyring",
    },
    {
        pattern: /(^|\/)\.aws(\/|$)/i,
        reason: "AWS credentials",
    },
    {
        pattern: /(^|\/)\.kube(\/|$)/i,
        reason: "kubeconfig",
    },
    {
        pattern: /(^|\/)\.docker(\/|$)/i,
        reason: "docker credentials",
    },
    {
        pattern: /(^|\/)\.npmrc$/i,
        reason: "npm credentials",
    },
    {
        pattern: /(^|\/)\.netrc$/i,
        reason: "netrc credentials",
    },
    {
        pattern: /(^|\/)\.claude(\.json)?(\/|$)/i,
        reason: "MCP client configuration",
    },
    {
        pattern: /(^|\/)\.mcp\.json$/i,
        reason: "MCP server configuration",
    },
    {
        pattern: /(^|\/)claude_desktop_config\.json$/i,
        reason: "MCP client configuration",
    },
    {
        pattern: /(^|\/)start ?menu\/programs\/startup(\/|$)/i,
        reason: "Windows startup folder",
    },
    {
        pattern: /(^|\/)\.config\/autostart(\/|$)/i,
        reason: "desktop autostart directory",
    },
];
