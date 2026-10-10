import { DEFAULT_SSH_PORT, PACKAGE_NAME, SERVER_NAME, SINGLE_HOST_ENV, TRUTHY_ENV_VALUES } from "@/_defs";
import type { HostSetupAnswers, McpServerEntry } from "@/_types";

/**
 * The variables the wizard owns. Anything else under `SSH_*` (timeouts, deny patterns,
 * `SSH_NAME`, `SSH_CWD`, jump host credentials, …) is hand-edited and survives an edit
 * untouched — see `extraEnv`.
 */
const MANAGED_ENV_NAMES: string[] = [
    SINGLE_HOST_ENV.HOST,
    SINGLE_HOST_ENV.PORT,
    SINGLE_HOST_ENV.USER,
    SINGLE_HOST_ENV.KEY,
    SINGLE_HOST_ENV.PASSPHRASE,
    SINGLE_HOST_ENV.PASSWORD,
    SINGLE_HOST_ENV.DESCRIPTION,
    SINGLE_HOST_ENV.JUMP_HOST,
    SINGLE_HOST_ENV.JUMP_PORT,
    SINGLE_HOST_ENV.JUMP_USER,
    SINGLE_HOST_ENV.PROXY_COMMAND,
    SINGLE_HOST_ENV.READONLY,
    SINGLE_HOST_ENV.ALLOWED_PATHS,
    SINGLE_HOST_ENV.HOST_KEY,
    SINGLE_HOST_ENV.JUMP_HOST_KEY,
];

/** Prefix shared by every jump host variable; none of them may outlive `SSH_JUMP_HOST`. */
const JUMP_ENV_PREFIX = "SSH_JUMP_";

/**
 * Valid MCP server names. The name becomes part of every tool name the agent sees
 * (`mcp__<name>__ssh_exec`), and tool names allow only these characters.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

/** True for entries that launch this package — the only ones the `config` command manages. */
export function isOurEntry(entry: McpServerEntry): boolean {
    if (entry.args.includes(PACKAGE_NAME) == true) {
        return true;
    }

    const commandBase = entry.command.replace(/\\/g, "/").split("/").pop() ?? "";
    return commandBase === SERVER_NAME || commandBase.startsWith(`${SERVER_NAME}.`) == true;
}

/**
 * How the client launches the server. On native Windows `npx` is a `.cmd` shim that a
 * client spawning without a shell cannot start, so it goes behind `cmd /c` — the wrapper
 * Claude Code's own docs prescribe for npx servers on Windows.
 */
function launchCommand(): { command: string; args: string[] } {
    if (process.platform === "win32") {
        return { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_NAME] };
    }

    return { command: "npx", args: ["-y", PACKAGE_NAME] };
}

/**
 * Renders the answers as an entry. A value equal to the server's default is left out, so
 * the result reads like the README's examples rather than a dump of every variable.
 */
export function answersToEntry(answers: HostSetupAnswers): McpServerEntry {
    const env: Record<string, string> = {};

    env[SINGLE_HOST_ENV.HOST] = answers.host;
    if (answers.port !== DEFAULT_SSH_PORT) {
        env[SINGLE_HOST_ENV.PORT] = String(answers.port);
    }
    env[SINGLE_HOST_ENV.USER] = answers.username;

    if (answers.auth === "key" && answers.keyPath != null) {
        env[SINGLE_HOST_ENV.KEY] = answers.keyPath;
        if (answers.passphrase != null && answers.passphrase !== "") {
            env[SINGLE_HOST_ENV.PASSPHRASE] = answers.passphrase;
        }
    }

    if (answers.auth === "password" && answers.password != null) {
        env[SINGLE_HOST_ENV.PASSWORD] = answers.password;
    }

    if (answers.hostKeyFingerprint != null) {
        env[SINGLE_HOST_ENV.HOST_KEY] = answers.hostKeyFingerprint;
    }

    if (answers.description != null && answers.description !== "") {
        env[SINGLE_HOST_ENV.DESCRIPTION] = answers.description;
    }

    if (answers.jumpHost != null) {
        env[SINGLE_HOST_ENV.JUMP_HOST] = answers.jumpHost;
        if (answers.jumpPort != null && answers.jumpPort !== DEFAULT_SSH_PORT) {
            env[SINGLE_HOST_ENV.JUMP_PORT] = String(answers.jumpPort);
        }
        if (answers.jumpUser != null && answers.jumpUser !== answers.username) {
            env[SINGLE_HOST_ENV.JUMP_USER] = answers.jumpUser;
        }
        if (answers.jumpHostKeyFingerprint != null) {
            env[SINGLE_HOST_ENV.JUMP_HOST_KEY] = answers.jumpHostKeyFingerprint;
        }
    }

    if (answers.proxyCommand != null && answers.proxyCommand !== "") {
        env[SINGLE_HOST_ENV.PROXY_COMMAND] = answers.proxyCommand;
    }

    if (answers.readonly == true) {
        env[SINGLE_HOST_ENV.READONLY] = "true";
    }

    if (answers.allowedPaths.length > 0) {
        env[SINGLE_HOST_ENV.ALLOWED_PATHS] = answers.allowedPaths.join(",");
    }

    for (const [name, value] of Object.entries(answers.extraEnv)) {
        if (MANAGED_ENV_NAMES.includes(name) == true) {
            continue;
        }

        // A hand-set `SSH_JUMP_KEY` left behind after the jump host was removed would make
        // the server refuse to start — it reads a stray jump variable as a half-made entry.
        if (answers.jumpHost == null && name.startsWith(JUMP_ENV_PREFIX) == true) {
            continue;
        }

        env[name] = value;
    }

    const launch = launchCommand();
    return {
        command: launch.command,
        args: launch.args,
        env: env,
    };
}

function readPort(value: string | undefined): number {
    if (value == null) {
        return DEFAULT_SSH_PORT;
    }

    const parsed = Number(value);
    if (Number.isInteger(parsed) == false || parsed <= 0) {
        return DEFAULT_SSH_PORT;
    }

    return parsed;
}

function isTruthy(value: string | undefined): boolean {
    if (value == null) {
        return false;
    }

    return TRUTHY_ENV_VALUES.includes(value.trim().toLowerCase());
}

/** Reads an existing entry back into answers so the wizard can pre-fill an edit. */
export function entryToAnswers(name: string, entry: McpServerEntry): HostSetupAnswers {
    const env = entry.env;
    const host = env[SINGLE_HOST_ENV.HOST] ?? "";
    const username = env[SINGLE_HOST_ENV.USER] ?? "";

    let auth: HostSetupAnswers["auth"] = "agent";
    if (env[SINGLE_HOST_ENV.KEY] != null) {
        auth = "key";
    }
    else if (env[SINGLE_HOST_ENV.PASSWORD] != null) {
        auth = "password";
    }

    let allowedPaths: string[] = [];
    const allowedPathsValue = env[SINGLE_HOST_ENV.ALLOWED_PATHS];
    if (allowedPathsValue != null) {
        allowedPaths = allowedPathsValue.split(",").map((item) => item.trim()).filter((item) => item !== "");
    }

    const extraEnv: Record<string, string> = {};
    for (const [variable, value] of Object.entries(env)) {
        if (MANAGED_ENV_NAMES.includes(variable) == false) {
            extraEnv[variable] = value;
        }
    }

    const answers: HostSetupAnswers = {
        name: name,
        host: host,
        port: readPort(env[SINGLE_HOST_ENV.PORT]),
        username: username,
        auth: auth,
        keyPath: env[SINGLE_HOST_ENV.KEY],
        passphrase: env[SINGLE_HOST_ENV.PASSPHRASE],
        password: env[SINGLE_HOST_ENV.PASSWORD],
        description: env[SINGLE_HOST_ENV.DESCRIPTION],
        proxyCommand: env[SINGLE_HOST_ENV.PROXY_COMMAND],
        readonly: isTruthy(env[SINGLE_HOST_ENV.READONLY]),
        allowedPaths: allowedPaths,
        hostKeyFingerprint: env[SINGLE_HOST_ENV.HOST_KEY],
        extraEnv: extraEnv,
    };

    const jumpHost = env[SINGLE_HOST_ENV.JUMP_HOST];
    if (jumpHost != null) {
        answers.jumpHost = jumpHost;
        answers.jumpPort = readPort(env[SINGLE_HOST_ENV.JUMP_PORT]);
        answers.jumpUser = env[SINGLE_HOST_ENV.JUMP_USER] ?? username;
        answers.jumpHostKeyFingerprint = env[SINGLE_HOST_ENV.JUMP_HOST_KEY];
    }

    return answers;
}

/** One row of the host list: endpoint, auth, and the route / policy settings in force. */
export function summarizeEntry(entry: McpServerEntry): { endpoint: string; auth: string; notes: string } {
    const env = entry.env;
    const host = env[SINGLE_HOST_ENV.HOST] ?? "?";
    const port = env[SINGLE_HOST_ENV.PORT] ?? String(DEFAULT_SSH_PORT);
    const username = env[SINGLE_HOST_ENV.USER] ?? "?";

    let auth = "agent";
    if (env[SINGLE_HOST_ENV.KEY] != null) {
        auth = "key";
    }
    else if (env[SINGLE_HOST_ENV.PASSWORD] != null) {
        auth = "password";
    }

    const notes: string[] = [];
    if (env[SINGLE_HOST_ENV.JUMP_HOST] != null) {
        notes.push(`jump ${env[SINGLE_HOST_ENV.JUMP_HOST]}`);
    }
    if (env[SINGLE_HOST_ENV.PROXY_COMMAND] != null) {
        notes.push("proxy");
    }
    if (isTruthy(env[SINGLE_HOST_ENV.READONLY]) == true) {
        notes.push("readonly");
    }
    if (env[SINGLE_HOST_ENV.ALLOWED_PATHS] != null) {
        notes.push(`paths ${env[SINGLE_HOST_ENV.ALLOWED_PATHS]}`);
    }
    if (env[SINGLE_HOST_ENV.HOST_KEY] != null) {
        notes.push("pinned");
    }

    return {
        endpoint: `${username}@${host}:${port}`,
        auth: auth,
        notes: notes.join(", "),
    };
}
