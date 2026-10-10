import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import ssh2 from "ssh2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ConfigTarget, McpServerEntry } from "@/_types";
import { runConfigCommand } from "@/modules/manage";
import { createJsonFileTarget } from "@/modules/manage/targets/json-file";
import { toHostKeyFingerprint } from "@/modules/ssh/ssh-connection";

process.env.SSH_MCP_LOG_LEVEL = "silent";

const { Server, utils } = ssh2;

/** An unrelated server and setting the manager must never disturb. */
const SEED_DOCUMENT = {
    theme: "dark",
    mcpServers: {
        postgres: { command: "postgres-mcp", args: ["--access-mode=restricted"], env: { DATABASE_URI: "postgres://x" } },
    },
};

let server: ssh2.Server;
let serverPort = 0;
let serverFingerprint = "";
/** A port nothing listens on — a host that refuses the connection. */
let closedPort = 0;

let workDirectory = "";
let configPath = "";
let target: ConfigTarget;

beforeAll(async () => {
    const hostKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;

    const parsedKey = utils.parseKey(hostKey);
    if (parsedKey instanceof Error) {
        throw parsedKey;
    }
    serverFingerprint = toHostKeyFingerprint(parsedKey.getPublicSSH());

    server = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on("authentication", (context) => {
            context.accept();
        });
        client.on("error", () => {
            // A client closing right after the handshake must not crash the server.
        });
    });

    serverPort = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve((server.address() as AddressInfo).port);
        });
    });

    const probe = net.createServer();
    closedPort = await new Promise<number>((resolve) => {
        probe.listen(0, "127.0.0.1", () => {
            resolve((probe.address() as AddressInfo).port);
        });
    });
    await new Promise<void>((resolve) => {
        probe.close(() => {
            resolve();
        });
    });
});

afterAll(async () => {
    await new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
});

beforeEach(() => {
    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-config-"));
    configPath = path.join(workDirectory, "mcp.json");
    fs.writeFileSync(configPath, `${JSON.stringify(SEED_DOCUMENT, null, 2)}\n`);
    target = createJsonFileTarget({ id: "cursor", label: "Test client", filePath: configPath });
});

afterEach(() => {
    fs.rmSync(workDirectory, { recursive: true, force: true });
});

/** Drives the manager with the given keystrokes, one answer per line, and returns its screen. */
async function runScript(lines: string[]): Promise<{ exitCode: number; screen: string }> {
    const input = new PassThrough();
    const output = new PassThrough();

    let screen = "";
    output.on("data", (chunk: Buffer) => {
        screen += chunk.toString();
    });

    input.end(lines.map((line) => `${line}\n`).join(""));

    const exitCode = await runConfigCommand({ input: input, output: output, targets: [target] });
    return { exitCode: exitCode, screen: screen };
}

function readDocument(): { theme: string; mcpServers: Record<string, McpServerEntry> } {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function seedHost(name: string, env: Record<string, string>): void {
    const document = readDocument();
    document.mcpServers[name] = { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: env };
    fs.writeFileSync(configPath, JSON.stringify(document, null, 2));
}

describe("config — adding a host", () => {
    it("asks plain questions, checks the connection, pins the key and writes the entry", async () => {
        const { exitCode, screen } = await runScript([
            "a",                       // add
            "127.0.0.1",               // host
            String(serverPort),        // port
            "tester",                  // user
            "",                        // server name → ssh-127-0-0-1
            "password",                // auth
            "secret-pw",               // password
            "",                        // jump host? no
            "",                        // proxy command? no
            "Test box",                // description
            "y",                       // read-only
            "/var/log,/opt/app",       // allowed paths
            "",                        // test now? yes
            "",                        // pin the host key? yes
            "",                        // write it? yes
            "q",
        ]);

        expect(exitCode).toBe(0);
        expect(screen).toContain("OK      tester@127.0.0.1");

        const document = readDocument();
        expect(document.mcpServers["ssh-127-0-0-1"].env).toEqual({
            SSH_HOST: "127.0.0.1",
            SSH_PORT: String(serverPort),
            SSH_USER: "tester",
            SSH_PASSWORD: "secret-pw",
            SSH_HOST_KEY: serverFingerprint,
            SSH_DESCRIPTION: "Test box",
            SSH_READONLY: "true",
            SSH_ALLOWED_PATHS: "/var/log,/opt/app",
        });
        expect(document.theme).toBe("dark");
        expect(document.mcpServers.postgres).toEqual(SEED_DOCUMENT.mcpServers.postgres);
    });

    it("never shows the password in the preview", async () => {
        const { screen } = await runScript([
            "a", "127.0.0.1", String(serverPort), "tester", "box", "password", "secret-pw",
            "", "", "", "", "",
            "n",   // test now? no
            "n",   // write it? no
        ]);

        expect(screen).toContain("\"SSH_PASSWORD\": \"********\"");
        expect(screen).not.toContain("secret-pw");
        expect(readDocument().mcpServers.box).toBeUndefined();
    });

    it("writes nothing when the check fails and the operator cancels", async () => {
        const { screen } = await runScript([
            "a", "127.0.0.1", String(closedPort), "tester", "dead", "agent",
            "", "", "", "", "",
            "",    // test now? yes
            "c",   // what now? cancel
            "q",
        ]);

        expect(screen).toContain("FAILED  tester@127.0.0.1");
        expect(screen).toContain("nothing was written");
        expect(readDocument().mcpServers.dead).toBeUndefined();
    });

    it("re-asks a server name that could not be part of a tool name", async () => {
        const { screen } = await runScript([
            "a", "127.0.0.1", "22", "tester", "my.host", "ok-name", "agent",
            "", "", "", "", "",
            "n", "",
            "q",
        ]);

        expect(screen).toContain("Use letters, digits");
        expect(readDocument().mcpServers["ok-name"]).toBeDefined();
    });
});

describe("config — managing existing hosts", () => {
    it("lists only this package's servers and counts the rest", async () => {
        seedHost("ssh-prod", { SSH_HOST: "10.0.0.5", SSH_USER: "deploy", SSH_READONLY: "true" });

        const { screen } = await runScript(["q"]);

        expect(screen).toContain("ssh-prod  deploy@10.0.0.5:22");
        expect(screen).toContain("readonly");
        expect(screen).toContain("1 other MCP server(s)");
        expect(screen).not.toMatch(/\d\s+postgres/);
    });

    it("renames on edit: the new name is written and the old one removed", async () => {
        seedHost("ssh-old", { SSH_HOST: "10.0.0.5", SSH_USER: "deploy", SSH_HOST_KEY: "SHA256:kept", SSH_CWD: "/opt/app" });

        await runScript([
            "e",                       // edit (the only host, so no picking)
            "", "", "",                // host, port, user unchanged
            "ssh-new",                 // new name
            "",                        // auth: agent, unchanged
            "", "", "", "", "",        // route, description, policy unchanged
            "n",                       // test now? no
            "",                        // write it? yes
            "q",
        ]);

        const servers = readDocument().mcpServers;
        expect(servers["ssh-old"]).toBeUndefined();
        expect(servers["ssh-new"].env).toEqual({
            SSH_HOST: "10.0.0.5",
            SSH_USER: "deploy",
            SSH_HOST_KEY: "SHA256:kept",
            SSH_CWD: "/opt/app",
        });
    });

    it("pins an unpinned host from the check, adding just that one variable", async () => {
        seedHost("ssh-test", { SSH_HOST: "127.0.0.1", SSH_PORT: String(serverPort), SSH_USER: "tester", SSH_PASSWORD: "pw" });

        await runScript(["c", "", "q"]);

        const entry = readDocument().mcpServers["ssh-test"];
        expect(entry.command).toBe("npx");
        expect(entry.env).toEqual({
            SSH_HOST: "127.0.0.1",
            SSH_PORT: String(serverPort),
            SSH_USER: "tester",
            SSH_PASSWORD: "pw",
            SSH_HOST_KEY: serverFingerprint,
        });
    });

    it("prints the entry in every form, ready to paste", async () => {
        seedHost("ssh-prod", { SSH_HOST: "10.0.0.5", SSH_USER: "deploy", SSH_PASSWORD: "pw" });

        const { screen } = await runScript(["p", "q"]);

        expect(screen).toContain("\"ssh-prod\": {");
        expect(screen).toContain("[mcp_servers.ssh-prod.env]");
        expect(screen).toContain("claude mcp add-json ssh-prod '{\"type\":\"stdio\"");
        expect(screen).toContain("\"SSH_PASSWORD\":\"pw\"");
    });

    it("removes a host only after confirmation", async () => {
        seedHost("ssh-a", { SSH_HOST: "10.0.0.5", SSH_USER: "deploy" });
        seedHost("ssh-b", { SSH_HOST: "10.0.0.6", SSH_USER: "deploy" });

        await runScript(["r", "2", "n", "r", "ssh-a", "y", "q"]);

        const servers = readDocument().mcpServers;
        expect(servers["ssh-a"]).toBeUndefined();
        expect(servers["ssh-b"]).toBeDefined();
        expect(servers.postgres).toBeDefined();
    });

    it("refuses to touch a file it cannot parse", async () => {
        fs.writeFileSync(configPath, "{ \"mcpServers\": ");

        const { exitCode, screen } = await runScript(["a", "q"]);

        expect(exitCode).toBe(0);
        expect(screen).toContain("Cannot read it");
        expect(fs.readFileSync(configPath, "utf8")).toBe("{ \"mcpServers\": ");
    });

    it("treats input running out as leaving", async () => {
        const { exitCode } = await runScript([]);

        expect(exitCode).toBe(0);
    });
});
