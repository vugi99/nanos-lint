export class NanosLintError extends Error {
  public override readonly name: string = "NanosLintError";

  constructor(
    message: string,
    public readonly code: string,
    public readonly remedy?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class ConfigError extends NanosLintError {
  public override readonly name: string = "ConfigError";
}

export class LuaLSError extends NanosLintError {
  public override readonly name: string = "LuaLSError";
}

export class AnnotationsError extends NanosLintError {
  public override readonly name: string = "AnnotationsError";
}

export class CacheError extends NanosLintError {
  public override readonly name: string = "CacheError";
}

export class ExportTypesError extends NanosLintError {
  public override readonly name: string = "ExportTypesError";
}
