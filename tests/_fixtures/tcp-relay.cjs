// Minimal ProxyCommand: `node tcp-relay.cjs <host> <port>` connects a TCP socket to
// host:port and relays it over stdin/stdout — what `nc %h %p` does on a POSIX box.
// Lives under tests/_fixtures so the integration suite has a proxy command that works on
// every platform without depending on `nc` or `cloudflared` being installed.
const net = require("node:net");

const host = process.argv[2];
const port = Number(process.argv[3]);

const socket = net.connect({ host: host, port: port }, () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
});

socket.on("error", (error) => {
    process.stderr.write(`tcp-relay: ${error.message}\n`);
    process.exit(1);
});

socket.on("close", () => {
    process.exit(0);
});

process.stdin.on("end", () => {
    socket.end();
});
