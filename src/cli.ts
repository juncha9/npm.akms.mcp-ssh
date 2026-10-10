#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LOG_LEVEL_ENV, SERVER_NAME, SERVER_VERSION, SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshHostProfile } from "@/_types";
import { runConfigCommand, runConnectionCheck } from "@/modules/manage";
import { createSshMcpServer } from "@/server";

interface CliArguments {
    showHelp: boolean;
    showVersion: boolean;
    checkOnly: boolean;
    /** `config` as the first argument opens the host manager instead of the server. */
    configMode: boolean;
    /** `--target <id>` — the client `config` opens on. */
    targetId?: string;
}

function parseArguments(argv: string[]): CliArguments {
    const parsed: CliArguments = { showHelp: false, showVersion: false, checkOnly: false, configMode: false };

    let rest = argv;
    if (argv[0] === "config") {
        parsed.configMode = true;
        rest = argv.slice(1);
    }

    for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];

        if (argument === "--target") {
            parsed.targetId = rest[index + 1];
            index += 1;
            continue;
        }

        if (argument.startsWith("--target=") == true) {
            parsed.targetId = argument.slice("--target=".length);
            continue;
        }

        if (argument === "--help" || argument === "-h") {
            parsed.showHelp = true;
            continue;
        }

        if (argument === "--version" || argument === "-v") {
            parsed.showVersion = true;
            continue;
        }

        if (argument === "--check") {
            parsed.checkOnly = true;
            continue;
        }
    }

    return parsed;
}

const HELP_TEXT = [
    `${SERVER_NAME} ${SERVER_VERSION} — MCP server for SSH command execution and SFTP transfers`,
    "",
    "Usage:",
    "  akms-mcp-ssh [--check]",
    "  akms-mcp-ssh config [--target <client>]",
    "",
    "Commands:",
    "  config               Manage the SSH hosts registered in an MCP client's config —",
    "                       list, add, edit, remove, check, print. Asks plain questions,",
    "                       so the SSH_* names below never have to be typed.",
    "",
    "Options:",
    "      --check          Connect to the configured host, report the result, and exit.",
    "                       Prints the host key fingerprint so it can be pinned.",
    "      --target <id>    config: claude-code | codex | claude-desktop | cursor",
    "                       (default: the first one installed)",
    "  -v, --version        Print the version and exit",
    "  -h, --help           Print this help and exit",
    "",
    "Environment — one server entry per host, set in the MCP client's env block:",
    `  ${SINGLE_HOST_ENV.HOST}          Hostname or IP  (required)`,
    `  ${SINGLE_HOST_ENV.USER}          Login user      (required)`,
    `  ${SINGLE_HOST_ENV.PORT}          Default 22`,
    `  ${SINGLE_HOST_ENV.KEY}           Path to a private key file, '~' expanded`,
    `  ${SINGLE_HOST_ENV.PASSPHRASE}    Key passphrase`,
    `  ${SINGLE_HOST_ENV.PASSWORD}      Password auth, when no key is used`,
    `  ${SINGLE_HOST_ENV.HOST_KEY}      Pinned host key, 'SHA256:…'; a mismatch aborts the connection`,
    `  ${SINGLE_HOST_ENV.NAME}          Alias shown to the model; defaults to the hostname`,
    `  ${SINGLE_HOST_ENV.DESCRIPTION}   Shown to the model — say what the host is for`,
    `  ${SINGLE_HOST_ENV.CWD}           Directory new sessions start in`,
    `  ${SINGLE_HOST_ENV.PROXY_COMMAND} Command carrying the SSH stream on its stdin/stdout (OpenSSH ProxyCommand);`,
    "                     %h / %p / %r expand to the first hop's host, port and user",
    `  ${SINGLE_HOST_ENV.JUMP_HOST}     Jump host the target is reached through (OpenSSH ProxyJump / -J)`,
    `  ${SINGLE_HOST_ENV.JUMP_PORT} / ${SINGLE_HOST_ENV.JUMP_USER} / ${SINGLE_HOST_ENV.JUMP_KEY} / ${SINGLE_HOST_ENV.JUMP_PASSPHRASE} / ${SINGLE_HOST_ENV.JUMP_PASSWORD} / ${SINGLE_HOST_ENV.JUMP_HOST_KEY}`,
    `                     Jump host connection; user and key default to ${SINGLE_HOST_ENV.USER} / ${SINGLE_HOST_ENV.KEY}`,
    `  ${SINGLE_HOST_ENV.READONLY}      Reject write commands, redirections, uploads  (default false)`,
    `  ${SINGLE_HOST_ENV.ALLOW_SUDO}    Allow sudo / su / doas  (default true)`,
    `  ${SINGLE_HOST_ENV.ALLOW_COMMANDS}  Comma-separated allow-list of binaries`,
    `  ${SINGLE_HOST_ENV.DENY_PATTERNS}   Comma-separated extra deny regexes`,
    `  ${SINGLE_HOST_ENV.ALLOWED_PATHS}   Comma-separated path prefixes the file tools may touch`,
    `  ${SINGLE_HOST_ENV.EXEC_TIMEOUT_MS} / ${SINGLE_HOST_ENV.CONNECT_TIMEOUT_MS}`,
    `  ${SINGLE_HOST_ENV.MAX_OUTPUT_CHARACTERS} / ${SINGLE_HOST_ENV.MAX_READ_FILE_BYTES}`,
    `  ${LOG_LEVEL_ENV}  silent | debug | info | warn | error  (default: info, written to stderr)`,
    "",
    "The server speaks MCP over stdio; run it from an MCP client, not interactively.",
].join("\n");

/**
 * `--check`: connects to the configured host and reports what happened. The report itself
 * is shared with `config`, so a host that passes setup passes `--check`. Writes to stdout
 * because this mode is not an MCP session.
 *
 * @returns Process exit code: 0 when the host is reachable.
 */
async function runCheckCommand(profile: SshHostProfile | null): Promise<number> {
    if (profile == null) {
        process.stdout.write(`No SSH host is registered — set ${SINGLE_HOST_ENV.HOST} and ${SINGLE_HOST_ENV.USER}, or run: akms-mcp-ssh config
`);
        return 1;
    }

    const result = await runConnectionCheck(profile, process.stdout);
    if (result.connected == true) {
        return 0;
    }

    return 1;
}

async function main(): Promise<void> {
    const _logger = $logger.child({ context: "cli" });

    const cliArguments = parseArguments(process.argv.slice(2));

    if (cliArguments.showHelp == true) {
        process.stderr.write(`${HELP_TEXT}\n`);
        return;
    }

    if (cliArguments.showVersion == true) {
        process.stderr.write(`${SERVER_VERSION}\n`);
        return;
    }

    if (cliArguments.configMode == true) {
        // The manager is a terminal UI: log lines on stderr would land in the middle of a
        // prompt. Warnings stay — a missing key file is worth seeing during setup.
        if (process.env[LOG_LEVEL_ENV] == null) {
            process.env[LOG_LEVEL_ENV] = "warn";
        }

        const exitCode = await runConfigCommand({
            input: process.stdin,
            output: process.stdout,
            targetId: cliArguments.targetId,
        });
        process.exit(exitCode);
    }

    // `--check` prints a report a person reads; routine log lines interleaved with it
    // make it unreadable, so only warnings and errors get through — a missing key file,
    // or a proxy command's stderr, which is where a `cloudflared` login prompt appears.
    // An explicit level still wins, so `SSH_MCP_LOG_LEVEL=debug --check` stays available
    // for diagnosing a connection that fails for an unclear reason.
    if (cliArguments.checkOnly == true && process.env[LOG_LEVEL_ENV] == null) {
        process.env[LOG_LEVEL_ENV] = "warn";
    }

    const instance = createSshMcpServer();

    if (cliArguments.checkOnly == true) {
        const exitCode = await runCheckCommand(instance.profile);
        instance.shutdown();
        process.exit(exitCode);
    }

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown == true) {
            return;
        }
        shuttingDown = true;

        _logger.info("shutting down", { signal: signal });
        instance.shutdown();
        void instance.server.close().finally(() => {
            process.exit(0);
        });
    };

    process.on("SIGINT", () => {
        shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
        shutdown("SIGTERM");
    });

    // stdin closing means the MCP client is gone; without this the process would linger
    // holding every open SSH connection.
    process.stdin.on("close", () => {
        shutdown("stdin-close");
    });

    const transport = new StdioServerTransport();
    await instance.server.connect(transport);

    _logger.info("mcp server ready on stdio", {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        profile: instance.profile?.name ?? null,
    });
}

main().catch((error: unknown) => {
    const _logger = $logger.child({ context: "cli" });
    _logger.error(error, "mcp server failed to start");

    // Printed independently of the logger: `--check` silences it, and a setup mistake
    // that exits 1 with no explanation is the worst possible first-run experience.
    let detail = String(error);
    if (error instanceof Error) {
        detail = error.message;
    }

    process.stderr.write(`akms-mcp-ssh: ${detail}\n`);
    process.exit(1);
});
