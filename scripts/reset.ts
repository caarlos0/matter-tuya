import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(
  process.env.MATTER_STORAGE_PATH?.trim() || join(homedir(), ".matter"),
  "tuya-matter",
);

// Erasing under a live bridge leaves it running with the old fabric in memory
// and rewriting its files, which looks like the reset did nothing.
const pid = Number(
  (await readFile(join(dir, "matter.pid"), "utf8").catch(() => "")).split(
    /\s+/,
  )[0],
);

if (pid && isRunning(pid)) {
  console.error(`The bridge is running as pid ${pid}. Stop it first.`);
  process.exit(1);
}

await rm(dir, { recursive: true, force: true });
console.log(`Erased ${dir}. Start the bridge for a new pairing code.`);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
