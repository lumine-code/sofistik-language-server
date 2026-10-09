const { SchemaResolver, upper } = require("./schema-resolver");
const {
  scanLine,
  initialState,
  clone,
  sameState,
  lastStartAt,
  compare,
  contains,
  range,
} = require("./lexer");

const flattenItems = (items, line) =>
  items.map((item) => ({
    ...item,
    range: range(line, item.start, item.end),
    selectionRange: range(line, item.start, item.end),
    ...(item.symbolStart === undefined
      ? {}
      : { range: range(line, item.symbolStart, item.symbolEnd) }),
    line,
  }));

function applyTextChanges(text, changes) {
  // LSP ranges apply sequentially to the immediately preceding snapshot.
  for (const change of changes) {
    if (!change.range) text = change.text;
    else {
      const offsets = [];
      for (const position of [change.range.start, change.range.end]) {
        let offset = 0;
        for (let line = 0; line < position.line; line++) {
          const next = text.indexOf("\n", offset);
          if (next < 0) {
            offset = text.length;
            break;
          }
          offset = next + 1;
        }
        offsets.push(offset + position.character);
      }
      text = text.slice(0, offsets[0]) + change.text + text.slice(offsets[1]);
    }
  }
  return text;
}

class FinderIndex {
  constructor(text, target = {}) {
    this.target = target;
    this.resolver = new SchemaResolver(target.keywords);
    this.documentVersion = 0;
    this.metrics = { scannedLines: 0, reusedLines: 0, updateCount: 0 };
    this._cache = new Map();
    this._scan(String(text ?? ""), null);
  }

  _scan(text, previous) {
    this.text = text;
    const lines = text.split(/\r?\n/);
    let prefix = 0;
    let suffix = 0;
    if (previous) {
      while (
        prefix < lines.length &&
        prefix < previous.length &&
        lines[prefix] === previous[prefix].text
      )
        prefix++;
      while (
        suffix < lines.length - prefix &&
        suffix < previous.length - prefix &&
        lines.at(-1 - suffix) === previous.at(-1 - suffix).text
      )
        suffix++;
      // A changed newline or continuation can change the preceding logical record.
      prefix = Math.max(0, prefix - 1);
      while (prefix > 0 && previous[prefix - 1].endState.continued) prefix--;
    }
    const entries = previous ? previous.slice(0, prefix) : [];
    let state = prefix ? clone(entries.at(-1).endState) : initialState(this.target);
    let scanned = 0;
    let reused = prefix;
    for (let line = prefix; line < lines.length; line++) {
      const oldLine = line - (lines.length - (previous?.length ?? 0));
      if (
        previous &&
        line >= lines.length - suffix &&
        oldLine >= 0 &&
        sameState(state, previous[oldLine].startState)
      ) {
        for (let reusedLine = oldLine; reusedLine < previous.length; reusedLine++)
          entries.push(previous[reusedLine]);
        reused += previous.length - oldLine;
        break;
      }
      const entry = scanLine(lines[line], state, this.resolver);
      entries.push(entry);
      state = entry.endState;
      scanned++;
    }
    this.lines = entries;
    this._cache.clear();
    this.metrics = {
      scannedLines: scanned,
      reusedLines: reused,
      updateCount: this.metrics.updateCount + (previous ? 1 : 0),
    };
  }

  offsetAt(position) {
    const line = Math.max(0, Math.min(position.line, this.lines.length - 1));
    let offset = 0;
    let count = 0;
    while (count < line) {
      const next = this.text.indexOf("\n", offset);
      if (next < 0) break;
      offset = next + 1;
      count++;
    }
    return offset + Math.min(Math.max(0, position.character), this.lines[line].text.length);
  }

  applyChanges(changes, documentVersion, text = applyTextChanges(this.text, changes)) {
    this.documentVersion = documentVersion ?? this.documentVersion + 1;
    this._scan(text, this.lines);
    return this;
  }

  _flatten(key) {
    if (!this._cache.has(key)) {
      const result = this.lines.flatMap((entry, line) => flattenItems(entry[key], line));
      this._cache.set(key, result);
    }
    return this._cache.get(key);
  }

  get records() {
    return this._flatten("records");
  }
  get declarations() {
    return this._flatten("declarations");
  }
  get occurrences() {
    return this._flatten("occurrences");
  }
  get diagnostics() {
    return this._flatten("diagnostics").map((item) => ({
      ...item,
      severity: 2,
      source: "sofistik",
      message: item.message,
    }));
  }

  contextAt(position) {
    const entry = this.lines[position.line];
    if (!entry)
      return {
        module: null,
        command: null,
        role: "command",
        prefix: "",
        forms: [],
        confidence: false,
      };
    const record =
      entry.records[lastStartAt(entry.records, position.character)] ?? entry.records.at(-1);
    const tokens = record?.tokens ?? [];
    const tokenIndex = lastStartAt(tokens, position.character);
    let token = tokens[tokenIndex]?.end >= position.character ? tokens[tokenIndex] : null;
    let previous;
    for (let index = tokenIndex; index >= 0; index--) {
      if (
        tokens[index].end <= position.character &&
        !["comment", "continuation"].includes(tokens[index].type)
      ) {
        previous = tokens[index];
        break;
      }
    }
    const context = record?.context ?? { ...entry.endState, forms: [], confidence: false };
    const embedded =
      token?.type === "string"
        ? entry.occurrences.find(
            (item) =>
              item.namespace === "macro" &&
              item.start <= position.character &&
              position.character <= item.end,
          )
        : null;
    if (embedded)
      token = {
        type: "macro",
        start: embedded.start - 2,
        end: embedded.end + 1,
        value: entry.text.slice(embedded.start - 2, embedded.end + 1),
        nameStart: embedded.start,
        nameEnd: embedded.end,
        mode: token.mode,
      };
    const prefix =
      token && token.type !== "comma"
        ? entry.text.slice(
            token.nameStart ?? token.literalStart ?? token.start,
            Math.min(position.character, token.literalEnd ?? token.nameEnd ?? token.end),
          )
        : "";
    const inComment = token?.type === "comment" || token?.type === "continuation";
    const inString = token?.type === "string";
    const inText =
      token?.mode === "text" ||
      token?.mode === "text-header" ||
      ["text", "text-header", "legacy"].includes(context.mode) ||
      (context.implicitText && token?.role !== "command") ||
      record?.kind === "text";
    let role =
      token?.type === "macro" ? "macro" : token?.type === "variable" ? "variable" : token?.role;
    if (inComment) role = "comment";
    else if (inText && !["macro", "variable"].includes(role)) role = "text";
    else if (record?.kind === "program" && (!token || token.role === "module")) role = "module";
    else if (!role) {
      const first = tokens.find((item) => !["comment", "continuation"].includes(item.type));
      if (!first && record?.continuedFromPrevious && context.command)
        role =
          record.before.continuationAwaitingValue || record.before.continuationListValue
            ? "value"
            : "param";
      else if (!first || (first === token && record?.kind === "record" && token.type === "word"))
        role = "command";
      else
        role =
          (previous?.role === "param" && !previous.partialParam && !record.tableDefinition) ||
          (previous?.type === "equals" && previous.param) ||
          (previous?.type === "comma" && previous.depth === 0)
            ? "value"
            : context.command
              ? "param"
              : "value";
    }
    const assignment = token?.param !== undefined ? token : previous;
    const inheritedParam =
      !previous && record?.continuedFromPrevious ? record.before.continuationParam : null;
    const param = token?.partialParam
      ? token.param
      : assignment?.param !== undefined
        ? assignment.param
        : (inheritedParam ?? record?.param ?? null);
    const activeParameter = token?.partialParam
      ? token.activeParameter
      : assignment?.activeParameter !== undefined
        ? assignment.activeParameter
        : (record?.activeParameter ??
          (record?.continuedFromPrevious && !record.before.continuationAwaitingValue
            ? record.before.continuationValuePosition
            : null) ??
          (param
            ? this.resolver.slotFor(this.resolver.lookup(context.module, context.command), param, 0)
                ?.activeParameter
            : null) ??
          null);
    return {
      ...context,
      role,
      token: token ? { ...token, range: range(position.line, token.start, token.end) } : null,
      prefix,
      record: record ? { ...record, range: range(position.line, record.start, record.end) } : null,
      param,
      activeParameter,
      ...(token?.partialParam
        ? { partialParam: true, paramCandidates: token.paramCandidates }
        : {}),
      inComment,
      inString,
      inText,
    };
  }

  symbols() {
    const seen = new Set();
    return this.declarations.filter((item) => {
      const key = `${item.namespace}:${item.scopeId}:${item.canonicalName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  occurrenceAt(position) {
    return (
      [...this.declarations, ...this.occurrences].find((item) =>
        contains(item.selectionRange, position),
      ) ?? null
    );
  }

  definitionsAt(position) {
    const occurrence = this.occurrenceAt(position);
    if (!occurrence) return [];
    if (occurrence.wildcard) return [];
    return this.declarations.filter(
      (item) =>
        item.namespace === occurrence.namespace &&
        item.canonicalName === occurrence.canonicalName &&
        (item.namespace === "macro" ||
          item.scopeId === occurrence.scopeId ||
          item.storage === "persistent") &&
        compare(item.selectionRange.start, position) <= 0,
    );
  }

  referencesAt(position) {
    const occurrence = this.occurrenceAt(position);
    if (!occurrence) return [];
    return this.occurrences.filter(
      (item) =>
        !item.wildcard &&
        item.namespace === occurrence.namespace &&
        item.canonicalName === occurrence.canonicalName &&
        (item.namespace === "macro" ||
          item.scopeId === occurrence.scopeId ||
          occurrence.storage === "persistent"),
    );
  }

  includes() {
    return this._flatten("includes");
  }

  enumTokens(requestedRange) {
    const result = [];
    const firstLine = Math.max(0, requestedRange?.start.line ?? 0);
    const lastLine = Math.min(
      this.lines.length - 1,
      requestedRange?.end.line ?? this.lines.length - 1,
    );
    for (let line = firstLine; line <= lastLine; line++) {
      for (const record of this.lines[line].records) {
        for (const token of record.tokens) {
          if (
            token.role !== "value" ||
            !token.param ||
            token.ambiguous ||
            token.dynamic ||
            token.incomplete ||
            token.depth > 0 ||
            token.type !== "word"
          )
            continue;
          const literal = token.value;
          const info = this.resolver.lookup(record.context.module, record.context.command);
          if (
            !this.resolver.enums(info, token.param).some((value) => upper(value) === upper(literal))
          )
            continue;
          const tokenRange = range(line, token.start, token.end);
          if (
            requestedRange &&
            (compare(tokenRange.end, requestedRange.start) <= 0 ||
              compare(tokenRange.start, requestedRange.end) >= 0)
          )
            continue;
          result.push({
            range: tokenRange,
            type: "enumMember",
            value: literal,
            module: record.context.module,
            command: record.context.command,
            param: token.param,
          });
        }
      }
    }
    return result;
  }
}

const createIndex = (text, target) => new FinderIndex(text, target);

// Closed files need navigation facts, not editable token and state snapshots.
// Retain only those facts; occasional lexical queries build a temporary index.
class NavigationIndex {
  constructor(text, target = {}) {
    this.text = String(text ?? "");
    this.target = target;
    this.resolver = new SchemaResolver(target.keywords);
    this.documentVersion = 0;
    this._declarations = [];
    this._occurrences = [];
    this._includes = [];
    this._diagnostics = [];
    const lines = this.text.split(/\r?\n/);
    let state = initialState(target);
    for (let line = 0; line < lines.length; line++) {
      const entry = scanLine(lines[line], state, this.resolver);
      state = entry.endState;
      for (const item of flattenItems(entry.declarations, line)) this._declarations.push(item);
      for (const item of flattenItems(entry.occurrences, line)) this._occurrences.push(item);
      for (const item of flattenItems(entry.includes, line)) this._includes.push(item);
      for (const item of flattenItems(entry.diagnostics, line)) this._diagnostics.push(item);
    }
    this.metrics = { scannedLines: lines.length, reusedLines: 0, updateCount: 0 };
  }

  get declarations() {
    return this._declarations;
  }
  get occurrences() {
    return this._occurrences;
  }
  get diagnostics() {
    return this._diagnostics.map((item) => ({ ...item, severity: 2, source: "sofistik" }));
  }
  get records() {
    return createIndex(this.text, this.target).records;
  }
  get lines() {
    return createIndex(this.text, this.target).lines;
  }
  includes() {
    return this._includes;
  }
  symbols() {
    return FinderIndex.prototype.symbols.call(this);
  }
  occurrenceAt(position) {
    return FinderIndex.prototype.occurrenceAt.call(this, position);
  }
  definitionsAt(position) {
    return FinderIndex.prototype.definitionsAt.call(this, position);
  }
  referencesAt(position) {
    return FinderIndex.prototype.referencesAt.call(this, position);
  }
  contextAt(position) {
    return createIndex(this.text, this.target).contextAt(position);
  }
  enumTokens(requestedRange) {
    return createIndex(this.text, this.target).enumTokens(requestedRange);
  }
  offsetAt(position) {
    const lines = this.text.split(/\r?\n/);
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    let offset = 0;
    for (let count = 0; count < line; count++) offset = this.text.indexOf("\n", offset) + 1;
    return offset + Math.min(Math.max(0, position.character), lines[line].length);
  }
  applyChanges(changes, documentVersion) {
    const updated = new NavigationIndex(applyTextChanges(this.text, changes), this.target);
    updated.documentVersion = documentVersion ?? this.documentVersion + 1;
    updated.metrics.updateCount = this.metrics.updateCount + 1;
    Object.assign(this, updated);
    return this;
  }
}

const createNavigationIndex = (text, target) => new NavigationIndex(text, target);

module.exports = {
  createIndex,
  createNavigationIndex,
  applyTextChanges,
  FinderIndex,
  NavigationIndex,
};
