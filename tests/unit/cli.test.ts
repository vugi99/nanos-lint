import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { runCLI, isDirectExecution, collectIgnorePatterns, createProgram } from "../../src/cli.js";
import * as pathsModule from "../../src/paths.js";
import * as lualsModule from "../../src/luals.js";
import * as annotationsModule from "../../src/annotations.js";
import * as realmsModule from "../../src/realms.js";
import { logger } from "../../src/logger.js";
import { getProgressMode, setProgressMode } from "../../src/terminal-progress.js";

describe("cli module flag and command parsing", () => {
  it("prints help and returns 0 on --help and -h", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code1 = await runCLI(["--help"]);
      expect(code1).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage: nanos-lint"));

      // Clear so the second assertion cannot match the first call's output.
      spy.mockClear();

      const code2 = await runCLI(["-h"]);
      expect(code2).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage: nanos-lint"));
    } finally {
      spy.mockRestore();
    }
  });

  it("prints version and returns 0 on --version and -v", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code1 = await runCLI(["--version"]);
      expect(code1).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));

      spy.mockClear();

      const code2 = await runCLI(["-v"]);
      expect(code2).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));
    } finally {
      spy.mockRestore();
    }
  });

  it("handles help and version subcommands", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpCode = await runCLI(["help"]);
    expect(helpCode).toBe(0);

    const versionCode = await runCLI(["version"]);
    expect(versionCode).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));
    spy.mockRestore();
  });

  it("handles clean-cache and clean subcommands without touching real cache on disk", async () => {
    const cleanSpy = vi.spyOn(pathsModule, "cleanCache").mockReturnValue("/mock/cache/path");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const codeCleanCache = await runCLI(["clean-cache"]);
    expect(codeCleanCache).toBe(0);
    expect(cleanSpy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Cleared cache at: /mock/cache/path"),
    );

    cleanSpy.mockReturnValue(null);
    const codeClean = await runCLI(["clean"]);
    expect(codeClean).toBe(0);
    expect(cleanSpy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[cache\] Cache is already empty/));

    cleanSpy.mockRestore();
    spy.mockRestore();
  });

  it("errors on unrecognized flags and returns 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(["--unknown-flag"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--unknown-flag'"));

    errSpy.mockRestore();
  });

  it("errors when options requiring values are missing their values and returns 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const codeConfig = await runCLI(["--config"]);
    expect(codeConfig).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("option '--config <path>' argument missing"),
    );

    const codeChecklevel = await runCLI(["--checklevel"]);
    expect(codeChecklevel).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("option '--checklevel <level>' argument missing"),
    );

    errSpy.mockRestore();
  });

  it("executes init subcommand successfully without vendoring annotations", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-init-test-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = await runCLI(["init", tempDir]);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".nanos-lint"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
    }
  });

  it("executes init subcommand with --vendor when requested", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-init-vendor-"));
    const dummyAnnotations = path.join(tempDir, "source.lua");
    fs.writeFileSync(dummyAnnotations, "-- valid annotations\nlocal a = 1\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = await runCLI(["init", tempDir, "--vendor", "--annotations", dummyAnnotations]);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, ".nanos-lint", "annotations.lua"))).toBe(true);
      const config = JSON.parse(fs.readFileSync(path.join(tempDir, ".luarc.json"), "utf-8"));
      expect(config.workspace?.library).toEqual([".nanos-lint/annotations.lua"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
    }
  });

  it("rejects init --annotations without --vendor (#56)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-init-ann-"));
    const dummyAnnotations = path.join(tempDir, "source.lua");
    fs.writeFileSync(dummyAnnotations, "-- valid annotations\nlocal a = 1\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runCLI(["init", tempDir, "--annotations", dummyAnnotations]);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("requires --vendor"));
      expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("handles copy-annotations subcommand with target path and force overwrite", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-copy-ann-"));
    const dummyAnnotations = path.join(tempDir, "source.lua");
    fs.writeFileSync(dummyAnnotations, "-- valid annotations\nlocal a = 1\n");
    const targetFile = path.join(tempDir, "pinned", "annotations.lua");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code1 = await runCLI([
        "copy-annotations",
        targetFile,
        "--annotations",
        dummyAnnotations,
      ]);
      expect(code1).toBe(0);
      expect(fs.existsSync(targetFile)).toBe(true);

      const codeFail = await runCLI([
        "copy-annotations",
        targetFile,
        "--annotations",
        dummyAnnotations,
      ]);
      expect(codeFail).toBe(1);

      const codeForce = await runCLI([
        "copy-annotations",
        targetFile,
        "--force",
        "--annotations",
        dummyAnnotations,
      ]);
      expect(codeForce).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("handles init subcommand overwrite rejection and force overwrite", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-init-force-test-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code1 = await runCLI(["init", tempDir]);
      expect(code1).toBe(0);

      // Re-running without --force should fail with error code 1
      const codeFail = await runCLI(["init", tempDir]);
      expect(codeFail).toBe(1);

      // Re-running with --force should succeed with exit code 0
      const codeForce = await runCLI(["init", tempDir, "--force"]);
      expect(codeForce).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  describe("collectIgnorePatterns helper", () => {
    it("handles single pattern", () => {
      expect(collectIgnorePatterns("myfolder/hello-*.lua")).toEqual(["myfolder/hello-*.lua"]);
    });

    it("handles comma-separated patterns", () => {
      expect(collectIgnorePatterns("myfolder/hello-*.lua, vendor/**, dist")).toEqual([
        "myfolder/hello-*.lua",
        "vendor/**",
        "dist",
      ]);
    });

    it("handles newline-separated patterns", () => {
      const multiline = `
        myfolder/hello-*.lua
        temp/*
        vendor
      `;
      expect(collectIgnorePatterns(multiline)).toEqual([
        "myfolder/hello-*.lua",
        "temp/*",
        "vendor",
      ]);
    });

    it("accumulates across multiple calls", () => {
      const first = collectIgnorePatterns("pat1, pat2");
      const second = collectIgnorePatterns("pat3", first);
      expect(second).toEqual(["pat1", "pat2", "pat3"]);
    });
  });

  describe("isDirectExecution entrypoint detection", () => {
    it("returns false when argv[1] is undefined", () => {
      expect(isDirectExecution(import.meta.url, undefined)).toBe(false);
    });

    it("returns true when argv[1] matches module path exactly", () => {
      const fakeFile = path.resolve("/workspace/dist/cli.js");
      const fakeUrl = pathToFileURL(fakeFile).href;
      expect(isDirectExecution(fakeUrl, fakeFile)).toBe(true);
    });

    it("returns true when argv[1] points to cli.js or cli.ts in the same directory as a bundled chunk", () => {
      const chunkFile = path.resolve("/workspace/dist/cli-xyz123.js");
      const chunkUrl = pathToFileURL(chunkFile).href;
      const cliJsArgv = path.resolve("/workspace/dist/cli.js");
      const cliTsArgv = path.resolve("/workspace/dist/cli.ts");
      expect(isDirectExecution(chunkUrl, cliJsArgv)).toBe(true);
      expect(isDirectExecution(chunkUrl, cliTsArgv)).toBe(true);
    });

    it("returns false when argv[1] points to a different script or parent runner", () => {
      const chunkFile = path.resolve("/workspace/dist/cli-xyz123.js");
      const chunkUrl = pathToFileURL(chunkFile).href;
      const binArgv = path.resolve("/workspace/bin/nanos-lint.js");
      const userScript = path.resolve("/workspace/my-app/index.js");
      expect(binArgv).toBeDefined();
      expect(isDirectExecution(chunkUrl, binArgv)).toBe(false);
      expect(isDirectExecution(chunkUrl, userScript)).toBe(false);
    });

    it("handles non-file url and malformed url in toPath", () => {
      expect(isDirectExecution("http://localhost:8080/cli.js", "/some/file.js")).toBe(false);
      expect(isDirectExecution("file://%ZZ/cli.js", "/nonexistent/file.js")).toBe(false);
    });

    it("falls back to string path comparison when realpathSync throws", () => {
      const fakeUrl = pathToFileURL(path.resolve("/nonexistent/dist/cli.js")).href;
      expect(isDirectExecution(fakeUrl, path.resolve("/nonexistent/dist/cli.js"))).toBe(true);

      const chunkUrl = pathToFileURL(path.resolve("/nonexistent/dist/cli-chunk.js")).href;
      expect(isDirectExecution(chunkUrl, path.resolve("/nonexistent/dist/cli.js"))).toBe(true);
      expect(isDirectExecution(chunkUrl, path.resolve("/nonexistent/dist/cli.ts"))).toBe(true);
      expect(isDirectExecution(chunkUrl, path.resolve("/nonexistent/other/app.js"))).toBe(false);
    });
  });

  describe("additional cli command coverage", () => {
    it("handles download-luals subcommand with default and explicit versions", async () => {
      const lualsSpy = vi
        .spyOn(lualsModule, "resolveLuaLSBinary")
        .mockResolvedValue("/mock/bin/luals");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const codeDefault = await runCLI(["download-luals"]);
      expect(codeDefault).toBe(0);
      expect(lualsSpy).toHaveBeenCalledWith("latest", { offline: undefined });

      const codePositional = await runCLI(["download-luals", "3.13.5"]);
      expect(codePositional).toBe(0);
      expect(lualsSpy).toHaveBeenCalledWith("3.13.5", { offline: undefined });

      const codeFlag = await runCLI(["download-luals", "--luals-version", "3.13.4"]);
      expect(codeFlag).toBe(0);
      expect(lualsSpy).toHaveBeenCalledWith("3.13.4", { offline: undefined });

      lualsSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("handles warmup command and download alias with default and custom options", async () => {
      const lualsSpy = vi
        .spyOn(lualsModule, "resolveLuaLSBinary")
        .mockResolvedValue("/mock/bin/luals");
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const metaSpy = vi.spyOn(annotationsModule, "readAnnotationsMetadata").mockReturnValue({
        commitId: "abcdef123456",
        lastChecked: "2026-09-23",
        date: { year: 2026, month: 9, day: 23 },
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const codeDefault = await runCLI(["warmup"]);
      expect(codeDefault).toBe(0);
      expect(lualsSpy).toHaveBeenCalledWith("latest", { offline: undefined });
      expect(annotSpy).toHaveBeenCalledWith({ customPath: undefined, offline: undefined });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[warmup] LuaLS binary ready: /mock/bin/luals"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[warmup] nanos world annotations ready: /mock/annotations.lua (commit abcdef1)",
        ),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[warmup] Cache pre-warmed successfully. Ready for offline execution.",
        ),
      );

      // Test alias "download" and custom options
      const codeDownload = await runCLI([
        "download",
        "--luals-version",
        "3.19.0",
        "--annotations",
        "/custom/annotations.lua",
        "-l",
        "error",
      ]);
      expect(codeDownload).toBe(0);
      expect(lualsSpy).toHaveBeenCalledWith("3.19.0", { offline: undefined });
      expect(annotSpy).toHaveBeenCalledWith({
        customPath: "/custom/annotations.lua",
        offline: undefined,
      });

      lualsSpy.mockRestore();
      annotSpy.mockRestore();
      metaSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("auto-selects GitHub annotations when GITHUB_ACTIONS is set", async () => {
      const originalGithubActions = process.env.GITHUB_ACTIONS;
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck").mockResolvedValue({
        passed: false,
        totalProblems: 1,
        totalErrors: 0,
        totalWarnings: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///workspace/Server/combat.lua": [
            {
              code: "undefined-global",
              message: "Undefined global `Client`.",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
              severity: 2 as const,
            },
          ],
        },
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        process.env.GITHUB_ACTIONS = "true";
        expect(await runCLI(["check", "."])).toBe(1);
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("::warning file=");
        // Annotation paths are always slash-normalized, unlike the pretty reporter.
        expect(output).toContain("Server/combat.lua");
      } finally {
        if (originalGithubActions === undefined) {
          delete process.env.GITHUB_ACTIONS;
        } else {
          process.env.GITHUB_ACTIONS = originalGithubActions;
        }
        annotSpy.mockRestore();
        checkSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("runs realm passes when a realm plan is available and always cleans it up", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck");
      const cleanup = vi.fn();
      const plan = {
        baseConfigPath: "/tmp/base.json",
        passes: [
          {
            realm: "server" as const,
            configPath: "/tmp/server.json",
            reportFiles: new Set(["a.lua"]),
          },
        ],
        cleanup,
      };
      const planSpy = vi.spyOn(realmsModule, "planRealmCheck").mockReturnValue(plan);
      const realmRunSpy = vi.spyOn(realmsModule, "runRealmAwareCheck").mockResolvedValue({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        expect(await runCLI(["check", ".", "--realm", "client"])).toBe(0);
        expect(planSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            selection: "client",
            annotationsPath: "/mock/annotations.lua",
          }),
        );
        expect(realmRunSpy).toHaveBeenCalledWith(plan, ".", expect.objectContaining({ path: "." }));
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(checkSpy).not.toHaveBeenCalled();
      } finally {
        annotSpy.mockRestore();
        checkSpy.mockRestore();
        planSpy.mockRestore();
        realmRunSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("cleans up the realm plan even when the realm run fails", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const cleanup = vi.fn();
      const planSpy = vi.spyOn(realmsModule, "planRealmCheck").mockReturnValue({
        baseConfigPath: "/tmp/base.json",
        passes: [],
        cleanup,
      });
      const realmRunSpy = vi
        .spyOn(realmsModule, "runRealmAwareCheck")
        .mockRejectedValue(new Error("luals exploded"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(await runCLI(["check", "."])).toBe(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("luals exploded"));
      } finally {
        annotSpy.mockRestore();
        planSpy.mockRestore();
        realmRunSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it("rejects an unknown --realm value", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await runCLI(["check", ".", "--realm", "banana"])).not.toBe(0);
        const messages = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(messages).toContain("Allowed choices are all, client, server, shared");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("handles errors during clean-cache execution", async () => {
      const cleanSpy = vi.spyOn(pathsModule, "cleanCache").mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const codeError = await runCLI(["clean-cache"]);
      expect(codeError).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear cache: EACCES: permission denied"),
      );

      cleanSpy.mockImplementation(() => {
        throw "String error";
      });
      const codeStringError = await runCLI(["clean-cache"]);
      expect(codeStringError).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear cache: String error"),
      );

      cleanSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("prints stack trace when DEBUG environment variable is set and an error occurs", async () => {
      const origDebug = process.env.DEBUG;
      process.env.DEBUG = "1";
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await runCLI(["check", "--config", "/nonexistent/path/config.json"]);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Configuration file not found"));

      if (origDebug !== undefined) {
        process.env.DEBUG = origDebug;
      } else {
        delete process.env.DEBUG;
      }
      errSpy.mockRestore();
    });

    it("handles check command with options and exit codes", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Success passing check
      checkSpy.mockResolvedValueOnce({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const codePass = await runCLI(["check", ".", "--github", "-l", "error"]);
      expect(codePass).toBe(0);

      // Failing check with --no-fail should return 0
      checkSpy.mockResolvedValueOnce({
        passed: false,
        totalProblems: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err",
              message: "m",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
            },
          ],
        },
      });
      const codeNoFail = await runCLI(["check", ".", "--format", "json", "--no-fail"]);
      expect(codeNoFail).toBe(0);

      // Failing check without --no-fail should return 1
      checkSpy.mockResolvedValueOnce({
        passed: false,
        totalProblems: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err",
              message: "m",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
            },
          ],
        },
      });
      const codeFail = await runCLI(["check", "."]);
      expect(codeFail).toBe(1);

      // Failing check with github format
      checkSpy.mockResolvedValueOnce({
        passed: false,
        totalProblems: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err",
              message: "m",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
            },
          ],
        },
      });
      const codeGithub = await runCLI(["check", ".", "--format", "github", "--no-fail"]);
      expect(codeGithub).toBe(0);

      // Failing check with pretty format
      checkSpy.mockResolvedValueOnce({
        passed: false,
        totalProblems: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err",
              message: "m",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
            },
          ],
        },
      });
      const codePretty = await runCLI(["check", ".", "--format", "pretty", "--no-fail"]);
      expect(codePretty).toBe(0);

      // Check with --ignore option and --log-level
      checkSpy.mockResolvedValueOnce({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const codeIgnore = await runCLI(["check", ".", "--ignore", "myfolder/*.lua", "-l", "error"]);
      expect(codeIgnore).toBe(0);

      // Check with -l info
      checkSpy.mockResolvedValueOnce({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const codeLog = await runCLI(["check", ".", "-l", "info"]);
      expect(codeLog).toBe(0);
      expect(logger.getLevel()).toBe("info");

      annotSpy.mockRestore();
      checkSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("configures logger log-level when --log-level or -l is supplied", async () => {
      logger.setLevel("warn");
      expect(logger.getLevel()).toBe("warn");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const code1 = await runCLI(["--version", "--log-level", "debug"]);
      expect(code1).toBe(0);
      expect(logger.getLevel()).toBe("debug");

      const code2 = await runCLI(["version", "-l", "silent"]);
      expect(code2).toBe(0);
      expect(logger.getLevel()).toBe("silent");

      logSpy.mockRestore();
      logger.setLevel("warn");
    });

    it("can create a program without options and parse with --log-level= syntax", async () => {
      const prog = createProgram();
      expect(prog).toBeDefined();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await runCLI(["--version", "--log-level=info"]);
      expect(code).toBe(0);
      expect(logger.getLevel()).toBe("info");
      logSpy.mockRestore();
      logger.setLevel("warn");
    });

    it("disables interactive progress with --no-progress and --format json (Issue #50)", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck").mockResolvedValue({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      } as never);

      try {
        setProgressMode("auto");
        expect(await runCLI(["version", "--no-progress"])).toBe(0);
        expect(getProgressMode()).toBe("off");

        setProgressMode("auto");
        expect(await runCLI(["check", ".", "--format", "json"])).toBe(0);
        expect(getProgressMode()).toBe("off");

        setProgressMode("auto");
        expect(await runCLI(["check", ".", "--format", "pretty", "--no-progress"])).toBe(0);
        expect(getProgressMode()).toBe("off");
        expect(checkSpy).toHaveBeenCalled();
      } finally {
        setProgressMode("auto");
        annotSpy.mockRestore();
        checkSpy.mockRestore();
        logSpy.mockRestore();
        logger.setLevel("warn");
      }
    });

    it("silences the diagnosis report only with --log-level=silent", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck");
      const failingResult = {
        passed: false,
        totalProblems: 1,
        totalErrors: 1,
        totalWarnings: 0,
        totalFiles: 1,
        totalFilesChecked: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err",
              message: "m",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1 as const,
            },
          ],
        },
      };
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        checkSpy.mockResolvedValue(failingResult);
        expect(await runCLI(["check", ".", "-l", "silent"])).toBe(1);
        expect(logSpy).not.toHaveBeenCalled();
        expect(checkSpy).toHaveBeenCalledTimes(1);

        logSpy.mockClear();
        expect(await runCLI(["check", ".", "-l", "error"])).toBe(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("test.lua"));

        logSpy.mockClear();
        expect(await runCLI(["check", ".", "--log-level", "warn"])).toBe(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("test.lua"));
      } finally {
        logger.setLevel("warn");
        annotSpy.mockRestore();
        checkSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("silences init, clean-cache and version subcommand output with --log-level=silent", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-silent-"));
      const dummyAnnotations = path.join(tempDir, "source-annotations.lua");
      fs.writeFileSync(dummyAnnotations, "-- dummy annotations", "utf-8");

      const origAnnotationsPath = process.env.NANOS_ANNOTATIONS_PATH;
      process.env.NANOS_ANNOTATIONS_PATH = dummyAnnotations;

      const cleanSpy = vi.spyOn(pathsModule, "cleanCache").mockReturnValue(null);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        expect(await runCLI(["init", tempDir, "-l", "silent"])).toBe(0);
        expect(logSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(true);

        expect(await runCLI(["clean-cache", "-l", "silent"])).toBe(0);
        expect(logSpy).not.toHaveBeenCalled();

        expect(await runCLI(["version", "-l", "silent"])).toBe(0);
        expect(logSpy).not.toHaveBeenCalled();

        // Without silent the same commands keep printing their result.
        logSpy.mockClear();
        expect(await runCLI(["version"])).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));
      } finally {
        logger.setLevel("warn");
        if (origAnnotationsPath !== undefined) {
          process.env.NANOS_ANNOTATIONS_PATH = origAnnotationsPath;
        } else {
          delete process.env.NANOS_ANNOTATIONS_PATH;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
        cleanSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("rejects the removed --quiet flag on every command (issue #3)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await runCLI(["check", ".", "--quiet"])).not.toBe(0);
        expect(await runCLI(["warmup", "--quiet"])).not.toBe(0);
        expect(await runCLI(["warmup", "-q"])).not.toBe(0);
        const messages = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(messages).toContain("unknown option");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("supports variadic paths for check command (#46)", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const cleanup = vi.fn();
      const plan = {
        baseConfigPath: "/tmp/base.json",
        passes: [
          {
            realm: "server" as const,
            configPath: "/tmp/server.json",
            reportFiles: new Set(["Server/combat.lua"]),
          },
        ],
        cleanup,
      };
      const planSpy = vi.spyOn(realmsModule, "planRealmCheck").mockReturnValue(plan);
      const realmRunSpy = vi.spyOn(realmsModule, "runRealmAwareCheck").mockResolvedValue({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const code = await runCLI([
          "check",
          "tests/fixtures/realms/Shared",
          "tests/fixtures/realms/Server",
          "--realm",
          "server",
        ]);
        const expectedShared = fs.realpathSync.native
          ? fs.realpathSync.native(path.resolve("tests/fixtures/realms/Shared"))
          : path.resolve("tests/fixtures/realms/Shared");
        const expectedServer = fs.realpathSync.native
          ? fs.realpathSync.native(path.resolve("tests/fixtures/realms/Server"))
          : path.resolve("tests/fixtures/realms/Server");
        expect(code).toBe(0);
        expect(planSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            selection: "server",
            targetPaths: [expectedShared, expectedServer],
          }),
        );
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally {
        annotSpy.mockRestore();
        planSpy.mockRestore();
        realmRunSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("passes repeatable -d and --dep options to planRealmCheck", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const cleanup = vi.fn();
      const plan = {
        baseConfigPath: "/mock/base.json",
        passes: [],
        cleanup,
      };
      const planSpy = vi.spyOn(realmsModule, "planRealmCheck").mockReturnValue(plan);
      const realmRunSpy = vi.spyOn(realmsModule, "runRealmAwareCheck").mockResolvedValue({
        passed: true,
        totalProblems: 0,
        totalFiles: 1,
        diagnostics: {},
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const code = await runCLI([
          "check",
          "tests/fixtures/realms",
          "-d",
          "../pkgA",
          "--dep",
          "../pkgB/types.lua",
        ]);
        expect(code).toBe(0);
        expect(planSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            cliDeps: ["../pkgA", "../pkgB/types.lua"],
          }),
        );
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally {
        annotSpy.mockRestore();
        planSpy.mockRestore();
        realmRunSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("errors when any variadic path does not exist", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await runCLI(["check", "tests/pass", "nonexistent_dir_xyz"]);
        expect(code).toBe(1);
        const messages = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(messages).toContain("Target path does not exist: nonexistent_dir_xyz");
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
