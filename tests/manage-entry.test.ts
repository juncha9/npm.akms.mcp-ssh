import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HostSetupAnswers } from "@/_types";
import { loadHostProfile } from "@/modules/config";
import { answersToEntry, entryToAnswers, isOurEntry } from "@/modules/manage/entry";

process.env.SSH_MCP_LOG_LEVEL = "silent";

function createAnswers(overrides?: Partial<HostSetupAnswers>): HostSetupAnswers {
    return {
        name: "ssh-prod",
        host: "10.0.0.5",
        port: 22,
        username: "deploy",
        auth: "agent",
        readonly: false,
        allowedPaths: [],
        extraEnv: {},
        ...overrides,
    };
}

describe("answersToEntry — what gets written", () => {
    it("writes only the minimum pair when everything else is a default", () => {
        const entry = answersToEntry(createAnswers());

        expect(entry.env).toEqual({ SSH_HOST: "10.0.0.5", SSH_USER: "deploy" });
    });

    it("launches the package through npx, behind cmd /c on Windows", () => {
        const entry = answersToEntry(createAnswers());

        if (process.platform === "win32") {
            expect(entry.command).toBe("cmd");
            expect(entry.args).toEqual(["/c", "npx", "-y", "@akms/mcp-ssh"]);
        }
        else {
            expect(entry.command).toBe("npx");
            expect(entry.args).toEqual(["-y", "@akms/mcp-ssh"]);
        }
    });

    it("writes every answered setting under its variable", () => {
        const entry = answersToEntry(createAnswers({
            port: 2222,
            auth: "key",
            keyPath: "~/.ssh/id_ed25519",
            passphrase: "secret",
            description: "production web",
            jumpHost: "bastion.example.com",
            jumpPort: 2200,
            jumpUser: "hop",
            proxyCommand: "cloudflared access ssh --hostname %h",
            readonly: true,
            allowedPaths: ["/var/log", "/opt/app"],
            hostKeyFingerprint: "SHA256:target",
            jumpHostKeyFingerprint: "SHA256:jump",
        }));

        expect(entry.env).toEqual({
            SSH_HOST: "10.0.0.5",
            SSH_PORT: "2222",
            SSH_USER: "deploy",
            SSH_KEY: "~/.ssh/id_ed25519",
            SSH_PASSPHRASE: "secret",
            SSH_HOST_KEY: "SHA256:target",
            SSH_DESCRIPTION: "production web",
            SSH_JUMP_HOST: "bastion.example.com",
            SSH_JUMP_PORT: "2200",
            SSH_JUMP_USER: "hop",
            SSH_JUMP_HOST_KEY: "SHA256:jump",
            SSH_PROXY_COMMAND: "cloudflared access ssh --hostname %h",
            SSH_READONLY: "true",
            SSH_ALLOWED_PATHS: "/var/log,/opt/app",
        });
    });

    it("leaves out a jump user equal to the login user, as the server defaults to it", () => {
        const entry = answersToEntry(createAnswers({ jumpHost: "bastion", jumpPort: 22, jumpUser: "deploy" }));

        expect(entry.env.SSH_JUMP_USER).toBeUndefined();
        expect(entry.env.SSH_JUMP_PORT).toBeUndefined();
    });

    it("drops the credentials of an auth method no longer chosen", () => {
        const entry = answersToEntry(createAnswers({ auth: "password", password: "pw", keyPath: "~/.ssh/id_rsa", passphrase: "old" }));

        expect(entry.env.SSH_PASSWORD).toBe("pw");
        expect(entry.env.SSH_KEY).toBeUndefined();
        expect(entry.env.SSH_PASSPHRASE).toBeUndefined();
    });

    it("carries hand-set variables through, but never lets them override an answer", () => {
        const entry = answersToEntry(createAnswers({
            extraEnv: { SSH_EXEC_TIMEOUT_MS: "120000", SSH_NAME: "prod-web", SSH_HOST: "stale" },
        }));

        expect(entry.env.SSH_EXEC_TIMEOUT_MS).toBe("120000");
        expect(entry.env.SSH_NAME).toBe("prod-web");
        expect(entry.env.SSH_HOST).toBe("10.0.0.5");
    });

    it("drops hand-set jump variables once the jump host is gone, so the server still starts", () => {
        const entry = answersToEntry(createAnswers({ extraEnv: { SSH_JUMP_KEY: "~/.ssh/bastion" } }));

        expect(entry.env.SSH_JUMP_KEY).toBeUndefined();
        expect(() => loadHostProfile(entry.env)).not.toThrow();
    });
});

describe("answersToEntry ↔ loadHostProfile — the contract with the server", () => {
    it("produces an env block the server reads back as the same host", () => {
        const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-entry-"));
        const keyPath = path.join(keyDirectory, "id_test");
        fs.writeFileSync(keyPath, "not a real key");

        const entry = answersToEntry(createAnswers({
            port: 2222,
            auth: "key",
            keyPath: keyPath,
            jumpHost: "bastion",
            jumpUser: "hop",
            proxyCommand: "nc %h %p",
            readonly: true,
            allowedPaths: ["/var/log"],
            hostKeyFingerprint: "SHA256:target",
        }));

        const profile = loadHostProfile(entry.env);

        expect(profile?.host).toBe("10.0.0.5");
        expect(profile?.port).toBe(2222);
        expect(profile?.username).toBe("deploy");
        expect(profile?.privateKeyPath).toBe(path.resolve(keyPath));
        expect(profile?.hostKeyFingerprint).toBe("SHA256:target");
        expect(profile?.proxyCommand).toBe("nc %h %p");
        expect(profile?.jump?.host).toBe("bastion");
        expect(profile?.jump?.username).toBe("hop");
        expect(profile?.policy.readonly).toBe(true);
        expect(profile?.policy.allowedPaths).toEqual(["/var/log"]);

        fs.rmSync(keyDirectory, { recursive: true, force: true });
    });

    it("does not touch the process environment while reading an entry", () => {
        loadHostProfile({ SSH_HOST: "10.0.0.5", SSH_USER: "deploy" });

        expect(process.env.SSH_HOST).toBeUndefined();
    });
});

describe("entryToAnswers — pre-filling an edit", () => {
    it("round-trips a full entry without losing a variable", () => {
        const original = answersToEntry(createAnswers({
            port: 2222,
            auth: "key",
            keyPath: "~/.ssh/id_ed25519",
            jumpHost: "bastion",
            jumpUser: "hop",
            readonly: true,
            allowedPaths: ["/var/log", "/opt/app"],
            hostKeyFingerprint: "SHA256:target",
            extraEnv: { SSH_CWD: "/opt/app", SSH_JUMP_KEY: "~/.ssh/bastion" },
        }));

        const answers = entryToAnswers("ssh-prod", original);
        const rewritten = answersToEntry(answers);

        expect(rewritten.env).toEqual(original.env);
        expect(answers.auth).toBe("key");
        expect(answers.readonly).toBe(true);
    });

    it("reads a hand-written boolean spelling", () => {
        const answers = entryToAnswers("ssh-prod", {
            command: "npx",
            args: ["-y", "@akms/mcp-ssh"],
            env: { SSH_HOST: "h", SSH_USER: "u", SSH_READONLY: "yes" },
        });

        expect(answers.readonly).toBe(true);
        expect(answers.auth).toBe("agent");
    });
});

describe("isOurEntry", () => {
    it("recognizes every way the package is launched", () => {
        expect(isOurEntry({ command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {} })).toBe(true);
        expect(isOurEntry({ command: "cmd", args: ["/c", "npx", "-y", "@akms/mcp-ssh"], env: {} })).toBe(true);
        expect(isOurEntry({ command: "akms-mcp-ssh", args: [], env: {} })).toBe(true);
        expect(isOurEntry({ command: "C:\\nodejs\\akms-mcp-ssh.cmd", args: [], env: {} })).toBe(true);
    });

    it("leaves other servers alone", () => {
        expect(isOurEntry({ command: "postgres-mcp", args: ["--access-mode=unrestricted"], env: {} })).toBe(false);
        expect(isOurEntry({ command: "npx", args: ["-y", "@other/mcp-ssh"], env: {} })).toBe(false);
    });
});
