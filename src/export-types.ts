import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAnnotations } from "./annotations.js";
import { deriveRealmAnnotationFiles } from "./annotations-realms.js";
import { getPackageRoot, loadUserConfig } from "./config.js";
import { resolvePackageDependencies } from "./deps.js";
import {
  planDependencyDefinitions,
  planOwnDefinitions,
  toPosix,
  type ExportedTypeFile,
  type PlannedTypeFile,
} from "./export-types-discovery.js";
import { logger } from "./logger.js";
import { ExportTypesError } from "./errors.js";

export {
  isDefinitionFile,
  isMetaDefinitionContent,
  type ExportDefinitionKind,
  type ExportDefinitionRealm,
  type ExportedTypeFile,
} from "./export-types-discovery.js";

/** Directory created when `export-types` is invoked without a destination argument. */
export const DEFAULT_EXPORT_TYPES_DESTINATION = "types";
/** Manifest written at the root of every exported type bundle. */
export const EXPORT_TYPES_MANIFEST = "nanos-types.json";
/** Version of the manifest payload, bumped when its shape changes incompatibly. */
export const EXPORT_TYPES_SCHEMA_VERSION = 1;

export interface ExportTypesOptions {
  /** Package root to collect definitions from. Defaults to `process.cwd()`. */
  root?: string;
  /** Destination directory, relative to the package root. Defaults to `./types`. */
  destination?: string;
  /** Replace an existing non-empty destination instead of failing. */
  force?: boolean;
  /** Include transitive dependency definition files. Defaults to true. */
  dependencies?: boolean;
  /** Include the resolved nanos world annotations in the bundle. */
  withNanos?: boolean;
  /** Custom annotations.lua source, only valid together with `withNanos`. */
  annotationsPath?: string;
  /** Custom `.luarc.json` used to resolve `nanos.deps`. */
  configPath?: string;
  /** Never access the network while resolving annotations. */
  offline?: boolean;
}

export interface ExportTypesManifest {
  schemaVersion: number;
  generator: { name: "nanos-lint"; version: string };
  package: { name: string; version: string | null };
  sourceCommit: string | null;
  generatedAt: string;
  includeDependencies: boolean;
  withNanos: boolean;
  files: ExportedTypeFile[];
}

export interface ExportTypesResult {
  destination: string;
  manifestPath: string;
  manifest: ExportTypesManifest;
}

/** Plans the nanos annotations requested by `--with-nanos`, splitting them when needed. */
async function collectNanosDefinitions(
  root: string,
  options: ExportTypesOptions,
  realmAware: boolean,
): Promise<PlannedTypeFile[]> {
  const annotations = await resolveAnnotations({
    customPath: options.annotationsPath,
    offline: options.offline,
  });
  const source = toPosix(path.relative(root, annotations)) || annotations;
  if (!realmAware) {
    return [
      {
        path: "annotations.d.lua",
        realm: "shared",
        kind: "nanos-annotations",
        source,
        absoluteSource: annotations,
      },
    ];
  }
  const derived = deriveRealmAnnotationFiles(annotations);
  return [
    {
      path: "Server/annotations.d.lua",
      realm: "server",
      kind: "nanos-annotations",
      source,
      absoluteSource: derived.server,
    },
    {
      path: "Client/annotations.d.lua",
      realm: "client",
      kind: "nanos-annotations",
      source,
      absoluteSource: derived.client,
    },
  ];
}

/** Reads the exported package's name and version from its package.json, when present. */
function readPackageMetadata(root: string): { name: string; version: string | null } {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name:
        typeof manifest.name === "string" && manifest.name.trim()
          ? manifest.name.trim()
          : path.basename(root),
      version: typeof manifest.version === "string" ? manifest.version : null,
    };
  } catch (err) {
    logger.debug(
      `[export-types] No package.json at ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name: path.basename(root), version: null };
  }
}

/** Reads the version of the running nanos-lint package for the manifest. */
function readGeneratorVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(getPackageRoot(), "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch (err) {
    logger.debug(
      `[export-types] Could not read the generator version: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  }
}

/** Resolves the Git commit recorded in the manifest, or null outside a repository. */
function readSourceCommit(root: string): string | null {
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(output) ? output : null;
  } catch (err) {
    logger.debug(
      `[export-types] Could not resolve the source commit: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Builds the manifest describing the bundle and every file it contains. */
function buildManifest(
  root: string,
  files: PlannedTypeFile[],
  options: ExportTypesOptions,
  generatedAt: Date,
): ExportTypesManifest {
  return {
    schemaVersion: EXPORT_TYPES_SCHEMA_VERSION,
    generator: { name: "nanos-lint", version: readGeneratorVersion() },
    package: readPackageMetadata(root),
    sourceCommit: readSourceCommit(root),
    generatedAt: generatedAt.toISOString(),
    includeDependencies: options.dependencies !== false,
    withNanos: options.withNanos === true,
    files: files
      .map(({ path: filePath, realm, kind, source }) => ({ path: filePath, realm, kind, source }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Resolves the destination and rejects a bundle nested on top of the package root. */
function resolveExportDestination(root: string, destination?: string): string {
  const resolved = path.resolve(root, destination || DEFAULT_EXPORT_TYPES_DESTINATION);
  if (resolved === root) {
    throw new ExportTypesError(
      `Refusing to export type definitions into the package root itself: ${resolved}`,
      "ERR_EXPORT_TYPES_DESTINATION",
      "Pass a destination directory such as './types' instead of '.'.",
    );
  }
  return resolved;
}

/** Returns whether a directory exists and contains no entries. */
function isDirectoryEmpty(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch (err) {
    logger.debug(
      `[export-types] Could not inspect ${directory}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Refuses to overwrite a non-empty destination unless `--force` was passed. */
function assertDestinationWritable(destination: string, force: boolean): void {
  if (!fs.existsSync(destination)) {
    return;
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(destination);
  } catch (err) {
    throw new ExportTypesError(
      `Cannot inspect the export destination ${destination}: ${err instanceof Error ? err.message : String(err)}`,
      "ERR_EXPORT_TYPES_DESTINATION",
      "Verify the destination exists and is readable, or choose another path.",
      { cause: err },
    );
  }
  if (!force && (!stats.isDirectory() || !isDirectoryEmpty(destination))) {
    throw new ExportTypesError(
      `Export destination already exists and is not empty: ${destination}`,
      "ERR_EXPORT_TYPES_EXISTS",
      "Pass --force to replace the existing destination.",
    );
  }
}

/** Builds a unique sibling path used for staging and backup directories. */
function uniqueSibling(target: string, purpose: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.nanos-lint-${purpose}-${suffix}`,
  );
}

/** Removes a temporary or backup tree, reporting cleanup failures without failing the export. */
function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `[export-types] Could not remove temporary path ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Copies every planned file and the manifest into a fresh staging directory. */
function writeStagedTree(
  staging: string,
  files: PlannedTypeFile[],
  manifest: ExportTypesManifest,
): void {
  fs.mkdirSync(staging, { recursive: true });
  for (const file of files) {
    const target = path.join(staging, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absoluteSource, target);
  }
  fs.writeFileSync(
    path.join(staging, EXPORT_TYPES_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

/** Atomically swaps a completed staging tree into the destination, restoring on failure. */
function commitStagedTree(staging: string, destination: string): void {
  let backup: string | null = null;
  try {
    if (fs.existsSync(destination)) {
      if (fs.statSync(destination).isDirectory() && isDirectoryEmpty(destination)) {
        fs.rmdirSync(destination);
      } else {
        backup = uniqueSibling(destination, "backup");
        fs.renameSync(destination, backup);
      }
    }
    fs.renameSync(staging, destination);
  } catch (err) {
    if (backup && !fs.existsSync(destination)) {
      try {
        fs.renameSync(backup, destination);
        backup = null;
      } catch (restoreErr) {
        logger.error(
          `[export-types] Could not restore the previous destination ${destination} from ${backup}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
        );
      }
    }
    removeQuietly(staging);
    throw err;
  }
  if (backup) {
    removeQuietly(backup);
  }
}

/** Ensures no two sources claim the same exported path. */
function assertNoOutputCollisions(files: PlannedTypeFile[]): void {
  const owners = new Map<string, string>();
  for (const file of files) {
    const existing = owners.get(file.path);
    if (existing && existing !== file.absoluteSource) {
      throw new ExportTypesError(
        `Type export collision: ${existing} and ${file.absoluteSource} both map to ${file.path}`,
        "ERR_EXPORT_TYPES_COLLISION",
        "Rename one definition file or adjust the package's nanos.realms mapping so the paths differ.",
      );
    }
    owners.set(file.path, file.absoluteSource);
  }
}

/**
 * Bundles a package's public Lua type surface into a portable directory that
 * `nanos.deps` / `--dep` can consume without the dependency source. Discovery collects
 * `*.d.lua` and `---@meta` files, preserves realm folders, includes transitive dependency
 * definitions by default, and writes the tree through a staging directory before an atomic
 * rename. A manifest records package metadata, the source commit, and every source file.
 */
export async function exportTypes(options: ExportTypesOptions = {}): Promise<ExportTypesResult> {
  const root = path.resolve(options.root ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new ExportTypesError(
      `Package root not found or not a directory: ${root}`,
      "ERR_EXPORT_TYPES_ROOT",
      "Run export-types from a package directory or pass a valid root.",
    );
  }
  if (options.annotationsPath && options.withNanos !== true) {
    throw new ExportTypesError(
      "--annotations requires --with-nanos: annotations are only bundled on request.",
      "ERR_EXPORT_TYPES_ANNOTATIONS",
      "Pass --with-nanos together with --annotations, or omit the custom annotations path.",
    );
  }
  const destination = resolveExportDestination(root, options.destination);
  assertDestinationWritable(destination, options.force === true);

  const userConfig = loadUserConfig(root, options.configPath);
  const resolved = resolvePackageDependencies(root, userConfig);
  const planned: PlannedTypeFile[] = [];

  const ownDefinitions = planOwnDefinitions(root, userConfig, [destination]);
  planned.push(...ownDefinitions);
  if (ownDefinitions.length === 0) {
    logger.warn(
      `[export-types] No definition files (*.d.lua or ---@meta) found in ${root}; the bundle will contain no package definitions.`,
    );
  }

  if (options.dependencies !== false) {
    const dependencies = planDependencyDefinitions(root, resolved);
    planned.push(...dependencies.files);
    for (const missing of dependencies.withoutDefinitions) {
      logger.warn(
        `[export-types] Dependency "${missing.name}" (${missing.path}) has no definition files; consumers of this bundle will need its source or a published type contract.`,
      );
    }
  }

  const realmAware = planned.some((file) => file.realm !== "shared");
  if (options.withNanos) {
    planned.push(...(await collectNanosDefinitions(root, options, realmAware)));
  }
  assertNoOutputCollisions(planned);

  const manifest = buildManifest(root, planned, options, new Date());
  const staging = uniqueSibling(destination, "tmp");
  try {
    writeStagedTree(staging, planned, manifest);
    commitStagedTree(staging, destination);
  } catch (err) {
    removeQuietly(staging);
    throw err;
  }
  logger.info(
    `[export-types] Bundled ${planned.length} file(s) into ${destination} with manifest ${EXPORT_TYPES_MANIFEST}.`,
  );
  return {
    destination,
    manifestPath: path.join(destination, EXPORT_TYPES_MANIFEST),
    manifest,
  };
}
