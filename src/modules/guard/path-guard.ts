import fs from "node:fs";
import path from "node:path";

import { PROTECTED_LOCAL_PATH_RULES, UNSAFE_PATH_CHARACTER_PATTERN } from "@/_defs";
import { $logger, isAbsoluteRemotePath, isRemotePathWithin, normalizeRemotePath } from "@/_libs";
import type { GuardVerdict, SshPolicy } from "@/_types";

export type RemotePathAccess = "read" | "write";

/**
 * Decides whether a file tool may touch a remote path.
 *
 * With `allowedPaths` set, only absolute paths are accepted: a relative path resolves
 * against the SFTP session's own working directory, which the guard cannot see, so it
 * could escape the allow-list without any way to detect it here.
 *
 * Symlinks on the remote side are not resolved — the guard has no view of that
 * filesystem. `allowedPaths` therefore bounds *names*, not inodes.
 */
export function inspectRemotePath(
    remotePath: string,
    policy: SshPolicy,
    access: RemotePathAccess
): GuardVerdict {
    const trimmedPath = remotePath.trim();
    if (trimmedPath === "") {
        return { allowed: false, reason: "path is empty" };
    }

    if (access === "write" && policy.readonly == true) {
        return {
            allowed: false,
            reason: "profile is read-only, remote writes are not permitted",
            offendingText: trimmedPath,
        };
    }

    if (policy.allowedPaths.length === 0) {
        return { allowed: true };
    }

    if (isAbsoluteRemotePath(trimmedPath) == false) {
        return {
            allowed: false,
            reason: `this profile restricts file access to ${policy.allowedPaths.join(", ")}, so the path must be absolute`,
            offendingText: trimmedPath,
        };
    }

    const normalizedPath = normalizeRemotePath(trimmedPath);
    const matched = policy.allowedPaths.some((allowedPath) => isRemotePathWithin(normalizedPath, allowedPath) == true);
    if (matched == false) {
        return {
            allowed: false,
            reason: `path is outside this profile's allowedPaths (${policy.allowedPaths.join(", ")})`,
            offendingText: normalizedPath,
        };
    }

    return { allowed: true };
}

/**
 * Resolves symlinks so the guard compares the file that will actually be touched.
 *
 * A lexical `path.resolve` is not enough: `~/notes.txt` symlinked to `~/.ssh/id_ed25519`
 * matches no rule by name, and both `fastPut` and `fastGet` follow the link. For a path
 * that does not exist yet (the normal download case) the parent directory is resolved
 * instead, which catches a symlinked *directory*.
 */
function toRealPath(inputPath: string): string {
    const _logger = $logger.child({ context: "toRealPath" });

    try {
        return fs.realpathSync.native(inputPath);
    }
    catch (ex) {
        // Expected for a download destination that does not exist yet, so this is not an
        // error — but it must not pass unrecorded, since the fallback guards less.
        _logger.debug("path does not resolve, falling back to its parent directory", {
            reason: ex instanceof Error ? ex.name : "unknown",
        });
    }

    try {
        const parentRealPath = fs.realpathSync.native(path.dirname(inputPath));
        return path.join(parentRealPath, path.basename(inputPath));
    }
    catch (ex) {
        _logger.debug("parent directory does not resolve either, comparing lexically", {
            reason: ex instanceof Error ? ex.name : "unknown",
        });
        return path.resolve(inputPath);
    }
}

/** Path form the protected-path rules are written against. */
function toComparablePath(inputPath: string): string {
    return toRealPath(inputPath).replace(/\\/g, "/");
}

/**
 * Decides whether a file tool may touch a path on the machine running this server.
 *
 * Separate from the remote guard because the threat is inverted: here the danger is
 * reading the operator's own credentials out (upload) or overwriting the files that
 * define the guards themselves (download).
 *
 * @param resolvedLocalPath Absolute path, already `~`-expanded.
 * @param extraProtectedPaths Runtime-known paths to protect on top of the built-in rules,
 *                            for a host embedding this server as a library.
 */
export function inspectLocalPath(
    resolvedLocalPath: string,
    access: RemotePathAccess,
    extraProtectedPaths: string[] = []
): GuardVerdict {
    const trimmedPath = resolvedLocalPath.trim();
    if (trimmedPath === "") {
        return { allowed: false, reason: "local path is empty" };
    }

    const comparablePath = toComparablePath(trimmedPath);

    for (const rule of PROTECTED_LOCAL_PATH_RULES) {
        if (rule.pattern.test(comparablePath) == true) {
            let verb = "read from";
            if (access === "write") {
                verb = "written to";
            }

            return {
                allowed: false,
                reason: `local path is protected and cannot be ${verb}: ${rule.reason}`,
                offendingText: trimmedPath,
            };
        }
    }

    for (const protectedPath of extraProtectedPaths) {
        if (protectedPath === "") {
            continue;
        }

        if (comparablePath.toLowerCase() === toComparablePath(protectedPath).toLowerCase()) {
            return {
                allowed: false,
                reason: "local path is this server's own configuration file",
                offendingText: trimmedPath,
            };
        }
    }

    return { allowed: true };
}

/**
 * Decides whether a `cwd` argument is safe to interpolate into the generated `cd` prefix.
 *
 * `cwd` never reaches the command guard — it is not a command — yet it lands in the same
 * remote shell script. Without this check, `cwd: '/tmp"; rm -rf /; #'` executes with every
 * command guard bypassed.
 */
export function inspectWorkingDirectory(cwd: string): GuardVerdict {
    const trimmedCwd = cwd.trim();
    if (trimmedCwd === "") {
        return { allowed: true };
    }

    const unsafeMatch = UNSAFE_PATH_CHARACTER_PATTERN.exec(trimmedCwd);
    if (unsafeMatch != null) {
        const displayCharacter = unsafeMatch[0]
            .replace(/\n/, "\\n")
            .replace(/\r/, "\\r")
            .replace(/\t/, "\\t");
        return {
            allowed: false,
            reason: `cwd contains the shell metacharacter '${displayCharacter}', which is not allowed in a directory argument`,
            offendingText: trimmedCwd,
        };
    }

    return { allowed: true };
}

/** Warns once when a profile's own settings make its guards inert. */
export function warnOnInertPolicy(profileName: string, policy: SshPolicy): void {
    if (policy.readonly == true || policy.allowCommands.length > 0 || policy.denyPatterns.length > 0) {
        return;
    }

    const _logger = $logger.child({ context: "warnOnInertPolicy", profile: profileName });
    _logger.debug("profile runs with catastrophe-only guards; remote account permissions are the real boundary");
}
