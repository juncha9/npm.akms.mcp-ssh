import { describe, expect, it } from "vitest";

import { analyzeSegment, inspectCommand, splitCommandSegments, stripQuotedText } from "@/modules/guard";

import { createPolicy, denyPatterns } from "./_helpers";

process.env.SSH_MCP_LOG_LEVEL = "silent";

describe("splitCommandSegments", () => {
    it("splits on ;, &&, || and pipes", () => {
        const segments = splitCommandSegments("ls -la; cd /tmp && rm x || echo fail | grep f");
        expect(segments).toEqual(["ls -la", "cd /tmp", "rm x", "echo fail", "grep f"]);
    });

    it("keeps separators inside quotes intact", () => {
        const segments = splitCommandSegments(`echo "a; b && c" | wc -l`);
        expect(segments).toEqual([`echo "a; b && c"`, "wc -l"]);
    });

    it("treats 2>&1 as redirection, not a background operator", () => {
        const segments = splitCommandSegments("make build 2>&1");
        expect(segments).toEqual(["make build 2>&1"]);
    });

    it("splits on newlines so multi-line scripts are still screened", () => {
        const segments = splitCommandSegments("cd /tmp\nrm -rf /");
        expect(segments).toEqual(["cd /tmp", "rm -rf /"]);
    });
});

describe("analyzeSegment", () => {
    it("skips wrappers and env assignments to find the real binary", () => {
        const result = analyzeSegment("sudo env FOO=bar nohup /usr/bin/rm -rf x");
        expect(result.wrappers).toEqual(["sudo", "env", "nohup"]);
        expect(result.binary).toBe("rm");
    });

    it("reduces an absolute path to its basename", () => {
        const result = analyzeSegment("/usr/local/bin/node script.js");
        expect(result.binary).toBe("node");
    });

    it("reports an empty binary for a segment with no command", () => {
        expect(analyzeSegment("FOO=bar").binary).toBe("");
    });

    it("skips a wrapper's numeric operand instead of taking it as the binary", () => {
        const result = analyzeSegment("timeout 30 sudo rm -rf /");
        expect(result.wrappers).toEqual(["timeout", "sudo"]);
        expect(result.binary).toBe("rm");
    });

    it("skips a leading redirection token and its target", () => {
        expect(analyzeSegment("2>/dev/null rm -rf /tmp/x").binary).toBe("rm");
        expect(analyzeSegment(">out.txt rm -rf /tmp/x").binary).toBe("rm");
    });

    it("splits a redirection glued to the binary", () => {
        expect(analyzeSegment("tee</dev/null /tmp/x").binary).toBe("tee");
    });

    it("skips shell keywords and grouping", () => {
        expect(analyzeSegment("then rm -rf /etc").binary).toBe("rm");
        expect(analyzeSegment("{ reboot").binary).toBe("reboot");
        expect(analyzeSegment("(reboot)").binary).toBe("reboot");
    });

    it("rewrites the binary to its basename in normalizedText so anchored rules match", () => {
        expect(analyzeSegment("nohup env FOO=1 /sbin/reboot now").normalizedText).toBe("reboot now");
    });

    it("separates flags from operands and unquotes them", () => {
        const result = analyzeSegment(`rm -rf '/' "/etc"`);
        expect(result.flags).toEqual(["-rf"]);
        expect(result.operands).toEqual(["/", "/etc"]);
    });
});

describe("stripQuotedText", () => {
    it("removes quoted spans", () => {
        expect(stripQuotedText(`echo "a > b" c`)).toBe("echo  c");
    });

    it("does not let an escaped apostrophe open a quoted span", () => {
        expect(stripQuotedText(`echo don\\'t worry > /tmp/pwn`)).toContain(">");
    });

    it("treats a backslash inside single quotes as a literal, as POSIX does", () => {
        // `'x\'` closes the quote in a real shell, so the `>` after it is a redirection.
        expect(stripQuotedText(`echo 'x\\' > /tmp/pwn`)).toContain(">");
    });
});

describe("inspectCommand — catastrophe rules apply to every profile", () => {
    const policy = createPolicy();

    it.each([
        "rm -rf /",
        "rm -rf /*",
        "rm -rf /etc",
        "rm -rf /home",
        "rm /etc/passwd",
        "rm -f /boot/vmlinuz-6.1.0",
        "mkfs.ext4 /dev/sda1",
        "dd if=/dev/zero of=/dev/sda",
        "shutdown -h now",
        "reboot",
        "systemctl poweroff",
        "chmod -R 777 /",
        "find / -name '*.log' -delete",
        "crontab -r",
        "iptables -F",
        "rm -rf --no-preserve-root /srv",
    ])("rejects %s", (command) => {
        const verdict = inspectCommand(command, policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("dangerous");
    });
});

describe("inspectCommand — ordinary administration is permitted by default", () => {
    const policy = createPolicy();

    it.each([
        "sudo systemctl restart nginx",
        "sudo apt-get install -y nginx",
        "npm ci && npm run build",
        "docker compose up -d",
        "rm -rf /var/log/myapp/old",
        "rm -rf /opt/app/node_modules",
        "echo 'server { }' > /etc/nginx/conf.d/app.conf",
        "sed -i 's/8080/9090/' /opt/app/.env",
        "curl -fsSL https://get.docker.com | sh",
        "git pull && pm2 restart app",
        "tar -xzf release.tar.gz -C /opt/app",
        "kill -9 12345",
        "systemctl stop nginx",
        "python3 -c \"import json,sys; print(len(sys.stdin.read()))\"",
        "psql -c 'select count(*) from users'",
    ])("allows %s", (command) => {
        expect(inspectCommand(command, policy).allowed).toBe(true);
    });
});

describe("inspectCommand — sudo", () => {
    it("is allowed by default", () => {
        expect(inspectCommand("sudo systemctl status nginx", createPolicy()).allowed).toBe(true);
    });

    it.each([
        "sudo systemctl status nginx",
        "su - root",
        "doas apt update",
        "pkexec id",
    ])("rejects %s when allowSudo is false", (command) => {
        const verdict = inspectCommand(command, createPolicy({ allowSudo: false }));
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("privilege escalation");
    });
});

describe("inspectCommand — read-only profiles", () => {
    const policy = createPolicy({ readonly: true });

    it.each([
        "rm old.log",
        "mv a b",
        "mkdir /tmp/x",
        "tee /etc/hosts",
        "apt-get install nginx",
        "npm install",
        "sed -i 's/a/b/' file",
        "git push origin main",
        "systemctl restart nginx",
        "docker run -d nginx",
        "kubectl apply -f deploy.yaml",
        "tar -xzf bundle.tar.gz",
        "curl -o out.bin https://example.com/x",
        "wget https://example.com/x",
        "echo hello > /tmp/out.txt",
        "cat a >> b",
        "vi /etc/hosts",
        "scp file remote:/tmp",
        "sort -o /etc/passwd /etc/passwd",
        "find /tmp -delete",
    ])("rejects %s", (command) => {
        const verdict = inspectCommand(command, policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("read-only");
    });

    // Analysis tools stay available: a read-only host exists to be *inspected*, and
    // blocking these made the mode unusable for its own purpose.
    it.each([
        "ls -la /var/log",
        "cat /etc/hostname",
        "tail -n 100 /var/log/syslog",
        "grep -r error /var/log 2>/dev/null",
        "df -h",
        "ps aux",
        "systemctl status nginx",
        "git log --oneline -20",
        "git status",
        "docker ps",
        "docker logs app",
        "journalctl -u nginx -n 50",
        "tar -tzf bundle.tar.gz",
        "find /var/log -name '*.gz'",
        "python3 -c \"print(1)\"",
        "node -e \"console.log(1)\"",
        "awk '$3 > 100 {print $1}' /var/log/app.log",
        "awk 'BEGIN{x=1} {sum+=$2} END{print sum}' data.txt",
        "perl -ne 'print if /error/' /var/log/syslog",
        "psql -c 'select 1'",
        `echo "a > b"`,
        "uptime > /dev/null 2>&1",
    ])("allows %s", (command) => {
        expect(inspectCommand(command, policy).allowed).toBe(true);
    });
});

describe("inspectCommand — allowCommands allow-list", () => {
    const policy = createPolicy({ allowCommands: ["ls", "cat", "tail"] });

    it("allows a listed binary", () => {
        expect(inspectCommand("tail -n 20 /var/log/syslog", policy).allowed).toBe(true);
    });

    it("rejects an unlisted binary even when it is harmless", () => {
        const verdict = inspectCommand("uptime", policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("allowCommands");
    });

    it("applies to every segment of a pipeline", () => {
        const verdict = inspectCommand("cat /var/log/syslog | grep error", policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.offendingText).toBe("grep error");
    });

    it("rejects a segment that writes a file without naming a command", () => {
        const verdict = inspectCommand("> /etc/cron.d/pwn", policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("only permits");
    });
});

describe("inspectCommand — profile denyPatterns", () => {
    it("rejects a command matching a profile-supplied pattern", () => {
        const policy = createPolicy({ denyPatterns: denyPatterns("docker\\s+compose\\s+down") });
        const verdict = inspectCommand("docker compose down", policy);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("denyPatterns");
    });

    it("applies per segment, so a harmless prefix does not evade an anchored rule", () => {
        const policy = createPolicy({ denyPatterns: denyPatterns("^rm") });
        expect(inspectCommand("rm -rf /tmp/x", policy).allowed).toBe(false);
        expect(inspectCommand("ls && rm -rf /tmp/x", policy).allowed).toBe(false);
    });

    it("matches the normalized form too, so a path prefix does not evade it", () => {
        const policy = createPolicy({ denyPatterns: denyPatterns("^reboot") });
        expect(inspectCommand("/sbin/reboot", policy).allowed).toBe(false);
    });
});

describe("inspectCommand — empty input", () => {
    it("rejects an empty command", () => {
        expect(inspectCommand("   ", createPolicy()).allowed).toBe(false);
    });
});
