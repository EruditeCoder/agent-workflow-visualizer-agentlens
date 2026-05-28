import {
  Project,
  Node,
  SyntaxKind,
  SourceFile,
  CallExpression,
  PropertyAccessExpression,
  ObjectLiteralExpression,
  ArrayLiteralExpression,
  Identifier,
  ClassDeclaration,
  MethodDeclaration,
  ArrowFunction,
  FunctionExpression,
  FunctionDeclaration,
  TypeNode,
  ParameterDeclaration,
  PropertyDeclaration,
} from "ts-morph";
import type {
  Graph,
  GraphNode,
  GraphEdge,
  Subgraph,
  AnalyzerDiagnostic,
  NodeMeta,
  SourceLocation,
} from "@awv/shared";
import * as path from "node:path";
import * as fs from "node:fs";

interface FnRecord {
  id: string;
  name: string;
  filePath: string;
  filePathRel: string;
  isExported: boolean;
  isRouteHandler: boolean;
  isMainFile: boolean;
  loc: SourceLocation;
  decl: Node;
  isAsync: boolean;
  signature: string;
  className?: string;
}

interface ClassRecord {
  name: string;
  filePathRel: string;
  filePath: string;
  decl: ClassDeclaration;
  methods: Map<string, FnRecord>;
  staticMethods: Map<string, FnRecord>;
  thisPropTypes: Map<string, string>;
  staticPropTypes: Map<string, string>;
  staticReturnTypes: Map<string, string>;
}

type ResolvedType =
  | { kind: "instance"; class: ClassRecord }
  | { kind: "class-ref"; class: ClassRecord };

interface AnalyzeContext {
  rootDir: string;
  fnById: Map<string, FnRecord>;
  fnByFileAndName: Map<string, FnRecord>;
  classByFqn: Map<string, ClassRecord>;
  classByName: Map<string, ClassRecord[]>;
  diagnostics: AnalyzerDiagnostic[];
  routeIdx: number;
  routerPrefixes: Map<string, string>;
  toolDefs: Map<string, string>;
  unresolvedLlmCalls: UnresolvedLlmCall[];
}

interface UnresolvedLlmCall {
  llmNodeId: string;
  containingFnId: string;
  toolsExpr: Node;
}

interface AnalyzeOptions {
  pruneHelpers?: boolean;
}

const MAIN_FILE_BASENAMES = new Set(["index.ts", "main.ts", "cli.ts", "server.ts"]);
const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

export async function analyze(rootDir: string, opts: AnalyzeOptions = {}): Promise<Graph> {
  const pruneHelpers = opts.pruneHelpers ?? true;

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: 99,
      module: 99,
      moduleResolution: 2,
      allowJs: false,
      noEmit: true,
      strict: false,
    },
  });

  const globPattern = path.join(rootDir, "**/*.ts").replace(/\\/g, "/");
  project.addSourceFilesAtPaths([
    globPattern,
    `!${path.join(rootDir, "**/node_modules/**").replace(/\\/g, "/")}`,
    `!${path.join(rootDir, "**/dist/**").replace(/\\/g, "/")}`,
  ]);

  const ctx: AnalyzeContext = {
    rootDir,
    fnById: new Map(),
    fnByFileAndName: new Map(),
    classByFqn: new Map(),
    classByName: new Map(),
    diagnostics: [],
    routeIdx: 0,
    routerPrefixes: new Map(),
    toolDefs: new Map(),
    unresolvedLlmCalls: [],
  };

  for (const sf of project.getSourceFiles()) {
    collectClasses(sf, ctx);
    collectFreeFunctions(sf, ctx);
  }

  for (const sf of project.getSourceFiles()) {
    collectRouterPrefixes(sf, ctx);
  }

  for (const sf of project.getSourceFiles()) {
    detectRouteHandlers(sf, ctx);
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const fn of ctx.fnById.values()) {
    const snippet = captureSnippet(fn.decl);
    nodes.set(fn.id, {
      id: fn.id,
      kind: fn.isExported || fn.isRouteHandler ? "entry" : "function",
      label: fn.name,
      loc: fn.loc,
      meta: {
        isAsync: fn.isAsync,
        signature: fn.signature,
        className: fn.className,
        codeSnippet: snippet.text,
        codeTruncated: snippet.truncated,
      },
    });
  }

  for (const fn of ctx.fnById.values()) {
    analyzeFunctionBody(fn, ctx, nodes, edges);
  }

  resolvePerCallerTools(ctx, nodes, edges);

  const handlerEdges = detectToolDispatchers(ctx, nodes, edges);

  mergeToolHandlers(nodes, edges, handlerEdges);

  attachRecursionFlags(nodes, edges);

  const declaredEntries = new Set(
    [...ctx.fnById.values()].filter((f) => f.isExported || f.isRouteHandler).map((f) => f.id),
  );

  const llmNodes = [...nodes.values()].filter((n) => n.kind === "llm-call");
  const toolNodes = [...nodes.values()].filter((n) => n.kind === "tool");
  if (llmNodes.length === 0) {
    ctx.diagnostics.push({
      severity: "warn",
      message: "No LLM call sites found.",
    });
  }

  const inDegree = new Map<string, number>();
  for (const e of edges) {
    if (e.kind === "calls") inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const llmAndTools = [...llmNodes.map((n) => n.id), ...toolNodes.map((n) => n.id)];
  const reachesLLM = computeReverseReachable(llmAndTools, edges);

  const toolHandlerIds = new Set<string>();
  for (const e of edges) {
    if (e.kind === "handles-tool") toolHandlerIds.add(e.target);
  }

  let keepIds: Set<string>;
  if (pruneHelpers) {
    keepIds = new Set<string>([...reachesLLM, ...llmAndTools, ...toolHandlerIds]);
    for (const id of declaredEntries) {
      if (reachesLLM.has(id)) keepIds.add(id);
    }
  } else {
    const fromEntries = computeReachable([...declaredEntries], edges);
    keepIds = new Set<string>([...fromEntries, ...reachesLLM, ...llmAndTools, ...toolHandlerIds]);
  }

  for (const id of keepIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      const node = nodes.get(id);
      if (node && node.kind === "function") node.kind = "entry";
    }
  }

  const reachableNodes = [...nodes.values()].filter((n) => keepIds.has(n.id));
  const reachableEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));

  const subgraphs = computeSubgraphs(reachableNodes, reachableEdges);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootDir,
    nodes: reachableNodes,
    edges: reachableEdges,
    subgraphs,
    diagnostics: ctx.diagnostics,
  };
}

function relPath(filePath: string, rootDir: string): string {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

function collectFreeFunctions(sf: SourceFile, ctx: AnalyzeContext): void {
  const filePath = sf.getFilePath();
  const filePathRel = relPath(filePath, ctx.rootDir);
  const isMainFile = MAIN_FILE_BASENAMES.has(path.basename(filePath));

  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? `<anon@${fn.getStartLineNumber()}>`;
    recordFn(ctx, {
      id: makeFnId(filePathRel, name, fn.getStartLineNumber()),
      name,
      filePath,
      filePathRel,
      isExported: fn.isExported() || fn.isDefaultExport(),
      isRouteHandler: false,
      isMainFile,
      loc: locOf(sf, fn),
      decl: fn,
      isAsync: fn.isAsync(),
      signature: fn.getText().split("{")[0].trim().slice(0, 200),
    });
  }

  for (const v of sf.getVariableStatements()) {
    const isExported = v.isExported();
    for (const decl of v.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        const name = decl.getName();
        recordFn(ctx, {
          id: makeFnId(filePathRel, name, decl.getStartLineNumber()),
          name,
          filePath,
          filePathRel,
          isExported,
          isRouteHandler: false,
          isMainFile,
          loc: locOf(sf, decl),
          decl: init,
          isAsync: init.isAsync(),
          signature: decl.getText().split("=>")[0].split("{")[0].trim().slice(0, 200),
        });
      }
    }
  }
}

function collectClasses(sf: SourceFile, ctx: AnalyzeContext): void {
  const filePath = sf.getFilePath();
  const filePathRel = relPath(filePath, ctx.rootDir);

  for (const cls of sf.getClasses()) {
    const className = cls.getName();
    if (!className) continue;

    const record: ClassRecord = {
      name: className,
      filePathRel,
      filePath,
      decl: cls,
      methods: new Map(),
      staticMethods: new Map(),
      thisPropTypes: new Map(),
      staticPropTypes: new Map(),
      staticReturnTypes: new Map(),
    };

    for (const prop of cls.getProperties()) {
      const propName = prop.getName();
      const isStatic = prop.isStatic();
      const typeNode = prop.getTypeNode();
      const propType = typeNameOf(typeNode);
      if (propType) {
        if (isStatic) record.staticPropTypes.set(propName, propType);
        else record.thisPropTypes.set(propName, propType);
      }
      const init = prop.getInitializer();
      if (init && Node.isNewExpression(init)) {
        const ctorName = init.getExpression().getText();
        if (isStatic) record.staticPropTypes.set(propName, ctorName);
        else record.thisPropTypes.set(propName, ctorName);
      }
    }

    const ctors = cls.getConstructors();
    for (const ctor of ctors) {
      for (const param of ctor.getParameters()) {
        if (param.hasScopeKeyword() || param.isReadonly()) {
          const propName = param.getName();
          const t = typeNameOf(param.getTypeNode());
          if (t) record.thisPropTypes.set(propName, t);
        }
      }
      ctor.forEachDescendant((d) => {
        if (Node.isBinaryExpression(d) && d.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const left = d.getLeft();
          if (Node.isPropertyAccessExpression(left)) {
            const recv = left.getExpression();
            if (recv.getKind() === SyntaxKind.ThisKeyword) {
              const propName = left.getName();
              const right = d.getRight();
              if (Node.isNewExpression(right)) {
                record.thisPropTypes.set(propName, right.getExpression().getText());
              } else if (Node.isIdentifier(right)) {
                const paramT = ctor.getParameter(right.getText())?.getTypeNode();
                const t = typeNameOf(paramT);
                if (t) record.thisPropTypes.set(propName, t);
              }
            }
          }
        }
      });
    }

    for (const m of cls.getMethods()) {
      const name = m.getName();
      const fqName = `${className}.${name}`;
      const isStatic = m.isStatic();
      const fnRecord: FnRecord = {
        id: makeFnId(filePathRel, fqName, m.getStartLineNumber()),
        name: fqName,
        filePath,
        filePathRel,
        isExported: false,
        isRouteHandler: false,
        isMainFile: false,
        loc: locOf(sf, m),
        decl: m,
        isAsync: m.isAsync(),
        signature: signatureOf(m),
        className,
      };
      recordFn(ctx, fnRecord);
      if (isStatic) {
        record.staticMethods.set(name, fnRecord);
        const returnTypeNode = m.getReturnTypeNode();
        const returnType = typeNameOf(returnTypeNode);
        if (returnType) {
          record.staticReturnTypes.set(name, returnType);
        } else if (name === "getInstance" || name === "instance") {
          record.staticReturnTypes.set(name, className);
        }
      } else {
        record.methods.set(name, fnRecord);
      }
    }

    for (const prop of cls.getProperties()) {
      const init = prop.getInitializer();
      if (!init) continue;
      if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
      const propName = prop.getName();
      const fqName = `${className}.${propName}`;
      const fnRecord: FnRecord = {
        id: makeFnId(filePathRel, fqName, prop.getStartLineNumber()),
        name: fqName,
        filePath,
        filePathRel,
        isExported: false,
        isRouteHandler: false,
        isMainFile: false,
        loc: locOf(sf, prop),
        decl: init,
        isAsync: init.isAsync(),
        signature: signatureOf(prop),
        className,
      };
      recordFn(ctx, fnRecord);
      if (prop.isStatic()) record.staticMethods.set(propName, fnRecord);
      else record.methods.set(propName, fnRecord);
    }

    ctx.classByFqn.set(`${filePathRel}::${className}`, record);
    const arr = ctx.classByName.get(className) ?? [];
    arr.push(record);
    ctx.classByName.set(className, arr);
  }
}

function collectRouterPrefixes(sf: SourceFile, ctx: AnalyzeContext): void {
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    if (callee.getName() !== "use") return;
    const args = node.getArguments();
    if (args.length < 2) return;
    const pathArg = args[0];
    if (!Node.isStringLiteral(pathArg) && !Node.isNoSubstitutionTemplateLiteral(pathArg)) return;
    const prefix = pathArg.getLiteralValue();
    if (!prefix.startsWith("/")) return;
    const handlerArg = args[1];
    if (!Node.isIdentifier(handlerArg)) return;
    const handlerName = handlerArg.getText();
    for (const imp of sf.getImportDeclarations()) {
      const defaultImport = imp.getDefaultImport();
      if (defaultImport && defaultImport.getText() === handlerName) {
        const resolved = resolveLocalImport(sf.getFilePath(), imp.getModuleSpecifierValue());
        if (resolved) ctx.routerPrefixes.set(normalizePath(resolved), prefix);
      }
    }
  });
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function detectRouteHandlers(sf: SourceFile, ctx: AnalyzeContext): void {
  const filePath = sf.getFilePath();
  const filePathRel = relPath(filePath, ctx.rootDir);
  const prefix = ctx.routerPrefixes.get(normalizePath(filePath)) ?? "";

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const method = callee.getName().toLowerCase();
    if (!HTTP_METHODS.has(method)) return;
    const args = node.getArguments();
    if (args.length < 2) return;
    const first = args[0];
    if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) return;
    const routePath = first.getLiteralValue();
    if (!routePath.startsWith("/")) return;
    const handler = args[args.length - 1];
    if (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)) return;

    const fullPath = prefix && routePath !== "/" ? prefix + routePath : prefix || routePath;
    const label = `${method.toUpperCase()} ${fullPath}`;
    const isAsync = handler.isAsync();
    recordFn(ctx, {
      id: `route:${filePathRel}:${handler.getStartLineNumber()}:${ctx.routeIdx++}`,
      name: label,
      filePath,
      filePathRel,
      isExported: false,
      isRouteHandler: true,
      isMainFile: false,
      loc: locOf(sf, handler),
      decl: handler,
      isAsync,
      signature: label,
    });
  });
}

function recordFn(ctx: AnalyzeContext, fn: FnRecord): void {
  ctx.fnById.set(fn.id, fn);
  ctx.fnByFileAndName.set(`${fn.filePathRel}::${fn.name}`, fn);
}

function analyzeFunctionBody(
  fn: FnRecord,
  ctx: AnalyzeContext,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): void {
  let order = 0;
  const calls: CallExpression[] = [];
  fn.decl.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const enc = enclosingFunctionOf(node);
    if (enc !== fn.decl) return;
    calls.push(node);
  });

  for (const node of calls) {
    const inLoop = isInsideLoop(node, fn.decl);
    const inBranch = isInsideBranch(node, fn.decl);
    const decision = getEnclosingDecision(node, fn.decl);

    if (isAnthropicMessagesCall(node)) {
      const callNode = buildLlmCallNode(node, fn, ctx);
      nodes.set(callNode.id, callNode);
      edges.push({
        id: `e:${fn.id}->${callNode.id}#${order++}`,
        source: fn.id,
        target: callNode.id,
        kind: "calls",
        meta: {
          inLoop,
          inBranch,
          order,
          awaited: isAwaited(node),
          branchKey: decision?.key,
          branchArm: decision?.arm,
        },
      });
      const meta = callNode.meta;
      if (meta) {
        meta.inLoop = inLoop;
        for (const toolName of meta.toolNames ?? []) {
          const toolId = `tool:${fn.filePathRel}:${toolName}`;
          if (!nodes.has(toolId)) {
            const defText = ctx.toolDefs.get(toolName);
            const snip = defText ? snippetFromText(defText) : undefined;
            nodes.set(toolId, {
              id: toolId,
              kind: "tool",
              label: toolName,
              meta: {
                notes: [`Tool definition referenced by ${callNode.id}`],
                codeSnippet: snip?.text,
                codeTruncated: snip?.truncated,
              },
            });
          }
          edges.push({
            id: `e:${callNode.id}->${toolId}#tool`,
            source: callNode.id,
            target: toolId,
            kind: "uses-tool",
          });
        }
      }
      continue;
    }

    const target = resolveCallTarget(node, fn, ctx);
    if (target) {
      const edgeId = `e:${fn.id}->${target.id}#${order}`;
      edges.push({
        id: edgeId,
        source: fn.id,
        target: target.id,
        kind: "calls",
        meta: {
          inLoop,
          inBranch,
          order,
          awaited: isAwaited(node),
          branchKey: decision?.key,
          branchArm: decision?.arm,
        },
      });
      order++;
    }
  }
}

function enclosingFunctionOf(node: Node): Node | undefined {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (
      Node.isFunctionDeclaration(cur) ||
      Node.isArrowFunction(cur) ||
      Node.isFunctionExpression(cur) ||
      Node.isMethodDeclaration(cur) ||
      Node.isConstructorDeclaration(cur) ||
      Node.isGetAccessorDeclaration(cur) ||
      Node.isSetAccessorDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return undefined;
}

function isInsideLoop(node: Node, stopAt: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur && cur !== stopAt) {
    const k = cur.getKind();
    if (
      k === SyntaxKind.WhileStatement ||
      k === SyntaxKind.DoStatement ||
      k === SyntaxKind.ForStatement ||
      k === SyntaxKind.ForOfStatement ||
      k === SyntaxKind.ForInStatement
    ) {
      return true;
    }
    cur = cur.getParent();
  }
  return false;
}

function getEnclosingDecision(
  call: Node,
  stopAt: Node,
): { key: string; arm: string } | undefined {
  let cur: Node | undefined = call;
  while (cur && cur !== stopAt) {
    const parent = cur.getParent();
    if (!parent) break;
    if (Node.isIfStatement(parent)) {
      const arm = parent.getThenStatement() === cur ? "then" : "else";
      return { key: `if@${parent.getStartLineNumber()}`, arm };
    }
    if (Node.isCaseClause(parent)) {
      const expr = parent.getExpression();
      const exprText = expr ? expr.getText() : "?";
      const switchAncestor = parent.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
      const ln = switchAncestor?.getStartLineNumber() ?? parent.getStartLineNumber();
      return { key: `switch@${ln}`, arm: `case ${exprText}` };
    }
    if (Node.isDefaultClause(parent)) {
      const switchAncestor = parent.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
      const ln = switchAncestor?.getStartLineNumber() ?? parent.getStartLineNumber();
      return { key: `switch@${ln}`, arm: "default" };
    }
    cur = parent;
  }
  return undefined;
}

function isInsideBranch(node: Node, stopAt: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur && cur !== stopAt) {
    const k = cur.getKind();
    if (
      k === SyntaxKind.IfStatement ||
      k === SyntaxKind.ConditionalExpression ||
      k === SyntaxKind.SwitchStatement ||
      k === SyntaxKind.CaseClause
    ) {
      return true;
    }
    cur = cur.getParent();
  }
  return false;
}

function isAwaited(node: Node): boolean {
  const p = node.getParent();
  return !!p && Node.isAwaitExpression(p);
}

function isAnthropicMessagesCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const methodName = expr.getName();
  if (methodName !== "create" && methodName !== "stream") return false;
  const obj = expr.getExpression();
  if (!Node.isPropertyAccessExpression(obj)) return false;
  return obj.getName() === "messages";
}

function buildLlmCallNode(call: CallExpression, fn: FnRecord, ctx: AnalyzeContext): GraphNode {
  const sf = call.getSourceFile();
  const loc = locOf(sf, call);
  const expr = call.getExpression() as PropertyAccessExpression;
  const methodName = expr.getName();
  const isStreaming = methodName === "stream";

  const meta: NodeMeta = {
    isStreaming,
    toolNames: [],
    systemPromptResolved: false,
  };

  const resolution: { unresolvedToolsExpr?: Node } = {};
  const args = call.getArguments();
  if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
    extractCallParams(args[0], meta, fn, ctx, resolution);
  } else {
    ctx.diagnostics.push({
      severity: "warn",
      message: "messages.create() called with non-literal arg — params not extracted.",
      loc,
    });
  }

  const id = `llm:${fn.filePathRel}:${loc.line}:${loc.column}`;
  const label = meta.model ? `LLM: ${meta.model}` : "LLM call";

  meta.containingFnId = fn.id;
  if (resolution.unresolvedToolsExpr) {
    meta.toolsResolution = "unresolved";
    ctx.unresolvedLlmCalls.push({
      llmNodeId: id,
      containingFnId: fn.id,
      toolsExpr: resolution.unresolvedToolsExpr,
    });
  } else {
    meta.toolsResolution = "literal";
  }

  let stmt: Node = call;
  while (true) {
    const p = stmt.getParent();
    if (!p) break;
    if (
      Node.isBlock(p) ||
      Node.isSourceFile(p) ||
      Node.isCaseClause(p) ||
      Node.isDefaultClause(p) ||
      Node.isModuleBlock(p)
    ) {
      break;
    }
    stmt = p;
  }
  const snippet = captureSnippet(stmt);
  meta.codeSnippet = snippet.text;
  meta.codeTruncated = snippet.truncated;
  meta.className = fn.className;

  return { id, kind: "llm-call", label, loc, meta };
}

function captureSnippet(node: Node, head = 50, tail = 50): { text: string; truncated: boolean } {
  const source = snippetSourceNode(node);
  const fullText = source.getFullText();
  const lines = fullText.split(/\r?\n/);
  while (lines.length > 1 && lines[0].trim() === "") lines.shift();
  return snippetFromLines(lines, head, tail);
}

function snippetSourceNode(decl: Node): Node {
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    const parent = decl.getParent();
    if (parent && Node.isPropertyDeclaration(parent)) return parent;
    if (parent && Node.isVariableDeclaration(parent)) {
      const stmt = parent.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      return stmt ?? parent;
    }
  }
  return decl;
}

function snippetFromText(text: string, head = 50, tail = 50): { text: string; truncated: boolean } {
  return snippetFromLines(text.split(/\r?\n/), head, tail);
}

function snippetFromLines(lines: string[], head = 50, tail = 50): { text: string; truncated: boolean } {
  if (lines.length <= head + tail + 1) return { text: lines.join("\n"), truncated: false };
  const middle = `// ... [${lines.length - head - tail} lines truncated] ...`;
  return {
    text: [...lines.slice(0, head), middle, ...lines.slice(-tail)].join("\n"),
    truncated: true,
  };
}

function extractCallParams(
  obj: ObjectLiteralExpression,
  meta: NodeMeta,
  fn: FnRecord,
  ctx: AnalyzeContext,
  resolution: { unresolvedToolsExpr?: Node } = {},
): void {
  for (const prop of obj.getProperties()) {
    if (Node.isSpreadAssignment(prop)) {
      let spread: Node = prop.getExpression();
      while (Node.isParenthesizedExpression(spread)) spread = spread.getExpression();
      if (Node.isConditionalExpression(spread)) {
        const trueBranch = spread.getWhenTrue();
        if (Node.isObjectLiteralExpression(trueBranch)) extractCallParams(trueBranch, meta, fn, ctx);
        const falseBranch = spread.getWhenFalse();
        if (Node.isObjectLiteralExpression(falseBranch)) extractCallParams(falseBranch, meta, fn, ctx);
      } else if (Node.isObjectLiteralExpression(spread)) {
        extractCallParams(spread, meta, fn, ctx);
      } else if (Node.isIdentifier(spread)) {
        const sf = fn.decl.getSourceFile();
        const v = sf.getVariableDeclaration(spread.getText());
        const init = v?.getInitializer();
        if (init && Node.isObjectLiteralExpression(init)) extractCallParams(init, meta, fn, ctx);
      }
      continue;
    }
    if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.getName();
    let init: Node | undefined;
    if (Node.isShorthandPropertyAssignment(prop)) {
      init = prop.getNameNode();
    } else {
      init = prop.getInitializer();
    }
    if (!init) continue;

    switch (name) {
      case "model": {
        const s = extractStringLike(init, fn);
        if (s?.resolved) meta.model = s.text;
        break;
      }
      case "max_tokens":
        if (Node.isNumericLiteral(init)) meta.maxTokens = Number(init.getLiteralValue());
        else {
          const ident = init;
          if (Node.isIdentifier(ident)) {
            const v = fn.decl.getSourceFile().getVariableDeclaration(ident.getText());
            const vinit = v?.getInitializer();
            if (vinit && Node.isNumericLiteral(vinit)) meta.maxTokens = Number(vinit.getLiteralValue());
          }
        }
        break;
      case "temperature":
        if (Node.isNumericLiteral(init)) meta.temperature = Number(init.getLiteralValue());
        break;
      case "system": {
        const s = extractStringLike(init, fn);
        if (s) {
          meta.systemPrompt = s.text;
          meta.systemPromptResolved = s.resolved;
        } else {
          meta.systemPrompt = init.getText().slice(0, 200);
          meta.systemPromptResolved = false;
        }
        break;
      }
      case "tools": {
        const arr = resolveToArrayLiteral(init, fn, ctx);
        if (arr) {
          const defs = extractToolDefs(arr);
          for (const d of defs) ctx.toolDefs.set(d.name, d.text);
          const existing = new Set(meta.toolNames ?? []);
          for (const d of defs) existing.add(d.name);
          meta.toolNames = [...existing];
        } else {
          resolution.unresolvedToolsExpr = init;
        }
        break;
      }
    }
  }
}

function extractStringLike(node: Node, fn: FnRecord): { text: string; resolved: boolean } | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.getLiteralValue(), resolved: true };
  }
  if (Node.isTemplateExpression(node)) {
    return { text: node.getText(), resolved: false };
  }
  if (Node.isIdentifier(node)) {
    const sf = fn.decl.getSourceFile();
    const v = sf.getVariableDeclaration(node.getText());
    const init = v?.getInitializer();
    if (init) return extractStringLike(init, fn);
    const fnNode = fn.decl;
    const params =
      Node.isFunctionDeclaration(fnNode) ||
      Node.isMethodDeclaration(fnNode) ||
      Node.isArrowFunction(fnNode) ||
      Node.isFunctionExpression(fnNode)
        ? fnNode.getParameters()
        : [];
    if (params.some((p) => p.getName() === node.getText())) {
      return { text: `(passed in via parameter: ${node.getText()})`, resolved: false };
    }
    const targetName = node.getText();
    let localInit: Node | undefined;
    let localSource: string | undefined;
    fn.decl.forEachDescendant((d, t) => {
      if (localInit) {
        t.stop();
        return;
      }
      if (Node.isVariableDeclaration(d) && d.getName() === targetName) {
        localInit = d.getInitializer() ?? undefined;
        t.stop();
        return;
      }
      if (Node.isBindingElement(d) && d.getName() === targetName) {
        const parentDecl = d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const init = parentDecl?.getInitializer();
        if (init) {
          localSource = `${init.getText()}.${targetName}`;
          t.stop();
        }
      }
    });
    if (localInit) return extractStringLike(localInit, fn);
    if (localSource) {
      const trimmed = localSource.length > 120 ? localSource.slice(0, 117) + "..." : localSource;
      return { text: `(destructured from: ${trimmed})`, resolved: false };
    }
    return { text: `(unresolved: ${targetName})`, resolved: false };
  }
  if (Node.isCallExpression(node)) {
    const text = node.getText();
    return { text: `(returned by: ${text.length > 120 ? text.slice(0, 117) + "..." : text})`, resolved: false };
  }
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getKind();
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      const left = extractStringLike(node.getLeft(), fn);
      const right = extractStringLike(node.getRight(), fn);
      if (left && right) {
        return { text: `${left.text}  ||  ${right.text}`, resolved: false };
      }
      return left ?? right;
    }
  }
  if (Node.isConditionalExpression(node)) {
    const yes = extractStringLike(node.getWhenTrue(), fn);
    const no = extractStringLike(node.getWhenFalse(), fn);
    if (yes && no) return { text: `${yes.text}  ||  ${no.text}`, resolved: false };
    return yes ?? no;
  }
  if (Node.isPropertyAccessExpression(node)) {
    return { text: `(value of: ${node.getText()})`, resolved: false };
  }
  return undefined;
}

function resolveToArrayLiteral(
  node: Node,
  fn: FnRecord,
  ctx: AnalyzeContext,
): ArrayLiteralExpression | undefined {
  if (Node.isArrayLiteralExpression(node)) return node;
  if (Node.isIdentifier(node)) {
    const sf = fn.decl.getSourceFile();
    const v = sf.getVariableDeclaration(node.getText());
    const init = v?.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) return init;
  }
  if (Node.isCallExpression(node)) {
    const target = resolveCallTarget(node, fn, ctx);
    if (target) {
      let arr: ArrayLiteralExpression | undefined;
      target.decl.forEachDescendant((d, t) => {
        if (Node.isReturnStatement(d)) {
          const expr = d.getExpression();
          if (expr && Node.isArrayLiteralExpression(expr)) {
            arr = expr;
            t.stop();
          }
        }
      });
      return arr;
    }
  }
  return undefined;
}

function extractToolDefs(arr: ArrayLiteralExpression): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const el of arr.getElements()) {
    if (!Node.isObjectLiteralExpression(el)) continue;
    const nameProp = el.getProperty("name");
    if (nameProp && Node.isPropertyAssignment(nameProp)) {
      const init = nameProp.getInitializer();
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
        out.push({ name: init.getLiteralValue(), text: el.getText() });
      }
    }
  }
  return out;
}

function resolveCallTarget(
  call: CallExpression,
  callerFn: FnRecord,
  ctx: AnalyzeContext,
): FnRecord | undefined {
  const callee = call.getExpression();

  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    const sameFile = ctx.fnByFileAndName.get(`${callerFn.filePathRel}::${name}`);
    if (sameFile) return sameFile;
    const sf = callerFn.decl.getSourceFile();
    for (const imp of sf.getImportDeclarations()) {
      const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
      if (!named) continue;
      const moduleSpec = imp.getModuleSpecifierValue();
      const resolvedPath = resolveLocalImport(callerFn.filePath, moduleSpec);
      if (!resolvedPath) return undefined;
      const targetRel = relPath(resolvedPath, ctx.rootDir);
      return ctx.fnByFileAndName.get(`${targetRel}::${named.getName()}`);
    }
    return undefined;
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const methodName = callee.getName();
    const receiver = callee.getExpression();
    const resolved = resolveExpr(receiver, callerFn, ctx);
    if (!resolved) return undefined;
    if (resolved.kind === "instance") {
      return resolved.class.methods.get(methodName);
    } else {
      return resolved.class.staticMethods.get(methodName);
    }
  }

  return undefined;
}

function resolveExpr(
  expr: Node,
  callerFn: FnRecord,
  ctx: AnalyzeContext,
): ResolvedType | undefined {
  if (expr.getKind() === SyntaxKind.ThisKeyword) {
    if (!callerFn.className) return undefined;
    const cls = ctx.classByFqn.get(`${callerFn.filePathRel}::${callerFn.className}`);
    return cls ? { kind: "instance", class: cls } : undefined;
  }

  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    const classRecs = ctx.classByName.get(name);
    if (classRecs && classRecs.length > 0) {
      return { kind: "class-ref", class: classRecs[0] };
    }
    const typeName = resolveLocalNameType(name, callerFn, ctx);
    if (typeName) {
      const cls = findClassByName(typeName, ctx);
      if (cls) return { kind: "instance", class: cls };
    }
    return undefined;
  }

  if (Node.isPropertyAccessExpression(expr)) {
    const propName = expr.getName();
    const recv = resolveExpr(expr.getExpression(), callerFn, ctx);
    if (!recv) return undefined;
    if (recv.kind === "instance") {
      const t = recv.class.thisPropTypes.get(propName);
      if (t) {
        const cls = findClassByName(t, ctx);
        if (cls) return { kind: "instance", class: cls };
      }
    } else {
      const t = recv.class.staticPropTypes.get(propName);
      if (t) {
        const cls = findClassByName(t, ctx);
        if (cls) return { kind: "instance", class: cls };
      }
      const ret = recv.class.staticReturnTypes.get(propName);
      if (ret) {
        const cls = findClassByName(ret, ctx);
        if (cls) return { kind: "instance", class: cls };
      }
    }
    return undefined;
  }

  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const methodName = callee.getName();
      const recv = resolveExpr(callee.getExpression(), callerFn, ctx);
      if (!recv) return undefined;
      if (recv.kind === "class-ref") {
        const ret = recv.class.staticReturnTypes.get(methodName);
        if (ret) {
          const cls = findClassByName(ret, ctx);
          if (cls) return { kind: "instance", class: cls };
        }
      }
    }
    return undefined;
  }

  if (Node.isParenthesizedExpression(expr)) {
    return resolveExpr(expr.getExpression(), callerFn, ctx);
  }
  if (Node.isAsExpression(expr) || Node.isTypeAssertion(expr) || Node.isNonNullExpression(expr)) {
    return resolveExpr(expr.getExpression(), callerFn, ctx);
  }
  if (Node.isAwaitExpression(expr)) {
    return resolveExpr(expr.getExpression(), callerFn, ctx);
  }

  return undefined;
}

function resolveLocalNameType(
  name: string,
  callerFn: FnRecord,
  ctx: AnalyzeContext,
): string | undefined {
  let foundType: string | undefined;
  callerFn.decl.forEachDescendant((d, t) => {
    if (foundType) {
      t.stop();
      return;
    }
    if (Node.isVariableDeclaration(d) && d.getName() === name) {
      const typeNode = d.getTypeNode();
      const t1 = typeNameOf(typeNode);
      if (t1) {
        foundType = t1;
        t.stop();
        return;
      }
      const init = d.getInitializer();
      if (init) {
        if (Node.isNewExpression(init)) {
          foundType = init.getExpression().getText();
          t.stop();
          return;
        }
        if (Node.isCallExpression(init)) {
          const callee = init.getExpression();
          if (Node.isPropertyAccessExpression(callee)) {
            const recv = resolveExpr(callee.getExpression(), callerFn, ctx);
            if (recv && recv.kind === "class-ref") {
              const ret = recv.class.staticReturnTypes.get(callee.getName());
              if (ret) {
                foundType = ret;
                t.stop();
                return;
              }
            }
          }
        }
      }
    }
  });
  if (foundType) return foundType;

  const fnNode = callerFn.decl;
  const params =
    Node.isFunctionDeclaration(fnNode) ||
    Node.isMethodDeclaration(fnNode) ||
    Node.isArrowFunction(fnNode) ||
    Node.isFunctionExpression(fnNode) ||
    Node.isConstructorDeclaration(fnNode)
      ? (fnNode.getParameters() as ParameterDeclaration[])
      : [];
  for (const p of params) {
    if (p.getName() === name) {
      const t = typeNameOf(p.getTypeNode());
      if (t) return t;
    }
  }

  if (callerFn.className) {
    const cls = ctx.classByFqn.get(`${callerFn.filePathRel}::${callerFn.className}`);
    const t = cls?.thisPropTypes.get(name);
    if (t) return t;
  }

  const sf = callerFn.decl.getSourceFile();
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
    if (named) {
      const moduleSpec = imp.getModuleSpecifierValue();
      const resolvedPath = resolveLocalImport(callerFn.filePath, moduleSpec);
      if (!resolvedPath) continue;
      const targetRel = relPath(resolvedPath, ctx.rootDir);
      const targetSf = sf.getProject().getSourceFile(resolvedPath);
      if (!targetSf) continue;
      for (const v of targetSf.getVariableStatements()) {
        for (const decl of v.getDeclarations()) {
          if (decl.getName() === named.getName()) {
            const init = decl.getInitializer();
            if (init && Node.isNewExpression(init)) return init.getExpression().getText();
            const typeNode = decl.getTypeNode();
            const t = typeNameOf(typeNode);
            if (t) return t;
          }
        }
      }
      void targetRel;
    }
  }

  return undefined;
}

function findClassByName(name: string, ctx: AnalyzeContext): ClassRecord | undefined {
  return ctx.classByName.get(name)?.[0];
}

function typeNameOf(node: TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isTypeReference(node)) {
    return node.getTypeName().getText();
  }
  return undefined;
}

function signatureOf(node: MethodDeclaration | PropertyDeclaration): string {
  const text = node.getText();
  const cut = text.indexOf("{");
  const arrowCut = text.indexOf("=>");
  const limits = [cut, arrowCut].filter((n) => n > 0);
  const end = limits.length ? Math.min(...limits) : text.length;
  return text.slice(0, end).trim().slice(0, 200);
}

function resolveLocalImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, spec);
  const baseNoJs = base.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = [baseNoJs + ".ts", baseNoJs + ".tsx", path.join(baseNoJs, "index.ts")];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function computeReachable(entries: string[], edges: GraphEdge[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>(entries);
  const stack = [...entries];
  while (stack.length) {
    const n = stack.pop()!;
    for (const next of out.get(n) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function computeReverseReachable(targets: string[], edges: GraphEdge[]): Set<string> {
  const inEdges = new Map<string, string[]>();
  for (const e of edges) {
    if (!inEdges.has(e.target)) inEdges.set(e.target, []);
    inEdges.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>(targets);
  const stack = [...targets];
  while (stack.length) {
    const n = stack.pop()!;
    for (const prev of inEdges.get(n) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        stack.push(prev);
      }
    }
  }
  return seen;
}

function computeSubgraphs(nodes: GraphNode[], edges: GraphEdge[]): Subgraph[] {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  const componentId = new Map<string, number>();
  let cid = 0;
  for (const n of nodes) {
    if (componentId.has(n.id)) continue;
    const stack = [n.id];
    while (stack.length) {
      const x = stack.pop()!;
      if (componentId.has(x)) continue;
      componentId.set(x, cid);
      for (const y of adj.get(x) ?? []) stack.push(y);
    }
    cid++;
  }
  const subgraphs: Subgraph[] = [];
  for (let i = 0; i < cid; i++) {
    const cn = nodes.filter((n) => componentId.get(n.id) === i);
    const ce = edges.filter((e) => componentId.get(e.source) === i);
    const entries = cn.filter((n) => n.kind === "entry");
    const label = entries.length > 0 ? entries.map((e) => e.label).slice(0, 3).join(", ") + (entries.length > 3 ? ` +${entries.length - 3}` : "") : `Component ${i + 1}`;
    subgraphs.push({
      id: `sg:${i}`,
      label,
      entryNodeIds: entries.map((e) => e.id),
      nodeIds: cn.map((n) => n.id),
      edgeIds: ce.map((e) => e.id),
    });
  }
  subgraphs.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  return subgraphs;
}

interface ToolDependency {
  paramName: string;
  propPath?: string;
  resolve(argNode: Node): { names: string[]; texts: Map<string, string> } | undefined;
}

function resolvePerCallerTools(
  ctx: AnalyzeContext,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): void {
  for (const item of ctx.unresolvedLlmCalls) {
    const fn = ctx.fnById.get(item.containingFnId);
    if (!fn) continue;
    const dep = detectToolDependency(item.toolsExpr, fn, ctx);
    if (!dep) continue;

    const params = getParams(fn.decl);
    const paramIdx = params.findIndex((p) => p.getName() === dep.paramName);
    if (paramIdx < 0) continue;

    const callerIds = new Set<string>();
    for (const e of edges) {
      if (e.kind === "calls" && e.target === fn.id) callerIds.add(e.source);
    }

    const perCallerNames: Record<string, string[]> = {};
    const allNames = new Set<string>();
    const allTexts = new Map<string, string>();

    for (const callerId of callerIds) {
      const callerFn = ctx.fnById.get(callerId);
      if (!callerFn) continue;
      callerFn.decl.forEachDescendant((d) => {
        if (!Node.isCallExpression(d)) return;
        const resolved = resolveCallTarget(d, callerFn, ctx);
        if (resolved?.id !== fn.id) return;
        const args = d.getArguments();
        if (args.length <= paramIdx) return;
        const baseArg = args[paramIdx];
        const effectiveArg = dep.propPath ? extractObjectProp(baseArg, dep.propPath) : baseArg;
        if (!effectiveArg) return;
        const out = dep.resolve(effectiveArg);
        if (!out) return;
        perCallerNames[callerId] = out.names;
        for (const n of out.names) allNames.add(n);
        for (const [name, text] of out.texts) allTexts.set(name, text);
      });
    }

    const llmNode = nodes.get(item.llmNodeId);
    if (llmNode && llmNode.meta) {
      llmNode.meta.toolNames = [...allNames];
      llmNode.meta.toolsResolution = allNames.size > 0 ? "per-caller" : "unresolved";
      llmNode.meta.perCallerTools = perCallerNames;
    }

    for (const [name, text] of allTexts) ctx.toolDefs.set(name, text);

    for (const toolName of allNames) {
      const toolId = `tool:${fn.filePathRel}:${toolName}`;
      if (!nodes.has(toolId)) {
        const text = allTexts.get(toolName);
        const snip = text ? snippetFromText(text) : undefined;
        nodes.set(toolId, {
          id: toolId,
          kind: "tool",
          label: toolName,
          meta: {
            notes: [`Per-caller tool referenced by ${item.llmNodeId}`],
            codeSnippet: snip?.text,
            codeTruncated: snip?.truncated,
          },
        });
      }
      const viaCallers: string[] = [];
      for (const [callerId, names] of Object.entries(perCallerNames)) {
        if (names.includes(toolName)) viaCallers.push(callerId);
      }
      const edgeId = `e:${item.llmNodeId}->${toolId}#tool`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: item.llmNodeId,
          target: toolId,
          kind: "uses-tool",
          meta: { viaCallers },
        });
      }
    }
  }
}

function detectToolDependency(
  expr: Node,
  fn: FnRecord,
  ctx: AnalyzeContext,
): ToolDependency | undefined {
  let resolved: Node = expr;
  let safety = 5;
  while (Node.isIdentifier(resolved) && safety-- > 0) {
    const decl = findVariableDeclInFn(resolved.getText(), fn);
    const init = decl?.getInitializer();
    if (!init) break;
    resolved = init;
  }
  return detectPatternB(resolved, fn, ctx) ?? detectPatternA(resolved, fn, ctx);
}

function detectPatternA(expr: Node, fn: FnRecord, ctx: AnalyzeContext): ToolDependency | undefined {
  if (!Node.isCallExpression(expr)) return undefined;
  const callee = expr.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (callee.getName() !== "filter") return undefined;

  const baseExpr = callee.getExpression();
  if (!Node.isIdentifier(baseExpr)) return undefined;

  const sf = fn.decl.getSourceFile();
  const arrDecl = sf.getVariableDeclaration(baseExpr.getText());
  if (!arrDecl) return undefined;
  let arrInit: Node | undefined = arrDecl.getInitializer();
  if (arrInit && Node.isAsExpression(arrInit)) arrInit = arrInit.getExpression();
  if (!arrInit || !Node.isArrayLiteralExpression(arrInit)) return undefined;
  const allDefs = extractToolDefs(arrInit);
  if (allDefs.length === 0) return undefined;

  const params = getParams(fn.decl);
  const paramNames = new Set(params.map((p) => p.getName()));
  if (paramNames.size === 0) return undefined;

  let paramName: string | undefined;
  let propPath: string | undefined;

  fn.decl.forEachDescendant((d) => {
    if (paramName) return;
    if (!Node.isVariableDeclaration(d)) return;
    const init = d.getInitializer();
    if (!init || !Node.isNewExpression(init)) return;
    if (init.getExpression().getText() !== "Set") return;
    const newArgs = init.getArguments();
    if (newArgs.length !== 1) return;
    const arg = newArgs[0];
    if (Node.isIdentifier(arg) && paramNames.has(arg.getText())) {
      paramName = arg.getText();
    } else if (Node.isPropertyAccessExpression(arg)) {
      const recv = arg.getExpression();
      if (Node.isIdentifier(recv) && paramNames.has(recv.getText())) {
        paramName = recv.getText();
        propPath = arg.getName();
      }
    }
  });

  if (!paramName) {
    const cb = expr.getArguments()[0];
    if (cb) {
      cb.forEachDescendant((d) => {
        if (paramName) return;
        if (Node.isIdentifier(d) && paramNames.has(d.getText())) {
          paramName = d.getText();
        } else if (Node.isPropertyAccessExpression(d)) {
          const recv = d.getExpression();
          if (Node.isIdentifier(recv) && paramNames.has(recv.getText())) {
            paramName = recv.getText();
            propPath = d.getName();
          }
        }
      });
    }
  }
  if (!paramName) return undefined;

  return {
    paramName,
    propPath,
    resolve(argNode) {
      if (!Node.isArrayLiteralExpression(argNode)) return undefined;
      const allowed = new Set<string>();
      for (const el of argNode.getElements()) {
        if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
          allowed.add(el.getLiteralValue());
        }
      }
      const names: string[] = [];
      const texts = new Map<string, string>();
      for (const def of allDefs) {
        if (allowed.has(def.name)) {
          names.push(def.name);
          texts.set(def.name, def.text);
        }
      }
      return { names, texts };
    },
  };
}

function detectPatternB(expr: Node, fn: FnRecord, ctx: AnalyzeContext): ToolDependency | undefined {
  if (!Node.isCallExpression(expr)) return undefined;
  const callee = expr.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (callee.getName() !== "map") return undefined;

  let baseExpr: Node = callee.getExpression();
  let safety = 5;
  while (Node.isIdentifier(baseExpr) && safety-- > 0) {
    const decl = findVariableDeclInFn(baseExpr.getText(), fn);
    const init = decl?.getInitializer();
    if (!init) break;
    baseExpr = init;
  }
  if (!Node.isElementAccessExpression(baseExpr)) return undefined;

  const regExpr = baseExpr.getExpression();
  const idxExpr = baseExpr.getArgumentExpression();
  if (!Node.isIdentifier(regExpr) || !idxExpr) return undefined;

  const params = getParams(fn.decl);
  const paramNames = new Set(params.map((p) => p.getName()));

  let paramName: string;
  let propPath: string | undefined;
  if (Node.isIdentifier(idxExpr)) {
    if (!paramNames.has(idxExpr.getText())) return undefined;
    paramName = idxExpr.getText();
  } else if (Node.isPropertyAccessExpression(idxExpr)) {
    const recv = idxExpr.getExpression();
    if (!Node.isIdentifier(recv) || !paramNames.has(recv.getText())) return undefined;
    paramName = recv.getText();
    propPath = idxExpr.getName();
  } else {
    return undefined;
  }

  const sf = fn.decl.getSourceFile();
  const regDecl = sf.getVariableDeclaration(regExpr.getText());
  if (!regDecl) return undefined;
  let regInit: Node | undefined = regDecl.getInitializer();
  if (regInit && Node.isAsExpression(regInit)) regInit = regInit.getExpression();
  if (!regInit || !Node.isObjectLiteralExpression(regInit)) return undefined;
  const bundles = regInit;

  const cb = expr.getArguments()[0];
  let toolsRegName: string | undefined;
  if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
    cb.forEachDescendant((d) => {
      if (toolsRegName) return;
      if (Node.isElementAccessExpression(d)) {
        const base = d.getExpression();
        if (Node.isIdentifier(base)) toolsRegName = base.getText();
      }
    });
  }

  let toolsObj: ObjectLiteralExpression | undefined;
  if (toolsRegName) {
    const toolsReg = sf.getVariableDeclaration(toolsRegName);
    let toolsInit: Node | undefined = toolsReg?.getInitializer();
    if (toolsInit && Node.isAsExpression(toolsInit)) toolsInit = toolsInit.getExpression();
    if (toolsInit && Node.isObjectLiteralExpression(toolsInit)) toolsObj = toolsInit;
  }

  return {
    paramName,
    propPath,
    resolve(argNode) {
      if (!Node.isStringLiteral(argNode) && !Node.isNoSubstitutionTemplateLiteral(argNode)) {
        return undefined;
      }
      const bundleName = argNode.getLiteralValue();
      const bundleProp = bundles.getProperty(bundleName);
      if (!bundleProp || !Node.isPropertyAssignment(bundleProp)) return undefined;
      let bundleInit: Node | undefined = bundleProp.getInitializer() ?? undefined;
      if (bundleInit && Node.isAsExpression(bundleInit)) bundleInit = bundleInit.getExpression();
      if (!bundleInit || !Node.isArrayLiteralExpression(bundleInit)) return undefined;

      const names: string[] = [];
      const texts = new Map<string, string>();
      for (const el of bundleInit.getElements()) {
        if (!Node.isStringLiteral(el) && !Node.isNoSubstitutionTemplateLiteral(el)) continue;
        const toolName = el.getLiteralValue();
        names.push(toolName);
        if (toolsObj) {
          const toolEntryProp = toolsObj.getProperty(toolName);
          if (toolEntryProp && Node.isPropertyAssignment(toolEntryProp)) {
            const toolEntry = toolEntryProp.getInitializer();
            if (toolEntry && Node.isObjectLiteralExpression(toolEntry)) {
              const defProp = toolEntry.getProperty("definition");
              if (defProp && Node.isPropertyAssignment(defProp)) {
                const defInit = defProp.getInitializer();
                if (defInit && Node.isObjectLiteralExpression(defInit)) {
                  texts.set(toolName, defInit.getText());
                }
              }
            }
          }
        }
      }
      return { names, texts };
    },
  };
}

function findVariableDeclInFn(name: string, fn: FnRecord) {
  let found: ReturnType<SourceFile["getVariableDeclaration"]>;
  fn.decl.forEachDescendant((d) => {
    if (found) return;
    if (Node.isVariableDeclaration(d) && d.getName() === name) found = d;
  });
  if (found) return found;
  return fn.decl.getSourceFile().getVariableDeclaration(name);
}

function getParams(decl: Node): ParameterDeclaration[] {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isMethodDeclaration(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isConstructorDeclaration(decl)
  ) {
    return decl.getParameters();
  }
  return [];
}

function extractObjectProp(argNode: Node, propName: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(argNode)) return undefined;
  const prop = argNode.getProperty(propName);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  return prop.getInitializer() ?? undefined;
}

function detectToolDispatchers(
  ctx: AnalyzeContext,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): GraphEdge[] {
  const created: GraphEdge[] = [];
  const toolNodes = [...nodes.values()].filter((n) => n.kind === "tool");
  if (toolNodes.length === 0) return created;
  const toolNamesInGraph = new Set(toolNodes.map((t) => t.label));

  for (const fn of ctx.fnById.values()) {
    fn.decl.forEachDescendant((d) => {
      if (!Node.isSwitchStatement(d)) return;
      for (const clause of d.getCaseBlock().getClauses()) {
        if (!Node.isCaseClause(clause)) continue;
        const caseExpr = clause.getExpression();
        if (
          !caseExpr ||
          (!Node.isStringLiteral(caseExpr) && !Node.isNoSubstitutionTemplateLiteral(caseExpr))
        ) {
          continue;
        }
        const toolName = caseExpr.getLiteralValue();
        if (!toolNamesInGraph.has(toolName)) continue;
        let handler: FnRecord | undefined;
        for (const stmt of clause.getStatements()) {
          let body: Node | undefined;
          if (Node.isReturnStatement(stmt)) body = stmt.getExpression() ?? undefined;
          else if (Node.isExpressionStatement(stmt)) body = stmt.getExpression();
          if (!body) continue;
          if (Node.isAwaitExpression(body)) body = body.getExpression();
          if (Node.isCallExpression(body)) {
            handler = resolveCallTarget(body, fn, ctx);
            break;
          }
        }
        if (handler) {
          const toolId = `tool:${fn.filePathRel}:${toolName}`;
          const edgeId = `e:${toolId}->${handler.id}#handles`;
          if (!edges.some((e) => e.id === edgeId)) {
            const edge: GraphEdge = {
              id: edgeId,
              source: toolId,
              target: handler.id,
              kind: "handles-tool",
            };
            edges.push(edge);
            created.push(edge);
          }
        }
      }
    });
  }
  return created;
}

/**
 * A tool definition and its dispatch handler are 1:1 in practice, so showing
 * them as two nodes joined by a "handles" edge doubles the node count for no
 * extra information. This folds each handler into its tool node: the handler's
 * source/signature is carried in `meta.handler`, the handler's other edges are
 * rewired onto the tool node, and the handler node + handles-tool edge are
 * dropped. The tool node inherits the handler's location so it stays navigable.
 */
function mergeToolHandlers(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  handlerEdges: GraphEdge[],
): void {
  if (handlerEdges.length === 0) return;
  // handler fn id -> tool node id
  const handlerToTool = new Map<string, string>();
  const removedHandlerIds = new Set<string>();
  const droppedEdgeIds = new Set<string>();

  for (const he of handlerEdges) {
    const toolId = he.source;
    const handlerId = he.target;
    const tool = nodes.get(toolId);
    const handler = nodes.get(handlerId);
    if (!tool || !handler) continue;
    handlerToTool.set(handlerId, toolId);
    removedHandlerIds.add(handlerId);
    droppedEdgeIds.add(he.id);

    const hMeta = handler.meta ?? {};
    tool.meta = tool.meta ?? {};
    tool.meta.handler = {
      fnId: handlerId,
      label: handler.label,
      signature: hMeta.signature,
      loc: handler.loc,
      codeSnippet: hMeta.codeSnippet,
      codeTruncated: hMeta.codeTruncated,
      isAsync: hMeta.isAsync,
    };
    // Make the tool node navigable to the actual implementation.
    if (!tool.loc && handler.loc) tool.loc = handler.loc;
    if (hMeta.className && !tool.meta.className) tool.meta.className = hMeta.className;
  }

  // Rewire every edge that touched a handler so it points at the tool instead.
  for (const e of edges) {
    if (droppedEdgeIds.has(e.id)) continue;
    const newSource = handlerToTool.get(e.source);
    const newTarget = handlerToTool.get(e.target);
    if (newSource) e.source = newSource;
    if (newTarget) e.target = newTarget;
  }

  // Drop handler nodes and the handles-tool edges; dedupe collapsed parallels.
  for (const id of removedHandlerIds) nodes.delete(id);
  const seen = new Set<string>();
  const kept: GraphEdge[] = [];
  for (const e of edges) {
    if (droppedEdgeIds.has(e.id)) continue;
    if (e.source === e.target) continue; // self-loops created by folding
    const key = `${e.source}->${e.target}#${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(e);
  }
  edges.length = 0;
  edges.push(...kept);
}

function attachRecursionFlags(nodes: Map<string, GraphNode>, edges: GraphEdge[]): void {
  const callEdges = edges.filter((e) => e.kind === "calls");
  const out = new Map<string, string[]>();
  for (const e of callEdges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const onStack = new Set<string>();
  const inSCC = new Set<string>();
  const visited = new Set<string>();

  function dfs(id: string, p: string[]): void {
    if (onStack.has(id)) {
      const idx = p.indexOf(id);
      if (idx !== -1) for (const x of p.slice(idx)) inSCC.add(x);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    onStack.add(id);
    for (const next of out.get(id) ?? []) dfs(next, [...p, id]);
    onStack.delete(id);
  }
  for (const id of out.keys()) dfs(id, []);

  for (const id of inSCC) {
    const node = nodes.get(id);
    if (node && node.meta) node.meta.inRecursion = true;
  }
  for (const id of inSCC) {
    for (const e of callEdges) {
      if (e.source === id) {
        const tgt = nodes.get(e.target);
        if (tgt?.kind === "llm-call" && tgt.meta) tgt.meta.inRecursion = true;
      }
    }
  }
}

function locOf(sf: SourceFile, n: Node): SourceLocation {
  const pos = n.getStart();
  const lc = sf.getLineAndColumnAtPos(pos);
  return { file: sf.getFilePath(), line: lc.line, column: lc.column };
}

function makeFnId(filePathRel: string, name: string, line: number): string {
  return `fn:${filePathRel}:${name}:${line}`;
}
