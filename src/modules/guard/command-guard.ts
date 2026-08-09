import {
    BARE_REDIRECTION_OPERATOR_PATTERN,
    BENIGN_REDIRECT_PATTERN,
    COMMAND_WRAPPER_BINARIES,
    DANGEROUS_ARGUMENT_RULES,
    DANGEROUS_COMMAND_RULES,
    DANGEROUS_PIPELINE_RULES,
    NUMERIC_OPERAND_PATTERN,
    OUTPUT_REDIRECT_PATTERN,
    PRIVILEGE_ESCALATION_BINARIES,
    REDIRECTION_TOKEN_PATTERN,
    SHELL_KEYWORD_TOKENS,
    SHELL_PAYLOAD_BINARIES,
    SHELL_TOKEN_PATTERN,
    WRAPPER_VALUE_FLAGS,
    WRITE_COMMAND_BINARIES,
    WRITE_USAGE_RULES,
} from "@/_defs";
import type { GuardVerdict, SshPolicy } from "@/_types";

/** Membership lists as sets — these are hit once per token, per segment, per command. */
const WRAPPER_BINARY_SET = new Set(COMMAND_WRAPPER_BINARIES);
const PRIVILEGE_BINARY_SET = new Set(PRIVILEGE_ESCALATION_BINARIES);
const SHELL_PAYLOAD_BINARY_SET = new Set(SHELL_PAYLOAD_BINARIES);
const WRITE_BINARY_SET = new Set(WRITE_COMMAND_BINARIES);
const SHELL_KEYWORD_SET = new Set(SHELL_KEYWORD_TOKENS);

/** `bash -c "sh -c '…'"` nests; three levels is far past anything legitimate. */
const MAX_INSPECTION_DEPTH = 3;

const ASSIGNMENT_TOKEN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `-c` alone, or bundled into a short-flag cluster like `-lc` / `-exc`. */
const SHELL_COMMAND_FLAG_PATTERN = /^-[a-z]*c$/i;

/**
 * Rewrites shell constructs that change how the text tokenizes but not what it runs,
 * so the rules below see the same command the remote shell will.
 *
 * - `\` + newline is a line continuation. POSIX removes it entirely — folding it to a
 *   space instead would split `r\⏎m` into two words and hide `rm` from every rule, so it
 *   is removed, and the *canonical* text is what gets executed (see `canonicalizeCommand`).
 * - `${IFS}` / `$IFS` expand to whitespace, the standard way to write a command with no
 *   literal spaces in it.
 */
export function normalizeCommandText(command: string): string {
    return command
        .replace(/\\\r?\n/g, "")
        .replace(/\$\{IFS\}/g, " ")
        .replace(/\$IFS/g, " ");
}

/**
 * The exact text that must be sent to the remote shell.
 *
 * Validating one string and executing another is a bypass by construction: the guard saw
 * `r m -rf /` while the host ran `rm -rf /`. Callers run this, then send its result.
 */
export function canonicalizeCommand(command: string): string {
    return normalizeCommandText(command);
}

/**
 * Splits a command line on `;`, `&&`, `||`, `|`, `&` and newlines, leaving quoted text intact.
 * `2>&1` keeps its `&` — a `&` directly after `>` is redirection, not a background operator.
 */
export function splitCommandSegments(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let openQuote: string | null = null;

    for (let index = 0; index < command.length; index++) {
        const character = command[index];
        const nextCharacter = command[index + 1];

        if (openQuote != null) {
            current += character;
            // Single quotes take no escapes in POSIX; double quotes do.
            if (character === "\\" && openQuote === `"` && nextCharacter != null) {
                current += nextCharacter;
                index++;
                continue;
            }
            if (character === openQuote) {
                openQuote = null;
            }
            continue;
        }

        if (character === "'" || character === `"`) {
            openQuote = character;
            current += character;
            continue;
        }

        if (character === "\\") {
            current += character;
            if (nextCharacter != null) {
                current += nextCharacter;
                index++;
            }
            continue;
        }

        if (character === "&" && current.trimEnd().endsWith(">") == true) {
            current += character;
            continue;
        }

        const isDoubleOperator = (character === "&" && nextCharacter === "&") || (character === "|" && nextCharacter === "|");
        if (isDoubleOperator == true) {
            segments.push(current);
            current = "";
            index++;
            continue;
        }

        if (character === ";" || character === "\n" || character === "|" || character === "&") {
            segments.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    segments.push(current);

    return segments
        .map((segment) => segment.trim())
        .filter((segment) => segment !== "");
}

/**
 * Drops quoted spans so `echo "a > b"` isn't read as a redirection.
 *
 * Quote state is checked *before* the backslash branch: POSIX single quotes take no
 * escapes, so treating `'x\'` as an escaped quote left the span open and swallowed the
 * rest of the line — including a real `> /etc/…` redirection.
 */
export function stripQuotedText(segment: string): string {
    let result = "";
    let openQuote: string | null = null;

    for (let index = 0; index < segment.length; index++) {
        const character = segment[index];

        if (openQuote === "'") {
            if (character === "'") {
                openQuote = null;
            }
            continue;
        }

        if (openQuote === `"`) {
            if (character === "\\") {
                index++;
                continue;
            }
            if (character === `"`) {
                openQuote = null;
            }
            continue;
        }

        if (character === "\\") {
            index++;
            continue;
        }

        if (character === "'" || character === `"`) {
            openQuote = character;
            continue;
        }

        result += character;
    }

    return result;
}

/** Splits a segment into shell words, keeping quoted spans as one word. */
function tokenizeSegment(segment: string): string[] {
    const tokens = segment.match(SHELL_TOKEN_PATTERN);
    if (tokens == null) {
        return [];
    }

    return tokens;
}

/** Removes quoting so an operand can be compared against a path pattern. */
function unquoteToken(token: string): string {
    if (token.includes("'") == false && token.includes(`"`) == false && token.includes("\\") == false) {
        return token;
    }

    return token
        // ANSI-C quoting: `$'rm'` is the word `rm`, and dropping only the quotes would
        // leave `$rm` — a binary name no rule matches.
        .replace(/\$'([^']*)'/g, "$1")
        .replace(/'([^']*)'/g, "$1")
        .replace(/"([^"]*)"/g, "$1")
        .replace(/\\(.)/g, "$1");
}

/**
 * Collapses `.`, `..` and duplicate slashes in an operand before it is matched.
 *
 * `rm -rf //*`, `/./*` and `/bin/../bin` all name the same targets as the plain forms,
 * and a literal-spelling comparison would miss every one of them. Trailing glob characters
 * are preserved because the patterns match on them.
 */
function normalizeOperand(operand: string): string {
    if (operand.startsWith("/") == false) {
        return operand;
    }

    let globSuffix = "";
    if (operand.endsWith("*") == true) {
        globSuffix = "*";
    }

    const withoutGlob = operand.slice(0, operand.length - globSuffix.length);
    const collapsed = withoutGlob.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "/").replace(/\/{2,}/g, "/");

    if (collapsed === "") {
        return `/${globSuffix}`;
    }

    return `${collapsed}${globSuffix}`;
}

/**
 * Commands nested inside the text: `$(…)`, backticks, and process substitution
 * `<(…)` / `>(…)`. Each runs as a command in its own right.
 */
export function extractSubstitutions(command: string): string[] {
    const found: string[] = [];

    const nestedPattern = /(?:\$|<|>)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let nestedMatch = nestedPattern.exec(command);
    while (nestedMatch != null) {
        found.push(nestedMatch[1]);
        nestedMatch = nestedPattern.exec(command);
    }

    const backtickPattern = /`([^`]*)`/g;
    let backtickMatch = backtickPattern.exec(command);
    while (backtickMatch != null) {
        found.push(backtickMatch[1]);
        backtickMatch = backtickPattern.exec(command);
    }

    return found.filter((substitution) => substitution.trim() !== "");
}

export interface SegmentAnalysis {
    /** Wrapper binaries preceding the real command, in order — e.g. `["sudo", "env"]`. */
    wrappers: string[];
    /** Basename of the binary that actually runs; empty when the segment has no command. */
    binary: string;
    /** Flags that follow the binary, unquoted. */
    flags: string[];
    /** Non-flag operands that follow the binary, unquoted. */
    operands: string[];
    /**
     * The segment reduced to `<basename> <args…>`, with assignment, redirection, wrapper
     * and shell-keyword prefixes removed. Rules are `^`-anchored, so they must see the
     * command at position zero — otherwise `nohup rm -rf /` and `/sbin/reboot` slide past.
     */
    normalizedText: string;
    /** Tokens of the segment, computed once and reused. */
    tokens: string[];
}

/**
 * Walks past `FOO=bar` assignments, redirection tokens, shell keywords, wrapper binaries,
 * their flags and their numeric operands (`timeout 30`) to the command that executes.
 */
export function analyzeSegment(segment: string): SegmentAnalysis {
    const tokens = tokenizeSegment(segment);
    const wrappers: string[] = [];
    const flags: string[] = [];
    const operands: string[] = [];

    let binary = "";
    let binaryIndex = -1;
    let expectRedirectionTarget = false;
    let expectFlagValue = false;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        // The filename after a bare `>` / `<` is a redirection target, not a command.
        if (expectRedirectionTarget == true) {
            expectRedirectionTarget = false;
            continue;
        }

        // The value of a wrapper flag such as `env -u FOO` / `sudo -u deploy`.
        if (expectFlagValue == true) {
            expectFlagValue = false;
            continue;
        }

        if (ASSIGNMENT_TOKEN_PATTERN.test(token) == true) {
            continue;
        }

        if (REDIRECTION_TOKEN_PATTERN.test(token) == true) {
            if (BARE_REDIRECTION_OPERATOR_PATTERN.test(token) == true) {
                expectRedirectionTarget = true;
            }
            continue;
        }

        if (token.startsWith("-") == true) {
            const currentWrapper = wrappers[wrappers.length - 1];
            if (currentWrapper != null) {
                const valueFlags = WRAPPER_VALUE_FLAGS[currentWrapper];
                if (valueFlags != null && valueFlags.includes(token) == true) {
                    expectFlagValue = true;
                }
            }
            continue;
        }

        if (NUMERIC_OPERAND_PATTERN.test(token) == true && wrappers.length > 0) {
            continue;
        }

        const unquoted = unquoteToken(token);
        const trimmed = unquoted.replace(/^[({!]+|[)}]+$/g, "");
        if (SHELL_KEYWORD_SET.has(trimmed) == true || trimmed === "") {
            continue;
        }

        const basename = trimmed.split("/").pop() ?? trimmed;
        if (basename === "") {
            continue;
        }

        if (WRAPPER_BINARY_SET.has(basename) == true) {
            wrappers.push(basename);
            continue;
        }

        binary = basename;
        binaryIndex = index;
        break;
    }

    if (binaryIndex >= 0) {
        for (const token of tokens.slice(binaryIndex + 1)) {
            const unquoted = unquoteToken(token);
            if (unquoted.startsWith("-") == true) {
                flags.push(unquoted);
                continue;
            }

            operands.push(normalizeOperand(unquoted));
        }
    }

    // `sudo -i` has wrappers but no following command: the wrapper *is* what runs.
    if (binary === "" && wrappers.length > 0) {
        binary = wrappers[wrappers.length - 1];
    }

    let normalizedText = segment;
    if (binaryIndex >= 0) {
        // The binary is rewritten to its basename so `/sbin/reboot` matches `^reboot`.
        normalizedText = [binary, ...tokens.slice(binaryIndex + 1).map(unquoteToken)].join(" ");
    }

    return {
        wrappers: wrappers,
        binary: binary,
        flags: flags,
        operands: operands,
        normalizedText: normalizedText,
        tokens: tokens,
    };
}

/**
 * Commands carried as arguments of a shell-style binary, which run in their own right:
 * the `-c "<string>"` form (including bundled clusters like `-lc`), and everything after
 * a `--` argv separator (`runuser -u root -- rm -rf /srv`).
 */
function extractShellPayloads(analysis: SegmentAnalysis): string[] {
    if (SHELL_PAYLOAD_BINARY_SET.has(analysis.binary) == false) {
        return [];
    }

    const tokens = analysis.tokens;
    const payloads: string[] = [];

    for (let index = 0; index < tokens.length - 1; index++) {
        if (SHELL_COMMAND_FLAG_PATTERN.test(tokens[index]) == true || tokens[index] === "--command") {
            payloads.push(unquoteToken(tokens[index + 1]));
        }
    }

    const separatorIndex = tokens.indexOf("--");
    if (separatorIndex >= 0 && separatorIndex < tokens.length - 1) {
        payloads.push(tokens.slice(separatorIndex + 1).map(unquoteToken).join(" "));
    }

    return payloads;
}

/**
 * Decides whether a command may run against a host.
 *
 * Ordered cheapest-to-strictest so the reported reason is the most fundamental one:
 * pipeline-wide disasters → command substitutions → then, per segment, profile deny
 * patterns → privilege escalation → always-dangerous rules → read-only rules →
 * allow-list → nested shell payloads.
 *
 * **Scope.** This is a mistake-stopper, not a sandbox. It reads the command as text, so
 * anything that hides the real operation — an interpreter one-liner, an encoded payload,
 * a tool named something else — runs unexamined, and no amount of pattern-chasing closes
 * that. The layer that actually contains an agent is the remote account's own permissions.
 */
export function inspectCommand(command: string, policy: SshPolicy, depth = 0): GuardVerdict {
    const normalizedCommand = normalizeCommandText(command);
    const trimmedCommand = normalizedCommand.trim();
    if (trimmedCommand === "") {
        return { allowed: false, reason: "command is empty" };
    }

    if (depth > MAX_INSPECTION_DEPTH) {
        return {
            allowed: false,
            reason: "command nests shells or substitutions too deeply to screen reliably",
            offendingText: trimmedCommand,
        };
    }

    for (const rule of DANGEROUS_PIPELINE_RULES) {
        if (rule.pattern.test(trimmedCommand) == true) {
            return {
                allowed: false,
                reason: `blocked as dangerous: ${rule.reason}`,
                offendingText: trimmedCommand,
            };
        }
    }

    for (const substitution of extractSubstitutions(trimmedCommand)) {
        const verdict = inspectCommand(substitution, policy, depth + 1);
        if (verdict.allowed == false) {
            return {
                allowed: false,
                reason: `${verdict.reason} (inside a command substitution)`,
                offendingText: substitution,
            };
        }
    }

    for (const segment of splitCommandSegments(trimmedCommand)) {
        const verdict = inspectSegment(segment, policy, depth);
        if (verdict.allowed == false) {
            return verdict;
        }
    }

    return { allowed: true };
}

function inspectSegment(segment: string, policy: SshPolicy, depth: number): GuardVerdict {
    const analysis = analyzeSegment(segment);

    // Per segment, not per command: an operator writing /^rm/ expects it to catch
    // `ls && rm -rf x`, and testing only the whole string silently would not.
    for (const pattern of policy.denyPatterns) {
        if (pattern.test(segment) == true || pattern.test(analysis.normalizedText) == true) {
            return {
                allowed: false,
                reason: `blocked by the profile's denyPatterns rule /${pattern.source}/`,
                offendingText: segment,
            };
        }
    }

    if (policy.allowSudo == false) {
        const escalation = [...analysis.wrappers, analysis.binary]
            .find((name) => PRIVILEGE_BINARY_SET.has(name) == true);
        if (escalation != null) {
            return {
                allowed: false,
                reason: `privilege escalation via '${escalation}' is disabled for this profile (set allowSudo: true to permit it)`,
                offendingText: segment,
            };
        }
    }

    // The raw segment is only re-tested when normalization actually changed something —
    // it carries redirections (`> /dev/sda`) that the normalized form drops.
    const shouldTestRawSegment = analysis.normalizedText !== segment;

    for (const rule of DANGEROUS_COMMAND_RULES) {
        const matched = rule.pattern.test(analysis.normalizedText) == true
            || (shouldTestRawSegment == true && rule.pattern.test(segment) == true);
        if (matched == true) {
            return {
                allowed: false,
                reason: `blocked as dangerous: ${rule.reason}`,
                offendingText: segment,
            };
        }
    }

    for (const rule of DANGEROUS_ARGUMENT_RULES) {
        if (rule.binaries.includes(analysis.binary) == false) {
            continue;
        }

        if (rule.requiredFlagPattern != null) {
            const hasRequiredFlag = analysis.flags.some((flag) => rule.requiredFlagPattern?.test(flag) == true);
            if (hasRequiredFlag == false) {
                continue;
            }
        }

        const offendingOperand = analysis.operands.find((operand) => rule.argumentPattern.test(operand) == true);
        if (offendingOperand != null) {
            return {
                allowed: false,
                reason: `blocked as dangerous: ${rule.reason}`,
                offendingText: `${analysis.binary} … ${offendingOperand}`,
            };
        }
    }

    if (policy.readonly == true) {
        const readonlyVerdict = inspectReadOnly(segment, analysis, shouldTestRawSegment);
        if (readonlyVerdict.allowed == false) {
            return readonlyVerdict;
        }
    }

    if (policy.allowCommands.length > 0) {
        // An empty binary means the segment is only a redirection (`> /etc/cron.d/x`),
        // which writes a file without naming a command — it must not skip the allow-list.
        if (analysis.binary === "") {
            return {
                allowed: false,
                reason: `this profile only permits ${policy.allowCommands.join(", ")}, and this segment runs no listed command`,
                offendingText: segment,
            };
        }

        if (policy.allowCommands.includes(analysis.binary) == false) {
            return {
                allowed: false,
                reason: `'${analysis.binary}' is not in this profile's allowCommands list (${policy.allowCommands.join(", ")})`,
                offendingText: segment,
            };
        }
    }

    for (const payload of extractShellPayloads(analysis)) {
        const verdict = inspectCommand(payload, policy, depth + 1);
        if (verdict.allowed == false) {
            return {
                allowed: false,
                reason: `${verdict.reason} (inside a '${analysis.binary} -c' payload)`,
                offendingText: payload,
            };
        }
    }

    return { allowed: true };
}

function inspectReadOnly(segment: string, analysis: SegmentAnalysis, shouldTestRawSegment: boolean): GuardVerdict {
    if (WRITE_BINARY_SET.has(analysis.binary) == true) {
        return {
            allowed: false,
            reason: `profile is read-only and '${analysis.binary}' can modify the host`,
            offendingText: segment,
        };
    }

    for (const rule of WRITE_USAGE_RULES) {
        const matched = rule.pattern.test(analysis.normalizedText) == true
            || (shouldTestRawSegment == true && rule.pattern.test(segment) == true);
        if (matched == true) {
            return {
                allowed: false,
                reason: `profile is read-only: ${rule.reason}`,
                offendingText: segment,
            };
        }
    }

    const withoutQuotes = stripQuotedText(segment);
    const withoutBenignRedirects = withoutQuotes.replace(BENIGN_REDIRECT_PATTERN, "");
    if (OUTPUT_REDIRECT_PATTERN.test(withoutBenignRedirects) == true) {
        return {
            allowed: false,
            reason: "profile is read-only and the command redirects output into a file",
            offendingText: segment,
        };
    }

    return { allowed: true };
}
