import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_MARKERS } from "./constants";

/**
 * Find project root by walking up from startPath.
 * Checks for PROJECT_MARKERS (.git, pyproject.toml, package.json, etc.)
 *
 * @param startPath - Starting path to search from (file or directory)
 * @param stopAt - Optional boundary directory; the walk inspects this
 *   directory for markers and then halts, returning null if none were
 *   found at or below it. Use this in tests to keep the walk inside a
 *   sandbox directory and prevent accidental matches against shared
 *   parents like /tmp that may contain stray project markers from
 *   unrelated processes.
 * @returns Project root path or null if not found
 */
export function findProjectRoot(
  startPath: string,
  stopAt?: string,
): string | null {
  let current: string;

  try {
    const stat = statSync(startPath);
    current = stat.isDirectory() ? startPath : dirname(startPath);
  } catch {
    current = dirname(startPath);
  }

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      const markerPath = join(current, marker);
      if (existsSync(markerPath)) {
        return current;
      }
    }

    if (stopAt !== undefined && current === stopAt) {
      return null;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
