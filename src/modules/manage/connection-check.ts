import type { Writable } from "node:stream";

import { SINGLE_HOST_ENV } from "@/_defs";
import type { SshHostProfile } from "@/_types";
import { loadHostProfile } from "@/modules/config";
import { SshConnection } from "@/modules/ssh";

export interface ConnectionCheckResult {
    connected: boolean;
    /** Fingerprints the server presented, pinned or not; null when the handshake never got there. */
    hostKeyFingerprint: string | null;
    jumpHostKeyFingerprint: string | null;
}

/**
 * Builds a profile from an entry's env the way the server will at startup — so a value the
 * server would reject is caught here, not when the agent first calls a tool.
 */
export function profileFromEnv(output: Writable, env: Record<string, string>): SshHostProfile | null {
    try {
        const profile = loadHostProfile(env);
        if (profile == null) {
            output.write("  The entry has no host.\n");
        }
        return profile;
    }
    catch (ex) {
        let detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
        output.write(`  The server would refuse to start with this entry: ${detail}\n`);
        return null;
    }
}

/**
 * How the host will authenticate, including the key path.
 *
 * The path is shown here but withheld from the runtime error message: the check is run by
 * the operator on their own terminal, whereas that message is handed to a model.
 */
function describeAuth(profile: SshHostProfile): string {
    if (profile.privateKeyPath != null) {
        return `key ${profile.privateKeyPath}`;
    }

    if (profile.password != null) {
        return "password";
    }

    return "ssh agent";
}

/**
 * Connects to the host and reports what happened — the body of `--check`, shared with the
 * `setup` command so a host that passes setup passes `--check`.
 *
 * Without this the only way to find out whether the setup works is to ask an agent to try
 * something, which mixes a setup mistake up with a policy rejection.
 */
export async function runConnectionCheck(profile: SshHostProfile, output: Writable): Promise<ConnectionCheckResult> {
    const endpoint = `${profile.username}@${profile.host}:${profile.port}`;
    const auth = describeAuth(profile);
    output.write(`Checking ${profile.name}  →  ${endpoint}\n`);

    if (profile.proxyCommand != null) {
        output.write(`  via proxy command: ${profile.proxyCommand}\n`);
    }

    if (profile.jump != null) {
        output.write(`  via jump host: ${profile.jump.username}@${profile.jump.host}:${profile.jump.port}\n`);
    }

    output.write("\n");

    const connection = new SshConnection(profile);
    const startedAt = Date.now();

    let connected = false;
    let detail = "";

    try {
        await connection.connect();
        connected = true;
    }
    catch (ex) {
        detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
    }
    finally {
        connection.disconnect();
    }

    const durationMs = Date.now() - startedAt;

    if (connected == true) {
        output.write(`  OK      ${endpoint}  (${auth}, ${durationMs}ms)\n`);
    }
    else {
        output.write(`  FAILED  ${endpoint}  (${auth})\n`);
        output.write(`          ${detail}\n`);
    }

    if (connection.hostKeyFingerprint != null) {
        let pinNote = `not pinned — set ${SINGLE_HOST_ENV.HOST_KEY} to it to detect a changed key`;
        if (profile.hostKeyFingerprint != null) {
            pinNote = "pinned";
        }

        output.write(`          host key ${connection.hostKeyFingerprint}  (${pinNote})\n`);
    }

    if (connection.jumpHostKeyFingerprint != null) {
        let pinNote = `not pinned — set ${SINGLE_HOST_ENV.JUMP_HOST_KEY} to it to detect a changed key`;
        if (profile.jump?.hostKeyFingerprint != null) {
            pinNote = "pinned";
        }

        output.write(`          jump host key ${connection.jumpHostKeyFingerprint}  (${pinNote})\n`);
    }

    return {
        connected: connected,
        hostKeyFingerprint: connection.hostKeyFingerprint,
        jumpHostKeyFingerprint: connection.jumpHostKeyFingerprint,
    };
}
