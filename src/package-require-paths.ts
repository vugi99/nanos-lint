import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors.js";
import type { LuaRCConfig } from "./types.js";

/** `runtime.path` search order shipped with nanos-lint and scaffolded by `nanos-lint init`. */
export const DEFAULT_PACKAGE_REQUIRE_PATHS = [
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
];

/** Relative path of the vendored resolver plugin inside a workspace `.nanos-lint/` folder. */
export const VENDORED_PACKAGE_REQUIRE_PLUGIN = ".nanos-lint/package-require.lua";

/** Absolute path of the bundled `Package.Require` resolver plugin. */
export function getBundledPackageRequirePlugin(packageRoot: string): string {
  return path.join(packageRoot, "templates", "package-require.lua").replace(/\\/g, "/");
}

/**
 * Reports whether the workspace declared a `runtime.path` list that is not the bundled
 * defaults.
 *
 * The comparison is by value on purpose: `nanos-lint init` scaffolds the default list
 * verbatim, so testing for key presence made every initialized workspace look customized
 * and skipped the realm-pass filtering and reordering of the shared defaults (#79).
 */
export function hasCustomRuntimePaths(config: LuaRCConfig): boolean {
  const declared: unknown = config.runtime?.path;
  if (declared === undefined) {
    return false;
  }
  if (!Array.isArray(declared)) {
    return true;
  }
  const patterns = declared.filter((pattern): pattern is string => typeof pattern === "string");
  if (
    patterns.length !== declared.length ||
    patterns.length !== DEFAULT_PACKAGE_REQUIRE_PATHS.length
  ) {
    return true;
  }
  return !DEFAULT_PACKAGE_REQUIRE_PATHS.every((pattern) => patterns.includes(pattern));
}

/** Adds the nanos require resolver and adapts the Packages root for a package-root workspace. */
export function configurePackageRequire(
  config: LuaRCConfig,
  workspacePath: string,
  packageRoot: string,
): void {
  const parent = path.dirname(path.resolve(workspacePath));
  const runtimePaths = config.runtime?.path;
  if (
    runtimePaths &&
    path.basename(parent).toLowerCase() === "packages" &&
    DEFAULT_PACKAGE_REQUIRE_PATHS.every((pattern) => runtimePaths.includes(pattern))
  ) {
    config.runtime!.path = runtimePaths.map((pattern) =>
      pattern === "Packages/?" ? "../?" : pattern === "Packages/?.lua" ? "../?.lua" : pattern,
    );
  }

  if (config.runtime?.plugin === undefined || config.runtime.plugin === "") {
    config.runtime = {
      ...(config.runtime ?? {}),
      plugin: getBundledPackageRequirePlugin(packageRoot),
    };
  }
}

/**
 * Vendors the bundled resolver plugin into `<workspace>/.nanos-lint/` and pins
 * `runtime.plugin` to the relative vendored path.
 *
 * Editors read `.luarc.json` directly and never pass through `configurePackageRequire`, so
 * without the vendored copy they resolve current-file-relative `Package.Require` calls
 * differently from the CLI (#79). A configuration that already declares a plugin is kept.
 */
export function vendorPackageRequirePlugin(
  workspacePath: string,
  config: LuaRCConfig,
  packageRoot: string,
): void {
  const declared: unknown = config.runtime?.plugin;
  const declaresPlugin =
    (typeof declared === "string" && declared.trim() !== "") ||
    (Array.isArray(declared) && declared.length > 0);
  if (declaresPlugin) {
    return;
  }

  const source = getBundledPackageRequirePlugin(packageRoot);
  if (!fs.existsSync(source)) {
    throw new ConfigError(
      `Package.Require resolver plugin not found at ${source}.`,
      "ERR_PLUGIN_NOT_FOUND",
      "Reinstall nanos-lint so the bundled templates directory is complete.",
    );
  }

  const target = path.join(workspacePath, VENDORED_PACKAGE_REQUIRE_PLUGIN);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  config.runtime = { ...(config.runtime ?? {}), plugin: VENDORED_PACKAGE_REQUIRE_PLUGIN };
}
