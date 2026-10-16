import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getPackageRoot, loadUserConfig } from "../../src/config.js";
import { planRealmCheck, runRealmAwareCheck, type RealmCheckPlan } from "../../src/realms.js";
import { fileUriToPath } from "../../src/types.js";
import { getSharedAnnotations, isLiveTestsEnabled } from "../helpers/live.js";

const packageRoot = path.join(getPackageRoot(), "tests", "fixtures", "require-paths");
const packageUnderPackagesRoot = path.join(
  getPackageRoot(),
  "tests",
  "fixtures",
  "require-packages",
  "Packages",
  "consumer",
);

let annotationsPath = "";

/** Runs all realm passes and returns their diagnostics relative to the fixture package. */
async function runRequirePathCheck(targetPath = packageRoot): Promise<string[]> {
  const plan: RealmCheckPlan | null = planRealmCheck({
    targetPath,
    userConfig: loadUserConfig(targetPath),
    selection: "all",
    annotationsPath,
  });
  if (!plan) return [];

  try {
    const result = await runRealmAwareCheck(plan, targetPath, {
      path: targetPath,
      checklevel: "Warning",
      format: "json",
    });
    const codes: string[] = [];
    for (const [uri, diagnostics] of Object.entries(result.diagnostics)) {
      const relative = path
        .relative(targetPath, path.resolve(fileUriToPath(uri)))
        .replace(/\\/g, "/");
      for (const diagnostic of diagnostics) {
        codes.push(`${relative}:${diagnostic.range.start.line + 1}:${diagnostic.code}`);
      }
    }
    return codes;
  } finally {
    plan.cleanup();
  }
}

describe.skipIf(!isLiveTestsEnabled())("Package.Require path searchers (#79)", () => {
  beforeAll(async () => {
    annotationsPath = await getSharedAnnotations();
  }, 120000);

  afterEach(() => {
    expect(fs.existsSync(annotationsPath)).toBe(true);
  });

  it("resolves relative, side-specific, shared, package-root, and Packages files in order", async () => {
    const codes = await runRequirePathCheck();

    expect(codes).toContain("Server/Index.lua:2:param-type-mismatch");
    expect(codes).toContain("Shared/Index.lua:2:param-type-mismatch");
    expect(codes).toContain("Shared/Index.lua:5:param-type-mismatch");
    expect(codes).not.toContain("Shared/Nested/Index.lua:2:param-type-mismatch");
    expect(codes).not.toContain("Client/Index.lua:2:param-type-mismatch");
    expect(codes.filter((code) => code.includes("undefined-field"))).toEqual([]);
  });

  it("resolves the Packages searcher from an individual package directory", async () => {
    const codes = await runRequirePathCheck(packageUnderPackagesRoot);

    expect(codes).toContain("Server/Index.lua:2:param-type-mismatch");
    expect(codes.filter((code) => code.includes("undefined-field"))).toEqual([]);
  });
});
