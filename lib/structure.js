function documentStructure(entry) {
  const lines = entry.index.lines;
  const declarations = entry.index.symbols();
  const position = (line, character) => ({ line, character });
  const compare = (left, right) => left.line - right.line || left.character - right.character;
  const eof = position(lines.length - 1, lines.at(-1).text.length);
  const items = [];
  const fromDeclaration = (symbol) => ({
    name: symbol.name,
    detail: symbol.storage || symbol.namespace,
    kind: symbol.namespace || symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange || symbol.range,
  });
  const modules = new Map(
    declarations
      .filter((symbol) => symbol.namespace === "module")
      .map((symbol) => [
        `${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`,
        symbol,
      ]),
  );
  for (const declaration of declarations) {
    if (declaration.namespace !== "module")
      items.push({ symbol: fromDeclaration(declaration), container: false });
  }

  let program = null;
  let completed = false;
  let command = null;
  const endOfRecord = (line, record) => {
    const text = lines[line].text;
    if (text[record.end] === ";") return position(line, record.end + 1);
    return record.end === text.length && line < lines.length - 1
      ? position(line + 1, 0)
      : position(line, record.end);
  };
  for (let line = 0; line < lines.length; line++) {
    for (const record of lines[line].records) {
      const tokens = record.tokens.filter(
        (token) => !["comment", "continuation"].includes(token.type),
      );
      const first = tokens[0];
      if (!first) continue;
      const start = position(line, first.start);
      const end = endOfRecord(line, record);
      if (["program", "root"].includes(record.kind)) {
        // A missing or commented header is still a scope boundary. It must not
        // attach subsequent commands to the preceding visible program.
        if (program && !completed) program.range.end = start;
        program = null;
        command = null;
        completed = false;
        const moduleToken = tokens.find((token) => token.role === "module");
        const declaration = moduleToken && modules.get(`${line}:${moduleToken.start}`);
        if (record.kind === "program" && !first.value.startsWith("$") && declaration) {
          program = fromDeclaration(declaration);
          program.range = { start, end: eof };
          items.push({ symbol: program, container: true });
        }
        continue;
      }
      if (program && completed) program.range.end = end;
      if (record.kind === "end") {
        if (program) program.range.end = end;
        completed = true;
        command = null;
        continue;
      }
      if (first.role === "command" && !record.continuedFromPrevious) {
        command = {
          name: first.value.toUpperCase(),
          kind: "command",
          range: { start, end },
          selectionRange: { start, end: position(line, first.end) },
        };
        items.push({ symbol: command, container: true });
        continue;
      }
      const codeRecord = record.kind === "record" && tokens.every((token) => token.mode === "code");
      const auxiliary =
        record.kind === "variable" ||
        (record.kind === "preprocessor" &&
          !["#IF", "#ELSEIF", "#ELSE", "#ENDIF"].includes(first.value.toUpperCase()));
      const legacyText = record.kind === "text" && ["TXAB", "TXBB", "TXEB"].includes(command?.name);
      if (command && (codeRecord || auxiliary || legacyText)) command.range.end = end;
      else command = null;
    }
  }

  // Only programs and commands can contain declarations. A GETN output's
  // statement range can equal its command range; variables remain peer leaves.
  items.sort(
    (left, right) =>
      compare(left.symbol.range.start, right.symbol.range.start) ||
      compare(right.symbol.range.end, left.symbol.range.end) ||
      Number(right.container) - Number(left.container),
  );
  const roots = [];
  const containers = [];
  for (const { symbol, container } of items) {
    while (
      containers.length &&
      (compare(containers.at(-1).range.start, symbol.range.start) > 0 ||
        compare(containers.at(-1).range.end, symbol.range.end) < 0)
    )
      containers.pop();
    const parent = containers.at(-1);
    if (parent) (parent.children ??= []).push(symbol);
    else roots.push(symbol);
    if (container) containers.push(symbol);
  }
  return roots;
}

module.exports = { documentStructure };
