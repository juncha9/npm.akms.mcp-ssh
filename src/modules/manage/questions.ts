import fs from "node:fs";

import { DEFAULT_SSH_PORT } from "@/_defs";
import { expandHomePath } from "@/_libs";
import type { HostAuthMethod, HostSetupAnswers } from "@/_types";

import { SERVER_NAME_PATTERN } from "./entry";
import type { Prompter } from "./prompter";

/** Typed with `~` so the entry stays portable; checked for existence after expansion. */
const DEFAULT_KEY_CANDIDATES = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"];

/** The answer that clears an optional value an edit pre-filled, since Enter keeps it. */
const CLEAR_ANSWER = "-";

async function askPort(prompter: Prompter, question: string, current: number): Promise<number> {
    for (;;) {
        const answer = await prompter.ask(question, String(current));
        const parsed = Number(answer);
        if (Number.isInteger(parsed) == true && parsed > 0 && parsed <= 65535) {
            return parsed;
        }

        prompter.write("  Enter a port number between 1 and 65535.\n");
    }
}

/** Optional free text: Enter keeps `current`, `-` clears it. */
async function askOptional(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    const answer = await prompter.ask(question, current);
    if (answer === "" || answer === CLEAR_ANSWER) {
        return undefined;
    }

    return answer;
}

/**
 * Secret with three outcomes: a new value, keep the existing one (Enter when one exists),
 * or none. Shown as "[keep current]" rather than echoing the secret back.
 */
async function askOptionalSecret(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    let suffix = " (empty for none)";
    if (current != null) {
        suffix = ` [keep current, ${CLEAR_ANSWER} to clear]`;
    }

    const answer = await prompter.askSecret(`${question}${suffix}`);
    if (answer === CLEAR_ANSWER) {
        return undefined;
    }

    if (answer === "") {
        return current;
    }

    return answer;
}

/**
 * The wizard. Every prompt is a plain question; the `SSH_*` names never appear. With
 * `existing` set (an edit) each prompt defaults to the current value.
 *
 * Flow:
 *  1) Endpoint — host, port, user, the name the agent sees
 *  2) Auth — key (path checked on disk) / password (warned: plain text) / agent
 *  3) Route — jump host, proxy command
 *  4) Agent-facing — description
 *  5) Policy — read-only, allowed paths
 */
export async function askHostQuestions(prompter: Prompter, existing?: HostSetupAnswers): Promise<HostSetupAnswers> {
    if (existing != null) {
        prompter.write(`  Enter keeps the value in brackets; ${CLEAR_ANSWER} clears an optional one.\n\n`);
    }

    // (1) Endpoint
    const host = await prompter.askRequired("Host (hostname or IP)", existing?.host);
    const port = await askPort(prompter, "Port", existing?.port ?? DEFAULT_SSH_PORT);
    const username = await prompter.askRequired("Login user", existing?.username);

    let name = "";
    const defaultName = existing?.name ?? `ssh-${host}`.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48);
    for (;;) {
        name = await prompter.askRequired("Server name the agent sees", defaultName);
        if (SERVER_NAME_PATTERN.test(name) == true) {
            break;
        }

        prompter.write("  Use letters, digits, '-' and '_' only (max 48) — the name becomes part of every tool name.\n");
    }

    // (2) Auth
    const auth = await prompter.askChoice<HostAuthMethod>(
        "Authentication",
        [
            { key: "key", label: "private key file  (recommended — only the path is stored)" },
            { key: "password", label: "password  (stored in the config file in plain text)" },
            { key: "agent", label: "ssh agent  (SSH_AUTH_SOCK / OpenSSH agent pipe)" },
        ],
        existing?.auth ?? "key",
    );

    let keyPath: string | undefined;
    let passphrase: string | undefined;
    let password: string | undefined;

    if (auth === "key") {
        let defaultKeyPath = existing?.keyPath;
        if (defaultKeyPath == null) {
            defaultKeyPath = DEFAULT_KEY_CANDIDATES.find((candidate) => fs.existsSync(expandHomePath(candidate)) == true);
        }

        for (;;) {
            keyPath = await prompter.askRequired("Private key path", defaultKeyPath);
            if (fs.existsSync(expandHomePath(keyPath)) == true) {
                break;
            }

            prompter.write(`  ${expandHomePath(keyPath)} does not exist.\n`);
            const useAnyway = await prompter.askYesNo("Use this path anyway?", false);
            if (useAnyway == true) {
                break;
            }
        }

        passphrase = await askOptionalSecret(prompter, "Key passphrase", existing?.passphrase);
    }

    if (auth === "password") {
        prompter.write("  The password is written into the config file as plain text. A key file is safer.\n");
        password = await askOptionalSecret(prompter, "Password", existing?.password);
        if (password == null) {
            // "none" makes no sense for password auth; agent is the closest honest fallback.
            prompter.write("  No password given — falling back to the ssh agent.\n");
        }
    }

    // (3) Route
    let jumpHost: string | undefined;
    let jumpPort: number | undefined;
    let jumpUser: string | undefined;

    const viaJump = await prompter.askYesNo("Reach it through a jump host (ssh -J)?", existing?.jumpHost != null);
    if (viaJump == true) {
        jumpHost = await prompter.askRequired("Jump host", existing?.jumpHost);
        jumpPort = await askPort(prompter, "Jump host port", existing?.jumpPort ?? DEFAULT_SSH_PORT);
        jumpUser = await prompter.askRequired("Jump host user", existing?.jumpUser ?? username);
    }

    let proxyCommand: string | undefined;
    const viaProxy = await prompter.askYesNo("Start a proxy command for the first hop (e.g. cloudflared)?", existing?.proxyCommand != null);
    if (viaProxy == true) {
        prompter.write("  %h / %p / %r expand to the first hop's host, port and user.\n");
        proxyCommand = await prompter.askRequired("Proxy command", existing?.proxyCommand ?? "cloudflared access ssh --hostname %h");
    }

    // (4) Agent-facing
    const description = await askOptional(prompter, "Description shown to the agent (what the host is for)", existing?.description);

    // (5) Policy
    const readonly = await prompter.askYesNo("Read-only? (rejects writes, redirections, uploads)", existing?.readonly ?? false);

    let currentAllowedPaths: string | undefined;
    if (existing != null && existing.allowedPaths.length > 0) {
        currentAllowedPaths = existing.allowedPaths.join(",");
    }

    let allowedPaths: string[] = [];
    const allowedPathsAnswer = await askOptional(
        prompter,
        "Restrict file tools to these path prefixes (comma-separated, empty = unrestricted)",
        currentAllowedPaths,
    );
    if (allowedPathsAnswer != null) {
        allowedPaths = allowedPathsAnswer.split(",").map((item) => item.trim()).filter((item) => item !== "");
    }

    let resolvedAuth = auth;
    if (auth === "password" && password == null) {
        resolvedAuth = "agent";
    }

    const answers: HostSetupAnswers = {
        name: name,
        host: host,
        port: port,
        username: username,
        auth: resolvedAuth,
        keyPath: keyPath,
        passphrase: passphrase,
        password: password,
        description: description,
        jumpHost: jumpHost,
        jumpPort: jumpPort,
        jumpUser: jumpUser,
        proxyCommand: proxyCommand,
        readonly: readonly,
        allowedPaths: allowedPaths,
        extraEnv: existing?.extraEnv ?? {},
    };

    // A pinned key belongs to a specific endpoint; keep it only while that endpoint stands.
    if (existing != null && existing.host === host && existing.port === port) {
        answers.hostKeyFingerprint = existing.hostKeyFingerprint;
    }
    if (existing != null && existing.jumpHost === jumpHost && existing.jumpPort === jumpPort) {
        answers.jumpHostKeyFingerprint = existing.jumpHostKeyFingerprint;
    }

    return answers;
}
