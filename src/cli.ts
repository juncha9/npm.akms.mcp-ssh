#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LOG_LEVEL_ENV, SERVER_NAME, SERVER_VERSION, SHUTDOWN_DEADLINE_MS, SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshHostProfile } from "@/_types";
import { runConnectionCheck, runConfigCommand } from "@/modules/manage";
import { createSshCatalogServer, createSshMcpServer } from "@/server";

interface CliArguments {
    showHelp: boolean;
    showVersion: boolean;
    checkOnly: boolean;
    catalogMode: boolean;
    /** `config` as the first argument opens the host manager instead of the server. */
    configMode: boolean;
    managementMode?: "config" | "register" | "sync";
    /** `--target <id>` — the client `config` opens on. */
    targetId?: string;
}

function parseArguments(argv: string[]): CliArguments {
    const parsed: CliArguments = { showHelp: false, showVersion: false, checkOnly: false, configMode: false, catalogMode: false };

    let rest = argv;
    if(["config", "register", "sync"].includes(argv[0])) {
        parsed.configMode = true;
        parsed.managementMode = argv[0] as "config" | "register" | "sync";
        rest = argv.slice(1);
    }

    for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if(argument === "--catalog") { parsed.catalogMode = true; continue; }

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

    if(parsed.catalogMode && (parsed.checkOnly || parsed.configMode || parsed.targetId !== undefined)) throw new Error("--catalog cannot be combined with --check, management commands or --target.");
    return parsed;
}

const HELP_TEXT = [
    `${SERVER_NAME} ${SERVER_VERSION} — MCP server for SSH command execution and SFTP transfers`,
    "",
    "Usage:",
    "  akms-mcp-ssh [--check]",
    "  akms-mcp-ssh --catalog           Load SSH connections from the shared registry",
    "  akms-mcp-ssh config [--target <client>]",
    "  akms-mcp-ssh register          Register AI services for all AKMS connections",
    "  akms-mcp-ssh sync              Review differences and retry pending changes",
    "",
    "Commands:",
    "  config               Manage the SSH hosts in the shared AKMS catalog —",
    "                       list, add, edit, remove, check, print. Asks plain questions,",
    "                       so the SSH_* names below never have to be typed.",
    "",
    "Options:",
    "      --check          Connect to the configured host, report the result, and exit.",
    "                       Prints the host key fingerprint so it can be pinned.",
    "      --target <id>    config: claude-code | codex | claude-desktop | cursor",
    "                       (preselects a service in Register; saves apply to all registered services)",
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
    "Catalog: ~/.akms/mcp/registry.json (or $AKMS_MCP_HOME/registry.json) stores settings and passwords in plaintext.",
].join("\n");

/**
 * `--check`: connects to the configured host and reports what happened. The report itself
 * is shared with `config`, so a host that passes the configuration check passes `--check`.
 * Writes to stdout because this mode is not an MCP session.
 *
 * @returns Process exit code: 0 when the host is reachable.
 */
async function runCheckCommand(profile: SshHostProfile | null): Promise<number> {
    if (profile == null) {
        process.stdout.write(`No SSH host is registered — set ${SINGLE_HOST_ENV.HOST} and ${SINGLE_HOST_ENV.USER}, or run: akms-mcp-ssh config\n`);
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

    if (process.argv[2] === "setup") {
        process.stderr.write("The setup command has been removed. Use akms-mcp-ssh config.\n");
        process.exitCode = 1;
        return;
    }

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
        // prompt. Warnings stay — a missing key file is worth seeing during configuration.
        if (process.env[LOG_LEVEL_ENV] == null) {
            process.env[LOG_LEVEL_ENV] = "warn";
        }

        const exitCode = await runConfigCommand({
            input: process.stdin,
            output: process.stdout,
            targetId: cliArguments.targetId,
            mode: cliArguments.managementMode,
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

    const instance = cliArguments.catalogMode ? createSshCatalogServer() : createSshMcpServer();

    if (cliArguments.checkOnly == true) {
        const exitCode = await runCheckCommand(instance.profile);
        instance.shutdown();
        process.exit(exitCode);
    }

    // A stray error in one session must not take every tool of this client down with it. The logger's
    // stderr guard is what keeps this from looping when the failure is the log channel itself.
    process.on("uncaughtException", (error) => {
        _logger.error(error, "uncaught exception; the server keeps running");
    });
    process.on("unhandledRejection", (reason) => {
        _logger.error(reason, "unhandled rejection; the server keeps running");
    });

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown == true) {
            return;
        }
        shuttingDown = true;

        _logger.info("shutting down", { signal: signal });
        // closeAll() ends every ssh2 client and server.close() waits for the transport; neither should take
        // long, and a peer that is already gone must not keep the process alive. unref: a shutdown that
        // finishes earlier exits through its own process.exit, not through this timer
        setTimeout(() => {
            _logger.warn("shutdown did not finish in time; exiting anyway", { deadline_ms: SHUTDOWN_DEADLINE_MS });
            process.exit(0);
        }, SHUTDOWN_DEADLINE_MS).unref();
        void Promise.resolve(instance.shutdown()).catch((error) => {
            _logger.error(error, "shutdown failed");
        }).finally(() => instance.server.close().finally(() => { process.exit(0); }));
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

    // The pid is what an operator needs to find this server among a client's processes
    _logger.info("mcp server ready on stdio", {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        profile: instance.profile?.name ?? null,
        pid: process.pid,
        ...("connectionCount" in instance ? { connections: instance.connectionCount } : {}),
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
