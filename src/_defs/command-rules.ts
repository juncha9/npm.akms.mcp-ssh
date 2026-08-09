/** One deny rule: a regex tested against a command segment plus the message shown on a hit. */
export interface CommandRule {
    pattern: RegExp;
    reason: string;
}

/**
 * A rule keyed on the resolved binary plus the shape of its operands.
 *
 * Regex-only rules could not express "`rm -rf` where *any* operand is a critical path" —
 * an anchored pattern reads operands positionally, so `rm -rf /tmp/x /` slipped through
 * because the root argument was not the first one.
 */
export interface ArgumentRule {
    binaries: string[];
    /** Rule fires only when at least one flag matches this, when set. */
    requiredFlagPattern?: RegExp;
    /** Tested against every non-flag operand. */
    argumentPattern: RegExp;
    reason: string;
}

/**
 * Directories whose recursive deletion or permission rewrite destroys the machine.
 * Anchored as a whole-operand match, so `/var/log/myapp` stays allowed while
 * `/var`, `/var/`, `/var/*` do not.
 */
export const CRITICAL_PATH_PATTERN = new RegExp(
    "^(?:"
    + "/|//|/\\*|/\\.|/\\.\\.|/\\*/|//\\*|"
    + "~|~/|~/\\*|\\$HOME|\\$HOME/|\\$HOME/\\*|\\$\\{HOME\\}/?\\*?|"
    + "/(?:bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|usr|var|data)(?:/\\*)?/?"
    + ")$",
    "i"
);

/** Individual files whose loss alone bricks the host or locks everyone out. */
export const CRITICAL_FILE_PATTERN = new RegExp(
    "^/(?:"
    + "etc/(?:passwd|shadow|group|sudoers|fstab|hostname|hosts|resolv\\.conf)"
    + "|boot/(?:vmlinuz|initrd|grub).*"
    + "|etc/ssh/sshd_config"
    + ")$",
    "i"
);

/**
 * Binaries that only wrap another command — the guard steps past them (and their flags,
 * `FOO=bar` assignments, and numeric operands like `timeout 30`) to the binary that runs.
 */
export const COMMAND_WRAPPER_BINARIES = [
    "sudo",
    "doas",
    "env",
    "eval",
    "nohup",
    "time",
    "nice",
    "ionice",
    "timeout",
    "stdbuf",
    "command",
    "exec",
    "builtin",
    "watch",
    "xargs",
    "setsid",
    "unbuffer",
    "busybox",
    "toybox",
];

/**
 * `timeout 30 cmd`, `nice -n 10 cmd`, `watch 2 cmd` — these wrappers take a bare numeric
 * operand before the real command, so a duration must not be mistaken for the binary.
 */
export const NUMERIC_OPERAND_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/i;

/**
 * Wrapper flags that consume the following token as their value.
 *
 * Without this, `env -u FOO rm -rf /` resolves its binary to `FOO`: the flag is skipped,
 * its value is not, and every binary-keyed rule then looks at the wrong word.
 */
export const WRAPPER_VALUE_FLAGS: Record<string, string[]> = {
    env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
    sudo: ["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-h", "--host", "-D", "--chdir", "-R", "--chroot"],
    doas: ["-u", "-C"],
    timeout: ["-s", "--signal", "-k", "--kill-after"],
    nice: ["-n", "--adjustment"],
    ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid"],
    stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
    xargs: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "--replace", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
    watch: ["-n", "--interval"],
    setsid: [],
    nohup: [],
    "systemd-run": ["-u", "--unit", "-p", "--property", "--uid", "--gid", "--setenv"],
    runuser: ["-u", "--user", "-g", "--group", "-s", "--shell"],
    su: ["-s", "--shell", "-g", "--group"],
};

/** Rejected when `allowSudo` is false. Default profiles allow these. */
export const PRIVILEGE_ESCALATION_BINARIES = [
    "sudo",
    "su",
    "doas",
    "pkexec",
    "runuser",
    "chroot",
    "nsenter",
    "systemd-run",
];

/**
 * Binaries that take a command *string* (`-c "…"`) and run it in a fresh shell.
 * The payload is pulled out and screened as its own command — otherwise
 * `bash -c "rm -rf /"` would only ever be judged as "the binary is bash".
 */
export const SHELL_PAYLOAD_BINARIES = [
    "sh",
    "bash",
    "zsh",
    "ksh",
    "dash",
    "ash",
    "mksh",
    "csh",
    "tcsh",
    "fish",
    "su",
    "runuser",
    "chroot",
    "nsenter",
    "systemd-run",
];

/**
 * Always rejected, on every profile, not configurable.
 *
 * Scope is deliberately narrow: **irreversible destruction of the machine, or cutting the
 * connection you are working through**. Everything short of that — installing packages,
 * restarting services, deleting an application's files, piping an install script into a
 * shell — is ordinary administration and is allowed by default. A profile that wants more
 * restraint opts in with `readonly`, `allowCommands` or `denyPatterns`.
 */
export const DANGEROUS_COMMAND_RULES: CommandRule[] = [
    {
        pattern: /^mkfs(\.\w+)?\b/i,
        reason: "formats a filesystem",
    },
    {
        pattern: />\s*\/dev\/(sd|nvme|hd|vd|xvd|mapper)/i,
        reason: "redirects output onto a block device",
    },
    {
        pattern: /^(shutdown|reboot|halt|poweroff)\b/i,
        reason: "powers off or reboots the host, ending this session",
    },
    {
        pattern: /^init\s+[06]\b/i,
        reason: "changes runlevel to halt or reboot",
    },
    {
        pattern: /^systemctl\s+(poweroff|reboot|halt|emergency|rescue)\b/i,
        reason: "powers off, reboots or degrades the host",
    },
    {
        // Anchored on `/` as the whole search root: `find /tmp -delete` is ordinary
        // cleanup, `find / -delete` empties the machine.
        pattern: /^find\s+\/\s+.*(-delete|-exec(dir)?\s+(\/\S+\/)?rm)/i,
        reason: "deletes files found from the filesystem root",
    },
    {
        pattern: /^crontab\s+(-\S+\s+)*-r\b/i,
        reason: "removes every cron job for the user",
    },
    {
        pattern: /^(iptables|ip6tables|nft)\s+(-F|--flush|flush)\b/i,
        reason: "flushes firewall rules and can lock this session out",
    },
    {
        pattern: /--no-preserve-root/i,
        reason: "explicitly disables the root-deletion safeguard",
    },
];

/** Danger rules keyed on the binary plus its operands. */
export const DANGEROUS_ARGUMENT_RULES: ArgumentRule[] = [
    {
        binaries: ["rm"],
        requiredFlagPattern: /^--?(?:[a-z]*[rRf][a-z]*|recursive|force)$/,
        argumentPattern: CRITICAL_PATH_PATTERN,
        reason: "deletes the filesystem root, a system directory or an entire home directory",
    },
    {
        binaries: ["rm", "unlink", "shred", "srm", "wipe"],
        argumentPattern: CRITICAL_FILE_PATTERN,
        reason: "deletes a file the host cannot boot or authenticate without",
    },
    {
        binaries: ["shred", "srm", "wipe"],
        argumentPattern: CRITICAL_PATH_PATTERN,
        reason: "irreversibly destroys a system path",
    },
    {
        binaries: ["chmod", "chown", "chgrp"],
        requiredFlagPattern: /^--?(R|recursive)$/,
        argumentPattern: CRITICAL_PATH_PATTERN,
        reason: "recursively rewrites ownership or permissions on a system path",
    },
    {
        binaries: ["dd"],
        argumentPattern: /^of=(\/dev\/(?!null|zero|stdout|stderr|tty)|\/etc\/|\/boot\/|\/bin\/|\/sbin\/|\/usr\/|\/lib)/i,
        reason: "writes raw bytes over a device or system file",
    },
    {
        binaries: ["mkfs", "fdisk", "parted", "sgdisk", "wipefs"],
        argumentPattern: /^\/dev\//i,
        reason: "repartitions or formats a block device",
    },
];

/** Danger rules tested against the whole command, before it is split on `;`, `&&`, `|`. */
export const DANGEROUS_PIPELINE_RULES: CommandRule[] = [
    {
        pattern: /\{\s*:\s*\|\s*:\s*&\s*\}/,
        reason: "fork bomb",
    },
];

/**
 * Blocked when the profile is read-only: binaries whose whole purpose is to change the
 * host's files, packages, services or accounts.
 *
 * Interpreters, `awk`, database clients and archive listing are deliberately **absent**.
 * A read-only profile exists to make a host safe to *inspect*, and log analysis routinely
 * needs `python3 -c`, `awk`, `psql`. Blocking them made the mode unusable for its own
 * purpose while stopping nobody who wanted around it — a shell payload is still screened
 * (see SHELL_PAYLOAD_BINARIES), so `bash -c "rm x"` is caught by the `rm` rule.
 */
export const WRITE_COMMAND_BINARIES = [
    // filesystem mutation
    "rm", "rmdir", "mv", "cp", "dd", "mkdir", "touch", "ln", "chmod", "chown", "chgrp",
    "truncate", "shred", "srm", "wipe", "install", "tee", "patch", "rename", "chattr", "setfacl",
    // storage / mounts
    "mkfs", "fdisk", "parted", "sgdisk", "wipefs", "mount", "umount", "swapon", "swapoff",
    // accounts and scheduling
    "useradd", "usermod", "userdel", "groupadd", "groupmod", "groupdel",
    "passwd", "chpasswd", "visudo", "crontab", "at", "batch",
    // process and power control
    "kill", "killall", "pkill", "reboot", "shutdown", "halt", "poweroff", "init", "service",
    // package managers
    "apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "rpm", "zypper", "pacman", "apk",
    "snap", "brew", "npm", "pnpm", "yarn", "npx", "pip", "pip3", "gem", "cargo", "composer",
    "bundle", "make", "cmake",
    // editors — interactive and write-oriented
    "vi", "vim", "nvim", "nano", "emacs", "ex", "ed",
    // transfer to/from other hosts, and archive extraction
    "scp", "rsync", "sftp", "ftp", "ssh", "ssh-keygen", "ssh-copy-id", "wget",
    "unzip", "gunzip", "bunzip2", "unxz", "cpio",
    // firewall
    "iptables", "ip6tables", "ufw", "firewall-cmd", "nft",
];

/**
 * Blocked when the profile is read-only: tools that read *or* write depending on the
 * subcommand or flag, so only the mutating form is matched.
 */
export const WRITE_USAGE_RULES: CommandRule[] = [
    {
        pattern: /^sed\b.*(?:(\s|^)-[a-zA-Z]*i([a-zA-Z]|\s|$|\.)|--in-place)/,
        reason: "sed edits files in place",
    },
    {
        pattern: /^sort\b.*(\s|^)(-o|--output)\b/i,
        reason: "sort writes its result to a file",
    },
    {
        pattern: /^find\b.*(-delete|-exec|-execdir|-ok|-okdir|-fls|-fprint)/i,
        reason: "find action deletes files or runs an arbitrary command",
    },
    {
        pattern: /^git\s+(push|reset|checkout|switch|restore|clean|rebase|merge|commit|add|rm|mv|stash|apply|revert|cherry-pick|pull|remote|tag|gc|prune|init|clone)\b/i,
        reason: "git subcommand mutates the working tree or the remote",
    },
    {
        pattern: /^systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill|isolate|set-property|edit|daemon-reload|daemon-reexec)\b/i,
        reason: "systemctl subcommand changes service state",
    },
    {
        pattern: /^docker\s+(run|rm|rmi|stop|start|restart|kill|exec|create|build|push|pull|cp|commit|prune|load|import|tag|update|rename|volume|network|swarm)\b/i,
        reason: "docker subcommand mutates containers, images or volumes",
    },
    {
        pattern: /^(kubectl|oc)\s+(apply|delete|create|edit|scale|patch|replace|rollout|drain|cordon|uncordon|exec|cp|set|annotate|label|taint)\b/i,
        reason: "kubectl subcommand mutates cluster state",
    },
    {
        pattern: /^tar\b.*(--extract|--create|--delete|(\s|^)-{1,2}[a-zA-Z]*[xc][a-zA-Z]*(\s|$))/i,
        reason: "tar extract/create writes files",
    },
    {
        pattern: /^curl\b.*(\s|^)(-o|-O|--output|--remote-name|--upload-file|-T)\b/i,
        reason: "curl writes a file or uploads one",
    },
    {
        pattern: /^(zip|gzip|bzip2|xz)\b/i,
        reason: "compression tool rewrites files on disk",
    },
];

/**
 * Harmless redirection forms stripped before checking for output redirection —
 * `2>&1`, `>/dev/null`, `&>/dev/null` are diagnostics plumbing, not writes.
 */
export const BENIGN_REDIRECT_PATTERN = /(\d?>>?\s*&\s*\d|&>>?\s*\/dev\/null|\d?>>?\s*\/dev\/null)/g;

/** Any remaining `>` after the benign forms are stripped means a real file write. */
export const OUTPUT_REDIRECT_PATTERN = />/;

/** Leading `2>`, `>>`, `<`, `2>&1` tokens — stripped so the binary scan finds the command. */
export const REDIRECTION_TOKEN_PATTERN = /^(?:\d*>>?|<|&>>?)/;

/**
 * A redirection operator with no target attached, so the *next* token is its filename
 * rather than a command. `2>&1` is excluded: it names its target inline.
 */
export const BARE_REDIRECTION_OPERATOR_PATTERN = /^(?:\d*>>?|<|&>>?)$/;

/**
 * Shell word splitting: redirection operators first so `tee</dev/null` yields
 * `tee`, `<`, `/dev/null` instead of one word whose basename reads as "null".
 */
export const SHELL_TOKEN_PATTERN = /\d*>>?&?\d*|&>>?|<&?\d*|(?:[^\s'"\\<>&|]|\\.|'[^']*'|"[^"]*")+/g;

/** Shell grouping and keyword tokens that precede a command rather than being one. */
export const SHELL_KEYWORD_TOKENS = [
    "if", "then", "else", "elif", "fi",
    "for", "while", "until", "do", "done",
    "case", "esac", "in", "select",
    "function", "{", "}", "(", ")", "!", "[[", "]]", "[", "]",
];

/**
 * Shell metacharacters forbidden in a `cwd` argument.
 *
 * `cwd` is interpolated into the generated `cd` prefix, so anything that can end a word
 * and start a new command is remote code execution that never passes through the command
 * guard. Directory names legitimately containing these are vanishingly rare; the trade is
 * obviously worth it.
 */
export const UNSAFE_PATH_CHARACTER_PATTERN = /[`$;|&<>(){}!*?\[\]\\"'\n\r\t]/;
