import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stripComments, type ParseError, printParseErrorCode } from "jsonc-parser";
import { systemPaths } from "./paths.js";
import { logger } from "./logger.js";
import type { LuaRCConfig } from "./types.js";
import { ConfigError } from "./errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds the package root directory across both development (src/) and production (dist/) environments.
 */
export function getPackageRoot(): string {
  let current = __dirname;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, "..");
}

/** Resolves the default annotations path from environment variable, bundled file, or user cache. */
export function getDefaultAnnotationsPath(): string {
  // 1. Env variable
  const envPath = process.env.NANOS_ANNOTATIONS_PATH || process.env.NANOS_ANNOTATIONS;
  if (envPath && fs.existsSync(envPath)) {
    return path.resolve(envPath);
  }
  // 2. Bundled with package (release distribution)
  const bundled = path.join(getPackageRoot(), "annotations.lua");
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  // 3. User cache
  return path.join(systemPaths.cache, "annotations", "annotations.lua");
}

/**
 * @deprecated Use getDefaultAnnotationsPath() instead.
 * Returns the directory containing the resolved annotations.lua file.
 */
export function getDefinitionsDir(): string {
  return path.dirname(getDefaultAnnotationsPath());
}

/** Resolves the absolute path to the default .luarc.json template shipped with the package. */
export function getDefaultTemplatePath(): string {
  const root = getPackageRoot();
  return path.join(root, "templates", ".luarc.json");
}

/**
 * Strips single-line and multi-line comments from JSONC text using jsonc-parser.
 */
export function stripJsonComments(text: string): string {
  const cleanText = text.replace(/^\uFEFF/, "");
  return stripComments(cleanText);
}

/** Parses JSONC text with support for comments and trailing commas. */
export function parseJsonc<T = unknown>(text: string): T {
  const cleanText = text.replace(/^\uFEFF/, "");
  const errors: ParseError[] = [];
  const result = parse(cleanText, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const errorDetails = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new SyntaxError(`Invalid JSONC: ${errorDetails}`);
  }
  return result as T;
}

/** Reads and parses a .luarc.json configuration file from disk. */
export function loadConfigFile(filePath: string): LuaRCConfig {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(
      `Configuration file not found: ${filePath}`,
      "ERR_CONFIG_NOT_FOUND",
      "Ensure the configuration file path is correct or run 'nanos-lint init' to generate a default config.",
    );
  }
  const content = fs.readFileSync(filePath, "utf-8");
  try {
    return parseJsonc<LuaRCConfig>(content);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
    throw new ConfigError(
      `Failed to parse configuration file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      "ERR_CONFIG_PARSE",
      "Check your .luarc.json syntax or run 'nanos-lint init --force' to scaffold a clean template.",
      { cause: err },
    );
  }
}

/**
 * Removes trailing `/` characters from a path-like string.
 *
 * Implemented with a scan instead of a `\/+$` regular expression: on inputs made
 * of many slashes that do not end in a slash, a backtracking engine retries the
 * repetition at every offset, which is quadratic in the input length
 * (CodeQL: js/polynomial-redos).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f /* "/" */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export interface MergeConfigOptions {
  cliIgnore?: string[];
  dependencyLibraries?: string[];
}

/**
 * Set of recognized diagnostic codes supported by Lua Language Server (LuaLS).
 * LuaLS discards the entire `diagnostics.severity` object if it contains a single
 * unrecognized key (such as obsolete 'syntax-error'). nanos-lint filters severity
 * and neededFileStatus maps against this allow-list to ensure valid configuration.
 */
export const VALID_LUALS_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "ambiguity-1",
  "assign-type-mismatch",
  "await-in-sync",
  "cast-local-type",
  "cast-type-mismatch",
  "circle-doc-class",
  "close-non-object",
  "code-after-break",
  "codestyle-check",
  "count-down-loop",
  "deprecated",
  "different-requires",
  "discard-returns",
  "doc-field-no-class",
  "duplicate-doc-alias",
  "duplicate-doc-field",
  "duplicate-doc-param",
  "duplicate-index",
  "duplicate-set-field",
  "empty-block",
  "global-element",
  "global-in-nil-env",
  "incomplete-signature-doc",
  "inject-field",
  "invisible",
  "lowercase-global",
  "missing-fields",
  "missing-global-doc",
  "missing-local-export-doc",
  "missing-parameter",
  "missing-return",
  "missing-return-value",
  "name-style-check",
  "need-check-nil",
  "newfield-call",
  "newline-call",
  "no-unknown",
  "not-yieldable",
  "param-type-mismatch",
  "redefined-local",
  "redundant-parameter",
  "redundant-return",
  "redundant-return-value",
  "redundant-value",
  "return-type-mismatch",
  "spell-check",
  "trailing-space",
  "unbalanced-assignments",
  "undefined-doc-class",
  "undefined-doc-name",
  "undefined-doc-param",
  "undefined-env-child",
  "undefined-field",
  "undefined-global",
  "unknown-cast-variable",
  "unknown-diag-code",
  "unknown-operator",
  "unreachable-code",
  "unused-function",
  "unused-label",
  "unused-local",
  "unused-vararg",
]);

/**
 * Merges a base nanos configuration with a workspace override configuration.
 * Guarantees that nanos API annotations are included in workspace.library,
 * and standardizes paths for LuaLS.
 *
 * @param base Base configuration template
 * @param override Workspace override configuration
 * @param definitionsPath Path to annotations.lua file or directory containing it
 * @param options Additional merge options
 */
export function mergeConfigs(
  base: LuaRCConfig,
  override: LuaRCConfig = {},
  definitionsPath: string = getDefaultAnnotationsPath(),
  options?: MergeConfigOptions,
): LuaRCConfig {
  let resolvedPath = definitionsPath;
  if (fs.existsSync(definitionsPath)) {
    try {
      if (fs.statSync(definitionsPath).isDirectory()) {
        const candidate = path.join(definitionsPath, "annotations.lua");
        if (fs.existsSync(candidate)) {
          resolvedPath = candidate;
        }
      }
    } catch (err) {
      logger.debug(
        `Error checking annotations definitionsPath directory (${definitionsPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const normalizedDefPath = resolvedPath.split(path.sep).join("/");

  // Merge library paths
  const baseLibraries = base.workspace?.library ?? [];
  const overrideLibraries = override.workspace?.library ?? [];
  const depLibraries = (options?.dependencyLibraries ?? []).map((p) => p.replace(/\\/g, "/"));
  const librarySet = new Set<string>([
    normalizedDefPath,
    ...baseLibraries,
    ...overrideLibraries,
    ...depLibraries,
  ]);

  // Merge globals
  const baseGlobals = base.diagnostics?.globals ?? [];
  const overrideGlobals = override.diagnostics?.globals ?? [];
  const globalsSet = new Set<string>([...baseGlobals, ...overrideGlobals]);

  // Merge severities and filter out unknown keys to prevent LuaLS from voiding the table
  const rawSeverity = {
    ...(base.diagnostics?.severity ?? {}),
    ...(override.diagnostics?.severity ?? {}),
  };
  const mergedSeverity: Record<string, string> = {};
  for (const [code, level] of Object.entries(rawSeverity)) {
    if (VALID_LUALS_DIAGNOSTIC_CODES.has(code)) {
      mergedSeverity[code] = level;
    } else {
      logger.warn(
        `[config] Unrecognized diagnostic code "${code}" in diagnostics.severity was dropped to prevent LuaLS from discarding the severity configuration.`,
      );
    }
  }

  // Merge neededFileStatus and filter out unknown keys
  const rawNeededFileStatus = {
    ...(base.diagnostics?.neededFileStatus ?? {}),
    ...(override.diagnostics?.neededFileStatus ?? {}),
  };
  const mergedNeededFileStatus: Record<string, string> = {};
  for (const [code, status] of Object.entries(rawNeededFileStatus)) {
    if (VALID_LUALS_DIAGNOSTIC_CODES.has(code)) {
      mergedNeededFileStatus[code] = status;
    } else {
      logger.warn(
        `[config] Unrecognized diagnostic code "${code}" in diagnostics.neededFileStatus was dropped.`,
      );
    }
  }

  const hasCliIgnore = Boolean(options?.cliIgnore && options.cliIgnore.length > 0);

  let mergedIgnoreDir: string[];
  let mergedFilesExclude: string[];

  const baseFilesExclude = base.files?.exclude ?? [];
  const overrideFilesExclude = override.files?.exclude ?? [];

  const defaultIgnore = [
    ".git",
    ".vscode",
    ".nanos-lint",
    "node_modules",
    "dist",
    "bin",
    "vendor",
    "script",
    "meta",
    "locale",
    "log",
  ];
  const baseIgnore = base.workspace?.ignoreDir ?? defaultIgnore;
  const overrideIgnore = override.workspace?.ignoreDir ?? [];

  if (hasCliIgnore) {
    const normalizedCliIgnore = (options?.cliIgnore ?? [])
      .map((p) => p.replace(/\\/g, "/").trim())
      .filter(Boolean);

    const excludePatterns = new Set<string>([...baseFilesExclude, ...overrideFilesExclude]);
    for (const pat of normalizedCliIgnore) {
      excludePatterns.add(pat);
      if (!pat.includes("*") && !pat.includes("?") && !pat.endsWith(".lua")) {
        const dirPat = stripTrailingSlashes(pat);
        excludePatterns.add(`${dirPat}/**`);
      }
    }
    mergedFilesExclude = Array.from(excludePatterns);

    // For workspace.ignoreDir, keep default structural exclusions plus any CLI ignore dirs
    const cliDirs = normalizedCliIgnore
      .filter((p) => !p.includes("*") && !p.includes("?") && !p.endsWith(".lua"))
      .map((p) => stripTrailingSlashes(p));
    mergedIgnoreDir = Array.from(
      new Set([...defaultIgnore, ...baseIgnore, ...overrideIgnore, ...cliDirs]),
    );
  } else {
    // Merge ignoreDir using default rules
    mergedIgnoreDir = Array.from(new Set([...defaultIgnore, ...baseIgnore, ...overrideIgnore]));
    mergedFilesExclude = Array.from(new Set([...baseFilesExclude, ...overrideFilesExclude]));
  }

  const merged: LuaRCConfig = {
    $schema: override.$schema ?? base.$schema,
    ...base,
    ...override,
    runtime: {
      version: "Lua 5.4",
      ...(base.runtime ?? {}),
      ...(override.runtime ?? {}),
    },
    workspace: {
      checkThirdParty: false,
      ...(base.workspace ?? {}),
      ...(override.workspace ?? {}),
      library: Array.from(librarySet),
      ignoreDir: mergedIgnoreDir,
    },
    files: {
      ...(base.files ?? {}),
      ...(override.files ?? {}),
      exclude: mergedFilesExclude,
    },
    diagnostics: {
      enable: true,
      ...(base.diagnostics ?? {}),
      ...(override.diagnostics ?? {}),
      globals: Array.from(globalsSet),
      severity: mergedSeverity,
      ...(Object.keys(mergedNeededFileStatus).length > 0
        ? { neededFileStatus: mergedNeededFileStatus }
        : {}),
    },
  };

  return merged;
}

export interface ResolveWorkspaceConfigOptions {
  ignore?: string[];
  annotationsPath?: string;
  dependencyLibraries?: string[];
  unrequestedExclusions?: string[];
}

/**
 * Loads the user workspace configuration from `--config` or `<workspace>/.luarc.json`,
 * returning an empty object when neither exists. Parse failures are reported with the
 * offending path so a broken `.luarc.json` is never silently ignored.
 */
export function loadUserConfig(workspacePath: string, customConfigPath?: string): LuaRCConfig {
  if (customConfigPath) {
    return loadConfigFile(path.resolve(customConfigPath));
  }
  const candidate = path.join(workspacePath, ".luarc.json");
  if (!fs.existsSync(candidate)) {
    return {};
  }
  try {
    return loadConfigFile(candidate);
  } catch (err) {
    throw new Error(
      `Failed to parse workspace configuration file (${candidate}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Writes a merged configuration to a unique temporary file and returns its path. */
export function writeTempConfig(config: LuaRCConfig): string {
  const tempDir = systemPaths.temp;
  fs.mkdirSync(tempDir, { recursive: true });
  const tempConfigFile = path.join(
    tempDir,
    `luarc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tempConfigFile, JSON.stringify(config, null, 2), "utf-8");
  return tempConfigFile;
}

/**
 * Discovers any existing workspace configuration and merges it with the nanos template,
 * returning a LuaLS-ready configuration object without writing anything to disk.
 */
export function buildWorkspaceConfig(
  workspacePath: string,
  customConfigPath?: string,
  options?: ResolveWorkspaceConfigOptions,
): LuaRCConfig {
  const defaultTemplate = loadConfigFile(getDefaultTemplatePath());
  const activeAnnotationsPath = options?.annotationsPath || getDefaultAnnotationsPath();
  const userConfig = loadUserConfig(workspacePath, customConfigPath);

  const hasCliIgnore = Boolean(options?.ignore && options.ignore.length > 0);

  // When relative to workspacePath, expand patterns if they start with workspace prefix
  let cliIgnore = options?.ignore;
  if (hasCliIgnore && cliIgnore) {
    const normWs = stripTrailingSlashes(workspacePath.replace(/\\/g, "/").replace(/^\.\//, ""));
    const expanded: string[] = [];
    for (const pat of cliIgnore) {
      expanded.push(pat);
      const normPat = pat.replace(/\\/g, "/");
      if (normWs && normWs !== "." && normPat.startsWith(`${normWs}/`)) {
        expanded.push(normPat.slice(normWs.length + 1));
      }
    }
    cliIgnore = expanded;
  }

  const merged = mergeConfigs(defaultTemplate, userConfig, activeAnnotationsPath, {
    cliIgnore,
    dependencyLibraries: options?.dependencyLibraries,
  });

  // Only apply hardcoded tool directory exclusions when CLI ignore was NOT provided
  if (!hasCliIgnore) {
    const resolvedTarget = path.resolve(workspacePath);
    const isToolDirectory =
      fs.existsSync(path.join(resolvedTarget, "main.lua")) &&
      (fs.existsSync(path.join(resolvedTarget, "bin", "lua-language-server.exe")) ||
        fs.existsSync(path.join(resolvedTarget, "bin", "lua-language-server")));

    if (isToolDirectory) {
      merged.files = merged.files ?? {};
      const existingExclude = merged.files.exclude ?? [];
      merged.files.exclude = [
        ...new Set([
          ...existingExclude,
          "main.lua",
          "debugger.lua",
          "**/main.lua",
          "**/debugger.lua",
        ]),
      ];
    }
  }

  if (options?.unrequestedExclusions && options.unrequestedExclusions.length > 0) {
    merged.files = merged.files ?? {};
    const existingExclude = merged.files.exclude ?? [];
    merged.files.exclude = [...new Set([...existingExclude, ...options.unrequestedExclusions])];
  }

  return merged;
}

/**
 * Builds the merged workspace configuration for a single standard LuaLS pass and writes
 * it to a temporary file (deleted by the caller after the run).
 */
export function resolveWorkspaceConfig(
  workspacePath: string,
  customConfigPath?: string,
  options?: ResolveWorkspaceConfigOptions,
): { configPath: string; isTemp: boolean } {
  return {
    configPath: writeTempConfig(buildWorkspaceConfig(workspacePath, customConfigPath, options)),
    isTemp: true,
  };
}

/** A glob pattern (relative to the checked root) bound to an execution realm. */
export interface RealmMapping {
  pattern: string;
  realm: "client" | "server" | "shared";
}

/** Conventional nanos world package layout used when `nanos.realms` is omitted. */
export const DEFAULT_REALM_MAPPINGS: ReadonlyArray<RealmMapping> = [
  { pattern: "Server/**", realm: "server" },
  { pattern: "Client/**", realm: "client" },
  { pattern: "Shared/**", realm: "shared" },
];

export interface ResolvedRealmMappings {
  /** `false` when the user explicitly disabled realms with `nanos.realms: {}`. */
  enabled: boolean;
  mappings: RealmMapping[];
}

/** Normalizes a realm identifier, mapping the `global` alias onto `shared`. */
function normalizeRealmName(value: unknown): RealmMapping["realm"] | null {
  if (value === "server" || value === "client") {
    return value;
  }
  if (value === "shared" || value === "global") {
    return "shared";
  }
  return null;
}

/**
 * Resolves the realm mappings declared in `nanos.realms`.
 *
 * - The key is omitted: the conventional `Server/**`, `Client/**`, `Shared/**` layout is
 *   used, and realms only activate when those patterns actually match files (#15, #35).
 * - The key is `{}`: realms are disabled and a single standard pass runs.
 * - Otherwise the declared mapping replaces the defaults, and `global` is accepted as an
 *   alias of `shared`. Unusable entries are dropped with a warning.
 */
export function resolveRealmMappings(userConfig: LuaRCConfig): ResolvedRealmMappings {
  const raw = userConfig.nanos?.realms;
  if (raw === undefined) {
    return { enabled: true, mappings: [...DEFAULT_REALM_MAPPINGS] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    logger.warn(
      "[realms] Ignoring nanos.realms: expected an object mapping glob patterns to realm names.",
    );
    return { enabled: true, mappings: [...DEFAULT_REALM_MAPPINGS] };
  }

  const mappings: RealmMapping[] = [];
  for (const [rawPattern, rawRealm] of Object.entries(raw as Record<string, unknown>)) {
    const realm = normalizeRealmName(rawRealm);
    if (!realm) {
      logger.warn(
        `[realms] Ignoring nanos.realms entry "${rawPattern}": "${String(rawRealm)}" is not one of server, client, shared or global.`,
      );
      continue;
    }
    const pattern =
      typeof rawPattern === "string"
        ? stripTrailingSlashes(rawPattern.trim().replace(/\\/g, "/"))
        : "";
    if (!pattern || pattern === ".") {
      logger.warn(`[realms] Ignoring unusable nanos.realms pattern "${rawPattern}".`);
      continue;
    }
    mappings.push({ pattern, realm });
  }

  if (mappings.length === 0) {
    logger.warn("[realms] nanos.realms has no usable entries; realm passes are disabled.");
    return { enabled: false, mappings: [] };
  }
  return { enabled: true, mappings };
}

export interface InitWorkspaceOptions {
  /** Custom JSONC configuration used as the scaffold base. */
  templatePath?: string;
  force?: boolean;
  /** Definitions file vendored into `.nanos-lint/`; only meaningful together with `vendor`. */
  annotationsPath?: string;
  /** Copies `annotations.lua` into the workspace and pins it in `workspace.library`. */
  vendor?: boolean;
}

/**
 * Initializes a new .luarc.json in a workspace.
 */
export function initWorkspace(workspacePath: string, options?: InitWorkspaceOptions): string {
  const targetFile = path.join(workspacePath, ".luarc.json");
  if (fs.existsSync(targetFile) && !options?.force) {
    throw new ConfigError(
      `.luarc.json already exists at ${targetFile}. Use --force to overwrite.`,
      "ERR_CONFIG_EXISTS",
      "Pass --force to overwrite the existing .luarc.json file.",
    );
  }

  if (options?.annotationsPath && !options.vendor) {
    throw new ConfigError(
      "--annotations requires --vendor: nanos-lint init does not pin or vendor annotations.lua by default.",
      "ERR_ANNOTATIONS_WITHOUT_VENDOR",
      "Run 'nanos-lint init --vendor --annotations <path>' (or pass vendor: true), or omit the custom path to use the managed annotations cache.",
    );
  }

  const template = loadConfigFile(path.resolve(options?.templatePath ?? getDefaultTemplatePath()));
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new ConfigError("Init template must contain a configuration object.", "ERR_CONFIG_PARSE");
  }
  template.nanos ??= {};
  template.nanos.realms ??= Object.fromEntries(
    DEFAULT_REALM_MAPPINGS.map(({ pattern, realm }) => [pattern, realm]),
  );

  if (options?.vendor) {
    const sourceAnnotations = options.annotationsPath || getDefaultAnnotationsPath();

    if (!fs.existsSync(sourceAnnotations)) {
      throw new ConfigError(
        `Definitions file not found at ${sourceAnnotations}. Make sure annotations have been downloaded or pass a valid file with --annotations.`,
        "ERR_ANNOTATIONS_NOT_FOUND",
        "Run 'nanos-lint warmup' to download annotations or provide --annotations <path>.",
      );
    }

    const targetAnnotations = path.join(workspacePath, ".nanos-lint", "annotations.lua");
    fs.mkdirSync(path.dirname(targetAnnotations), { recursive: true });
    fs.copyFileSync(sourceAnnotations, targetAnnotations);

    template.workspace = template.workspace ?? {};
    template.workspace.library = [
      ...new Set([...(template.workspace.library ?? []), ".nanos-lint/annotations.lua"]),
    ];

    template.workspace.ignoreDir = [
      ...new Set([".nanos-lint", ...(template.workspace.ignoreDir ?? [])]),
    ];

    template.files = template.files ?? {};
    template.files.exclude = [...new Set([".nanos-lint/**", ...(template.files.exclude ?? [])])];
  }

  fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), "utf-8");
  return targetFile;
}
