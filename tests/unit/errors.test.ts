import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  NanosLintError,
  ConfigError,
  LuaLSError,
  AnnotationsError,
  CacheError,
  ExportTypesError,
  loadConfigFile,
  resolveAnnotations,
  resolveLuaLSVersion,
  getPlatformInfo,
  runCLI,
  logger,
} from "../../src/index.js";

describe("Typed Error Hierarchy", () => {
  it("creates NanosLintError with correct name, code, remedy and cause", () => {
    const cause = new Error("inner error");
    const err = new NanosLintError("Something failed", "ERR_CODE", "Fix it this way", { cause });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NanosLintError);
    expect(err.name).toBe("NanosLintError");
    expect(err.message).toBe("Something failed");
    expect(err.code).toBe("ERR_CODE");
    expect(err.remedy).toBe("Fix it this way");
    expect(err.cause).toBe(cause);
  });

  it("subclasses retain appropriate class name and inherit from NanosLintError", () => {
    const configErr = new ConfigError("Config missing", "ERR_CONFIG_NOT_FOUND", "Run init");
    expect(configErr).toBeInstanceOf(NanosLintError);
    expect(configErr).toBeInstanceOf(ConfigError);
    expect(configErr.name).toBe("ConfigError");

    const lualsErr = new LuaLSError("Crash", "ERR_LUALS_EXECUTION", "Reinstall");
    expect(lualsErr).toBeInstanceOf(NanosLintError);
    expect(lualsErr).toBeInstanceOf(LuaLSError);
    expect(lualsErr.name).toBe("LuaLSError");

    const annotErr = new AnnotationsError("Download failed", "ERR_ANNOTATIONS_DOWNLOAD");
    expect(annotErr).toBeInstanceOf(NanosLintError);
    expect(annotErr).toBeInstanceOf(AnnotationsError);
    expect(annotErr.name).toBe("AnnotationsError");

    const cacheErr = new CacheError("Corrupted", "ERR_CACHE_CORRUPTED");
    expect(cacheErr).toBeInstanceOf(NanosLintError);
    expect(cacheErr).toBeInstanceOf(CacheError);
    expect(cacheErr.name).toBe("CacheError");

    const exportErr = new ExportTypesError("Exists", "ERR_EXPORT_TYPES_EXISTS");
    expect(exportErr).toBeInstanceOf(NanosLintError);
    expect(exportErr).toBeInstanceOf(ExportTypesError);
    expect(exportErr.name).toBe("ExportTypesError");
  });

  describe("Call site typed errors", () => {
    it("loadConfigFile throws ConfigError with ERR_CONFIG_NOT_FOUND for nonexistent file", () => {
      expect(() => loadConfigFile("/nonexistent/file/.luarc.json")).toThrow(ConfigError);
      try {
        loadConfigFile("/nonexistent/file/.luarc.json");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configErr = err as ConfigError;
        expect(configErr.code).toBe("ERR_CONFIG_NOT_FOUND");
        expect(configErr.remedy).toBeDefined();
      }
    });

    it("loadConfigFile throws ConfigError with ERR_CONFIG_PARSE for invalid JSON", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-err-test-"));
      const badConfig = path.join(tempDir, ".luarc.json");
      fs.writeFileSync(badConfig, "{ invalid json ...", "utf-8");

      try {
        expect(() => loadConfigFile(badConfig)).toThrow(ConfigError);
        try {
          loadConfigFile(badConfig);
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigError);
          const configErr = err as ConfigError;
          expect(configErr.code).toBe("ERR_CONFIG_PARSE");
          expect(configErr.remedy).toContain("Check your .luarc.json syntax");
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("resolveAnnotations throws AnnotationsError for nonexistent custom file", async () => {
      await expect(
        resolveAnnotations({ customPath: "/nonexistent/custom-annotations.lua" }),
      ).rejects.toThrow(AnnotationsError);

      try {
        await resolveAnnotations({ customPath: "/nonexistent/custom-annotations.lua" });
      } catch (err) {
        expect(err).toBeInstanceOf(AnnotationsError);
        const annErr = err as AnnotationsError;
        expect(annErr.code).toBe("ERR_ANNOTATIONS_NOT_FOUND");
        expect(annErr.remedy).toBeDefined();
      }
    });

    it("resolveLuaLSVersion throws LuaLSError for invalid version format", async () => {
      await expect(resolveLuaLSVersion("invalid/version/tag")).rejects.toThrow(LuaLSError);

      try {
        await resolveLuaLSVersion("invalid/version/tag");
      } catch (err) {
        expect(err).toBeInstanceOf(LuaLSError);
        const lualsErr = err as LuaLSError;
        expect(lualsErr.code).toBe("ERR_LUALS_INVALID_VERSION");
        expect(lualsErr.remedy).toBeDefined();
      }
    });

    it("getPlatformInfo throws LuaLSError for unsupported platform", () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, "platform", { value: "sunos", configurable: true });
        expect(() => getPlatformInfo()).toThrow(LuaLSError);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      }
    });
  });

  describe("CLI formatting of NanosLintError", () => {
    it("outputs error and hint without raw stack trace for NanosLintError", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const exitCode = await runCLI(["check", ".", "--config", "/nonexistent/.luarc.json"]);
        expect(exitCode).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^error: Configuration file not found/),
        );
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^hint: /));
      } finally {
        errSpy.mockRestore();
      }
    });

    it("outputs stack and cause in debug mode", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const prevLevel = logger.getLevel();
      logger.setLevel("debug");
      try {
        const exitCode = await runCLI([
          "check",
          ".",
          "--config",
          "/nonexistent/.luarc.json",
          "-l",
          "debug",
        ]);
        expect(exitCode).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^error: Configuration file not found/),
        );
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^hint: /));
      } finally {
        logger.setLevel(prevLevel);
        errSpy.mockRestore();
      }
    });
  });
});
