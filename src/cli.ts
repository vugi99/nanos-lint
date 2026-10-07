import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { initWorkspace, getPackageRoot } from "./config.js";
import { collectDeps } from "./deps.js";
import { resolveAnnotations, readAnnotationsMetadata, copyAnnotations } from "./annotations.js";
import { resolveLuaLSBinary, DEFAULT_LUALS_VERSION } from "./luals.js";
import { cleanCache, systemPaths } from "./paths.js";
import { getCacheStatus, formatCacheStatusPretty } from "./cache-status.js";
import { logger, LogLevel, isValidLogLevel, DEFAULT_LOG_LEVEL } from "./logger.js";
import { writeOutput } from "./output.js";
import { setProgressMode } from "./terminal-progress.js";
import { NanosLintError } from "./errors.js";
import { executeCheckCommand, type CheckCommandOptions } from "./cli-check.js";

/** Retrieves the formatted package name and version string from package.json. */
function getVersionString(): string {
  const root = getPackageRoot();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    return `nanos-lint v${pkg.version}`;
  } catch (err) {
    logger.debug(
      `Could not read version from package.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "nanos-lint v1.0.0";
  }
}

/** Accumulates repeatable --ignore pattern arguments, splitting by comma and newline. */
export function collectIgnorePatterns(val: string, prev?: string[]): string[] {
  const parts = val
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (prev ?? []).concat(parts);
}

export interface CreateProgramOptions {
  setExitCode?: (code: number) => void;
}

/** Constructs and configures the top-level Commander program and its CLI subcommands. */
export function createProgram(options?: CreateProgramOptions): Command {
  const setExitCode = options?.setExitCode ?? (() => {});
  const program = new Command("nanos-lint");

  program
    .description("Linter and type-checker for nanos world Lua scripts")
    .version(getVersionString(), "-v, --version", "Show version information")
    .addOption(
      new Option("-l, --log-level <level>", "Logging level: error, warn, info, debug, silent")
        .choices(["error", "warn", "info", "debug", "silent"])
        .default(DEFAULT_LOG_LEVEL),
    )
    .option("--offline", "Use local dependencies only; never access the network")
    .option(
      "--no-progress",
      "Disable the interactive download, extraction and realm derivation progress display",
    )
    .hook("preAction", (thisCommand, actionCommand) => {
      const target = actionCommand || thisCommand;
      const opts = target.optsWithGlobals
        ? target.optsWithGlobals<{ logLevel?: string; progress?: boolean }>()
        : target.opts<{ logLevel?: string; progress?: boolean }>();
      if (opts.logLevel && isValidLogLevel(opts.logLevel)) {
        logger.setLevel(opts.logLevel as LogLevel);
      }
      if (opts.progress === false) {
        setProgressMode("off");
      }
    })
    .exitOverride()
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({
      writeOut: (str) => console.log(str.trimEnd()),
      writeErr: (str) => logger.error(str.trimEnd()),
    });

  program
    .command("check [paths...]", { isDefault: true })
    .description("Check workspace files or directories (default command)")
    .addOption(
      new Option(
        "--checklevel <level>",
        "Minimum diagnostic level: Error, Warning, Information, Hint",
      )
        .choices(["Error", "Warning", "Information", "Hint"])
        .default("Warning"),
    )
    .option("--config <path>", "Path to custom .luarc.json configuration file")
    .option("--annotations <path>", "Path to custom annotations.lua file")
    .addOption(
      new Option(
        "--format <format>",
        "Output format: pretty, json, github (default: pretty, auto-detects GitHub Actions)",
      ).choices(["pretty", "json", "github"]),
    )
    .option(
      "-i, --ignore <pattern>",
      "Files or directories to ignore (supports glob patterns, repeatable)",
      collectIgnorePatterns,
    )
    .option(
      "-d, --dep <path>",
      "Path to package dependency or Lua definition file (repeatable)",
      collectDeps,
    )
    .option(
      "--luals-version <ver>",
      `Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})`,
      DEFAULT_LUALS_VERSION,
    )
    .option("--no-fail", "Do not exit with code 1 if diagnostics are found")
    .addOption(
      new Option(
        "-l, --log-level <level>",
        "Logging level: error, warn, info, debug, silent",
      ).choices(["error", "warn", "info", "debug", "silent"]),
    )
    .option("--github", "Output in GitHub Actions format (shortcut for --format=github)")
    .addOption(
      new Option(
        "--realm <realm>",
        "Execution realm to check: all, client, server, shared (default: all)",
      )
        .choices(["all", "client", "server", "shared"])
        .default("all"),
    )
    .action(async (targetPaths: string[] = ["."], opts: CheckCommandOptions, cmd: Command) => {
      opts.offline = cmd.optsWithGlobals().offline;
      await executeCheckCommand(targetPaths, opts, setExitCode);
    });

  program
    .command("init [path]")
    .description("Scaffold a .luarc.json configuration in the workspace")
    .option("-f, --force", "Overwrite existing .luarc.json configuration")
    .option(
      "--vendor",
      "Vendor annotations.lua into .nanos-lint/ inside workspace for portable standalone editor setup",
    )
    .option("--annotations <path>", "Path to custom annotations.lua file (requires --vendor)")
    .action(
      async (
        targetPath: string = ".",
        opts: {
          force?: boolean;
          annotations?: string;
          vendor?: boolean;
          offline?: boolean;
        },
        cmd: Command,
      ) => {
        opts.offline = cmd.optsWithGlobals().offline;
        const shouldVendor = Boolean(opts.vendor);
        // Without --vendor the path is passed through on purpose: initWorkspace rejects the
        // combination instead of silently generating a configuration that ignores the file.
        const annotationsPath = shouldVendor
          ? await resolveAnnotations({ customPath: opts.annotations, offline: opts.offline })
          : opts.annotations;
        const created = initWorkspace(path.resolve(targetPath), {
          force: opts.force,
          annotationsPath,
          vendor: shouldVendor,
        });
        writeOutput(`[init] Initialized nanos world LuaLS configuration: ${created}`);
        setExitCode(0);
      },
    );

  program
    .command("copy-annotations [destination]")
    .alias("export-annotations")
    .description(
      "Copy cached nanos world annotations.lua definitions into a target file or directory (targets not ending in .lua are treated as directories)",
    )
    .option("-f, --force", "Overwrite existing annotations file")
    .option("--annotations <path>", "Path to custom annotations.lua source file")
    .action(
      async (
        destination: string | undefined,
        opts: { force?: boolean; annotations?: string },
        cmd: Command,
      ) => {
        const copied = await copyAnnotations(destination, {
          force: opts.force,
          annotationsPath: opts.annotations,
          offline: cmd.optsWithGlobals().offline,
        });
        writeOutput(`[copy-annotations] Copied nanos world annotations to: ${copied}`);
        setExitCode(0);
      },
    );

  program
    .command("warmup")
    .alias("download")
    .description("Pre-fetch and cache both LuaLS binary and annotations for offline execution")
    .option("--luals-version <ver>", `Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})`)
    .option("--annotations <path>", "Path to custom annotations.lua file")
    .action(async (opts: { lualsVersion?: string; annotations?: string }, cmd: Command) => {
      const ver = opts?.lualsVersion || DEFAULT_LUALS_VERSION;
      const bin = await resolveLuaLSBinary(ver, { offline: cmd.optsWithGlobals().offline });
      writeOutput(`[warmup] LuaLS binary ready: ${bin}`);

      const annotationsPath = await resolveAnnotations({
        customPath: opts?.annotations,
        offline: cmd.optsWithGlobals().offline,
      });
      const meta = readAnnotationsMetadata();
      const commitInfo =
        meta?.commitId && meta.commitId !== "unknown"
          ? ` (commit ${meta.commitId.slice(0, 7)})`
          : "";
      writeOutput(`[warmup] nanos world annotations ready: ${annotationsPath}${commitInfo}`);
      writeOutput("[warmup] Cache pre-warmed successfully. Ready for offline execution.");
      setExitCode(0);
    });

  program
    .command("download-luals [version]")
    .description("Download and cache the LuaLS binary")
    .option("--luals-version <ver>", `Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})`)
    .action(async (version: string | undefined, opts: { lualsVersion?: string }, cmd: Command) => {
      const ver = version || opts?.lualsVersion || DEFAULT_LUALS_VERSION;
      writeOutput(`[luals] Downloading LuaLS ${ver}...`);
      const bin = await resolveLuaLSBinary(ver, { offline: cmd.optsWithGlobals().offline });
      writeOutput(`[luals] Ready at: ${bin}`);
      setExitCode(0);
    });

  const handleCleanCache = (): void => {
    try {
      const cleared = cleanCache();
      if (cleared) {
        writeOutput(`[cache] Cleared cache at: ${cleared}`);
      } else {
        writeOutput(`[cache] Cache is already empty (${systemPaths.cache})`);
      }
      setExitCode(0);
    } catch (err) {
      logger.error(
        `[cache] Failed to clear cache: ${err instanceof Error ? err.message : String(err)}`,
      );
      setExitCode(1);
    }
  };

  const handleCacheStatus = (opts?: { json?: boolean }): void => {
    if (opts?.json) {
      // Machine-readable output owns stdout: diagnostics must not interleave with the JSON report.
      logger.setDiagnosticStream("stderr");
    }
    const report = getCacheStatus();
    if (opts?.json) {
      writeOutput(JSON.stringify(report, null, 2));
    } else {
      writeOutput(formatCacheStatusPretty(report));
    }
    setExitCode(0);
  };

  const cacheCmd = program
    .command("cache")
    .description("Inspect or manage the nanos-lint cache")
    .option("--json", "Output cache state in JSON format");

  cacheCmd
    .command("status", { isDefault: true })
    .alias("info")
    .description("Show cache status, installed versions, and disk usage")
    .option("--json", "Output cache state in JSON format")
    .action((opts: { json?: boolean }, cmd: Command) => {
      const json = opts?.json || (cmd.parent ? Boolean(cmd.parent.opts()?.json) : false);
      handleCacheStatus({ json });
    });

  cacheCmd
    .command("clean")
    .description("Clear the nanos-lint cache")
    .action(() => {
      handleCleanCache();
    });

  program
    .command("cache-status")
    .description("Show cache status, installed versions, and disk usage")
    .option("--json", "Output cache state in JSON format")
    .action((opts: { json?: boolean }) => {
      handleCacheStatus(opts);
    });

  program
    .command("clean-cache")
    .alias("clean")
    .description("Clear the nanos-lint cache")
    .action(() => {
      handleCleanCache();
    });

  program
    .command("version")
    .description("Show version information")
    .action(() => {
      writeOutput(getVersionString());
      setExitCode(0);
    });

  program.helpCommand("help [command]", "Show this help message");

  program.addHelpText(
    "after",
    `
Examples:
  $ npx nanos-lint
  $ npx nanos-lint warmup
  $ npx nanos-lint cache status
  $ npx nanos-lint check ./my-package
  $ npx nanos-lint check . --checklevel=Error
  $ npx nanos-lint check . --ignore "myfolder/hello-*.lua"
  $ npx nanos-lint check . --realm server
  $ npx nanos-lint check Shared/ Server/ --realm server
  $ npx nanos-lint init
  $ npx nanos-lint copy-annotations
  $ npx nanos-lint clean-cache
`,
  );

  return program;
}

/** Parses command-line arguments and executes the requested CLI action. */
export async function runCLI(args: string[] = process.argv.slice(2)): Promise<number> {
  // The redraw policy and the diagnostic stream are process-global and derived from the parsed
  // flags, so every run starts from the defaults: a previous in-process run cannot leak into it.
  setProgressMode("auto");
  logger.setDiagnosticStream("stdout");

  // Early parse of log-level so early exits (e.g. --version, --help) configure the logger
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "-l" || arg === "--log-level") {
      const nextArg = args[i + 1];
      if (nextArg && isValidLogLevel(nextArg)) {
        logger.setLevel(nextArg as LogLevel);
      }
    } else if (arg.startsWith("--log-level=")) {
      const val = arg.split("=")[1];
      if (val && isValidLogLevel(val)) {
        logger.setLevel(val as LogLevel);
      }
    }
  }

  let exitCode = 0;
  const program = createProgram({
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  try {
    await program.parseAsync(args, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    if (err instanceof NanosLintError) {
      logger.error(`error: ${err.message}`);
      if (err.remedy) {
        logger.error(`hint: ${err.remedy}`);
      }
      if ((logger.getLevel() === "debug" || process.env.DEBUG) && err.stack) {
        logger.error(err.stack);
        if (err.cause) {
          logger.error(
            `cause: ${err.cause instanceof Error ? err.cause.stack || err.cause.message : String(err.cause)}`,
          );
        }
      }
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`error: ${message}`);
    if ((logger.getLevel() === "debug" || process.env.DEBUG) && err instanceof Error && err.stack) {
      logger.error(err.stack);
    }
    return 1;
  }
}

/** Determines whether the current module is being directly executed as an application entrypoint. */
export function isDirectExecution(
  importMetaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) {
    return false;
  }
  const toPath = (urlStr: string): string => {
    try {
      if (urlStr.startsWith("file:")) {
        return fileURLToPath(urlStr);
      }
      return urlStr;
    } catch (err) {
      logger.debug(
        `[cli] Failed to convert URL "${urlStr}" using fileURLToPath: ${err instanceof Error ? err.message : String(err)}`,
      );
      return urlStr.replace(/^file:\/\/\/?/, "");
    }
  };

  try {
    const scriptPath = fs.realpathSync(path.resolve(argv1)).toLowerCase();
    const modulePath = fs.realpathSync(toPath(importMetaUrl)).toLowerCase();
    if (scriptPath === modulePath) {
      return true;
    }
    const moduleDir = path.dirname(modulePath);
    const cliJsPath = path.join(moduleDir, "cli.js").toLowerCase();
    const cliTsPath = path.join(moduleDir, "cli.ts").toLowerCase();
    if (scriptPath === cliJsPath || scriptPath === cliTsPath) {
      return true;
    }
  } catch (err) {
    logger.debug(
      `[cli] Failed to resolve realpath for entry detection: ${err instanceof Error ? err.message : String(err)}`,
    );
    const normArgv = path.resolve(argv1).toLowerCase();
    const normMeta = toPath(importMetaUrl).toLowerCase();
    if (normArgv === normMeta) {
      return true;
    }
    const normDir = path.dirname(normMeta);
    if (
      normArgv === path.join(normDir, "cli.js").toLowerCase() ||
      normArgv === path.join(normDir, "cli.ts").toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

if (isDirectExecution()) {
  runCLI()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
