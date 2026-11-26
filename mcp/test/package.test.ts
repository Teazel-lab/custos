import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.homepage).toBe("https://custosprotocol.com");
    expect(pkg.repository.url).toBe("git+https://github.com/Teazel-lab/custos.git");
    expect(pkg.bin["custosprotocol-mcp"]).toBe("./dist/index.js");
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.bin["custos-mcp"]).toBeUndefined();
  });
});
