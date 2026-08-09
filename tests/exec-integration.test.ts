import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import ssh2 from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CWD_MARKER } from "@/_defs";
import type { SshHostProfile } from "@/_types";
import { SshConnection, SshSessionManager } from "@/modules/ssh";

import { createPolicy } from "./_helpers";

process.env.SSH_MCP_LOG_LEVEL = "silent";

const { Server } = ssh2;

/** Canned reply for one exec request; `hang: true` never closes the channel. */
interface MockReply {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hang?: boolean;
    /** Send EOF first and the exit status only after this delay, as real servers may. */
    eofBeforeExitMs?: number;
}

/** Commands the mock server received, in order — asserted against to check the wire form. */
let receivedCommands: string[] = [];
/** True once the client sends EOF on the exec channel's stdin. */
let receivedStdinEof = false;
let replyFor: (command: string) => MockReply = () => ({ exitCode: 0 });

let server: ssh2.Server;
let serverPort = 0;

beforeAll(async () => {
    const hostKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;

    server = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on("authentication", (context) => {
            context.accept();
        });

        client.on("ready", () => {
            client.on("session", (acceptSession) => {
                const session = acceptSession();
                session.on("exec", (acceptExec, _rejectExec, info) => {
                    receivedCommands.push(info.command);

                    const reply = replyFor(info.command);
                    const stream = acceptExec();

                    stream.on("end", () => {
                        receivedStdinEof = true;
                    });
                    // A paused stream never emits 'end'; a real sshd reads stdin, so put
                    // the mock in flowing mode to observe the client's EOF.
                    stream.resume();

                    if (reply.stdout != null) {
                        stream.write(reply.stdout);
                    }

                    if (reply.stderr != null) {
                        stream.stderr.write(reply.stderr);
                    }

                    if (reply.hang === true) {
                        return;
                    }

                    if (reply.eofBeforeExitMs != null) {
                        // OpenSSH's real ordering is data → EOF → exit-status → close.
                        // ssh2's public `exit()` only fires while the channel is 'open',
                        // and `eof()` moves it to 'eof', so the protocol layer is driven
                        // directly here to reproduce what a real server sends.
                        stream.eof();
                        setTimeout(() => {
                            const internals = stream as unknown as {
                                _client: { _protocol: { exitStatus(id: number, status: number): void } };
                                outgoing: { id: number };
                            };
                            internals._client._protocol.exitStatus(internals.outgoing.id, reply.exitCode ?? 0);
                            stream.close();
                        }, reply.eofBeforeExitMs);
                        return;
                    }

                    stream.exit(reply.exitCode ?? 0);
                    stream.end();
                });
            });
        });

        client.on("error", () => {
            // A client aborting mid-handshake (the timeout test) must not crash the server.
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            serverPort = (server.address() as AddressInfo).port;
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
    receivedCommands = [];
    receivedStdinEof = false;
    replyFor = () => ({ exitCode: 0 });
});

function createProfile(overrides?: Partial<SshHostProfile>): SshHostProfile {
    return {
        name: "mock",
        host: "127.0.0.1",
        port: serverPort,
        username: "tester",
        password: "pw",
        policy: createPolicy({ execTimeoutMs: 5_000, connectTimeoutMs: 5_000, maxOutputCharacters: 100 }),
        ...overrides,
    };
}

describe("SshConnection.exec against a live ssh server", () => {
    it("returns stdout, stderr and the exit code", async () => {
        replyFor = () => ({ stdout: "hello\n", stderr: "warned\n", exitCode: 3 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "echo hello",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(result.stdout).toBe("hello\n");
            expect(result.stderr).toBe("warned\n");
            expect(result.exitCode).toBe(3);
            expect(result.timedOut).toBe(false);
            expect(receivedCommands).toEqual(["echo hello"]);
        }
        finally {
            connection.disconnect();
        }
    });

    it("sends a quoted cd prefix when cwd is given", async () => {
        const connection = new SshConnection(createProfile());
        try {
            await connection.exec({
                command: "ls",
                cwd: "/opt/app",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(receivedCommands[0]).toContain(`cd '/opt/app'`);
            expect(receivedCommands[0]?.endsWith("ls")).toBe(true);
        }
        finally {
            connection.disconnect();
        }
    });

    it("strips the cwd marker out of stdout and reports it separately", async () => {
        replyFor = () => ({ stdout: `file.txt\n${CWD_MARKER}/srv/data`, exitCode: 0 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "ls",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: true,
            });

            expect(result.cwd).toBe("/srv/data");
            expect(result.stdout).toBe("file.txt");
            expect(receivedCommands[0]).toContain("__akms_exit=$?");
        }
        finally {
            connection.disconnect();
        }
    });

    it("truncates output past maxOutputCharacters", async () => {
        replyFor = () => ({ stdout: "x".repeat(500), exitCode: 0 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "cat big.log",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(result.truncated).toBe(true);
            expect(result.stdout).toContain("truncated 400 characters of 500");
        }
        finally {
            connection.disconnect();
        }
    });

    it("waits for close so an exit status arriving after EOF is still captured", async () => {
        replyFor = () => ({ stdout: "partial output\n", exitCode: 0, eofBeforeExitMs: 250 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "exec 1>&-; long_task",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(result.exitCode).toBe(0);
            expect(result.timedOut).toBe(false);
        }
        finally {
            connection.disconnect();
        }
    });

    it("preserves multi-byte characters split across packet boundaries", async () => {
        const payload = "한글 로그 라인 · 이모지 🚀 ".repeat(8_000);
        replyFor = () => ({ stdout: payload, exitCode: 0 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "cat /var/log/app.log",
                timeoutMs: 20_000,
                maxOutputCharacters: 1_000_000,
                trackCwd: false,
            });

            expect(result.stdout.includes("�")).toBe(false);
            expect(result.stdout).toBe(payload);
        }
        finally {
            connection.disconnect();
        }
    });

    it("leaves output containing the marker text intact when tracking is off", async () => {
        replyFor = () => ({ stdout: `grep hit: ${CWD_MARKER}/fake\nmore output\n`, exitCode: 0 });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "grep -r marker .",
                timeoutMs: 5_000,
                maxOutputCharacters: 1_000,
                trackCwd: false,
            });

            expect(result.cwd).toBeUndefined();
            expect(result.stdout).toContain("more output");
        }
        finally {
            connection.disconnect();
        }
    });

    // Without this, a command that reads stdin (a sudo password prompt, an apt
    // confirmation) blocks until the timeout instead of failing immediately.
    it("closes the remote stdin so an interactive prompt cannot hang", async () => {
        const connection = new SshConnection(createProfile());
        try {
            await connection.exec({
                command: "sudo systemctl restart nginx",
                timeoutMs: 5_000,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(receivedStdinEof).toBe(true);
        }
        finally {
            connection.disconnect();
        }
    });

    it("refuses to re-dial after disconnect", async () => {
        const connection = new SshConnection(createProfile());
        await connection.exec({ command: "id", timeoutMs: 5_000, maxOutputCharacters: 100, trackCwd: false });
        connection.disconnect();

        await expect(connection.exec({
            command: "id",
            timeoutMs: 5_000,
            maxOutputCharacters: 100,
            trackCwd: false,
        })).rejects.toThrow(/has been closed/);
    });

    it("flags a command that outruns its timeout", async () => {
        replyFor = () => ({ stdout: "starting\n", hang: true });

        const connection = new SshConnection(createProfile());
        try {
            const result = await connection.exec({
                command: "sleep 100",
                timeoutMs: 300,
                maxOutputCharacters: 100,
                trackCwd: false,
            });

            expect(result.timedOut).toBe(true);
            expect(result.stdout).toContain("starting");
        }
        finally {
            connection.disconnect();
        }
    });
});

describe("SshSessionManager against a live ssh server", () => {
    it("carries the working directory from one command to the next", async () => {
        const manager = new SshSessionManager();
        try {
            replyFor = () => ({ stdout: `${CWD_MARKER}/var/log`, exitCode: 0 });

            const session = await manager.open(createProfile());
            await session.exec("cd /var/log");
            expect(session.cwd).toBe("/var/log");

            replyFor = () => ({ stdout: `syslog\n${CWD_MARKER}/var/log`, exitCode: 0 });
            const second = await session.exec("ls");

            expect(receivedCommands[1]).toContain(`cd '/var/log'`);
            expect(second.stdout).toBe("syslog");
            expect(session.execCount).toBe(2);
        }
        finally {
            manager.closeAll();
        }
    });

    it("moves the session when a per-call cwd is supplied", async () => {
        const manager = new SshSessionManager();
        try {
            replyFor = () => ({ stdout: `${CWD_MARKER}/etc/nginx`, exitCode: 0 });

            const session = await manager.open(createProfile());
            await session.exec("ls", { cwd: "/etc/nginx" });

            expect(receivedCommands[0]).toContain(`cd '/etc/nginx'`);
            expect(session.cwd).toBe("/etc/nginx");
        }
        finally {
            manager.closeAll();
        }
    });

    it("lists and closes sessions", async () => {
        const manager = new SshSessionManager();
        try {
            const session = await manager.open(createProfile());

            const listed = manager.list();
            expect(listed).toHaveLength(1);
            expect(listed[0]?.sessionId).toBe(session.sessionId);
            expect(listed[0]?.host).toBe("127.0.0.1");

            expect(manager.close(session.sessionId)).toBe(true);
            expect(manager.list()).toHaveLength(0);
            expect(manager.close(session.sessionId)).toBe(false);
        }
        finally {
            manager.closeAll();
        }
    });

    it("does not resurrect the connection of a closed session", async () => {
        const manager = new SshSessionManager();
        const session = await manager.open(createProfile());
        manager.close(session.sessionId);

        await expect(session.exec("id")).rejects.toThrow(/has been closed/);
        expect(manager.list()).toHaveLength(0);
    });

    it("keeps the previous cwd when the remote reports an unsafe one", async () => {
        const manager = new SshSessionManager();
        try {
            replyFor = () => ({ stdout: `${CWD_MARKER}/opt/app`, exitCode: 0 });
            const session = await manager.open(createProfile());
            await session.exec("pwd");
            expect(session.cwd).toBe("/opt/app");

            replyFor = () => ({ stdout: `${CWD_MARKER}/tmp/$(reboot)`, exitCode: 0 });
            await session.exec("cd weird");

            expect(session.cwd).toBe("/opt/app");
        }
        finally {
            manager.closeAll();
        }
    });

    it("fails a lookup with the open session ids listed", async () => {
        const manager = new SshSessionManager();
        try {
            await manager.open(createProfile());
            expect(() => manager.require("mock#99")).toThrow(/open sessions: mock#1/);
        }
        finally {
            manager.closeAll();
        }
    });
});

describe("host key verification", () => {
    // ssh2 accepts any host key when no verifier is supplied, so a rebuilt server or a
    // man-in-the-middle was indistinguishable from the real host.
    it("reports the fingerprint the server presented", async () => {
        const connection = new SshConnection(createProfile());
        try {
            await connection.connect();
            expect(connection.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
        }
        finally {
            connection.disconnect();
        }
    });

    it("refuses a connection whose host key does not match the pin", async () => {
        const connection = new SshConnection(createProfile({ hostKeyFingerprint: "SHA256:aWrongFingerprintValue" }));
        await expect(connection.connect()).rejects.toThrow(/ssh connect failed/);
    });

    it("accepts a connection whose host key matches the pin", async () => {
        const probe = new SshConnection(createProfile());
        await probe.connect();
        const observed = probe.hostKeyFingerprint;
        probe.disconnect();

        expect(observed).not.toBeNull();

        const pinned = new SshConnection(createProfile({ hostKeyFingerprint: observed as string }));
        try {
            await pinned.connect();
            expect(pinned.isConnected).toBe(true);
        }
        finally {
            pinned.disconnect();
        }
    });
});

describe("SshConnection.connect failure", () => {
    it("reports the profile and endpoint when the host refuses", async () => {
        const connection = new SshConnection(createProfile({ port: 1 }));
        await expect(connection.exec({
            command: "ls",
            timeoutMs: 1_000,
            maxOutputCharacters: 100,
            trackCwd: false,
        })).rejects.toThrow(/ssh connect failed for 'mock' \(tester@127\.0\.0\.1:1\)/);
    });
});
