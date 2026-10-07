import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { getPackageRoot } from "../config.js";
import { systemPaths } from "../paths.js";
import { fileUriToPath } from "../types.js";
import type { CheckOptions, CheckResult, DiagnosticReport } from "../types.js";
import { LuaLSError } from "../errors.js";
import { filterReportByTargetPaths } from "../target-resolver.js";
import {
  DEFAULT_LUALS_VERSION,
  FALLBACK_LUALS_VERSION,
  resolveLuaLSVersion,
  fetchLatestLuaLSVersionFromGitHub,
  sanitizeLuaLSVersion,
} from "./version.js";
import { getPlatformInfo } from "./platform.js";
import {
  getBaseLuaLSCacheDir,
  getCacheDir,
  readLuaLSMetadata,
  writeLuaLSMetadata,
  listCachedLuaLSVersions,
  cleanupOldCachedLuaLSVersions,
  getIsoWeek,
} from "./cache.js";
import {
  isBinaryValid,
  assertValidLuaLSBinary,
  rethrowLuaLSPermissionError,
} from "./validation.js";
import { downloadAndExtractLuaLS } from "./download.js";
import { resolveOfflineLuaLS, validateOfflineBinary } from "./offline.js";
import { countCheckedFiles } from "./files.js";

export { countCheckedFiles } from "./files.js";

const execFileAsync = promisify(execFile);

/** Determines if an error represents an offline network condition. */
function isOfflineError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /offline|enotfound|eai_again|econnrefused|etimedout|fetch failed/i.test(msg);
}

export interface ResolveLuaLSOptions {
  /** Cache base directory (version directories, metadata, temp extraction). Defaults to the system cache. */
  cacheDir?: string;
  /** Set to `false` to always fetch the archive instead of reusing an installed copy. */
  reuseExisting?: boolean;
  offline?: boolean;
}

/** Resolves the executable path of a LuaLS binary from env, bundle, cache, or network download. */
export async function resolveLuaLSBinary(
  version: string = DEFAULT_LUALS_VERSION,
  options?: ResolveLuaLSOptions,
): Promise<string> {
  if (options?.offline) return resolveOfflineLuaLS(version, options.cacheDir);

  // 1. Environment variable override
  if (process.env.LUALS_BIN) {
    return assertValidLuaLSBinary(process.env.LUALS_BIN, "LUALS_BIN");
  }

  // 2. Bundled with package (release distribution) - check early for default version to avoid network delay
  if (options?.reuseExisting !== false && (!version || version === "latest")) {
    const defaultInfo = getPlatformInfo(FALLBACK_LUALS_VERSION);
    const defaultBundledPath = path.join(getPackageRoot(), defaultInfo.binaryRelativePath);
    if (fs.existsSync(defaultBundledPath) && isBinaryValid(defaultBundledPath)) {
      return defaultBundledPath;
    }
  }

  const isDefaultOrLatest = !version || version === "latest";

  const baseCacheDir = options?.cacheDir ?? getBaseLuaLSCacheDir();

  // When a specific version is explicitly requested (not "latest"):
  if (!isDefaultOrLatest) {
    const resolvedVersion = await resolveLuaLSVersion(version);
    const info = getPlatformInfo(resolvedVersion);

    // Bundled with package for explicitly requested version
    if (options?.reuseExisting !== false) {
      const bundledPath = path.join(getPackageRoot(), info.binaryRelativePath);
      if (fs.existsSync(bundledPath) && isBinaryValid(bundledPath)) {
        return bundledPath;
      }
    }

    // User cache for explicitly requested version
    const cachedDir = getCacheDir(resolvedVersion, baseCacheDir);
    const cachedPath = path.join(cachedDir, info.binaryRelativePath);
    const completeMarker = path.join(cachedDir, ".complete");

    let wasCorrupted = false;
    if (fs.existsSync(cachedPath)) {
      let isValid = false;
      if (fs.existsSync(completeMarker)) {
        try {
          const storedVersion = fs.readFileSync(completeMarker, "utf-8").trim();
          if (storedVersion === resolvedVersion && isBinaryValid(cachedPath)) {
            isValid = true;
            if (options?.reuseExisting !== false) {
              return cachedPath;
            }
          }
        } catch (err) {
          rethrowLuaLSPermissionError(err, completeMarker);
          logger.debug(
            `[luals] Failed to read complete marker at ${completeMarker}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!isValid) {
        wasCorrupted = true;
        logger.warn(
          `[luals] Cached LuaLS binary at ${cachedPath} is corrupted or incomplete. Repairing...`,
        );
      }
      try {
        fs.rmSync(cachedDir, { recursive: true, force: true });
      } catch (err) {
        rethrowLuaLSPermissionError(err, cachedDir);
        logger.warn(
          `[luals] Failed to remove corrupted cache directory ${cachedDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // In PATH
    if (options?.reuseExisting !== false) {
      try {
        const cmd = process.platform === "win32" ? "where.exe" : "which";
        const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
        const found = stdout.trim().split(/\r?\n/)[0];
        if (found && fs.existsSync(found) && isBinaryValid(found)) {
          return found;
        }
      } catch (err) {
        rethrowLuaLSPermissionError(err, "lua-language-server", "execute");
        logger.debug(
          `[luals] LuaLS binary not found in PATH: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Download and cache explicit version
    try {
      return await downloadAndExtractLuaLS(
        resolvedVersion,
        getCacheDir(resolvedVersion, baseCacheDir),
        options,
      );
    } catch (err) {
      rethrowLuaLSPermissionError(err, cachedDir);
      if (wasCorrupted) {
        const isOffline = isOfflineError(err);
        const reason = isOffline
          ? "while offline"
          : err instanceof Error
            ? err.message
            : String(err);
        throw new LuaLSError(
          `Cached LuaLS binary at '${cachedPath}' is corrupted (failed execution/size check) and cannot be re-downloaded ${isOffline ? reason : `: ${reason}`}. Please ${isOffline ? "connect to the internet" : "verify your network connection"} to repair or run 'nanos-lint clean-cache'.`,
          "ERR_LUALS_CORRUPTED_CACHE",
          "Connect to the internet to repair the corrupted binary or run 'nanos-lint clean-cache'.",
          { cause: err },
        );
      }
      throw err;
    }
  }

  // 3. Default/latest version: Weekly cache check & auto-cleanup
  const currentWeek = getIsoWeek();
  const metadata = readLuaLSMetadata(baseCacheDir);

  // Fast path first: enumerating the cache would spawn every cached binary.
  const safeLatest = metadata?.latestVersion ? sanitizeLuaLSVersion(metadata.latestVersion) : null;
  if (
    options?.reuseExisting !== false &&
    metadata &&
    metadata.lastCheckedWeek === currentWeek &&
    safeLatest
  ) {
    const info = getPlatformInfo(safeLatest);
    const targetDir = path.resolve(getCacheDir(safeLatest, baseCacheDir));
    const resolvedBase = path.resolve(baseCacheDir);
    if (targetDir.startsWith(resolvedBase + path.sep) || targetDir === resolvedBase) {
      const cachedPath = path.join(targetDir, info.binaryRelativePath);
      if (isBinaryValid(cachedPath)) {
        return cachedPath;
      }
    }
  }

  const cachedVersions =
    options?.reuseExisting !== false ? listCachedLuaLSVersions(baseCacheDir) : [];

  // Same week, but the recorded version is unusable: reuse another cached one.
  const firstCachedVersion = cachedVersions[0];
  if (
    options?.reuseExisting !== false &&
    metadata &&
    metadata.lastCheckedWeek === currentWeek &&
    firstCachedVersion
  ) {
    const info = getPlatformInfo(firstCachedVersion);
    return path.join(getCacheDir(firstCachedVersion, baseCacheDir), info.binaryRelativePath);
  }

  // We need to check for updates (new week, missing metadata, or no valid binary in cache)
  const onlineTag = await fetchLatestLuaLSVersionFromGitHub();
  const today = new Date().toISOString().split("T")[0];

  let targetVersion: string;
  if (onlineTag) {
    targetVersion = onlineTag;
  } else if (metadata?.latestVersion && cachedVersions.includes(metadata.latestVersion)) {
    logger.info(
      `[luals] Network unreachable or rate limited; using cached LuaLS ${metadata.latestVersion}.`,
    );
    targetVersion = metadata.latestVersion;
  } else if (firstCachedVersion) {
    logger.info(
      `[luals] Network unreachable or rate limited; using cached LuaLS ${firstCachedVersion}.`,
    );
    targetVersion = firstCachedVersion;
  } else {
    targetVersion = FALLBACK_LUALS_VERSION;
  }

  // Update metadata with the current week and target version
  writeLuaLSMetadata(
    {
      lastCheckedWeek: currentWeek,
      latestVersion: targetVersion,
      lastCheckedDate: today,
    },
    baseCacheDir,
  );

  const info = getPlatformInfo(targetVersion);
  const targetCacheDir = getCacheDir(targetVersion, baseCacheDir);
  const targetBinaryPath = path.join(targetCacheDir, info.binaryRelativePath);
  const completeMarker = path.join(targetCacheDir, ".complete");
  let wasCorrupted = false;
  if (fs.existsSync(targetBinaryPath)) {
    if (fs.existsSync(completeMarker) && isBinaryValid(targetBinaryPath)) {
      if (options?.reuseExisting !== false) {
        // Already downloaded and valid; clean up any older versions
        cleanupOldCachedLuaLSVersions(targetVersion, baseCacheDir);
        return targetBinaryPath;
      }
    } else {
      wasCorrupted = true;
    }
  }

  // Check PATH as fallback before downloading if offline/unreachable
  if (options?.reuseExisting !== false && !onlineTag) {
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
      const found = stdout.trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found) && isBinaryValid(found)) {
        return found;
      }
    } catch (err) {
      rethrowLuaLSPermissionError(err, "lua-language-server", "execute");
      logger.debug(
        `[luals] LuaLS binary not found in PATH: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Download and extract latest LuaLS
  let downloadedBinary: string;
  try {
    downloadedBinary = await downloadAndExtractLuaLS(targetVersion, targetCacheDir, options);
  } catch (err) {
    rethrowLuaLSPermissionError(err, targetCacheDir);
    if (wasCorrupted) {
      const isOffline = isOfflineError(err);
      const reason = isOffline ? "while offline" : err instanceof Error ? err.message : String(err);
      throw new LuaLSError(
        `Cached LuaLS binary at '${targetBinaryPath}' is corrupted (failed execution/size check) and cannot be re-downloaded ${isOffline ? reason : `: ${reason}`}. Please ${isOffline ? "connect to the internet" : "verify your network connection"} to repair or run 'nanos-lint clean-cache'.`,
        "ERR_LUALS_CORRUPTED_CACHE",
        "Connect to the internet to repair the corrupted binary or run 'nanos-lint clean-cache'.",
        { cause: err },
      );
    }
    throw err;
  }

  // If update is found, download latest LuaLS to replace the older one, remove the older one from cache afterwards
  cleanupOldCachedLuaLSVersions(targetVersion, baseCacheDir);

  return downloadedBinary;
}

/** Executes the LuaLS diagnostics check on the target path using merged configurations. */
export async function runLuaLSCheck(
  targetPath: string,
  configPath: string,
  options: CheckOptions,
): Promise<CheckResult> {
  let absoluteTarget = path.resolve(targetPath);
  try {
    if (fs.existsSync(absoluteTarget)) {
      absoluteTarget = fs.realpathSync.native(absoluteTarget);
    }
  } catch (err) {
    logger.debug(
      `[luals] Failed to resolve native realpath for target: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fs.existsSync(absoluteTarget)) {
    throw new LuaLSError(
      `Target path does not exist: ${targetPath}`,
      "ERR_TARGET_NOT_FOUND",
      "Verify that the target path exists and is accessible.",
    );
  }

  const binary = options.lualsBin
    ? options.offline
      ? validateOfflineBinary(options.lualsBin, options.lualsVersion ?? "latest")
      : assertValidLuaLSBinary(options.lualsBin, "--luals-bin")
    : await resolveLuaLSBinary(options.lualsVersion, { offline: options.offline });

  let checkDir = absoluteTarget;
  let targetFileOnly: string | null = null;

  if (fs.statSync(absoluteTarget).isFile()) {
    checkDir = path.dirname(absoluteTarget);
    targetFileOnly = absoluteTarget;
  }

  const tempOutputDir = systemPaths.temp;
  fs.mkdirSync(tempOutputDir, { recursive: true });
  const checkOutPath = path.join(
    tempOutputDir,
    `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );

  const args: string[] = [
    `--check=${checkDir}`,
    `--configpath=${path.resolve(configPath)}`,
    `--check_out_path=${checkOutPath}`,
    "--check_format=json",
  ];

  if (options.checklevel) {
    args.push(`--checklevel=${options.checklevel}`);
  }

  let execError: unknown = null;
  try {
    await execFileAsync(binary, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    execError = err;
    logger.debug(
      `[luals] LuaLS process exited with error or non-zero status: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Process may exit with non-zero when diagnostics are found
  }

  let diagnostics: DiagnosticReport = {};
  let parseSucceeded = false;
  if (fs.existsSync(checkOutPath)) {
    try {
      const content = fs.readFileSync(checkOutPath, "utf-8");
      diagnostics = JSON.parse(content) as DiagnosticReport;
      parseSucceeded = true;
    } catch (err) {
      logger.error(
        `[luals] Failed to read or parse diagnostic output from ${checkOutPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      try {
        fs.unlinkSync(checkOutPath);
      } catch (err) {
        logger.debug(
          `[luals] Failed to delete check output file ${checkOutPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (!parseSucceeded) {
    const cacheHint = `(Cache location: ${getCacheDir()})`;
    if (execError) {
      throw new LuaLSError(
        `LuaLS check failed to execute or produce diagnostic output: ${execError instanceof Error ? execError.message : String(execError)}. ${cacheHint}`,
        "ERR_LUALS_EXECUTION",
        "Inspect the debug log with --log-level=debug or run 'nanos-lint clean-cache' to re-fetch LuaLS.",
        { cause: execError },
      );
    }
    throw new LuaLSError(
      `LuaLS check failed to produce diagnostic output at: ${checkOutPath}. ${cacheHint}`,
      "ERR_LUALS_NO_OUTPUT",
      "Ensure the temporary directory is writable and sufficient disk space is available.",
    );
  }

  // If a single file was requested, filter diagnostics to only that file
  if (targetFileOnly) {
    const filtered: DiagnosticReport = {};
    const normalizeComparable = (p: string): string => {
      try {
        if (fs.existsSync(p)) {
          return fs.realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
        }
      } catch (err) {
        logger.debug(
          `[luals] Failed to resolve native realpath for comparison: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return path.resolve(p).replace(/\\/g, "/").toLowerCase();
    };
    const normTarget = normalizeComparable(targetFileOnly);
    for (const [rawUri, diags] of Object.entries(diagnostics)) {
      const filePath = fileUriToPath(rawUri);
      if (normalizeComparable(filePath) === normTarget) {
        filtered[rawUri] = diags;
      }
    }
    diagnostics = filtered;
  } else if (options.paths && options.paths.length > 0) {
    diagnostics = filterReportByTargetPaths(diagnostics, checkDir, options.paths);
  }

  let totalProblems = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let problemFiles = 0;

  for (const [_, diags] of Object.entries(diagnostics)) {
    if (diags.length > 0) {
      problemFiles += 1;
      totalProblems += diags.length;
      for (const d of diags) {
        if (d.severity === 1) {
          totalErrors += 1;
        } else if (d.severity === 2) {
          totalWarnings += 1;
        }
      }
    }
  }

  const passed = totalProblems === 0;
  const filesChecked = countCheckedFiles(targetPath, configPath, options.paths);
  const totalFiles = passed ? filesChecked : problemFiles;

  return {
    passed,
    totalProblems,
    totalErrors,
    totalWarnings,
    totalFiles,
    totalFilesChecked: filesChecked,
    diagnostics,
  };
}
