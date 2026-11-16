import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

test("compiled_api_starts_without_a_typescript_loader_and_serves_health", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PORT: "0", NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Compiled API did not start: ${output}`)), 8000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer); reject(new Error(`Compiled API exited (${code}): ${output}`));
      });
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const response = await globalThis.fetch(`${address}/health`, { signal: globalThis.AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
