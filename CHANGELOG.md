# Changelog

All notable changes to `nanos-lint` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `--offline` for local-only LuaLS and annotation resolution across commands, preserving stale caches and explicit version constraints (#61).

### Changed

- Configured Dependabot version update pull requests for npm and GitHub Actions to target `dev`.
- Updated TypeScript ESLint packages from 8.70.1 to 8.71.0 via Dependabot (#63, #64); the standalone parser update (#65) was superseded by #64.
- Updated dependency-cruiser from 18.4.0 to 18.5.0 and ESLint from 10.11.0 to 10.12.0 via Dependabot (#66, #67).

## [3.3.0] - 2026-10-02

### Added

- Added `copy-annotations` CLI command (with `export-annotations` alias) and programmatic `copyAnnotations()` export to copy cached nanos world definitions into a workspace or custom target path (#56). Targets not ending in `.lua` (case-insensitive) are treated as directories.
- Added `--vendor` option to `nanos-lint init` allowing explicit opt-in to copying annotations into `.nanos-lint/` and configuring `workspace.library` (#56).

### Changed

- Lowered comment density quality gate threshold from 15.0% to 10.0% across all source, test, and script files.
- `nanos-lint init` no longer pins or vendors `annotations.lua` by default; workspaces are initialized with managed annotations dynamic resolution (#56).
- Removed automatic push guidance from `AGENTS.md` so changes are pushed only on explicit user request.
- Extracted the `check` command implementation into `src/cli-check.ts` and the shared stdout helper into `src/output.ts` (internal refactor, no behavior change).

### Fixed

- `nanos-lint init --annotations` without `--vendor` now fails with `ERR_ANNOTATIONS_WITHOUT_VENDOR` instead of silently writing a configuration that ignores the custom definitions file (#56).

### Security

- Updated security supported versions policy in `SECURITY.md` to specify that only the latest release is supported and older releases are not supported. Updated agent guidance and release skills accordingly.

## [3.2.1] - 2026-09-30

### Changed

- Updated `@types/node` from 26.6.2 to 26.6.3 via Dependabot (#52).
- Updated Vitest and `@vitest/coverage-v8` from 5.0.2 to 5.0.3.

### Fixed

- Preserve LuaLS caches when validation is blocked by `EPERM` or `EACCES`, and report the binary path and execution permissions or sandbox policy remedy instead of attempting corruption repair (#53). Cache repair permission failures now surface directly.

### Security

- Dropped security support for versions < 3.2.1 in `SECURITY.md`.

## [3.2.0] - 2026-09-27

### Added

- Added `src/download-guard.ts` with the shared outbound transfer policy: `isAllowedDownloadUrl()`, `guardedFetch()` and `cancelResponseBody()`. `guardedFetch()` resolves redirects hop by hop in `redirect: "manual"` mode, so each hop is validated against the HTTPS + GitHub allowlist before it is ever contacted, and it also refuses a 3xx without a `Location` header, a redirect chain longer than `MAX_REDIRECT_HOPS`, and a final response that left the allowlist.
- Added `tests/unit/download-guard.test.ts` covering off-host redirects, plaintext `http://` downgrades, internal/link-local targets, hop exhaustion, unusable or missing `Location` headers, opaque redirects and transport failures.
- Added terminal progress reporting for the long-running network and CPU operations (#50):
  - Added `src/terminal-progress.ts` with `createProgressBar()`, `createSpinner()`, `isProgressInteractive()`, `formatTransferSummary()`, `setProgressMode()` and `restoreTerminal()`. Both displays redraw in place on a TTY (throttled to ~10 frames/s), fall back to discrete `info`-level milestones without a terminal, hide the cursor only while redrawing, and restore it on completion, failure, `SIGINT`/`SIGTERM`, uncaught exceptions and process exit.
  - The LuaLS release archive download now renders a byte progress bar with percentage, transferred/total size, transfer speed and ETA; the transfer completion line reports size, duration and average speed.
  - The LuaLS archive validation and extraction now render an indeterminate spinner with elapsed time, switching its label to the verification stage.
  - The `annotations.lua` download now renders a byte progress bar with transferred size, speed and, when the transport declares an uncompressed length, percentage and ETA.
  - Realm annotation derivation now renders an indeterminate spinner that is advanced by parse progress, so it keeps animating while the synchronous split blocks the event loop.
  - Added `--no-progress` and the `NANOS_NO_PROGRESS` environment variable to disable the interactive display; `--format json` disables it as well.
- Added `trackDownloadProgress()` to `src/luals/download.ts`, which reports cumulative transferred bytes while passing a download stream through unchanged.
- Added `parseDeclaredContentLength()` to `src/download-guard.ts`, which reads a response `content-length` only when the runtime streams the bytes it describes.
- Added unit tests in `tests/unit/terminal-progress.test.ts` plus progress assertions in `tests/unit/annotations.test.ts`, `tests/unit/realms.test.ts`, `tests/unit/luals-cache.test.ts` and `tests/unit/cli.test.ts`.
- Added allowlist boundary coverage to `tests/unit/download-guard.test.ts` (look-alike hosts such as `evilgithub.com` and `github.com.evil.com`, uppercase hosts, userinfo, trailing-dot hosts, `https://` IP literals, non-HTTPS schemes, protocol-relative and blank `Location` headers, the exact hop-budget acceptance case), plus assertions that every refused response body is released and that an off-allowlist hop is never contacted. `tests/unit/luals-redirect-guard.test.ts` pins the same property for the LuaLS archive download, including a plaintext hop to an allowlisted host, which only the scheme check can refuse (CWE-829).
- Added `Logger.setDiagnosticStream()`/`getDiagnosticStream()` in `src/logger.ts` and the cross-origin credential-stripping rule in `guardedFetch()`.

### Changed

- The download allowlist (`ALLOWED_DOWNLOAD_DOMAINS`, `isAllowedDownloadUrl()`) now lives in `src/download-guard.ts` and is re-exported from `src/luals/download.ts`, so the policy has a single definition while the existing public API is unchanged.
- `splitAnnotationsByRealm()` accepts an optional progress callback and reports parse, classification and render stages; `readBoundedResponseBody()` in `src/annotations-download.ts` accepts an optional per-chunk progress callback.
- The LuaLS release archive download in `src/luals/download.ts` now runs through `guardedFetch()` instead of a bare `fetch()` whose redirects were only inspected after the target had been contacted, so the archive — the request that always redirects upstream — is validated hop by hop like every other outbound request. A refused hop fails fast with `ERR_LUALS_DOWNLOAD` and is never retried; transient failures keep the existing three-attempt backoff.
- The release-packaging tooling reuses the shared guard instead of its own copy of the check: `downloadAssetHardened()` in `scripts/packaging/verify.ts` and `resolveLuaLSReleaseVersion()` in `scripts/package-release.ts` both call `guardedFetch()`.
- `--no-progress` (and every other global option) is now listed by `nanos-lint <command> --help`, and the flag description names realm derivation, which it also governs.
- `runCLI()` starts each run from the default redraw policy and diagnostic stream, so an in-process repeat run cannot inherit `--no-progress` or JSON routing from the previous one.

### Fixed

- Progress lines now go to stderr in every mode, not only while redrawing: the non-interactive milestones, announcements and completion lines were written to stdout, contradicting the documented `stdout` guarantee. With `--format json` (and `cache status --json`) the `info`/`debug` diagnostics are routed to stderr as well, so `nanos-lint check . --format json -l info` emits a JSON report on stdout that parses at any log level.
- `guardedFetch()` drops `Authorization`, `Cookie` and `Proxy-Authorization` when a hop leaves the origin of the original request. Re-issuing each hop manually had started forwarding credentials that the runtime strips when it follows a redirect itself.
- A redirect with a blank `Location` header is now refused as `missing-location` instead of resolving to the current URL and burning the whole hop budget re-requesting it.
- `cancelResponseBody()` no longer throws when a response exposes no `cancel()` or when `cancel()` returns a non-promise, so cleanup can never mask the reason a response was refused.
- Progress percentages are no longer derived from a compressed `content-length`: GitHub serves `annotations.lua` gzip-encoded, so its declared length (108 KB) described the compressed payload while 926 KB were streamed, producing milestone lines such as `25% (32.0 KB / 106 KB)`. A declared length is now used only when the response is not content-encoded, and a total the transfer has already passed is dropped in favour of transferred bytes and speed.
- `fetchRawAnnotationsContent()` now validates every redirect hop and the final response URL against the allowlist instead of relying on the default `redirect: "follow"`, which contacted the redirect target before any check could run. A refused redirect fails fast with `ERR_ANNOTATIONS_DOWNLOAD`, a remedy naming the refused redirect, and a `logger.warn` visible at the default log level.
- `fetchLatestCommitId()` and `fetchLatestLuaLSVersionFromGitHub()` no longer follow redirects unchecked; both refuse an off-allowlist redirect (warning and returning `null`) so the documented transport policy covers every outbound request, not only requests that end in a file write.
- A blocked annotations redirect can no longer poison the cache: the refused body is cancelled and neither `annotations.lua` nor `metadata.json` is rewritten, so the previously cached annotations and commit pin survive.
- The `lock heartbeat (#44)` mtime test in `tests/unit/concurrency.test.ts` no longer depends on wall-clock scheduling (#49). It sampled the lock's `mtime` every 35 ms while asserting `isLockStale(lockPath, 80) === false`, which measured the runner's timer punctuality rather than the heartbeat: a synchronous stall longer than the staleness window starves the heartbeat callback, so `mtime` ages past the threshold and the assertion fails mid-test. Measured on Windows, the observed lock age is `stall + ~16 ms`, so the old `staleMs: 40` failed from roughly a 25 ms stall and the loosened `staleMs: 80` only moved that boundary to roughly 65 ms — no finite tolerance makes it reliable. The test now freezes `Date.now()` and drives the captured heartbeat callback directly, so a genuinely stale lock (backdated `createdAt` and `mtime`) must become fresh through exactly the production `touchLockFile()` path; fault injection confirms it still fails when the heartbeat is disabled. A second test keeps the real-timer contract by asserting the heartbeat touches the lock repeatedly during a slow task, without asserting how punctually.
- The companion "postpones stale timeout as long as the heartbeat is beating" test no longer asserts staleness from inside a worker's timed loop — the same wall-clock dependence that failed `windows-latest`. Worker 1 now outlasts the staleness threshold while worker 2 polls the held lock, and the test asserts both that worker 2 really did evaluate the lock (so it cannot pass vacuously by waiting out the release) and that it never entered early. Measured on Windows the lock ages only 1–24 ms against a 300 ms threshold while the heartbeat beats, and fault injection still fails the test, with the reclaim actually firing once the heartbeat is disabled.
- A CodeQL "Incomplete regular expression for hostnames" alert in `tests/unit/annotations.test.ts` is resolved by asserting the refused redirect against a literal message substring instead of interpolating the URL into a `RegExp`.
- CI proved the remaining wall-clock sensitivity of the two heartbeat tests, so their margins were widened again: `postpones stale timeout as long as the heartbeat is beating` now uses a 1500 ms staleness window, a 50 ms heartbeat and a 3000 ms hold (20 s timeout, 20 ms poll), and `proves that without heartbeat the lock becomes stale, but with heartbeat it stays fresh` uses a 600 ms window, a 25 ms heartbeat and a 1500 ms delay. A loaded four-vCPU Windows runner shares the scheduler with every other vitest worker, so a false failure now needs a stall of more than a second; fault injection with the heartbeat disabled still fails all three timing-sensitive tests.

### Security

- Applied the documented _Strict Protocol and Host Allowlisting_ policy (`SECURITY.md`) to the runtime annotations download. Previously a redirect to any host — including a plaintext `http://` address or an internal/link-local one — was followed silently and the response body was cached as the user's type-definition source.
- Completed that policy for the LuaLS release archive, which `SECURITY.md` already claimed. The archive download now validates every hop before contacting it, so a redirect aimed at an internal or plaintext target can no longer make the machine reach a host outside GitHub infrastructure even though the resulting body was refused.
- Dropped security support for versions < 3.2.0 in SECURITY.md.

## [3.1.0] - 2026-09-25

### Added

- Support for package dependencies via `nanos.deps` in `.luarc.json` and `-d, --dep <path>` CLI option (#47):
  - Added repeatable `-d, --dep <path>` CLI option to `check` command, supporting package directories and single `.lua` definition files.
  - Added support for `nanos.deps` array in `.luarc.json` to declare dependencies relative to package configuration files.
  - Implemented `src/deps.ts` resolving transitive package dependencies with cycle detection.
  - Partitioned resolved dependency libraries across realm passes: server pass receives `Server/`, `Shared/`, and root `.lua` files; client pass receives `Client/`, `Shared/`, and root `.lua` files; shared pass receives `Shared/` and root `.lua` files. When realms are disabled, all dependency paths are supplied to the single standard pass.
  - Non-existent dependency paths emit a non-fatal warning (`logger.warn`) and are skipped without failing the check or contributing to problem counts.
  - Added unit tests in `tests/unit/deps.test.ts` and `tests/unit/cli.test.ts`, and live integration test in `tests/integration/cli-execution.test.ts`.
- Variadic target paths for `check` command (`npx nanos-lint check [paths...]`) (#46):
  - Changed CLI `check` argument definition to `check [paths...]`, allowing multiple directories and/or files to be passed simultaneously (e.g. `npx nanos-lint check Shared/ Server/ --realm server`).
  - Added `src/target-resolver.ts` to compute the lowest common ancestor directory across multiple targets and filter reported diagnostics and file counts to only match the requested paths.
  - In realm-aware checks (`planRealmCheck()`), targets are mapped within the common workspace root, enabling server scripts to reference shared declarations without undefined-global errors while skipping unrequested passes (such as client).
  - Updated `CheckOptions` in `src/types.ts` to accept optional `paths?: string[]`.
  - Added unit tests in `tests/unit/target-resolver.test.ts` and `tests/unit/cli.test.ts`, and integration tests in `tests/integration/cli-execution.test.ts`.
- Added `paths` and `dep` inputs to the GitHub Action composite definition (`action.yml`).

### Changed

- Cached parsed `.luarc.json` configurations in `src/deps.ts` to eliminate duplicate disk reads and JSON parsing during dependency graph traversal.
- Logged the discovered project root at debug level when a check is re-parented to an enclosing directory holding `.luarc.json`.

### Fixed

- Symlinked and non-canonical target paths no longer discard diagnostics: roots and targets are canonicalized via `getCanonicalPath()` in `resolveCheckTargets()`, `matchesTargetPaths()` and `filterReportByTargetPaths()`.
- Unrequested sibling files under a common ancestor directory no longer leak globals that mask `undefined-global` diagnostics, by computing and applying `computeUnrequestedExclusions()` to `files.exclude` in both realm-aware and fallback passes.
- Escaped glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`, `,`) in the computed `files.exclude` entries, so siblings with such names are really excluded instead of being read as character ranges or brace groups by the LuaLS `glob.gitignore` matcher.
- Excluded unrequested siblings inside dot-directories: the previous blanket skip left their Lua files visible to LuaLS, where they could still define globals.
- Discovered the enclosing project root containing `.luarc.json` via `findProjectRoot()` when checking subpaths or single files, properly preserving realm configurations and package dependencies.
- Corrected the "target is the workspace root" guard in `computeUnrequestedExclusions()`, which compared a resolved path against the raw root argument and therefore never matched.
- Added cross-volume (`ERR_MULTIPLE_ROOTS`) and filesystem root (`ERR_ROOT_ANCESTOR`) validation for target paths.
- Emitted a warning (`logger.warn`) when a requested realm filter matches no target files before falling back to a standard check.
- Hardened the cross-process lock heartbeat test margins (1000 ms hold, 500 ms staleness, 100 ms heartbeat) so a stalled Windows runner cannot falsely reclaim a live lock; a disabled heartbeat still fails the test (#49).
- Replaced regex trailing slash removal with index-based scanning in `src/target-resolver.ts` to prevent polynomial ReDoS CodeQL warnings (`js/polynomial-redos`).

### Security

- Dropped security support for versions < 3.1.0 in SECURITY.md.

## [3.0.1] - 2026-09-25

### Added

- Periodic lock heartbeat in `withFileLock()` (`src/lock.ts`) for long-running cache extractions and downloads (#44):
  - Added `heartbeatIntervalMs?: number` to `FileLockOptions`, defaulting to `staleMs / 4` capped at 15s (or disabled when `staleMs <= 0`).
  - Implemented non-destructive `touchLockFile()` using `fs.utimesSync()`, ensuring an active heartbeat updates the file's modification timestamp without rewriting metadata or risking clobbering another worker's acquired lock.
  - Paired with `Math.max(createdAt, mtime)` freshness calculation in `isLockStale()` and `lockAgeMs()`.
  - Added immediate heartbeat timer cancellation with a warning when lock ownership is lost, and a warn-once report if timestamp updates fail.
  - Note: synchronous operations executed inside the locked section (such as hashing archives or synchronous recursive directory copies) block the event loop, so heartbeat ticks only fire during asynchronous phases.
  - Reduced `DEFAULT_LOCK_STALE_MS` from 120s to 30s: with the 60s default timeout (`DEFAULT_LOCK_TIMEOUT_MS`), abandoned locks from hard-killed processes (`SIGKILL` / power loss) can now be reclaimed automatically before timeout, while live processes stay protected by the heartbeat.
  - Added comprehensive unit tests in `tests/unit/concurrency.test.ts` verifying non-destructive touching, mtime advancement, clean timer disposal, error handling, lost-ownership cancellation, disabled heartbeat modes, and cross-process mutual exclusion across slow tasks.

### Changed

- Upgraded devDependencies `vitest` and `@vitest/coverage-v8` to `5.0.2`.

### Security

- Dropped security support for versions < 3.0.1 in SECURITY.md.
- In `downloadAndExtractLuaLS()` (`src/luals/download.ts`), fail fast when an HTTP redirect targets an untrusted, off-allowlist domain instead of retrying up to three times, log a warning at warn level, and preserve the typed `LuaLSError` with its security remediation instructions.

## [3.0.0] - 2026-09-25

### Added

- Updated GitHub Actions workflow snippet in README.md to recommend floating major tag `uses: vugi99/nanos-lint@v3` and documented post-release manual GitHub Marketplace publishing procedure in `.agents/skills/new-release/SKILL.md` and `AGENTS.md` (#4).
- Realm-aware checking (#15): `nanos-lint check` now mirrors the two nanos world VMs instead of analyzing one merged workspace.
  - The server pass indexes `Server/**` + `Shared/**` with shared+server annotations and excludes client-only files; the client pass is its mirror image; the shared pass keeps the complete annotation set and reports `Shared/**` plus files matched by no realm pattern, so a guarded side-specific call stays legal.
  - Realm libraries are derived mechanically from the cached upstream `annotations.lua` by reading its side markers (`both`, `client-only`, `server-only`, `authority-only`, `network-authority`): unmarked declarations inherit their class or sibling member realm, and a realm-specific class table (such as `Weapon`, declared server-only but with 35 shared instance methods) keeps only the members that realm can actually use. Derived files are cached under the system cache keyed by the annotations revision.
  - Cross-realm misuse is reported as `undefined-global` for side-only classes (`Client`, `Server`, `Database`, `WebUI`, …) and as `undefined-field` for realm-specific members of classes that exist on both sides (`Character:SetTeam()` on the client), while globals defined in `Client/**` no longer satisfy `Server/**` and vice versa.
  - New `--realm <all|client|server|shared>` flag selects which passes run (`client` and `server` keep the shared pass; `shared` runs the full-context pass only).
  - Plan logic lives in `src/realms.ts` and the annotation splitter in `src/annotations-realms.ts`, both exported from the programmatic API; `listCheckedFiles()` was extracted from `countCheckedFiles()` so realm assignment reuses the exact set of files LuaLS checks.
  - Fixtures under `tests/fixtures/realms*` plus `tests/integration/realms.test.ts` cover cross-realm calls, global isolation, guarded shared calls, custom mappings, the disabled escape hatch, `--realm` selection and the split of the real upstream annotations.
- `nanos.realms` configuration in `.luarc.json` for custom package layouts (#35): each entry maps a glob pattern (relative to the checked root) to `server`, `client`, `shared` or the `global` alias, the last matching entry wins, files matched by no entry are treated as shared, and the `nanos` key is ignored by LuaLS so editor support is unaffected. Omitting the key keeps the conventional `Server/**`, `Client/**`, `Shared/**` layout, while `"nanos": { "realms": {} }` disables realm passes. Unusable entries (unknown realm names, empty patterns, non-object values) are dropped with a warning, and the default template now ships the conventional mapping as documentation.
- Zero-dependency cross-process locking and atomic file replacement (`src/lock.ts`) so parallel `nanos-lint` runs can share one user cache (#7):
  - `withFileLock()` acquires locks with `fs.openSync(..., "wx")` (`O_CREAT | O_EXCL`), records `{ pid, createdAt, token }`, queues contenders with jittered exponential backoff, reclaims abandoned locks (dead owner pid or older than 120s), and only unlinks the lock it still owns.
  - `writeAtomicFileSync()` / `writeAtomicFile()` write to a unique sibling temp file and rename over the target with retries for transient `EBUSY`/`EPERM`/`EACCES` errors, so readers never observe a truncated file.
- LuaLS installs now serialize on a per-version lock (`.luals-<version>.lock`) and repeat the `.complete` probe once the lock is held, so a cold cache with N parallel workers downloads and extracts exactly once while the others reuse the promoted directory (#7).
- Annotations updates serialize on `.annotations.lock` and reuse the file a concurrent worker just wrote instead of re-downloading and overwriting it (#7).
- `tests/unit/concurrency.test.ts` covering 25 racing metadata writers with concurrent readers, in-process mutual exclusion, separate-process mutual exclusion (four child processes verifying no interleaved critical sections), stale-lock recovery for dead and expired owners, lock-ownership safety, atomic-write retry and cleanup, ten parallel `resolveAnnotations()` callers on a cold cache (exactly one raw download), and four parallel `downloadAndExtractLuaLS()` workers (exactly one copy) (#7).
- `new-release` agent skill (`.agents/skills/new-release/SKILL.md`) documenting the release procedure as guided by AGENTS.md: verifying the `master` branch, bumping the npm version, dropping security support for older versions in `SECURITY.md`, promoting `## [Unreleased]` in `CHANGELOG.md`, updating the pinned `npx --yes nanos-lint@<version>` fallback in `action.yml`, committing through the quality gates, and creating and pushing the `v<version>` tag.
- Regression test suite (`tests/unit/validation-zip.test.ts`) for the ZIP pre-extraction inspection, built on a byte-level archive builder that can tamper with every structural field: zeroed entry counts, empty archives, ZIP64 archives with and without sentinel EOCD fields, out-of-range and mismatched central directory offsets/sizes/counts, truncated central directories and local file headers, missing or corrupt ZIP64 locator/record/extra-field structures, multi-disk archives, symlink/path-escape/drive-relative/UNC members, data-descriptor members, orphan local file headers, and a second EOCD hidden inside the first record's comment. Verified against archives written by Python `zipfile`, PowerShell `Compress-Archive`, and the published LuaLS `win32-x64` release asset.
- Committed ZIP fixtures written by real tools (`tests/fixtures/zip/`, with provenance and regeneration commands in its README): Python `zipfile` with an archive comment, a stored member and a `force_zip64` member, Python `zipfile` over a non-seekable stream (data descriptor), and Info-ZIP with its extra fields. The suite asserts their exact member counts and declared sizes, so the "no false positives" property is enforced in CI rather than verified by hand.

### Changed

- `countCheckedFiles()` semantics are pinned by golden tests instead of the pre-#27 differential harness (breaking for the test suite, not for users, #33): `tests/helpers/legacy-count.ts` and the `legacyCountCheckedFiles()` comparisons were deleted, the 19 parity configurations became explicit expected counts, and the `intended behaviour differences` block was renamed to `glob semantics`, since the retired walker is no longer the reference. The v3.0.0 semantics are now: `!`-prefixed and absolute patterns are rejected with a warning instead of being silently misinterpreted, symlinked files and directories are never counted, over-budget patterns stay skipped with a warning (which can only over-count), and a user `workspace.ignoreDir` keeps replacing the built-in defaults for that file while the merged config handed to LuaLS always includes them. Documented in the README under "File Counting and Glob Semantics".
- `downloadAndCacheAnnotations()` no longer copies through a temp directory plus a rollback backup: the fetched payload and its metadata are written with atomic renames (metadata last), so an interrupted or failed update leaves the previous cache intact and is retried on the next run (#7).
- Extracted pure ZIP structural parsing into `src/luals/zip.ts` (`findEndOfCentralDirectory()`, `resolveCentralDirectoryLocation()`, `readZipCentralDirectoryRecord()`, `readZipLocalFileHeader()`, `assertCentralDirectoryTerminator()`, `assertLocalFileHeadersTileArchive()`), leaving `src/luals/validation.ts` with the inspection policy and within the 500-line module budget. `inspectZipMembers()` remains exported from `src/luals/validation.ts`.
- Behaviour change for callers of the public `validateArchiveMembers()` export: a ZIP archive is now rejected with `ERR_LUALS_EXTRACT` when it is empty (zero declared members), when its last end of central directory record does not declare a comment reaching the end of the file (trailing data after the archive), or when its local file headers do not exactly account for the central directory's members. Archives with a normal archive comment are unaffected.

### Removed

- `--quiet` / `-q` CLI flag and the `quiet?: boolean` option across the programmatic API (breaking, #3): `nanos-lint check --quiet`, `nanos-lint warmup -q|--quiet`, the `quiet` input of `action.yml`, and the `quiet` field of `CheckOptions`, `ResolveLuaLSOptions`, `DownloadOptions`, `ResolveAnnotationsOptions` and the third argument of `downloadAndCacheAnnotations()` are gone. Output is now governed by a single knob: `-l, --log-level error` suppresses progress while still printing the report, `--log-level silent` suppresses everything. The GitHub Action exposes the same control through its new `log-level` input (default `warn`), and the redundant `if (!options?.quiet)` guards were deleted so `Logger` is the only component gating output.
- Legacy LuaLS cache discovery and automatic migration (breaking, #2): `getLegacyCacheDir()` is gone from `src/luals.ts` and from the public API exports, `findExistingLuaLSDir()` no longer probes the pre-2.3.0 locations (`%LOCALAPPDATA%\nanos-lint\luals\<version>` on Windows, `~/.cache/nanos-lint/luals/<version>` on Linux/macOS), and `resolveLuaLSBinary()` no longer copies (`fs.cpSync`) a legacy installation into the system cache. LuaLS discovery now follows a single hierarchy: `LUALS_BIN` → bundled package → system cache → `PATH` → download. This also closes #23, because `nanos-lint clean-cache` can no longer leave a legacy tree behind that the next run would silently re-migrate.

### Fixed

- Realm file assignment (`collectRealmFiles()`) now returns workspace-relative paths with their on-disk casing instead of lowercasing them on Windows; realm report sets are keyed by normalized paths separately, so diagnostics still match on Windows' case-insensitive file system (#15).
- The realm CLI tests in `tests/integration/cli-execution.test.ts` are now hermetic: they pin `--format=pretty` and normalize path separators, because the pretty reporter prints OS-native separators while `GITHUB_ACTIONS` in the environment switches the CLI to the slash-normalized annotation format. A new unit test asserts that `GITHUB_ACTIONS` auto-selection so the two environments can no longer mask each other (#15).
- Windows concurrency-test flakiness plus the lock hardening it uncovered (#7): the multi-process mutual-exclusion test no longer infers overlaps from a shared append log, because sibling processes' file writes are not a reliable ordering signal on Windows under load — each worker now proves exclusion from _inside_ the critical section with an exclusive-create marker and an owner-token read-back, and asserts one start/end pair per worker instead of global ordering. `withFileLock()` additionally treats `EPERM`/`EACCES`/`EBUSY` create failures as contention while the lock exists (Windows reports these instead of `EEXIST` while a lock is being deleted or swapped), verifies it still owns the file it just created, reclaims an abandoned lock only after a 1s grace period and only while its owner token is unchanged, and also gained the timeout that a stale-but-young lock previously bypassed in an unbounded retry loop.
- `inspectZipMembers()` (`src/luals/validation.ts`) no longer treats an unwalkable ZIP central directory as an empty archive: the directory is walked record by record from its declared offset until the declared end, every walked record is validated, and the archive is rejected unless the walk terminates on a valid end of central directory record whose record count matches the declared count and is greater than zero.
- ZIP64 archives are now inspected instead of skipped: the ZIP64 end of central directory locator and record supply the 64-bit member count, directory offset and directory size whenever the 32-bit EOCD fields are sentinels, the per-entry ZIP64 extended information extra field (0x0001) supplies 64-bit member sizes and local header offsets, and any disagreement between the 32-bit fields and the ZIP64 record is rejected.
- The inspection now anchors on the same end of central directory record that extraction uses. Every backend (`tar.exe`/libarchive, PowerShell `Expand-Archive`/.NET, Info-ZIP, Python) takes the _last_ EOCD signature in the file and ignores its declared comment length, so an archive whose last record does not end the file is rejected instead of falling back to an earlier, comment-consistent record whose central directory extraction never reads.
- Every member's local file header is now cross-checked against its central directory record (name bytes, compression method, and declared sizes unless a data descriptor is used) _and_ the two views are reconciled: the first local file header must start at offset 0, each member must begin where the previous member's data (plus its validated trailing data descriptor, when present) ends, and the last member must end exactly at the central directory. Unreferenced local file headers (which `tar.exe` extracts through its streamable reader when the EOCD sits outside its 16 KiB search window), unreferenced bytes, overlapping members and mismatched data descriptors are now rejected, which also restores the member-count and declared-size limits for members that previously existed only outside the inspected central directory. Archives with a record between the central directory and the EOCD (archive extra data record `0x08064b50`, digital signature `0x05054b50`) are consequently rejected as well: fail-closed is deliberate for release assets.
- Harden `checkEscapedMember()` to reject drive-relative member paths (`C:evil.sh`) in addition to absolute drive paths (`C:\evil.sh`), UNC/rooted paths and `..` segments.
- Reject multi-disk archives and ZIP64 archives whose sentinel fields cannot be resolved from a readable locator, end record or extra field, instead of proceeding with a partially inspected member list.

### Security

- Hardened release workflow packaging pipeline (`.github/workflows/release.yml`, `scripts/package-release.ts`, `scripts/packaging/*`):
  - Pre-extraction archive validation: All five upstream LuaLS release archives are inspected before extraction with `validateArchiveMembers()`, rejecting symlinks/hardlinks, path traversals (`..`, leading `/`, drive letters, UNC paths), member counts exceeding 10,000, and declared decompressed sizes exceeding 500 MB.
  - Safe extraction flags: Tar archives are extracted with `--no-same-owner --no-same-permissions` and zip archives are extracted with `unzip -q -o` into clean, dedicated target directories (with PowerShell `Expand-Archive` fallback on Windows).
  - Post-extraction tree invariants: The extracted directory tree is traversed to guarantee no symbolic links, hard links, or escaped paths exist, total decompressed size does not exceed 500 MB, the complete expected file set (`bin/lua-language-server(.exe)`, `main.lua`, `locale/`, `meta/`, `script/`) exists, and binary headers match the target architecture (ELF/PE/Mach-O).
  - Transport hardening: Enforced HTTPS only, restricted redirects to allowlisted domains (`github.com`, `githubusercontent.com`), capped archive download streams to 150 MB, and recorded SHA-256 digests for audit.
  - Pinned `annotations.lua`: Pinned upstream API annotations download to an immutable commit SHA resolved via GitHub API instead of mutable branch HEAD, enforced size bounds (1,000 bytes to 10 MiB), and recorded SHA-256 digests for audit.
  - Release provenance manifest: Writes `release-builds/SHA256SUMS` containing the resolved release tag, LuaLS version, pinned annotations commit SHA, and release archive SHA-256 checksums, published as a release asset (note: header metadata comments are informative and unauthenticated as the manifest cannot authenticate itself).
  - Third-party Action pinning: Pinned `softprops/action-gh-release` in `.github/workflows/release.yml` to immutable commit SHA `efb35369e0ad2afab669f228072c1b0d510eae64` (`# v3`).
  - Added dedicated packaging test suite under `tests/packaging/` separated from app tests, covering pre-extraction checks, safe extraction, tree invariants, binary architecture inspection, transport hardening, and annotations commit pinning with coverage thresholds enforced.
- Closed the fail-open bypass in the `inspectZipMembers()` ZIP pre-extraction inspection added for #31 (GHSA-4x3m-f5v4-qvp4): a release asset whose EOCD declared zero members, or whose declared central directory offset was out of range or the `0xFFFFFFFF` ZIP64 sentinel, previously walked nothing and returned `{ memberCount: 0, totalDeclaredSize: 0 }`, letting archive-planted symlinks, path-escaping members and oversized/inflated archives pass every check before extraction. Such archives are now rejected with `ERR_LUALS_EXTRACT`.
- Closed two further ways to be extracted while uninspected, both reachable with an archive whose central directory alone looked valid: a second end of central directory record hidden in the first record's comment (the inspector and the extraction backends previously selected different records), and local file headers that no central directory record references (libarchive's streamable reader extracts them when the EOCD sits outside its 16 KiB search window). With both closed, the member path, link, count (10,000) and declared size (500 MB) constraints apply to the same member set the extraction backends will actually extract, and the `tar.exe`-then-`Expand-Archive` fallback in `src/luals/download.ts` no longer changes which members are extracted.
- Dropped security support for versions < 3.0.0 in SECURITY.md.

## [2.8.2] - 2026-09-24

### Added

- Prettier code formatting quality gate (`npm run format:check` and auto-fix `npm run format:fix`) enforcing consistent code style across all TypeScript, JSON, Markdown, and YAML files, with `eslint-config-prettier` integration to disable conflicting ESLint rules (#41).
- Dependency architecture, bundle boundaries, and license compliance quality gate (`npm run lint:deps` via `dependency-cruiser` and `.dependency-cruiser.cjs`), enforcing zero cycles, strict layer boundaries, tsdown bundle compliance, orphan detection, and MIT-compatible permissive licenses (#40).
- Docstring quality gate script (`npm run lint:docstrings` via `scripts/lint-docstrings.ts`) enforcing >= 90% function documentation coverage per file across `src/`, with comprehensive JSDoc coverage across all production modules (#38).
- Comment density quality gate script (`npm run lint:comments` via `scripts/lint-comments.ts`) enforcing <= 15% pure comment lines on files with >= 50 lines, with condensed commentary in verbose modules and exception support (#37).
- Unified quality gates npm script (`npm run gates` and alias `npm run check:all`) chaining all mandatory project quality gates in sequence, simplifying pre-commit hooks and documentation (#39).
- Hardening tests for shipped `templates/.luarc.json` (#36):
  - Unit tests in `tests/unit/config.test.ts` asserting 100% of keys in `diagnostics.severity` and `diagnostics.neededFileStatus` belong to `VALID_LUALS_DIAGNOSTIC_CODES`, merging default template emits zero dropped-key warnings, and the `$schema` URL pattern is valid.
  - Live integration test in `tests/integration/luals.test.ts` verifying the `$schema` URL is reachable (HTTP 200) and returns valid JSON.
  - Live integration test in `tests/integration/luals.test.ts` verifying that each default diagnostic severity promotion (`unused-local`, `redefined-local`, `unused-vararg`) actively triggers at `Warning` severity on live LuaLS.

### Fixed

- Cross-platform ZIP archive safety inspection (`inspectZipMembers` in `src/luals/validation.ts`) using pure-JS central directory parsing without spawning external processes (`tar` or PowerShell), fixing Linux test failures on `.zip` fixtures where GNU `tar` does not support ZIP archives (#31).
- Cross-platform LF line endings normalization in `.gitattributes` (`* text=auto eol=lf`), preventing Git checkouts on Windows runners with `core.autocrlf=true` from failing Prettier code formatting checks (#41).
- Close file descriptor in a `finally` block when `fs.readSync()` throws in `isAnnotationsValid()`, preventing descriptor leaks on I/O errors (#32, #34).
- Close file descriptor in a `finally` block when `fs.readSync()` throws during custom or environment annotations validation in `validateCustomAnnotationsPath()`.
- Drop ineffective LuaLS binary and annotations `actions/cache` step and week computation from CI workflow, which were never read or written by the isolated test suite (#29).
- Cap `annotations.lua` download size (10 MB via `MAX_ANNOTATIONS_SIZE_BYTES`) and commit JSON response (1 MB via `MAX_COMMIT_JSON_SIZE_BYTES`) before buffering in memory, rejecting over-large responses with `ERR_ANNOTATIONS_TOO_LARGE` and remediation naming `--annotations <path>` (#30).
- Bound decompressed archive size (500 MB via `MAX_DECOMPRESSED_SIZE_BYTES`) and member count (10,000 via `MAX_ARCHIVE_MEMBER_COUNT`) during LuaLS archive inspection before and after extraction, rejecting archives with symlink/hardlink members, directory escapes, or excessive members/size with `ERR_LUALS_EXTRACT` (#31).
- Return `null` immediately in `fetchLatestCommitId()` when response exceeds limit, preventing double-read of consumed response body via `res.json()` on Node.js 24 (#30, #42).
- Include `scripts/**/*.ts` in `tsconfig.json` and ESLint checks so quality gate tooling is typechecked and linted (#42).
- Clarify dependency cruiser rule names and docstring coverage specifications for top-level/exported functions (#42).

### Security

- Dropped security support for versions < 2.8.2 in SECURITY.md.

## [2.8.1] - 2026-09-24

### Added

- Security vulnerability reporting guidelines and working `gh api` CLI examples in `AGENTS.md` specifying private GitHub Security Advisories for responsible disclosure.
- Bundled `glob@13` together with its `minimatch`, `path-scurry`, `lru-cache`, `minipass`, and `brace-expansion` dependency tree, inlined through `tsdown` so the published package keeps zero runtime dependencies while `countCheckedFiles()` gains full glob support (#27).
- Regression tests for `LUALS_BIN` / `--luals-bin` validation (#26) and for glob-based file counting, covering brace expansion, character classes, adversarial pattern budgets, unusable patterns, and symlink handling (#27).
- Differential parity test (`tests/unit/glob-parity.test.ts`) that runs the pre-#27 `countCheckedFiles()` implementation against the bundled-glob one on the same fixture tree, pinning the configs where behaviour must stay identical and documenting each intended difference (#27).

### Changed

- `countCheckedFiles()` (`src/luals/files.ts`) now walks the tree and matches `files.exclude` / `workspace.ignoreDir` patterns with the bundled `globSync()` instead of a hand-rolled recursive walk plus glob-to-regex translation: brace expansion (`{a,b}`), character classes (`[0-9]`), `?` and `**` follow standard glob semantics, patterns without a slash keep matching at any depth, and a trailing slash (`vendor/`) is treated like `vendor` (#27).
- Glob wildcards now apply to `workspace.ignoreDir` entries as well (`deep/*` previously matched nothing), and unusable pattern values (`""`, `"."`, NUL bytes, oversized strings, absolute paths, non-string JSON values) are skipped instead of throwing out of `countCheckedFiles()`. Absolute patterns are rejected everywhere on purpose: `glob` anchors them on some platforms but not others, so skipping them keeps one `.luarc.json` behaving identically on Linux, macOS and Windows (#27).
- `LUALS_BIN` and `--luals-bin` are validated instead of trusted: a path that is missing, is a directory, or is not a runnable LuaLS binary now fails with `ERR_LUALS_BIN_INVALID` naming the setting, instead of being silently ignored or failing deep inside the check run (#26). Thin wrapper scripts that report a version stay supported — the 100 KB floor for downloaded archives is not applied to user-supplied binaries.

### Fixed

- Validate `LUALS_BIN` / `options.lualsBin` by requiring a regular file whose `--version` reports a LuaLS release, with actionable remediation hints naming `LUALS_BIN` / `--luals-bin` (#26).
- Repaired the Issue #20 archive-planted symlink regression test, which aborted while extracting an intentionally fake archive before reaching the symlink guard it asserts on.
- Repaired the Issue #17 traversal regression test, which a discoverable valid LuaLS installation (such as the shared live-test fixture) could legitimately satisfy, so the poisoned `metadata.json` path was never exercised deterministically.
- Sanitize `metadata.json` `latestVersion` with `sanitizeLuaLSVersion()` and enforce cache boundary checks before resolving cached binary paths, preventing path traversal and arbitrary binary execution outside the cache tree (#17).
- Canonicalize both the extracted binary and the extraction directory before the directory-escape check, so a cache path reached through symlinks (such as macOS `os.tmpdir()` under `/var` -> `/private/var`) no longer rejects every download (#20).
- Enforce 120s timeout and stream LuaLS archive downloads directly to disk with a 150 MB upper bound, preventing indefinite process hangs and out-of-memory exhaustion; the SHA-256 audit hash reads the archive in 1 MiB chunks so the memory bound holds after the download too (#18).
- Enforce HTTPS GitHub host allowlisting on download URLs and redirects, log the downloaded archive SHA-256 digest (at `info` level, for out-of-band comparison against a locally pinned value), and document the binary verification model in `SECURITY.md` (#19).
- Harden tar extraction with `--no-same-owner --no-same-permissions` on POSIX and validate extracted binary path against symlinks and directory escapes before chmod or execution (#20).
- Prevent symlink loops and directory escapes in `countCheckedFiles` by resolving the checked root to its canonical path and never traversing symlinked directories or counting symlinked files (#21).
- Pin annotations downloads to resolved upstream commit SHAs, enforce named constant `MIN_ANNOTATIONS_SIZE_BYTES` with strict header validation against generic comments, and validate custom/env annotation paths against directories, empty files, and binary files (#24).

### Security

- Bound glob pattern complexity in `countCheckedFiles()` (#27): patterns that exceed the per-segment wildcard (max 2), total wildcard (max 12) or brace-expansion (max 256) budget are skipped with a warning, keeping the walk bounded against catastrophic regex backtracking and combinatorial brace expansion from a hostile `.luarc.json`. The budgets are conservative on purpose — matching cost grows like `C(segment length, wildcards per segment)` — and a skipped pattern only over-counts the reported file total, never under-counts it.
- Dropped security support for versions `< 2.8.1` in `SECURITY.md`.

## [2.8.0] - 2026-09-23

### Added

- Cache status and inspection command (`nanos-lint cache status`, `cache info`, and `cache-status`) with human-readable terminal output and `--json` export displaying cached LuaLS binaries, annotations commit SHA, metadata freshness, and disk usage (#14).
- Cache inspection and sizing utilities (`getCacheStatus`, `formatCacheStatusPretty`, `getDirectorySize`, `formatBytes`) exported in `src/cache-status.ts` and `src/paths.ts` (#14).
- Dedicated unit test suite `tests/unit/cache-status.test.ts` verifying disk size calculation, byte formatting, empty and populated cache reporting, and CLI subcommands (#14).
- Exported helper `listCachedLuaLSVersionDirs()` in `src/luals/cache.ts` and `countCheckedFiles()` in `src/luals/files.ts`.
- Documented `nanos-lint cache clean` subcommand in `README.md` and CLI references.
- Dedicated warmup / download CLI command (`nanos-lint warmup` and alias `download`) pre-fetching and caching both the LuaLS binary and nanos world annotations for air-gapped CI and Docker build pipelines (#13).
- Centralized typed error hierarchy in `src/errors.ts` (`NanosLintError`, `ConfigError`, `LuaLSError`, `AnnotationsError`, `CacheError`) providing structured error codes and actionable remediation hints for users and programmatic consumers (#12).
- Enhanced CLI error reporting formatting `NanosLintError` failures with clean error messages and remediation hints (`hint: ...`) without raw stack traces unless running with `--log-level=debug` or `DEBUG` (#12).
- Dedicated unit test suite `tests/unit/errors.test.ts` testing error classes, codes, call sites, and CLI formatting (#12).
- Exported validator `isAnnotationsValid()` in `src/annotations.ts` verifying file existence, minimum size (>= 1000 bytes), and valid Lua headers.
- Dedicated unit test suite `tests/unit/cache-corruption.test.ts` covering automated self-healing across corrupted annotations, malformed metadata, broken binaries, and legacy cache states.

### Changed

- Promoted `redefined-local`, `unused-local`, and `unused-vararg` diagnostics from `Hint` to `Warning` in `templates/.luarc.json`; projects running with default `--checklevel=Warning` can opt out by specifying `--checklevel=Error` or setting their severities back to `Hint` in `.luarc.json`.
- Dropped `?/init.lua` from default `runtime.path` in `templates/.luarc.json` intentionally to align with standard nanos world package layouts.
- Updated `$schema` URL in `templates/.luarc.json` and `README.md` to point to the live `LuaLS/vscode-lua` repository.
- Refined module coverage floors in `vitest.config.ts` targeting `src/luals/runner.ts`, `src/luals/cache.ts`, and `src/luals/download.ts`, while excluding zero-logic re-export shims (`src/luals.ts`, `src/luals/index.ts`).
- Aligned `diagnostics.neededFileStatus` in `mergeConfigs()` to key-merge overrides alongside `diagnostics.severity`.
- Enhanced `ERR_LUALS_CORRUPTED_CACHE` error messages in `resolveLuaLSBinary()` to include actual underlying failure causes instead of unconditionally claiming offline.
- Configured GitHub Actions CI workflow triggers on pull requests targeting `dev` while constraining `push` triggers to `master` and `main` to prevent duplicate workflow runs on PRs (`.github/workflows/ci.yml`).
- Enforced file line limits via ESLint `max-lines` (500 lines for `src/**/*.ts`, 1000 lines for `tests/**/*.ts`).
- Modularized `src/luals.ts` into `src/luals/` submodules (`version.ts`, `platform.ts`, `cache.ts`, `download.ts`, `runner.ts`, `validation.ts`, `files.ts`, and `index.ts`), retaining 100% backward-compatible exports from `src/luals.ts`.
- Automated self-healing for corrupted or malformed `metadata.json` files across LuaLS and annotations caches, automatically purging invalid JSON files on parse errors.
- Enhanced `resolveAnnotations()` to purge corrupted or 0-byte cached files and automatically fall back to bundled definitions when offline.
- Improved offline diagnostics in `resolveLuaLSBinary()` providing clear remediation hints (`nanos-lint clean-cache`) when cached binaries fail execution checks and cannot be re-downloaded.
- Enabled `noUncheckedIndexedAccess` and `noImplicitOverride` in `tsconfig.json` for safer array/dictionary index access and explicit inheritance semantics.
- Enforced async, promise safety, and strict equality guardrails in `eslint.config.mjs` (`@typescript-eslint/no-floating-promises`, `@typescript-eslint/await-thenable`, `@typescript-eslint/no-misused-promises`, `eqeqeq`, and `prefer-const`).
- Documented transitive runtime dependency `is-safe-filename` (from `env-paths@4.0.0`) in `tsdown.config.ts`, explaining why it is inlined into the zero-dependency bundle.
- Cleaned up redundant `diagnostics.globals` singletons in `templates/.luarc.json` that are already declared as global tables in `annotations.lua`.
- Configured nanos package lookup paths (`Shared/?.lua`, `Client/?.lua`, `Server/?.lua`) and mapped `"Package.Require": "require"` via `runtime.special` in `templates/.luarc.json`.
- Updated `AGENTS.md` guidelines noting that running checks manually before committing is unnecessary because the full quality suite runs automatically in the pre-commit hook.

### Fixed

- Fixed single-file diagnostic filtering in `runLuaLSCheck` (`src/luals/runner.ts`) across macOS and Windows by canonicalizing paths with `fs.realpathSync.native` to handle symlinks (such as `/var` vs `/private/var` on macOS) and 8.3 short names on Windows runner environments.
- Fixed cache status inspection in `getCacheStatus()` (`src/cache-status.ts`) by targeting `<cache>/luals` rather than `<cache>`, accurately discovering cached LuaLS copies, metadata freshness, and distinguishing valid versus corrupted binaries (#14).
- Filtered `diagnostics.severity` and `diagnostics.neededFileStatus` keys against LuaLS's 62 valid diagnostic codes in `mergeConfigs()`, automatically dropping obsolete or unrecognized keys (such as `syntax-error`) with a warning to prevent LuaLS from silently voiding the entire severity table (#22).
- Resolved circular import between `src/luals/cache.ts` and `src/luals/download.ts` by extracting `isBinaryValid()` to `src/luals/validation.ts`.
- Clamped `formatBytes()` for inputs `< 1` and handled scale promotion on boundary rounding (e.g. `1023.6` -> `"1.00 KB"`, `0.4` -> `"0 B"`).
- Consistently honored `reuseExisting: false` across all bundled, cached, and PATH fallback branches in `resolveLuaLSBinary()` and `downloadAndExtractLuaLS()`.
- Extracted `countCheckedFiles()` from `src/luals/runner.ts` to `src/luals/files.ts`, keeping `runner.ts` well under the 500-line limit.
- Fixed legacy cache path collision on Linux where `getLegacyCacheDir` resolved to the same directory as the primary cache, preventing redundant probes in `findExistingLuaLSDir` and respecting `reuseExisting: false` in `resolveLuaLSBinary`.
- Duplicate releases: pushing a release commit to `master` and its tag produced two qualifying CI runs, so the release ran twice and the second `npm publish` failed with a 409. The release job now only runs for tag-triggered CI, skips a tag whose GitHub release already exists, and skips `npm publish` when the version is already published.

### Security

- Dropped security support for versions `< 2.8.0` in `SECURITY.md`.

## [2.7.0] - 2026-09-23

### Added

- Centralized logger module (`src/logger.ts`) providing configurable log levels (`error`, `warn`, `info`, `debug`, `silent`) with default level `"warn"`.
- `-l, --log-level <level>` CLI parameter on root and `check` command and `NANOS_LOG_LEVEL` environment variable to configure the application log level.
- Custom ESLint rule `local/no-empty-catch` in `eslint.config.mjs` preventing empty or silent `catch` blocks across the codebase.
- Dedicated unit tests for the logger module (`tests/unit/logger.test.ts`) and CLI log level configuration (`tests/unit/cli.test.ts`).
- Exported helper `findExistingLuaLSDir()` in `src/luals.ts` to discover pre-installed LuaLS directories in primary cache, legacy cache, or bundled distributions.
- `reuseExisting` option in `DownloadOptions` for `downloadAndExtractLuaLS()`, enabling reuse of existing platform binaries without network download.
- Pre-packaged standalone Linux ARM64 (`nanos-lint-<version>-linux-arm64.tar.gz`) and macOS release archives (`nanos-lint-<version>-macos-arm64.tar.gz` for Apple Silicon and `nanos-lint-<version>-macos-x64.tar.gz` for Intel) bundling platform LuaLS binaries, vendored annotations, and shell launchers in `.github/workflows/release.yml`.
- `macos-latest`, `macos-26-intel`, and `ubuntu-26.04-arm` runners to the GitHub Actions CI test matrix in `.github/workflows/ci.yml`.
- Architecture-aware cache keys (`${{ runner.os }}-${{ runner.arch }}`) in `.github/workflows/ci.yml` and `action.yml` preventing cross-architecture cache collisions between x64 and arm64 runners.
- Documentation in `README.md` for standalone Linux ARM64 and macOS release distributions, `-l, --log-level` option, and `NANOS_LOG_LEVEL` environment variable.
- Weekly checking cadence for LuaLS updates in `src/luals.ts` tracking ISO week in `metadata.json` (`lastCheckedWeek`), eliminating redundant GitHub API requests on every invocation.
- Automatic cleanup helper `cleanupOldCachedLuaLSVersions()` removing older cached LuaLS version directories when a newer version is downloaded or verified.
- Dedicated unit test suite `tests/unit/luals-cache.test.ts` verifying weekly ISO week caching, metadata parsing, cache discovery, error recovery, and older version purging.
- Isolated test harness (`tests/global-setup.ts`, `tests/helpers/`): each run uses its own cache/temp tree, so tests never read or write the real `~/.cache/nanos-lint`.
- One shared LuaLS/annotations download per run in the global setup, memoized per worker, plus a counter that fails the run when LuaLS is downloaded more than once.
- `cacheDir` and `reuseExisting` options for `resolveLuaLSBinary()`, `findExistingLuaLSDir()`, and `downloadAndExtractLuaLS()`.
- `NANOS_LIVE_TESTS=0` offline test mode (no network access, coverage thresholds disabled).
- Per-file coverage floor for `src/luals.ts` in `vitest.config.ts`.
- Architecture check (ELF/Mach-O/PE header) for every bundled LuaLS binary in the release packaging step; real arm64 execution is covered by the `ubuntu-26.04-arm` CI job.
- `.gitattributes` keeping `.githooks/**` and shell scripts on LF (and `*.cmd`/`*.bat` on CRLF).
- Regression test asserting that a warm weekly cache validates exactly one binary.

### Changed

- `resolveLuaLSBinary()` checks the weekly metadata before enumerating the cache, so the warm path validates one binary instead of spawning LuaLS once per cached version.
- `--log-level=silent` now suppresses the diagnosis report and command output too; `--quiet`/`--log-level=error` still print the report and hide only progress.
- `src/logger.ts` reads only `NANOS_LOG_LEVEL`, no longer a bare `LOG_LEVEL`.
- CI matrix: dropped the 1-vCPU `ubuntu-slim` runner; Linux x64 stays covered by `ubuntu-latest`.
- Cache keys in `.github/workflows/ci.yml` and `action.yml` include the ISO week so entries refresh, and the dead restore-key prefixes were fixed.
- `action.yml` falls back to the exact released version (`npx --yes nanos-lint@2.7.0`) instead of the `^2.6.1` range.
- Tests modernized: vacuous/conditional assertions replaced, missing fixtures asserted instead of skipped, `mockClear()` between flag variants, and the `-i/--ignore` test drives the real CLI.
- `README.md` documents the test-suite variables and the shared download; the runtime environment variable table links to them.

### Removed

- 1-vCPU `ubuntu-slim` runner from the CI test matrix.

### Fixed

- Test suite hermetic: no user-cache mutation, no stray `../invalid` directory, no dependency on a pre-warmed cache.
- Single shared LuaLS download per run (previously one per test file plus a `regressions.test.ts` `beforeAll`).
- `tests/unit/regressions.test.ts` no longer degrades to "29 skipped" when its `beforeAll` fails.
- **Script injection in the release workflow**: untrusted tag values and the GitHub token now pass through `env:` instead of being interpolated into `run:` text.
- Release tag detection is end-anchored and no longer fails on commits without a release tag under `bash -e -o pipefail`.
- The release fails when the tag does not match `package.json`'s version.
- Removed the `workflow_run` `branches` filter that dropped tag-triggered CI runs.
- `id-token: write` is scoped to the npm publish job.
- Write-once `actions/cache` entries whose restore keys could never match the key they wrote.
- `--log-level=silent` is now respected by the report and command output.
- LuaLS resolution tests inject an isolated cache, and the offline-fallback test exercises the fallback download path.
- ReDoS regression budgets in `tests/unit/config.test.ts` widened to avoid CI flakes.
- Windows CI: the file-scoped diagnostic assertion normalizes path separators and case.
- **CodeQL `js/incomplete-url-substring-sanitization`**: the LuaLS request assertions in `tests/unit/luals-cache.test.ts` and the download counter in `tests/helpers/download-counter.ts` now parse URLs and compare the hostname and path instead of matching substrings.

### Security

- Hardened `.github/workflows/release.yml` against command injection: no `${{ }}` expression remains in any `run:` script text.
- Scoped `id-token: write` to the npm publish job, so the release job and its third-party actions cannot mint OIDC tokens.

## [2.6.1] - 2026-09-23

### Added

- Built-in GitHub Actions caching in `action.yml` using `actions/cache@v6` with a configurable `cache` input (default: `true`), automatically caching LuaLS binaries and annotations across runs for consumers of the action.

### Changed

- Updated fallback npx execution in `action.yml` to target `nanos-lint@^2.6.1`.

## [2.6.0] - 2026-09-23

### Security

- Dropped security support for versions `< 2.6.0` in `SECURITY.md`.

### Added

- `npm run test:coverage` script using `@vitest/coverage-v8` to enforce strict test coverage thresholds across the codebase without autoUpdate.
- Vitest global coverage thresholds: statements (85%), functions (88%), lines (85%), branches (75%).
- Comprehensive unit tests across all modules targeting previously uncovered branches in URI resolution (`types.test.ts`), CLI options & commands (`cli.test.ts`), report snippet and annotation formatting (`reporter.test.ts`), config discovery & workspace init (`config.test.ts`), platform & binary resolution (`luals-utils.test.ts`), and commit/content fetching (`annotations.test.ts`).
- `clean-cache` (and `clean` alias) CLI command to safely purge cached LuaLS binaries and annotations (`nanos-lint clean-cache`).
- Dynamic downloading and date-based cache validation for `annotations.lua` from repository `nanos-world/vscode-extension` (`docgen-output` branch), eliminating the upstream Git submodule.
- `--annotations <path>` CLI option for `check` and `init` commands to supply a custom annotations file.
- `NANOS_ANNOTATIONS_PATH` and `NANOS_ANNOTATIONS` environment variables to configure a custom annotations file.
- `GITHUB_TOKEN` environment variable support for GitHub API authentication during LuaLS and annotations resolution to avoid rate limiting.
- Automatic probing and transparent migration of legacy LuaLS cache directories (`%LOCALAPPDATA%\nanos-lint\luals` on Windows, `~/.cache/nanos-lint/luals` on macOS/Linux) from versions <= 2.2.1 to prevent unnecessary re-downloads.
- `annotations` input to GitHub Action (`action.yml`).
- Git pre-commit hook in `.githooks/pre-commit` to automatically run quality gates (`npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`) before each commit.
- Atomic cache update transaction for annotations with automated rollback on failure.
- npm version badge in `README.md`.

### Changed

- Standardized project quality gates (`.githooks/pre-commit`, `.git/hooks/pre-commit`, `AGENTS.md`, `README.md`) and CI workflows (`.github/workflows/ci.yml`) to enforce `npm run test:coverage`.
- Standardized cross-platform application cache, config, data, and temp path resolution using `env-paths` in `src/paths.ts`.
- **Cache relocation migration note**: System cache paths now resolve to `%LOCALAPPDATA%\nanos-lint\Cache` on Windows and `~/Library/Caches/nanos-lint` on macOS (standard platform cache paths). Existing cache directories from <= 2.2.1 are automatically probed and migrated.
- `mergeConfigs()` now accepts either an `annotations.lua` file path or a directory containing `annotations.lua` for seamless backwards compatibility.
- Deprecated `getDefinitionsDir()` in favor of `getDefaultAnnotationsPath()`.
- Removed Git submodule `vendor/nanos-world-vscode-extension`, `.gitmodules`, and the periodic synchronization workflow `.github/workflows/sync-annotations.yml`.
- Standalone packaged release builds now download and bundle `annotations.lua` at build time to enable complete offline execution.
- Clarified in `README.md` that standalone binary distributions require Node.js installed on the host machine.
- Updated vulnerability reporting link in `SECURITY.md` to GitHub repository security advisories.

### Fixed

- **Annotation error reporting**: Differentiated filesystem and permission errors (`EACCES`, `ENOSPC`, etc.) from network errors in `resolveAnnotations()`, preserving the original error cause without incorrectly diagnosing a network failure.
- **Early configuration validation**: CLI `check` command now verifies the existence of any custom `--config` path before initiating annotation resolution.
- **Offline cache persistence**: Updated `lastChecked` date when falling back to existing cached annotations during offline or rate-limited sessions, avoiding repeated failing network calls.
- **Cache marker validation**: `resolveLuaLSBinary()` now strictly verifies that `.complete` exists and matches the expected version before accepting a cache hit, preventing stale or partially extracted binaries from being used.
- **Atomic promotion cleanup**: Cleans up corrupted destination directories if promotion fails in `downloadAndExtractLuaLS()`, and eliminated redundant `isBinaryValid()` subprocess execution during binary extraction.
- **Release workflow hardening**: Used `curl -fsSL` with minimum size verification in `.github/workflows/release.yml` to prevent bundling error pages into release packages.
- **Race conditions & Windows file locking (`EBUSY`/`EPERM`)**: Staged temporary downloads in `os.tmpdir()` and introduced retry backoffs (`copyFileWithRetry`) when promoting cached annotations files across concurrent multi-worker processes.
- **Integration test isolation**: Ensured annotations are pre-cached in `beforeAll` for live LuaLS test suites, and isolated `cleanCache()` operations in unit tests to prevent accidental deletion of shared cache.
- **CodeQL `js/incomplete-url-substring-sanitization`**: Replaced substring URL check in annotations unit test mocks with strict URL hostname parsing.

## [2.5.0] - 2026-09-22

### Security

- **CodeQL `js/command-line-injection`**: LuaLS version/tag strings are now validated with an allow-list before use. Values obtained from the GitHub releases API (`tag_name`) and from user supplied `--luals-version` arguments are interpolated into cache directory paths, download URLs, and the path of the executed binary, so they are rebuilt character by character (`sanitizeLuaLSVersion()`) and rejected unless they form a single safe path segment. This prevents path traversal or command injection through a crafted release tag.
- **CodeQL `js/shell-command-injection-from-environment`**: The Windows `.cmd` launcher integration test no longer puts an environment-derived absolute path on a command line interpreted by `cmd.exe`; the launcher is referenced by name and resolved through the `cwd` option.
- **CodeQL `actions/missing-workflow-permissions`**: Added an explicit least-privilege `permissions: contents: read` block to `.github/workflows/ci.yml` so the workflow token stays read-only regardless of repository/organization defaults.
- Validated the LuaLS release tag fetched in the release workflow before it is used in a shell command.
- Dropped security support for versions `< 2.5.0` in `SECURITY.md`.

### Fixed

- **CodeQL `js/polynomial-redos`**: Removed the `\/+$` regular expressions used to trim trailing slashes in `src/config.ts` and replaced them with the linear `stripTrailingSlashes()` scan, eliminating quadratic backtracking on slash-heavy input.

### Changed

- `resolveLuaLSVersion()` now throws a descriptive error for an invalid explicitly requested version instead of returning it unchanged.
- Added exported helpers `sanitizeLuaLSVersion()` (`src/luals.ts`) and `stripTrailingSlashes()` (`src/config.ts`).

## [2.4.0] - 2026-09-22

### Changed

- Replaced custom handwritten JSONC parser and comment stripper with `jsonc-parser` (`^3.3.1`).
- Configured ESM module alias in `tsdown.config.ts` for `jsonc-parser` to ensure internal implementation modules (`./impl/*`) are statically bundled, resolving Node.js bundling issues ([microsoft/node-jsonc-parser#57](https://github.com/microsoft/node-jsonc-parser/issues/57)).

### Security

- Dropped security support for versions `< 2.4.0` in `SECURITY.md`.

## [2.3.0] - 2026-09-22

### Fixed

- **Critical (Finding N0)**: Added `.nanos-lint` to `workspace.ignoreDir` and `.nanos-lint/**` to `files.exclude` in `templates/.luarc.json`, `src/config.ts`, and `initWorkspace()`, preventing LuaLS from diagnosing `.nanos-lint/annotations.lua` as workspace source code and eliminating false-positive luadoc warnings on initialized workspaces.
- **High (Finding N1)**: Made LuaLS download and extraction atomic and race-safe for concurrent cold-cache runs using unique PID/timestamp temporary directories, isolated archive downloads, cancellation of non-OK response bodies, and atomic directory promotion with conflict resolution.
- **Medium (Finding N2)**: Added self-healing cache validation and recovery via `isBinaryValid()` smoke testing and `.complete` installation markers; automatically detects, cleans up, and repairs corrupted/truncated binaries, and includes the cache directory path in error messages when LuaLS check execution fails.
- **Low**: Ensured `initWorkspace()` throws an informative error if source `annotations.lua` is missing instead of generating broken workspace configurations.

### Security

- Dropped security support for versions `< 2.3.0` in `SECURITY.md`.

## [2.2.1] - 2026-09-22

### Changed

- Configured npm Trusted Publishing using OpenID Connect (OIDC) via `id-token: write` workflow permission.
- Updated nanos world official game website URL in `README.md` to `https://nanos-world.com/`.

### Fixed

- Fixed release workflow step condition where `env.NPM_TOKEN != ''` was evaluated before step-level environment variables were initialized, migrating to tokenless OIDC authentication.

## [2.2.0] - 2026-09-22

### Added

- `--github` flag as a direct shortcut for `--format=github`.
- `--force` (`-f`) flag for the `init` command to explicitly permit overwriting an existing `.luarc.json`.
- Automated update of moving major version tags (e.g. `v2`) on GitHub release.
- CI concurrency control (`cancel-in-progress`) and caching for LuaLS binary downloads using `actions/cache@v6`.
- Portable definition scaffolding during `init`: copies `annotations.lua` to `.nanos-lint/annotations.lua` inside the target workspace.
- Formal security policy in `SECURITY.md` (supporting versions `>= 2.1.0`).
- Documentation in `README.md` for `LUALS_BIN`, `NO_COLOR`, `FORCE_COLOR`, and repeatable `--ignore`.
- Mandatory release and changelog guidelines in `AGENTS.md`.

### Changed

- Moved `commander` from `dependencies` to `devDependencies`, achieving a true zero-dependency runtime for published bundles.
- Cleaned `tsconfig.json` to target Node.js runtime exclusively (removed `DOM` library and stale configuration files).

### Fixed

- **Critical**: Prevented silent false passes by treating missing target paths and failed/crashed LuaLS subprocess runs without output as hard errors.
- **Critical**: Fixed variadic `-i, --ignore` option swallowing following positional target arguments by switching to a repeatable single-pattern option.
- **Critical**: Hardened `action.yml` to prevent script injection via shell input variables and added fallback to `npx` when `dist/` is not present.
- **High**: Fixed `--quiet` flag to suppress all `[luals]` progress output.
- **High**: Added strict choice validation for `--checklevel` and `--format` options, preventing silent false passes on invalid values.
- **High**: Added UTF-8 BOM tolerance (`\uFEFF`) when reading user `.luarc.json` configuration files.
- **High**: Prevented `init` from silently overwriting existing `.luarc.json` configurations and generating machine-specific absolute library paths.
- **High**: Fixed `--ignore` wiping out default structural exclusions (`node_modules`, `.git`, `dist`, `bin`, `vendor`, etc.).
- **Medium**: Formatted top-level CLI error messages cleanly without verbose stack traces unless `DEBUG` is set.
- **Medium**: Removed deleted temporary `outputPath` field from `CheckResult`.
- **Medium**: Added subprocess timeout (120s) and fetch retry with exponential backoff for LuaLS downloads.
- **Medium**: Aligned `countCheckedFiles` glob matching (`*.lua`, `**/*.lua`) with LuaLS exclusion semantics.
- **Low**: Fixed `fileUriToPath` handling of UNC paths, malformed percent encodings, and normalized Windows drive letter URIs on POSIX environments (Linux & macOS).
- **Low**: Escaped commas (`%2C`) in GitHub Actions annotation file paths.

## [2.1.0] - 2026-09-22

### Added

- `-i/--ignore` option with glob pattern matching for CLI and GitHub Action input (`action.yml`).
- Total count of checked files in terminal output upon passing diagnosis (`Diagnosis completed, no problems found across N files`).

### Fixed

- Applied universal two-space symbol padding across all platforms for consistent alignment in terminal output.

## [2.0.1] - 2026-09-22

### Added

- Error and warning breakdown in terminal problem summary (`N errors, M warnings across X files`).

### Fixed

- Automatic pluralization of nouns ("problem", "warning", "error", "file") in CLI report output.
- Prevented LuaLS check from hanging indefinitely when running with default positional path inside a directory containing the tool itself or a cached LuaLS binary.

## [2.0.0] - 2026-09-22

### Changed

- **Breaking**: Require Node.js `>= 24.0.0` (`engines.node: ">=24.0.0"`).
- Replaced deprecated `Command#addHelpCommand` with `Command#helpCommand` in Commander setup, enabling `@typescript-eslint/no-deprecated` rule.

### Added

- Node.js 26 to CI test matrix on Ubuntu and Windows runners.
- Submodule tracking upstream `nanos-world-vscode-extension` (`docgen-output` branch) under `vendor/nanos-world-vscode-extension`, loading `annotations.lua` directly from the submodule and removing `definitions/` directory and custom sanitizers.
- Automated daily synchronization workflow (`.github/workflows/sync-annotations.yml`) at 01:00 UTC to track upstream annotations updates.
- Direct execution detection (`isDirectExecution`) in `dist/cli.js` so it executes CLI commands immediately when invoked directly via `node`.
- Smoke tests and regression test suite for CLI entrypoints and launcher scripts.

### Fixed

- Fixed Windows batch launcher (`bin/nanos-lint.cmd`) errorlevel propagation on non-zero exit codes.
- Ensured `dist/` is compiled before running CLI integration tests in CI.

## [1.2.0] - 2026-09-22

### Changed

- Migrated bundler from `tsup` to `tsdown` (`v0.23.0`) powered by Rolldown, compiling standalone bundles targeting Node.js 24.
- Rewrote CLI argument parsing with `commander` (`v15.0.0`), supporting `check`, `init`, `download-luals`, and `version` subcommands.
- Configured `tsdown.config.ts` with `deps.alwaysBundle: ["commander"]` to maintain zero external runtime dependencies.
- Configured Dependabot with `npm` package ecosystem and pinned TypeScript < 6.1.0 to prevent peer dependency conflicts.

## [1.1.2] - 2026-09-21

### Security

- Hardened release workflow by requiring `workflow_run` events to originate from upstream `push` events (ignoring `pull_request` and preventing unauthorized fork triggers).

## [1.1.1] - 2026-09-21

### Added

- Pre-release test matrix job (Ubuntu and Windows) in release workflow before building and publishing.

### Changed

- Chained release workflow to execute upon successful completion of CI workflow via GitHub Actions `workflow_run` on `master`.

### Fixed

- Added automated detection of release tags on HEAD using `git tag --points-at`, cleanly skipping untagged runs.

## [1.1.0] - 2026-09-21

### Added

- JSONC support in `.luarc.json` configuration files (support for comments and trailing commas).
- Respect for `NO_COLOR` environment variable convention and TTY detection in reporter output.
- CLI validation for unrecognized flags and missing required options.

### Fixed

- Added 10-second timeout to GitHub API LuaLS version resolution fetch.
- Guaranteed temporary check configuration file cleanup in `finally` block.
- Escaped single quotes in PowerShell `Expand-Archive` command on Windows.
- Tightened `Diagnostic.severity` typing to `1 | 2 | 3 | 4`.

## [1.0.0] - 2026-09-21

### Added

- Initial release of `nanos-lint`.
- Lua Language Server (LuaLS) integration targeting Lua 5.4.9 for nanos world scripts.
- Automatic download and caching of platform-specific LuaLS standalone binaries (Windows x64, Linux x64, macOS).
- Built-in nanos world API definitions bundled from `nanos-world/vscode-extension`.
- CLI commands: `check`, `init`, and `download-luals`.
- Multiple report formatters: human-readable terminal output, JSON output (`--format=json`), and GitHub Actions workflow annotations (`--format=github`).
- GitHub Action composite action (`action.yml`) for automated CI linting.
- Multi-platform CI/CD release workflow for npm publishing and GitHub Releases.

### Fixed

- Normalized LuaLS file URI schemes across Windows (`file:///C:/...`) and Linux/POSIX (`file:///...`).
