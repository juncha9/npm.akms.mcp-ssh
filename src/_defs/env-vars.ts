/**
 * Environment variables that define the host, one MCP server entry per host.
 *
 * This is the only way to configure the server. Each variable is a plain value, so an
 * MCP client's `env` block reads like a connection form — no JSON inside JSON, no
 * escaped quotes, and a typo shows up on the line it is on.
 */
export const SINGLE_HOST_ENV = {
    /** Presence of this variable is what registers a host at all. */
    HOST: "SSH_HOST",
    PORT: "SSH_PORT",
    USER: "SSH_USER",
    /** Path to a private key file. */
    KEY: "SSH_KEY",
    PASSPHRASE: "SSH_PASSPHRASE",
    PASSWORD: "SSH_PASSWORD",
    /** Pinned host key, `SHA256:…`. */
    HOST_KEY: "SSH_HOST_KEY",
    /** Alias shown to the model; defaults to the hostname. */
    NAME: "SSH_NAME",
    DESCRIPTION: "SSH_DESCRIPTION",
    /** Directory new sessions start in. */
    CWD: "SSH_CWD",
    READONLY: "SSH_READONLY",
    ALLOW_SUDO: "SSH_ALLOW_SUDO",
    /** Comma-separated binary names. */
    ALLOW_COMMANDS: "SSH_ALLOW_COMMANDS",
    /** Comma-separated regex sources. */
    DENY_PATTERNS: "SSH_DENY_PATTERNS",
    /** Comma-separated absolute path prefixes. */
    ALLOWED_PATHS: "SSH_ALLOWED_PATHS",
    EXEC_TIMEOUT_MS: "SSH_EXEC_TIMEOUT_MS",
    CONNECT_TIMEOUT_MS: "SSH_CONNECT_TIMEOUT_MS",
    MAX_OUTPUT_CHARACTERS: "SSH_MAX_OUTPUT",
    MAX_READ_FILE_BYTES: "SSH_MAX_READ_BYTES",
} as const;

/** Accepted spellings for a true boolean env value. */
export const TRUTHY_ENV_VALUES = ["true", "1", "yes", "on"];

/** Accepted spellings for a false boolean env value. */
export const FALSY_ENV_VALUES = ["false", "0", "no", "off"];
