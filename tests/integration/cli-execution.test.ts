import { describe, it, expect, beforeAll } from "vitest";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { isLiveTestsEnabled, getSharedLuaLSBinary, getSharedAnnotations } from "../helpers/live.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../..");

/**
 * The pretty reporter prints OS-native separators (so Windows output contains `\`), and
 * `GITHUB_ACTIONS` in the environment switches the CLI to the annotation format. Every
 * realm assertion below pins `--format=pretty` and normalizes separators so the test
 * behaves identically on a developer machine and inside CI.
 */
function normalizeSlashes(output: string | undefined): string {
  return (output ?? "").replace(/\\/g, "/");
}
const distCli = path.join(rootDir, "dist", "cli.js");
const binCli = path.join(rootDir, "bin", "nanos-lint.js");

/**
 * `true` when this platform lets the suite create symlinks. Creating them needs
 * elevation on Windows; returning early from inside a test would report success
 * without asserting anything, so the capability is probed once and used with
 * `it.skipIf` to surface the skip in the run report.
 */
const canCreateSymlinks = ((): boolean => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-symlink-probe-"));
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe.skipIf(!isLiveTestsEnabled())("CLI entrypoint execution regression tests", () => {
  beforeAll(async () => {
    // Cache hits: guarantees the fixtures exist before the first subprocess.
    await Promise.all([getSharedLuaLSBinary(), getSharedAnnotations()]);

    if (!fs.existsSync(distCli)) {
      await execAsync("npm run build", { cwd: rootDir });
    }
  }, 60000);

  it("executes dist/cli.js --help directly and outputs non-empty help text", async () => {
    expect(fs.existsSync(distCli), "dist/cli.js must be built").toBe(true);

    const { stdout, stderr } = await execFileAsync(process.execPath, [distCli, "--help"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: nanos-lint");
    expect(stdout).toContain("Check workspace files or directories");
    expect(stdout.trim().length).toBeGreaterThan(50);
  });

  it("executes dist/cli.js -v directly and outputs version string", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distCli, "-v"]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^nanos-lint v\d+\.\d+\.\d+$/);
  });

  it("copies annotations to the default .nanos-lint destination and refuses silent overwrites (#56)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-copy-annotations-"));
    try {
      const annotations = await getSharedAnnotations();

      const { stdout } = await execFileAsync(
        process.execPath,
        [distCli, "copy-annotations", "--annotations", annotations],
        { cwd: tempDir },
      );
      const copied = path.join(tempDir, ".nanos-lint", "annotations.lua");
      expect(stdout).toContain("[copy-annotations] Copied nanos world annotations to:");
      expect(fs.statSync(copied).size).toBe(fs.statSync(annotations).size);

      // The documented export-annotations alias resolves the same default and still needs --force.
      try {
        await execFileAsync(
          process.execPath,
          [distCli, "export-annotations", "--annotations", annotations],
          { cwd: tempDir },
        );
        expect.fail("Expected export-annotations to refuse overwriting without --force");
      } catch (err: unknown) {
        expect((err as { code?: number }).code).toBe(1);
      }

      await execFileAsync(
        process.execPath,
        [distCli, "export-annotations", "--force", "--annotations", annotations],
        { cwd: tempDir },
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exports package types through dist/cli.js and refuses silent overwrites (#90)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-export-types-cli-"));
    try {
      fs.mkdirSync(path.join(tempDir, "Server"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "cli-export-fixture", version: "2.0.0" }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tempDir, "Server", "api.d.lua"),
        "---@meta\n---@class Api\nApi = {}\n",
        "utf-8",
      );

      const { stdout } = await execFileAsync(process.execPath, [distCli, "export-types", "types"], {
        cwd: tempDir,
      });
      expect(stdout).toContain("[export-types] Exported 1 definition file(s) to:");
      expect(fs.existsSync(path.join(tempDir, "types", "Server", "api.d.lua"))).toBe(true);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tempDir, "types", "nanos-types.json"), "utf-8"),
      ) as { package?: { name?: string; version?: string } };
      expect(manifest.package).toEqual({ name: "cli-export-fixture", version: "2.0.0" });

      try {
        await execFileAsync(process.execPath, [distCli, "export-types", "types"], {
          cwd: tempDir,
        });
        expect.fail("Expected export-types to refuse overwriting without --force");
      } catch (err: unknown) {
        const execErr = err as { code?: number; stderr?: string };
        expect(execErr.code).toBe(1);
        expect(execErr.stderr).toContain("already exists and is not empty");
        expect(execErr.stderr).toContain("--force");
      }

      await execFileAsync(process.execPath, [distCli, "export-types", "types", "--force"], {
        cwd: tempDir,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js check tests/pass directly and exits with code 0", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      path.join(rootDir, "tests", "pass"),
    ]);
    expect(stdout).toMatch(/Diagnosis completed, no problems found across \d+ files?\./);
  });

  it("keeps stdout machine-readable for --format json even with info diagnostics", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      path.join(rootDir, "tests", "pass"),
      "--format",
      "json",
      "-l",
      "info",
    ]);

    // Progress milestones and info diagnostics are written to stderr, so the JSON report on
    // stdout stays parseable at any log level (the guarantee README documents).
    const report = JSON.parse(stdout) as { passed?: boolean; totalFiles?: number };
    expect(report.passed).toBe(true);
    expect(report.totalFiles).toBeGreaterThan(0);
    expect(stdout).not.toContain("\r");
    expect(stdout).not.toContain("\u001b");
  }, 60000);

  it("executes dist/cli.js check tests/fail/type_mismatch.lua directly and exits with code 1", async () => {
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        path.join(rootDir, "tests", "fail", "type_mismatch.lua"),
      ]);
      expect.fail("Expected dist/cli.js to exit with non-zero code on type_mismatch.lua");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stdout).toContain("param-type-mismatch");
    }
  });

  it("checks a package through dist/cli.js with realm-aware passes", async () => {
    const fixture = path.join(rootDir, "tests", "fixtures", "realms");
    try {
      await execFileAsync(process.execPath, [distCli, "check", fixture, "--format=pretty"]);
      expect.fail("Expected realm violations to fail the check");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      const stdout = normalizeSlashes(execErr.stdout);
      expect(execErr.code).toBe(1);
      // Server and client files are reported from their own strict realm pass.
      expect(stdout).toContain("tests/fixtures/realms/Server/combat.lua");
      expect(stdout).toContain("tests/fixtures/realms/Client/hud.lua");
      expect(stdout).toContain("Undefined global");
      // The guarded side-specific call in Shared/ stays unreported.
      expect(stdout).not.toContain("tests/fixtures/realms/Shared/bridge.lua");
    }
  }, 120000);

  it("restricts dist/cli.js check --realm client to the client realm", async () => {
    const fixture = path.join(rootDir, "tests", "fixtures", "realms");
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        fixture,
        "--realm",
        "client",
        "--format=pretty",
      ]);
      expect.fail("Expected the client realm violation to fail the check");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      const stdout = normalizeSlashes(execErr.stdout);
      expect(execErr.code).toBe(1);
      expect(stdout).toContain("tests/fixtures/realms/Client/hud.lua");
      expect(stdout).not.toContain("tests/fixtures/realms/Server/combat.lua");
    }
  }, 120000);

  it("passes a clean realm-aware package through dist/cli.js", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      path.join(rootDir, "tests", "fixtures", "realms_clean"),
      "--format=pretty",
    ]);

    expect(normalizeSlashes(stdout)).toMatch(
      /Diagnosis completed, no problems found across \d+ files?\./,
    );
  }, 120000);

  it("executes dist/cli.js check with variadic paths and realm selection (#46)", async () => {
    const fixture = path.join(rootDir, "tests", "fixtures", "realms");
    const sharedDir = path.join(fixture, "Shared");
    const serverDir = path.join(fixture, "Server");
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        sharedDir,
        serverDir,
        "--realm",
        "server",
        "--format=pretty",
      ]);
      expect.fail("Expected server realm violations to fail the check");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      const stdout = normalizeSlashes(execErr.stdout);
      expect(execErr.code).toBe(1);
      expect(stdout).toContain("tests/fixtures/realms/Server/combat.lua");
      expect(stdout).not.toContain("tests/fixtures/realms/Client/hud.lua");
      expect(stdout).not.toContain("tests/fixtures/realms/Shared/bridge.lua");
    }
  }, 120000);

  it("passes clean package with variadic directory targets through dist/cli.js (#46)", async () => {
    const cleanFixture = path.join(rootDir, "tests", "fixtures", "realms_clean");
    const sharedDir = path.join(cleanFixture, "Shared");
    const serverDir = path.join(cleanFixture, "Server");

    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      sharedDir,
      serverDir,
      "--format=pretty",
    ]);

    expect(normalizeSlashes(stdout)).toMatch(
      /Diagnosis completed, no problems found across 3 files\./,
    );
  }, 120000);

  it("executes dist/cli.js check with variadic file targets (#46)", async () => {
    const file1 = path.join(rootDir, "tests", "pass", "character.lua");
    const file2 = path.join(rootDir, "tests", "pass", "events.lua");

    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      file1,
      file2,
      "--format=pretty",
    ]);

    expect(normalizeSlashes(stdout)).toMatch(
      /Diagnosis completed, no problems found across 2 files\./,
    );
  }, 120000);

  it("executes bin/nanos-lint.js --help and matches dist/cli.js output", async () => {
    const { stdout: binStdout } = await execFileAsync(process.execPath, [binCli, "--help"]);
    const { stdout: distStdout } = await execFileAsync(process.execPath, [distCli, "--help"]);

    expect(binStdout.trim()).toBe(distStdout.trim());
  });

  it("executes via Windows batch launcher (.cmd) and propagates output and exit codes", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cmd-test-"));
    const tempCmd = path.join(tempDir, "nanos-lint.cmd");

    try {
      // Replicate the exact release .cmd launcher script
      fs.writeFileSync(tempCmd, `@echo off\r\nnode "${distCli}" %*\r\nexit /b %ERRORLEVEL%\r\n`);

      // The launcher is referenced by its bare file name and resolved through the
      // `cwd` option, so no environment-derived absolute path is ever placed on a
      // command line interpreted by cmd.exe (CodeQL: js/shell-command-injection-from-environment).
      const cmdLauncher = "nanos-lint.cmd";

      // 1. Verify --help via .cmd
      const { stdout: helpStdout } = await execFileAsync("cmd.exe", ["/c", cmdLauncher, "--help"], {
        cwd: tempDir,
      });
      expect(helpStdout).toContain("Usage: nanos-lint");

      // 2. Verify -v via .cmd
      const { stdout: versionStdout } = await execFileAsync("cmd.exe", ["/c", cmdLauncher, "-v"], {
        cwd: tempDir,
      });
      expect(versionStdout.trim()).toMatch(/^nanos-lint v\d+\.\d+\.\d+$/);

      // 3. Verify failure exit code propagation via .cmd
      try {
        await execFileAsync(
          "cmd.exe",
          ["/c", cmdLauncher, "check", "tests/fail/type_mismatch.lua"],
          { cwd: rootDir },
        );
        expect.fail("Expected .cmd launcher to propagate exit code 1");
      } catch (err: unknown) {
        const execErr = err as { code?: number };
        expect(execErr.code).toBe(1);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes with no arguments inside a directory containing LuaLS without hanging", async () => {
    // Regression test for issue where running `nanos-lint` with no arguments
    // inside the release folder would hang analyzing LuaLS internal scripts
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-release-hang-test-"));
    try {
      // Mock LuaLS standalone layout
      fs.writeFileSync(path.join(tempDir, "main.lua"), "-- dummy main.lua");
      fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "bin", "lua-language-server.exe"), "");
      fs.mkdirSync(path.join(tempDir, "script"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "script", "dummy.lua"), "-- dummy script");

      const { stdout } = await execFileAsync(process.execPath, [distCli], {
        cwd: tempDir,
        timeout: 10000,
      });

      expect(stdout).toContain("Diagnosis completed, no problems found");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("executes with --ignore pattern matching (myfolder/hello-*.lua)", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        fixtureDir,
        "--ignore",
        "myfolder/hello-*.lua",
      ]);
      expect.fail("Expected check to fail because other.lua still has an error");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stdout).toContain("other.lua");
      expect(execErr.stdout).not.toContain("hello-1.lua");
      expect(execErr.stdout).not.toContain("hello-2.lua");
      expect(execErr.stdout).toContain("2 problems (2 errors) found across 1 file.");
    }
  });

  it("executes with multiple --ignore rules and exits cleanly", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      fixtureDir,
      "--ignore",
      "myfolder/hello-*.lua",
      "-i",
      "myfolder/other.lua",
    ]);

    expect(stdout).toContain("Diagnosis completed, no problems found");
  });

  it("executes with directory --ignore rule and exits cleanly", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      fixtureDir,
      "--ignore",
      "myfolder",
    ]);

    expect(stdout).toContain("Diagnosis completed, no problems found");
  });

  it("preserves default ignore rules when --ignore is passed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-default-ignore-preserved-test-"));
    try {
      // Create a file inside `script/` which is in defaultIgnore
      fs.mkdirSync(path.join(tempDir, "script"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "script", "broken.lua"), "function invalid(");

      // 1. Without --ignore, defaultIgnore ignores `script/`, so 0 problems found
      const { stdout: stdoutDefault } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        tempDir,
      ]);
      expect(stdoutDefault).toContain("Diagnosis completed, no problems found");

      // 2. With --ignore, default structural exclusions remain active, so `script/broken.lua` is still ignored
      const { stdout: stdoutIgnore } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        tempDir,
        "--ignore",
        "unrelated_folder",
      ]);
      expect(stdoutIgnore).toContain("Diagnosis completed, no problems found");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js clean-cache and clean subcommands in an isolated environment", async () => {
    const tempEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-clean-test-"));
    try {
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";

      let expectedCacheDir: string;
      if (isWindows) {
        expectedCacheDir = path.join(tempEnvDir, "nanos-lint", "Cache");
      } else if (isMac) {
        expectedCacheDir = path.join(tempEnvDir, "Library", "Caches", "nanos-lint");
      } else {
        expectedCacheDir = path.join(tempEnvDir, "cache", "nanos-lint");
      }

      // Pre-populate the cache directory
      fs.mkdirSync(expectedCacheDir, { recursive: true });
      fs.writeFileSync(path.join(expectedCacheDir, "test-binary"), "dummy content");
      expect(fs.existsSync(expectedCacheDir)).toBe(true);

      const isolatedEnv = {
        ...process.env,
        LOCALAPPDATA: tempEnvDir,
        XDG_CACHE_HOME: path.join(tempEnvDir, "cache"),
        HOME: tempEnvDir,
      };

      // 1. Run clean-cache
      const { stdout: stdoutClean } = await execFileAsync(
        process.execPath,
        [distCli, "clean-cache"],
        { env: isolatedEnv },
      );
      expect(stdoutClean).toContain("[cache] Cleared cache at:");
      expect(fs.existsSync(expectedCacheDir)).toBe(false);

      // 2. Run alias clean on already empty cache
      const { stdout: stdoutEmpty } = await execFileAsync(process.execPath, [distCli, "clean"], {
        env: isolatedEnv,
      });
      expect(stdoutEmpty).toContain("[cache] Cache is already empty");
    } finally {
      fs.rmSync(tempEnvDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js check with custom --annotations path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-custom-ann-test-"));
    const annDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-ann-dir-"));
    try {
      const customAnn = path.join(annDir, "custom-annotations.lua");
      // Define a custom global function in the custom annotations file
      fs.writeFileSync(customAnn, "---@type fun(): void\nCustomSuperGlobal = nil\n", "utf-8");

      const script = path.join(tempDir, "script.lua");
      fs.writeFileSync(script, "CustomSuperGlobal()\n", "utf-8");

      // Running WITH --annotations customAnn must pass cleanly!
      const { stdout } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        script,
        "--annotations",
        customAnn,
      ]);
      expect(stdout).toMatch(/Diagnosis completed, no problems found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(annDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js check with custom NANOS_ANNOTATIONS_PATH environment variable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-env-ann-test-"));
    const annDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-env-ann-dir-"));
    try {
      const customAnn = path.join(annDir, "custom-annotations.lua");
      fs.writeFileSync(customAnn, "---@type fun(): void\nEnvSuperGlobal = nil\n", "utf-8");

      const script = path.join(tempDir, "script.lua");
      fs.writeFileSync(script, "EnvSuperGlobal()\n", "utf-8");

      const { stdout } = await execFileAsync(process.execPath, [distCli, "check", script], {
        env: {
          ...process.env,
          NANOS_ANNOTATIONS_PATH: customAnn,
        },
      });
      expect(stdout).toMatch(/Diagnosis completed, no problems found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(annDir, { recursive: true, force: true });
    }
  });

  it("checks a package with dependencies configured via nanos.deps and -d flag", async () => {
    const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-deps-test-"));
    const tempDir = fs.realpathSync.native
      ? fs.realpathSync.native(rawTempDir)
      : fs.realpathSync(rawTempDir);
    try {
      const depPkg = path.join(tempDir, "dep-pkg");
      fs.mkdirSync(path.join(depPkg, "Shared"), { recursive: true });
      fs.writeFileSync(
        path.join(depPkg, "Shared", "dep.lua"),
        "---@type fun(): void\nDepGlobalFunction = function() end\n",
        "utf-8",
      );

      const targetPkg = path.join(tempDir, "target-pkg");
      fs.mkdirSync(path.join(targetPkg, "Server"), { recursive: true });
      fs.writeFileSync(
        path.join(targetPkg, "Server", "server.lua"),
        "DepGlobalFunction()\n",
        "utf-8",
      );

      // Without dependency configured, it should fail with undefined-global
      try {
        await execFileAsync(process.execPath, [distCli, "check", targetPkg]);
        expect.fail("Expected check without dependency to fail with undefined-global");
      } catch (err: unknown) {
        const execErr = err as { code?: number; stdout?: string };
        expect(execErr.code).toBe(1);
        expect(execErr.stdout).toContain("undefined-global");
      }

      // With -d flag pointing to dep-pkg, it passes cleanly
      const { stdout: stdoutFlag } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        targetPkg,
        "-d",
        depPkg,
      ]);
      expect(stdoutFlag).toMatch(/Diagnosis completed, no problems found/);

      // With nanos.deps configured inside .luarc.json, it passes cleanly
      fs.writeFileSync(
        path.join(targetPkg, ".luarc.json"),
        JSON.stringify({ nanos: { deps: ["../dep-pkg"] } }, null, 2),
        "utf-8",
      );

      const { stdout: stdoutConfig } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        targetPkg,
      ]);
      expect(stdoutConfig).toMatch(/Diagnosis completed, no problems found/);

      // Missing dependency logs warning and does not crash
      const { stdout: stdoutWarn, stderr: stderrWarn } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        targetPkg,
        "-d",
        path.join(tempDir, "missing-dep"),
      ]);
      expect(stdoutWarn).toMatch(/Diagnosis completed, no problems found/);
      expect(stderrWarn).toContain("Dependency path not found");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!canCreateSymlinks)(
    "reports diagnostics correctly when target path is accessed through a symlink",
    async () => {
      const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-sym-integ-"));
      const tempDir = fs.realpathSync.native
        ? fs.realpathSync.native(rawTempDir)
        : fs.realpathSync(rawTempDir);
      try {
        const flatDir = path.join(tempDir, "flat");
        fs.mkdirSync(flatDir);
        fs.writeFileSync(
          path.join(flatDir, "broken.lua"),
          "CallNonExistentFunctionInFlat()\n",
          "utf-8",
        );

        const linkFlat = path.join(tempDir, "link-flat");
        fs.symlinkSync(flatDir, linkFlat, "dir");

        // Check absolute symlinked path
        try {
          await execFileAsync(process.execPath, [distCli, "check", linkFlat]);
          expect.fail("Expected check on symlinked path to fail");
        } catch (err: unknown) {
          const execErr = err as { code?: number; stdout?: string };
          expect(execErr.code).toBe(1);
          expect(execErr.stdout).toContain("1 problem");
          expect(execErr.stdout).toContain("undefined-global");
        }

        // Check relative symlinked path from cwd = tempDir
        try {
          await execFileAsync(process.execPath, [distCli, "check", "link-flat"], { cwd: tempDir });
          expect.fail("Expected relative symlinked check to fail");
        } catch (err: unknown) {
          const execErr = err as { code?: number; stdout?: string };
          expect(execErr.code).toBe(1);
          expect(execErr.stdout).toContain("1 problem");
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("excludes unrequested sibling folders to prevent context leakage across targets", async () => {
    const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-integ-"));
    const tempDir = fs.realpathSync.native
      ? fs.realpathSync.native(rawTempDir)
      : fs.realpathSync(rawTempDir);
    try {
      const subA = path.join(tempDir, "subA");
      const subB = path.join(tempDir, "subB");
      const unrelated = path.join(tempDir, "unrelated");
      fs.mkdirSync(subA);
      fs.mkdirSync(subB);
      fs.mkdirSync(unrelated);

      // subA calls undefined global
      fs.writeFileSync(path.join(subA, "a.lua"), "CallLeakedGlobal()\n", "utf-8");
      // subB has valid code
      fs.writeFileSync(path.join(subB, "b.lua"), "local b = 1\n", "utf-8");
      // unrelated defines the global
      fs.writeFileSync(
        path.join(unrelated, "provider.lua"),
        "CallLeakedGlobal = function() end\n",
        "utf-8",
      );

      // Checking subA and subB should NOT load unrelated/provider.lua, so subA must fail with undefined-global
      try {
        await execFileAsync(process.execPath, [distCli, "check", subA, subB]);
        expect.fail("Expected check on subA subB to fail with undefined-global");
      } catch (err: unknown) {
        const execErr = err as { code?: number; stdout?: string };
        expect(execErr.code).toBe(1);
        expect(execErr.stdout).toContain("undefined-global");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
