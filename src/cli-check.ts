import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceConfig, loadUserConfig } from "./config.js";
import { planRealmCheck, runRealmAwareCheck, type RealmSelection } from "./realms.js";
import { resolvePackageDependencies } from "./deps.js";
import { resolveAnnotations } from "./annotations.js";
import { runLuaLSCheck } from "./luals.js";
import { readBaseline, writeBaseline, compareBaseline, createBaseline } from "./baseline.js";
import { formatReport } from "./reporter.js";
import { logger, LogLevel, isValidLogLevel } from "./logger.js";
import { writeOutput } from "./output.js";
import { setProgressMode } from "./terminal-progress.js";
import { ConfigError } from "./errors.js";
import { computeUnrequestedExclusions, resolveCheckTargets } from "./target-resolver.js";
import type { CheckOptions, DiagnosticSeverity } from "./types.js";

export interface CheckCommandOptions {
  checklevel: DiagnosticSeverity;
  config?: string;
  annotations?: string;
  format?: "pretty" | "json" | "github";
  lualsVersion: string;
  fail: boolean;
  logLevel?: string;
  progress?: boolean;
  github?: boolean;
  offline?: boolean;
  baseline?: string;
  writeBaseline?: string;
  baselineStrict?: boolean;
  ignore?: string[];
  dep?: string[];
  realm?: RealmSelection;
}

/** Executes the check command on target paths with specified options. */
export async function executeCheckCommand(
  targetPaths: string[] = ["."],
  opts: CheckCommandOptions,
  setExitCode: (code: number) => void,
): Promise<void> {
  if (opts.logLevel && isValidLogLevel(opts.logLevel)) {
    logger.setLevel(opts.logLevel as LogLevel);
  }

  const rawPaths = targetPaths && targetPaths.length > 0 ? targetPaths : ["."];
  const { rootPath, targetPaths: canonicalTargets } = resolveCheckTargets(rawPaths);

  const format = opts.github
    ? "github"
    : opts.format || (process.env.GITHUB_ACTIONS ? "github" : "pretty");

  if (format === "json") {
    setProgressMode("off");
    logger.setDiagnosticStream("stderr");
  }

  if ((opts.baseline && opts.writeBaseline) || (opts.baselineStrict && !opts.baseline)) {
    throw new ConfigError(
      "Use either --baseline or --write-baseline; --baseline-strict requires --baseline.",
      "ERR_BASELINE_OPTIONS",
    );
  }
  const baseline = opts.baseline ? readBaseline(path.resolve(opts.baseline)) : undefined;

  const checkOptions: CheckOptions = {
    offline: opts.offline,
    path: rootPath,
    paths: canonicalTargets,
    configpath: opts.config,
    checklevel: opts.checklevel,
    format,
    lualsVersion: opts.lualsVersion,
    failOnError: opts.fail !== false,
    ignore: opts.ignore,
    deps: opts.dep,
  };

  if (opts.config) {
    const resolvedConfig = path.resolve(opts.config);
    if (!fs.existsSync(resolvedConfig)) {
      throw new ConfigError(
        `Configuration file not found: ${resolvedConfig}`,
        "ERR_CONFIG_NOT_FOUND",
        "Verify the path passed to --config exists and is readable.",
      );
    }
  }

  const annotationsPath = await resolveAnnotations({
    customPath: opts.annotations,
    offline: opts.offline,
  });

  const userConfig = loadUserConfig(rootPath, checkOptions.configpath);
  const realmPlan = planRealmCheck({
    targetPath: rootPath,
    userConfig,
    selection: opts.realm ?? "all",
    annotationsPath,
    customConfigPath: checkOptions.configpath,
    ignore: checkOptions.ignore,
    targetPaths: canonicalTargets,
    cliDeps: checkOptions.deps,
  });

  let result;
  if (realmPlan) {
    try {
      result = await runRealmAwareCheck(realmPlan, rootPath, checkOptions);
    } finally {
      realmPlan.cleanup();
    }
  } else {
    const resolvedDeps = resolvePackageDependencies(rootPath, userConfig, checkOptions.deps);
    const unrequestedExclusions = computeUnrequestedExclusions(rootPath, canonicalTargets);
    const resolved = resolveWorkspaceConfig(rootPath, checkOptions.configpath, {
      ignore: checkOptions.ignore,
      annotationsPath,
      dependencyLibraries: resolvedDeps.all,
      unrequestedExclusions,
    });
    try {
      result = await runLuaLSCheck(rootPath, resolved.configPath, checkOptions);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        try {
          fs.unlinkSync(resolved.configPath);
        } catch (err) {
          logger.warn(
            `Failed to clean up temporary config file ${resolved.configPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (opts.writeBaseline) {
    writeBaseline(opts.writeBaseline, result, rootPath);
    result = compareBaseline(result, createBaseline(result, rootPath), rootPath);
  } else if (baseline) {
    result = compareBaseline(result, baseline, rootPath, opts.baselineStrict);
  }

  const output = formatReport(result, checkOptions.format, process.cwd());
  if (output) {
    writeOutput(output);
  }

  if (!result.passed && checkOptions.failOnError) {
    setExitCode(1);
  } else {
    setExitCode(0);
  }
}
