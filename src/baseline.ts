import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors.js";
import { writeAtomicFileSync } from "./lock.js";
import { fileUriToPath, type Diagnostic, type CheckResult } from "./types.js";

export interface BaselineEntry {
  path: string;
  code: string;
  message: string;
  severity: number;
  count: number;
}

export interface DiagnosticBaseline {
  version: 1;
  entries: BaselineEntry[];
}

/** Builds a line-independent diagnostic identity relative to the checked workspace root. */
function entryFor(root: string, uri: string, diagnostic: Diagnostic): BaselineEntry {
  const file = fileUriToPath(uri);
  const relative = path.relative(root, path.isAbsolute(file) ? file : path.resolve(root, file));
  return {
    path: relative.replace(/\\/g, "/"),
    code: diagnostic.code ?? "",
    message: diagnostic.message.replace(/\s+/g, " ").trim(),
    severity: diagnostic.severity,
    count: 1,
  };
}

/** Serializes the fields defining a diagnostic identity, excluding occurrence count. */
function keyFor(entry: BaselineEntry): string {
  return JSON.stringify([entry.path, entry.code, entry.message, entry.severity]);
}

/** Records sorted diagnostic identities and multiplicities without source positions. */
export function createBaseline(result: CheckResult, root: string): DiagnosticBaseline {
  const entries = new Map<string, BaselineEntry>();
  for (const [uri, diagnostics] of Object.entries(result.diagnostics)) {
    for (const diagnostic of diagnostics) {
      const entry = entryFor(root, uri, diagnostic);
      const key = keyFor(entry);
      const previous = entries.get(key);
      if (previous) previous.count++;
      else entries.set(key, entry);
    }
  }
  return {
    version: 1,
    entries: [...entries.values()].sort((a, b) => {
      const left = keyFor(a);
      const right = keyFor(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}

/** Validates a persisted baseline and rejects ambiguous or incompatible entries. */
export function readBaseline(file: string): DiagnosticBaseline {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as DiagnosticBaseline;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("Unsupported baseline schema (expected version 1).");
    }
    const keys = new Set<string>();
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        !entry.path ||
        typeof entry.code !== "string" ||
        typeof entry.message !== "string" ||
        !Number.isInteger(entry.severity) ||
        entry.severity < 1 ||
        entry.severity > 4 ||
        !Number.isSafeInteger(entry.count) ||
        entry.count < 1
      ) {
        throw new Error("Invalid baseline diagnostic entry.");
      }
      const key = keyFor(entry);
      if (keys.has(key)) throw new Error("Duplicate baseline diagnostic entry.");
      keys.add(key);
    }
    return parsed;
  } catch (cause) {
    throw new ConfigError(
      `Cannot read diagnostic baseline ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "ERR_BASELINE_READ",
      "Regenerate with 'nanos-lint check <targets> --write-baseline <path>' using the same targets and options.",
      { cause },
    );
  }
}

/** Atomically writes a deterministic baseline, creating its parent directory if needed. */
export function writeBaseline(file: string, result: CheckResult, root: string): void {
  try {
    writeAtomicFileSync(
      path.resolve(file),
      `${JSON.stringify(createBaseline(result, root), null, 2)}\n`,
    );
  } catch (cause) {
    throw new ConfigError(
      `Cannot write diagnostic baseline ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "ERR_BASELINE_WRITE",
      "Choose a writable baseline path.",
      { cause },
    );
  }
}

/** Classifies each diagnostic against an occurrence budget and computes strict staleness. */
export function compareBaseline(
  result: CheckResult,
  baseline: DiagnosticBaseline,
  root: string,
  strict = false,
): CheckResult {
  const remaining = new Map(baseline.entries.map((entry) => [keyFor(entry), entry.count]));
  const diagnostics: CheckResult["diagnostics"] = {};
  let baselined = 0;
  let total = 0;
  for (const [uri, items] of Object.entries(result.diagnostics)) {
    diagnostics[uri] = [...items]
      .sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character,
      )
      .map((diagnostic) => {
        const key = keyFor(entryFor(root, uri, diagnostic));
        const count = remaining.get(key) ?? 0;
        const matched = count > 0;
        if (matched) {
          remaining.set(key, count - 1);
          baselined++;
        }
        total++;
        return { ...diagnostic, baseline: matched };
      });
  }
  const stale = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  const newProblems = total - baselined;
  return {
    ...result,
    diagnostics,
    passed: newProblems === 0 && (!strict || stale === 0),
    baselineSummary: { new: newProblems, baselined, total, stale },
  };
}
