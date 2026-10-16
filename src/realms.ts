import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import {
  buildWorkspaceConfig,
  resolveRealmMappings,
  writeTempConfig,
  type RealmMapping,
} from "./config.js";
import { deriveRealmAnnotationFiles, type RealmPassName } from "./annotations-realms.js";
import { logger } from "./logger.js";
import { listCheckedFiles, runLuaLSCheck } from "./luals.js";
import {
  computeUnrequestedExclusions,
  getCanonicalPath,
  matchesTargetPaths,
} from "./target-resolver.js";
import { resolvePackageDependencies } from "./deps.js";
import { generatePackageExportBindings, type ExportBindingLibraries } from "./package-exports.js";
import { hasCustomRuntimePaths } from "./package-require-paths.js";
import {
  fileUriToPath,
  type CheckOptions,
  type CheckResult,
  type DiagnosticReport,
  type LuaRCConfig,
} from "./types.js";

export {
  deriveRealmAnnotationFiles,
  splitAnnotationsByRealm,
  type DerivedRealmAnnotations,
  type RealmPassName,
} from "./annotations-realms.js";

/** `--realm` selection: `all` runs every pass, others keep the shared pass too. */
export type RealmSelection = "all" | RealmPassName;

export interface RealmFileSets {
  client: string[];
  server: string[];
  /** Files matched by a shared/global pattern. */
  shared: string[];
  /** Files matched by no pattern: they are checked with full context. */
  unmatched: string[];
}

/** Normalizes a workspace-relative path for case-insensitive comparison on Windows. */
function normalizeRelative(candidate: string): string {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Assigns every checked Lua file to a realm, returning the paths exactly as they are on
 * disk (comparisons are case-insensitive on Windows). The last matching `nanos.realms`
 * entry wins, and files matched by no entry belong to the shared (full-context) pass.
 */
export function collectRealmFiles(
  root: string,
  mappings: RealmMapping[],
  checkedFiles: string[],
): RealmFileSets {
  const checked = new Set(checkedFiles.map(normalizeRelative));
  const assignments = new Map<string, RealmPassName>();

  for (const { pattern, realm } of mappings) {
    let matches: string[];
    try {
      matches = globSync(pattern, {
        cwd: root,
        dot: true,
        nocase: true,
        follow: false,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.relativePosix());
    } catch (err) {
      logger.warn(
        `[realms] Skipping nanos.realms pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const match of matches) {
      const key = normalizeRelative(match);
      if (key.endsWith(".lua") && checked.has(key)) {
        assignments.set(key, realm);
      }
    }
  }

  const sets: RealmFileSets = { client: [], server: [], shared: [], unmatched: [] };
  for (const file of checkedFiles) {
    const realm = assignments.get(normalizeRelative(file));
    if (realm) {
      sets[realm].push(file);
    } else {
      sets.unmatched.push(file);
    }
  }
  return sets;
}

export interface RealmPass {
  realm: RealmPassName;
  configPath: string;
  /** Workspace-relative files whose diagnostics belong to this pass. */
  reportFiles: Set<string>;
}

export interface RealmCheckPlan {
  baseConfigPath: string;
  passes: RealmPass[];
  cleanup: () => void;
}

const PACKAGE_REQUIRE_SIDE_PATHS: Record<"client" | "server", string[]> = {
  server: ["Server/?", "Server/?.lua"],
  client: ["Client/?", "Client/?.lua"],
};
const PACKAGE_REQUIRE_SHARED_PATHS = ["Shared/?", "Shared/?.lua"];
const PACKAGE_REQUIRE_ROOT_PATHS = ["?", "?.lua"];
const PACKAGE_REQUIRE_PACKAGE_PATHS = new Set(["Packages/?", "Packages/?.lua", "../?", "../?.lua"]);

export interface PlanRealmCheckOptions {
  targetPath: string;
  userConfig: LuaRCConfig;
  selection: RealmSelection;
  annotationsPath: string;
  customConfigPath?: string;
  ignore?: string[];
  targetPaths?: string[];
  cliDeps?: string[];
}

/** Returns the passes selected by `--realm`, always pairing a side with the shared pass. */
function selectedRealms(selection: RealmSelection): RealmPassName[] {
  if (selection === "all") {
    return ["server", "client", "shared"];
  }
  if (selection === "shared") {
    return ["shared"];
  }
  return ["shared", selection];
}

/** Builds a pass config from the merged base config by swapping library and exclusions. */
function buildPassConfig(
  baseConfig: Record<string, unknown>,
  realm: RealmPassName,
  annotationsPath: string,
  realmAnnotationPath: string,
  excludedPatterns: string[],
  dependencyLibraries: string[] = [],
  hasCustomRuntimePaths = false,
): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(baseConfig)) as {
    runtime?: { path?: string[] };
    workspace?: { library?: string[] };
    files?: { exclude?: string[] };
  };
  const runtimePaths = config.runtime?.path;
  if (!hasCustomRuntimePaths && runtimePaths) {
    const oppositeSidePaths =
      realm === "server"
        ? PACKAGE_REQUIRE_SIDE_PATHS.client
        : realm === "client"
          ? PACKAGE_REQUIRE_SIDE_PATHS.server
          : [];
    const activeRuntimePaths = runtimePaths.filter(
      (pattern) => !oppositeSidePaths.includes(pattern),
    );
    const packagePaths = activeRuntimePaths.filter((pattern) =>
      PACKAGE_REQUIRE_PACKAGE_PATHS.has(pattern),
    );
    const completePackagePair =
      (packagePaths.includes("Packages/?") && packagePaths.includes("Packages/?.lua")) ||
      (packagePaths.includes("../?") && packagePaths.includes("../?.lua"));
    const requiredSidePaths =
      realm === "shared"
        ? [...PACKAGE_REQUIRE_SIDE_PATHS.server, ...PACKAGE_REQUIRE_SIDE_PATHS.client]
        : PACKAGE_REQUIRE_SIDE_PATHS[realm];
    const requiredPaths = [
      ...requiredSidePaths,
      ...PACKAGE_REQUIRE_SHARED_PATHS,
      ...PACKAGE_REQUIRE_ROOT_PATHS,
    ];
    if (
      completePackagePair &&
      requiredPaths.every((pattern) => activeRuntimePaths.includes(pattern))
    ) {
      const knownPaths = new Set([
        ...PACKAGE_REQUIRE_SIDE_PATHS.server,
        ...PACKAGE_REQUIRE_SIDE_PATHS.client,
        ...PACKAGE_REQUIRE_SHARED_PATHS,
        ...PACKAGE_REQUIRE_ROOT_PATHS,
        ...packagePaths,
      ]);
      const positions = activeRuntimePaths.flatMap((pattern, index) =>
        knownPaths.has(pattern) ? [index] : [],
      );
      const officialOrder =
        realm === "shared"
          ? [
              ...PACKAGE_REQUIRE_SHARED_PATHS,
              ...PACKAGE_REQUIRE_SIDE_PATHS.server,
              ...PACKAGE_REQUIRE_SIDE_PATHS.client,
              ...PACKAGE_REQUIRE_ROOT_PATHS,
              ...packagePaths,
            ]
          : [
              ...PACKAGE_REQUIRE_SIDE_PATHS[realm],
              ...PACKAGE_REQUIRE_SHARED_PATHS,
              ...PACKAGE_REQUIRE_ROOT_PATHS,
              ...packagePaths,
            ];
      if (positions.length === officialOrder.length) {
        for (const [index, position] of positions.entries()) {
          activeRuntimePaths[position] = officialOrder[index]!;
        }
        config.runtime = { ...(config.runtime ?? {}), path: activeRuntimePaths };
      }
    }
  }
  const normalizedFull = annotationsPath.replace(/\\/g, "/");
  const libraries = (config.workspace?.library ?? []).filter(
    (entry) => entry.replace(/\\/g, "/") !== normalizedFull,
  );
  config.workspace = {
    ...(config.workspace ?? {}),
    library: Array.from(new Set([realmAnnotationPath, ...libraries, ...dependencyLibraries])),
  };
  if (realm !== "shared" && excludedPatterns.length > 0) {
    config.files = {
      ...(config.files ?? {}),
      exclude: [...new Set([...(config.files?.exclude ?? []), ...excludedPatterns])],
    };
  }
  return config as Record<string, unknown>;
}

/**
 * Plans realm-aware checking for a target. Returns `null` when a single standard pass is
 * the right answer: realms disabled, the target is a file, or no configured realm pattern
 * matches a checked Lua file.
 */
export function planRealmCheck(options: PlanRealmCheckOptions): RealmCheckPlan | null {
  const { targetPath, userConfig, selection, annotationsPath } = options;
  const resolvedTarget = path.resolve(targetPath);

  if (!fs.existsSync(resolvedTarget) || fs.statSync(resolvedTarget).isFile()) {
    return null;
  }
  const { enabled, mappings } = resolveRealmMappings(userConfig);
  if (!enabled) {
    logger.debug("[realms] Realm mapping disabled; running a single standard pass.");
    return null;
  }

  const unrequestedExclusions = options.targetPaths
    ? computeUnrequestedExclusions(resolvedTarget, options.targetPaths)
    : [];
  const baseConfig = buildWorkspaceConfig(resolvedTarget, options.customConfigPath, {
    ignore: options.ignore,
    annotationsPath,
    unrequestedExclusions,
  });
  const tempConfigs: string[] = [];
  const baseConfigPath = writeTempConfig(baseConfig);
  tempConfigs.push(baseConfigPath);
  let exportBindings: ExportBindingLibraries | null = null;
  try {
    const checkedFiles = listCheckedFiles(resolvedTarget, baseConfigPath);
    const realmFiles = collectRealmFiles(resolvedTarget, mappings, checkedFiles);

    const isTargetFile = (file: string): boolean => {
      if (!options.targetPaths || options.targetPaths.length === 0) {
        return true;
      }
      return matchesTargetPaths(file, resolvedTarget, options.targetPaths);
    };

    // Report sets are keyed by normalized paths: diagnostics arrive as real file paths,
    // so membership must survive Windows' case-insensitive file system.
    const realmReportFiles: Record<RealmPassName, Set<string>> = {
      client: new Set(realmFiles.client.filter(isTargetFile).map(normalizeRelative)),
      server: new Set(realmFiles.server.filter(isTargetFile).map(normalizeRelative)),
      shared: new Set(
        [...realmFiles.shared, ...realmFiles.unmatched].filter(isTargetFile).map(normalizeRelative),
      ),
    };
    const hasRealmFolders =
      realmFiles.client.length > 0 || realmFiles.server.length > 0 || realmFiles.shared.length > 0;
    if (selection === "all" && !hasRealmFolders) {
      logger.debug("[realms] No realm folders matched; running a single standard pass.");
      for (const tempConfig of tempConfigs) {
        removeTempConfig(tempConfig);
      }
      return null;
    }

    const wanted = selectedRealms(selection).filter((realm) => realmReportFiles[realm].size > 0);
    if (wanted.length === 0) {
      if (selection !== "all") {
        logger.warn(
          `[realms] No target files match the requested realm "${selection}"; falling back to a standard check.`,
        );
      } else {
        logger.debug(
          "[realms] No files to report for selected realm pass; running a single standard pass.",
        );
      }
      for (const tempConfig of tempConfigs) {
        removeTempConfig(tempConfig);
      }
      return null;
    }
    const needsSplitLibraries = wanted.some((realm) => realm !== "shared");
    const derived = needsSplitLibraries
      ? deriveRealmAnnotationFiles(annotationsPath)
      : { client: annotationsPath, server: annotationsPath };
    const resolvedDeps = resolvePackageDependencies(resolvedTarget, userConfig, options.cliDeps);
    // Generated Package.Export bindings must be released together with the pass configs.
    exportBindings = generatePackageExportBindings(resolvedDeps);
    const passes: RealmPass[] = [];
    for (const realm of wanted) {
      const excluded = mappings
        .filter((mapping) => mapping.realm !== realm && mapping.realm !== "shared")
        .map((mapping) => mapping.pattern);
      const depLibraries =
        realm === "server"
          ? [...resolvedDeps.server, ...exportBindings.server]
          : realm === "client"
            ? [...resolvedDeps.client, ...exportBindings.client]
            : [...resolvedDeps.shared, ...exportBindings.shared];
      const passConfig = buildPassConfig(
        baseConfig as unknown as Record<string, unknown>,
        realm,
        annotationsPath,
        realm === "client" ? derived.client : realm === "server" ? derived.server : annotationsPath,
        excluded,
        depLibraries,
        hasCustomRuntimePaths(userConfig),
      );
      const configPath = writeTempConfig(passConfig);
      tempConfigs.push(configPath);
      passes.push({ realm, configPath, reportFiles: realmReportFiles[realm] });
    }

    return {
      baseConfigPath,
      passes,
      cleanup: () => {
        exportBindings?.cleanup();
        for (const tempConfig of tempConfigs) {
          removeTempConfig(tempConfig);
        }
      },
    };
  } catch (err) {
    exportBindings?.cleanup();
    for (const tempConfig of tempConfigs) {
      removeTempConfig(tempConfig);
    }
    throw err;
  }
}

/** Deletes a temporary configuration file, ignoring cleanup failures. */
function removeTempConfig(configPath: string): void {
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch (err) {
    logger.warn(
      `Failed to clean up temporary config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Keeps only the diagnostics of files owned by the pass. */
function filterReportByFiles(
  report: DiagnosticReport,
  root: string,
  reportFiles: Set<string>,
): DiagnosticReport {
  const filtered: DiagnosticReport = {};
  const canonicalRoot = getCanonicalPath(root);
  for (const [uri, diagnostics] of Object.entries(report)) {
    const filePath = fileUriToPath(uri);
    const resolvedFile = path.resolve(filePath);
    let relative = normalizeRelative(path.relative(root, resolvedFile));
    if (!reportFiles.has(relative)) {
      const canonicalFile = getCanonicalPath(resolvedFile);
      relative = normalizeRelative(path.relative(canonicalRoot, canonicalFile));
    }
    if (reportFiles.has(relative)) {
      filtered[uri] = diagnostics;
    }
  }
  return filtered;
}

/**
 * Runs every planned realm pass, merges the per-realm reports into one result, and
 * recomputes the totals. Shared files are reported by the full-context pass only, so a
 * file never yields duplicate diagnostics.
 */
export async function runRealmAwareCheck(
  plan: RealmCheckPlan,
  targetPath: string,
  options: CheckOptions,
): Promise<CheckResult> {
  const root = path.resolve(targetPath);
  const diagnostics: DiagnosticReport = {};
  let totalProblems = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const pass of plan.passes) {
    logger.info(`[realms] Checking the ${pass.realm} realm (${pass.reportFiles.size} file(s))...`);
    const passResult = await runLuaLSCheck(targetPath, pass.configPath, options);
    const report = filterReportByFiles(passResult.diagnostics, root, pass.reportFiles);
    for (const [uri, diags] of Object.entries(report)) {
      if (diags.length === 0) {
        continue;
      }
      diagnostics[uri] = [...(diagnostics[uri] ?? []), ...diags];
      totalProblems += diags.length;
      for (const diagnostic of diags) {
        if (diagnostic.severity === 1) {
          totalErrors += 1;
        } else if (diagnostic.severity === 2) {
          totalWarnings += 1;
        }
      }
    }
  }

  const checkedFiles = new Set<string>();
  for (const pass of plan.passes) {
    for (const file of pass.reportFiles) {
      checkedFiles.add(file);
    }
  }
  const filesChecked = checkedFiles.size;
  const problemFiles = Object.values(diagnostics).filter((diags) => diags.length > 0).length;
  return {
    passed: totalProblems === 0,
    totalProblems,
    totalErrors,
    totalWarnings,
    totalFiles: totalProblems === 0 ? filesChecked : problemFiles,
    totalFilesChecked: filesChecked,
    diagnostics,
  };
}
