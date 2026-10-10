import { generateKeyPairSync } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ssh2 from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SshHostProfile } from "@/_types";
import { SshConnection } from "@/modules/ssh";
import { expandProxyCommand } from "@/modules/ssh/ssh-connection";

import { createPolicy } from "./_helpers";

process.env.SSH_MCP_LOG_LEVEL = "silent";

const { Server } = ssh2;

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** `node tests/_fixtures/tcp-relay.cjs %h %p` — a cross-platform `nc %h %p`. */
const RELAY_PROXY_COMMAND = `"${process.execPath}" "${path.join(TEST_DIRECTORY, "_fixtures", "tcp-relay.cjs")}" %h %p`;

/** Commands the target server received — proof that a command crossed the whole route. */
let receivedCommands: string[] = [];
/** Forward requests the jump server received, as `host:port`. */
let forwardRequests: string[] = [];
/** When false the jump server rejects every forward, as a locked-down bastion would. */
let allowForward = true;
/** When false the jump server refuses every login. */
let acceptJumpLogin = true;

let targetServer: ssh2.Server;
let targetPort = 0;
let jumpServer: ssh2.Server;
let jumpPort = 0;

function generateHostKey(): string {
    return generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
}

function listen(server: ssh2.Server): Promise<number> {
    return new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve((server.address() as AddressInfo).port);
        });
    });
}

function close(server: ssh2.Server): Promise<void> {
    return new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
}

beforeAll(async () => {
    // The target: accepts any login and answers every exec with its own stdout.
    targetServer = new Server({ hostKeys: [generateHostKey()] }, (client) => {
        client.on("authentication", (context) => {
            context.accept();
        });

        client.on("ready", () => {
            client.on("session", (acceptSession) => {
                const session = acceptSession();
                session.on("exec", (acceptExec, _rejectExec, info) => {
                    receivedCommands.push(info.command);

                    const stream = acceptExec();
                    stream.resume();
                    stream.write(`target ran: ${info.command}\n`);
                    stream.exit(0);
                    stream.end();
                });
            });
        });

        client.on("error", () => {
            // A client aborting mid-handshake must not crash the server.
        });
    });
    targetPort = await listen(targetServer);

    // The jump host: a bastion that only forwards TCP, the way `ssh -J` uses one. A
    // `direct-tcpip` request is answered with a real socket to the requested address.
    jumpServer = new Server({ hostKeys: [generateHostKey()] }, (client) => {
        client.on("authentication", (context) => {
            if (acceptJumpLogin == false) {
                context.reject();
                return;
            }

            context.accept();
        });

        client.on("ready", () => {
            client.on("tcpip", (acceptChannel, rejectChannel, info) => {
                forwardRequests.push(`${info.destIP}:${info.destPort}`);

                if (allowForward == false) {
                    rejectChannel();
                    return;
                }

                const upstream = net.connect({ host: info.destIP, port: info.destPort }, () => {
                    const channel = acceptChannel();
                    channel.pipe(upstream);
                    upstream.pipe(channel);

                    channel.on("close", () => {
                        upstream.destroy();
                    });
                    upstream.on("close", () => {
                        channel.close();
                    });
                });

                upstream.on("error", () => {
                    rejectChannel();
                });
            });
        });

        client.on("error", () => {
            // Same as above.
        });
    });
    jumpPort = await listen(jumpServer);
});

afterAll(async () => {
    await close(targetServer);
    await close(jumpServer);
});

beforeEach(() => {
    receivedCommands = [];
    forwardRequests = [];
    allowForward = true;
    acceptJumpLogin = true;
});

function createProfile(overrides?: Partial<SshHostProfile>): SshHostProfile {
    return {
        name: "routed",
        host: "127.0.0.1",
        port: targetPort,
        username: "tester",
        password: "pw",
        policy: createPolicy({ execTimeoutMs: 5_000, connectTimeoutMs: 5_000 }),
        ...overrides,
    };
}

function jumpProfile(): NonNullable<SshHostProfile["jump"]> {
    return { host: "127.0.0.1", port: jumpPort, username: "bastion", password: "jump-pw" };
}

async function execOnce(profile: SshHostProfile, command: string): Promise<string> {
    const connection = new SshConnection(profile);
    try {
        const result = await connection.exec({ command: command, timeoutMs: 5_000, maxOutputCharacters: 10_000, trackCwd: false });
        return result.stdout;
    }
    finally {
        connection.disconnect();
    }
}

describe("expandProxyCommand", () => {
    it("expands %h, %p, %r and %% like OpenSSH", () => {
        const expanded = expandProxyCommand("cloudflared access ssh --hostname %h -p %p -u %r 100%%", {
            host: "dev-ak-ssh.example.com",
            port: 2222,
            username: "ubuntu",
        });

        expect(expanded).toBe("cloudflared access ssh --hostname dev-ak-ssh.example.com -p 2222 -u ubuntu 100%");
    });

    it("leaves a command without tokens untouched", () => {
        expect(expandProxyCommand("nc bastion 22", { host: "x", port: 1, username: "u" })).toBe("nc bastion 22");
    });
});

describe("jump host route", () => {
    it("reaches the target through the jump host's forwarded channel", async () => {
        const stdout = await execOnce(createProfile({ jump: jumpProfile() }), "uname -a");

        expect(stdout).toBe("target ran: uname -a\n");
        expect(receivedCommands).toEqual(["uname -a"]);
        // The forward names the *target*, which is what the jump host actually dials.
        expect(forwardRequests).toEqual([`127.0.0.1:${targetPort}`]);
    });

    it("records both host key fingerprints", async () => {
        const connection = new SshConnection(createProfile({ jump: jumpProfile() }));
        try {
            await connection.connect();
        }
        finally {
            connection.disconnect();
        }

        expect(connection.hostKeyFingerprint).toMatch(/^SHA256:/);
        expect(connection.jumpHostKeyFingerprint).toMatch(/^SHA256:/);
        expect(connection.jumpHostKeyFingerprint).not.toBe(connection.hostKeyFingerprint);
    });

    it("names the jump host when its login is refused", async () => {
        acceptJumpLogin = false;

        const connection = new SshConnection(createProfile({ jump: jumpProfile() }));
        await expect(connection.connect()).rejects.toThrow(/jump host bastion@127\.0\.0\.1:\d+: .*authentication/i);
        connection.disconnect();
    });

    it("names the jump host when it refuses the forward", async () => {
        allowForward = false;

        const connection = new SshConnection(createProfile({ jump: jumpProfile() }));
        await expect(connection.connect()).rejects.toThrow(/jump host .* refused the forward to 127\.0\.0\.1:\d+/);
        connection.disconnect();
    });

    it("aborts when the pinned jump host key does not match", async () => {
        const jump = { ...jumpProfile(), hostKeyFingerprint: "SHA256:not-the-real-one" };

        const connection = new SshConnection(createProfile({ jump: jump }));
        await expect(connection.connect()).rejects.toThrow(/jump host bastion@.*: Host denied/);
        connection.disconnect();
    });

    it("tears the jump connection down with the target connection", async () => {
        // A second jump connection after the first was closed still gets its own forward,
        // and nothing from the first one lingers to answer in its place.
        await execOnce(createProfile({ jump: jumpProfile() }), "first");
        await execOnce(createProfile({ jump: jumpProfile() }), "second");

        expect(forwardRequests).toHaveLength(2);
        expect(receivedCommands).toEqual(["first", "second"]);
    });
});

describe("proxy command route", () => {
    it("reaches the target over the command's stdin/stdout", async () => {
        const stdout = await execOnce(createProfile({ proxyCommand: RELAY_PROXY_COMMAND }), "df -h");

        expect(stdout).toBe("target ran: df -h\n");
        expect(receivedCommands).toEqual(["df -h"]);
    });

    it("fails fast when the command exits without speaking SSH", async () => {
        const profile = createProfile({ proxyCommand: `"${process.execPath}" -e "process.exit(3)"` });

        const connection = new SshConnection(profile);
        const startedAt = Date.now();
        await expect(connection.connect()).rejects.toThrow(/ssh connect failed for 'routed'/);
        connection.disconnect();

        // Well inside the 5s ready timeout — the exit was noticed, not waited out.
        expect(Date.now() - startedAt).toBeLessThan(4_000);
    });

    it("reports an unreadable jump key before touching the network", async () => {
        const jump = { ...jumpProfile(), privateKeyPath: path.join(TEST_DIRECTORY, "does-not-exist.key") };
        const profile = createProfile({ proxyCommand: RELAY_PROXY_COMMAND, jump: jump });

        const connection = new SshConnection(profile);
        await expect(connection.connect()).rejects.toThrow(/cannot read the private key configured for 'routed jump host'/);
        connection.disconnect();

        // The proxy was started before the key was read, and nothing reached the bastion.
        expect(forwardRequests).toEqual([]);
    });

    it("carries the jump hop when both are configured", async () => {
        // The relay is told the *jump host's* address, and the jump host forwards on.
        const profile = createProfile({ proxyCommand: RELAY_PROXY_COMMAND, jump: jumpProfile() });

        const stdout = await execOnce(profile, "hostname");

        expect(stdout).toBe("target ran: hostname\n");
        expect(forwardRequests).toEqual([`127.0.0.1:${targetPort}`]);
    });
});
