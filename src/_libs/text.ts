/** Output cut to `maxCharacters`, with a note appended when anything was dropped. */
export interface TruncatedText {
    text: string;
    truncated: boolean;
}

/**
 * Cuts `text` to `maxCharacters`, appending a note saying how much was dropped.
 *
 * @returns The possibly-cut text and whether anything was removed.
 */
export function truncateOutput(text: string, maxCharacters: number): TruncatedText {
    if (text.length <= maxCharacters) {
        return { text: text, truncated: false };
    }

    // Never cut between the halves of a surrogate pair: the orphaned half renders as a
    // replacement character, so an emoji at the boundary would come back corrupted.
    let cutAt = maxCharacters;
    const lastKeptCode = text.charCodeAt(cutAt - 1);
    if (lastKeptCode >= 0xd800 && lastKeptCode <= 0xdbff) {
        cutAt -= 1;
    }

    const droppedCharacters = text.length - cutAt;
    const kept = text.slice(0, cutAt);
    return {
        text: `${kept}\n... [truncated ${droppedCharacters} characters of ${text.length}]`,
        truncated: true,
    };
}

/**
 * Wraps a value in single quotes for POSIX shells, escaping embedded quotes as `'\''`.
 * Used for interpolating paths into the `cd` prefix — never for user commands, which
 * are passed through verbatim so the remote shell parses them as written.
 */
export function quoteShellArgument(value: string): string {
    const escaped = value.replace(/'/g, `'\\''`);
    return `'${escaped}'`;
}

/** Renders a byte count as `B` / `KB` / `MB` for display in tool output. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        const kilobytes = bytes / 1024;
        return `${kilobytes.toFixed(1)} KB`;
    }

    const megabytes = bytes / (1024 * 1024);
    return `${megabytes.toFixed(1)} MB`;
}
