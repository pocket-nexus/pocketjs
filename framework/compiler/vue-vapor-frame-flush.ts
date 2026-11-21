import ts from "typescript";

/** Locate Vue's scheduled flush from its nextTick export, including minified builds. */
export function exposeVaporFrameFlush(source: string): string {
  const file = ts.createSourceFile("vue-runtime.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let nextTick: string | undefined;
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const exported = statement.exportClause.elements.find(item => item.name.text === "nextTick");
      if (exported) nextTick = (exported.propertyName ?? exported.name).text;
    }
  }
  const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === nextTick);
  let pending: string | undefined;
  function findPending(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken && ts.isIdentifier(node.left) && ts.isIdentifier(node.right)) pending ??= node.left.text;
    ts.forEachChild(node, findPending);
  }
  if (declaration) findPending(declaration);
  let callback: string | undefined;
  function findCallback(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === pending && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isCallExpression(node.right)) {
      const call = node.right;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "then" && call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]!)) callback = call.arguments[0]!.text;
    }
    ts.forEachChild(node, findCallback);
  }
  if (pending) findCallback(file);
  if (!callback) throw new Error("PocketJS: the Vue runtime scheduler changed; cannot install the synchronous AOT frame flush");
  const bridge = new URL("../src/vue-vapor-flush.ts", import.meta.url).pathname;
  return `${source}\nimport { installVueFrameFlush as __pocketInstallFrameFlush } from ${JSON.stringify(bridge)};\n__pocketInstallFrameFlush(${callback});\n`;
}
