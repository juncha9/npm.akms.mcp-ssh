import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import ssh2 from "ssh2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SshHostProfile } from "@/_types";
import {
    SshConnection,
    downloadFile,
    listRemoteDirectory,
    readRemoteFile,
    uploadFile,
    writeRemoteFile,
} from "@/modules/ssh";

import { createPolicy } from "./_helpers";

process.env.SSH_MCP_LOG_LEVEL = "silent";

const { Server, utils } = ssh2;
const STATUS_CODE = utils.sftp.STATUS_CODE;

/** File-type bits so ssh2's `Stats.isDirectory()` / `isFile()` answer correctly. */
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** In-memory remote filesystem: absolute path → contents. */
let remoteFiles = new Map<string, Buffer>();
/** Absolute directory path → child names. */
let remoteDirectories = new Map<string, string[]>();
/** Paths whose stat reports size 0 despite having content — how /proc behaves. */
let sizelessFiles = new Set<string>();
/** Directory entries returned with no attributes at all, as a sparse server would. */
let attributelessEntries = new Set<string>();

interface OpenHandle {
    kind: "file" | "dir";
    remotePath: string;
    /** Directories answer their listing once, then EOF. */
    listed: boolean;
}

let server: ssh2.Server;
let serverPort = 0;
let temporaryDirectory = "";

function fileAttributes(size: number): Record<string, number> {
    const nowSeconds = Math.floor(Date.parse("2026-08-07T00:00:00.000Z") / 1000);
    return { mode: S_IFREG | 0o644, uid: 0, gid: 0, size: size, atime: nowSeconds, mtime: nowSeconds };
}

function directoryAttributes(): Record<string, number> {
    const nowSeconds = Math.floor(Date.parse("2026-08-07T00:00:00.000Z") / 1000);
    return { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 4096, atime: nowSeconds, mtime: nowSeconds };
}

/** Minimal SFTP subsystem: OPEN/READ/WRITE/CLOSE, OPENDIR/READDIR, STAT family, REALPATH. */
function attachSftpHandlers(sftpStream: any): void {
    const openHandles: OpenHandle[] = [];

    const allocateHandle = (handle: OpenHandle): Buffer => {
        openHandles.push(handle);
        const handleBuffer = Buffer.alloc(4);
        handleBuffer.writeUInt32BE(openHandles.length - 1, 0);
        return handleBuffer;
    };

    const lookupHandle = (handleBuffer: Buffer): OpenHandle | undefined => {
        return openHandles[handleBuffer.readUInt32BE(0)];
    };

    sftpStream.on("OPEN", (requestId: number, filename: string, flags: number) => {
        const isWrite = (flags & utils.sftp.OPEN_MODE.WRITE) !== 0 || (flags & utils.sftp.OPEN_MODE.APPEND) !== 0;

        if (isWrite === false && remoteFiles.has(filename) === false) {
            sftpStream.status(requestId, STATUS_CODE.NO_SUCH_FILE);
            return;
        }

        if (isWrite === true && (flags & utils.sftp.OPEN_MODE.APPEND) === 0) {
            remoteFiles.set(filename, Buffer.alloc(0));
        }

        if (isWrite === true && remoteFiles.has(filename) === false) {
            remoteFiles.set(filename, Buffer.alloc(0));
        }

        sftpStream.handle(requestId, allocateHandle({ kind: "file", remotePath: filename, listed: false }));
    });

    sftpStream.on("READ", (requestId: number, handleBuffer: Buffer, offset: number, length: number) => {
        const handle = lookupHandle(handleBuffer);
        if (handle == null) {
            sftpStream.status(requestId, STATUS_CODE.FAILURE);
            return;
        }

        const content = remoteFiles.get(handle.remotePath) ?? Buffer.alloc(0);
        if (offset >= content.length) {
            sftpStream.status(requestId, STATUS_CODE.EOF);
            return;
        }

        sftpStream.data(requestId, content.subarray(offset, offset + length));
    });

    sftpStream.on("WRITE", (requestId: number, handleBuffer: Buffer, offset: number, data: Buffer) => {
        const handle = lookupHandle(handleBuffer);
        if (handle == null) {
            sftpStream.status(requestId, STATUS_CODE.FAILURE);
            return;
        }

        const existing = remoteFiles.get(handle.remotePath) ?? Buffer.alloc(0);
        const requiredLength = Math.max(existing.length, offset + data.length);
        const merged = Buffer.alloc(requiredLength);
        existing.copy(merged, 0);
        data.copy(merged, offset);
        remoteFiles.set(handle.remotePath, merged);

        sftpStream.status(requestId, STATUS_CODE.OK);
    });

    sftpStream.on("CLOSE", (requestId: number) => {
        sftpStream.status(requestId, STATUS_CODE.OK);
    });

    sftpStream.on("OPENDIR", (requestId: number, remotePath: string) => {
        if (remoteDirectories.has(remotePath) === false) {
            sftpStream.status(requestId, STATUS_CODE.NO_SUCH_FILE);
            return;
        }

        sftpStream.handle(requestId, allocateHandle({ kind: "dir", remotePath: remotePath, listed: false }));
    });

    sftpStream.on("READDIR", (requestId: number, handleBuffer: Buffer) => {
        const handle = lookupHandle(handleBuffer);
        if (handle == null || handle.listed === true) {
            sftpStream.status(requestId, STATUS_CODE.EOF);
            return;
        }

        handle.listed = true;
        const childNames = remoteDirectories.get(handle.remotePath) ?? [];
        const entries = childNames.map((name) => {
            const childPath = path.posix.join(handle.remotePath, name);
            if (attributelessEntries.has(name) === true) {
                return { filename: name, longname: `? ${name}`, attrs: {} };
            }

            if (remoteDirectories.has(childPath) === true) {
                return { filename: name, longname: `drwxr-xr-x 2 root root 4096 ${name}`, attrs: directoryAttributes() };
            }

            const size = (remoteFiles.get(childPath) ?? Buffer.alloc(0)).length;
            return { filename: name, longname: `-rw-r--r-- 1 root root ${size} ${name}`, attrs: fileAttributes(size) };
        });

        sftpStream.name(requestId, entries);
    });

    const respondWithAttributes = (requestId: number, remotePath: string): void => {
        if (remoteDirectories.has(remotePath) === true) {
            sftpStream.attrs(requestId, directoryAttributes());
            return;
        }

        const content = remoteFiles.get(remotePath);
        if (content == null) {
            sftpStream.status(requestId, STATUS_CODE.NO_SUCH_FILE);
            return;
        }

        let reportedSize = content.length;
        if (sizelessFiles.has(remotePath) === true) {
            reportedSize = 0;
        }

        sftpStream.attrs(requestId, fileAttributes(reportedSize));
    };

    sftpStream.on("STAT", respondWithAttributes);
    sftpStream.on("LSTAT", respondWithAttributes);
    sftpStream.on("FSTAT", (requestId: number, handleBuffer: Buffer) => {
        const handle = lookupHandle(handleBuffer);
        if (handle == null) {
            sftpStream.status(requestId, STATUS_CODE.FAILURE);
            return;
        }

        respondWithAttributes(requestId, handle.remotePath);
    });

    sftpStream.on("REALPATH", (requestId: number, remotePath: string) => {
        sftpStream.name(requestId, [{ filename: remotePath, longname: remotePath, attrs: fileAttributes(0) }]);
    });

    sftpStream.on("SETSTAT", (requestId: number) => {
        sftpStream.status(requestId, STATUS_CODE.OK);
    });
    sftpStream.on("FSETSTAT", (requestId: number) => {
        sftpStream.status(requestId, STATUS_CODE.OK);
    });
}

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
                session.on("sftp", (acceptSftp: () => unknown) => {
                    attachSftpHandlers(acceptSftp());
                });
            });
        });

        client.on("error", () => {
            // Ignored: an aborted client must not take the test server down.
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
    remoteFiles = new Map<string, Buffer>();
    remoteDirectories = new Map<string, string[]>();
    sizelessFiles = new Set<string>();
    attributelessEntries = new Set<string>();
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-sftp-test-"));
});

afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function createProfile(): SshHostProfile {
    return {
        name: "mock-sftp",
        host: "127.0.0.1",
        port: serverPort,
        username: "tester",
        password: "pw",
        policy: createPolicy({ execTimeoutMs: 5_000, connectTimeoutMs: 5_000, maxReadFileBytes: 1_000 }),
    };
}

async function withConnection<T>(handler: (connection: SshConnection) => Promise<T>): Promise<T> {
    const connection = new SshConnection(createProfile());
    try {
        return await handler(connection);
    }
    finally {
        connection.disconnect();
    }
}

describe("listRemoteDirectory", () => {
    it("returns directories first, then files, each alphabetical", async () => {
        remoteDirectories.set("/var/log", ["syslog", "nginx", "auth.log", "apt"]);
        remoteDirectories.set("/var/log/nginx", []);
        remoteDirectories.set("/var/log/apt", []);
        remoteFiles.set("/var/log/syslog", Buffer.from("a".repeat(2048)));
        remoteFiles.set("/var/log/auth.log", Buffer.from("b"));

        const listing = await withConnection((connection) => listRemoteDirectory(connection, "/var/log"));
        const entries = listing.entries;

        expect(entries.map((entry) => entry.name)).toEqual(["apt", "nginx", "auth.log", "syslog"]);
        expect(entries[0]?.type).toBe("directory");
        expect(entries[2]?.type).toBe("file");
        expect(entries[3]?.sizeBytes).toBe(2048);
        expect(entries[3]?.mode).toBe("0644");
        expect(entries[0]?.mode).toBe("0755");
        expect(entries[3]?.modifiedAt).toBe("2026-08-07T00:00:00.000Z");
        expect(listing.totalCount).toBe(4);
        expect(listing.truncated).toBe(false);
    });

    it("rejects a path that does not exist", async () => {
        await expect(withConnection((connection) => listRemoteDirectory(connection, "/nope"))).rejects.toThrow();
    });

    it("lists the rest of the directory when one entry carries no attributes", async () => {
        remoteDirectories.set("/spool", ["good.log", "sparse.log", "other.log"]);
        remoteFiles.set("/spool/good.log", Buffer.from("a"));
        remoteFiles.set("/spool/other.log", Buffer.from("bb"));
        remoteFiles.set("/spool/sparse.log", Buffer.from("ccc"));
        attributelessEntries.add("sparse.log");

        const listing = await withConnection((connection) => listRemoteDirectory(connection, "/spool"));
        const sparse = listing.entries.find((entry) => entry.name === "sparse.log");

        expect(listing.entries).toHaveLength(3);
        expect(sparse?.modifiedAt).toBe("unknown");
        expect(sparse?.mode).toBe("?");
        expect(sparse?.sizeBytes).toBe(0);
        expect(sparse?.type).toBe("other");
    });

    it("caps a huge directory and reports the true total", async () => {
        const names = Array.from({ length: 1_200 }, (_, index) => `file-${String(index).padStart(5, "0")}.log`);
        remoteDirectories.set("/big", names);
        for (const name of names) {
            remoteFiles.set(`/big/${name}`, Buffer.from("x"));
        }

        const listing = await withConnection((connection) => listRemoteDirectory(connection, "/big"));

        expect(listing.totalCount).toBe(1_200);
        expect(listing.entries).toHaveLength(1_000);
        expect(listing.truncated).toBe(true);
    });
});

describe("readRemoteFile", () => {
    it("reads a whole file that fits under the ceiling", async () => {
        remoteFiles.set("/etc/hostname", Buffer.from("web-01\n", "utf8"));

        const file = await withConnection((connection) => readRemoteFile(connection, "/etc/hostname", 1_000));

        expect(file.content).toBe("web-01\n");
        expect(file.sizeBytes).toBe(7);
        expect(file.truncated).toBe(false);
    });

    it("returns the leading bytes of an oversized file and flags it", async () => {
        remoteFiles.set("/var/log/big.log", Buffer.from("x".repeat(5_000), "utf8"));

        const file = await withConnection((connection) => readRemoteFile(connection, "/var/log/big.log", 100));

        expect(file.content).toHaveLength(100);
        expect(file.sizeBytes).toBe(5_000);
        expect(file.truncated).toBe(true);
    });

    it("handles an empty file without hanging or over-reading", async () => {
        remoteFiles.set("/tmp/empty", Buffer.alloc(0));

        const file = await withConnection((connection) => readRemoteFile(connection, "/tmp/empty", 1_000));

        expect(file.content).toBe("");
        expect(file.sizeBytes).toBe(0);
        expect(file.readBytes).toBe(0);
        expect(file.truncated).toBe(false);
    });

    it("reads a file that reports size 0 but holds content, as /proc does", async () => {
        const content = "MemTotal:       16384000 kB\nMemFree:         2048000 kB\n";
        remoteFiles.set("/proc/meminfo", Buffer.from(content, "utf8"));
        sizelessFiles.add("/proc/meminfo");

        const file = await withConnection((connection) => readRemoteFile(connection, "/proc/meminfo", 1_000));

        expect(file.content).toBe(content);
        expect(file.readBytes).toBe(Buffer.byteLength(content, "utf8"));
        expect(file.truncated).toBe(false);
    });

    it("still honours the ceiling for a size-0 file with more content than the limit", async () => {
        remoteFiles.set("/proc/huge", Buffer.from("y".repeat(5_000), "utf8"));
        sizelessFiles.add("/proc/huge");

        const file = await withConnection((connection) => readRemoteFile(connection, "/proc/huge", 100));

        expect(file.readBytes).toBe(100);
        expect(file.truncated).toBe(true);
    });

    it("refuses a directory with a pointer to the right tool", async () => {
        remoteDirectories.set("/var/log", []);

        await expect(withConnection((connection) => readRemoteFile(connection, "/var/log", 1_000)))
            .rejects.toThrow(/ssh_list_dir/);
    });
});

describe("writeRemoteFile", () => {
    it("writes utf-8 content and reports the byte count", async () => {
        const written = await withConnection((connection) => writeRemoteFile(connection, {
            remotePath: "/opt/app/config.json",
            content: `{"a":1}`,
            append: false,
        }));

        expect(written).toBe(7);
        expect(remoteFiles.get("/opt/app/config.json")?.toString("utf8")).toBe(`{"a":1}`);
    });

    it("replaces existing content when append is false", async () => {
        remoteFiles.set("/tmp/notes", Buffer.from("old content here", "utf8"));

        await withConnection((connection) => writeRemoteFile(connection, {
            remotePath: "/tmp/notes",
            content: "new",
            append: false,
        }));

        expect(remoteFiles.get("/tmp/notes")?.toString("utf8")).toBe("new");
    });

    it("appends to existing content when append is true", async () => {
        remoteFiles.set("/tmp/notes", Buffer.from("line1\n", "utf8"));

        await withConnection((connection) => writeRemoteFile(connection, {
            remotePath: "/tmp/notes",
            content: "line2\n",
            append: true,
        }));

        expect(remoteFiles.get("/tmp/notes")?.toString("utf8")).toBe("line1\nline2\n");
    });

    it("preserves multi-byte characters", async () => {
        const content = "한글 로그 · 2026\n";

        const written = await withConnection((connection) => writeRemoteFile(connection, {
            remotePath: "/tmp/ko.txt",
            content: content,
            append: false,
        }));

        expect(remoteFiles.get("/tmp/ko.txt")?.toString("utf8")).toBe(content);
        expect(written).toBe(Buffer.byteLength(content, "utf8"));
    });
});

describe("uploadFile / downloadFile", () => {
    it("uploads a local file and reports its size", async () => {
        const localPath = path.join(temporaryDirectory, "bundle.txt");
        fs.writeFileSync(localPath, "payload".repeat(100), "utf8");

        const transferred = await withConnection((connection) => uploadFile(connection, localPath, "/tmp/bundle.txt"));

        expect(transferred).toBe(700);
        expect(remoteFiles.get("/tmp/bundle.txt")?.length).toBe(700);
    });

    it("rejects a local path that is a directory", async () => {
        await expect(withConnection((connection) => uploadFile(connection, temporaryDirectory, "/tmp/x")))
            .rejects.toThrow(/not a file/);
    });

    it("downloads a remote file to a local path", async () => {
        remoteFiles.set("/var/log/syslog", Buffer.from("log line\n".repeat(50), "utf8"));
        const localPath = path.join(temporaryDirectory, "syslog");

        const transferred = await withConnection((connection) => downloadFile(connection, "/var/log/syslog", localPath));

        expect(transferred).toBe(450);
        expect(fs.readFileSync(localPath, "utf8").startsWith("log line\n")).toBe(true);
    });

    it("round-trips binary content unchanged", async () => {
        const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x00, 0x42]);
        const sourcePath = path.join(temporaryDirectory, "blob.bin");
        const destinationPath = path.join(temporaryDirectory, "blob.copy.bin");
        fs.writeFileSync(sourcePath, payload);

        await withConnection(async (connection) => {
            await uploadFile(connection, sourcePath, "/tmp/blob.bin");
            await downloadFile(connection, "/tmp/blob.bin", destinationPath);
        });

        expect(fs.readFileSync(destinationPath).equals(payload)).toBe(true);
    });
});
