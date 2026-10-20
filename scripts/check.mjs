// Syntax-checks every source file: node scripts/check.mjs
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRS = ["bin", "client", "server", "shared", "scripts", "tests"];

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(full);
  }
  return files;
}

const files = (await Promise.all(SOURCE_DIRS.map(dir => walk(join(root, dir))))).flat();
let failed = 0;
for (const file of files) {
  try {
    await run(process.execPath, ["--check", file]);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${file.replace(root, ".")}\n${error.stderr ?? error.message}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);
