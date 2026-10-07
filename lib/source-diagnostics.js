const { EMPTY_RANGE } = require("./ranges");

function sourceDiagnostics(project, uri) {
  const document = project.documents.get(uri);
  if (!document?.open) return [];
  const diagnostics = (document.index.diagnostics || []).map((item) => ({
    severity: 2,
    source: "sofistik",
    ...item,
  }));
  if (project.skippedInputs.has(uri))
    diagnostics.push({
      range: EMPTY_RANGE,
      severity: 2,
      source: "sofistik",
      code: "input-size-limit",
      message: project.skippedInputs.get(uri),
    });
  const target = document.target;
  const keywords = target.keywords;
  const modules = new Set(keywords?.getModuleNames() || []);
  if (keywords) {
    for (const record of document.index.records) {
      if (record.kind !== "program") continue;
      const module = record.tokens.find((token) => token.role === "module");
      if (
        module &&
        module.type === "word" &&
        /^[a-z][a-z0-9]*$/i.test(module.value) &&
        !modules.has(module.value.toUpperCase())
      ) {
        diagnostics.push({
          range: {
            start: { line: record.range.start.line, character: module.start },
            end: { line: record.range.start.line, character: module.end },
          },
          severity: 1,
          source: "sofistik",
          code: "unknown-module",
          message: `Unknown module ${module.value} in the SOFiSTiK ${target.version} catalogue.`,
        });
      }
    }
  }
  if (!target.dataSupported) {
    diagnostics.push({
      range: EMPTY_RANGE,
      severity: 2,
      source: "sofistik",
      code: "unsupported-project-version",
      message: `No command schema is included for SOFiSTiK ${target.version}. Structural navigation remains available.`,
    });
  }
  return diagnostics;
}

module.exports = { sourceDiagnostics };
