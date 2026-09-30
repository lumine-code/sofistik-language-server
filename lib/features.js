const { CompletionItemKind, SymbolKind } = require("vscode-languageserver/node");

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

function currentWord(context) {
  return String(context.token?.text || context.token?.value || context.prefix || "");
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
  const keywords = project.targetFor(entry.text).keywords;
  const prefix = wordPrefix(context);
  const normalizedPrefix = prefix.replace(/^#|^\$\(/, "").toUpperCase();
  const format = (word) =>
    project.settings.textCase === "lower" ? word.toLowerCase() : word.toUpperCase();
  const candidates = [];
  const add = (label, kind, detail, insertText = format(label)) => {
    if (!label.toUpperCase().startsWith(normalizedPrefix)) return;
    candidates.push({
      label: format(label),
      kind,
      detail,
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
  const unique = new Map();
  for (const item of candidates) unique.set(`${item.kind}:${item.label}`, item);
  return [...unique.values()].sort(
    (a, b) =>
      (a.kind === CompletionItemKind.EnumMember ? -1 : 0) -
        (b.kind === CompletionItemKind.EnumMember ? -1 : 0) || a.label.localeCompare(b.label),
  );
}

async function hover(project, uri, position) {
  const entry = await project.loadDocument(uri);
  if (!entry) return null;
  const context = entry.index.contextAt(position);
  if (!context || context.inComment) return null;
  const target = project.targetFor(entry.text);
  const word = currentWord(context);
  const keywords = target.keywords;
  let value;
  if (context.role === "variable" || context.role === "macro") {
    const definitions = await project.definitions(uri, position);
    value = `**${word}**\n\n${context.role === "macro" ? "Preprocessor macro" : "CADINP variable"}. ${definitions.length} source definition${definitions.length === 1 ? "" : "s"} found.`;
  } else if (context.role === "module" && keywords) {
    const count = keywords.getModuleCommands(word).length;
    if (count)
      value = `**${word.toUpperCase()}**\n\nSOFiSTiK ${target.version} (${target.language.toUpperCase()}): ${count} catalogued records.`;
  } else if (context.command && keywords) {
    const schema = schemaFor(keywords, context.module, context.command);
    if (!schema) return null;
    const parameter = parameterName(context);
    if (parameter && context.role !== "command") {
      const slots = slotsFor(schema, context);
      if (!slots.length) return null;
      const values = [...new Set(slots.flatMap((slot) => slot.enumValues || []))];
      const typeCodes = [...new Set(slots.map((slot) => slot.dataTypeCode).filter(Boolean))];
      value = `**${context.module} · ${context.command} · ${parameter}**\n\nSlot${slots.length === 1 ? "" : "s"}: ${[...new Set(slots.map((slot) => slot.position))].join(", ")}.`;
      if (values.length)
        value += `\n\nCatalogue values: ${values.slice(0, 30).join(", ")}${values.length > 30 ? ", …" : ""}.`;
      if (typeCodes.length) value += `\n\nCatalogue type codes: ${typeCodes.join(", ")}.`;
    } else {
      value = `**${context.module} · ${context.command}**\n\n\`\`\`text\n${schema.forms.map((form) => signatureLabel(context.command, form)).join("\n")}\n\`\`\``;
    }
    value += `\n\nSOFiSTiK ${target.version}, ${target.language.toUpperCase()}.`;
  }
  return value ? { contents: { kind: "markdown", value }, range: context.token?.range } : null;
}

async function signatureHelp(project, uri, position) {
  const entry = await project.loadDocument(uri);
  if (!entry) return null;
  const context = entry.index.contextAt(position);
  if (!context || context.inComment || context.inText || !context.command) return null;
  const schema = schemaFor(project.targetFor(entry.text).keywords, context.module, context.command);
  if (!schema?.forms.length) return null;
  const activeName = parameterName(context)?.toUpperCase();
  const namedParameters = context.record.tokens
    .filter((token) => token.role === "param")
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
