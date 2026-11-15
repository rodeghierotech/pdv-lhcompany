import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const [suite, ...filters] = process.argv.slice(2);
if (suite !== "unit" && suite !== "db") {
  throw new Error("Informe a suíte unit ou db.");
}

const sourceDirectory = fileURLToPath(new URL("../", import.meta.url));
const suffix = `.${suite}.test.ts`;
async function discover(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : entry.name.endsWith(suffix) ? [path] : [];
  }));
  return files.flat().sort();
}

const files = (await discover(sourceDirectory)).filter((path) =>
  filters.length === 0 || filters.some((filter) => basename(path) === filter || path === filter),
);
if (files.length === 0) {
  console.info(`Nenhum teste ${suite} encontrado.`);
  process.exitCode = filters.length > 0 ? 1 : 0;
} else {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
