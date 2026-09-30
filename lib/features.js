const { CompletionItemKind, SymbolKind } = require("vscode-languageserver/node");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

function schemaFor(keywords, module, command) {
  return (
    keywords?.getCommandSchema(module, command) ||
    keywords?.getCommandSchema("BASIC", command) ||
    null
  );
}

function parameterName(context) {
  const parameter =
    context.param ||
    (typeof context.activeParameter === "string" ? context.activeParameter : undefined);
  return typeof parameter === "string" ? parameter : parameter?.name;
}

function slotsFor(schema, context) {
  const name = parameterName(context)?.toUpperCase();
  return (schema?.forms || []).flatMap((form) =>
    form.slots.filter((slot) => name && slot.name === name),
  );
}

function signatureLabel(command, form) {
  return [command, ...form.slots.map((slot) => slot.name || "_")].join(" ");
}

function wordPrefix(context) {
  return String(context.prefix || "");
}

function completionRange(position, prefix) {
  return {
    start: { line: position.line, character: Math.max(0, position.character - prefix.length) },
    end: position,
  };
}

async function completion(project, uri, position) {
  const entry = await project.loadDocument(uri);
  if (!entry) return [];
  const context = entry.index.contextAt(position);
  if (!context || context.inComment) return [];
  const keywords = entry.target.keywords;
  const prefix = wordPrefix(context);
  const normalizedPrefix = prefix.replace(/^#|^\$\(/, "").toUpperCase();
  const format = (word) =>
    project.settings.textCase === "lower" ? word.toLowerCase() : word.toUpperCase();
  const candidates = [];
  const seen = new Set();
  let order = 0;
  const add = (label, kind, detail, insertText = format(label)) => {
    const identity = `${kind}:${label.toUpperCase()}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const sortText = String(order++).padStart(6, "0");
    if (!label.toUpperCase().startsWith(normalizedPrefix)) return;
    candidates.push({
      label: format(label),
      kind,
      detail,
      sortText,
      textEdit: { range: completionRange(position, prefix), newText: insertText },
    });
  };

  if (context.role === "variable" || context.role === "macro") {
    const namespace = context.role === "macro" ? "macro" : "variable";
    for (const symbol of await project.visibleSymbols(uri)) {
      if (symbol.namespace !== namespace) continue;
      const replacement = prefix.startsWith("$(")
        ? `$( ${format(symbol.name)} )`.replace(/ /g, "")
        : prefix.startsWith("#")
          ? `#${format(symbol.name)}`
          : format(symbol.name);
      add(
        symbol.name,
        namespace === "macro" ? CompletionItemKind.Function : CompletionItemKind.Variable,
        namespace,
        replacement,
      );
    }
  } else if (context.inText || (context.inString && context.role !== "value")) {
    return [];
  } else if (context.role === "module") {
    for (const name of keywords?.getModuleNames() || []) {
      if (name !== "BASIC") add(name, CompletionItemKind.Module, "SOFiSTiK module");
    }
  } else if (!context.command || context.role === "command") {
    const commands = new Set([
      ...(keywords?.getModuleCommands(context.module) || []),
      ...(keywords?.getModuleCommands("BASIC") || []),
    ]);
    for (const command of commands)
      add(command, CompletionItemKind.Keyword, context.module || "CADINP");
  } else {
    const schema = schemaFor(keywords, context.module, context.command);
    if (context.role === "value") {
      for (const slot of slotsFor(schema, context)) {
        for (const value of slot.enumValues || [])
          add(value, CompletionItemKind.EnumMember, `${context.command} ${slot.name}`);
      }
    }
    if (!context.inString && context.role !== "value") {
      for (const slot of (schema?.forms || []).flatMap((form) => form.slots)) {
        if (slot.name) add(slot.name, CompletionItemKind.Field, context.command);
      }
    }
  }
  return candidates;
}

function halfOpenContains(range, position) {
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return range && compare(range.start, position) <= 0 && compare(position, range.end) < 0;
}

function matchingForms(schema, context) {
  const parameters = (context.record?.tokens || [])
    .filter((token) => token.role === "param" && !token.partialParam)
    .map((token) => token.param || token.value.toUpperCase());
  const forms = schema.forms.filter((form) =>
    parameters.every((name) => form.slots.some((slot) => slot.name === name)),
  );
  return forms.length ? forms : schema.forms;
}

function declarationPreview(entry, declaration) {
  const lines = entry.text.split(/\r?\n/);
  const start = declaration.range.start;
  let end = declaration.range.end;
  const recordIndex = entry.index.records.findIndex(
    (record) =>
      record.range.start.line === start.line && record.range.start.character === start.character,
  );
  const record = entry.index.records[recordIndex];
  if (
    declaration.namespace === "macro" &&
    record?.tokens.filter((token) => token.type !== "comment").length === 2
  ) {
    let depth = 1;
    for (const next of entry.index.records.slice(recordIndex + 1)) {
      const keyword = next.tokens[0]?.value.toUpperCase();
      if (
        keyword === "#DEFINE" &&
        next.tokens.filter((token) => token.type !== "comment").length === 2
      )
        depth++;
      if (keyword === "#ENDDEF") depth--;
      end = next.range.end;
      if (depth === 0 || end.line >= start.line + 3) break;
    }
  } else if (record?.continued) {
    for (const next of entry.index.records.slice(recordIndex + 1)) {
      if (!next.continuedFromPrevious) break;
      end = next.range.end;
      if (!next.continued || end.line >= start.line + 3) break;
    }
  }
  const lastLine = Math.min(end.line, start.line + 3);
  const excerpt = lines.slice(start.line, lastLine + 1);
  if (!excerpt.length) return null;
  if (end.line === lastLine) excerpt[excerpt.length - 1] = excerpt.at(-1).slice(0, end.character);
  excerpt[0] = excerpt[0].slice(start.character);
  const code = excerpt.join("\n").trimEnd();
  const characters = Array.from(code);
  return characters.length > 300 || end.line > lastLine
    ? `${characters.slice(0, 300).join("")}…`
    : code;
}

async function hover(project, uri, position) {
  const entry = await project.loadDocument(uri);
  if (!entry) return null;
  const context = entry.index.contextAt(position);
  if (!context || context.inComment || !halfOpenContains(context.token?.range, position))
    return null;
  const occurrence = entry.index.lines[position.line]?.occurrences.find(
    (item) =>
      item.start <= position.character &&
      position.character < item.end &&
      ["variable", "macro"].includes(item.namespace) &&
      ["read", "include"].includes(item.role) &&
      !item.wildcard,
  );
  if (occurrence) {
    const snapshot = entry.version;
    const definitions = await project.definitions(uri, position);
    if (definitions.length !== 1 || entry.version !== snapshot) return null;
    const definition = definitions[0];
    if (definition.uri === uri && halfOpenContains(definition.range, position)) return null;
    const views = await project.contextualViews();
    for (const view of views) {
      if (view.uri !== definition.uri) continue;
      const declaration = view.index.declarations.find(
        (item) =>
          item.namespace === occurrence.namespace &&
          JSON.stringify(item.selectionRange || item.range) === JSON.stringify(definition.range),
      );
      if (!declaration) continue;
      const code = declarationPreview(view, declaration);
      if (!code) return null;
      const filename = definition.uri.startsWith("file:")
        ? path.basename(fileURLToPath(definition.uri))
        : "Untitled";
      return {
        contents: {
          kind: "plaintext",
          value: `${code}\n\n${filename}:${definition.range.start.line + 1}`,
        },
        range: {
          start: { line: position.line, character: occurrence.start },
          end: { line: position.line, character: occurrence.end },
        },
      };
    }
    return null;
  }
  if (context.inText) return null;
  const target = entry.target;
  const keywords = target.keywords;
  const schema = schemaFor(keywords, context.module, context.command);
  if (context.role === "command") {
    if (!schema || context.inString || context.token.value.toUpperCase() !== context.command)
      return null;
    const keyLines = [
      ...new Set(
        schema.forms
          .map((form) =>
            [
              ...new Set(
                form.slots
                  .filter((slot) => slot.name && !["placeholder", "reserved"].includes(slot.kind))
                  .map((slot) => slot.name),
              ),
            ].join(", "),
          )
          .filter(Boolean),
      ),
    ];
    if (!keyLines.length) return null;
    return {
      contents: {
        kind: "plaintext",
        value: `${context.module} · ${context.command}\n\n${keyLines.join("\n\n")}`,
      },
      range: context.token.range,
    };
  }
  if (!["param", "value"].includes(context.role)) return null;
  const parameter = parameterName(context);
  if (!schema || !parameter) return null;
  if (context.role === "param" && context.token.value.toUpperCase() !== parameter.toUpperCase())
    return null;
  const slots = matchingForms(schema, context).flatMap((form) =>
    form.slots.filter((slot) => slot.name === parameter.toUpperCase() && slot.kind !== "comment"),
  );
  if (!slots.length) return null;
  const positions = Number.isInteger(context.activeParameter)
    ? [context.activeParameter + 1]
    : [...new Set(slots.map((slot) => slot.position))];
  const values = [...new Set(slots.flatMap((slot) => slot.enumValues || []))];
  if (context.inString && !values.length) return null;
  const heading = `${context.module} · ${context.command} · ${parameter} /${positions.join(",")}`;
  return {
    contents: {
      kind: "plaintext",
      value: values.length ? `${heading}\n\n${values.join(", ")}` : heading,
    },
    range: context.token.range,
  };
}

async function signatureHelp(project, uri, position) {
  const entry = await project.loadDocument(uri);
  if (!entry) return null;
  const context = entry.index.contextAt(position);
  if (!context || context.inComment || context.inText || !context.command) return null;
  const schema = schemaFor(entry.target.keywords, context.module, context.command);
  if (!schema?.forms.length) return null;
  const activeName = parameterName(context)?.toUpperCase();
  const namedParameters = context.record.tokens
    .filter((token) => token.role === "param" && !token.partialParam)
    .map((token) => token.param || token.value.toUpperCase());
  const matchingForm = schema.forms.findIndex((candidate) =>
    namedParameters.every((name) => candidate.slots.some((slot) => slot.name === name)),
  );
  const activeSignature = Math.max(0, matchingForm);
  const form = schema.forms[activeSignature];
  let activeParameter = Number.isInteger(context.activeParameter)
    ? context.activeParameter
    : form.slots.findIndex((slot) => slot.name === activeName);
  if (activeParameter < 0)
    activeParameter = Number.isInteger(context.activeParameter)
      ? context.activeParameter
      : Math.max(0, (context.slot?.position || context.positionIndex || 1) - 1);
  activeParameter = Math.min(activeParameter, Math.max(0, form.slots.length - 1));
  return {
    signatures: schema.forms.map((candidate) => ({
      label: signatureLabel(context.command, candidate),
      parameters: candidate.slots.map((slot) => ({ label: slot.name || "_" })),
    })),
    activeSignature,
    activeParameter,
  };
}

function symbolKind(symbol) {
  if (typeof symbol.kind === "number") return symbol.kind;
  if (symbol.namespace === "variable" || symbol.kind === "variable") return SymbolKind.Variable;
  if (symbol.namespace === "macro" || symbol.kind === "macro") return SymbolKind.Function;
  if (symbol.kind === "program" || symbol.kind === "module") return SymbolKind.Module;
  return SymbolKind.Namespace;
}

function documentSymbols(entry) {
  return entry.index.symbols().map((symbol) => ({
    name: symbol.name,
    detail: symbol.storage || symbol.namespace,
    kind: symbolKind(symbol),
    range: symbol.range,
    selectionRange: symbol.selectionRange || symbol.range,
  }));
}

function workspaceSymbols(project, query) {
  const result = [];
  const search = String(query || "").toLowerCase();
  for (const entry of project.documents.values()) {
    for (const symbol of entry.index.symbols()) {
      if (!symbol.name.toLowerCase().includes(search)) continue;
      result.push({
        name: symbol.name,
        kind: symbolKind(symbol),
        location: { uri: entry.uri, range: symbol.selectionRange || symbol.range },
      });
    }
  }
  return result;
}

function semanticTokens(entry, range) {
  const tokens = entry.index.enumTokens(range).map((token) =>
    token.range
      ? token
      : {
          range: {
            start: { line: token.row, character: token.column },
            end: { line: token.row, character: token.column + token.length },
          },
        },
  );
  tokens.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
  const data = [];
  let previousLine = 0;
  let previousCharacter = 0;
  let previousEnd = -1;
  for (const token of tokens) {
    const { start, end } = token.range;
    if (start.line !== end.line || end.character <= start.character) continue;
    if (start.line === previousLine && start.character < previousEnd) continue;
    data.push(
      start.line - previousLine,
      start.line === previousLine ? start.character - previousCharacter : start.character,
      end.character - start.character,
      0,
      0,
    );
    previousLine = start.line;
    previousCharacter = start.character;
    previousEnd = end.character;
  }
  return { data };
}

module.exports = {
  completion,
  hover,
  signatureHelp,
  documentSymbols,
  workspaceSymbols,
  semanticTokens,
  schemaFor,
};
