const { spawn } = require("child_process");

const proc = spawn("python3", ["kokoro_server.py"], { stdio: "inherit" });

proc.on("exit", (code) => {
  process.exit(code ?? 0);
});
