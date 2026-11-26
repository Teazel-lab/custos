import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Version from this package's package.json, whether the code is running from src or dist. */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "custosprotocol-mcp" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // Not this directory. Walk toward the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("custosprotocol-mcp package.json was not found.");
}

export const PACKAGE_VERSION = packageVersion();
export const USER_AGENT = `custosprotocol-mcp/${PACKAGE_VERSION}`;
