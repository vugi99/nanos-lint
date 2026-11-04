import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { resolveRealmMappings } from "./config.js";
import { collectRealmFiles } from "./realms.js";
import { logger } from "./logger.js";
import type { ResolvedDependencyRealms } from "./deps.js";
import type { LuaRCConfig } from "./types.js";

const META_SNIFF_BYTES = 16 * 1024;
const IGNORED_DIRECTORY_GLOBS = ["**/.git/**", "**/.nanos-lint/**", "**/node_modules/**"];

/** Realm a bundled definition is visible in, mirroring nanos world's VM split. */
export type ExportDefinitionRealm = "server" | "client" | "shared";

/** Where a bundled file came from: a package definition or the managed nanos annotations. */
export type ExportDefinitionKind = "definition" | "nanos-annotations";

/** One file in the exported bundle, relative to the destination root. */
export interface ExportedTypeFile {
  /** Forward-slash path inside the exported directory. */
  path: string;
  realm: ExportDefinitionRealm;
  kind: ExportDefinitionKind;
  /** Source path relative to the package root (or the resolved annotations path). */
  source: string;
}

/** A planned output file together with the absolute source it is copied from. */
export interface PlannedTypeFile extends ExportedTypeFile {
  absoluteSource: string;
}

export interface DependencyWithoutDefinitions {
  /** Package name from package.json, or the directory/file name as a fallback. */
  name: string;
  path: string;
}

export interface DependencyPlan {
  files: PlannedTypeFile[];
  /** Dependency roots that contain no definition files. */
  withoutDefinitions: DependencyWithoutDefinitions[];
}

interface DefinitionSource {
  absolute: string;
  relative: string;
}

/** Normalizes a filesystem path to forward slashes for manifest and library portability. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Reads at most the first {@link META_SNIFF_BYTES} of a Lua file. */
function readFilePrefix(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(META_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf-8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Recognizes the documented definition-file marker: the first non-comment directive is
 * `---@meta`. Blank lines, shebangs, line comments, block comments and plain `---`
 * documentation lines are skipped; any other annotation or executable statement before it
 * makes the file ordinary source.
 */
export function isMetaDefinitionContent(source: string): boolean {
  let rest = source.replace(/^\uFEFF/, "");
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest === "") {
      return false;
    }
    if (rest.startsWith("#!")) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        return false;
      }
      rest = rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith("---")) {
      const newline = rest.indexOf("\n");
      const line = (newline < 0 ? rest : rest.slice(0, newline)).trimEnd();
      if (/^---\s*@meta(?:\s|$)/.test(line)) {
        return true;
      }
      if (/^---\s*@[A-Za-z]/.test(line)) {
        return false;
      }
      if (newline < 0) {
        return false;
      }
      rest = rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith("--")) {
      const longComment = /^--\[(=*)\[/.exec(rest);
      if (longComment) {
        const closing = `]${"=".repeat(longComment[1]!.length)}]`;
        const closingAt = rest.indexOf(closing, longComment[0].length);
        if (closingAt < 0) {
          return false;
        }
        rest = rest.slice(closingAt + closing.length);
        continue;
      }
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        return false;
      }
      rest = rest.slice(newline + 1);
      continue;
    }
    return false;
  }
  return false;
}

/** Returns whether a file is a definition file by suffix or by its `---@meta` marker. */
export function isDefinitionFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".d.lua")) {
    return true;
  }
  if (!lower.endsWith(".lua")) {
    return false;
  }
  try {
    return isMetaDefinitionContent(readFilePrefix(filePath));
  } catch (err) {
    logger.warn(
      `[export-types] Could not read ${filePath} while detecting ---@meta: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Discovers definition files below a root, excluding ignored and generated directories. */
function discoverDefinitions(root: string, excludedRoots: string[] = []): DefinitionSource[] {
  const ignored = [...IGNORED_DIRECTORY_GLOBS];
  for (const excluded of excludedRoots) {
    const relative = toPosix(path.relative(root, path.resolve(excluded)));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      ignored.push(relative, `${relative}/**`);
    }
  }
  const files = globSync("**/*.lua", {
    cwd: root,
    dot: false,
    nodir: true,
    follow: false,
    ignore: ignored,
  });
  return files
    .map((relative) => ({
      absolute: path.join(root, relative),
      relative: toPosix(relative),
    }))
    .filter((candidate) => isDefinitionFile(candidate.absolute))
    .sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Maps each package definition file to the realm its `nanos.realms` entry assigns. */
function classifyOwnDefinitions(
  root: string,
  userConfig: LuaRCConfig,
  definitions: DefinitionSource[],
): Map<string, ExportDefinitionRealm> {
  const realms = new Map<string, ExportDefinitionRealm>();
  const { enabled, mappings } = resolveRealmMappings(userConfig);
  if (!enabled || definitions.length === 0) {
    for (const definition of definitions) {
      realms.set(definition.relative, "shared");
    }
    return realms;
  }
  const sets = collectRealmFiles(
    root,
    mappings,
    definitions.map((definition) => definition.relative),
  );
  for (const definition of definitions) {
    realms.set(
      definition.relative,
      sets.server.includes(definition.relative)
        ? "server"
        : sets.client.includes(definition.relative)
          ? "client"
          : "shared",
    );
  }
  return realms;
}

/** Returns the canonical output folder for a realm. */
function realmFolder(realm: ExportDefinitionRealm): string {
  return realm === "server" ? "Server" : realm === "client" ? "Client" : "Shared";
}

/** Removes a conventional `Server/`, `Client/` or `Shared/` prefix from a source path. */
function stripRealmPrefix(relative: string, realm: ExportDefinitionRealm): string {
  const segments = relative.split("/");
  if (segments.length > 1 && segments[0]!.toLowerCase() === realm) {
    return segments.slice(1).join("/");
  }
  return relative;
}

/**
 * Flattens a relative definition path into a single file name. Nested directories must not
 * survive into the bundle: downstream configurations ignore directory names such as `meta`,
 * `vendor` or `dist` anywhere in a library, which would silently hide exported definitions.
 */
function flattenDefinitionPath(relative: string): string {
  return relative.split("/").filter(Boolean).join("__");
}

/** Maps a package definition to a bundle path; shared definitions live at the root. */
function packageOutputPath(relative: string, realm: ExportDefinitionRealm): string {
  const flattened = flattenDefinitionPath(stripRealmPrefix(relative, realm));
  return realm === "shared" ? flattened : `${realmFolder(realm)}/${flattened}`;
}

/** Maps a dependency definition into its namespace under the matching realm folder. */
function dependencyOutputPath(
  relative: string,
  realm: ExportDefinitionRealm,
  namespace: string,
): string {
  const flattened = flattenDefinitionPath(stripRealmPrefix(relative, realm));
  return `${realmFolder(realm)}/deps/${namespace}/${flattened}`;
}

/** Returns whether a resolved dependency library entry contains a file. */
function entryContains(entry: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(entry), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Classifies a dependency definition by the realm partitions resolved for it. */
function classifyDependencyDefinition(
  resolved: ResolvedDependencyRealms,
  filePath: string,
): ExportDefinitionRealm | null {
  const server = resolved.server.some((entry) => entryContains(entry, filePath));
  const client = resolved.client.some((entry) => entryContains(entry, filePath));
  const shared = resolved.shared.some((entry) => entryContains(entry, filePath));
  if (server && client) {
    return "shared";
  }
  if (server) {
    return "server";
  }
  if (client) {
    return "client";
  }
  return shared ? "shared" : null;
}

/** Derives a readable namespace from a dependency directory or definition file. */
function dependencyDisplayName(packagePath: string, isFile: boolean): string {
  if (!isFile) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packagePath, "package.json"), "utf-8"),
      ) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.trim()) {
        return manifest.name.trim();
      }
    } catch (err) {
      logger.debug(
        `[export-types] No usable package.json in ${packagePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const base = path.basename(packagePath);
  return isFile ? base.replace(/\.d\.lua$/i, "").replace(/\.lua$/i, "") : base;
}

/** Reduces a package name to a portable directory name. */
function sanitizeNamespace(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "dependency";
}

/** Allocates a unique, case-insensitive namespace for a dependency package. */
function allocateNamespace(name: string, used: Set<string>): string {
  const base = sanitizeNamespace(name);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Plans the definition files of the package itself. */
export function planOwnDefinitions(
  root: string,
  userConfig: LuaRCConfig,
  excludedRoots: string[] = [],
): PlannedTypeFile[] {
  const definitions = discoverDefinitions(root, excludedRoots);
  const realms = classifyOwnDefinitions(root, userConfig, definitions);
  return definitions.map((definition) => {
    const realm = realms.get(definition.relative) ?? "shared";
    return {
      path: packageOutputPath(definition.relative, realm),
      realm,
      kind: "definition",
      source: definition.relative,
      absoluteSource: definition.absolute,
    };
  });
}

/** Plans the definition files of every resolved transitive dependency. */
export function planDependencyDefinitions(
  root: string,
  resolved: ResolvedDependencyRealms,
): DependencyPlan {
  const files: PlannedTypeFile[] = [];
  const withoutDefinitions: DependencyWithoutDefinitions[] = [];
  const usedNamespaces = new Set<string>();
  for (const rawEntry of resolved.all) {
    const packagePath = path.resolve(rawEntry);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(packagePath);
    } catch (err) {
      logger.warn(
        `[export-types] Cannot read dependency ${packagePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const isFile = stats.isFile();
    const definitions = isFile
      ? isDefinitionFile(packagePath)
        ? [{ absolute: packagePath, relative: path.basename(packagePath) }]
        : []
      : discoverDefinitions(packagePath);
    if (definitions.length === 0) {
      withoutDefinitions.push({
        name: dependencyDisplayName(packagePath, isFile),
        path: packagePath,
      });
      continue;
    }
    const namespace = allocateNamespace(dependencyDisplayName(packagePath, isFile), usedNamespaces);
    for (const definition of definitions) {
      const realm = classifyDependencyDefinition(resolved, definition.absolute);
      if (!realm) {
        logger.debug(
          `[export-types] Skipping ${definition.absolute}: it is not part of any resolved dependency realm.`,
        );
        continue;
      }
      files.push({
        path: dependencyOutputPath(definition.relative, realm, namespace),
        realm,
        kind: "definition",
        source: toPosix(path.relative(root, definition.absolute)) || definition.absolute,
        absoluteSource: definition.absolute,
      });
    }
  }
  return { files, withoutDefinitions };
}
