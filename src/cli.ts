#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LOG_LEVEL_ENV, SERVER_NAME, SERVER_VERSION, SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshHostProfile } from "@/_types";
import { SshConnection } from "@/modules/ssh";
import { createSshMcpServer } from "@/server";

interface CliArguments {
    showHelp: boolean;
    showVersion: boolean;
    checkOnly: boolean;
}

function parseArguments(argv: string[]): CliArguments {
    const parsed: CliArguments = { showHelp: false, showVersion: false, checkOnly: false };

    for (const argument of argv) {
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
    "",
    "Options:",
    "      --check          Connect to the configured host, report the result, and exit.",
    "                       Prints the host key fingerprint so it can be pinned.",
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
 * How the host will authenticate, including the key path.
 *
 * The path is shown here but withheld from the runtime error message: `--check` is run by
 * the operator on their own terminal, whereas that message is handed to a model.
 */
function describeAuth(profile: SshHostProfile): string {
    if (profile.privateKeyPath != null) {
        return `key ${profile.privateKeyPath}`;
    }

    if (profile.password != null) {
        return "password";
    }

    return "ssh agent";
}

/**
 * Connects to the configured host and reports what happened.
 *
 * Without this the only way to find out whether the setup works is to ask an agent to try
 * something, which mixes a setup mistake up with a policy rejection. Writes to stdout
 * because this mode is not an MCP session.
 *
 * @returns Process exit code: 0 when the host is reachable.
 */
async function runConnectionCheck(profile: SshHostProfile | null): Promise<number> {
    if (profile == null) {
        process.stdout.write(`No SSH host is registered — set ${SINGLE_HOST_ENV.HOST} and ${SINGLE_HOST_ENV.USER}.\n`);
        return 1;
    }

    const endpoint = `${profile.username}@${profile.host}:${profile.port}`;
    const auth = describeAuth(profile);
    process.stdout.write(`Checking ${profile.name}  →  ${endpoint}\n\n`);

    const connection = new SshConnection(profile);
    const startedAt = Date.now();

    let connected = false;
    let detail = "";

    try {
        await connection.connect();
        connected = true;
    }
    catch (ex) {
        detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
    }
    finally {
        connection.disconnect();
    }

    const durationMs = Date.now() - startedAt;

    if (connected == true) {
        process.stdout.write(`  OK      ${endpoint}  (${auth}, ${durationMs}ms)\n`);
    }
    else {
        process.stdout.write(`  FAILED  ${endpoint}  (${auth})\n`);
        process.stdout.write(`          ${detail}\n`);
    }

    if (connection.hostKeyFingerprint != null) {
        let pinNote = `not pinned — set ${SINGLE_HOST_ENV.HOST_KEY} to it to detect a changed key`;
        if (profile.hostKeyFingerprint != null) {
            pinNote = "pinned";
        }

        process.stdout.write(`          host key ${connection.hostKeyFingerprint}  (${pinNote})\n`);
    }

    if (connected == true) {
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

    // `--check` prints a report a person reads; interleaved log lines make it unreadable.
    // An explicit level still wins, so `SSH_MCP_LOG_LEVEL=debug --check` stays available
    // for diagnosing a connection that fails for an unclear reason.
    if (cliArguments.checkOnly == true && process.env[LOG_LEVEL_ENV] == null) {
        process.env[LOG_LEVEL_ENV] = "silent";
    }

    const instance = createSshMcpServer();

    if (cliArguments.checkOnly == true) {
        const exitCode = await runConnectionCheck(instance.profile);
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
