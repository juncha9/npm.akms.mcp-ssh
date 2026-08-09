/**
 * Guard rules applied to every command / file operation on the host.
 * Resolved at startup: the built-in permissive stance with each `SSH_*` variable applied over it.
 */
export interface SshPolicy {
    /** Blocks write-shaped commands, output redirection, uploads and remote writes. */
    readonly: boolean;
    /** When false, any segment starting with `sudo` / `su` / `doas` is rejected. */
    allowSudo: boolean;
    /** Per-command wall clock limit; the channel is killed once it elapses. */
    execTimeoutMs: number;
    /** TCP + handshake limit for opening the connection. */
    connectTimeoutMs: number;
    /** stdout and stderr are each truncated past this many characters. */
    maxOutputCharacters: number;
    /** Byte ceiling for `ssh_read_file`, guarding against dumping a huge log into context. */
    maxReadFileBytes: number;
    /** Allowed command binaries. Empty means "anything that no deny rule matches". */
    allowCommands: string[];
    /**
     * Extra deny rules, compiled at config load so an invalid pattern fails startup
     * instead of silently not being in force at the moment it matters.
     */
    denyPatterns: RegExp[];
    /** Remote path prefixes the file tools may touch. Empty means unrestricted. */
    allowedPaths: string[];
}

/** The registered host: where to connect, how to authenticate, what is permitted. */
export interface SshHostProfile {
    /** Alias shown to the model, from `SSH_NAME`; defaults to the hostname. */
    name: string;
    host: string;
    port: number;
    username: string;
    description?: string;
    /** Expanded absolute path to a private key file. */
    privateKeyPath?: string;
    passphrase?: string;
    password?: string;
    /**
     * Expected server host key, as `SHA256:…` — the string `ssh-keyscan` prints and this
     * server logs on first connect. When set, a mismatch aborts the connection.
     */
    hostKeyFingerprint?: string;
    /** Directory every session starts in; falls back to the login shell's default. */
    defaultCwd?: string;
    policy: SshPolicy;
}

/** Credential-free view of the profile, safe to hand back to the model. */
export interface SshHostSummary {
    name: string;
    host: string;
    port: number;
    username: string;
    description?: string;
    authMethod: "privateKey" | "password" | "agent";
    readonly: boolean;
    allowSudo: boolean;
    allowedPaths: string[];
    allowCommands: string[];
}
