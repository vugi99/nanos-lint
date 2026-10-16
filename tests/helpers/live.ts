import fs from "node:fs";
import path from "node:path";
import { FALLBACK_LUALS_VERSION, resolveLuaLSBinary, getPlatformInfo } from "../../src/luals.js";
import { resolveAnnotations } from "../../src/annotations.js";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** Live tests run by default and are skipped only for a falsy `NANOS_LIVE_TESTS`. */
export function isLiveTestsEnabled(): boolean {
  const raw = (process.env.NANOS_LIVE_TESTS ?? "").trim().toLowerCase();
  return !DISABLED_VALUES.has(raw);
}

let sharedBinaryPromise: Promise<string> | null = null;

/**
 * Shared LuaLS binary: a cache hit thanks to the global setup, memoized per
 * worker so concurrent tests await the same resolution.
 */
export function getSharedLuaLSBinary(): Promise<string> {
  sharedBinaryPromise ??= resolveLuaLSBinary(FALLBACK_LUALS_VERSION);
  return sharedBinaryPromise;
}

let sharedAnnotationsPromise: Promise<string> | null = null;

/** Resolves (and caches) the annotations file once per worker process. */
export function getSharedAnnotations(): Promise<string> {
  sharedAnnotationsPromise ??= resolveAnnotations();
  return sharedAnnotationsPromise;
}

/** Copies the shared LuaLS install into `baseCacheDir/<version>`; returns its binary path. */
export async function seedCachedLuaLS(baseCacheDir: string, version: string): Promise<string> {
  const info = getPlatformInfo(version);
  const binary = await getSharedLuaLSBinary();
  // Walk up from the binary to the version directory the cache expects.
  const parentHops = info.binaryRelativePath.split(path.sep).length;
  const sourceDir = path.resolve(binary, ...Array(parentHops).fill(".."));
  const targetDir = path.join(baseCacheDir, version);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== "log",
  });
  fs.writeFileSync(path.join(targetDir, ".complete"), version, "utf-8");

  return path.join(targetDir, info.binaryRelativePath);
}
