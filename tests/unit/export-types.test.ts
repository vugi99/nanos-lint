import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXPORT_TYPES_MANIFEST,
  EXPORT_TYPES_SCHEMA_VERSION,
  exportTypes,
  isDefinitionFile,
  isMetaDefinitionContent,
  type ExportTypesManifest,
} from "../../src/export-types.js";
import { ExportTypesError } from "../../src/errors.js";
import { logger } from "../../src/logger.js";

const tempDirs: string[] = [];

/** Creates an isolated scratch directory removed after the test. */
function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Writes fixture files described as `relativePath -> content` pairs. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
}

/** Reads the manifest written by an export run. */
function readManifest(destination: string): ExportTypesManifest {
  return JSON.parse(
    fs.readFileSync(path.join(destination, EXPORT_TYPES_MANIFEST), "utf-8"),
  ) as ExportTypesManifest;
}

/** Captures warnings emitted while the callback runs. */
async function captureWarnings(callback: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const spy = vi.spyOn(logger, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  try {
    await callback();
  } finally {
    spy.mockRestore();
  }
  return warnings;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("definition-file detection", () => {
  it("recognizes ---@meta as the first directive", () => {
    expect(isMetaDefinitionContent("---@meta\n")).toBe(true);
    expect(isMetaDefinitionContent("\uFEFF---@meta\n---@class X\nX = {}\n")).toBe(true);
    expect(isMetaDefinitionContent("#!lua\n-- header\n\n---@meta named\n")).toBe(true);
    expect(isMetaDefinitionContent("---  @meta\n")).toBe(true);
    expect(isMetaDefinitionContent("--[[ license\n * text\n]]\n---@meta\n")).toBe(true);
    expect(isMetaDefinitionContent("--[=[ license ]=]\n---@meta\n")).toBe(true);
    expect(isMetaDefinitionContent("--- Documentation line\n---@meta\n")).toBe(true);
  });

  it("rejects files whose first directive is not ---@meta", () => {
    expect(isMetaDefinitionContent("")).toBe(false);
    expect(isMetaDefinitionContent("---@class X\nX = {}\n")).toBe(false);
    expect(isMetaDefinitionContent("local x = 1\n---@meta\n")).toBe(false);
    expect(isMetaDefinitionContent("print('hello')\n")).toBe(false);
    expect(isMetaDefinitionContent("--[[ unterminated\n---@meta\n")).toBe(false);
    expect(isMetaDefinitionContent("---@class X\n---@meta\n")).toBe(false);
  });

  it("accepts .d.lua by suffix and meta files by content", () => {
    const root = makeTempDir("nanos-export-defs-");
    const suffixOnly = path.join(root, "api.d.lua");
    const metaFile = path.join(root, "meta.lua");
    const sourceFile = path.join(root, "source.lua");
    fs.writeFileSync(suffixOnly, "X = {}\n", "utf-8");
    fs.writeFileSync(metaFile, "-- header\n---@meta\nX = {}\n", "utf-8");
    fs.writeFileSync(sourceFile, "---@class X\nX = {}\n", "utf-8");

    expect(isDefinitionFile(suffixOnly)).toBe(true);
    expect(isDefinitionFile(metaFile)).toBe(true);
    expect(isDefinitionFile(sourceFile)).toBe(false);
    expect(isDefinitionFile(path.join(root, "README.md"))).toBe(false);
  });

  it("warns and skips a .lua file that cannot be read", () => {
    const root = makeTempDir("nanos-export-unreadable-");
    const file = path.join(root, "broken.lua");
    fs.writeFileSync(file, "---@meta\n", "utf-8");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    try {
      expect(isDefinitionFile(file)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    } finally {
      openSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("exportTypes discovery and manifest", () => {
  it("copies definitions, preserves realms and writes package metadata", async () => {
    const root = makeTempDir("nanos-export-basic-");
    writeTree(root, {
      "package.json": JSON.stringify({ name: "@scope/demo", version: "1.2.3" }),
      "root.d.lua": "---@meta\nRoot = {}\n",
      "Server/weapons.d.lua": "---@meta\nServerWeapon = {}\n",
      "Client/hud.lua": "-- header\n---@meta\nClientHud = {}\n",
      "Shared/events.d.lua": "---@meta\nSharedEvent = {}\n",
      "meta/legacy.lua": "---@meta\nLegacy = {}\n",
      "plain.lua": "---@class NotExported\nNotExported = {}\n",
      "node_modules/ignored/package.d.lua": "---@meta\nIgnored = {}\n",
    });

    const destination = path.join(root, "types");
    const result = await exportTypes({ root, destination: "types" });

    expect(result.destination).toBe(destination);
    expect(result.manifestPath).toBe(path.join(destination, EXPORT_TYPES_MANIFEST));
    for (const relative of [
      "root.d.lua",
      "Server/weapons.d.lua",
      "Client/hud.lua",
      "events.d.lua",
      "meta__legacy.lua",
    ]) {
      expect(fs.existsSync(path.join(destination, relative)), relative).toBe(true);
    }
    expect(fs.existsSync(path.join(destination, "plain.lua"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "Client/hud.lua"), "utf-8")).toBe(
      fs.readFileSync(path.join(root, "Client/hud.lua"), "utf-8"),
    );

    const manifest = readManifest(destination);
    expect(manifest.schemaVersion).toBe(EXPORT_TYPES_SCHEMA_VERSION);
    expect(manifest.generator.name).toBe("nanos-lint");
    expect(manifest.generator.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.package).toEqual({ name: "@scope/demo", version: "1.2.3" });
    expect(manifest.sourceCommit).toBeNull();
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    expect(manifest.includeDependencies).toBe(true);
    expect(manifest.withNanos).toBe(false);
    expect(manifest.files).toHaveLength(5);
    expect(manifest.files).toContainEqual({
      path: "Client/hud.lua",
      realm: "client",
      kind: "definition",
      source: "Client/hud.lua",
    });
    expect(manifest.files).toContainEqual({
      path: "Server/weapons.d.lua",
      realm: "server",
      kind: "definition",
      source: "Server/weapons.d.lua",
    });
    expect(manifest.files).toContainEqual({
      path: "events.d.lua",
      realm: "shared",
      kind: "definition",
      source: "Shared/events.d.lua",
    });
    expect(manifest.files).toContainEqual({
      path: "meta__legacy.lua",
      realm: "shared",
      kind: "definition",
      source: "meta/legacy.lua",
    });
    expect(manifest.files).toContainEqual({
      path: "root.d.lua",
      realm: "shared",
      kind: "definition",
      source: "root.d.lua",
    });
  });

  it("honours custom nanos.realms mappings", async () => {
    const root = makeTempDir("nanos-export-custom-realms-");
    writeTree(root, {
      ".luarc.json": JSON.stringify({
        nanos: {
          realms: {
            "src/server/**": "server",
            "src/client/**": "client",
            "common/**": "shared",
          },
        },
      }),
      "src/server/combat.d.lua": "---@meta\nServerCombat = {}\n",
      "src/client/hud.d.lua": "---@meta\nClientHud = {}\n",
      "common/util.d.lua": "---@meta\nCommonUtil = {}\n",
      "top.d.lua": "---@meta\nTop = {}\n",
    });

    const destination = path.join(root, "out");
    await exportTypes({ root, destination: "out" });

    expect(fs.existsSync(path.join(destination, "Server/src__server__combat.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "Client/src__client__hud.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "common__util.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "top.d.lua"))).toBe(true);
    expect(readManifest(destination).files.map((file) => file.path)).toContain(
      "Server/src__server__combat.d.lua",
    );
    expect(readManifest(destination).files.map((file) => file.path)).toContain(
      "Client/src__client__hud.d.lua",
    );
  });

  it("treats every definition as shared when nanos.realms is disabled", async () => {
    const root = makeTempDir("nanos-export-realms-disabled-");
    writeTree(root, {
      ".luarc.json": JSON.stringify({ nanos: { realms: {} } }),
      "Server/logic.d.lua": "---@meta\nLogic = {}\n",
      "root.d.lua": "---@meta\nRoot = {}\n",
    });

    const destination = path.join(root, "out");
    await exportTypes({ root, destination: "out" });

    expect(fs.existsSync(path.join(destination, "Server__logic.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "Shared"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "Server"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "root.d.lua"))).toBe(true);
  });

  it("writes an empty manifest and warns when no definitions exist", async () => {
    const root = makeTempDir("nanos-export-empty-");
    writeTree(root, { "main.lua": "print('hello')\n" });
    const destination = path.join(root, "out");

    const warnings = await captureWarnings(async () => {
      await exportTypes({ root, destination: "out" });
    });

    expect(warnings.join("\n")).toContain("No definition files");
    expect(readManifest(destination).files).toEqual([]);
  });

  it("defaults the destination to ./types", async () => {
    const root = makeTempDir("nanos-export-default-destination-");
    writeTree(root, { "api.d.lua": "---@meta\nApi = {}\n" });

    const result = await exportTypes({ root });

    expect(result.destination).toBe(path.join(root, "types"));
    expect(fs.existsSync(path.join(root, "types", "api.d.lua"))).toBe(true);
  });
});

describe("exportTypes dependency resolution", () => {
  it("includes transitive dependency definitions and breaks cycles", async () => {
    const base = makeTempDir("nanos-export-deps-");
    const root = path.join(base, "root");
    writeTree(base, {
      "root/.luarc.json": JSON.stringify({
        nanos: { deps: ["../dep-a", "../dep-empty", "../defs/shared.d.lua"] },
      }),
      "root/root.d.lua": "---@meta\nRoot = {}\n",
      "dep-a/package.json": JSON.stringify({ name: "@scope/dep-a" }),
      "dep-a/.luarc.json": JSON.stringify({ nanos: { deps: ["../dep-b"] } }),
      "dep-a/Server/server.d.lua": "---@meta\nDepServer = {}\n",
      "dep-a/Shared/api.d.lua": "---@meta\nDepApi = {}\n",
      "dep-b/package.json": JSON.stringify({ name: "dep-b" }),
      "dep-b/.luarc.json": JSON.stringify({ nanos: { deps: ["../dep-a"] } }),
      "dep-b/client.d.lua": "---@meta\nDepClient = {}\n",
      "dep-empty/plain.lua": "print('no definitions')\n",
      "defs/shared.d.lua": "---@meta\nSingleFile = {}\n",
    });

    const destination = path.join(root, "types");
    const warnings = await captureWarnings(async () => {
      await exportTypes({ root, destination: "types" });
    });

    expect(fs.existsSync(path.join(destination, "Shared/deps/scope-dep-a/api.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "Server/deps/scope-dep-a/server.d.lua"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(destination, "Shared/deps/dep-b/client.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "Shared/deps/shared/shared.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "root.d.lua"))).toBe(true);
    expect(warnings.join("\n")).toContain('"dep-empty"');
    expect(warnings.join("\n")).toContain("has no definition files");

    const manifest = readManifest(destination);
    const dependencyFiles = manifest.files.filter((file) => file.path.includes("/deps/"));
    expect(dependencyFiles.map((file) => file.realm).sort()).toEqual([
      "server",
      "shared",
      "shared",
      "shared",
    ]);
    expect(dependencyFiles.map((file) => file.source)).toContain("../dep-a/Server/server.d.lua");
  });

  it("writes dependency source paths relative to the canonical package root", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-export-canonical-"));
    tempDirs.push(base);
    writeTree(base, {
      "root/.luarc.json": JSON.stringify({ nanos: { deps: ["../dep"] } }),
      "root/api.d.lua": "---@meta\nApi = {}\n",
      "dep/api.d.lua": "---@meta\nDep = {}\n",
    });

    const result = await exportTypes({ root: path.join(base, "root"), destination: "types" });

    const dependency = result.manifest.files.find((file) => file.path.includes("/deps/"));
    expect(dependency?.source).toBe("../dep/api.d.lua");
  });

  it("resolves dependencies through a custom --config file", async () => {
    const base = makeTempDir("nanos-export-custom-config-");
    const root = path.join(base, "root");
    writeTree(base, {
      "root/api.d.lua": "---@meta\nApi = {}\n",
      "config.json": JSON.stringify({ nanos: { deps: ["../dep"] } }),
      "dep/dep.d.lua": "---@meta\nDep = {}\n",
    });

    await exportTypes({ root, destination: "types", configPath: path.join(base, "config.json") });

    expect(fs.existsSync(path.join(root, "types/Shared/deps/dep/dep.d.lua"))).toBe(true);
  });

  it("omits dependency definitions with --no-deps", async () => {
    const base = makeTempDir("nanos-export-no-deps-");
    const root = path.join(base, "root");
    writeTree(base, {
      "root/.luarc.json": JSON.stringify({ nanos: { deps: ["../dep-a"] } }),
      "root/root.d.lua": "---@meta\nRoot = {}\n",
      "dep-a/api.d.lua": "---@meta\nDepApi = {}\n",
    });

    const destination = path.join(root, "types");
    const result = await exportTypes({ root, destination: "types", dependencies: false });

    expect(fs.existsSync(path.join(destination, "Shared"))).toBe(false);
    expect(result.manifest.files.map((file) => file.path)).toEqual(["root.d.lua"]);
    expect(result.manifest.includeDependencies).toBe(false);
  });

  it("warns about missing dependency paths and continues", async () => {
    const root = makeTempDir("nanos-export-missing-dep-");
    writeTree(root, {
      ".luarc.json": JSON.stringify({ nanos: { deps: ["../does-not-exist"] } }),
      "root.d.lua": "---@meta\nRoot = {}\n",
    });

    const warnings = await captureWarnings(async () => {
      await exportTypes({ root, destination: "types" });
    });

    expect(warnings.join("\n")).toContain("Dependency path not found");
    expect(fs.existsSync(path.join(root, "types", "root.d.lua"))).toBe(true);
  });

  it("disambiguates dependencies whose names collide", async () => {
    const base = makeTempDir("nanos-export-dependency-names-");
    const root = path.join(base, "root");
    writeTree(base, {
      "root/.luarc.json": JSON.stringify({
        nanos: { deps: ["../one/dep", "../two/dep"] },
      }),
      "one/dep/api.d.lua": "---@meta\nOne = {}\n",
      "two/dep/api.d.lua": "---@meta\nTwo = {}\n",
    });

    await exportTypes({ root, destination: "types" });

    expect(fs.existsSync(path.join(root, "types/Shared/deps/dep/api.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(root, "types/Shared/deps/dep-2/api.d.lua"))).toBe(true);
  });
});

describe("exportTypes overwrite and failure safety", () => {
  it("refuses to overwrite a non-empty destination without force", async () => {
    const root = makeTempDir("nanos-export-existing-");
    writeTree(root, {
      "api.d.lua": "---@meta\nApi = {}\n",
      "types/stale.txt": "stale\n",
    });

    await expect(exportTypes({ root, destination: "types" })).rejects.toMatchObject({
      code: "ERR_EXPORT_TYPES_EXISTS",
    });
    expect(fs.existsSync(path.join(root, "types", "stale.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "types", "api.d.lua"))).toBe(false);
  });

  it("allows an empty destination and replaces it with --force", async () => {
    const root = makeTempDir("nanos-export-force-");
    writeTree(root, {
      "api.d.lua": "---@meta\nApi = {}\n",
      "types/stale.txt": "stale\n",
    });
    fs.mkdirSync(path.join(root, "empty"));

    await exportTypes({ root, destination: "empty" });
    expect(fs.existsSync(path.join(root, "empty", "api.d.lua"))).toBe(true);

    await exportTypes({ root, destination: "types", force: true });
    expect(fs.existsSync(path.join(root, "types", "api.d.lua"))).toBe(true);
    expect(fs.existsSync(path.join(root, "types", "stale.txt"))).toBe(false);
  });

  it("refuses and then replaces a destination that is a file", async () => {
    const root = makeTempDir("nanos-export-file-destination-");
    writeTree(root, {
      "api.d.lua": "---@meta\nApi = {}\n",
      types: "not a directory\n",
    });

    await expect(exportTypes({ root, destination: "types" })).rejects.toMatchObject({
      code: "ERR_EXPORT_TYPES_EXISTS",
    });
    await exportTypes({ root, destination: "types", force: true });
    expect(fs.statSync(path.join(root, "types")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, "types", "api.d.lua"))).toBe(true);
  });

  it("restores the previous bundle when the final rename fails", async () => {
    const root = makeTempDir("nanos-export-commit-failure-");
    writeTree(root, {
      "api.d.lua": "---@meta\nApi = {}\n",
      "types/marker.txt": "keep\n",
    });
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(oldPath).includes(".nanos-lint-tmp-")) {
        throw new Error("rename failed");
      }
      realRename(oldPath, newPath);
    });
    try {
      await expect(exportTypes({ root, destination: "types", force: true })).rejects.toThrow(
        "rename failed",
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(root, "types", "marker.txt"), "utf-8")).toBe("keep\n");
    expect(fs.readdirSync(root).filter((entry) => entry.includes(".nanos-lint-"))).toEqual([]);
  });

  it("leaves the previous bundle intact when staging fails", async () => {
    const root = makeTempDir("nanos-export-staging-failure-");
    writeTree(root, {
      "api.d.lua": "---@meta\nApi = {}\n",
      "types/marker.txt": "keep\n",
    });
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      await expect(exportTypes({ root, destination: "types", force: true })).rejects.toThrow(
        "disk full",
      );
    } finally {
      copySpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(root, "types", "marker.txt"), "utf-8")).toBe("keep\n");
    const leftovers = fs.readdirSync(root).filter((entry) => entry.includes(".nanos-lint-"));
    expect(leftovers).toEqual([]);
  });

  it("rejects the package root and invalid options", async () => {
    const root = makeTempDir("nanos-export-invalid-");
    fs.writeFileSync(path.join(root, "api.d.lua"), "---@meta\nApi = {}\n", "utf-8");

    await expect(exportTypes({ root, destination: "." })).rejects.toMatchObject({
      code: "ERR_EXPORT_TYPES_DESTINATION",
    });
    await expect(
      exportTypes({ root, destination: "types", annotationsPath: "custom.lua" }),
    ).rejects.toMatchObject({ code: "ERR_EXPORT_TYPES_ANNOTATIONS" });
    await expect(exportTypes({ root: path.join(root, "missing") })).rejects.toMatchObject({
      code: "ERR_EXPORT_TYPES_ROOT",
    });
  });

  it("rejects output paths claimed by two source files", async () => {
    const root = makeTempDir("nanos-export-collision-");
    writeTree(root, {
      "src/shared/foo.d.lua": "---@meta\nOne = {}\n",
      "Shared/src/shared/foo.d.lua": "---@meta\nTwo = {}\n",
    });

    await expect(exportTypes({ root, destination: "types" })).rejects.toBeInstanceOf(
      ExportTypesError,
    );
    await expect(exportTypes({ root, destination: "types" })).rejects.toMatchObject({
      code: "ERR_EXPORT_TYPES_COLLISION",
    });
    expect(fs.existsSync(path.join(root, "types"))).toBe(false);
  });
});

const ANNOTATIONS_FIXTURE = [
  "---@meta",
  "",
  '---<img src="https://example.test/assets/both.png">',
  "---@class Package",
  "Package = {}",
  "",
  '---<img src="https://example.test/assets/client-only.png">',
  "---@class Client",
  "Client = {}",
  "",
  "function Client.GetLocalPlayer() end",
  "",
  '---<img src="https://example.test/assets/server-only.png">',
  "---@class Server",
  "Server = {}",
  "",
  "function Server.ChangeMap(path) end",
  "",
].join("\n");

describe("exportTypes --with-nanos", () => {
  it("bundles the full annotations at the root when no realm split is needed", async () => {
    const root = makeTempDir("nanos-export-with-nanos-");
    const annotations = path.join(root, "custom-annotations.lua");
    writeTree(root, { "api.d.lua": "---@meta\nApi = {}\n" });
    fs.writeFileSync(annotations, ANNOTATIONS_FIXTURE, "utf-8");
    const destination = path.join(root, "types");

    const result = await exportTypes({
      root,
      destination: "types",
      withNanos: true,
      annotationsPath: annotations,
    });

    expect(fs.readFileSync(path.join(destination, "annotations.d.lua"), "utf-8")).toBe(
      ANNOTATIONS_FIXTURE,
    );
    expect(fs.existsSync(path.join(destination, "Server"))).toBe(false);
    expect(result.manifest.withNanos).toBe(true);
    expect(result.manifest.files).toContainEqual({
      path: "annotations.d.lua",
      realm: "shared",
      kind: "nanos-annotations",
      source: "custom-annotations.lua",
    });
  });

  it("derives realm-specific annotations when package definitions are realm-aware", async () => {
    const root = makeTempDir("nanos-export-with-nanos-realms-");
    const annotations = path.join(root, "custom-annotations.lua");
    writeTree(root, {
      "Server/api.d.lua": "---@meta\nApi = {}\n",
      "Client/hud.d.lua": "---@meta\nHud = {}\n",
    });
    fs.writeFileSync(annotations, ANNOTATIONS_FIXTURE, "utf-8");
    const destination = path.join(root, "types");

    const result = await exportTypes({
      root,
      destination: "types",
      withNanos: true,
      annotationsPath: annotations,
    });

    expect(fs.existsSync(path.join(destination, "annotations.d.lua"))).toBe(false);
    const server = fs.readFileSync(path.join(destination, "Server/annotations.d.lua"), "utf-8");
    const client = fs.readFileSync(path.join(destination, "Client/annotations.d.lua"), "utf-8");
    expect(server).toContain("function Server.ChangeMap(path) end");
    expect(server).not.toContain("function Client.GetLocalPlayer() end");
    expect(client).toContain("function Client.GetLocalPlayer() end");
    expect(client).not.toContain("function Server.ChangeMap(path) end");
    expect(result.manifest.files.filter((file) => file.kind === "nanos-annotations")).toEqual([
      {
        path: "Client/annotations.d.lua",
        realm: "client",
        kind: "nanos-annotations",
        source: "custom-annotations.lua",
      },
      {
        path: "Server/annotations.d.lua",
        realm: "server",
        kind: "nanos-annotations",
        source: "custom-annotations.lua",
      },
    ]);
  });
});
