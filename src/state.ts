import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Ids of the Tuya devices the user chose to expose over Matter. */
export async function loadEnabled(file: string): Promise<Set<string>> {
  try {
    const content = await readFile(file, "utf8");
    return new Set(JSON.parse(content) as string[]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

export async function saveEnabled(
  file: string,
  enabled: Set<string>,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify([...enabled], null, 2)}\n`);
}
