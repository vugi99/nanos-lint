import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPackageRoot,
  initWorkspace,
  loadUserConfig,
  resolveWorkspaceConfig,
} from "../../src/config.js";
import { runLuaLSCheck } from "../../src/luals.js";
import { planRealmCheck, runRealmAwareCheck, type RealmCheckPlan } from "../../src/realms.js";
import { fileUriToPath, type DiagnosticReport } from "../../src/types.js";
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
const spellingsRoot = path.join(getPackageRoot(), "tests", "fixtures", "require-spellings");
const reenabledSpellingsRoot = path.join(
  getPackageRoot(),
  "tests",
  "fixtures",
  "require-spellings_reenabled",
);
const anchoringRoot = path.join(getPackageRoot(), "tests", "fixtures", "require-path-anchoring");

let annotationsPath = "";

/**
 * Resolves symlinks and short names natively.
 *
 * LuaLS reports URIs for the real path it checked, so a workspace created under a
 * symlinked temporary directory (`/var` on macOS, short `RUNNER~1` names on Windows)
 * would otherwise never match the target path used to start the check.
 */
function canonicalPath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/** Collects `<relative>:<line>:<code>` diagnostics from a LuaLS report. */
function collectCodes(targetPath: string, diagnostics: DiagnosticReport): string[] {
  const canonicalTarget = canonicalPath(targetPath);
  const codes: string[] = [];
  for (const [uri, entries] of Object.entries(diagnostics)) {
    const relative = path
      .relative(canonicalTarget, canonicalPath(fileUriToPath(uri)))
      .replace(/\\/g, "/");
    for (const diagnostic of entries) {
      codes.push(`${relative}:${diagnostic.range.start.line + 1}:${diagnostic.code}`);
    }
  }
  return codes;
}

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
    return collectCodes(targetPath, result.diagnostics);
  } finally {
    plan.cleanup();
  }
}

/** Runs a single standard pass with the merged template configuration. */
async function runStandardCheck(targetPath: string): Promise<string[]> {
  const resolved = resolveWorkspaceConfig(targetPath, undefined, { annotationsPath });
  try {
    const result = await runLuaLSCheck(targetPath, resolved.configPath, {
      path: targetPath,
      checklevel: "Warning",
      format: "json",
    });
    return collectCodes(targetPath, result.diagnostics);
  } finally {
    if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
      fs.unlinkSync(resolved.configPath);
    }
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

  it("resolves like the bundled defaults in a workspace scaffolded by `init --vendor`", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-vendored-init-"));
    try {
      fs.cpSync(packageRoot, workspace, { recursive: true });
      initWorkspace(workspace, { vendor: true, annotationsPath });

      const codes = await runRequirePathCheck(workspace);

      expect(codes).toContain("Server/Index.lua:2:param-type-mismatch");
      expect(codes).toContain("Shared/Index.lua:2:param-type-mismatch");
      expect(codes).toContain("Shared/Index.lua:5:param-type-mismatch");
      // The scaffolded default paths stay realm-managed and the vendored plugin resolves
      // current-file-relative imports, so the shared pass keeps Shared/ first (#79).
      expect(codes).not.toContain("Shared/Nested/Index.lua:2:param-type-mismatch");
      expect(codes).not.toContain("Client/Index.lua:2:param-type-mismatch");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts package-relative and package-qualified spellings of the same file", async () => {
    expect(await runStandardCheck(spellingsRoot)).toEqual([]);
  });

  it("keeps different-requires available for workspaces that replace the bundled disable list", async () => {
    const codes = await runStandardCheck(reenabledSpellingsRoot);

    expect(codes.some((code) => code.endsWith(":different-requires"))).toBe(true);
  });

  it("does not bind a require to a same-named file in another package", async () => {
    expect(await runStandardCheck(anchoringRoot)).toEqual([]);
  });
});
