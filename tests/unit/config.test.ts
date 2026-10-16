import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPackageRoot,
  getDefinitionsDir,
  getDefaultAnnotationsPath,
  getDefaultTemplatePath,
  loadConfigFile,
  mergeConfigs,
  buildWorkspaceConfig,
  parseJsonc,
  stripJsonComments,
  stripTrailingSlashes,
  resolveWorkspaceConfig,
  initWorkspace,
  VALID_LUALS_DIAGNOSTIC_CODES,
} from "../../src/config.js";
import { logger } from "../../src/logger.js";
import type { LuaRCConfig } from "../../src/types.js";

describe("config module", () => {
  it("resolves package root and definitions directory", () => {
    const root = getPackageRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const defDir = getDefinitionsDir();
    expect(defDir).toBeDefined();
    expect(defDir).toContain("annotations");

    const annotationsPath = getDefaultAnnotationsPath();
    expect(annotationsPath).toBeDefined();
    expect(annotationsPath).toContain("annotations.lua");

    const template = getDefaultTemplatePath();
    expect(template).toBe(path.join(root, "templates", ".luarc.json"));
  });

  it("loads and parses the default template", () => {
    const templatePath = getDefaultTemplatePath();
    const config = loadConfigFile(templatePath);
    expect(config.runtime?.version).toBe("Lua 5.4");
    expect(config.runtime?.path).toEqual([
      "Server/?",
      "Server/?.lua",
      "Client/?",
      "Client/?.lua",
      "Shared/?",
      "Shared/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);
    expect(config.runtime?.special?.["Package.Require"]).toBe("require");
    expect(config.diagnostics?.enable).toBe(true);
    expect(config.diagnostics?.severity?.["unused-local"]).toBe("Warning");
    expect(config.workspace?.ignoreDir).toContain("script");
    expect(config.workspace?.ignoreDir).toContain("node_modules");
  });

  it("maps the Packages searcher to sibling packages when checking one package", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-package-paths-"));
    const packageDir = path.join(tempDir, "Packages", "current");
    try {
      fs.mkdirSync(packageDir, { recursive: true });
      const defaults = buildWorkspaceConfig(packageDir);
      expect(defaults.runtime?.path).toContain("../?");
      expect(defaults.runtime?.path).toContain("../?.lua");
      expect(defaults.runtime?.path).not.toContain("Packages/?");
      expect(defaults.runtime?.plugin).toBe(
        path.join(getPackageRoot(), "templates", "package-require.lua").replace(/\\/g, "/"),
      );

      fs.writeFileSync(
        path.join(packageDir, ".luarc.json"),
        JSON.stringify({
          runtime: { path: ["custom/?.lua"], plugin: "custom-plugin.lua" },
        }),
      );
      const custom = buildWorkspaceConfig(packageDir);
      expect(custom.runtime?.path).toEqual(["custom/?.lua"]);
      expect(custom.runtime?.plugin).toBe("custom-plugin.lua");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("shipped templates/.luarc.json validation (Issue #36)", () => {
    it("asserts 100% of diagnostic keys in templates/.luarc.json belong to VALID_LUALS_DIAGNOSTIC_CODES", () => {
      const templatePath = getDefaultTemplatePath();
      const config = loadConfigFile(templatePath);

      const severityMap = config.diagnostics?.severity ?? {};
      const severityKeys = Object.keys(severityMap);
      expect(severityKeys.length).toBeGreaterThan(0);
      for (const key of severityKeys) {
        expect(
          VALID_LUALS_DIAGNOSTIC_CODES.has(key),
          `diagnostics.severity key "${key}" in templates/.luarc.json must belong to VALID_LUALS_DIAGNOSTIC_CODES`,
        ).toBe(true);
      }

      const neededFileStatusMap = config.diagnostics?.neededFileStatus ?? {};
      const neededFileStatusKeys = Object.keys(neededFileStatusMap);
      expect(neededFileStatusKeys.length).toBeGreaterThan(0);
      for (const key of neededFileStatusKeys) {
        expect(
          VALID_LUALS_DIAGNOSTIC_CODES.has(key),
          `diagnostics.neededFileStatus key "${key}" in templates/.luarc.json must belong to VALID_LUALS_DIAGNOSTIC_CODES`,
        ).toBe(true);
      }
    });

    it("emits zero warning logs when merging default template (no dropped diagnostic keys)", () => {
      const templatePath = getDefaultTemplatePath();
      const template = loadConfigFile(templatePath);

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const merged = mergeConfigs(template, {});
        expect(warnSpy).not.toHaveBeenCalled();
        expect(merged.diagnostics?.severity).toBeDefined();
        expect(Object.keys(merged.diagnostics?.severity ?? {}).length).toBe(
          Object.keys(template.diagnostics?.severity ?? {}).length,
        );
        expect(Object.keys(merged.diagnostics?.neededFileStatus ?? {}).length).toBe(
          Object.keys(template.diagnostics?.neededFileStatus ?? {}).length,
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("asserts $schema URL pattern in templates/.luarc.json is valid (offline check)", () => {
      const templatePath = getDefaultTemplatePath();
      const config = loadConfigFile(templatePath);
      expect(config.$schema).toBeDefined();
      expect(typeof config.$schema).toBe("string");
      expect(config.$schema).toMatch(/^https:\/\/raw\.githubusercontent\.com\/LuaLS\/vscode-lua\//);
      expect(config.$schema).toMatch(/\/schema\.json$/);
    });
  });

  it("merges custom workspace config while preserving nanos definitions", () => {
    const base: LuaRCConfig = {
      runtime: { version: "Lua 5.4" },
      workspace: { library: [] },
      diagnostics: {
        globals: ["Server", "Client"],
        severity: { "undefined-field": "Warning" },
      },
    };

    const override: LuaRCConfig = {
      workspace: {
        ignoreDir: ["custom_ignore"],
      },
      diagnostics: {
        globals: ["MyCustomGlobal"],
        severity: { "undefined-field": "Information" },
        disable: ["lowercase-global"],
      },
    };

    const fakeDefDir = "C:/mock/definitions";
    const merged = mergeConfigs(base, override, fakeDefDir);

    expect(merged.runtime?.version).toBe("Lua 5.4");
    expect(merged.workspace?.library).toContain(fakeDefDir);
    expect(merged.workspace?.ignoreDir).toContain("custom_ignore");
    expect(merged.workspace?.ignoreDir).toContain("script");
    expect(merged.diagnostics?.globals).toContain("Server");
    expect(merged.diagnostics?.globals).toContain("MyCustomGlobal");
    expect(merged.diagnostics?.severity?.["undefined-field"]).toBe("Information");
    expect(merged.diagnostics?.disable).toContain("lowercase-global");
  });

  it("filters unrecognized diagnostic codes from diagnostics.severity and neededFileStatus (Issue #22)", () => {
    const base: LuaRCConfig = {
      diagnostics: {
        severity: {
          "unused-local": "Warning",
          "redefined-local": "Warning",
        },
        neededFileStatus: {
          "unused-local": "Any",
        },
      },
    };

    const override: LuaRCConfig = {
      diagnostics: {
        severity: {
          "syntax-error": "Error",
          "bogus-key": "Warning",
          "undefined-global": "Error",
        },
        neededFileStatus: {
          "syntax-error": "Any",
          "redefined-local": "Any",
        },
      },
    };

    const merged = mergeConfigs(base, override);
    expect(merged.diagnostics?.severity).toEqual({
      "unused-local": "Warning",
      "redefined-local": "Warning",
      "undefined-global": "Error",
    });
    expect(merged.diagnostics?.severity).not.toHaveProperty("syntax-error");
    expect(merged.diagnostics?.severity).not.toHaveProperty("bogus-key");

    expect(merged.diagnostics?.neededFileStatus).toEqual({
      "unused-local": "Any",
      "redefined-local": "Any",
    });
    expect(merged.diagnostics?.neededFileStatus).not.toHaveProperty("syntax-error");
  });

  it("preserves default ignore rules when cliIgnore is passed", () => {
    const base: LuaRCConfig = {
      runtime: { version: "Lua 5.4" },
      workspace: {
        library: [],
        ignoreDir: ["script", "meta", "locale", "log", "node_modules"],
      },
    };

    const override: LuaRCConfig = {
      workspace: {
        ignoreDir: ["user_override_dir"],
      },
      files: {
        exclude: ["user_config_exclude.lua"],
      },
    };

    const fakeDefDir = "C:/mock/definitions";
    const merged = mergeConfigs(base, override, fakeDefDir, {
      cliIgnore: ["myfolder/hello-*.lua", "custom_folder", "other/**/*.lua"],
    });

    // Default structural rules MUST still be in ignoreDir
    expect(merged.workspace?.ignoreDir).toContain("script");
    expect(merged.workspace?.ignoreDir).toContain("meta");
    expect(merged.workspace?.ignoreDir).toContain("node_modules");
    expect(merged.workspace?.ignoreDir).toContain(".git");

    // Also user's override ignoreDir and plain directories from cliIgnore
    expect(merged.workspace?.ignoreDir).toContain("user_override_dir");
    expect(merged.workspace?.ignoreDir).toContain("custom_folder");

    // files.exclude must contain user override and CLI ignore patterns
    expect(merged.files?.exclude).toContain("user_config_exclude.lua");
    expect(merged.files?.exclude).toContain("myfolder/hello-*.lua");
    expect(merged.files?.exclude).toContain("custom_folder");
    expect(merged.files?.exclude).toContain("custom_folder/**");
    expect(merged.files?.exclude).toContain("other/**/*.lua");
  });

  it("strips JSON comments and trailing commas correctly", () => {
    const jsonc = `{
      // Single line comment
      "string": "https://example.com/api", // comment after value
      /* Multi-line
         comment */
      "nested": {
        "quotedComment": "/* not a comment */ // still string",
        "trailing": 42,
      },
      "list": [
        "item1",
        "item2",
      ],
    }`;

    const stripped = stripJsonComments(jsonc);
    expect(stripped).not.toContain("// Single line comment");
    expect(stripped).not.toContain("/* Multi-line");
    expect(stripped).toContain("https://example.com/api");

    const parsed = parseJsonc<{
      string: string;
      nested: { quotedComment: string; trailing: number };
      list: string[];
    }>(jsonc);

    expect(parsed.string).toBe("https://example.com/api");
    expect(parsed.nested.quotedComment).toBe("/* not a comment */ // still string");
    expect(parsed.nested.trailing).toBe(42);
    expect(parsed.list).toEqual(["item1", "item2"]);
  });

  it("handles empty comments and escaped strings in JSONC", () => {
    const jsonc = `{
      "escaped": "value with \\"quotes\\" and \\\\ backslash",
      /**/
      //
      "valid": true,
    }`;

    const parsed = parseJsonc<{ escaped: string; valid: boolean }>(jsonc);
    expect(parsed.escaped).toBe('value with "quotes" and \\ backslash');
    expect(parsed.valid).toBe(true);
  });

  describe("stripTrailingSlashes", () => {
    it("removes trailing slashes", () => {
      expect(stripTrailingSlashes("myfolder/")).toBe("myfolder");
      expect(stripTrailingSlashes("myfolder///")).toBe("myfolder");
      expect(stripTrailingSlashes("myfolder")).toBe("myfolder");
      expect(stripTrailingSlashes("a/b//")).toBe("a/b");
      expect(stripTrailingSlashes("C:/dir/")).toBe("C:/dir");
      expect(stripTrailingSlashes("///")).toBe("");
      expect(stripTrailingSlashes("")).toBe("");
    });

    it("stays linear on slash-heavy input that would be quadratic for /\\/+$/", () => {
      // A trailing-slash regex has to retry its repetition at every offset when the
      // string does not end with a slash, which is quadratic in the input length.
      // The budget is deliberately generous (a quadratic implementation needs
      // minutes for 100k characters) so the assertion cannot flake on a slow or
      // loaded CI runner, while still failing on a real complexity regression.
      const pathological = "/".repeat(100_000) + "!";
      const started = Date.now();
      expect(stripTrailingSlashes(pathological)).toBe(pathological);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it("keeps CLI ignore expansion working for patterns with trailing slashes", () => {
      const merged = mergeConfigs({}, {}, "C:/mock/definitions", {
        cliIgnore: ["myfolder///", "other"],
      });

      expect(merged.files?.exclude).toContain("myfolder/**");
      expect(merged.workspace?.ignoreDir).toContain("myfolder");
      expect(merged.workspace?.ignoreDir).toContain("other");
    });

    it("merges pathological CLI ignore patterns quickly (js/polynomial-redos regression)", () => {
      // Same generous budget rationale as the stripTrailingSlashes test above.
      const pathological = ["/".repeat(100_000) + "!", "/".repeat(50_000) + "\\"];
      const started = Date.now();
      const merged = mergeConfigs({}, {}, "C:/mock/definitions", { cliIgnore: pathological });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(merged.files?.exclude).toContain(pathological[0]);
    });

    it("accepts a directory containing annotations.lua and resolves it to annotations.lua path", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cfg-dir-"));
      try {
        const annFile = path.join(tempDir, "annotations.lua");
        fs.writeFileSync(annFile, "-- test");

        const mergedWithDir = mergeConfigs({}, {}, tempDir);
        const expectedNorm = annFile.split(path.sep).join("/");
        expect(mergedWithDir.workspace?.library).toContain(expectedNorm);

        const mergedWithFile = mergeConfigs({}, {}, annFile);
        expect(mergedWithFile.workspace?.library).toContain(expectedNorm);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("automatically excludes tool files when checking a tool directory without cliIgnore", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-tool-dir-"));
      try {
        fs.writeFileSync(path.join(tempDir, "main.lua"), "-- tool entry");
        fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
        const binName =
          process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
        fs.writeFileSync(path.join(tempDir, "bin", binName), "fake binary");

        const dummyAnnotations = path.join(tempDir, "annotations.lua");
        fs.writeFileSync(dummyAnnotations, "-- dummy annotations");

        const resolved = resolveWorkspaceConfig(tempDir, undefined, {
          annotationsPath: dummyAnnotations,
        });

        expect(resolved.isTemp).toBe(true);
        const writtenConfig = JSON.parse(
          fs.readFileSync(resolved.configPath, "utf-8"),
        ) as LuaRCConfig;
        expect(writtenConfig.files?.exclude).toContain("main.lua");
        expect(writtenConfig.files?.exclude).toContain("**/main.lua");
        expect(writtenConfig.files?.exclude).toContain("debugger.lua");

        fs.unlinkSync(resolved.configPath);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("throws a descriptive error when candidate workspace .luarc.json has invalid JSON", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-invalid-cfg-"));
      try {
        fs.writeFileSync(path.join(tempDir, ".luarc.json"), "{ invalid json: }");
        expect(() => {
          resolveWorkspaceConfig(tempDir);
        }).toThrow(/Failed to parse workspace configuration file/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("expands cliIgnore patterns when prefixed with workspace path", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-expand-ignore-"));
      try {
        const dummyAnnotations = path.join(tempDir, "annotations.lua");
        fs.writeFileSync(dummyAnnotations, "-- dummy");

        const resolved = resolveWorkspaceConfig("packages/my-pkg", undefined, {
          annotationsPath: dummyAnnotations,
          ignore: ["packages/my-pkg/subfolder/**", "other/**"],
        });

        const writtenConfig = JSON.parse(
          fs.readFileSync(resolved.configPath, "utf-8"),
        ) as LuaRCConfig;
        expect(writtenConfig.files?.exclude).toContain("packages/my-pkg/subfolder/**");
        expect(writtenConfig.files?.exclude).toContain("subfolder/**");
        expect(writtenConfig.files?.exclude).toContain("other/**");

        fs.unlinkSync(resolved.configPath);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("handles initWorkspace default mode without vendoring annotations (#56)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-init-default-"));
      try {
        const created = initWorkspace(tempDir);
        expect(fs.existsSync(created)).toBe(true);
        expect(fs.existsSync(path.join(tempDir, ".nanos-lint"))).toBe(false);

        const config = JSON.parse(fs.readFileSync(created, "utf-8"));
        expect(config.workspace?.library).toEqual([]);

        expect(() => {
          initWorkspace(tempDir);
        }).toThrow(/\.luarc\.json already exists/);

        const overwritten = initWorkspace(tempDir, { force: true });
        expect(overwritten).toBe(created);

        const managedAnnotations = path.join(tempDir, "managed-cache", "annotations.lua");
        fs.mkdirSync(path.dirname(managedAnnotations), { recursive: true });
        fs.writeFileSync(managedAnnotations, "-- managed annotations");
        const resolved = resolveWorkspaceConfig(tempDir, undefined, {
          annotationsPath: managedAnnotations,
        });
        const merged = JSON.parse(fs.readFileSync(resolved.configPath, "utf-8"));
        // mergeConfigs normalizes library paths to forward slashes for LuaLS.
        expect(merged.workspace?.library).toContain(managedAnnotations.split(path.sep).join("/"));
        if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
          fs.unlinkSync(resolved.configPath);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects annotationsPath without explicit vendoring (#56)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-init-no-vendor-"));
      try {
        const dummyAnnotations = path.join(tempDir, "source-annotations.lua");
        fs.writeFileSync(dummyAnnotations, "-- dummy annotations");

        expect(() => {
          initWorkspace(tempDir, { annotationsPath: dummyAnnotations });
        }).toThrow(/requires --vendor/);
        // The flag combination is rejected before anything is written.
        expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, ".nanos-lint"))).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("handles initWorkspace explicit vendoring mode (#56)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-init-vendor-"));
      try {
        const dummyAnnotations = path.join(tempDir, "source-annotations.lua");
        fs.writeFileSync(dummyAnnotations, "-- dummy annotations");

        expect(() => {
          initWorkspace(tempDir, {
            vendor: true,
            annotationsPath: "/nonexistent/annotations.lua",
          });
        }).toThrow(/Definitions file not found/);

        const created = initWorkspace(tempDir, {
          vendor: true,
          annotationsPath: dummyAnnotations,
        });
        expect(fs.existsSync(created)).toBe(true);

        const config = JSON.parse(fs.readFileSync(created, "utf-8"));
        expect(config.workspace?.library).toEqual([".nanos-lint/annotations.lua"]);
        expect(fs.existsSync(path.join(tempDir, ".nanos-lint", "annotations.lua"))).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
