import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHostProfile, toHostSummary } from "@/modules/config";

// Silences the stderr logger so the "no host is registered" warning doesn't pollute output.
process.env.SSH_MCP_LOG_LEVEL = "silent";

afterEach(() => {
    for (const name of Object.keys(process.env)) {
        // SSH_MCP_LOG_LEVEL shares the prefix but is this suite's own log setting.
        if (name.startsWith("SSH_") == true && name !== "SSH_MCP_LOG_LEVEL") {
            delete process.env[name];
        }
    }
});

describe("loadHostProfile — the minimum pair", () => {
    it("returns null when no host is registered", () => {
        expect(loadHostProfile()).toBeNull();
    });

    it("builds the profile from SSH_HOST and SSH_USER alone", () => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";

        const profile = loadHostProfile();

        expect(profile?.name).toBe("10.0.0.5");
        expect(profile?.username).toBe("deploy");
        expect(profile?.port).toBe(22);
    });

    it("names the profile after SSH_NAME when given", () => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";
        process.env.SSH_NAME = "prod-web";

        expect(loadHostProfile()?.name).toBe("prod-web");
    });

    it("requires SSH_USER alongside SSH_HOST", () => {
        process.env.SSH_HOST = "10.0.0.5";

        expect(() => loadHostProfile()).toThrow(/SSH_USER is required/);
    });
});

describe("loadHostProfile — defaults", () => {
    it("fills every policy field from the built-in defaults", () => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";

        const profile = loadHostProfile();

        expect(profile?.policy.readonly).toBe(false);
        // Permissive by default: restriction is opt-in, so an unconfigured host can do
        // ordinary administration including sudo.
        expect(profile?.policy.allowSudo).toBe(true);
        expect(profile?.policy.execTimeoutMs).toBe(60_000);
        expect(profile?.policy.connectTimeoutMs).toBe(20_000);
        expect(profile?.policy.maxOutputCharacters).toBe(100_000);
        expect(profile?.policy.maxReadFileBytes).toBe(200_000);
        expect(profile?.policy.allowCommands).toEqual([]);
        expect(profile?.policy.denyPatterns).toEqual([]);
        expect(profile?.policy.allowedPaths).toEqual([]);
    });
});

describe("loadHostProfile — variable mapping", () => {
    it("maps every connection and policy variable onto the profile", () => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";
        process.env.SSH_PORT = "2222";
        process.env.SSH_KEY = "~/.ssh/id_ed25519";
        process.env.SSH_HOST_KEY = "SHA256:abc123";
        process.env.SSH_DESCRIPTION = "prod web";
        process.env.SSH_CWD = "/opt/app";
        process.env.SSH_READONLY = "true";
        process.env.SSH_ALLOW_SUDO = "no";
        process.env.SSH_ALLOW_COMMANDS = "ls, cat ,tail";
        process.env.SSH_ALLOWED_PATHS = "/var/log,/opt/app";
        process.env.SSH_EXEC_TIMEOUT_MS = "5000";
        process.env.SSH_MAX_READ_BYTES = "1000";

        const profile = loadHostProfile();

        expect(profile?.port).toBe(2222);
        expect(profile?.hostKeyFingerprint).toBe("SHA256:abc123");
        expect(profile?.description).toBe("prod web");
        expect(profile?.defaultCwd).toBe("/opt/app");
        expect(profile?.policy.readonly).toBe(true);
        expect(profile?.policy.allowSudo).toBe(false);
        expect(profile?.policy.allowedPaths).toEqual(["/var/log", "/opt/app"]);
        expect(profile?.policy.execTimeoutMs).toBe(5_000);
        expect(profile?.policy.maxReadFileBytes).toBe(1_000);
    });

    it("expands ~ in SSH_KEY to an absolute path", () => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";
        process.env.SSH_KEY = "~/.ssh/id_ed25519";

        const keyPath = loadHostProfile()?.privateKeyPath;

        expect(keyPath).toBeDefined();
        expect(path.isAbsolute(keyPath as string)).toBe(true);
        expect(keyPath).toContain(".ssh");
    });

    it("adds pwd to an allow-list so ssh_connect can still probe", () => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";
        process.env.SSH_ALLOW_COMMANDS = "ls,cat";

        expect(loadHostProfile()?.policy.allowCommands).toEqual(["ls", "cat", "pwd"]);
    });

    it("compiles valid deny patterns into regexes", () => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";
        process.env.SSH_DENY_PATTERNS = "^reboot$,docker\\s+compose\\s+down";

        const compiled = loadHostProfile()?.policy.denyPatterns ?? [];

        expect(compiled).toHaveLength(2);
        expect(compiled[0]?.test("reboot")).toBe(true);
    });
});

// A malformed value must abort startup rather than being ignored: silently dropping
// SSH_READONLY would leave a host the operator believed was read-only fully writable.
describe("loadHostProfile — malformed values abort startup", () => {
    it.each(["ture", "yep"])("rejects the malformed boolean %j", (value) => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";
        process.env.SSH_READONLY = value;

        expect(() => loadHostProfile()).toThrow(/SSH_READONLY must be one of/);
    });

    it("reads a blank boolean as unset, leaving the default alone", () => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";
        process.env.SSH_READONLY = "";

        expect(loadHostProfile()?.policy.readonly).toBe(false);
    });

    it.each(["twenty-two", "0", "-1", "22.5"])("rejects the non-integer port %j", (value) => {
        process.env.SSH_HOST = "10.0.0.5";
        process.env.SSH_USER = "deploy";
        process.env.SSH_PORT = value;

        expect(() => loadHostProfile()).toThrow(/SSH_PORT must be a positive integer/);
    });

    // Compiling lazily meant a typo'd rule logged one line and then simply was not in
    // force — the operator's own deny rule, silently absent.
    it("rejects a deny pattern that is not a valid regex", () => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";
        process.env.SSH_DENY_PATTERNS = "([unclosed";

        expect(() => loadHostProfile()).toThrow(/SSH_DENY_PATTERNS has an invalid entry/);
    });
});

describe("toHostSummary", () => {
    it.each([
        ["privateKey", { SSH_KEY: "~/.ssh/id_ed25519", SSH_PASSPHRASE: "PASSPHRASE-SENTINEL-9271" }],
        ["password", { SSH_PASSWORD: "PASSWORD-SENTINEL-4460" }],
        ["agent", {}],
    ])("reports the %s auth method without exposing any secret", (expectedMethod, credentials) => {
        process.env.SSH_HOST = "10.0.0.1";
        process.env.SSH_USER = "root";
        Object.assign(process.env, credentials);

        const summary = toHostSummary(loadHostProfile()!);

        expect(summary.authMethod).toBe(expectedMethod);

        // Distinctive sentinels: a short value like "pw" is a substring of ordinary words
        // ("app" contains "pp"), so the assertion would pass by accident.
        const serialized = JSON.stringify(summary);
        expect(serialized).not.toContain("PASSWORD-SENTINEL-4460");
        expect(serialized).not.toContain("PASSPHRASE-SENTINEL-9271");
        expect(serialized).not.toContain("id_ed25519");
    });
});
