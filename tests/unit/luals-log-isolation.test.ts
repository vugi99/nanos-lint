import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultTemplatePath } from "../../src/config.js";
import { LuaLSError } from "../../src/errors.js";
import { runLuaLSCheck } from "../../src/luals.js";
import { systemPaths } from "../../src/paths.js";

/** Emulates LuaLS execution so the per-run `--logpath` lifecycle is observable. */
const { execFileMock, fake } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  fake: { calls: [] as string[][], writesOutput: true },
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../../src/luals/validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/luals/validation.js")>()),
  assertValidLuaLSBinary: (binaryPath: string) => binaryPath,
}));

/** Extracts the `--logpath` directory of a recorded LuaLS invocation. */
function logDirOf(args: string[] | undefined): string {
  const value = args?.find((arg) => arg.startsWith("--logpath="))?.slice("--logpath=".length);
  if (!value) {
    throw new Error(`No --logpath argument recorded: ${JSON.stringify(args)}`);
  }
  return value;
}

describe("LuaLS per-run log isolation", () => {
  let target: string;

  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-logpath-"));
    fs.writeFileSync(path.join(target, "Index.lua"), "local value = 1\nreturn value\n");
    fake.calls.length = 0;
    fake.writesOutput = true;
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          fake.calls.push([...args]);
          const logPath = args
            .find((arg) => arg.startsWith("--logpath="))
            ?.slice("--logpath=".length);
          if (logPath) {
            // LuaLS writes service.log (and threaded check-partial files) into LOGPATH.
            fs.writeFileSync(path.join(logPath, "service.log"), "fake service log");
          }
          if (fake.writesOutput) {
            const outPath = args
              .find((arg) => arg.startsWith("--check_out_path="))
              ?.slice("--check_out_path=".length);
            if (outPath) {
              fs.writeFileSync(outPath, "{}");
            }
          }
          callback(null, "", "");
        },
      );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(target, { recursive: true, force: true });
  });

  it("runs each check in its own --logpath and removes it after a successful run", async () => {
    const result = await runLuaLSCheck(target, getDefaultTemplatePath(), {
      path: target,
      checklevel: "Warning",
      lualsBin: "fake-luals-binary",
    });

    expect(result.passed).toBe(true);
    const logDir = logDirOf(fake.calls[0]);
    expect(path.dirname(logDir)).toBe(path.resolve(systemPaths.temp));
    expect(fs.existsSync(logDir)).toBe(false);
  });

  it("keeps the log directory and names it when LuaLS writes no diagnostic output", async () => {
    fake.writesOutput = false;

    const error: unknown = await runLuaLSCheck(target, getDefaultTemplatePath(), {
      path: target,
      checklevel: "Warning",
      lualsBin: "fake-luals-binary",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LuaLSError);
    const logDir = logDirOf(fake.calls[0]);
    expect((error as Error).message).toContain(logDir);
    expect(fs.readFileSync(path.join(logDir, "service.log"), "utf-8")).toBe("fake service log");
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
