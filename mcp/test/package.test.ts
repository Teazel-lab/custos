import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION, USER_AGENT } from "../src/version.js";

describe("package metadata", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
    license: string;
    homepage: string;
    bin: Record<string, string>;
    publishConfig: { access: string };
    repository: { url: string };
  };

  it("publishes as custosprotocol-mcp", () => {
    expect(pkg.name).toBe("custosprotocol-mcp");
    expect(pkg.version).toBe("0.1.2");
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`custosprotocol-mcp/${pkg.version}`);
    expect(pkg.license).toBe("MIT");
    expect(pkg.homepage).toBe("https://custosprotocol.com");
    expect(pkg.repository.url).toBe("git+https://github.com/Teazel-lab/custos.git");
    expect(pkg.bin["custosprotocol-mcp"]).toBe("dist/index.js");
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.bin["custos-mcp"]).toBeUndefined();
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    expect(server).toContain("PACKAGE_VERSION");
    expect(api).toContain("USER_AGENT");
    expect(server).not.toMatch(/version:\s*"0\.1\./);
    expect(api).not.toMatch(/custosprotocol-mcp\/0\.1\./);
  });
});
