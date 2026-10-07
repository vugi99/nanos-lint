import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initWorkspace, loadConfigFile } from "../../src/config.js";
import { runCLI } from "../../src/cli.js";

const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-template-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("preserves custom JSONC settings and adds default realm mappings", () => {
  const dir = workspace();
  const templatePath = path.join(dir, "template.json");
  fs.writeFileSync(
    templatePath,
    '{// team defaults\n"workspace":{"ignoreDir":[".agents"]},"files":{"exclude":["**/Fixtures/**"]},"diagnostics":{"disable":["unused-local"]},"nanos":{"deps":["../collider"]},}',
  );
  const config = loadConfigFile(initWorkspace(dir, { templatePath }));
  expect(config.workspace?.ignoreDir).toEqual([".agents"]);
  expect(config.files?.exclude).toEqual(["**/Fixtures/**"]);
  expect(config.diagnostics?.disable).toEqual(["unused-local"]);
  expect(config.nanos?.deps).toEqual(["../collider"]);
  expect(config.nanos?.realms).toEqual({
    "Server/**": "server",
    "Client/**": "client",
    "Shared/**": "shared",
  });
});

it.each([{}, { "Scripts/**": "server" }])(
  "preserves explicit realms with vendoring: %j",
  async (realms) => {
    const dir = workspace();
    const templatePath = path.join(dir, "template.json");
    const annotations = path.join(dir, "source.lua");
    fs.writeFileSync(annotations, "---@class TeamAPI\n");
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        workspace: { library: ["../definitions"], ignoreDir: [".agents"] },
        nanos: { realms },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      await runCLI(["init", dir, "-t", templatePath, "--vendor", "--annotations", annotations]),
    ).toBe(0);
    const config = loadConfigFile(path.join(dir, ".luarc.json"));
    expect(config.nanos?.realms).toEqual(realms);
    expect(config.workspace?.library).toEqual(["../definitions", ".nanos-lint/annotations.lua"]);
    expect(config.workspace?.ignoreDir).toContain(".agents");
    expect(config.files?.exclude).toContain(".nanos-lint/**");
    expect(fs.readFileSync(path.join(dir, ".nanos-lint/annotations.lua"), "utf-8")).toBe(
      fs.readFileSync(annotations, "utf-8"),
    );
    expect(() => initWorkspace(dir, { templatePath })).toThrow("already exists");
    expect(() => initWorkspace(dir, { templatePath, force: true })).not.toThrow();
  },
);

it.each(["null", "[]", "42", "{bad"])(
  "rejects invalid templates (%s) before writing output",
  (content) => {
    const dir = workspace();
    const templatePath = path.join(dir, "template.json");
    fs.writeFileSync(templatePath, content);
    expect(() => initWorkspace(dir, { templatePath })).toThrow();
    expect(fs.existsSync(path.join(dir, ".luarc.json"))).toBe(false);
  },
);

it("rejects a missing template", () => {
  const dir = workspace();
  expect(() => initWorkspace(dir, { templatePath: path.join(dir, "missing.json") })).toThrow(
    "not found",
  );
});
