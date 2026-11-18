import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";

describe("manifest", () => {
  it("matches constants and package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe(pkg.version);
  });

  it("has no runtime imports (host caches imported modules across upgrades)", () => {
    const src = readFileSync(new URL("../src/manifest.ts", import.meta.url), "utf8");
    const runtimeImports = src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
    expect(runtimeImports).toEqual([]);
  });
});
