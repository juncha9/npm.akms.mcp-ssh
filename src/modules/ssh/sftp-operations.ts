import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

import { MAX_DIRECTORY_ENTRIES } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshRemoteEntry } from "@/_types";
import { GuardRejectionError, inspectRemotePath } from "@/modules/guard";
import type { RemotePathAccess } from "@/modules/guard";

import type { SshConnection } from "./ssh-connection";

/**
 * Screens a remote path against the connection's own policy.
 *
 * Enforced here rather than in the tool handlers for the same reason `exec` screens its
 * own command: this is the layer every path must pass through, so a new tool cannot
 * forget the check.
 *
 * @throws {GuardRejectionError} If the policy refuses the path.
 */
function requirePermittedPath(connection: SshConnection, remotePath: string, access: RemotePathAccess): void {
    const verdict = inspectRemotePath(remotePath, connection.profile.policy, access);
    if (verdict.allowed == false) {
        throw new GuardRejectionError(verdict);
    }
}

function toEntryType(attrs: Stats): SshRemoteEntry["type"] {
    // SFTP attributes are flag-gated; without PERMISSIONS every predicate answers false.
    if (typeof attrs.mode !== "number") {
        return "other";
    }

    if (attrs.isDirectory() == true) {
        return "directory";
    }

    if (attrs.isSymbolicLink() == true) {
        return "symlink";
    }

    if (attrs.isFile() == true) {
        return "file";
    }

    return "other";
}

/**
 * ssh2 `Stats` → the listing shape returned to the model.
 *
 * Every field is optional on the wire: a server may answer readdir without SIZE or
 * ACMODTIME. Reading them unguarded turned one such entry into `new Date(NaN)` and a
 * thrown RangeError that failed the whole directory listing.
 */
function toRemoteEntry(entry: FileEntryWithStats): SshRemoteEntry {
    const attrs = entry.attrs;

    let mode = "?";
    if (typeof attrs.mode === "number") {
        mode = `0${(attrs.mode & 0o7777).toString(8)}`;
    }

    let sizeBytes = 0;
    if (typeof attrs.size === "number" && Number.isFinite(attrs.size) == true) {
        sizeBytes = attrs.size;
    }

    let modifiedAt = "unknown";
    if (typeof attrs.mtime === "number" && Number.isFinite(attrs.mtime) == true) {
        modifiedAt = new Date(attrs.mtime * 1000).toISOString();
    }

    return {
        name: entry.filename,
        type: toEntryType(attrs),
        sizeBytes: sizeBytes,
        mode: mode,
        modifiedAt: modifiedAt,
    };
}

export interface RemoteDirectoryListing {
    entries: SshRemoteEntry[];
    /** Entries the remote host reported, before the cap was applied. */
    totalCount: number;
    truncated: boolean;
}

/**
 * Lists a remote directory, directories first then files, each group alphabetical.
 *
 * Capped at `MAX_DIRECTORY_ENTRIES`: this is the one output path with no byte ceiling,
 * and a spool directory with half a million files would otherwise return megabytes.
 *
 * @throws {Error} If the path does not exist or is not readable.
 */
export async function listRemoteDirectory(
    connection: SshConnection,
    remotePath: string
): Promise<RemoteDirectoryListing> {
    requirePermittedPath(connection, remotePath, "read");

    return await connection.withSftp(async (sftp: SFTPWrapper) => {
        const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
            sftp.readdir(remotePath, (error, list) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve(list);
            });
        });

        const mapped = entries.map(toRemoteEntry);
        mapped.sort((left, right) => {
            if (left.type === "directory" && right.type !== "directory") {
                return -1;
            }

            if (left.type !== "directory" && right.type === "directory") {
                return 1;
            }

            return left.name.localeCompare(right.name);
        });

        return {
            entries: mapped.slice(0, MAX_DIRECTORY_ENTRIES),
            totalCount: mapped.length,
            truncated: mapped.length > MAX_DIRECTORY_ENTRIES,
        };
    });
}

export interface RemoteFileContent {
    content: string;
    /** Size the remote host reported; 0 for virtual files that do not declare one. */
    sizeBytes: number;
    /** Bytes actually read. */
    readBytes: number;
    truncated: boolean;
}

/**
 * Reads a remote file as UTF-8, stopping after `maxBytes`.
 *
 * Oversized files return their leading bytes rather than an error — a 2 GB log is exactly
 * the case where the first chunk is what you wanted anyway.
 *
 * A reported size of 0 does not mean empty: every file under /proc and most of /sys says 0
 * while holding real content. Those are read unbounded up to `maxBytes` instead of being
 * range-limited, which previously returned exactly one byte and called it the whole file.
 *
 * @throws {Error} If the path is missing, is a directory, or is not readable.
 */
export async function readRemoteFile(
    connection: SshConnection,
    remotePath: string,
    maxBytes: number
): Promise<RemoteFileContent> {
    requirePermittedPath(connection, remotePath, "read");

    return await connection.withSftp(async (sftp: SFTPWrapper) => {
        const attrs = await new Promise<Stats>((resolve, reject) => {
            sftp.stat(remotePath, (error, stats) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve(stats);
            });
        });

        if (attrs.isDirectory() == true) {
            throw new Error(`${remotePath} is a directory, use ssh_list_dir instead`);
        }

        let declaredSize = 0;
        if (typeof attrs.size === "number" && Number.isFinite(attrs.size) == true) {
            declaredSize = attrs.size;
        }

        const isSizeKnown = declaredSize > 0;

        const streamOptions: { start?: number; end?: number } = {};
        if (isSizeKnown == true) {
            streamOptions.start = 0;
            streamOptions.end = Math.min(declaredSize, maxBytes) - 1;
        }

        const chunks: Buffer[] = [];
        let collectedBytes = 0;

        await new Promise<void>((resolve, reject) => {
            const stream = sftp.createReadStream(remotePath, streamOptions);

            stream.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
                collectedBytes += chunk.length;

                if (collectedBytes >= maxBytes) {
                    stream.destroy();
                    resolve();
                }
            });
            stream.on("error", (error: Error) => {
                reject(error);
            });
            stream.on("end", () => {
                resolve();
            });
            stream.on("close", () => {
                resolve();
            });
        });

        const buffer = Buffer.concat(chunks, Math.min(collectedBytes, maxBytes));

        let truncated = false;
        if (isSizeKnown == true) {
            truncated = declaredSize > buffer.length;
        }
        else {
            truncated = buffer.length >= maxBytes;
        }

        // Decoded through StringDecoder for the same reason the exec path does: the cut
        // lands at an arbitrary byte offset, and a plain toString() turns the multi-byte
        // character straddling it into U+FFFD. `end()` drops the incomplete tail instead.
        const decoder = new StringDecoder("utf8");
        const content = decoder.write(buffer) + decoder.end();

        return {
            content: content,
            sizeBytes: declaredSize,
            readBytes: buffer.length,
            truncated: truncated,
        };
    });
}

/**
 * Writes UTF-8 text to a remote path, replacing or appending.
 *
 * @throws {Error} If the parent directory is missing or the account cannot write there.
 */
export async function writeRemoteFile(
    connection: SshConnection,
    args: { remotePath: string; content: string; append: boolean }
): Promise<number> {
    const { remotePath, content, append } = args;

    requirePermittedPath(connection, remotePath, "write");

    const payload = Buffer.from(content, "utf8");

    await connection.withSftp(async (sftp: SFTPWrapper) => {
        await new Promise<void>((resolve, reject) => {
            const callback = (error: Error | null | undefined): void => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve();
            };

            if (append == true) {
                sftp.appendFile(remotePath, payload, callback);
                return;
            }

            sftp.writeFile(remotePath, payload, callback);
        });
    });

    const _logger = $logger.child({
        context: "writeRemoteFile",
        profile: connection.profile.name,
        remote_path: remotePath,
        append: append,
    });
    _logger.info("remote file written", { bytes: payload.length });

    return payload.length;
}

/**
 * Uploads a local file with SFTP.
 *
 * @returns Bytes transferred.
 * @throws {Error} If the local file is missing or the remote path is not writable.
 */
export async function uploadFile(
    connection: SshConnection,
    localPath: string,
    remotePath: string
): Promise<number> {
    requirePermittedPath(connection, remotePath, "write");

    const localStats = fs.statSync(localPath);
    if (localStats.isFile() == false) {
        throw new Error(`local path is not a file: ${localPath}`);
    }

    await connection.withSftp(async (sftp: SFTPWrapper) => {
        await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (error) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    });

    const _logger = $logger.child({
        context: "uploadFile",
        profile: connection.profile.name,
        local_path: localPath,
        remote_path: remotePath,
    });
    _logger.info("file uploaded", { bytes: localStats.size });

    return localStats.size;
}

/**
 * Downloads a remote file with SFTP.
 *
 * @returns Bytes written locally.
 * @throws {Error} If the remote file is missing or the local path is not writable.
 */
export async function downloadFile(
    connection: SshConnection,
    remotePath: string,
    localPath: string
): Promise<number> {
    requirePermittedPath(connection, remotePath, "read");

    await connection.withSftp(async (sftp: SFTPWrapper) => {
        await new Promise<void>((resolve, reject) => {
            sftp.fastGet(remotePath, localPath, (error) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    });

    const localStats = fs.statSync(localPath);

    const _logger = $logger.child({
        context: "downloadFile",
        profile: connection.profile.name,
        remote_path: remotePath,
        local_path: localPath,
    });
    _logger.info("file downloaded", { bytes: localStats.size });

    return localStats.size;
}
