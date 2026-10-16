import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultTemplatePath, loadUserConfig } from "../../src/config.js";
import type { RealmMapping } from "../../src/config.js";
import {
  collectRealmFiles,
  deriveRealmAnnotationFiles,
  planRealmCheck,
  splitAnnotationsByRealm,
} from "../../src/realms.js";
import { logger } from "../../src/logger.js";

const MARKER = (image: string): string =>
  `---<img src="https://raw.github.com/nanos-world/vscode-extension/master/assets/${image}.png" height="21">`;

/** Synthetic upstream-shaped annotations covering every marker and inheritance path. */
const ANNOTATIONS_FIXTURE = [
  "---@meta",
  "",
  MARKER("both"),
  "---@class Package",
  "Package = {}",
  "",
  MARKER("both"),
  "function Package.Require(file_path) end",
  "",
  MARKER("client-only"),
  "---@class Client",
  "Client = {}",
  "",
  MARKER("client-only"),
  "function Client.GetLocalPlayer() end",
  "",
  "---Subscribe to an event",
  "function Client.Subscribe(event_name, callback) end",
  "",
  MARKER("server-only"),
  "---@class Server",
  "Server = {}",
  "",
  MARKER("server-only"),
  "function Server.ChangeMap(map_path) end",
  "",
  MARKER("server-only"),
  "---@class Weapon",
  "---@field Super Weapon",
  "Weapon = {}",
  "",
  MARKER("server-only"),
  "function Weapon:Constructor(asset) end",
  "",
  MARKER("both"),
  "function Weapon:GetAmmoClip() end",
  "",
  MARKER("network-authority"),
  "function Weapon:SetAmmoClip(ammo) end",
  "",
  "AimMode = {",
  "    None = 0,",
  "}",
  "",
].join("\n");

const tempDirs: string[] = [];

/** Creates an isolated scratch directory removed after the test. */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});

describe("realm annotation splitting (#15)", () => {
  const split = splitAnnotationsByRealm(ANNOTATIONS_FIXTURE);
  const clientLines = split.client.split("\n");
  const serverLines = split.server.split("\n");

  it("keeps shared and authority declarations in both realms", () => {
    for (const declaration of [
      "function Package.Require(file_path) end",
      "function Weapon:GetAmmoClip() end",
      "function Weapon:SetAmmoClip(ammo) end",
      "AimMode = {",
    ]) {
      expect(clientLines).toContain(declaration);
      expect(serverLines).toContain(declaration);
    }
  });

  it("drops obsolete client declarations from the server realm", () => {
    expect(clientLines).toContain("function Client.GetLocalPlayer() end");
    expect(clientLines).toContain("Client = {}");
    for (const line of serverLines) {
      expect(line.startsWith("Client = {}")).toBe(false);
      expect(line.startsWith("function Client.")).toBe(false);
    }
  });

  it("drops server-only classes and members from the client realm", () => {
    expect(serverLines).toContain("function Server.ChangeMap(map_path) end");
    expect(serverLines).toContain("function Weapon:Constructor(asset) end");
    for (const line of clientLines) {
      expect(line.startsWith("Server = {}")).toBe(false);
      expect(line.startsWith("function Server.")).toBe(false);
      expect(line.startsWith("function Weapon:Constructor")).toBe(false);
    }
  });

  it("resolves unmarked members through their class realm, like Client.Subscribe", () => {
    const clientSubscribe = clientLines.filter((line) => line.startsWith("function Client."));
    expect(clientSubscribe).toContain("function Client.Subscribe(event_name, callback) end");
    expect(serverLines.some((line) => line.includes("Client.Subscribe"))).toBe(false);
  });

  it("keeps unmarked enum tables in both realms", () => {
    expect(clientLines).toContain("    None = 0,");
    expect(serverLines).toContain("    None = 0,");
  });

  it("treats an annotations file without side markers as fully shared", () => {
    const plain = "---@meta\n\n---@class Plain\nPlain = {}\n";
    const plainSplit = splitAnnotationsByRealm(plain);
    expect(plainSplit.client).toBe(plainSplit.server);
    expect(plainSplit.client).toContain("Plain = {}");
  });
});

describe("realm annotations cache (#15)", () => {
  it("derives realm files once and reuses them for the same source revision", () => {
    const root = makeTempDir("nanos-realm-annotations-");
    const source = path.join(root, "annotations.lua");
    fs.writeFileSync(source, ANNOTATIONS_FIXTURE, "utf-8");
    const cacheDir = path.join(root, "derived");

    const first = deriveRealmAnnotationFiles(source, cacheDir);
    expect(fs.existsSync(first.client)).toBe(true);
    expect(fs.existsSync(first.server)).toBe(true);
    const stamp = fs.statSync(first.client).mtimeMs;

    const second = deriveRealmAnnotationFiles(source, cacheDir);
    expect(second).toEqual(first);
    expect(fs.statSync(second.client).mtimeMs).toBe(stamp);
  });

  it("keeps realm files out of the way of later readers when the source grows", () => {
    const root = makeTempDir("nanos-realm-annotations-changed-");
    const source = path.join(root, "annotations.lua");
    fs.writeFileSync(source, "-- custom annotations without markers\n".repeat(60), "utf-8");
    const first = deriveRealmAnnotationFiles(source);
    expect(fs.existsSync(first.client)).toBe(true);

    fs.writeFileSync(
      source,
      `${"-- custom annotations without markers\n".repeat(60)}-- trailing addition\n`,
      "utf-8",
    );
    const second = deriveRealmAnnotationFiles(source);
    expect(second.client).not.toBe(first.client);
    expect(fs.existsSync(second.client)).toBe(true);
  });
});

describe("realm derivation progress (#50)", () => {
  it("reports parse progress while splitting a multi-megabyte annotations file", () => {
    const lines = ["---@meta", ""];
    for (let index = 0; index < 900; index++) {
      lines.push(MARKER("both"), "---@class Shared", `Shared${index} = {}`, "");
      lines.push(MARKER("client-only"), `function Shared${index}:Only() end`, "");
    }

    let ticks = 0;
    const split = splitAnnotationsByRealm(lines.join("\n"), () => {
      ticks += 1;
    });

    expect(ticks).toBeGreaterThan(1);
    expect(split.client).toContain("Shared0 = {}");
    expect(split.client).toContain("function Shared0:Only() end");
    expect(split.server).not.toContain("function Shared0:Only() end");
  });

  it("logs the derivation start and completion without dynamic redraws", () => {
    const root = makeTempDir("nanos-realm-progress-");
    const source = path.join(root, "annotations.lua");
    fs.writeFileSync(source, ANNOTATIONS_FIXTURE, "utf-8");

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    logger.setLevel("info");
    try {
      deriveRealmAnnotationFiles(source, path.join(root, "derived"));
      expect(
        logged.some((line) => line.startsWith("[realms] Deriving client/server annotations")),
      ).toBe(true);
      expect(
        logged.some((line) => /^\[realms\] Derived client\/server annotations in /.test(line)),
      ).toBe(true);
      for (const line of logged) {
        expect(line).not.toContain("\r");
        expect(line).not.toContain("\u001b");
      }
    } finally {
      logger.setLevel("warn");
      logSpy.mockRestore();
    }
  });

  it("skips the progress display when the derived files are already cached", () => {
    const root = makeTempDir("nanos-realm-progress-cached-");
    const source = path.join(root, "annotations.lua");
    fs.writeFileSync(source, ANNOTATIONS_FIXTURE, "utf-8");
    const cacheDir = path.join(root, "derived");
    deriveRealmAnnotationFiles(source, cacheDir);

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    logger.setLevel("info");
    try {
      deriveRealmAnnotationFiles(source, cacheDir);
      expect(logged).toEqual([]);
    } finally {
      logger.setLevel("warn");
      logSpy.mockRestore();
    }
  });
});

describe("realm file assignment (#35)", () => {
  it("assigns files by pattern and lets the last matching entry win", () => {
    const root = makeTempDir("nanos-realm-files-");
    writeTree(root, {
      "Server/a.lua": "-- s",
      "Client/b.lua": "-- c",
      "Shared/c.lua": "-- sh",
      "main.lua": "-- root",
      "docs/readme.txt": "not lua",
    });
    const mappings: RealmMapping[] = [
      { pattern: "Server/**", realm: "shared" },
      { pattern: "Server/**", realm: "server" },
      { pattern: "Client/**", realm: "client" },
      { pattern: "Shared/**", realm: "shared" },
    ];
    const checked = ["Server/a.lua", "Client/b.lua", "Shared/c.lua", "main.lua"];

    const sets = collectRealmFiles(root, mappings, checked);

    expect(sets.server).toEqual(["Server/a.lua"]);
    expect(sets.client).toEqual(["Client/b.lua"]);
    expect(sets.shared).toEqual(["Shared/c.lua"]);
    expect(sets.unmatched).toEqual(["main.lua"]);
  });

  it("skips patterns that cannot be expanded", () => {
    const root = makeTempDir("nanos-realm-bad-pattern-");
    writeTree(root, { "Server/a.lua": "-- s" });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const sets = collectRealmFiles(
        root,
        [{ pattern: "a".repeat(70_000), realm: "server" }],
        ["Server/a.lua"],
      );
      expect(sets.server).toEqual([]);
      expect(sets.unmatched).toEqual(["Server/a.lua"]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping nanos.realms"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("realm check planning (#15)", () => {
  it("returns null for a single-file target", () => {
    const root = makeTempDir("nanos-realm-plan-file-");
    writeTree(root, { "Server/a.lua": "-- s" });
    const plan = planRealmCheck({
      targetPath: path.join(root, "Server", "a.lua"),
      userConfig: {},
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });
    expect(plan).toBeNull();
  });

  it("returns null when no configured pattern matches a checked file", () => {
    const root = makeTempDir("nanos-realm-plan-empty-");
    writeTree(root, { "lib/util.lua": "-- util" });
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: {},
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });
    expect(plan).toBeNull();
  });

  it("returns null when realms are explicitly disabled", () => {
    const root = makeTempDir("nanos-realm-plan-disabled-");
    writeTree(root, { "Server/a.lua": "-- s" });
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: { nanos: { realms: {} } },
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });
    expect(plan).toBeNull();
  });

  it("builds the selected passes with temporary configs that cleanup removes", () => {
    const root = makeTempDir("nanos-realm-plan-passes-");
    writeTree(root, {
      "Server/a.lua": "-- s",
      "Client/b.lua": "-- c",
      "Shared/c.lua": "-- sh",
      "annotations.lua": ANNOTATIONS_FIXTURE,
    });
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: {},
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });

    expect(plan).not.toBeNull();
    expect(plan!.passes.map((pass) => pass.realm)).toEqual(["server", "client", "shared"]);
    const serverPass = plan!.passes[0]!;
    const serverConfig = JSON.parse(fs.readFileSync(serverPass.configPath, "utf-8")) as {
      runtime: { path: string[] };
      workspace: { library: string[] };
      files: { exclude: string[] };
    };
    expect(serverConfig.workspace.library[0]).toContain("annotations.server.lua");
    expect(serverConfig.files.exclude).toContain("Client/**");
    expect(serverConfig.files.exclude).not.toContain("Shared/**");
    expect(serverConfig.runtime.path).toEqual([
      "Server/?",
      "Server/?.lua",
      "Shared/?",
      "Shared/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);

    const clientPass = plan!.passes[1]!;
    const clientConfig = JSON.parse(fs.readFileSync(clientPass.configPath, "utf-8")) as {
      runtime: { path: string[] };
    };
    expect(clientConfig.runtime.path).toEqual([
      "Client/?",
      "Client/?.lua",
      "Shared/?",
      "Shared/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);

    const sharedPass = plan!.passes[2]!;
    const sharedConfig = JSON.parse(fs.readFileSync(sharedPass.configPath, "utf-8")) as {
      runtime: { path: string[] };
      workspace: { library: string[] };
      files: { exclude: string[] };
    };
    expect(sharedConfig.workspace.library[0]).toBe(path.join(root, "annotations.lua"));
    expect(sharedConfig.files.exclude).not.toContain("Client/**");
    expect(sharedConfig.runtime.path).toEqual([
      "Shared/?",
      "Shared/?.lua",
      "Server/?",
      "Server/?.lua",
      "Client/?",
      "Client/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);

    const configPaths = [plan!.baseConfigPath, ...plan!.passes.map((pass) => pass.configPath)];
    plan!.cleanup();
    for (const configPath of configPaths) {
      expect(fs.existsSync(configPath)).toBe(false);
    }
  });

  it("keeps the realm-aware order when the workspace declares the bundled default paths (#79)", () => {
    const root = makeTempDir("nanos-realm-plan-default-paths-");
    writeTree(root, {
      "Server/a.lua": "-- s",
      "Client/b.lua": "-- c",
      "Shared/c.lua": "-- sh",
      "annotations.lua": ANNOTATIONS_FIXTURE,
    });
    // `nanos-lint init` scaffolds the bundled template verbatim, so the declared list is
    // behaviorally identical to declaring nothing at all.
    fs.copyFileSync(getDefaultTemplatePath(), path.join(root, ".luarc.json"));
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: loadUserConfig(root),
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });

    expect(plan).not.toBeNull();
    const pathsOf = (index: number): string[] =>
      (
        JSON.parse(fs.readFileSync(plan!.passes[index]!.configPath, "utf-8")) as {
          runtime: { path: string[] };
        }
      ).runtime.path;

    expect(pathsOf(0)).toEqual([
      "Server/?",
      "Server/?.lua",
      "Shared/?",
      "Shared/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);
    expect(pathsOf(2)).toEqual([
      "Shared/?",
      "Shared/?.lua",
      "Server/?",
      "Server/?.lua",
      "Client/?",
      "Client/?.lua",
      "?",
      "?.lua",
      "Packages/?",
      "Packages/?.lua",
    ]);
    plan!.cleanup();
  });

  it("leaves a genuinely custom runtime.path untouched in every pass (#79)", () => {
    const root = makeTempDir("nanos-realm-plan-custom-paths-");
    writeTree(root, {
      "Server/a.lua": "-- s",
      "Client/b.lua": "-- c",
      "Shared/c.lua": "-- sh",
      "annotations.lua": ANNOTATIONS_FIXTURE,
    });
    fs.writeFileSync(
      path.join(root, ".luarc.json"),
      JSON.stringify({ runtime: { path: ["Custom/?"] } }),
    );
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: loadUserConfig(root),
      selection: "all",
      annotationsPath: path.join(root, "annotations.lua"),
    });

    expect(plan).not.toBeNull();
    for (const pass of plan!.passes) {
      const config = JSON.parse(fs.readFileSync(pass.configPath, "utf-8")) as {
        runtime: { path: string[] };
      };
      expect(config.runtime.path).toEqual(["Custom/?"]);
    }
    plan!.cleanup();
  });

  it("restricts the selection to the requested side plus the shared pass", () => {
    const root = makeTempDir("nanos-realm-plan-selection-");
    writeTree(root, {
      "Server/a.lua": "-- s",
      "Client/b.lua": "-- c",
      "Shared/c.lua": "-- sh",
      "annotations.lua": ANNOTATIONS_FIXTURE,
    });
    const plan = planRealmCheck({
      targetPath: root,
      userConfig: {},
      selection: "client",
      annotationsPath: path.join(root, "annotations.lua"),
    });
    try {
      expect(plan!.passes.map((pass) => pass.realm)).toEqual(["shared", "client"]);
    } finally {
      plan!.cleanup();
    }
  });

  it("warns and falls back to single pass when requested realm matches no files", () => {
    const root = makeTempDir("nanos-realm-plan-nomatch-");
    writeTree(root, {
      "Server/a.lua": "-- s",
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const plan = planRealmCheck({
        targetPath: root,
        userConfig: {},
        selection: "client",
        annotationsPath: path.join(root, "annotations.lua"),
      });
      expect(plan).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No target files match the requested realm "client"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
