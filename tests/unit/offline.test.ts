import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLuaLSBinary, runLuaLSCheck } from "../../src/luals.js";
import { resolveAnnotations } from "../../src/annotations.js";
import { runCLI } from "../../src/cli.js";
import { isLiveTestsEnabled, seedCachedLuaLS, getSharedAnnotations } from "../helpers/live.js";

const temporary: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-offline-"));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("offline dependency failures", () => {
  it("rejects absent or corrupt annotations without requests or cache deletion", async () => {
    const cacheDir = temp();
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(resolveAnnotations({ cacheDir, offline: true })).rejects.toThrow("Offline");
    const file = path.join(cacheDir, "annotations.lua");
    fs.writeFileSync(file, "");
    await expect(resolveAnnotations({ cacheDir, offline: true })).rejects.toThrow("Offline");
    expect(fs.existsSync(file)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts --offline before and after check/default targets", async () => {
    vi.stubEnv("NANOS_ANNOTATIONS_PATH", path.join(temp(), "absent.lua"));
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const args of [
      ["--offline", "."],
      ["check", ".", "--offline"],
      [".", "--offline"],
    ]) {
      expect(await runCLI(args)).toBe(1);
      expect(output.mock.calls.flat().join("\n")).not.toContain("unknown option");
    }
  });
});

describe.skipIf(!isLiveTestsEnabled())("offline with local LuaLS", () => {
  it("uses stale assets, chooses deterministically, preserves metadata and executes diagnostics", async () => {
    const cacheDir = temp();
    const binary = await seedCachedLuaLS(cacheDir, "3.19.1");
    await seedCachedLuaLS(cacheDir, "3.18.0");
    const annotations = await getSharedAnnotations();
    const annotationsCache = temp();
    fs.copyFileSync(annotations, path.join(annotationsCache, "annotations.lua"));
    const meta = '{"lastChecked":"2000-01-01","commitId":"stale"}';
    fs.writeFileSync(path.join(annotationsCache, "metadata.json"), meta);
    fs.writeFileSync(path.join(cacheDir, "metadata.json"), "invalid stale metadata");
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await resolveLuaLSBinary("latest", { offline: true, cacheDir })).toBe(binary);
    expect(await resolveLuaLSBinary("v3.19.1", { offline: true, cacheDir })).toBe(binary);
    await expect(resolveLuaLSBinary("99.0.0", { offline: true, cacheDir })).rejects.toThrow(
      "Offline",
    );
    expect(await resolveAnnotations({ offline: true, cacheDir: annotationsCache })).toBe(
      path.join(annotationsCache, "annotations.lua"),
    );
    expect(fs.readFileSync(path.join(annotationsCache, "metadata.json"), "utf-8")).toBe(meta);
    expect(fs.readFileSync(path.join(cacheDir, "metadata.json"), "utf-8")).toBe(
      "invalid stale metadata",
    );
    const result = await runLuaLSCheck(
      path.resolve("tests/fail"),
      path.resolve("templates/.luarc.json"),
      {
        lualsBin: binary,
        offline: true,
      },
    );
    expect(result.totalProblems).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports explicit binaries and annotations and rejects version mismatches", async () => {
    const cacheDir = temp();
    const binary = await seedCachedLuaLS(cacheDir, "3.19.1");
    const annotations = await getSharedAnnotations();
    vi.stubEnv("LUALS_BIN", binary);
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await resolveLuaLSBinary("latest", { offline: true })).toBe(binary);
    await expect(resolveLuaLSBinary("99.0.0", { offline: true })).rejects.toThrow("does not match");
    expect(await resolveAnnotations({ customPath: annotations, offline: true })).toBe(annotations);
    expect(fetch).not.toHaveBeenCalled();
  });
});
