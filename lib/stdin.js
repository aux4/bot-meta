// Shared with aux4/bot core's own lib/stdin.js: read the full event aux4/api
// pipes to a route command on stdin, and write a single JSON reply.

export function readStdin() {
  return new Promise(resolve => {
    let data = "";
    if (process.stdin.isTTY) {
      return resolve("");
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
}
