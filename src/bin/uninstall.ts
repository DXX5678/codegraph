#!/usr/bin/env node
/**
 * CodeGraph preuninstall cleanup script
 *
 * Runs automatically when `npm uninstall -g @colbymchenry/codegraph`
 * is called. Loops over every known agent target's `uninstall(loc)`
 * for the global location only — local-location entries live inside
 * project working trees and aren't ours to nuke at npm-uninstall
 * time.
 *
 * A target's `uninstall()` may be async (iCode prompts and awaits), so
 * every call is awaited: without it the process can exit before the work
 * finishes, and a rejection would escape the per-target guard and become
 * an unhandled rejection that aborts the npm uninstall. `nonInteractive`
 * keeps a target from opening a prompt inside a lifecycle hook.
 *
 * This script must never throw — a failed cleanup must not block
 * uninstall.
 */

void (async () => {
  try {
    // Lazy require so any module-level error in the registry can't
    // bubble out and abort the npm uninstall.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ALL_TARGETS } = require('../installer/targets/registry') as
      typeof import('../installer/targets/registry');

    for (const target of ALL_TARGETS) {
      if (!target.supportsLocation('global')) continue;
      try {
        await target.uninstall('global', { nonInteractive: true });
      } catch {
        // Each target is independently safe-to-skip; per-target failure
        // must not stop the loop.
      }
    }
  } catch {
    // If the registry itself can't be loaded (e.g. partial install),
    // we silently skip cleanup. Uninstall still completes.
  }
})();
