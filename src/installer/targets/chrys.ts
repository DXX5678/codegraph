/**
 * Chrys target.
 *
 * Chrys stores agent profiles as individual YAML files (one per profile)
 * under ``~/.chrys/agents/``.  Each profile is a complete agent definition
 * with a ``tools.mcp`` list of MCP server configs.
 *
 * When no user-created profiles exist under ``~/.chrys/agents/`` yet
 * (e.g. a fresh Chrys installation), built-in agent definitions are
 * discovered from the Chrys runtime installation directory on disk.
 * The user can pick one or more built-in agents; for each selection a
 * shadow profile is created under ``~/.chrys/agents/`` with the
 * built-in's full content plus the codegraph MCP server entry injected.
 *
 * **Install**: discovers user-created profiles AND built-in agents not
 * yet shadowed by a user profile.  Prompts the user to pick one or more
 * via interactive multi-select, then injects (or creates with) the
 * codegraph MCP server entry.
 *
 * In non-interactive mode (piped stdin, test suite) the prompt is
 * skipped and ALL profiles are updated.
 *
 * **Uninstall**: scans existing user profiles for the codegraph MCP
 * entry, prompts the user to pick which profiles to remove it from,
 * then strips the entry.
 *
 * Chrys has no project-local config concept, so only ``global`` is
 * supported.
 *
 * No instructions file is written (issue #529) — the codegraph usage
 * guidance ships in the MCP server's ``initialize`` response.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import { atomicWriteFileSync, getMcpServerConfig } from './shared';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function configDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'chrys');
  }
  return path.join(os.homedir(), '.chrys');
}

function agentsDir(): string {
  return path.join(configDir(), 'agents');
}

// ---------------------------------------------------------------------------
// Chrys runtime roots — where Chrys's pyapp installation lives
// ---------------------------------------------------------------------------

function chrysRuntimeRoots(): string[] {
  const roots: string[] = [];

  // Custom override (mirrors PYAPP_INSTALL_DIR_CHRYS)
  const envOverride: string | undefined = process.env.PYAPP_INSTALL_DIR_CHRYS;
  if (envOverride) {
    roots.push(path.resolve(envOverride.replace(/^~/, os.homedir())));
  }

  // Platform default
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    roots.push(path.join(localAppData, 'pyapp', 'data', 'chrys'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'pyapp', 'chrys'));
  } else {
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
    roots.push(path.join(xdgData, 'pyapp', 'chrys'));
  }

  return roots;
}

/** Walk a directory tree looking for matching subdir patterns. */
function findSubdirs(root: string, globSegments: string[]): string[] {
  if (globSegments.length === 0) {
    return fs.existsSync(root) ? [root] : [];
  }
  const head = globSegments[0]!;
  const tail = globSegments.slice(1);
  const current = path.join(root, head);
  if (tail.length === 0) {
    return fs.existsSync(current) ? [current] : [];
  }

  // If head is 'site-packages', we need to search recursively
  if (head === 'site-packages') {
    const results: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === 'site-packages') {
          const candidate = findSubdirs(full, tail);
          results.push(...candidate);
        } else {
          stack.push(full);
        }
      }
    }
    return results;
  }

  // Non-recursive segment
  return findSubdirs(current, tail);
}

/** Parse a dotted version string like "0.9.7" → [0, 9, 7], or null. */
function parseVersion(segment: string): number[] | null {
  const parts = segment.split('.');
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums.length > 0 ? nums : null;
}

/** Walk up path ancestors looking for a version-like directory name. */
function versionFromPath(p: string): number[] {
  let current = path.dirname(p);
  while (current !== path.dirname(current)) {
    const segment = path.basename(current);
    const v = parseVersion(segment);
    if (v) return v;
    current = path.dirname(current);
  }
  return [];
}

/** Get mtime of a path, or 0 on failure. */
function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Built-in agent discovery
// ---------------------------------------------------------------------------

const BUILTIN_SEARCH = ['site-packages', 'chrys', 'profiles', 'agents', 'builtins'];

interface BuiltinProfile {
  /** Display name (the YAML filename without extension). */
  name: string;
  /** Absolute path to the builtin YAML file in the runtime directory. */
  sourcePath: string;
  /** Where the user-facing shadow file would go (~/.chrys/agents/<name>.yaml). */
  userPath: string;
  /** Raw YAML content from the builtin file. */
  content: string;
}

function discoverBuiltins(): BuiltinProfile[] {
  const seen = new Set<string>();
  const results: BuiltinProfile[] = [];
  const userAgentDir = agentsDir();

  for (const root of chrysRuntimeRoots()) {
    const builtinDirs = findSubdirs(root, BUILTIN_SEARCH);
    if (builtinDirs.length === 0) continue;

    // Sort: newest version + highest mtime first
    builtinDirs.sort((a, b) => {
      const va = versionFromPath(a);
      const vb = versionFromPath(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const da = va[i] ?? 0;
        const db = vb[i] ?? 0;
        if (da !== db) return db - da;
      }
      const ma = mtimeOf(a);
      const mb = mtimeOf(b);
      return mb - ma;
    });

    for (const dir of builtinDirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') continue;
        const name = path.basename(entry.name, ext);
        if (seen.has(name)) continue;
        seen.add(name);

        const sourcePath = path.join(dir, entry.name);
        const content = readText(sourcePath);
        if (!content) continue;

        results.push({
          name,
          sourcePath,
          userPath: path.join(userAgentDir, `${name}.yaml`),
          content,
        });
      }
      // Only process the highest-priority runtime that has YAML files.
      // (The first builtinDirs entry after sorting is the best one.)
      if (results.length > 0) break;
    }

    if (results.length > 0) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unified profile discovery (user-created + built-in)
// ---------------------------------------------------------------------------

interface DiscoveredProfile {
  name: string;
  source: 'user' | 'builtin';
  /** Absolute path in ~/.chrys/agents/ (may not exist yet for builtins). */
  userPath: string;
  /** Raw YAML content. For user profiles this is read lazily if needed. */
  content: string;
}

function discoverProfiles(): DiscoveredProfile[] {
  const result: DiscoveredProfile[] = [];
  const seen = new Set<string>();

  // 1. User-created profiles under ~/.chrys/agents/
  const dir = agentsDir();
  if (fs.existsSync(dir)) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') continue;
        const name = path.basename(f, ext);
        seen.add(name);
        const userPath = path.join(dir, f);
        result.push({
          name,
          source: 'user',
          userPath,
          content: readText(userPath),
        });
      }
    } catch {
      // ignore
    }
  }

  // 2. Built-in agents not yet shadowed by a user profile
  for (const b of discoverBuiltins()) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    result.push({
      name: b.name,
      source: 'builtin' as const,
      userPath: b.userPath,
      content: b.content,
    });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Reads and helpers
// ---------------------------------------------------------------------------

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function profileDisplayLabel(p: DiscoveredProfile): string {
  return p.source === 'builtin' ? `${p.name} (built-in)` : p.name;
}

function pathToDisplayLabel(userPath: string, profiles: DiscoveredProfile[]): string {
  for (const p of profiles) {
    if (p.userPath === userPath) return profileDisplayLabel(p);
  }
  return path.basename(userPath, path.extname(userPath));
}

// ---------------------------------------------------------------------------
// Interactive mode detection
// ---------------------------------------------------------------------------

function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

const importESM = new Function('specifier', 'return import(specifier)') as
  <T = any>(specifier: string) => Promise<T>;

interface ClackMultiselectOption {
  value: string;
  label: string;
  hint?: string;
}

async function promptProfileSelect(
  message: string,
  options: ClackMultiselectOption[],
  prepopulate: string[],
): Promise<string[]> {
  const clack = await importESM('@clack/prompts');
  const result = await (clack as any).multiselect({
    message,
    options,
    required: false,
    initialValues: prepopulate,
  });
  if ((clack as any).isCancel(result)) return [];
  return result as string[];
}

// ---------------------------------------------------------------------------
// YAML line helpers
// ---------------------------------------------------------------------------

type LineRange = { start: number; end: number };

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function joinLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find a top-level YAML key (zero indent). */
function topLevelRange(lines: string[], key: string): LineRange | null {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Find a 2-space-indented child key within a parent range. */
function childRange(
  lines: string[],
  parent: LineRange,
  child: string,
): LineRange | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^  \S/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// CodeGraph MCP entry block
// ---------------------------------------------------------------------------

function renderCodeGraphMcpEntry(): string[] {
  const mcp = getMcpServerConfig();
  const lines: string[] = [
    '    - name: codegraph',
    '      transport: stdio',
    `      command: ${mcp.command}`,
    '      args:',
  ];
  for (const arg of mcp.args) {
    lines.push(`        - ${arg}`);
  }
  lines.push('      enabled: true');
  return lines;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function hasCodeGraphMcp(content: string): boolean {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');
  if (!tools) return false;
  const mcp = childRange(lines, tools, 'mcp');
  if (!mcp) return false;
  for (let i = mcp.start + 1; i < mcp.end; i++) {
    if (/^    - name:\s*codegraph\b/.test(lines[i] ?? '')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Install: inject into existing YAML
// ---------------------------------------------------------------------------

function findMCPInsertPoint(lines: string[], mcpRange: LineRange): number {
  for (let i = mcpRange.end - 1; i > mcpRange.start; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indent = (line.match(/^( *)/)?.[1] ?? '').length;
    if (indent >= 4) return i;
  }
  return mcpRange.start;
}

function addCodeGraphMcp(content: string): string {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');
  if (tools) {
    const mcp = childRange(lines, tools, 'mcp');
    if (mcp && hasCodeGraphMcp(content)) return content;
  }

  if (!tools) {
    const entry = renderCodeGraphMcpEntry();
    return joinLines([
      ...lines,
      '',
      'tools:',
      '  mcp:',
      ...entry,
      '',
    ]);
  }

  const mcp = childRange(lines, tools, 'mcp');
  if (!mcp) {
    const entry = renderCodeGraphMcpEntry();
    const insertAfter = lastIndentedLine(lines, tools);
    return insertAt(lines, insertAfter, ['  mcp:', ...entry, '']);
  }

  const entry = renderCodeGraphMcpEntry();
  const insertAfter = findMCPInsertPoint(lines, mcp);
  return insertAt(lines, insertAfter, entry);
}

function lastIndentedLine(lines: string[], parent: LineRange): number {
  for (let i = parent.end - 1; i > parent.start; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^  /.test(line)) return i;
  }
  return parent.start;
}

function insertAt(lines: string[], afterIdx: number, newLines: string[]): string {
  const result = [...lines];
  result.splice(afterIdx + 1, 0, ...newLines);
  return joinLines(result);
}

// ---------------------------------------------------------------------------
// Uninstall helpers
// ---------------------------------------------------------------------------

function findCodeGraphEntryRange(
  lines: string[],
  mcpRange: LineRange,
): LineRange | null {
  let entryStart = -1;
  for (let i = mcpRange.start + 1; i < mcpRange.end; i++) {
    if (/^    - name:\s*codegraph\b/.test(lines[i] ?? '')) {
      entryStart = i;
      break;
    }
  }
  if (entryStart === -1) return null;

  let entryEnd = mcpRange.end;
  for (let i = entryStart + 1; i < mcpRange.end; i++) {
    if (/^    - name:/.test(lines[i] ?? '')) {
      entryEnd = i;
      break;
    }
  }
  while (entryEnd > entryStart + 1 && (lines[entryEnd - 1] ?? '').trim() === '') {
    entryEnd--;
  }
  return { start: entryStart, end: entryEnd };
}

function removeCodeGraphMcp(content: string): string {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');
  if (!tools) return content;

  const mcp = childRange(lines, tools, 'mcp');
  if (!mcp) return content;

  const entryRange = findCodeGraphEntryRange(lines, mcp);
  if (!entryRange) return content;

  const remaining = lines.slice(mcp.start + 1, mcp.end).some((l, i) => {
    const lineIdx = mcp.start + 1 + i;
    if (lineIdx >= entryRange.start && lineIdx < entryRange.end) return false;
    return l.trim() !== '';
  });

  if (!remaining) {
    return stripLines(lines, mcp.start, mcp.end);
  }

  return stripLines(lines, entryRange.start, entryRange.end);
}

function stripLines(lines: string[], start: number, end: number): string {
  const result = [...lines];
  result.splice(start, end - start);
  const cleaned: string[] = [];
  let prevBlank = false;
  for (const line of result) {
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) continue;
    cleaned.push(line);
    prevBlank = isBlank;
  }
  return joinLines(cleaned);
}

// ---------------------------------------------------------------------------
// Target implementation
// ---------------------------------------------------------------------------

class ChrysTarget implements AgentTarget {
  readonly id = 'chrys' as const;
  readonly displayName = 'Chrys';
  readonly docsUrl = 'https://github.com/anthropics/chrys';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(_loc: Location): DetectionResult {
    const profiles = discoverProfiles();
    let installed = false;
    let alreadyConfigured = false;
    let firstPath: string | undefined;

    // Chrys is "installed" if its config dir exists OR the runtime is present.
    if (fs.existsSync(configDir())) {
      installed = true;
    }
    if (!installed) {
      for (const root of chrysRuntimeRoots()) {
        if (fs.existsSync(root)) {
          installed = true;
          break;
        }
      }
    }

    if (!installed) {
      return { installed: false, alreadyConfigured: false };
    }

    for (const p of profiles) {
      if (hasCodeGraphMcp(p.content)) {
        alreadyConfigured = true;
        firstPath = p.userPath;
        break;
      }
    }

    return {
      installed,
      alreadyConfigured,
      configPath: firstPath ?? agentsDir(),
    };
  }

  async install(_loc: Location, _opts: InstallOptions): Promise<WriteResult> {
    const profiles = discoverProfiles();

    if (profiles.length === 0) {
      return {
        files: [],
        notes: [
          fs.existsSync(configDir())
            ? 'No Chrys agent profiles found. Run `chrys` to initialize them first.'
            : 'Chrys does not appear to be installed. Install Chrys first, then re-run this command.',
        ],
      };
    }

    // Build options for the multi-select prompt.
    const options: ClackMultiselectOption[] = profiles
      .filter((p) => p.content.trim().length > 0)
      .map((p) => ({
        value: p.userPath,
        label: profileDisplayLabel(p),
        hint: p.source === 'builtin' ? 'creates user-facing copy' : undefined,
      }));

    const allPaths = options.map((o) => o.value);

    let selected: string[];
    if (isInteractive()) {
      selected = await promptProfileSelect(
        'Select Chrys profiles to add CodeGraph MCP server to:',
        options,
        allPaths, // pre-select all
      );
      if (selected.length === 0) {
        return { files: [], notes: ['No profiles selected — nothing was changed.'] };
      }
    } else {
      selected = allPaths;
    }

    const files: WriteResult['files'] = [];
    for (const filePath of selected) {
      const prof = profiles.find((p) => p.userPath === filePath);
      if (!prof) continue;

      const before = prof.content || readText(filePath);
      const after = addCodeGraphMcp(before);
      if (after === before && fs.existsSync(filePath)) {
        files.push({ path: filePath, action: 'unchanged' });
        continue;
      }

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const existed = fs.existsSync(filePath);
      atomicWriteFileSync(filePath, ensureTrailingNewline(after));
      files.push({
        path: filePath,
        action: existed ? 'updated' : 'created',
      });
    }

    const created = files.filter((f) => f.action === 'created').length;
    const updated = files.filter((f) => f.action === 'updated').length;
    const skipped = files.filter((f) => f.action === 'unchanged').length;
    const notes: string[] = [];
    if (created > 0) {
      notes.push(`Created ${created} Chrys agent profile(s) with CodeGraph MCP.`);
    }
    if (updated > 0) {
      notes.push(`Injected CodeGraph MCP server into ${updated} Chrys profile(s).`);
    }
    if (skipped > 0) {
      notes.push(`${skipped} profile(s) already had CodeGraph configured.`);
    }
    if (notes.length === 0) {
      notes.push('Nothing was changed.');
    }
    return { files, notes };
  }

  async uninstall(_loc: Location): Promise<WriteResult> {
    // Uninstall only operates on user-created files under ~/.chrys/agents/.
    // Built-in profiles are never modified in their runtime location, so we
    // only need to scan the user config dir.
    const dir = agentsDir();
    if (!fs.existsSync(dir)) {
      return { files: [], notes: ['No Chrys agent profiles found — nothing to uninstall.'] };
    }

    let userFiles: string[];
    try {
      userFiles = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((f) => path.join(dir, f))
        .sort();
    } catch {
      return { files: [], notes: ['No Chrys agent profiles found — nothing to uninstall.'] };
    }

    // Find profiles that have codegraph configured.
    const configuredProfiles = userFiles.filter((f) => hasCodeGraphMcp(readText(f)));

    if (configuredProfiles.length === 0) {
      return { files: [], notes: ['CodeGraph MCP server was not configured in any profile.'] };
    }

    const allProfiles = discoverProfiles();
    const options: ClackMultiselectOption[] = configuredProfiles.map((p) => ({
      value: p,
      label: pathToDisplayLabel(p, allProfiles),
    }));

    let selected: string[];
    if (isInteractive()) {
      selected = await promptProfileSelect(
        `Select Chrys profiles to remove CodeGraph MCP from (${configuredProfiles.length} have it):`,
        options,
        configuredProfiles, // pre-select all configured
      );
      if (selected.length === 0) {
        return { files: [], notes: ['No profiles selected — nothing was removed.'] };
      }
    } else {
      selected = configuredProfiles;
    }

    const files: WriteResult['files'] = [];
    for (const profilePath of selected) {
      const before = readText(profilePath);
      const after = removeCodeGraphMcp(before);
      if (after === before) {
        files.push({ path: profilePath, action: 'kept' });
        continue;
      }
      atomicWriteFileSync(profilePath, ensureTrailingNewline(after));
      files.push({ path: profilePath, action: 'removed' });
    }

    const removed = files.filter((f) => f.action === 'removed').length;
    return {
      files,
      notes: [
        removed > 0
          ? `Removed CodeGraph MCP from ${removed} location(s).`
          : 'CodeGraph MCP server was not configured in any selected profile.',
      ],
    };
  }

  printConfig(_loc: Location): string {
    const entryLines = renderCodeGraphMcpEntry();
    return [
      `# Add to each profile YAML under ~/.chrys/agents/`,
      `# Find the "tools:" section, then under the "mcp:" list add:`,
      '',
      ...entryLines,
      '',
      `# Or install with: codegraph install --target chrys`,
      '',
    ].join('\n');
  }

  describePaths(_loc: Location): string[] {
    return discoverProfiles().map((p) => p.userPath);
  }
}

export const chrysTarget: AgentTarget = new ChrysTarget();
