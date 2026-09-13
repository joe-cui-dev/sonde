import { readFileSync } from "node:fs";

/**
* Styles and characters are both optional personal files, read and validated
* before anything is opened or paid for, and both report a failure the same
* way: name the file, name the field. That sequence lives here once, with each
* caller supplying its own label for the error text.
*/

/** Null for "the file does not exist", which is not a problem. Anything else is. */
export function readConfigFile(path: string, label: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read ${label} file ${path}: ${(error as Error).message}`);
  }
}

export function parseConfigJson(raw: string, path: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${label} file ${path}: ${(error as Error).message}`);
  }
}

/** One bullet per field, the way every config file reports what was wrong with it. */
export function renderZodIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
