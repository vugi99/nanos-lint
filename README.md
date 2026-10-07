# nanos-lint

[![CI](https://github.com/vugi99/nanos-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/vugi99/nanos-lint/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/nanos-lint.svg)](https://www.npmjs.com/package/nanos-lint)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org/)
[![Lua Version](https://img.shields.io/badge/Lua-5.4.9-blue.svg)](https://www.lua.org/manual/5.4/)
[![LuaLS Version](https://img.shields.io/badge/LuaLS-latest-brightgreen.svg)](https://github.com/LuaLS/lua-language-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A dedicated, fast linter and type-checker for **[nanos world](https://nanos-world.com/)** Lua scripts powered by the **[Lua Language Server (LuaLS)](https://github.com/LuaLS/lua-language-server)**.

---

## Features

- **Realm-aware diagnostics**: `Server/`, `Client/` and `Shared/` are checked against their real execution context, so cross-realm API misuse and client/server global leakage fail the build instead of crashing at runtime.
- **Accurate nanos world Type Checking**: Bundles verified nanos world API annotations (Lua 5.4.9).
- **Zero-Install Local CLI**: Run directly via `npx nanos-lint [path]` without installing anything.
- **Native GitHub Action**: Use `vugi99/nanos-lint` directly in CI workflows with inline GitHub PR annotations.
- **Workspace Config Merging**: Fully respects local `.luarc.json` files, merging your project globals and disabled diagnostics on top of the nanos API.
- **Cross-Platform**: Works on **Windows x64**, **Linux (x64, arm64)**, and **macOS (Apple Silicon arm64, Intel x64)**. Automatically downloads and caches platform LuaLS binaries, defaulting to the latest LuaLS release and falling back to 3.19.1 when offline.
- **Modern Node.js Runtime**: Built targeting Node.js (>= 24) with zero runtime dependencies.

---

## Requirements

- **Node.js**: `>= 24.0.0` (required for npm/npx CLI usage; standalone release bundles include all dependencies)

---

## Quick Start

### 1. Run via `npx` (No installation needed)

Check the current directory:

```bash
npx nanos-lint
```

Check a specific directory or file:

```bash
npx nanos-lint check ./my-package
npx nanos-lint check ./my-package/Server/Index.lua
```

### 2. Global Installation

```bash
npm install -g nanos-lint

# Then use anywhere
nanos-lint check .
```

### 3. Setup VS Code / Neovim IntelliSense

To configure autocompletion, type annotations, and diagnostics in your local editor:

```bash
npx nanos-lint init
```

This generates a `.luarc.json` file in your workspace pointing to the nanos world definitions and schemas.

### 4. Pre-warm Cache for Offline / Docker Environments

To pre-populate all required assets (both LuaLS binary and nanos world annotations) for air-gapped CI or container builds:

```bash
npx nanos-lint warmup
```

Offline execution uses only local dependencies and skips all nanos-lint network requests:

```sh
nanos-lint warmup                         # provision online
nanos-lint check Packages/events --offline
npx --offline nanos-lint check Packages/events --offline
```

For `latest`, offline mode selects the highest usable cached version (numeric tag order)
and reports it, then tries a bundled binary or PATH. `LUALS_BIN` overrides discovery.
Pinned versions require a matching cache or local executable. Custom annotations
(`--annotations` or `NANOS_ANNOTATIONS_PATH`), bundled annotations, and valid stale
cached annotations work offline. `warmup --offline` verifies local assets without
downloading them. Missing assets fail with provisioning instructions.
The flag controls nanos-lint; npm/npx may access the registry before it starts. Use
a preinstalled executable or npm's own `--offline` with an already cached package.

---

## GitHub Actions Integration

Add `nanos-lint` to your repository's workflow (e.g. `.github/workflows/lint.yml`):

```yaml
name: Lint Lua Scripts

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7

      - name: Lint nanos world Lua scripts
        uses: vugi99/nanos-lint@v3
        with:
          path: "."
          checklevel: "Warning"
```

### Action Inputs

| Input             | Description                                                                           | Default   |
| :---------------- | :------------------------------------------------------------------------------------ | :-------- |
| `path`            | Path to workspace directory or Lua file to check                                      | `.`       |
| `paths`           | One or more workspace target paths or Lua files to check (newline or comma-separated) | `""`      |
| `dep`             | External package dependency paths or definition files (newline or comma-separated)    | `""`      |
| `checklevel`      | Minimum severity to report (`Error`, `Warning`, `Information`, `Hint`)                | `Warning` |
| `config`          | Path to a custom `.luarc.json` configuration file                                     | `""`      |
| `annotations`     | Path to a custom `annotations.lua` file                                               | `""`      |
| `ignore`          | Files or directories to ignore (supports glob patterns, newline or comma separated)   | `""`      |
| `luals-version`   | Version of `lua-language-server` to use                                               | `latest`  |
| `baseline`        | Accepted diagnostic baseline; only new diagnostics fail                               | `""`      |
| `write-baseline`  | Record current diagnostics and exit successfully                                      | `""`      |
| `baseline-strict` | Also fail when baseline entries disappear (requires `baseline`)                       | `false`   |
| `fail-on-error`   | Fail the workflow step if diagnostics are found                                       | `true`    |
| `log-level`       | Logging level (`error`, `warn`, `info`, `debug`, `silent`)                            | `warn`    |
| `realm`           | Execution realm to check (`all`, `client`, `server`, `shared`)                        | `all`     |
| `cache`           | Whether to cache the LuaLS binary and annotations across workflow runs                | `true`    |

`paths` takes precedence over `path` when both are set; `path` is kept for backwards compatibility with the single-target form.

When caching is enabled, the cache key rolls over each ISO week, so a freshly downloaded LuaLS binary is actually persisted under the new week's key; in the meantime the previous week's entry is restored from the cache.

When running inside GitHub Actions, `nanos-lint` automatically outputs **workflow annotations** (`::error` / `::warning`) that appear inline on PR diffs.

---

## CLI Reference

```
nanos-lint [command] [options] [paths...]

COMMANDS:
  check [paths...]         Check workspace files or directories (default)
  init [path]              Scaffold a .luarc.json configuration in the workspace (supports --vendor, --force)
  copy-annotations [dest]  Copy cached annotations.lua definitions into a target file or directory (alias: export-annotations; targets not ending in .lua are treated as directories)
  warmup, download         Pre-fetch and cache both LuaLS binary and annotations for offline execution
  cache status, cache info Show cache status, installed versions, and disk usage (supports --json)
  cache clean              Clear the nanos-lint cache directory
  cache-status             Alias for cache status
  download-luals [version] Download and cache the LuaLS binary (the version can also be passed via --luals-version <ver>)
  clean-cache, clean       Clear the nanos-lint cache directory
  help, --help, -h         Show help message
  version, --version, -v   Show version information

OPTIONS:
  -i, --ignore <pattern>   Files or directories to ignore (supports globs, repeatable, comma/newline-separated)
  -d, --dep <path>         Path to package dependency directory or Lua definition file (repeatable; resolves relative to cwd)
  -l, --log-level <level>  Logging level: error, warn, info, debug, silent (default: warn)
                           silent suppresses all output, including the final report and the progress display (only the exit code remains)
                           error and warn (the default) hide the info-level log lines and the non-interactive progress milestones but still print the report and the interactive progress bar
                           debug adds diagnostic tracing
  --checklevel=<level>     Minimum diagnostic level: Error, Warning, Information, Hint (default: Warning)
  --config=<path>          Path to custom .luarc.json configuration file
  --annotations=<path>     Path to custom annotations.lua file (applies to check, init --vendor, and copy-annotations)
  --format=<format>        Output format: pretty, json, github (default: pretty)
  --github                 Output in GitHub Actions format (shortcut for --format=github)
  --luals-version=<ver>    Version of LuaLS to use (default: latest, falling back to 3.19.1 when offline)
  --baseline <path>        Report and fail only on new diagnostics
  --write-baseline <path>  Record diagnostics and exit 0
  --baseline-strict        Also fail on stale entries (requires --baseline)
  --no-fail                Do not exit with code 1 if diagnostics are found
  --realm <realm>          Execution realm to check: all, client, server, shared (default: all)
  --offline                Use local dependencies only; never access the network
  --no-progress            Disable the interactive download, extraction and realm derivation progress display
  -t, --template <path>    (init command only) Use a custom JSONC scaffold template
  --vendor                 (init command only) Vendor annotations.lua into .nanos-lint/ inside workspace
  -f, --force              (init and copy-annotations only) Overwrite existing files
```

### Diagnostic Baselines

Use a diagnostic baseline to accept an existing backlog and fail on new problems:

```sh
nanos-lint check . --write-baseline .nanos-lint/baseline.json
nanos-lint check . --baseline .nanos-lint/baseline.json
nanos-lint check . --baseline .nanos-lint/baseline.json --baseline-strict
```

Recording writes all reported diagnostics in a deterministic versioned JSON file,
creates parent directories, and exits 0 (also with `--no-fail`). Comparison shows
only new diagnostics with a summary such as `12 new, 154 baselined, 166 total`.
JSON output retains every diagnostic and adds `baseline: true|false` plus
`baselineSummary` counts. GitHub annotations are emitted only for new diagnostics.

Matches use paths relative to the checked root, diagnostic code, whitespace-normalized
message, severity, and occurrence counts. Line changes preserve matches; additional
occurrences or severity changes are new problems. Removed occurrences are stale and
only fail with `--baseline-strict`. `--no-fail` suppresses diagnostic failure, including
strict staleness; invalid baseline files still fail. Missing, invalid, or incompatible
files require regeneration with `--write-baseline`. Recording and comparison are
mutually exclusive. Keep targets, realm, check level, configuration, and LuaLS version
consistent between runs; pin `--luals-version` to avoid diagnostic changes from upgrades.
Relative baseline paths are resolved from the working directory.

The GitHub Action exposes the same options as `baseline`, `write-baseline`, and
`baseline-strict` inputs:

```yaml
- uses: vugi99/nanos-lint@v3
  with:
    baseline: .nanos-lint/baseline.json
    baseline-strict: "false"
```

### Progress Display

Downloads and extractions (`LuaLS` archive, `annotations.lua`, realm derivation) report their
progress on **stderr**, so `stdout` keeps carrying only the diagnostic report:

```
[luals] Downloading lua-language-server-3.19.1-linux-x64.tar.gz [=====>        ] 37% (1.31 MB / 3.51 MB, 8.2 MB/s, ETA 0.3s)
[luals] Extracting lua-language-server-3.19.1-linux-x64.tar.gz ⠹ (2.4s)
```

A live, in-place redraw is used only when stderr is an interactive terminal. Everywhere else
(CI runners, pipes, redirected output, `TERM=dumb`) the same information is emitted as discrete
single-line milestones, so logs stay free of carriage returns:

```
[luals] Downloading lua-language-server-3.19.1-linux-x64.tar.gz: 25% (901 KB / 3.51 MB)
[luals] Downloaded lua-language-server-3.19.1-linux-x64.tar.gz (3.51 MB in 0.1s (37.3 MB/s))
```

Dynamic redrawing is also disabled by `--no-progress`, `NANOS_NO_PROGRESS`, `--format json`,
`-l silent`, `CI`, `NO_COLOR` and `TERM=dumb`. When a transfer declares a compressed
`content-length` (GitHub serves `annotations.lua` gzip-encoded), the percentage is dropped in
favour of transferred bytes and speed instead of reporting a misleading total.

Machine-readable output owns `stdout`: with `--format json` (and `cache status --json`) the
milestones, completions and every other `info`/`debug` diagnostic move to `stderr` as well, so
`nanos-lint check . --format json -l info | jq .` works at any log level.

### Environment Variables

| Variable                                      | Description                                                                                                                                                                                                                    |
| :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LUALS_BIN`                                   | Explicit path to a pre-installed `lua-language-server` binary; it must be a regular file that reports its version via `--version` (thin wrapper scripts are accepted), otherwise nanos-lint fails with `ERR_LUALS_BIN_INVALID` |
| `NANOS_ANNOTATIONS_PATH`, `NANOS_ANNOTATIONS` | Explicit path to a custom `annotations.lua` file                                                                                                                                                                               |
| `NANOS_LOG_LEVEL`                             | Default logging level: `error`, `warn`, `info`, `debug`, `silent` (default: `warn`)                                                                                                                                            |
| `GITHUB_TOKEN`                                | GitHub personal access token used for authenticated GitHub API requests (avoids unauthenticated rate limits)                                                                                                                   |
| `NANOS_NO_PROGRESS`                           | Disables the interactive download/extraction progress display when set to any non-empty value other than `0`, `false`, `no` or `off`                                                                                           |
| `NO_COLOR`                                    | Disables ANSI color output when set to any non-empty value; dynamic progress redrawing stops for any non-empty value other than `0`, `false`, `no` or `off`                                                                    |
| `FORCE_COLOR`                                 | Forces ANSI color output even in non-TTY environments                                                                                                                                                                          |

Only `NANOS_LOG_LEVEL` controls the logging level; a generic `LOG_LEVEL` environment variable is intentionally not read, because CI images commonly set it.

`NANOS_LIVE_TESTS` and `NANOS_TEST_CACHE_ROOT` only affect this repository's test suite and are documented under [Test Suite Environment Variables](#test-suite-environment-variables).

---

## Workspace Configuration (`.luarc.json`)

If your project already has a `.luarc.json`, `nanos-lint` automatically merges it. Your custom settings (e.g., custom globals, disabled diagnostics, additional libraries) are retained, while nanos world definitions are injected in `workspace.library`:

```json
{
  "$schema": "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json",
  "diagnostics": {
    "disable": ["lowercase-global"],
    "globals": ["MyCustomGlobal"]
  }
}
```

To scaffold a `.luarc.json` configuration in your project:

```bash
npx nanos-lint init
# Or overwrite an existing configuration:
npx nanos-lint init --force
```

By default `init` writes no annotations reference at all: `workspace.library` stays empty and
`nanos-lint check` injects the managed cache path into its own temporary merged configuration at
runtime, so a later cache update is picked up without touching repository files. Editors that read
`.luarc.json` directly need a pinned copy, which is always an explicit opt-in:

```bash
# Initialize with annotations vendored into .nanos-lint/ and pinned in workspace.library
npx nanos-lint init --vendor

# Or copy the cached annotations to a custom file, or to any target that does not end in
# ".lua" (treated as a directory). Copying alone does not pin anything: add the resulting
# path to workspace.library yourself.
npx nanos-lint copy-annotations
npx nanos-lint copy-annotations ./types
```

`copy-annotations` refuses to overwrite an existing file unless `--force` is passed.

### Custom Init Templates

Initialize packages from a shared configuration template:

```sh
nanos-lint init Packages/events --template tools/team-luarc.json
nanos-lint init Packages/events -t tools/team-luarc.json --vendor --annotations tools/annotations.lua
```

The custom JSON/JSONC file becomes the base configuration. Relative paths in its
settings are interpreted relative to the target workspace, so shared templates can
use entries such as `nanos.deps: ["../collider"]`. Custom settings and realm mappings
are preserved, including `{}` to disable realms. Omitted realm mappings receive
the conventional Server/Client/Shared defaults. Vendoring adds its annotation
library, ignore and exclusion entries without discarding template entries. Existing
`.luarc.json` files still require `--force` to overwrite.

### Realm Mapping (`nanos.realms`)

nanos world runs two isolated Lua VMs: the server executes `Server/**` + `Shared/**`, the client executes `Client/**` + `Shared/**`. `nanos-lint` mirrors that split and lets you describe a non-standard layout in `.luarc.json`:

```json
{
  "nanos": {
    "realms": {
      "src/server/**": "server",
      "src/client/**": "client",
      "common/**": "shared"
    }
  }
}
```

| Realm value             | Meaning                                                                                                         |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `"server"`              | Checked with the server context: client-only APIs and `Client/**` globals do not exist.                         |
| `"client"`              | Checked with the client context: server-only APIs and `Server/**` globals do not exist.                         |
| `"shared"` / `"global"` | Checked with the complete context, because a shared script may guard side-specific calls behind runtime checks. |

- Omitting `nanos.realms` falls back to the conventional `Server/**`, `Client/**`, `Shared/**` layout, and realm passes only run when at least one of those patterns matches a checked Lua file.
- `"nanos": { "realms": {} }` disables realm checking and restores a single standard pass.
- When several entries match the same file, the last matching entry wins.
- Files matched by no entry (a root `main.lua`, for example) are checked with the complete context.

The `nanos` key is nanos-lint specific and ignored by LuaLS, so the same `.luarc.json` keeps working in the editor.

### Package Dependencies (`nanos.deps`)

When packages depend on other packages (e.g. located in `Server/Packages/` or external integration folders), you can declare them in `.luarc.json` under `nanos.deps` or via the `-d, --dep` CLI option:

```json
{
  "nanos": {
    "deps": ["../base_package", "../integration_package", "../definitions/common.lua"]
  }
}
```

- **Path Resolution**: Paths defined in `nanos.deps` resolve relative to the package directory containing the `.luarc.json`. In contrast, paths passed via the `-d, --dep <path>` CLI option resolve relative to the current working directory (`process.cwd()`).
- **Transitive Dependencies & Cycle Detection**: Dependencies are traversed recursively. If a dependency defines its own `nanos.deps` in `.luarc.json`, those dependencies are loaded automatically. Circular dependencies are detected and visited only once.
- **Realm Partitioning**: Dependency directories are inspected for realm conventions (`Server/`, `Client/`, `Shared/`). Server passes only include `Server/` and `Shared/` folders of dependencies; client passes only include `Client/` and `Shared/` folders. Single definition `.lua` files and non-partitioned dependency directories are included in all passes.
- **Resilience**: If a declared dependency path does not exist, `nanos-lint` emits a warning and continues without failing the lint pass.

### File Counting and Glob Semantics

The `N files checked` figure is produced by matching `workspace.ignoreDir` and `files.exclude` with the bundled `glob` engine. The v3.0.0 contract is:

- **Trailing slashes and `./` prefixes** are normalized (`vendor/` behaves like `vendor`), and `\` separators are converted to `/`.
- **Wildcards** follow standard glob semantics (`*`, `**`, `?`, `[0-9]`, `{a,b}`), including inside `workspace.ignoreDir`.
- **Absolute entries are rejected** (with a warning). LuaLS matches patterns relative to the workspace root, and `glob` anchors absolute patterns inconsistently across platforms, so one `.luarc.json` stays portable by not supporting them.
- **Negation prefixes (`!pattern`) are rejected** (with a warning). LuaLS uses a gitignore-style matcher without negation support, so honoring `!` here would count files LuaLS never checks.
- **Over-budget patterns** (excessive wildcards or brace alternatives) are skipped with a warning instead of risking a slow, backtracking-heavy match. Skipping can only over-count, never hide a file.
- **Symlinks are never followed**: symlinked `.lua` files are not counted and symlinked directories are not traversed.
- A `workspace.ignoreDir` list in your `.luarc.json` **replaces** the built-in defaults for that file, mirroring LuaLS. The configuration handed to LuaLS is always merged with nanos-lint's defaults, so `.git`, `.vscode`, `.nanos-lint` and `node_modules` stay ignored during a check.

---

## Realm-Aware Checking

nanos world loads a package into two isolated Lua VMs: the **server** executes `Server/**` plus `Shared/**`, and the **client** executes `Client/**` plus `Shared/**`. `nanos-lint` mirrors that split so a `Client/` script can no longer call `Server.ChangeMap()` unnoticed, and a global defined in `Client/` no longer satisfies a `Server/` script.

`nanos-lint check <path>` detects the conventional layout automatically and runs one LuaLS pass per realm (see [Realm Mapping](#realm-mapping-nanosrealms) to describe a custom layout):

| Pass       | Files reported             | Context                                                                                                                |
| :--------- | :------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **server** | `Server/**`                | Server annotations only; `Client/**` is excluded from the analysis.                                                    |
| **client** | `Client/**`                | Client annotations only; `Server/**` is excluded from the analysis.                                                    |
| **shared** | `Shared/**` and root files | The complete annotation set, because a shared script may legitimately call a side-specific API behind a runtime check. |

Only the annotations that belong to a realm are loaded, so misuse is reported as `undefined-global` (for side-only classes such as `Client`, `Server`, `Database` or `WebUI`) or as `undefined-field` (for realm-specific members of classes that exist on both sides, such as `Character:SetTeam()` on the client).

```bash
nanos-lint check .                # every detected realm
nanos-lint check . --realm server # server files + shared files
nanos-lint check . --realm client # client files + shared files
nanos-lint check . --realm shared # shared files only, with the complete context
```

Deliberate limits:

- **Runtime guards are not analyzed.** `Shared/**` is checked with the complete context, so a guarded `Server.ChangeMap()` inside a `Package.IsUnloading()`-style branch is accepted, and so is an unguarded one. Real nanos world packages gate calls in too many ways for static detection to be reliable.
- **`Package.Require` keeps resolving across realms**, because `runtime.path` keeps `?.lua`, `Shared/?.lua`, `Client/?.lua` and `Server/?.lua` in every pass. A shared file may require a realm-specific module behind a guard.
- **Realm checking only activates when a configured pattern matches at least one checked Lua file**, so non-package repositories keep running a single standard pass. `"nanos": { "realms": {} }` disables it explicitly.

### Variadic Target Paths & Scoped Context

`nanos-lint` accepts multiple files or directories on the command line:

```bash
# Lint both Shared and Server folders in one pass
npx nanos-lint check Shared/ Server/ --realm server

# Lint multiple specific files
npx nanos-lint check Shared/utility.lua Server/main.lua
```

- **Project Root Discovery**: When checking subpaths or individual files (e.g. `Server/main.lua`), `nanos-lint` searches upward to locate the enclosing project root containing `.luarc.json` so custom realm mappings and dependencies are properly loaded.
- **Unrequested Sibling Exclusion**: To prevent unrelated files under the common ancestor directory from defining globals that mask `undefined-global` diagnostics in requested files, `nanos-lint` automatically excludes unrequested siblings during the check.
- **Root Filesystem Protection**: Target paths must share a common project directory. Passing disjoint paths spanning the filesystem root (or different drive letters on Windows) is rejected with an error.

---

## Pre-packaged Release Distributions (Offline / CD)

Pre-packaged release bundles containing the platform's `lua-language-server` binary, vendored `annotations.lua`, and the nanos-lint CLI wrapper are available on the [Releases](https://github.com/vugi99/nanos-lint/releases) page:

- `nanos-lint-<version>-windows-x64.zip`
- `nanos-lint-<version>-linux-x64.tar.gz`
- `nanos-lint-<version>-linux-arm64.tar.gz`
- `nanos-lint-<version>-macos-arm64.tar.gz` (Apple Silicon)
- `nanos-lint-<version>-macos-x64.tar.gz` (Intel)

These bundles are fully self-contained and ready for offline CI/CD environments with Node.js installed, eliminating the need to download LuaLS or annotations at runtime. Simply extract the archive and run `./nanos-lint` (Linux & macOS) or `nanos-lint.cmd` (Windows).

---

## Development

```bash
# Clone the repository
git clone https://github.com/vugi99/nanos-lint.git
cd nanos-lint

# Install dependencies
npm install

# Run all quality gates (recommended before commit/PR)
npm run gates
# Or alias
npm run check:all

# Run individual quality gates
npm run format:check    # Prettier code formatting (auto-fix via npm run format:fix)
npm run lint            # ESLint
npm run lint:deps       # Dependency architecture & license checks (dependency-cruiser)
npm run lint:comments   # Comment density limit (<= 10%)
npm run lint:docstrings # Docstring coverage (>= 90% top-level/exported function coverage per file in src/)
npm run typecheck       # TypeScript typecheck
npm run build           # Build distribution bundle
npm run test:coverage   # Vitest unit + live LuaLS integration tests with coverage

# Offline: skip live LuaLS tests, perform no network access, disable coverage thresholds
NANOS_LIVE_TESTS=0 npm run test:coverage
```

### Test Suite Environment Variables

`tests/global-setup.ts` downloads the LuaLS binary and annotations **once per run** into an isolated temporary cache, so the real `~/.cache/nanos-lint` is never touched; the run fails if anything downloads LuaLS a second time.

| Variable                | Description                                                                                                                                                                                                                                    |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NANOS_LIVE_TESTS`      | `0` (or `false`/`no`/`off`) skips the live LuaLS/annotations tests, performs no network access, and does not enforce the coverage thresholds. Any other value or unset requires the shared fixtures; if they cannot be resolved the run fails. |
| `NANOS_TEST_CACHE_ROOT` | Reuses the given directory as the isolated test cache instead of a fresh one, avoiding a re-download on repeat runs.                                                                                                                           |

```bash
NANOS_LIVE_TESTS=0 npm run test:coverage                          # fully offline
NANOS_TEST_CACHE_ROOT=/tmp/nanos-tests npm run test:coverage      # reuse a warm cache
```

See [AGENTS.md](AGENTS.md) for development philosophy and quality gate requirements.

---

## License

[MIT](LICENSE)
