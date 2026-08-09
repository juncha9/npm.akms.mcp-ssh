import fs from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger, expandHomePath, formatBytes } from "@/_libs";
import { GuardRejectionError, inspectLocalPath } from "@/modules/guard";
import {
    downloadFile,
    listRemoteDirectory,
    readRemoteFile,
    uploadFile,
    writeRemoteFile,
} from "@/modules/ssh";

import { formatDirectoryListing } from "./format";
import {
    resolveProfile,
    textResult,
    toToolError,
    withHostConnection,
} from "./tool-context";
import type { ToolContext } from "./tool-context";

const SESSION_DESCRIPTION = "Session id from ssh_connect, whose connection is reused. Omit it to open a one-off connection.";

/**
 * Screens a path on the machine running this server.
 *
 * The remote side is guarded inside the SFTP layer, where the policy lives. The local
 * side has no policy — it is the operator's own filesystem — so it is checked here, at
 * the only layer that knows the path came from a tool argument.
 *
 * @throws {GuardRejectionError} If the path is protected.
 */
function requirePermittedLocalPath(localPath: string, access: "read" | "write"): void {
    const verdict = inspectLocalPath(localPath, access);
    if (verdict.allowed == false) {
        throw new GuardRejectionError(verdict);
    }
}

export function registerFileTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "ssh_list_dir",
        {
            title: "List a remote directory",
            description: [
                "List a directory on the configured SSH host over SFTP, with type, permissions, size and mtime.",
                "Cheaper and more structured than running 'ls -la' through ssh_exec, and it works on a read-only host.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute remote directory path. When SSH_ALLOWED_PATHS is set, only paths inside it are accepted."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ path: remotePath, session }) => {
            const _logger = $logger.child({ context: "ssh_list_dir", remote_path: remotePath });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });

                const listing = await withHostConnection(profile, openSession, async (connection) => {
                    return await listRemoteDirectory(connection, remotePath);
                });

                _logger.info("remote directory listed", {
                    profile: profile.name,
                    entry_count: listing.totalCount,
                    truncated: listing.truncated,
                });
                const rendered = formatDirectoryListing(remotePath, listing);
                return textResult(rendered);
            }
            catch (ex) {
                return toToolError(ex, "ssh_list_dir", `list ${remotePath}`);
            }
        }
    );

    server.registerTool(
        "ssh_read_file",
        {
            title: "Read a remote file",
            description: [
                "Read a remote text file over SFTP and return its contents.",
                "Oversized files come back truncated to their leading bytes rather than failing, so pointing this at a large log is safe.",
                "Files that report size 0 but hold content (/proc, /sys) are read in full up to the ceiling.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute remote file path."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
                maxBytes: z.number().int().positive().optional().describe("Lowers the read ceiling for this call; it cannot exceed SSH_MAX_READ_BYTES."),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ path: remotePath, session, maxBytes }) => {
            const _logger = $logger.child({ context: "ssh_read_file", remote_path: remotePath });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });

                // Clamped, not defaulted: an override above the profile ceiling would let one
                // call buffer hundreds of megabytes and take the server down.
                const requestedLimit = maxBytes ?? profile.policy.maxReadFileBytes;
                const readLimit = Math.min(requestedLimit, profile.policy.maxReadFileBytes);

                const file = await withHostConnection(profile, openSession, async (connection) => {
                    return await readRemoteFile(connection, remotePath, readLimit);
                });

                let header = `${remotePath} — ${formatBytes(file.readBytes)} read`;
                if (file.sizeBytes > 0) {
                    header = `${remotePath} — ${formatBytes(file.sizeBytes)}`;
                }

                if (file.truncated == true) {
                    header += `, truncated to the first ${formatBytes(file.readBytes)}`;
                }

                _logger.info("remote file read", {
                    profile: profile.name,
                    size_bytes: file.sizeBytes,
                    read_bytes: file.readBytes,
                    truncated: file.truncated,
                });
                return textResult(`${header}\n\n${file.content}`);
            }
            catch (ex) {
                return toToolError(ex, "ssh_read_file", `read ${remotePath}`);
            }
        }
    );

    server.registerTool(
        "ssh_write_file",
        {
            title: "Write a remote file",
            description: [
                "Write or append UTF-8 text to a file on the configured SSH host over SFTP.",
                "Use this instead of 'echo ... > file' through ssh_exec: no shell quoting to get wrong, and it works with multi-line content.",
                "Refused on a read-only host. The parent directory must already exist.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute remote file path. Existing content is replaced unless 'append' is true."),
                content: z.string().describe("UTF-8 text to write."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
                append: z.boolean().optional().describe("Append instead of replacing. Defaults to false."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ path: remotePath, content, session, append }) => {
            const _logger = $logger.child({ context: "ssh_write_file", remote_path: remotePath });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });
                const shouldAppend = append ?? false;

                const writtenBytes = await withHostConnection(profile, openSession, async (connection) => {
                    return await writeRemoteFile(connection, {
                        remotePath: remotePath,
                        content: content,
                        append: shouldAppend,
                    });
                });

                let verb = "Wrote";
                if (shouldAppend == true) {
                    verb = "Appended";
                }

                _logger.info("remote file written", { profile: profile.name, bytes: writtenBytes });
                return textResult(`${verb} ${formatBytes(writtenBytes)} to ${remotePath} on ${profile.name}.`);
            }
            catch (ex) {
                return toToolError(ex, "ssh_write_file", `write ${remotePath}`);
            }
        }
    );

    server.registerTool(
        "ssh_upload",
        {
            title: "Upload a file over SFTP",
            description: [
                "Upload a local file to the configured SSH host over SFTP.",
                "Refused on a read-only host, and for local paths holding credentials (SSH keys, cloud credentials).",
                "The remote parent directory must already exist.",
            ].join(" "),
            inputSchema: {
                localPath: z.string().min(1).describe("Local file path on the machine running this MCP server. '~' is expanded."),
                remotePath: z.string().min(1).describe("Absolute destination path on the remote host, including the filename."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ localPath, remotePath, session }) => {
            const _logger = $logger.child({ context: "ssh_upload", remote_path: remotePath });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });

                const resolvedLocalPath = expandHomePath(localPath);
                requirePermittedLocalPath(resolvedLocalPath, "read");

                if (fs.existsSync(resolvedLocalPath) == false) {
                    return textResult(`local file not found: ${resolvedLocalPath}`);
                }

                const transferredBytes = await withHostConnection(profile, openSession, async (connection) => {
                    return await uploadFile(connection, resolvedLocalPath, remotePath);
                });

                _logger.info("file uploaded", { profile: profile.name, bytes: transferredBytes });
                return textResult(`Uploaded ${resolvedLocalPath} → ${remotePath} (${formatBytes(transferredBytes)}) on ${profile.name}.`);
            }
            catch (ex) {
                return toToolError(ex, "ssh_upload", `upload to ${remotePath}`);
            }
        }
    );

    server.registerTool(
        "ssh_download",
        {
            title: "Download a file over SFTP",
            description: [
                "Download a file from the configured SSH host to the machine running this MCP server.",
                "Use this for binaries or files too large to read into the conversation; missing local directories are created.",
                "The local destination is overwritten, and paths holding credentials are refused.",
            ].join(" "),
            inputSchema: {
                remotePath: z.string().min(1).describe("Absolute source path on the remote host."),
                localPath: z.string().min(1).describe("Local destination path, including the filename. '~' is expanded. Overwritten if it exists."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ remotePath, localPath, session }) => {
            const _logger = $logger.child({ context: "ssh_download", remote_path: remotePath });

            try {
                const { profile, session: openSession } = resolveProfile(context, { session: session });

                const resolvedLocalPath = expandHomePath(localPath);
                requirePermittedLocalPath(resolvedLocalPath, "write");

                fs.mkdirSync(path.dirname(resolvedLocalPath), { recursive: true });

                const transferredBytes = await withHostConnection(profile, openSession, async (connection) => {
                    return await downloadFile(connection, remotePath, resolvedLocalPath);
                });

                _logger.info("file downloaded", { profile: profile.name, bytes: transferredBytes });
                return textResult(`Downloaded ${remotePath} → ${resolvedLocalPath} (${formatBytes(transferredBytes)}) from ${profile.name}.`);
            }
            catch (ex) {
                return toToolError(ex, "ssh_download", `download ${remotePath}`);
            }
        }
    );
}
