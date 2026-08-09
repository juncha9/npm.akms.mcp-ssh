import type { SshHostProfile, SshPolicy } from "@/_types";

/**
 * Shared fixtures. Not a `*.test.ts` file, so vitest does not collect it — the five
 * copies of this factory that used to live in the test files drifted apart and made
 * adding an `SshPolicy` field a five-file edit.
 */

/** Default profile: permissive, matching what an unconfigured host resolves to. */
export function createPolicy(overrides?: Partial<SshPolicy>): SshPolicy {
    return {
        readonly: false,
        allowSudo: true,
        execTimeoutMs: 60_000,
        connectTimeoutMs: 20_000,
        maxOutputCharacters: 100_000,
        maxReadFileBytes: 200_000,
        allowCommands: [],
        denyPatterns: [],
        allowedPaths: [],
        ...overrides,
    };
}

export function createProfile(overrides?: Partial<SshHostProfile>): SshHostProfile {
    return {
        name: "mock",
        host: "127.0.0.1",
        port: 22,
        username: "tester",
        password: "pw",
        policy: createPolicy(),
        ...overrides,
    };
}

/** Compiles deny-pattern sources the way `resolvePolicy` does at config load. */
export function denyPatterns(...sources: string[]): RegExp[] {
    return sources.map((source) => new RegExp(source, "i"));
}
