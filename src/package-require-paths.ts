import path from "node:path";
import type { LuaRCConfig } from "./types.js";

const DEFAULT_PACKAGE_REQUIRE_PATHS = [
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
    const pluginPath = path.join(packageRoot, "templates", "package-require.lua");
    config.runtime = {
      ...(config.runtime ?? {}),
      plugin: pluginPath.replace(/\\/g, "/"),
    };
  }
}
