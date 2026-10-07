import { fileURLToPath as nodeFileURLToPath } from "node:url";
import { logger } from "./logger.js";

export type DiagnosticSeverity = "Error" | "Warning" | "Information" | "Hint";
export type DiagnosticSeverityLevel = 1 | 2 | 3 | 4;

export interface DiagnosticRange {
  start: {
    line: number;
    character: number;
  };
  end: {
    line: number;
    character: number;
  };
}

export interface Diagnostic {
  range: DiagnosticRange;
  severity: DiagnosticSeverityLevel; // 1 = Error, 2 = Warning, 3 = Information, 4 = Hint
  code?: string;
  message: string;
  source?: string;
  /** Present when comparing or recording a diagnostic baseline. */
  baseline?: boolean;
}

export type DiagnosticReport = Record<string, Diagnostic[]>;

export interface CheckOptions {
  /** Single workspace path or file to check (legacy/convenience option). */
  path?: string;
  /** One or more workspace target paths or files to check. If provided, takes precedence over `path`. */
  paths?: string[];
  checklevel?: DiagnosticSeverity;
  configpath?: string;
  lualsVersion?: string;
  offline?: boolean;
  format?: "pretty" | "json" | "github";
  failOnError?: boolean;
  lualsBin?: string;
  ignore?: string[];
  /** External package dependency directories or Lua files. */
  deps?: string[];
}

export interface CheckResult {
  passed: boolean;
  totalProblems: number;
  totalErrors?: number;
  totalWarnings?: number;
  totalFiles: number;
  totalFilesChecked?: number;
  diagnostics: DiagnosticReport;
  baselineSummary?: { new: number; baselined: number; total: number; stale: number };
}

/** Execution realm of a nanos world script, as loaded by the server or client VM. */
export type RealmName = "client" | "server" | "shared" | "global";

/** nanos-lint specific settings embedded in `.luarc.json` under the `nanos` key. */
export interface NanosConfig {
  /** Maps glob patterns (relative to the checked root) to realm names. */
  realms?: Record<string, RealmName>;
  /** Package dependency paths or definition files. */
  deps?: string[];
  [key: string]: unknown;
}

export interface LuaRCConfig {
  $schema?: string;
  runtime?: {
    version?: string;
    path?: string[];
    special?: Record<string, string>;
    [key: string]: unknown;
  };
  workspace?: {
    checkThirdParty?: boolean;
    library?: string[];
    ignoreDir?: string[];
    [key: string]: unknown;
  };
  files?: {
    exclude?: string[];
    [key: string]: unknown;
  };
  diagnostics?: {
    enable?: boolean;
    globals?: string[];
    disable?: string[];
    severity?: Record<string, string>;
    neededFileStatus?: Record<string, string>;
    [key: string]: unknown;
  };
  nanos?: NanosConfig;
  [key: string]: unknown;
}

/**
 * Converts a URI (e.g. `file:///path/to/file` or `file:///C:/path/to/file` or `file:///c%3A/path` or `file://server/share/file`)
 * to a standard local file system path across both Windows and Unix.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }

  try {
    const parsed = nodeFileURLToPath(uri);
    let res = parsed.replace(/\\/g, "/");
    if (/^\/[a-zA-Z]:/.test(res)) {
      res = res.slice(1);
    }
    if (/^[a-zA-Z]:/.test(res)) {
      res = res.charAt(0).toUpperCase() + res.slice(1);
    }
    return res;
  } catch (err) {
    logger.debug(
      `fileURLToPath fallback for URI "${uri}": ${err instanceof Error ? err.message : String(err)}`,
    );
    // Fallback if nodeFileURLToPath fails (e.g. malformed percent encoding)
    let decoded = uri.slice(7);
    try {
      decoded = decodeURIComponent(decoded);
    } catch (decodeErr) {
      logger.warn(
        `decodeURIComponent failed for path "${decoded}": ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`,
      );
    }

    if (decoded.startsWith("//")) {
      return decoded;
    }

    if (!decoded.startsWith("/") && uri.startsWith("file://") && !uri.startsWith("file:///")) {
      return `//${decoded}`;
    }

    // Windows file URIs often look like /C:/foo or /c:/foo
    if (/^\/[a-zA-Z]:/.test(decoded)) {
      decoded = decoded.slice(1);
    }

    // Normalize drive letter to uppercase on Windows
    if (/^[a-zA-Z]:/.test(decoded)) {
      return decoded.charAt(0).toUpperCase() + decoded.slice(1);
    }

    return decoded;
  }
}
