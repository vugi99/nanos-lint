import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import type { CacheStatusReport } from "../../src/cache-status.js";
import { FALLBACK_LUALS_VERSION, getPlatformInfo } from "../../src/luals.js";
import { getSharedAnnotations, isLiveTestsEnabled, seedCachedLuaLS } from "../helpers/live.js";
import { applyTestCacheEnv } from "../helpers/test-cache.js";

it.skipIf(!isLiveTestsEnabled())(
  "runs the built CLI offline with release-bundle assets and an empty cache",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-offline-bundle-"));
    try {
      const binary = await seedCachedLuaLS(path.join(root, "seed"), FALLBACK_LUALS_VERSION);
      const annotations = await getSharedAnnotations();
      const bundle = path.join(root, "bundle");
      const binaryHops = getPlatformInfo(FALLBACK_LUALS_VERSION).binaryRelativePath.split(
        path.sep,
      ).length;
      fs.cpSync(path.resolve(binary, ...Array(binaryHops).fill("..")), bundle, { recursive: true });
      for (const directory of ["dist", "templates"]) {
        fs.cpSync(path.resolve(directory), path.join(bundle, directory), { recursive: true });
      }
      fs.copyFileSync("package.json", path.join(bundle, "package.json"));
      fs.copyFileSync(annotations, path.join(bundle, "annotations.lua"));
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, "main.lua"), "print('offline bundle')\n");
      const preload = path.join(root, "no-network.mjs");
      fs.writeFileSync(
        preload,
        "globalThis.fetch = () => { process.stderr.write('Unexpected network request'); process.exit(91); };\n",
      );
      const env = {
        ...process.env,
        LUALS_BIN: "",
        NANOS_ANNOTATIONS_PATH: "",
        NANOS_ANNOTATIONS: "",
      };
      const cacheRoot = path.join(root, "empty-cache");
      applyTestCacheEnv(env, cacheRoot);
      const invoke = (args: string[]) =>
        execFileSync(
          process.execPath,
          ["--import", pathToFileURL(preload).href, path.join(bundle, "dist/cli.js"), ...args],
          { cwd: workspace, env, encoding: "utf-8", timeout: 30_000 },
        );
      expect(invoke(["warmup", "--offline"])).toContain(path.join(bundle, "annotations.lua"));
      const report = JSON.parse(invoke(["check", ".", "--offline", "--format=json"]));
      expect(report.passed).toBe(true);
      expect(report.totalFilesChecked).toBe(1);
      const cache = JSON.parse(invoke(["cache", "status", "--json"])) as CacheStatusReport;
      expect(fs.existsSync(cache.cacheDirectory)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
