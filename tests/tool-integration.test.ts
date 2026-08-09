import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import ssh2 from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSshMcpServer } from "@/server";
import type { SshMcpServerInstance } from "@/server";

process.env.SSH_MCP_LOG_LEVEL = "silent";

const { Server } = ssh2;

/**
 * End-to-end through the real MCP layer: a client calls tools over an in-memory transport,
 * the server runs its handlers, and the commands land on a live ssh2 server. This is the
 * only place that proves the tool handlers actually *call* the guards — unit-testing the
 * guards alone left deleting `inspectCommand` from the handler undetected.
 *
 * One server entry fronts one host, so a policy pair needs two instances: `locked` is
 * read-only with a path allow-list, `sandbox` is writable.
 */

let receivedCommands: string[] = [];
let sshServer: ssh2.Server;
let sshPort = 0;

let lockedInstance: SshMcpServerInstance;
let sandboxInstance: SshMcpServerInstance;
let lockedClient: Client;
let sandboxClient: Client;

/** Returns the text of the first content block, or the error message. */
function firstText(result: unknown): string {
    const typed = result as { content?: { type: string; text?: string }[] };
    return typed.content?.[0]?.text ?? "";
}

function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

/**
 * Builds a server from `SSH_*` variables and hands back a client wired to it.
 *
 * The variables are applied only for the duration of the build — `createSshMcpServer`
 * reads the environment once at startup, so leaving them set would leak this host's policy
 * into the next instance.
 */
async function startServer(env: Record<string, string>): Promise<{ instance: SshMcpServerInstance; client: Client }> {
    for (const [name, value] of Object.entries(env)) {
        process.env[name] = value;
    }

    let instance: SshMcpServerInstance;
    try {
        instance = createSshMcpServer();
    }
    finally {
        for (const name of Object.keys(env)) {
            delete process.env[name];
        }
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await instance.server.connect(serverTransport);

    const client = new Client({ name: "tool-integration-test", version: "0.0.1" });
    await client.connect(clientTransport);

    return { instance: instance, client: client };
}

beforeAll(async () => {
    const hostKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;

    sshServer = new Server({ hostKeys: [hostKey] }, (connection) => {
        connection.on("authentication", (context) => {
            context.accept();
        });

        connection.on("ready", () => {
            connection.on("session", (acceptSession) => {
                const session = acceptSession();
                session.on("exec", (acceptExec, _rejectExec, info) => {
                    receivedCommands.push(info.command);

                    const stream = acceptExec();
                    // Echo a plausible cwd marker payload so session tracking has something
                    // to adopt: the wrapper always appends `printf …$PWD`.
                    if (info.command.includes("__AKMS_SSH_CWD__") == true) {
                        stream.write("ok\n__AKMS_SSH_CWD__/opt/app");
                    }
                    else {
                        stream.write("ok\n");
                    }

                    stream.exit(0);
                    stream.end();
                });
            });
        });

        connection.on("error", () => {
            // A client aborting must not take the test server down.
        });
    });

    await new Promise<void>((resolve) => {
        sshServer.listen(0, "127.0.0.1", () => {
            sshPort = (sshServer.address() as AddressInfo).port;
            resolve();
        });
    });

    const locked = await startServer({
        SSH_HOST: "127.0.0.1",
        SSH_PORT: String(sshPort),
        SSH_USER: "tester",
        SSH_PASSWORD: "pw",
        SSH_NAME: "locked",
        SSH_DESCRIPTION: "read-only smoke host",
        SSH_READONLY: "true",
        SSH_ALLOWED_PATHS: "/var/log",
    });
    lockedInstance = locked.instance;
    lockedClient = locked.client;

    const sandbox = await startServer({
        SSH_HOST: "127.0.0.1",
        SSH_PORT: String(sshPort),
        SSH_USER: "tester",
        SSH_PASSWORD: "pw",
        SSH_NAME: "sandbox",
        SSH_DESCRIPTION: "writable smoke host",
    });
    sandboxInstance = sandbox.instance;
    sandboxClient = sandbox.client;
});

afterAll(async () => {
    lockedInstance.shutdown();
    sandboxInstance.shutdown();
    await lockedClient.close();
    await sandboxClient.close();

    await new Promise<void>((resolve) => {
        sshServer.close(() => {
            resolve();
        });
    });
});

beforeEach(() => {
    receivedCommands = [];
});

describe("tool surface", () => {
    it("exposes every tool with its annotations", async () => {
        const listed = await sandboxClient.listTools();
        const names = listed.tools.map((tool) => tool.name);

        expect(names).toEqual([
            "ssh_list_hosts",
            "ssh_connect",
            "ssh_disconnect",
            "ssh_list_sessions",
            "ssh_exec",
            "ssh_list_dir",
            "ssh_read_file",
            "ssh_write_file",
            "ssh_upload",
            "ssh_download",
        ]);

        const download = listed.tools.find((tool) => tool.name === "ssh_download");
        expect(download?.annotations?.destructiveHint).toBe(true);
    });

    // No host argument exists at all — the model cannot name a machine, which is the
    // property that makes a pre-registered host meaningful.
    it("exposes no host argument on any tool", async () => {
        const listed = await sandboxClient.listTools();

        for (const tool of listed.tools) {
            const properties = tool.inputSchema.properties ?? {};
            expect(Object.keys(properties)).not.toContain("target");
        }
    });

    it("shows the host without leaking credentials", async () => {
        const result = await lockedClient.callTool({ name: "ssh_list_hosts", arguments: {} });
        const text = firstText(result);

        expect(text).toContain("locked");
        expect(text).toContain("READ-ONLY");
        expect(text).toContain("does not restrict ssh_exec");
        expect(text).not.toContain("pw");
    });
});

describe("ssh_exec guards are wired into the handler", () => {
    it.each([
        ["rm -rf /", "dangerous"],
        ["nohup rm -rf /", "dangerous"],
        ["timeout 30 reboot", "dangerous"],
        ["cat <(mkfs.ext4 /dev/sda1)", "dangerous"],
        ["/sbin/reboot", "dangerous"],
    ])("rejects %s on a writable host before connecting", async (command, expectedReason) => {
        const result = await sandboxClient.callTool({ name: "ssh_exec", arguments: { command: command } });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain(expectedReason);
        expect(receivedCommands).toHaveLength(0);
    });

    it.each([
        ["rm old.log", "read-only"],
        ["systemctl restart nginx", "read-only"],
        ["X=$(rm -rf /tmp/x)", "read-only"],
    ])("rejects %s on the read-only host before connecting", async (command, expectedReason) => {
        const result = await lockedClient.callTool({ name: "ssh_exec", arguments: { command: command } });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain(expectedReason);
        expect(receivedCommands).toHaveLength(0);
    });

    it("rejects an injected cwd before connecting", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_exec",
            arguments: { command: "ls", cwd: `/tmp"; echo INJECTED; #` },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("metacharacter");
        expect(receivedCommands).toHaveLength(0);
    });

    it("runs an allowed command and reports the exit code", async () => {
        const result = await lockedClient.callTool({ name: "ssh_exec", arguments: { command: "uptime" } });

        expect(isError(result)).toBe(false);
        expect(firstText(result)).toContain("exit code: 0");
        expect(firstText(result)).toContain("ok");
        expect(receivedCommands).toEqual(["uptime"]);
    });

    it("runs sudo by default", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_exec",
            arguments: { command: "sudo systemctl status nginx" },
        });

        expect(isError(result)).toBe(false);
        expect(receivedCommands).toEqual(["sudo systemctl status nginx"]);
    });
});

describe("session lifecycle through the tools", () => {
    it("opens, reuses, tracks cwd and closes", async () => {
        const opened = await sandboxClient.callTool({ name: "ssh_connect", arguments: {} });
        const openedText = firstText(opened);
        expect(isError(opened)).toBe(false);

        const sessionId = openedText.match(/Opened session (\S+)/)?.[1];
        expect(sessionId).toBeDefined();
        expect(sessionId).toContain("sandbox");
        expect(openedText).toContain("/opt/app");

        const listed = await sandboxClient.callTool({ name: "ssh_list_sessions", arguments: {} });
        expect(firstText(listed)).toContain(sessionId as string);

        const executed = await sandboxClient.callTool({
            name: "ssh_exec",
            arguments: { session: sessionId, command: "ls" },
        });
        expect(isError(executed)).toBe(false);
        // The session's tracked cwd becomes the cd prefix of the next command.
        expect(receivedCommands.at(-1)).toContain(`cd '/opt/app'`);

        const closed = await sandboxClient.callTool({ name: "ssh_disconnect", arguments: { session: sessionId } });
        expect(firstText(closed)).toContain("Closed session");

        const afterClose = await sandboxClient.callTool({
            name: "ssh_exec",
            arguments: { session: sessionId, command: "ls" },
        });
        expect(isError(afterClose)).toBe(true);
        expect(firstText(afterClose)).toContain("unknown ssh session");
    });

    it("rejects an injected cwd at connect time", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_connect",
            arguments: { cwd: "/tmp`reboot`" },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("metacharacter");
    });
});

describe("file tool guards are wired into the handlers", () => {
    it("rejects a remote path outside allowedPaths", async () => {
        const result = await lockedClient.callTool({
            name: "ssh_read_file",
            arguments: { path: "/etc/shadow" },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("allowedPaths");
    });

    it("rejects a remote write on a read-only host", async () => {
        const result = await lockedClient.callTool({
            name: "ssh_write_file",
            arguments: { path: "/var/log/x", content: "hi" },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("read-only");
    });

    it("refuses to download onto the MCP client configuration", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_download",
            arguments: { remotePath: "/tmp/evil.json", localPath: path.join(os.homedir(), ".claude.json") },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("MCP client configuration");
    });

    it("refuses to download onto a protected local path", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_download",
            arguments: { remotePath: "/tmp/x", localPath: path.join(os.homedir(), ".ssh", "authorized_keys") },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("protected");
    });

    it("refuses to upload a private key", async () => {
        const result = await sandboxClient.callTool({
            name: "ssh_upload",
            arguments: { localPath: path.join(os.homedir(), ".ssh", "id_ed25519"), remotePath: "/tmp/k" },
        });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("protected");
    });
});
