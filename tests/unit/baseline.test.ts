import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBaseline,
  compareBaseline,
  readBaseline,
  writeBaseline,
} from "../../src/baseline.js";
import { formatReport } from "../../src/reporter.js";
import type { CheckResult, Diagnostic } from "../../src/types.js";

const root = path.resolve("workspace");
const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-baseline-"));
  dirs.push(dir);
  return dir;
}
function diagnostic(
  line = 1,
  message = "Unknown global: foo",
  severity: Diagnostic["severity"] = 2,
): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 3 } },
    severity,
    code: "undefined-global",
    message,
  };
}
function result(items: Diagnostic[], filename = "script.lua"): CheckResult {
  return {
    passed: items.length === 0,
    totalProblems: items.length,
    totalFiles: items.length ? 1 : 0,
    diagnostics: { [pathToFileURL(path.join(root, filename)).href]: items },
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("diagnostic baseline matching", () => {
  it("survives line and whitespace drift while limiting duplicate occurrences", () => {
    const accepted = createBaseline(result([diagnostic(1), diagnostic(2)]), root);
    expect(accepted.entries).toEqual([
      {
        path: "script.lua",
        code: "undefined-global",
        message: "Unknown global: foo",
        severity: 2,
        count: 2,
      },
    ]);
    const moved = compareBaseline(
      result([diagnostic(120, "Unknown   global:\nfoo")]),
      accepted,
      root,
    );
    expect(moved.passed).toBe(true);
    expect(moved.baselineSummary).toEqual({ new: 0, baselined: 1, total: 1, stale: 1 });
    expect(compareBaseline(result([diagnostic(120)]), accepted, root, true).passed).toBe(false);
    const extra = compareBaseline(
      result([diagnostic(99), diagnostic(2), diagnostic(50)]),
      accepted,
      root,
    );
    expect(extra.passed).toBe(false);
    expect(extra.baselineSummary).toEqual({ new: 1, baselined: 2, total: 3, stale: 0 });
    expect(Object.values(extra.diagnostics)[0]?.map((d) => d.baseline)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("recognizes changes in file, code, message or severity as new", () => {
    const original = result([diagnostic()]);
    const baseline = createBaseline(original, root);
    for (const changed of [
      result([diagnostic()], "other.lua"),
      result([{ ...diagnostic(), code: "other" }]),
      result([diagnostic(1, "different")]),
      result([diagnostic(1, undefined, 1)]),
    ]) {
      expect(compareBaseline(changed, baseline, root).baselineSummary?.new).toBe(1);
    }
    expect(Object.values(original.diagnostics)[0]?.[0]?.baseline).toBeUndefined();
    expect(compareBaseline(result([]), baseline, root).passed).toBe(true);
    expect(compareBaseline(result([]), baseline, root, true).passed).toBe(false);
  });

  it("sorts identities and writes stable files independent of insertion order or line positions", () => {
    const first = result([diagnostic(5, "Zulu"), diagnostic(8, "Alpha"), diagnostic(1, "Zulu")]);
    const second = result([
      diagnostic(400, "Alpha"),
      diagnostic(50, "Zulu"),
      diagnostic(12, "Zulu"),
    ]);
    const dir = temp();
    const file = path.join(dir, "nested/baseline.json");
    writeBaseline(file, first, root);
    const bytes = fs.readFileSync(file, "utf-8");
    expect(readBaseline(file)).toEqual(createBaseline(first, root));
    writeBaseline(file, second, root);
    expect(fs.readFileSync(file, "utf-8")).toBe(bytes);
    expect(readBaseline(file).entries.map((e) => e.message)).toEqual(["Alpha", "Zulu"]);
    expect(bytes).not.toContain(root);
    expect(() => writeBaseline(dir, first, root)).toThrow("Cannot write diagnostic baseline");
  });

  it.each([
    "bad JSON",
    "null",
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":{}}',
    '{"version":1,"entries":[null]}',
    '{"version":1,"entries":[{"path":"a.lua","code":"x","message":"x","severity":2,"count":0}]}',
  ])("rejects malformed or incompatible baselines: %s", (content) => {
    const file = path.join(temp(), "baseline.json");
    fs.writeFileSync(file, content);
    expect(() => readBaseline(file)).toThrow("Cannot read diagnostic baseline");
  });

  it("provides a regeneration hint for missing files and rejects duplicate identities", () => {
    const file = path.join(temp(), "missing.json");
    try {
      readBaseline(file);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ERR_BASELINE_READ",
        remedy: expect.stringContaining("--write-baseline"),
      });
    }
    const baseline = createBaseline(result([diagnostic()]), root);
    baseline.entries.push(baseline.entries[0]!);
    fs.writeFileSync(file, JSON.stringify(baseline));
    expect(() => readBaseline(file)).toThrow("Duplicate");
  });

  it("shows only new diagnostics in pretty/GitHub output and tags every JSON diagnostic", () => {
    const baseline = createBaseline(result([diagnostic(1, "accepted warning")]), root);
    const compared = compareBaseline(
      result([diagnostic(1, "accepted warning"), diagnostic(20, "new warning")]),
      baseline,
      root,
    );
    for (const format of ["pretty", "github"] as const) {
      const output = formatReport(compared, format, root, false);
      expect(output).toContain("new warning");
      expect(output).not.toContain("accepted warning");
      expect(output).toContain("1 new, 1 baselined, 2 total");
    }
    const json = JSON.parse(formatReport(compared, "json"));
    expect(Object.values(json.diagnostics).flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseline: true }),
        expect.objectContaining({ baseline: false }),
      ]),
    );
    expect(
      formatReport(
        compareBaseline(result([diagnostic(60, "accepted warning")]), baseline, root),
        "pretty",
        root,
        false,
      ),
    ).toContain("0 new, 1 baselined, 1 total");
  });
});

it("passes GitHub Action baseline inputs as literal shell arguments", () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(
    path.join(dir, "dist/cli.js"),
    "console.log(JSON.stringify(process.argv.slice(2)))",
  );
  const yaml = fs.readFileSync("action.yml", "utf-8");
  const script = yaml
    .split("      run: |\n")[1]!
    .split("\n")
    .map((line) => line.replace(/^ {8}/, ""))
    .join("\n");
  const baselinePath = "some directory/$baseline.json";
  const output = execFileSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ACTION_PATH: dir,
      INPUT_PATH: ".",
      INPUT_CHECKLEVEL: "Warning",
      INPUT_LUALS_VERSION: "latest",
      INPUT_BASELINE: baselinePath,
      INPUT_WRITE_BASELINE: "recorded baseline.json",
      INPUT_BASELINE_STRICT: "true",
    },
  });
  expect(JSON.parse(output)).toEqual(
    expect.arrayContaining([
      `--baseline=${baselinePath}`,
      "--write-baseline=recorded baseline.json",
      "--baseline-strict",
    ]),
  );
});
