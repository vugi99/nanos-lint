import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCLI } from "../../src/cli.js";
import { getSharedLuaLSBinary, getSharedAnnotations, isLiveTestsEnabled } from "../helpers/live.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!isLiveTestsEnabled())("baseline CLI with live LuaLS", () => {
  it("records, accepts line drift, fails new diagnostics and optionally fails staleness", async () => {
    const binary = await getSharedLuaLSBinary();
    const annotations = await getSharedAnnotations();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-baseline-live-"));
    dirs.push(dir);
    const source = path.join(dir, "script.lua");
    const baseline = path.join(dir, ".nanos-lint/baseline.json");
    vi.stubEnv("LUALS_BIN", binary);
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const args = ["check", dir, "--offline", "--annotations", annotations, "--format=json"];
    fs.writeFileSync(source, "print(baseline_unknown)\n");
    expect(await runCLI([...args, "--write-baseline", baseline])).toBe(0);
    const recorded = fs.readFileSync(baseline, "utf-8");
    expect(JSON.parse(recorded).entries.length).toBeGreaterThan(0);
    expect(await runCLI([...args, "--write-baseline", baseline, "--no-fail"])).toBe(0);
    expect(fs.readFileSync(baseline, "utf-8")).toBe(recorded);
    fs.writeFileSync(source, "\n\n\nprint(baseline_unknown)\n");
    expect(await runCLI([...args, "--baseline", baseline])).toBe(0);
    const matched = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(matched.baselineSummary.new).toBe(0);
    expect(matched.baselineSummary.baselined).toBeGreaterThan(0);
    fs.appendFileSync(source, "print(new_unknown)\n");
    expect(await runCLI([...args, "--baseline", baseline])).toBe(1);
    const changed = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(changed.baselineSummary.new).toBeGreaterThan(0);
    expect(Object.values(changed.diagnostics).flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseline: true }),
        expect.objectContaining({ baseline: false }),
      ]),
    );
    expect(await runCLI([...args, "--baseline", baseline, "--no-fail"])).toBe(0);
    fs.writeFileSync(source, "print('clean')\n");
    expect(await runCLI([...args, "--baseline", baseline])).toBe(0);
    expect(await runCLI([...args, "--baseline", baseline, "--baseline-strict"])).toBe(1);
    expect(await runCLI([...args, "--baseline", baseline, "--baseline-strict", "--no-fail"])).toBe(
      0,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("rejects invalid baseline options and unreadable baselines before dependency resolution", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn(() => {
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", fetch);
  for (const flags of [
    ["--baseline-strict"],
    ["--baseline", "missing.json", "--write-baseline", "new.json"],
    ["--baseline", "missing.json"],
  ]) {
    expect(await runCLI(["check", ".", ...flags])).toBe(1);
  }
  expect(log.mock.calls.flat().join("\n")).toContain("--write-baseline");
  expect(fetch).not.toHaveBeenCalled();
});
