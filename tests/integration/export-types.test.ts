import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPackageRoot, loadUserConfig } from "../../src/config.js";
import { exportTypes } from "../../src/export-types.js";
import { planRealmCheck, runRealmAwareCheck } from "../../src/realms.js";
import { fileUriToPath } from "../../src/types.js";
import { getSharedAnnotations, isLiveTestsEnabled } from "../helpers/live.js";

const fixturesRoot = path.join(getPackageRoot(), "tests", "fixtures", "export-types");

let annotationsPath = "";

describe.skipIf(!isLiveTestsEnabled())("export-types integration (#90)", () => {
  beforeAll(async () => {
    annotationsPath = await getSharedAnnotations();
  }, 120000);

  it("type-checks a consumer against the exported tree after the dependency source is removed", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-export-types-"));
    const packageRoot = path.join(tempRoot, "package");
    const consumerRoot = path.join(tempRoot, "consumer");
    try {
      for (const fixture of ["package", "dep-pkg", "dep-pkg-two", "consumer"]) {
        fs.cpSync(path.join(fixturesRoot, fixture), path.join(tempRoot, fixture), {
          recursive: true,
        });
      }
      const destination = path.join(consumerRoot, "types");
      const exported = await exportTypes({ root: packageRoot, destination });
      expect(fs.existsSync(path.join(destination, "Server/weapons.d.lua"))).toBe(true);
      expect(fs.existsSync(path.join(destination, "meta__legacy.lua"))).toBe(true);
      expect(fs.existsSync(path.join(destination, "plain.lua"))).toBe(false);
      expect(exported.manifest.package).toEqual({
        name: "export-types-fixture",
        version: "1.4.2",
      });
      expect(exported.manifest.sourceCommit).toBeNull();

      // The consumer must be checkable with no package or dependency source left on disk.
      fs.rmSync(packageRoot, { recursive: true, force: true });
      fs.rmSync(path.join(tempRoot, "dep-pkg"), { recursive: true, force: true });
      fs.rmSync(path.join(tempRoot, "dep-pkg-two"), { recursive: true, force: true });

      const plan = planRealmCheck({
        targetPath: consumerRoot,
        userConfig: loadUserConfig(consumerRoot),
        selection: "all",
        annotationsPath,
      });
      expect(plan).not.toBeNull();
      try {
        const result = await runRealmAwareCheck(plan!, consumerRoot, {
          path: consumerRoot,
          checklevel: "Warning",
          format: "json",
        });
        const diagnostics: string[] = [];
        for (const [uri, entries] of Object.entries(result.diagnostics)) {
          const relative = path
            .relative(consumerRoot, path.resolve(fileUriToPath(uri)))
            .replace(/\\/g, "/");
          for (const entry of entries) {
            diagnostics.push(`${relative}:${entry.code}`);
          }
        }
        expect(diagnostics).toEqual(["Client/violation.lua:undefined-global"]);
      } finally {
        plan!.cleanup();
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120000);
});
