import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../logger.js";
import { DEFAULT_LUALS_VERSION, resolveLuaLSVersion } from "./version.js";
import { getPlatformInfo } from "./platform.js";
import { findExistingLuaLSDir, getBaseLuaLSCacheDir, getCacheDir } from "./cache.js";
import {
  rethrowLuaLSPermissionError,
  isBinaryValid,
  MAX_DECOMPRESSED_SIZE_BYTES,
  validateArchiveMembers,
  getTarBinary,
  escapePowerShellSingleQuote,
} from "./validation.js";
import { LuaLSError } from "../errors.js";
import { formatBytes, getDirectorySize } from "../paths.js";
import { withFileLock } from "../lock.js";
import { cancelResponseBody, guardedFetch, parseDeclaredContentLength } from "../download-guard.js";
import { createProgressBar, createSpinner, formatTransferSummary } from "../terminal-progress.js";

export {
  isBinaryValid,
  MAX_DECOMPRESSED_SIZE_BYTES,
  MAX_ARCHIVE_MEMBER_COUNT,
  parseTarTvSize,
  validateArchiveMembers,
  getTarBinary,
  escapePowerShellSingleQuote,
} from "./validation.js";

export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const MAX_ARCHIVE_SIZE_BYTES = 150 * 1024 * 1024; // 150 MB

/** Re-exported so the allowlist policy has a single definition (see `src/download-guard.ts`). */
export { ALLOWED_DOWNLOAD_DOMAINS, isAllowedDownloadUrl } from "../download-guard.js";

/** Chunk size used when hashing an archive, so a 150 MB asset is never buffered whole. */
const HASH_CHUNK_SIZE_BYTES = 1024 * 1024;

/**
 * Calculates the SHA-256 hash of a file on disk in bounded memory.
 */
export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_SIZE_BYTES);
    let position = 0;
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const execFileAsync = promisify(execFile);

/**
 * Enforces a maximum byte count on an asynchronous download stream.
 */
export async function* limitDownloadStream(
  source: AsyncIterable<Uint8Array | Buffer>,
): AsyncGenerator<Uint8Array | Buffer, void, unknown> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > MAX_ARCHIVE_SIZE_BYTES) {
      throw new LuaLSError(
        `Download exceeded maximum allowed size of ${MAX_ARCHIVE_SIZE_BYTES} bytes`,
        "ERR_LUALS_DOWNLOAD",
        "Verify the LuaLS release asset size or specify a local binary with LUALS_BIN.",
      );
    }
    yield chunk;
  }
}

/** Reports cumulative transferred bytes while passing a download stream through unchanged. */
export async function* trackDownloadProgress(
  source: AsyncIterable<Uint8Array | Buffer>,
  onProgress: (transferred: number) => void,
): AsyncGenerator<Uint8Array | Buffer, void, unknown> {
  let transferred = 0;
  for await (const chunk of source) {
    transferred += chunk.length;
    onProgress(transferred);
    yield chunk;
  }
}

export interface DownloadOptions {
  reuseExisting?: boolean;
  /** Base directory searched for an installed copy when reusing. Defaults to the system cache. */
  cacheDir?: string;
}

/** Returns whether a cache directory holds a complete, executable LuaLS installation. */
function isCompleteLuaLSInstall(
  binaryPath: string,
  completeMarker: string,
  version: string,
): boolean {
  if (!fs.existsSync(binaryPath) || !fs.existsSync(completeMarker)) {
    return false;
  }
  try {
    return fs.readFileSync(completeMarker, "utf-8").trim() === version && isBinaryValid(binaryPath);
  } catch (err) {
    rethrowLuaLSPermissionError(err, completeMarker);
    logger.debug(
      `[luals] Failed to read complete marker at ${completeMarker}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Downloads, verifies, and extracts the LuaLS release archive for the current platform.
 *
 * Concurrent callers targeting the same cache directory serialize on a version lock
 * (`.luals-<version>.lock`) and the completion check is repeated once the lock is held,
 * so exactly one worker downloads while the others reuse the promoted directory (#7).
 */
export async function downloadAndExtractLuaLS(
  version: string = DEFAULT_LUALS_VERSION,
  targetDir?: string,
  options?: DownloadOptions,
): Promise<string> {
  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);
  const destDir = targetDir || getCacheDir(resolvedVersion);
  const binaryPath = path.join(destDir, info.binaryRelativePath);
  const completeMarker = path.join(destDir, ".complete");

  if (
    options?.reuseExisting !== false &&
    isCompleteLuaLSInstall(binaryPath, completeMarker, resolvedVersion)
  ) {
    return binaryPath;
  }

  const lockPath = path.join(path.dirname(destDir), `.${path.basename(destDir)}.lock`);
  return withFileLock(
    lockPath,
    () =>
      downloadAndPromoteLuaLS(resolvedVersion, info, destDir, binaryPath, completeMarker, options),
    { label: `LuaLS ${resolvedVersion}` },
  );
}

/** Performs the locked download/extraction work, skipping it when another worker won. */
async function downloadAndPromoteLuaLS(
  resolvedVersion: string,
  info: ReturnType<typeof getPlatformInfo>,
  destDir: string,
  binaryPath: string,
  completeMarker: string,
  options?: DownloadOptions,
): Promise<string> {
  if (
    options?.reuseExisting !== false &&
    isCompleteLuaLSInstall(binaryPath, completeMarker, resolvedVersion)
  ) {
    logger.info(`[luals] LuaLS ${resolvedVersion} was installed by a concurrent run; reusing it.`);
    return binaryPath;
  }

  if (fs.existsSync(destDir)) {
    if (
      options?.reuseExisting !== false &&
      fs.existsSync(binaryPath) &&
      fs.existsSync(completeMarker)
    ) {
      try {
        const storedVersion = fs.readFileSync(completeMarker, "utf-8").trim();
        if (storedVersion === resolvedVersion && isBinaryValid(binaryPath)) {
          return binaryPath;
        }
      } catch (err) {
        rethrowLuaLSPermissionError(err, completeMarker);
        logger.debug(
          `[luals] Failed to read complete marker at ${completeMarker}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // destDir exists but is invalid/corrupted/stale or reuseExisting is false: clean it up before downloading
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch (err) {
      rethrowLuaLSPermissionError(err, destDir);
      logger.warn(
        `[luals] Failed to remove stale or invalid cache dir ${destDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const tempDir = path.join(
    parentDir,
    `.${path.basename(destDir)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tempDir, { recursive: true });

  const canReuse = options?.reuseExisting !== false;
  const existingSourceDir = canReuse
    ? findExistingLuaLSDir(resolvedVersion, options?.cacheDir ?? getBaseLuaLSCacheDir())
    : null;
  const shouldCopyFromExisting =
    existingSourceDir !== null && path.resolve(existingSourceDir) !== path.resolve(destDir);

  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${resolvedVersion}/${info.assetName}`;
  const archivePath = path.join(tempDir, info.assetName);

  try {
    if (shouldCopyFromExisting) {
      logger.info(
        `[luals] Reusing existing LuaLS ${resolvedVersion} installation from ${existingSourceDir}...`,
      );
      fs.cpSync(existingSourceDir, tempDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== "log",
      });
    } else {
      logger.info(`[luals] Downloading LuaLS ${resolvedVersion} from ${url}...`);

      let response: Response | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // The guard resolves redirects hop by hop, so the release asset is never requested
          // from a host the allowlist has not approved *before* that host is contacted.
          const outcome = await guardedFetch(url, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          });
          if (!outcome.ok || !outcome.response) {
            if (outcome.reason !== "network-error") {
              // A refused hop is a policy verdict, not a transient failure: never retry it.
              const blockedMessage = `Redirect to untrusted URL blocked: ${outcome.url ?? url}`;
              logger.warn(`[luals] ${blockedMessage}`);
              throw new LuaLSError(
                blockedMessage,
                "ERR_LUALS_DOWNLOAD",
                "Download redirects must stay on allowlisted HTTPS GitHub hosts.",
              );
            }
            lastErr = outcome.error ?? new Error(`Failed to download ${url}`);
          } else if (outcome.response.ok && outcome.response.body) {
            response = outcome.response;
            break;
          } else {
            const res = outcome.response;
            await cancelResponseBody(res);
            lastErr = new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
          }
        } catch (err) {
          if (err instanceof LuaLSError) {
            throw err;
          }
          lastErr = err;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }

      if (!response || !response.body) {
        throw new LuaLSError(
          `Failed to download LuaLS from ${url}${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ""}`,
          "ERR_LUALS_DOWNLOAD",
          "Check your network connection or specify a custom binary with LUALS_BIN.",
          { cause: lastErr },
        );
      }

      const contentLengthHeader = response.headers?.get?.("content-length");
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > MAX_ARCHIVE_SIZE_BYTES) {
          await response.body.cancel();
          throw new LuaLSError(
            `Archive size (${contentLength} bytes) exceeds maximum limit (${MAX_ARCHIVE_SIZE_BYTES} bytes)`,
            "ERR_LUALS_DOWNLOAD",
            "Verify the LuaLS release asset size or specify a local binary with LUALS_BIN.",
          );
        }
      }
      const declaredTotal = parseDeclaredContentLength(response);

      const downloadStartedAt = Date.now();
      let transferred = 0;
      const progress = createProgressBar({
        label: `[luals] Downloading ${info.assetName}`,
        total: declaredTotal,
        announce: false,
      });
      const fileStream = fs.createWriteStream(archivePath);
      try {
        const streamSource =
          typeof (Readable as unknown as { fromWeb?: (stream: unknown) => Readable }).fromWeb ===
            "function" && !("pipe" in response.body)
            ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
            : (response.body as unknown as Readable);

        await pipeline(
          streamSource,
          limitDownloadStream,
          (source: AsyncIterable<Uint8Array | Buffer>) =>
            trackDownloadProgress(source, (bytes) => {
              transferred = bytes;
              progress.update(bytes, declaredTotal);
            }),
          fileStream,
        );
      } catch (streamErr) {
        progress.fail();
        try {
          if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
          }
        } catch (unlinkErr) {
          void unlinkErr;
        }
        if (streamErr instanceof LuaLSError) {
          throw streamErr;
        }
        throw new LuaLSError(
          `Failed to download LuaLS from ${url}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
          "ERR_LUALS_DOWNLOAD",
          "Check your network connection or specify a custom binary with LUALS_BIN.",
          { cause: streamErr },
        );
      }
      progress.finish(
        `[luals] Downloaded ${info.assetName} (${formatTransferSummary(transferred, Date.now() - downloadStartedAt)})`,
      );

      // Audit trail only: the digest is recorded so a downloaded asset can be
      // compared out of band. It is not checked against a pinned value, because
      // upstream publishes no signed checksums (see SECURITY.md).
      const archiveSha256 = computeFileSha256(archivePath);
      logger.info(`[luals] Downloaded ${info.assetName} (SHA-256 ${archiveSha256})`);

      logger.info(`[luals] Extracting to ${destDir}...`);

      const spinner = createSpinner({
        label: `[luals] Extracting ${info.assetName}`,
        announce: false,
      });
      spinner.start();
      let extractedSize: number;
      try {
        await validateArchiveMembers(archivePath);

        try {
          // Both Windows 10+ and UNIX systems have tar built in
          const tarArgs =
            process.platform === "win32"
              ? ["-xf", path.basename(archivePath), "-C", tempDir]
              : [
                  "-xf",
                  path.basename(archivePath),
                  "--no-same-owner",
                  "--no-same-permissions",
                  "-C",
                  tempDir,
                ];
          await execFileAsync(getTarBinary(), tarArgs, { cwd: path.dirname(archivePath) });
        } catch (tarErr) {
          // Fallback for PowerShell Expand-Archive on Windows if tar fails.
          // `validateArchiveMembers()` reconciled the central directory with the
          // archive's local file headers before this point, so both extractors see
          // the same members: retrying only changes which tool reports a failure.
          if (process.platform === "win32" && info.assetName.endsWith(".zip")) {
            await execFileAsync("powershell.exe", [
              "-NoProfile",
              "-Command",
              `Expand-Archive -Path '${escapePowerShellSingleQuote(archivePath)}' -DestinationPath '${escapePowerShellSingleQuote(tempDir)}' -Force`,
            ]);
          } else {
            throw tarErr;
          }
        }

        spinner.updateText("[luals] Verifying extracted files");
        extractedSize = getDirectorySize(tempDir);
        if (extractedSize > MAX_DECOMPRESSED_SIZE_BYTES) {
          throw new LuaLSError(
            `Extracted archive size (${extractedSize} bytes) exceeds maximum limit (${MAX_DECOMPRESSED_SIZE_BYTES} bytes)`,
            "ERR_LUALS_EXTRACT",
            "Run 'nanos-lint clean-cache' and ensure there is sufficient disk space.",
          );
        }

        // Cleanup archive file
        try {
          fs.unlinkSync(archivePath);
        } catch (err) {
          logger.debug(
            `[luals] Failed to delete temporary archive ${archivePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        spinner.stop(`[luals] Extracted ${formatBytes(extractedSize)} to ${destDir}`);
      } catch (extractErr) {
        spinner.fail();
        throw extractErr;
      }
    }

    const tempBinaryPath = path.join(tempDir, info.binaryRelativePath);

    // Verify file exists before checking attributes
    if (!fs.existsSync(tempBinaryPath)) {
      throw new LuaLSError(
        `Failed to extract valid LuaLS binary to expected path: ${tempBinaryPath}`,
        "ERR_LUALS_EXTRACT",
        "Run 'nanos-lint clean-cache' and ensure there is sufficient disk space.",
      );
    }

    // Verify binary is a regular file and not a symlink to prevent chmod following archive-planted symlinks
    const lstat = fs.lstatSync(tempBinaryPath);
    if (lstat.isSymbolicLink()) {
      throw new LuaLSError(
        `Extracted binary at '${tempBinaryPath}' is a symbolic link. Refusing to chmod or execute archive-planted symlinks.`,
        "ERR_LUALS_EXTRACT",
        "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
      );
    }
    if (!lstat.isFile()) {
      throw new LuaLSError(
        `Extracted binary at '${tempBinaryPath}' is not a regular file.`,
        "ERR_LUALS_EXTRACT",
        "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
      );
    }

    // Verify that the real path does not escape the extraction directory. Both
    // sides are canonicalized, because the extraction directory itself can be
    // reached through symlinks (for example `/var` -> `/private/var` on macOS,
    // where `os.tmpdir()` lives), which would otherwise reject every download.
    const realBinaryPath = fs.realpathSync(tempBinaryPath);
    const resolvedTemp = fs.realpathSync(tempDir);
    if (!realBinaryPath.startsWith(resolvedTemp + path.sep) && realBinaryPath !== resolvedTemp) {
      throw new LuaLSError(
        `Extracted binary path escapes extraction directory: ${realBinaryPath}`,
        "ERR_LUALS_EXTRACT",
        "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
      );
    }

    // Make executable on unix
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tempBinaryPath, 0o755);
      } catch (err) {
        logger.warn(
          `[luals] Failed to chmod binary at ${tempBinaryPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (lstat.size < 100_000) {
      throw new LuaLSError(
        `Failed to extract valid LuaLS binary to expected path: ${tempBinaryPath}`,
        "ERR_LUALS_EXTRACT",
        "Run 'nanos-lint clean-cache' and ensure there is sufficient disk space.",
      );
    }
    if (!isBinaryValid(tempBinaryPath)) {
      throw new LuaLSError(
        `Extracted LuaLS binary at ${tempBinaryPath} is invalid or non-functional.`,
        "ERR_LUALS_INVALID_BINARY",
        "Run 'nanos-lint clean-cache' to remove corrupted downloads or set LUALS_BIN to a custom binary.",
      );
    }

    // Write .complete marker in tempDir before promotion
    fs.writeFileSync(path.join(tempDir, ".complete"), resolvedVersion, "utf-8");

    // Atomic promotion with retry and race resolution
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tempDir, destDir);
        break;
      } catch (renameErr) {
        if (fs.existsSync(binaryPath) && isBinaryValid(binaryPath)) {
          // A concurrent worker already promoted destDir successfully
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (err) {
            logger.debug(
              `[luals] Failed to remove temp directory after concurrent promotion: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          logger.info(`[luals] Ready: ${binaryPath}`);
          return binaryPath;
        }
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        } else {
          // Clean up broken destDir if partially created or left corrupted during failed promotion
          if (
            fs.existsSync(destDir) &&
            (!fs.existsSync(binaryPath) || !fs.existsSync(completeMarker))
          ) {
            try {
              fs.rmSync(destDir, { recursive: true, force: true });
            } catch (err) {
              logger.warn(
                `[luals] Failed to clean up broken destination directory ${destDir}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          throw renameErr;
        }
      }
    }

    logger.info(`[luals] Ready: ${binaryPath}`);
    return binaryPath;
  } finally {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.debug(
          `[luals] Failed to clean up temporary directory ${tempDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
