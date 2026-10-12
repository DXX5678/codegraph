/**
 * Agent target abstraction for the installer.
 *
 * Each MCP-capable agent (Claude Code, Cursor, Codex CLI, opencode, ...)
 * implements this interface so the installer orchestrator can write the
 * right MCP-server config + instructions file + permissions for that
 * agent without baking client-specific paths into core code. Adding a
 * new agent = one new file in `targets/` + one entry in `registry.ts`.
 *
 * Closes the Claude-locked installer issue (upstream #137). The
 * runtime MCP server is already agent-agnostic; this brings the
 * installer to the same surface.
 */

export type Location = 'global' | 'local';

/**
 * Stable string id used in the `--target` CLI flag and the registry
 * lookup. New targets add a value here when they're added to the
 * registry. Keep these short and lowercase.
 */
export type TargetId = 'icode' | 'claude' | 'cursor' | 'codex' | 'opencode' | 'hermes' | 'gemini' | 'antigravity' | 'kiro' | 'copilot-vscode' | 'copilot-cli' | 'copilot-jetbrains';

/**
 * Result of `target.detect(location)`.
 *
 * `installed` is a best-effort heuristic that the agent's CLI / app /
 * config dir is present on this system — used to default the
 * multiselect prompt to "what's actually here." False positives are
 * acceptable (we still write); false negatives just mean the user
 * has to opt in manually.
 *
 * `alreadyConfigured` reports whether codegraph has already been
 * wired into this target at this location — drives the
 * "Updated"-vs-"Added" log line and lets `--check` exit 0/1.
 */
export interface DetectionResult {
  installed: boolean;
  alreadyConfigured: boolean;
  /** Path inspected; surfaced in diagnostic / dry-run output. */
  configPath?: string;
}

/**
 * What `target.install(location)` actually changed on disk. The
 * orchestrator renders one log line per file using `action`.
 *
 * `unchanged` means we touched the file but its contents were already
 * what we'd write — used for byte-identical idempotent re-runs.
 */
export interface WriteResult {
  files: Array<{
    path: string;
    action: 'created' | 'updated' | 'unchanged' | 'removed' | 'not-found' | 'kept';
  }>;
  /**
   * Optional one-line notes the orchestrator surfaces verbatim — e.g.
   * "Restart Cursor to apply." Keep these short; multi-line goes in
   * the README.
   */
  notes?: string[];
}

export interface InstallOptions {
  /**
   * Whether to write the agent's permissions / auto-allow surface
   * (Claude `settings.json`, others where applicable). When the
   * target has no permissions concept this option is a no-op.
   */
  autoAllow: boolean;
  /**
   * Front-load prompt hook (Claude `UserPromptSubmit`) that injects
   * codegraph_explore context for structural prompts. `true` installs it,
   * `false` removes any prior install (so opt-out round-trips), `undefined`
   * leaves it untouched. Targets without a prompt-hook concept ignore it.
   */
  promptHook?: boolean;
  /**
   * Force a non-interactive install: a target whose install would
   * otherwise open a prompt (iCode's profile multi-select) must pick
   * its defaults instead. Set by the `install --refresh` sweep and by
   * `--yes`, which must never block on stdin. Targets with no prompt
   * ignore it.
   */
  nonInteractive?: boolean;
  /**
   * Only touch config that is already present — never add a first-time
   * install. Set by the `install --refresh` sweep, which heals already
   * configured targets in place. Only meaningful for targets that fan
   * out over many config files (iCode's per-profile files): a target
   * with a single config file ignores it and rewrites that file as
   * usual.
   */
  existingOnly?: boolean;
}

/**
 * Options for {@link AgentTarget.uninstall}.
 */
export interface UninstallOptions {
  /**
   * Force a non-interactive uninstall: a target whose uninstall would
   * otherwise open a prompt (iCode's profile multi-select) must pick its
   * defaults instead. Set by `codegraph uninstall --yes` and by the npm
   * `preuninstall` hook — neither may block on stdin. Targets with no
   * prompt ignore it.
   */
  nonInteractive?: boolean;
}

export interface AgentTarget {
  /** Stable id; matches the `TargetId` union. */
  readonly id: TargetId;
  /** Human-readable name shown in clack prompts and log lines. */
  readonly displayName: string;
  /** Optional URL for "where do I learn more about this agent." */
  readonly docsUrl?: string;
  /**
   * Whether this target supports the given install location.
   *
   * Some agents (GitHub Copilot CLI, the Copilot JetBrains plugin)
   * have no project-local config concept — only a single per-user
   * config dir. Returning false for an unsupported (target, location)
   * pair lets the orchestrator skip cleanly with a clear message.
   */
  supportsLocation(loc: Location): boolean;
  /**
   * Read-only, and quiet. Every target is detected on every run —
   * including agents codegraph was never installed into — and
   * `install --refresh` skips the unconfigured ones on the strength of
   * this answer, so a target that writes or warns here touches a config
   * it has no business touching (issue #1870).
   */
  detect(loc: Location): DetectionResult;
  install(loc: Location, opts: InstallOptions): Promise<WriteResult> | WriteResult;
  /**
   * Inverse of install. Removes only what install would have written;
   * preserves sibling MCP servers, sibling permissions, and unrelated
   * markdown sections. Must be safe to call when nothing was ever
   * installed (returns `not-found` actions). `opts.nonInteractive`
   * suppresses any prompt the target would otherwise open.
   */
  uninstall(loc: Location, opts?: UninstallOptions): Promise<WriteResult> | WriteResult;
  /**
   * Print the MCP-server snippet a user would paste manually for this
   * target. Used by `codegraph install --print-config <id>` and by
   * the README. Must NOT touch the filesystem.
   */
  printConfig(loc: Location): string;
  /** Filesystem paths this target would write to at this location. */
  describePaths(loc: Location): string[];
}
