const fs = require("node:fs/promises");
const { uriPath } = require("./source-resolver");

/** Imported calculation findings are independent of static analysis. */
class CalculationDiagnostics {
  constructor(project) {
    this.project = project;
    this.results = new Map();
  }

  async importCalculationDiagnostics(uri) {
    const document = this.project.documents.get(uri);
    const filePath = uriPath(uri);
    if (!document?.open || !filePath)
      throw new Error("Open a saved SOFiSTiK document before importing calculation diagnostics.");
    const snapshot = document.version;
    const targetSnapshot = document.target;
    const saved = await this.project.readInput(uri);
    if (saved !== document.text.replace(/^\uFEFF/, ""))
      throw new Error("Save this document before importing calculation diagnostics.");
    const contents = await fs.readFile(
      filePath.replace(/\.[^.\\/]+$/, "") + ".error_positions",
      "utf8",
    );
    const sourceLines = document.text.split(/\r?\n/);
    const diagnostics = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !Number.isInteger(item.position?.line) ||
        item.position.line < 1 ||
        typeof item.position.text !== "string" ||
        typeof item.isError !== "boolean"
      )
        continue;
      const row = item.position.line - 1;
      const textLine = sourceLines[row];
      if (textLine === undefined) continue;
      diagnostics.push({
        range: {
          start: { line: row, character: 0 },
          end: { line: row, character: Math.max(1, textLine.length) },
        },
        severity: item.isError ? 1 : 3,
        source: "sofistik-calculation",
        code:
          typeof item.errornumber === "number" || typeof item.errornumber === "string"
            ? item.errornumber
            : undefined,
        message: item.position.text,
      });
    }
    if (
      this.project.documents.get(uri) !== document ||
      document.version !== snapshot ||
      document.target !== targetSnapshot
    )
      return { uri, count: 0, discarded: true };
    this.results.set(uri, diagnostics);
    return { uri, count: diagnostics.length };
  }

  dispose() {
    this.results.clear();
  }
}

module.exports = { CalculationDiagnostics };
