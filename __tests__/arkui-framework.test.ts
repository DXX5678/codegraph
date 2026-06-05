/**
 * ArkUI Framework Resolver Tests
 */
import { describe, it, expect } from 'vitest';
import { arkuiResolver } from '../src/resolution/frameworks/arkui';

describe('arkuiResolver.extract', () => {
  it('extracts @Entry-decorated struct as arkui_page node', () => {
    const src = `
@Entry
@Component
struct IndexPage {
  @State message: string = 'Hello';
  build() {
    Column() {
      Text(this.message)
    }
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/Index.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('IndexPage');
    expect(nodes[0].language).toBe('arkts');
    expect(nodes[0].id).toContain('arkui_page:');
    expect(nodes[0].qualifiedName).toContain('IndexPage');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('IndexPage');
    expect(references[0].referenceKind).toBe('references');
  });

  it('extracts @Entry struct without extra decorators', () => {
    const src = `
@Entry
struct SimplePage {
  build() {
    Text('simple');
  }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/SimplePage.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('SimplePage');
  });

  it('extracts multiple @Entry structs from one file', () => {
    const src = `
@Entry
@Component
struct PageA {
  build() { Text('A'); }
}

@Entry
struct PageB {
  build() { Text('B'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Multi.ets', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name).sort()).toEqual(['PageA', 'PageB']);
    expect(nodes.every((n) => n.kind === 'arkui_page')).toBe(true);
  });

  it('extracts @Component struct (without @Entry) as component node', () => {
    const src = `
@Component
struct NotAPage {
  build() {
    Text('not a page');
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/NotEntry.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('component');
    expect(nodes[0].name).toBe('NotAPage');
    expect(nodes[0].decorators).toEqual(['Component']);
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('NotAPage');
    expect(references[0].referenceKind).toBe('references');
  });

  it('extracts router.pushUrl as unresolved reference', () => {
    const src = `
@Entry
struct HomePage {
  build() {
    Button('Go Detail')
      .onClick(() => {
        router.pushUrl({ url: 'pages/Detail' })
      })
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/HomePage.ets', src);
    expect(nodes).toHaveLength(1);
    const navRefs = references.filter(
      (r) => r.referenceKind === 'references' && r.referenceName !== 'HomePage'
    );
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('pages/Detail');
    expect(navRefs[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts router.replaceUrl as unresolved reference', () => {
    const src = `
@Entry
struct LoginPage {
  build() {
    Button('Login')
      .onClick(() => {
        router.replaceUrl({ url: 'pages/Home' })
      })
  }
}
`;
    const { references } = arkuiResolver.extract!('pages/Login.ets', src);
    const navRefs = references.filter((r) => r.referenceName !== 'LoginPage');
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('pages/Home');
  });

  it('attributes pushUrl to nearest preceding @Entry struct', () => {
    const src = `
@Entry
struct PageOne {
  build() { Text('one'); }
}

router.pushUrl({ url: 'pages/PageTwo' })

@Entry
struct PageTwo {
  build() { Text('two'); }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/RouteTest.ets', src);
    expect(nodes).toHaveLength(2);
    const navRef = references.find((r) => r.referenceName === 'pages/PageTwo');
    expect(navRef).toBeDefined();
    expect(navRef!.fromNodeId).toBe(nodes.find((n) => n.name === 'PageOne')!.id);
  });

  it('falls back to file-level id when no @Entry precedes pushUrl', () => {
    const src = `
router.pushUrl({ url: 'pages/Standalone' })
`;
    const { references } = arkuiResolver.extract!('pages/NopageRef.ets', src);
    const navRef = references.find((r) => r.referenceName === 'pages/Standalone');
    expect(navRef).toBeDefined();
    expect(navRef!.fromNodeId).toMatch(/^file:/);
  });

  it('returns empty for non-.ets files', () => {
    const { nodes, references } = arkuiResolver.extract!('test.ts', '');
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });

  it('skips // line-commented @Entry', () => {
    const src = `
// @Entry
// struct FakePage {}
@Entry
struct RealPage {
  build() { Text('real'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Commented.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('RealPage');
  });

  it('skips /* block-commented */ @Entry', () => {
    const src = `
/*
@Entry
struct FakePage {
  build() { Text('fake'); }
}
*/
@Entry
struct RealPage {
  build() { Text('real'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/BlockCommented.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('RealPage');
  });

  it('does not duplicate @Entry+@Component struct as component', () => {
    const src = `
@Entry
@Component
struct IndexPage {
  build() {
    Text('hello');
  }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Index.ets', src);
    const pages = nodes.filter((n) => n.kind === 'arkui_page');
    const components = nodes.filter((n) => n.kind === 'component');
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('IndexPage');
    expect(components).toHaveLength(0);
  });

  it('extracts @Component-only structs alongside @Entry pages', () => {
    const src = `
@Entry
@Component
struct HomePage {
  build() { Text('home'); }
}

@Component
struct MyButton {
  build() { Button('click'); }
}

@Component
struct MyLabel {
  build() { Text('label'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Mixed.ets', src);
    const pages = nodes.filter((n) => n.kind === 'arkui_page');
    const components = nodes.filter((n) => n.kind === 'component');
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('HomePage');
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.name).sort()).toEqual(['MyButton', 'MyLabel']);
    components.forEach((c) => {
      expect(c.decorators).toEqual(['Component']);
    });
  });

  it('extracts @Entry with routeName param', () => {
    const src = `
@Entry({ routeName: 'main' })
@Component
struct MainPage {
  build() { Text('main'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Main.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('MainPage');
  });

  it('extracts @Component with freezeWhenInvisible param', () => {
    const src = `
@Component({ freezeWhenInvisible: true })
struct FrozenLabel {
  build() { Text('frozen'); }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/Frozen.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('component');
    expect(nodes[0].name).toBe('FrozenLabel');
    expect(nodes[0].decorators).toEqual(['Component']);
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('FrozenLabel');
  });
});

describe('arkuiResolver.postExtract', () => {
  it('returns empty array when main_pages.json is absent', () => {
    const context = {
      readFile: (_path: string) => null,
      getNodesByKind: (_kind: string) => [],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toEqual([]);
  });

  it('creates arkui_page nodes from main_pages.json src entries', () => {
    const json = JSON.stringify({ src: ['pages/Index', 'pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('arkui_page');
    expect(result[0].name).toBe('pages/Index');
    expect(result[1].name).toBe('pages/Detail');
  });

  it('de-duplicates against already extracted pages (filePath match)', () => {
    const json = JSON.stringify({ src: ['pages/Index', 'pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [
        {
          filePath: 'pages/Index.ets',
          qualifiedName: 'pages/Index.ets::Index',
          name: 'Index',
        },
      ] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pages/Detail');
  });

  it('de-duplicates against qualifiedName end-match', () => {
    const json = JSON.stringify({ src: ['pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [
        {
          filePath: 'pages/Detail.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail.ets::Detail',
          name: 'Detail',
        },
      ] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toEqual([]);
  });

  it('prefers primary config path over fallback', () => {
    const primary = JSON.stringify({ src: ['pages/Primary'] });
    const fallback = JSON.stringify({ src: ['pages/Fallback'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return primary;
        if (path === 'main_pages.json') return fallback;
        return null;
      },
      getNodesByKind: (_kind: string) => [] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pages/Primary');
  });
});

describe('arkuiResolver.resolve', () => {
  it('resolves pages/Detail to matching arkui_page by filePath', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page1',
          filePath: 'entry/src/main/ets/pages/Detail.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller1',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page1');
    expect(result!.confidence).toBe(0.9);
  });

  it('resolves pages/Detail to index.ets fallback', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page2',
          filePath: 'entry/src/main/ets/pages/Detail/index.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail/index.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller2',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page2');
    expect(result!.confidence).toBe(0.9);
  });

  it('falls back to partial path match with lower confidence', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page3',
          filePath: 'feature/src/main/ets/custom/Detail.ets',
          qualifiedName: 'feature/src/main/ets/custom/Detail.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller3',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page3');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.65);
    expect(result!.confidence).toBeLessThan(0.9);
  });

  it('returns null for non-page references', () => {
    const context = { getNodesByKind: (_kind: string) => [] };
    const ref = {
      fromNodeId: 'caller4',
      referenceName: 'SomeUtility',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).toBeNull();
  });

  it('returns null for pages/ reference with no matching nodes', () => {
    const context = { getNodesByKind: (_kind: string) => [] };
    const ref = {
      fromNodeId: 'caller5',
      referenceName: 'pages/NotFound',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Callback-synthesizer phase tests
// ---------------------------------------------------------------------------
import type { Node, Edge } from '../src/types';
import { arkuiStateChainEdges, arkuiStateDepEdges, arkuiEventChainEdges } from '../src/resolution/callback-synthesizer';

/** Create a minimal QueryBuilder mock. */
function mockQueries(overrides: {
  classes?: Node[];
  structs?: Node[];
  edges?: Map<string, Edge[]>;
  nodesById?: Map<string, Node>;
} = {}) {
  const classes = overrides.classes ?? [];
  const structs = overrides.structs ?? [];
  const edges = overrides.edges ?? new Map();
  const nodesById = overrides.nodesById ?? new Map();
  return {
    getNodesByKind: (kind: string) => {
      if (kind === 'class') return classes;
      if (kind === 'struct') return structs;
      return [];
    },
    getOutgoingEdges: (nodeId: string, _kinds: string[]) => edges.get(nodeId) ?? [],
    getNodeById: (id: string) => nodesById.get(id) ?? null,
  } as any;
}

/** Create a minimal ResolutionContext mock. */
function mockCtx(overrides: {
  files?: string[];
  fileContents?: Map<string, string>;
  fileNodes?: Map<string, Node[]>;
} = {}) {
  const files = overrides.files ?? [];
  const fileContents = overrides.fileContents ?? new Map();
  const fileNodes = overrides.fileNodes ?? new Map();
  return {
    getAllFiles: () => files,
    readFile: (path: string) => fileContents.get(path) ?? null,
    getNodesInFile: (path: string) => fileNodes.get(path) ?? [],
  } as any;
}

describe('arkuiStateChainEdges', () => {
  it('links every sibling method to build() in .ets structs', () => {
    const buildNode: Node = {
      id: 'build-1', kind: 'method', name: 'build',
      filePath: 'pages/Index.ets', startLine: 20, endLine: 30,
      qualifiedName: 'pages/Index.ets::Index::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const onClickNode: Node = {
      id: 'onClick-1', kind: 'method', name: 'onClick',
      filePath: 'pages/Index.ets', startLine: 10, endLine: 18,
      qualifiedName: 'pages/Index.ets::Index::onClick', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-1', kind: 'struct', name: 'Index',
      filePath: 'pages/Index.ets', startLine: 1, endLine: 35,
      qualifiedName: 'pages/Index.ets::Index', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('build-1', buildNode);
    nodesById.set('onClick-1', onClickNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-1', [
      { source: 'struct-1', target: 'build-1', kind: 'contains', line: 20 },
      { source: 'struct-1', target: 'onClick-1', kind: 'contains', line: 10 },
    ] as any);
    const queries = mockQueries({
      structs: [structNode],
      edges,
      nodesById,
    });
    const ctx = mockCtx();

    const result = arkuiStateChainEdges(queries as any, ctx as any);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('onClick-1');
    expect(result[0].target).toBe('build-1');
    expect(result[0].kind).toBe('calls');
    expect(result[0].provenance).toBe('heuristic');
    expect(result[0].metadata?.synthesizedBy).toBe('arkui-state-chain');
  });

  it('skips non-.ets files', () => {
    const clsNode: Node = {
      id: 'cls-ts', kind: 'class', name: 'Foo',
      filePath: 'utils.ts', startLine: 0, endLine: 10,
      qualifiedName: 'utils.ts::Foo', language: 'typescript',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const queries = mockQueries({ classes: [clsNode] });
    const result = arkuiStateChainEdges(queries as any, mockCtx() as any);
    expect(result).toEqual([]);
  });
});

describe('arkuiStateDepEdges', () => {
  it('links methods that read @State properties → property nodes', () => {
    // Source: @State at line 5, build() body spans 5-7, struct covers 1-8.
    const buildNode: Node = {
      id: 'build-2', kind: 'method', name: 'build',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 7,
      qualifiedName: 'pages/Home.ets::Home::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const countProp: Node = {
      id: 'prop-count', kind: 'property', name: 'count',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 5,
      qualifiedName: 'pages/Home.ets::Home::count', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-2', kind: 'struct', name: 'Home',
      filePath: 'pages/Home.ets', startLine: 1, endLine: 8,
      qualifiedName: 'pages/Home.ets::Home', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('build-2', buildNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-2', [
      { source: 'struct-2', target: 'build-2', kind: 'contains', line: 5 },
    ] as any);
    const queries = mockQueries({ structs: [structNode], edges, nodesById });

    const src = `
@Entry
@Component
struct Home {
  @State count: number = 0;
  build() {
    Text(this.count.toString());
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Home.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Home.ets', [structNode, buildNode, countProp]);
    const ctx = mockCtx({
      files: ['pages/Home.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiStateDepEdges(queries as any, ctx as any);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // build() reads this.count → edge: build → count property
    const buildEdge = result.find((e) => e.source === 'build-2');
    expect(buildEdge).toBeDefined();
    expect(buildEdge!.target).toBe('prop-count');
    expect(buildEdge!.kind).toBe('calls');
    expect(buildEdge!.provenance).toBe('heuristic');
    expect(buildEdge!.metadata?.synthesizedBy).toBe('arkui-state-dep');
  });

  it('does not link methods that do not reference the state property', () => {
    // Source: @State at 5, helper at 6, build at 7, struct covers 1-7.
    const helperNode: Node = {
      id: 'helper-1', kind: 'method', name: 'helper',
      filePath: 'pages/Home.ets', startLine: 6, endLine: 6,
      qualifiedName: 'pages/Home.ets::Home::helper', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const countProp: Node = {
      id: 'prop-count-2', kind: 'property', name: 'count',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 5,
      qualifiedName: 'pages/Home.ets::Home::count', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-3', kind: 'struct', name: 'Home',
      filePath: 'pages/Home.ets', startLine: 1, endLine: 7,
      qualifiedName: 'pages/Home.ets::Home', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('helper-1', helperNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-3', [
      { source: 'struct-3', target: 'helper-1', kind: 'contains', line: 6 },
    ] as any);
    const queries = mockQueries({ structs: [structNode], edges, nodesById });

    const src = `
@Entry
@Component
struct Home {
  @State count: number = 0;
  helper() { return 42; }
  build() { Text('hello'); }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Home.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Home.ets', [structNode, helperNode, countProp]);
    const ctx = mockCtx({
      files: ['pages/Home.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiStateDepEdges(queries as any, ctx as any);
    const helperEdge = result.find((e) => e.source === 'helper-1');
    expect(helperEdge).toBeUndefined();
  });
});

describe('arkuiEventChainEdges', () => {
  it('links build() → handler for .onClick(this.handler)', () => {
    // Source is 7 lines (1-indexed): handleClick at 3, build() body spans 4-6.
    const buildNode: Node = {
      id: 'build-3', kind: 'method', name: 'build',
      filePath: 'pages/Click.ets', startLine: 4, endLine: 6,
      qualifiedName: 'pages/Click.ets::Page::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const handlerNode: Node = {
      id: 'handleClick-1', kind: 'method', name: 'handleClick',
      filePath: 'pages/Click.ets', startLine: 3, endLine: 3,
      qualifiedName: 'pages/Click.ets::Page::handleClick', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const src = `
@Entry
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('OK').onClick(() => { this.handleClick(); });
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Click.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Click.ets', [buildNode, handlerNode]);
    const ctx = mockCtx({
      files: ['pages/Click.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiEventChainEdges(ctx as any);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('build-3');
    expect(result[0].target).toBe('handleClick-1');
    expect(result[0].kind).toBe('calls');
    expect(result[0].provenance).toBe('heuristic');
    expect(result[0].metadata?.synthesizedBy).toBe('arkui-event-chain');
    expect(result[0].metadata?.handler).toBe('handleClick');
  });

  it('skips refs where handler name is build', () => {
    // Source: build() body spans lines 3-5.
    const buildNode: Node = {
      id: 'build-4', kind: 'method', name: 'build',
      filePath: 'pages/Rec.ets', startLine: 3, endLine: 5,
      qualifiedName: 'pages/Rec.ets::Page::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const src = `
@Entry
struct Page {
  build() {
    Column() { this.build(); }
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Rec.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Rec.ets', [buildNode]);
    const ctx = mockCtx({
      files: ['pages/Rec.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiEventChainEdges(ctx as any);
    expect(result).toEqual([]);
  });
});
