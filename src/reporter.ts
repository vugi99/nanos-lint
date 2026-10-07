import fs from "node:fs";
import path from "node:path";
import { fileUriToPath } from "./types.js";
import { logger } from "./logger.js";
import type { CheckResult, DiagnosticSeverity } from "./types.js";

const SEVERITY_NAMES: Record<number, DiagnosticSeverity> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

/**
 * Determines whether ANSI color codes should be enabled according to the NO_COLOR convention
 * and TTY detection.
 */
export function shouldEnableColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return process.stdout ? Boolean(process.stdout.isTTY) : true;
}

/** Returns ANSI color escape code helpers or empty strings when colors are disabled. */
export function getColors(useColor: boolean = shouldEnableColor()) {
  if (!useColor) {
    return {
      reset: "",
      bold: "",
      dim: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      magenta: "",
      cyan: "",
      gray: "",
    };
  }
  return {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
  };
}

/** Formats a numeric diagnostic severity level into a colored badge. */
export function formatSeverityBadge(
  severity: number,
  useColor: boolean = shouldEnableColor(),
): string {
  const c = getColors(useColor);
  const name = SEVERITY_NAMES[severity] || "Warning";
  switch (severity) {
    case 1:
      return `${c.red}[${name}]${c.reset}`;
    case 2:
      return `${c.yellow}[${name}]${c.reset}`;
    case 3:
      return `${c.cyan}[${name}]${c.reset}`;
    default:
      return `${c.gray}[${name}]${c.reset}`;
  }
}

/** Formats a noun with its count and pluralizes if necessary. */
export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Formats the summary text detailing diagnostic counts and affected files. */
export function formatProblemSummary(
  totalProblems: number,
  errors: number,
  warnings: number,
  files: number,
): string {
  const parts: string[] = [];
  if (errors > 0) {
    parts.push(pluralize(errors, "error"));
  }
  if (warnings > 0) {
    parts.push(pluralize(warnings, "warning"));
  }
  const other = totalProblems - (errors + warnings);
  if (other > 0) {
    parts.push(pluralize(other, "other"));
  }

  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const problemStr = pluralize(totalProblems, "problem");
  const fileStr = pluralize(files, "file");

  return `Diagnosis complete: ${problemStr}${breakdown} found across ${fileStr}.`;
}

/** Formats check results into pretty human-readable terminal output. */
export function formatPretty(
  result: CheckResult,
  cwd: string = process.cwd(),
  useColor: boolean = shouldEnableColor(),
): string {
  const c = getColors(useColor);
  const symCross = "✖  ";
  const symCheck = "✔  ";

  if (result.passed && !result.baselineSummary) {
    const files = result.totalFilesChecked ?? result.totalFiles;
    const fileStr = pluralize(files, "file");
    return `${c.green}${c.bold}${symCheck}Diagnosis completed, no problems found across ${fileStr}.${c.reset}`;
  }

  const lines: string[] = [];

  for (const [rawUri, diags] of Object.entries(result.diagnostics)) {
    if (!diags || diags.length === 0) continue;

    // Convert file:// or absolute path to relative if within cwd
    const filePath = fileUriToPath(rawUri);

    const relPath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) || filePath : filePath;

    let fileContent: string[] = [];
    try {
      if (fs.existsSync(filePath)) {
        fileContent = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
      }
    } catch (err) {
      logger.debug(
        `Failed to read file snippet for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const d of diags) {
      if (d.baseline) continue;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const badge = formatSeverityBadge(d.severity, useColor);
      const code = d.code ? `${c.magenta}(${d.code})${c.reset}` : "";

      lines.push(`${c.blue}${relPath}:${line}:${col}${c.reset} ${badge} ${d.message} ${code}`);

      // Line snippet preview
      if (fileContent.length >= line) {
        const sourceLine = fileContent[line - 1];
        const indent = "    ";
        lines.push(`${indent}${sourceLine}`);

        const caretOffset = Math.max(0, d.range.start.character);
        const caretLength =
          d.range.start.line === d.range.end.line
            ? Math.max(1, d.range.end.character - d.range.start.character)
            : 1;

        const pointer = " ".repeat(caretOffset) + "^".repeat(caretLength);
        lines.push(`${indent}${c.gray}${pointer}${c.reset}`);
      }
    }
  }

  let errors = result.totalErrors;
  let warnings = result.totalWarnings;
  if (errors === undefined || warnings === undefined) {
    errors = 0;
    warnings = 0;
    for (const diags of Object.values(result.diagnostics)) {
      for (const d of diags) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
  }

  lines.push("");
  const counts = result.baselineSummary;
  const summary = counts
    ? `Diagnosis complete: ${counts.new} new, ${counts.baselined} baselined, ${counts.total} total (${counts.stale} stale baseline entries).`
    : formatProblemSummary(result.totalProblems, errors, warnings, result.totalFiles);
  const color = result.passed ? c.green : c.red;
  lines.push(`${color}${c.bold}${result.passed ? symCheck : symCross}${summary}${c.reset}`);

  return lines.join("\n");
}

/** Formats check diagnostics into GitHub Actions workflow annotation commands. */
export function formatGitHubAnnotations(result: CheckResult, cwd: string = process.cwd()): string {
  const commands: string[] = [];

  for (const [rawUri, diags] of Object.entries(result.diagnostics)) {
    if (!diags || diags.length === 0) continue;

    const filePath = fileUriToPath(rawUri);

    const relPath = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath).replace(/\\/g, "/")
      : filePath.replace(/\\/g, "/");

    const escapedFile = relPath.replace(/%/g, "%25").replace(/,/g, "%2C");

    for (const d of diags) {
      if (d.baseline) continue;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const endLine = d.range.end.line + 1;
      const endCol = d.range.end.character + 1;

      const level = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "notice";
      const codeSuffix = d.code ? ` (${d.code})` : "";
      const escapedMessage = d.message
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");

      commands.push(
        `::${level} file=${escapedFile},line=${line},col=${col},endLine=${endLine},endColumn=${endCol},title=nanos-lint::${escapedMessage}${codeSuffix}`,
      );
    }
  }

  return commands.join("\n");
}

/** Formats check results according to the chosen format (pretty, json, github). */
export function formatReport(
  result: CheckResult,
  format: "pretty" | "json" | "github" = "pretty",
  cwd: string = process.cwd(),
  useColor: boolean = shouldEnableColor(),
): string {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "github": {
      const pretty = formatPretty(result, cwd, useColor);
      const annotations = formatGitHubAnnotations(result, cwd);
      return annotations ? `${annotations}\n\n${pretty}` : pretty;
    }
    case "pretty":
    default:
      return formatPretty(result, cwd, useColor);
  }
}
