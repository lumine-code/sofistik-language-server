"use strict";

const { upper } = require("./schema-resolver");

const VARIABLES = new Set(["LET", "STO", "RCL", "DEL", "PRT", "DBG"]);
const PREPROCESSOR = new Set([
  "DEFINE",
  "ENDDEF",
  "IF",
  "ELSEIF",
  "ELSE",
  "ENDIF",
  "INCLUDE",
  "UNDEF",
]);
const ROOT = /^(?:[+\-$]?)PROG$/i;
const TEXT_OPEN = /^<TEXT(?=[>, \t]|$)/i;
const TEXT_CLOSE = /^<[/\\]TEXT>/i;
const PICTURE = /^<\/?PICT>/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*|^\d+/;
const MACRO_NAME = /^[#]?[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const FUNCTIONS = new Set([
  "ABS",
  "ACOS",
  "ASIN",
  "ATAN",
  "ATAN2",
  "COS",
  "COSH",
  "EXP",
  "INT",
  "KWH",
  "KWL",
  "LIT",
  "LOG",
  "LOG10",
  "MAX",
  "MIN",
  "MOD",
  "ROUND",
  "SIGN",
  "SIN",
  "SINH",
  "SQR",
  "SQRT",
  "TAN",
  "TANH",
  "TRUNC",
]);

const point = (line, character) => ({ line, character });
const range = (line, start, end) => ({ start: point(line, start), end: point(line, end) });
const compare = (a, b) => a.line - b.line || a.character - b.character;
const contains = (r, p) => compare(r.start, p) <= 0 && compare(p, r.end) <= 0;
// Line snapshots share immutable stack tails. Copying the whole nesting stack
// for every line makes unfinished or deeply nested input consume quadratic memory.
const STACKS = Symbol("lexicalStacks");
const pushStack = (parent, value) => {
  let hash = parent?.hash ?? 2166136261;
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  hash = Math.imul(hash ^ 0xffff, 16777619);
  return { value, parent, length: (parent?.length ?? 0) + 1, hash };
};
const stackFrom = (values) => values.reduce((parent, value) => pushStack(parent, value), null);
const stackFor = (state, name) => (state[STACKS] ? state[STACKS][name] : stackFrom(state[name]));
const stackValues = (stack) => {
  const values = new Array(stack?.length ?? 0);
  for (let node = stack; node; node = node.parent) values[node.length - 1] = node.value;
  return values;
};
const stackProperties = {
  macros: {
    enumerable: true,
    get() {
      return stackValues(this[STACKS].macros);
    },
  },
  controls: {
    enumerable: true,
    get() {
      return stackValues(this[STACKS].controls);
    },
  },
};
const clone = (state) => {
  const snapshot = {};
  for (const key of Object.keys(state)) {
    if (key !== "macros" && key !== "controls") snapshot[key] = state[key];
  }
  snapshot.tableHeader = state.tableHeader?.slice() ?? null;
  snapshot.continuationUsedParams = state.continuationUsedParams.slice();
  Object.defineProperty(snapshot, STACKS, {
    value: { macros: stackFor(state, "macros"), controls: stackFor(state, "controls") },
  });
  // Keep the exported scanLine snapshots' array shape, materializing it only
  // when an external caller reads a stack rather than while indexing.
  Object.defineProperties(snapshot, stackProperties);
  return snapshot;
};
const sameStack = (left, right) => {
  // A fingerprint rejects different deep stacks without walking them on every
  // suffix line. Equal fingerprints still need an exact comparison.
  if ((left?.length ?? 0) !== (right?.length ?? 0) || (left?.hash ?? 0) !== (right?.hash ?? 0))
    return false;
  while (left !== right) {
    if (!left || !right || left.value !== right.value) return false;
    left = left.parent;
    right = right.parent;
  }
  return true;
};
const sameState = (left, right) => {
  for (const key of Object.keys(left)) {
    if (key === "macros" || key === "controls") continue;
    const before = left[key];
    const after = right[key];
    if (Array.isArray(before)) {
      if (
        !Array.isArray(after) ||
        before.length !== after.length ||
        before.some((value, index) => value !== after[index])
      )
        return false;
    } else if (before !== after) return false;
  }
  return (
    sameStack(stackFor(left, "macros"), stackFor(right, "macros")) &&
    sameStack(stackFor(left, "controls"), stackFor(right, "controls"))
  );
};
const stackTop = (state, name) => stackFor(state, name)?.value ?? null;
const pushStateStack = (state, name, value) => {
  state[STACKS][name] = pushStack(stackFor(state, name), value);
};
const popStateStack = (state, name) => {
  state[STACKS][name] = stackFor(state, name)?.parent ?? null;
};
function lastStartAt(items, character) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].start <= character) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function initialState(target) {
  return {
    module: target.module ? upper(target.module) : null,
    command: target.command ? upper(target.command) : null,
    scopeId: target.scopeId ?? "document:0",
    scopePrefix: target.scopePrefix ?? target.uri ?? "document",
    scopeCounter: 0,
    segmentCounter: 0,
    tableHeader: null,
    mode: "code",
    continued: false,
    continuationParam: null,
    continuationAwaitingValue: false,
    continuationListValue: false,
    continuationValuePosition: null,
    continuationUsedParams: [],
    continuationPosition: 0,
    depth: 0,
    macros: [],
    macroCounter: 0,
    controls: [],
    pictureDepth: 0,
  };
}

// Tokens retain line-relative UTF-16 offsets, so inserting lines does not
// rewrite every token in the unchanged suffix.
function scanLine(text, incoming, resolver) {
  const state = clone(incoming);
  const records = [];
  const occurrences = [];
  const declarations = [];
  const includeEntries = [];
  const diagnostics = [];
  const tokens = [];
  let fragment = [];
  let fragmentStart = 0;
  let fragmentState = clone(state);
  let atHead = !state.continued;
  let defineValue = false;
  let defining = false;
  let conditionValue = false;
  let depth = state.continued ? state.depth : 0;
  let continued = false;
  const emit = (type, start, end, extra = {}) => {
    const token = {
      type,
      start,
      end,
      value: text.slice(start, end),
      depth,
      mode: state.mode,
      ...extra,
    };
    tokens.push(token);
    fragment.push(token);
    return token;
  };
  const addOccurrence = (token, namespace, role = "read", extra = {}) => {
    const prefix = namespace === "macro" ? 2 : 1;
    const start = token.nameStart ?? token.start + prefix;
    const end = token.nameEnd ?? token.end;
    const name = text.slice(start, end);
    if (!name || token.incomplete) return;
    occurrences.push({
      name,
      canonicalName: upper(name),
      namespace,
      role,
      start,
      end,
      scopeId: state.scopeId,
      macro: stackTop(state, "macros"),
      storage: "local",
      ...extra,
    });
  };
  const macroInString = (start, end) => {
    let index = start;
    while (index < end) {
      const open = text.indexOf("$(", index);
      if (open < 0 || open >= end) break;
      const close = text.indexOf(")", open + 2);
      if (close < 0 || close >= end) break;
      addOccurrence(
        { start: open, end: close, nameStart: open + 2, nameEnd: close },
        "macro",
        "read",
        { scopeId: "preprocessor", storage: "macro" },
      );
      index = close + 1;
    }
  };
  const finish = (end, joinsNext = false) => {
    const meaningful = fragment.filter(
      (token) => !["comment", "continuation"].includes(token.type),
    );
    const first = meaningful[0];
    const name = upper(first?.value);
    let kind = "record";
    let commandOffset = 0;
    let resolution = { info: null, assignments: [], confidence: false };
    if (first && ["code", "legacy"].includes(first.mode) && atHead) {
      if (ROOT.test(name)) {
        kind = "program";
        state.module = meaningful[1]?.value ? upper(meaningful[1].value) : null;
        state.command = null;
        state.tableHeader = null;
        state.continuationParam = null;
        state.continuationPosition = 0;
        state.scopeCounter++;
        state.segmentCounter = 0;
        state.scopeId = `${state.scopePrefix}:program:${state.scopeCounter}:0`;
        state[STACKS].controls = null;
        const moduleToken = meaningful[1];
        if (moduleToken) {
          moduleToken.role = "module";
          declarations.push({
            name: state.module,
            canonicalName: state.module,
            namespace: "module",
            kind: 2,
            role: "definition",
            start: moduleToken.start,
            end: moduleToken.end,
            symbolStart: first.start,
            symbolEnd: end,
            scopeId: state.scopeId,
            storage: "local",
          });
        }
        first.role = "keyword";
      } else if (["END", "ENDE"].includes(name)) {
        kind = "end";
        state.command = null;
        state.tableHeader = null;
        state.continuationParam = null;
        state.continuationPosition = 0;
        state.segmentCounter++;
        state.scopeId = `${state.scopePrefix}:program:${state.scopeCounter}:${state.segmentCounter}`;
        if (state.mode === "legacy") state.mode = "code";
      } else if (/^[+$-]?APPLY$|^[+-]?SYS$/.test(name)) {
        kind = "root";
        state.module = null;
        state.command = null;
        state.tableHeader = null;
      } else if (first.type === "preprocessor") {
        kind = "preprocessor";
        const directive = name.slice(1);
        const argument = meaningful[1];
        if (directive === "DEFINE" && argument) {
          const macroName = argument.value.replace(/^#/, "");
          if (MACRO_NAME.test(argument.value)) {
            const declaration = {
              name: macroName,
              canonicalName: upper(macroName),
              namespace: "macro",
              kind: 12,
              role: "definition",
              start: argument.start + (argument.value.startsWith("#") ? 1 : 0),
              end: argument.end,
              symbolStart: first.start,
              symbolEnd: end,
              scopeId: "preprocessor",
              storage: "macro",
            };
            declarations.push(declaration);
            const found = occurrences.find(
              (item) => item.start === declaration.start && item.end === declaration.end,
            );
            if (found) occurrences.splice(occurrences.indexOf(found), 1);
            occurrences.push({ ...declaration, symbolStart: undefined, symbolEnd: undefined });
            if (!meaningful.some((token) => token.type === "equals"))
              pushStateStack(state, "macros", `${upper(macroName)}:${++state.macroCounter}`);
            argument.role = "macro";
          }
        } else if (directive === "ENDDEF") {
          if (stackFor(state, "macros")) popStateStack(state, "macros");
          else if (resolver.moduleNames().includes(state.module))
            diagnostics.push({
              start: first.start,
              end: first.end,
              message: "#ENDDEF has no matching #DEFINE.",
              code: "orphan-enddef",
            });
        } else if (directive === "INCLUDE" && argument) {
          const args = meaningful.slice(1);
          const raw = text.slice(argument.start, args.at(-1).end).trim();
          const literal =
            args.length === 1 &&
            ["word", "string"].includes(argument.type) &&
            !argument.dynamic &&
            !argument.incomplete;
          includeEntries.push({
            name: argument.literal ?? raw,
            argument: raw,
            start: argument.start,
            end: args.at(-1).end,
            kind: literal
              ? argument.type === "string" || /[\\/.]/.test(raw)
                ? "static"
                : "macro"
              : "dynamic",
            scopeId: state.scopeId,
            module: state.module,
            command: state.command,
          });
          if (literal && argument.type === "word") {
            occurrences.push({
              name: raw,
              canonicalName: upper(raw),
              namespace: "macro",
              role: "include",
              start: argument.start,
              end: argument.end,
              scopeId: "preprocessor",
              storage: "macro",
            });
          }
        } else if (directive === "UNDEF" && argument) {
          const found = occurrences.find(
            (item) => item.start === argument.nameStart && item.end === argument.nameEnd,
          );
          if (found) occurrences.splice(occurrences.indexOf(found), 1);
          occurrences.push({
            name: argument.value.replace(/^#/, ""),
            canonicalName: upper(argument.value.replace(/^#/, "")),
            namespace: "macro",
            role: "undef",
            start: argument.start + (argument.value.startsWith("#") ? 1 : 0),
            end: argument.end,
            scopeId: "preprocessor",
            storage: "macro",
          });
        }
      } else if (["@KEY", "@CDB"].includes(name)) {
        kind = "cdb";
      } else if (VARIABLES.has(name) && meaningful[1]?.type === "variable") {
        kind = "variable";
        const token = meaningful[1];
        const occurrence = occurrences.find(
          (item) => item.start === token.nameStart && item.end === token.nameEnd,
        );
        let valueStart = 2;
        if (meaningful[valueStart]?.value === "(" && meaningful[valueStart].start === token.end) {
          valueStart++;
          while (
            valueStart < meaningful.length &&
            !(meaningful[valueStart].value === ")" && meaningful[valueStart].depth === 0)
          )
            valueStart++;
          valueStart++;
        }
        const assigns = name === "LET" || (name === "STO" && meaningful.length > valueStart);
        const storage = name === "STO" ? "persistent" : name === "RCL" ? "external" : "local";
        if (occurrence)
          Object.assign(occurrence, {
            role: assigns
              ? "write"
              : name === "RCL"
                ? "import"
                : name === "DEL"
                  ? "delete"
                  : "read",
            storage,
            wildcard:
              name === "DEL" &&
              /[*?]/.test(text.slice(token.end, meaningful[valueStart]?.end ?? token.end)),
          });
        if (assigns)
          declarations.push({
            name: token.value.slice(1),
            canonicalName: upper(token.value.slice(1)),
            namespace: "variable",
            kind: 13,
            role: "definition",
            start: token.nameStart,
            end: token.nameEnd,
            symbolStart: first.start,
            symbolEnd: end,
            scopeId: state.scopeId,
            storage,
            macro: stackTop(state, "macros"),
          });
      } else if (name === "LOOP" || name === "IF") {
        kind = "control";
        pushStateStack(state, "controls", name);
        if (
          name === "LOOP" &&
          meaningful[1]?.type === "variable" &&
          meaningful[1].start === first.end
        ) {
          const token = meaningful[1];
          const occurrence = occurrences.find((item) => item.start === token.nameStart);
          if (occurrence) occurrence.role = "write";
          declarations.push({
            name: token.value.slice(1),
            canonicalName: upper(token.value.slice(1)),
            namespace: "variable",
            kind: 13,
            role: "definition",
            start: token.nameStart,
            end: token.nameEnd,
            symbolStart: first.start,
            symbolEnd: end,
            scopeId: state.scopeId,
            storage: "local",
            macro: stackTop(state, "macros"),
          });
        }
      } else if (["ENDLOOP", "ENDIF", "ELSE", "ELSEIF"].includes(name)) {
        kind = "control";
        const expected = name === "ENDLOOP" ? "LOOP" : "IF";
        if (stackTop(state, "controls") === expected) {
          if (name.startsWith("END")) popStateStack(state, "controls");
        } else if (resolver.moduleNames().includes(state.module))
          diagnostics.push({
            start: first.start,
            end: first.end,
            message: `${name} has no matching ${expected}.`,
            code: "orphan-control",
          });
      } else if (first.type === "picture") {
        kind = "picture";
        state.pictureDepth = Math.max(0, state.pictureDepth + (name.startsWith("</") ? -1 : 1));
      } else if (state.mode === "legacy" && name !== "TXEN") {
        kind = "text";
      } else if (["TXAB", "TXBB", "TXEB"].includes(name)) {
        kind = "text";
        state.command = name;
        state.mode = "legacy";
        first.role = "command";
      } else if (
        !(meaningful[1]?.type === "comma" && meaningful[1].depth === 0) &&
        resolver.lookup(state.module, name)
      ) {
        state.command = name;
        state.tableHeader = null;
        state.continuationParam = null;
        state.continuationPosition = 0;
        commandOffset = 1;
        first.role = "command";
        kind = "command";
        if (["TXAB", "TXBB", "TXEB"].includes(name)) state.mode = "legacy";
        if (name === "TXEN") state.mode = "code";
      }
    }
    if (
      ["record", "command"].includes(kind) &&
      meaningful.every((token) => token.mode === "code")
    ) {
      resolution = resolver.resolve(meaningful, state, commandOffset);
      for (const { token, ...assignment } of resolution.assignments)
        Object.assign(token, assignment);
      if (resolution.tableHeader) state.tableHeader = resolution.tableHeader;
    }
    if (
      first &&
      !["text", "text-header", "legacy"].includes(first.mode) &&
      kind !== "preprocessor"
    ) {
      // CADINP permits bare variable identifiers after a leading equals sign.
      // A tokenizer is sufficient here; it does not evaluate the expression.
      let math = false;
      for (let index = 1; index < meaningful.length; index++) {
        const token = meaningful[index];
        if (token.type === "equals") {
          const previousToken = meaningful[index - 1];
          math =
            kind === "variable" ||
            (previousToken?.role !== "param" && previousToken?.end !== token.start);
          continue;
        }
        if (token.role === "param") math = false;
        if (!math || token.type !== "word" || token.value.startsWith("@")) continue;
        for (const match of token.value.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const variableName = match[1];
          if (FUNCTIONS.has(upper(variableName))) continue;
          const start = token.start + match.index + match[0].length - variableName.length;
          occurrences.push({
            name: variableName,
            canonicalName: upper(variableName),
            namespace: "variable",
            role: "read",
            syntax: "bare-expression",
            start,
            end: start + variableName.length,
            scopeId: state.scopeId,
            storage: "local",
            macro: stackTop(state, "macros"),
          });
        }
      }
      if (name === "LOOP") {
        const argument =
          meaningful[1]?.type === "variable" && meaningful[1].start === first.end
            ? meaningful[2]
            : meaningful[1];
        if (argument?.type === "word" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.value)) {
          occurrences.push({
            name: argument.value,
            canonicalName: upper(argument.value),
            namespace: "variable",
            role: "read",
            syntax: "loop-array",
            start: argument.start,
            end: argument.end,
            scopeId: state.scopeId,
            storage: "local",
            macro: stackTop(state, "macros"),
          });
        }
      }
      if (kind === "command" || kind === "record") {
        for (const token of meaningful) {
          if (
            state.command !== "GETN" ||
            upper(token.param) !== "VAR" ||
            token.role !== "value" ||
            token.type !== "word" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value)
          )
            continue;
          const item = {
            name: token.value,
            canonicalName: upper(token.value),
            namespace: "variable",
            role: "write",
            syntax: "getn-output",
            start: token.start,
            end: token.end,
            scopeId: state.scopeId,
            storage: "local",
            macro: stackTop(state, "macros"),
          };
          occurrences.push(item);
          declarations.push({
            ...item,
            role: "definition",
            kind: 13,
            symbolStart: first.start,
            symbolEnd: end,
          });
        }
      }
    }
    const schemaRecord = ["record", "command"].includes(kind);
    const context = {
      module: state.module,
      command: schemaRecord ? state.command : null,
      scopeId: state.scopeId,
      tableHeader: state.tableHeader?.slice() ?? null,
      forms: schemaRecord
        ? (resolution.info?.forms ?? resolver.lookup(state.module, state.command)?.forms ?? [])
        : [],
      schema: resolution.info?.schema ?? null,
      confidence: resolution.confidence,
      mode: state.mode,
    };
    records.push({
      start: fragmentStart,
      end,
      tokens: fragment,
      kind,
      context,
      before: fragmentState,
      param: resolution.param ?? null,
      activeParameter: resolution.assignments.at(-1)?.activeParameter ?? null,
      tableDefinition: Boolean(resolution.tableHeader),
      continuedFromPrevious: !atHead,
      continued: joinsNext,
    });
    state.continued = joinsNext;
    state.continuationParam = joinsNext ? (resolution.param ?? state.continuationParam) : null;
    state.continuationAwaitingValue = joinsNext
      ? (resolution.awaitingValue ?? state.continuationAwaitingValue)
      : false;
    state.continuationListValue = joinsNext
      ? (resolution.awaitingListValue ?? state.continuationListValue)
      : false;
    state.continuationValuePosition = joinsNext ? (resolution.valuePosition ?? null) : null;
    state.continuationUsedParams = joinsNext
      ? (resolution.usedParams ?? state.continuationUsedParams)
      : [];
    state.continuationPosition = joinsNext
      ? resolution.positional === undefined
        ? state.continuationPosition
        : resolution.positional
      : 0;
    state.depth = joinsNext ? depth : 0;
    fragment = [];
    atHead = !joinsNext;
    fragmentStart = end;
    fragmentState = clone(state);
    defineValue = false;
    defining = false;
    conditionValue = false;
  };

  for (let index = 0; index < text.length;) {
    const start = index;
    const character = text[index];
    if (text.startsWith("ï»¿", index)) {
      index += 3;
      continue;
    }
    if (/\s/.test(character) || character === "\uFEFF") {
      index++;
      continue;
    }
    if (state.mode === "text" && TEXT_CLOSE.test(text.slice(index))) {
      const end = index + text.slice(index).match(TEXT_CLOSE)[0].length;
      emit("text-end", index, end);
      finish(end);
      state.mode = "code";
      fragmentState = clone(state);
      index = end;
      continue;
    }
    if (state.mode === "code" && TEXT_OPEN.test(text.slice(index))) {
      emit("text-open", index, index + 5);
      state.mode = "text-header";
      index += 5;
      continue;
    }
    if (state.mode === "text-header" && character === ">") {
      emit("text-header-end", index, ++index);
      state.mode = "text";
      continue;
    }
    if (state.mode === "code" && PICTURE.test(text.slice(index))) {
      const match = text.slice(index).match(PICTURE)[0];
      emit("picture", index, index + match.length);
      index += match.length;
      continue;
    }
    if (character === "$" && text[index + 1] === "(") {
      const close = text.indexOf(")", index + 2);
      const end = close < 0 ? text.length : close + 1;
      const token = emit("macro", index, end, {
        nameStart: index + 2,
        nameEnd: close < 0 ? end : close,
        incomplete: close < 0,
      });
      addOccurrence(token, "macro", "read", { scopeId: "preprocessor", storage: "macro" });
      index = end;
      continue;
    }
    if (
      state.mode !== "text" &&
      state.mode !== "text-header" &&
      character === "$" &&
      text[index + 1] === "$"
    ) {
      emit("continuation", index, text.length);
      continued = Boolean(
        fragment.some((token) => token.type !== "continuation" && token.type !== "comment"),
      );
      break;
    }
    if (
      state.mode !== "text" &&
      state.mode !== "text-header" &&
      character === "$" &&
      atHead &&
      !fragment.length &&
      /^\$(?:PROG|APPLY)(?=\s|$)/i.test(text.slice(index))
    ) {
      const match = text.slice(index).match(/^\$(?:PROG|APPLY)/i)[0];
      emit("word", index, index + match.length);
      index += match.length;
      continue;
    }
    if (
      !["text", "text-header"].includes(state.mode) &&
      (character === "$" || character === "!" || text.startsWith("//", index))
    ) {
      emit("comment", index, text.length);
      break;
    }
    if (character === "'" || character === '"') {
      if (state.mode === "text" && /[A-Za-z0-9_]/.test(text[index - 1] ?? "")) {
        emit("prose", index, ++index);
        continue;
      }
      const quote = character;
      const doubled =
        text[index + 1] === quote && text[index + 2] !== quote
          ? text.indexOf(quote + quote, index + 2)
          : -1;
      let end = doubled >= 0 ? doubled + 2 : index + 1;
      let closed = doubled >= 0;
      if (!closed) {
        while (end < text.length) {
          if (text[end] !== quote) {
            end++;
            continue;
          }
          if (text[end + 1] === quote) {
            end += 2;
            continue;
          }
          end++;
          closed = true;
          break;
        }
      }
      if (!closed && state.mode === "text") {
        emit("prose", index, ++index);
        continue;
      }
      const width = doubled >= 0 ? 2 : 1;
      const literalStart = index + width;
      const literalEnd = closed ? end - width : end;
      emit("string", index, end, {
        literal: text
          .slice(literalStart, literalEnd)
          .split(quote + quote)
          .join(quote),
        literalStart,
        literalEnd,
        incomplete: !closed,
        dynamic: text.slice(index, end).includes("$("),
      });
      macroInString(literalStart, literalEnd);
      if (!closed)
        diagnostics.push({
          start: index,
          end,
          message: "Unterminated quoted value.",
          code: "unterminated-string",
        });
      index = end;
      continue;
    }
    if ((defining || upper(fragment[0]?.value) === "#UNDEF") && fragment.length === 1) {
      const match = text.slice(index).match(/^#?[A-Za-z0-9_][A-Za-z0-9_.-]*/);
      if (match) {
        emit("word", index, index + match[0].length, {
          nameStart: index + (character === "#" ? 1 : 0),
          nameEnd: index + match[0].length,
        });
        index += match[0].length;
        continue;
      }
    }
    if (character === "#") {
      const match = text.slice(index + 1).match(NAME);
      if (match) {
        const end = index + 1 + match[0].length;
        if (atHead && fragment.length === 0 && PREPROCESSOR.has(upper(match[0]))) {
          emit("preprocessor", index, end);
          defining = upper(match[0]) === "DEFINE";
          conditionValue = ["IF", "ELSEIF"].includes(upper(match[0]));
        } else {
          const token = emit("variable", index, end, { nameStart: index + 1, nameEnd: end });
          addOccurrence(token, "variable");
        }
        index = end;
        continue;
      }
      emit("punctuation", index, ++index);
      continue;
    }
    if (
      character === ";" &&
      depth === 0 &&
      !defineValue &&
      !conditionValue &&
      !["text", "text-header"].includes(state.mode)
    ) {
      finish(index);
      index++;
      fragmentStart = index;
      depth = 0;
      continue;
    }
    if (character === "=") {
      emit("equals", index, ++index);
      if (defining) defineValue = true;
      continue;
    }
    if (character === "," && state.mode === "code") {
      emit("comma", index, ++index);
      continue;
    }
    if (character === "(") {
      emit("punctuation", index, ++index);
      depth++;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      emit("punctuation", index, ++index);
      continue;
    }
    if (character === "[") {
      const close = text.indexOf("]", index + 1);
      const end = close < 0 ? text.length : close + 1;
      emit("unit", index, end);
      index = end;
      continue;
    }
    if (state.mode === "text" || state.mode === "text-header") {
      index++;
      while (index < text.length && !/[#$'"<>\s]/.test(text[index])) index++;
      emit("prose", start, index);
      continue;
    }
    index++;
    while (index < text.length && !/[\s,;!=$#@"[\]()<>]/.test(text[index])) index++;
    emit("word", start, index);
  }
  finish(text.length, continued);
  if (!continued) state.depth = 0;
  return {
    text,
    startState: clone(incoming),
    endState: clone(state),
    records,
    tokens,
    occurrences,
    declarations,
    includes: includeEntries,
    diagnostics,
  };
}

module.exports = {
  isMathFunction: (value) => FUNCTIONS.has(upper(value)),
  scanLine,
  initialState,
  clone,
  sameState,
  lastStartAt,
  compare,
  contains,
  range,
  point,
};
