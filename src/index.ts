export { createSshMcpServer } from "./server";
export type { SshMcpServerInstance } from "./server";

export { loadHostProfile, toHostSummary } from "./modules/config";

export {
    SshConnection,
    SshSession,
    SshSessionManager,
    listRemoteDirectory,
    readRemoteFile,
    writeRemoteFile,
    uploadFile,
    downloadFile,
} from "./modules/ssh";
export type { SshExecOptions, RemoteFileContent, RemoteDirectoryListing } from "./modules/ssh";

export {
    inspectCommand,
    inspectRemotePath,
    inspectLocalPath,
    inspectWorkingDirectory,
    normalizeCommandText,
    canonicalizeCommand,
    splitCommandSegments,
    stripQuotedText,
    extractSubstitutions,
    analyzeSegment,
    GuardRejectionError,
} from "./modules/guard";
export type { RemotePathAccess, SegmentAnalysis } from "./modules/guard";

export { registerAllTools } from "./modules/tools";
export type { ToolContext } from "./modules/tools";

export { $logger } from "./_libs";
export type { Logger, LogLevel } from "./_libs";

export { SERVER_NAME, SERVER_VERSION, LOG_LEVEL_ENV, SINGLE_HOST_ENV } from "./_defs";

export type {
    SshPolicy,
    SshHostProfile,
    SshHostSummary,
    SshExecResult,
    SshSessionInfo,
    SshRemoteEntry,
    GuardVerdict,
} from "./_types";
