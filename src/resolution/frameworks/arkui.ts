/**
 * ArkUI Framework Resolver (HarmonyOS)
 *
 * Handles ArkUI declarative UI constructs in .ets files:
 *   - @Entry-decorated structs → arkui_page nodes
 *   - router.pushUrl / router.replaceUrl → unresolved references
 *   - main_pages.json → cross-file page registration
 *
 * Regex-over-source approach (comment-stripped), matching the
 * NestJS/Express pattern. ArkTS is a TypeScript superset.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const arkuiResolver: FrameworkResolver = {
  name: 'arkui',
  languages: ['arkts'],

  // ------------------------------------------------------------------
  // detect
  // ------------------------------------------------------------------
  detect(context: ResolutionContext): boolean {
    // build-profile.json5 is the canonical HarmonyOS/ArkUI project marker.
    if (context.fileExists('build-profile.json5')) return true;

    // Fallback: any .ets file with an @Entry decorator.
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.ets')) continue;
      const content = context.readFile(file);
      if (content && /@Entry\b/.test(content)) return true;
    }
    return false;
  },

  // ------------------------------------------------------------------
  // resolve
  // ------------------------------------------------------------------
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Only handle navigation references whose referenceName is a page URL
    // (e.g. "pages/Detail", "entry/src/main/ets/pages/Detail").
    const routePath = ref.referenceName;
    if (
      !routePath.startsWith('pages/') &&
      !routePath.startsWith('entry/src/main/ets/')
    ) {
      return null;
    }

    // Match against arkui_page nodes.
    let best: Node | null = null;
    let bestScore = 0;

    for (const node of context.getNodesByKind('arkui_page')) {
      // Exact file-path match (highest confidence).
      // Anchor with a leading '/' so `pages/Detail` matches
      // `entry/.../pages/Detail.ets` but NOT
      // `feature/.../custom/Detail.ets`.
      const pathSuffix = `/${routePath}.ets`;
      const indexPathSuffix = `/${routePath}/index.ets`;
      if (
        node.filePath.endsWith(pathSuffix) ||
        node.filePath.endsWith(indexPathSuffix)
      ) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }

      // Partial path match.
      if (node.qualifiedName.includes(routePath)) {
        const score = 0.7;
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }

      // Name-based fallback — last path segment matches page name.
      const pageName = routePath.split('/').pop()!;
      if (node.name === pageName) {
        const score = 0.65;
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
    }

    if (best) {
      return {
        original: ref,
        targetNodeId: best.id,
        confidence: bestScore,
        resolvedBy: 'framework',
      };
    }

    return null;
  },

  // ------------------------------------------------------------------
  // extract
  // ------------------------------------------------------------------
  extract(filePath, content) {
    if (!filePath.endsWith('.ets')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // ArkTS is a TypeScript superset — identical comment/string syntax.
    const safe = stripCommentsForRegex(content, 'typescript');

    // ── Pass 1: @Entry-decorated structs → arkui_page nodes ───────
    //
    // Pattern: @Entry (optionally followed by @Component / @Preview /
    // @V2 / @Observed / @Reusable, possibly with params like
    // @Entry({ routeName: 'main' })) then `struct Name`.
    // (?:[^{}]|\{[^}]*\})*? skips decorator param braces but stops
    // before the struct body's opening brace.
    const entryRe = /@Entry\b(?:[^{}]|\{[^}]*\})*?struct\s+(\w+)/g;
    const entryPositions: Array<{ line: number; name: string; node: Node }> = [];

    let match: RegExpExecArray | null;
    while ((match = entryRe.exec(safe)) !== null) {
      const structName = match[1]!;
      const line = safe.slice(0, match.index).split('\n').length;
      const pageNode: Node = {
        id: `arkui_page:${filePath}:${line}:${structName}`,
        kind: 'arkui_page',
        name: structName,
        qualifiedName: `${filePath}::${structName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'arkts',
        updatedAt: now,
      };
      nodes.push(pageNode);
      entryPositions.push({ line, name: structName, node: pageNode });

      // Link the arkui_page node back to its declaring struct via a
      // references edge. Standard name-based resolution matches this
      // to the struct node produced by tree-sitter extraction.
      references.push({
        fromNodeId: pageNode.id,
        referenceName: structName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'arkts',
      });
    }

    // ── Pass 2: router.pushUrl / router.replaceUrl → references ────
    //
    // Pattern: router.pushUrl({ ..., url: 'pages/X', ... })
    // Uses [\s\S]*? to span multiple lines inside the object literal.
    const pushUrlRe =
      /router\.(pushUrl|replaceUrl)\s*\(\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/g;
    pushUrlRe.lastIndex = 0;

    while ((match = pushUrlRe.exec(safe)) !== null) {
      const url = match[2]!;
      const callLine = safe.slice(0, match.index).split('\n').length;

      // Attribute the navigation call to the nearest preceding @Entry
      // struct — the page that contains this router.pushUrl call.
      let fromNodeId = `file:${filePath}`;
      for (let i = entryPositions.length - 1; i >= 0; i--) {
        const entry = entryPositions[i]!;
        if (entry.line < callLine) {
          fromNodeId = entry.node.id;
          break;
        }
      }

      references.push({
        fromNodeId,
        referenceName: url,
        referenceKind: 'references',
        line: callLine,
        column: 0,
        filePath,
        language: 'arkts',
      });
    }

    // ── Pass 3: @Component-decorated structs (without @Entry) → component nodes
    //
    // Pattern: @Component (optionally followed by @Preview / @V2 /
    // @Observed / @Reusable, possibly with params) then `struct Name`,
    // excluding structs already captured as @Entry pages.
    const entryNames = new Set(entryPositions.map((e) => e.name));
    const componentRe = /@Component\b(?:[^{}]|\{[^}]*\})*?struct\s+(\w+)/g;
    componentRe.lastIndex = 0;

    while ((match = componentRe.exec(safe)) !== null) {
      const structName = match[1]!;
      if (entryNames.has(structName)) continue;

      const line = safe.slice(0, match.index).split('\n').length;
      const componentNode: Node = {
        id: `component:${filePath}:${line}:${structName}`,
        kind: 'component',
        name: structName,
        qualifiedName: `${filePath}::${structName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'arkts',
        updatedAt: now,
        decorators: ['Component'],
      };
      nodes.push(componentNode);

      // Link the component node back to its declaring struct via a
      // references edge — same pattern as arkui_page nodes.
      references.push({
        fromNodeId: componentNode.id,
        referenceName: structName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'arkts',
      });
    }

    return { nodes, references };
  },

  // ------------------------------------------------------------------
  // postExtract
  // ------------------------------------------------------------------
  postExtract(context: ResolutionContext): Node[] {
    // main_pages.json (HarmonyOS 5.0+) lists all page entry routes.
    // Common locations: src/main/resources/base/profile/main_pages.json
    // or main_pages.json at project root.
    const content =
      context.readFile(
        'entry/src/main/resources/base/profile/main_pages.json'
      ) ?? context.readFile('main_pages.json');
    if (!content) return [];

    let config: { src?: string[] };
    try {
      config = JSON.parse(content);
    } catch {
      return [];
    }

    const pages: string[] = config.src ?? [];
    if (pages.length === 0) return [];

    // Only emit nodes for pages not already captured by extract().
    const existingRoutes = context.getNodesByKind('arkui_page');
    const now = Date.now();
    const nodes: Node[] = [];

    for (const pagePath of pages) {
      const alreadyExists = existingRoutes.some(
        (n) =>
          n.filePath.endsWith(pagePath + '.ets') ||
          n.filePath.endsWith(pagePath + '/index.ets')
      );
      if (alreadyExists) continue;

      nodes.push({
        id: `arkui_page:main_pages.json:0:${pagePath}`,
        kind: 'arkui_page',
        name: pagePath,
        qualifiedName: `main_pages.json::${pagePath}`,
        filePath: 'main_pages.json',
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0,
        language: 'arkts',
        updatedAt: now,
      });
    }

    return nodes;
  },
};
