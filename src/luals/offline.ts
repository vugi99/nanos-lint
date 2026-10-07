import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getPackageRoot } from "../config.js";
import { LuaLSError } from "../errors.js";
import { logger } from "../logger.js";
import { getBaseLuaLSCacheDir, getCacheDir, listCachedLuaLSVersions } from "./cache.js";
import { getPlatformInfo } from "./platform.js";
import { assertValidLuaLSBinary, rethrowLuaLSPermissionError } from "./validation.js";
import { FALLBACK_LUALS_VERSION, sanitizeLuaLSVersion } from "./version.js";

/** Validates an explicit local executable and checks a requested version against its output. */
export function validateOfflineBinary(binary: string, version: string): string {
  const resolved = assertValidLuaLSBinary(binary, "offline local binary");
  if (version !== "latest") {
    const output = execFileSync(resolved, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (!output.split(/\s+/).some((part) => sanitizeLuaLSVersion(part) === version)) {
      throw new LuaLSError(
        `Offline LuaLS binary ${resolved} does not match requested version ${version}.`,
        "ERR_LUALS_OFFLINE",
        `Run 'nanos-lint warmup --luals-version ${version}' online or set LUALS_BIN to a matching binary.`,
      );
    }
  }
  return resolved;
}

/** Resolves local LuaLS assets without changing cache entries or discovering remote releases. */
export function resolveOfflineLuaLS(version: string, cacheDir = getBaseLuaLSCacheDir()): string {
  const requested = version === "latest" ? version : sanitizeLuaLSVersion(version);
  if (!requested) {
    throw new LuaLSError(`Invalid LuaLS version: "${version}".`, "ERR_LUALS_INVALID_VERSION");
  }
  if (process.env.LUALS_BIN) {
    return validateOfflineBinary(process.env.LUALS_BIN, requested);
  }
  const versions = listCachedLuaLSVersions(cacheDir).sort((a, b) =>
    b.localeCompare(a, "en", { numeric: true }),
  );
  const selected = requested === "latest" ? versions[0] : versions.find((v) => v === requested);
  if (selected) {
    logger.info(`[luals] Offline: using cached LuaLS ${selected}.`);
    return path.join(getCacheDir(selected, cacheDir), getPlatformInfo(selected).binaryRelativePath);
  }
  const bundled = path.join(
    getPackageRoot(),
    getPlatformInfo(FALLBACK_LUALS_VERSION).binaryRelativePath,
  );
  if (fs.existsSync(bundled)) {
    return validateOfflineBinary(bundled, requested);
  }
  try {
    const output = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["lua-language-server"],
      { encoding: "utf-8" },
    );
    const found = output.trim().split(/\r?\n/)[0];
    if (found) return validateOfflineBinary(found, requested);
  } catch (err) {
    rethrowLuaLSPermissionError(err, "lua-language-server", "execute");
  }
  throw new LuaLSError(
    `Offline: no usable local LuaLS binary for ${requested}.`,
    "ERR_LUALS_OFFLINE",
    `Run 'nanos-lint warmup${requested === "latest" ? "" : ` --luals-version ${requested}`}' online or set LUALS_BIN to a matching local executable.`,
  );
}
