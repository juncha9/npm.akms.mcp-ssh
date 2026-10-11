/** One `mcpServers` entry as every MCP client spells it: a stdio command plus its env block. */
export interface McpServerEntry {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export type HostAuthMethod = "key" | "password" | "agent";

/**
 * What the `setup` form collects for one host. `answersToEntry` turns it into `SSH_*`
 * variables and `entryToAnswers` reads an existing entry back, so an edit pre-fills.
 */
export interface HostSetupAnswers {
    /** The entry key — the name the agent sees in its tool list. */
    name: string;
    host: string;
    port: number;
    username: string;
    auth: HostAuthMethod;
    /** As typed, `~` kept — the entry stays portable across machines. */
    keyPath?: string;
    passphrase?: string;
    password?: string;
    description?: string;
    jumpHost?: string;
    jumpPort?: number;
    jumpUser?: string;
    proxyCommand?: string;
    readonly: boolean;
    allowedPaths: string[];
    hostKeyFingerprint?: string;
    jumpHostKeyFingerprint?: string;
    /** `SSH_*` variables the wizard does not ask about, carried through an edit untouched. */
    extraEnv: Record<string, string>;
}

export type ConfigTargetId = "claude-code" | "claude-desktop" | "codex" | "cursor";

export interface ConfigWriteResult {
    status: "written" | "unavailable";
    /** Where it went, or why it could not and what to do instead. */
    detail: string;
}

/** One MCP client's config: where its entries live and how to change them. */
export interface ConfigTarget {
    id: ConfigTargetId;
    label: string;
    /** The config file, as shown to the user. */
    location: string;
    /** True when the client's CLI is on PATH or its config file exists. */
    detected: boolean;
    /**
     * Every `mcpServers` entry in the file, ours or not; entries this package cannot parse
     * are skipped.
     *
     * @throws {Error} If the file exists but cannot be parsed.
     */
    readEntries(): Record<string, McpServerEntry>;
    writeEntry(name: string, entry: McpServerEntry): ConfigWriteResult;
    removeEntry(name: string): ConfigWriteResult;
}
