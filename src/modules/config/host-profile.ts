import fs from "node:fs";

import {
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_CHARACTERS,
    DEFAULT_MAX_READ_FILE_BYTES,
    DEFAULT_SSH_PORT,
    FALSY_ENV_VALUES,
    SINGLE_HOST_ENV,
    TRUTHY_ENV_VALUES,
} from "@/_defs";
import { $logger, expandHomePath } from "@/_libs";
import type { SshHostProfile, SshHostSummary, SshPolicy } from "@/_types";

/** Trimmed value, or undefined when the variable is unset or blank. */
function readEnv(name: string): string | undefined {
    const value = process.env[name];
    if (value == null) {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed === "") {
        return undefined;
    }

    return trimmed;
}

/**
 * @throws {Error} If the value is set but is neither a truthy nor a falsy spelling —
 *                 `SSH_READONLY=ture` must fail loudly, not resolve to "not read-only".
 */
function readBooleanEnv(name: string): boolean | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const normalized = value.toLowerCase();
    if (TRUTHY_ENV_VALUES.includes(normalized) == true) {
        return true;
    }

    if (FALSY_ENV_VALUES.includes(normalized) == false) {
        throw new Error(`${name} must be one of ${[...TRUTHY_ENV_VALUES, ...FALSY_ENV_VALUES].join(", ")} (got "${value}")`);
    }

    return false;
}

/**
 * @throws {Error} If the value is set but is not a positive integer.
 */
function readIntegerEnv(name: string): number | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const parsed = Number(value);
    if (Number.isInteger(parsed) == false || parsed <= 0) {
        throw new Error(`${name} must be a positive integer (got "${value}")`);
    }

    return parsed;
}

/** Comma-separated list, blanks dropped. */
function readListEnv(name: string): string[] | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.length === 0) {
        return undefined;
    }

    return items;
}

/**
 * Compiles `SSH_DENY_PATTERNS` at startup.
 *
 * Lazily compiling them at first use meant a typo'd regex logged one stderr line and then
 * simply wasn't in force — the operator's own deny rule, silently absent, on a server that
 * reported "host profile loaded". Every other malformed value aborts startup; so does this.
 *
 * @throws {Error} If a pattern is not a valid regular expression.
 */
function compileDenyPatterns(sources: string[]): RegExp[] {
    return sources.map((source) => {
        try {
            return new RegExp(source, "i");
        }
        catch (ex) {
            const _logger = $logger.child({ context: "compileDenyPatterns" });
            _logger.error(ex, "denyPatterns entry is not a valid regular expression");

            let detail = String(ex);
            if (ex instanceof Error) {
                detail = ex.message;
            }

            throw new Error(`${SINGLE_HOST_ENV.DENY_PATTERNS} has an invalid entry /${source}/: ${detail}`);
        }
    });
}

/**
 * Builds the host profile from the `SSH_*` variables, or null when `SSH_HOST` is unset.
 *
 * One MCP server entry fronts one host, so every setting is a plain variable — no JSON
 * inside JSON, no escaped quotes, and a typo shows up on the line it is on. A malformed
 * value aborts startup rather than being ignored, because silently dropping `SSH_READONLY`
 * would leave a host the operator believed was read-only fully writable.
 *
 * Flow:
 *  1) Guard: no `SSH_HOST` means nothing is registered — the server still starts and says so
 *  2) Resolve the policy over the built-in permissive stance; each variable is opt-in restriction
 *  3) Assemble the connection fields
 *  4) Expand the private key path and check it exists
 *
 * @throws {Error} If `SSH_HOST` is set without `SSH_USER`, or a typed value is malformed.
 */
export function loadHostProfile(): SshHostProfile | null {
    // (1) Guard — a missing host is not an error: the server reports "not configured"
    // through the tools, which is a far clearer signal to the model than a dead server.
    const host = readEnv(SINGLE_HOST_ENV.HOST);
    if (host == null) {
        const _startupLogger = $logger.child({ context: "loadHostProfile" });
        _startupLogger.warn("no host is registered; set the connection variables and restart", {
            env_vars: [SINGLE_HOST_ENV.HOST, SINGLE_HOST_ENV.USER],
        });
        return null;
    }

    const username = readEnv(SINGLE_HOST_ENV.USER);
    if (username == null) {
        throw new Error(`${SINGLE_HOST_ENV.HOST} is set, so ${SINGLE_HOST_ENV.USER} is required`);
    }

    const name = readEnv(SINGLE_HOST_ENV.NAME) ?? host;
    const _logger = $logger.child({ context: "loadHostProfile", profile: name });

    // (2) Policy — the built-in stance is permissive: an unconfigured host allows
    // everything except the catastrophe rules, because a guard nobody can work through
    // gets turned off wholesale rather than tuned.
    const allowCommands = readListEnv(SINGLE_HOST_ENV.ALLOW_COMMANDS) ?? [];

    // `ssh_connect` probes with `pwd` to settle the session's starting directory; without
    // this an allow-list profile could never open a session at all.
    if (allowCommands.length > 0 && allowCommands.includes("pwd") == false) {
        allowCommands.push("pwd");
    }

    const policy: SshPolicy = {
        readonly: readBooleanEnv(SINGLE_HOST_ENV.READONLY) ?? false,
        allowSudo: readBooleanEnv(SINGLE_HOST_ENV.ALLOW_SUDO) ?? true,
        execTimeoutMs: readIntegerEnv(SINGLE_HOST_ENV.EXEC_TIMEOUT_MS) ?? DEFAULT_EXEC_TIMEOUT_MS,
        connectTimeoutMs: readIntegerEnv(SINGLE_HOST_ENV.CONNECT_TIMEOUT_MS) ?? DEFAULT_CONNECT_TIMEOUT_MS,
        maxOutputCharacters: readIntegerEnv(SINGLE_HOST_ENV.MAX_OUTPUT_CHARACTERS) ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
        maxReadFileBytes: readIntegerEnv(SINGLE_HOST_ENV.MAX_READ_FILE_BYTES) ?? DEFAULT_MAX_READ_FILE_BYTES,
        allowCommands: allowCommands,
        denyPatterns: compileDenyPatterns(readListEnv(SINGLE_HOST_ENV.DENY_PATTERNS) ?? []),
        allowedPaths: readListEnv(SINGLE_HOST_ENV.ALLOWED_PATHS) ?? [],
    };

    // (3) Connection
    const profile: SshHostProfile = {
        name: name,
        host: host,
        port: readIntegerEnv(SINGLE_HOST_ENV.PORT) ?? DEFAULT_SSH_PORT,
        username: username,
        description: readEnv(SINGLE_HOST_ENV.DESCRIPTION),
        passphrase: readEnv(SINGLE_HOST_ENV.PASSPHRASE),
        password: readEnv(SINGLE_HOST_ENV.PASSWORD),
        hostKeyFingerprint: readEnv(SINGLE_HOST_ENV.HOST_KEY),
        defaultCwd: readEnv(SINGLE_HOST_ENV.CWD),
        policy: policy,
    };

    // (4) Key path — checked at load, not at first use: a typo would otherwise surface as
    // a connection failure minutes later, with the path withheld from the message.
    const keyPath = readEnv(SINGLE_HOST_ENV.KEY);
    if (keyPath != null) {
        const expandedKeyPath = expandHomePath(keyPath);
        profile.privateKeyPath = expandedKeyPath;

        if (fs.existsSync(expandedKeyPath) == false) {
            _logger.warn(`${SINGLE_HOST_ENV.KEY} does not exist; connections will fail`, {
                private_key_path: expandedKeyPath,
            });
        }
    }

    _logger.info("host profile loaded", {
        host: host,
        port: profile.port,
        username: username,
        readonly: policy.readonly,
    });

    return profile;
}

/** Strips every secret so the profile can be described back to the model. */
export function toHostSummary(profile: SshHostProfile): SshHostSummary {
    let authMethod: SshHostSummary["authMethod"] = "agent";
    if (profile.privateKeyPath != null) {
        authMethod = "privateKey";
    }
    else if (profile.password != null) {
        authMethod = "password";
    }

    return {
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        description: profile.description,
        authMethod: authMethod,
        readonly: profile.policy.readonly,
        allowSudo: profile.policy.allowSudo,
        allowedPaths: profile.policy.allowedPaths,
        allowCommands: profile.policy.allowCommands,
    };
}
