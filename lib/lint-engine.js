"use strict";

const { createHash } = require("node:crypto");
const { scanLine, initialState } = require("./lexer");
const { SchemaResolver, upper } = require("./schema-resolver");
const { compileRules } = require("./err-rule-engine");
const { mappedLocation } = require("./source-map");
const { findInvalidNumbers, isNumericMathRecord } = require("./invalid-numbers");
const ruleCatalogue = require("./err-rules.json");

const RULE_VERSION = ruleCatalogue.ruleVersion;
const CONTROL_RELEASES = new Set(ruleCatalogue.releases.map(String));
const MAX_DIAGNOSTICS = 100;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_LEXICAL_MODULES = 128;
const MAX_LEXICAL_CHARS = 8 * 1024 * 1024;
const BUILTINS = new Set(["PI", "VERSION"]);
const EXTERNAL_VARIABLES = new Set([
  "GRP_MASS",
  "SCT_MASS",
  "MAT_MASS",
  "GRP_REIN",
  "SCT_REIN",
  "ASE_ITER",
  "AQB_USAGE",
]);
const COORDINATE_MODULES = new Set(["SOFILOAD", "ASE", "DYNA", "TALPA", "HYDRA"]);
const ALIASES = {
  LF: "LC",
  KOMB: "COMB",
  QPOL: "POLY",
  QP: "VERT",
  KNOT: "NODE",
  STAB: "BEAM",
  FACH: "TRUS",
  SEIL: "CABL",
  STEL: "BEPL",
};
const LOADS = new Set([
  "NODE",
  "BEAM",
  "TRUS",
  "CABL",
  "BEPL",
  "QUAD",
  "BRIC",
  "COPY",
  "POIN",
  "LINE",
  "AREA",
  "VOLU",
]);

function integerIndex(raw) {
  const match = raw.match(/^\s*\(\s*(\d+)\s*\)/);
  return match ? Number(match[1]) : null;
}

function valueCount(raw) {
  const chunks = [];
  let depth = 0;
  let quote = null;
  let chunk = "";
  const flush = () => {
    if (chunk) chunks.push(chunk);
    chunk = "";
  };
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (quote) {
      chunk += character;
      if (character === quote && raw[index + 1] === quote) chunk += raw[++index];
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
      chunk += character;
    } else if (character === "(" || character === "[") {
      depth++;
      chunk += character;
    } else if (character === ")" || character === "]") {
      depth--;
      chunk += character;
    } else if (depth === 0 && (character === "," || /\s/.test(character))) {
      flush();
      if (character === ",") chunks.push(",");
    } else chunk += character;
  }
  flush();
  if (depth !== 0 || quote) return null;
  const values = chunks.filter((value) => value !== "," && !/^\[[^\]]*\]$/.test(value));
  if (!values.length) return 0;
  const literal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?(?:\[[^\]]*\])?$|^(['"]).*\1$/;
  if (values.every((value) => literal.test(value))) return values.length;
  let count = 0;
  let operator = false;
  let followingComma = false;
  for (let index = 0; index < chunks.length; index++) {
    let value = chunks[index];
    if (value === ",") {
      operator = false;
      followingComma = true;
      continue;
    }
    if (/^\[[^\]]*\]$/.test(value)) continue;
    if (count === 0 && value.startsWith("=")) value = value.slice(1);
    if (!value) continue;
    if (/^[+*/^=<>!-]+$/.test(value)) {
      operator = true;
      continue;
    }
    // A bare array or CADINP repeat/range expression can expand to several
    // values. Its size is unknown until calculation, so never infer one.
    const nextOperator = /^[+*/^=<>!-]+$/.test(chunks[index + 1] || "");
    if (
      (!operator && !nextOperator && /^#?[A-Za-z_][A-Za-z0-9_]*$/.test(value)) ||
      /^\d[^\s]*\([^)]*\)\d|^\d+\(\d+\)$/.test(value)
    )
      return null;
    if (!operator || followingComma) {
      if (count && !followingComma && /^[+*-]/.test(value)) return null;
      count++;
    }
    operator = /[+*/^=-]$/.test(value);
    followingComma = false;
  }
  if (operator) return null;
  return count;
}

function compactRecord(record, entry, offset, line, previous) {
  const tokens = record.tokens.filter((token) => !["comment", "continuation"].includes(token.type));
  if (!tokens.length) return null;
  const first = tokens[0];
  const unitRecord = upper(first.value) === "UNIT";
  const start = offset + first.start;
  const codeEnd = tokens.at(-1).end;
  const end = offset + codeEnd;
  const raw = line.slice(first.start, codeEnd);
  const invalidNumbers = findInvalidNumbers(
    record,
    tokens,
    offset,
    record.continuedFromPrevious && previous?.continued && isNumericMathRecord(previous),
  );
  const params = {};
  const expressions = {};
  let activeParameter;
  for (const token of tokens) {
    if (token.role === "param") activeParameter = null;
    if (token.role !== "value" || !token.param) {
      if (activeParameter && expressions[activeParameter])
        expressions[activeParameter].end = token.end;
      continue;
    }
    const name = upper(token.param);
    if (!params[name]) params[name] = [];
    params[name].push(token.value);
    if (!expressions[name]) expressions[name] = { start: token.start, end: token.end };
    else expressions[name].end = token.end;
    activeParameter = name;
  }
  const probes = [...raw.matchAll(/\bDEF\s*\([^)]*\)/gi)].map((match) => ({
    start: first.start + match.index,
    end: first.start + match.index + match[0].length,
  }));
  const refs = entry.occurrences
    .filter(
      (item) =>
        item.namespace === "variable" && item.start >= first.start && item.end <= record.end,
    )
    .filter((item) => !probes.some((probe) => item.start >= probe.start && item.end <= probe.end))
    .map((item) => {
      const tail = line.slice(item.end, record.end);
      const literalIndex = tail.match(/^\s*\(\s*\d+\s*\)/);
      return {
        name: upper(item.name),
        role: item.role,
        start: offset + item.start - (line[item.start - 1] === "#" ? 1 : 0),
        end: offset + item.end + (literalIndex?.[0].length || 0),
        index: integerIndex(tail),
        indexed: /^\s*\(/.test(tail),
      };
    });
  const target = tokens[1]?.type === "variable" ? tokens[1] : null;
  let rhs = target ? line.slice(target.end, codeEnd) : "";
  const indexed = target && /^\s*\(/.test(rhs);
  const writeIndex = integerIndex(rhs);
  if (indexed) {
    let depth = 0;
    for (let index = 0; index < rhs.length; index++) {
      if (rhs[index] === "(") depth++;
      else if (rhs[index] === ")" && --depth === 0) {
        rhs = rhs.slice(index + 1);
        break;
      }
    }
  }
  return {
    start,
    end,
    kind: unitRecord ? "unit" : record.kind,
    name: upper(first.value),
    module: record.context.module,
    command: unitRecord
      ? "UNIT"
      : ALIASES[upper(record.context.command)] || upper(record.context.command),
    nativeCommand: unitRecord ? "UNIT" : upper(record.context.command),
    header: record.kind === "command" && Array.isArray(record.context.tableHeader),
    explicit: record.kind === "command" && !Array.isArray(record.context.tableHeader),
    ambiguous: record.context.confidence === false,
    params,
    commandRange: { start, end: offset + first.end },
    paramRanges: Object.fromEntries(
      Object.entries(expressions).map(([name, range]) => [
        name,
        { start: offset + range.start, end: offset + range.end },
      ]),
    ),
    paramExpressions: Object.fromEntries(
      Object.entries(expressions).map(([name, range]) => [
        name,
        line.slice(range.start, range.end),
      ]),
    ),
    refs,
    ...(invalidNumbers.length ? { invalidNumbers } : {}),
    mode: first.mode,
    raw,
    target: target ? upper(target.value.slice(1)) : null,
    indexed: Boolean(indexed),
    writeIndex,
    count: valueCount(rhs),
    hasRhs: Boolean(rhs.trim()),
    wildcard: target ? /^\s*[*?]/.test(rhs) : false,
    rhs,
    continued: record.continued,
    continuedFromPrevious: record.continuedFromPrevious,
  };
}

function nativeCommentLine(line) {
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote && line[index + 1] === quote) index++;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      const close =
        line[index + 1] === character && line[index + 2] !== character
          ? line.indexOf(character + character, index + 2)
          : -1;
      if (close >= 0) index = close + 1;
      else quote = character;
    } else if (character === "!" || line.startsWith("//", index)) break;
    else if (line.startsWith("$(", index)) {
      const close = line.indexOf(")", index + 2);
      if (close < 0) break;
      index = close;
    } else if (line.startsWith("$$", index)) break;
    else if (character === "$") return line.slice(0, index);
  }
  return line;
}

function scanBlocks(text, keywords, isCancelled) {
  const resolver = new SchemaResolver(keywords);
  const blocks = [];
  let block = { start: 0, headerEnd: 0, module: null, records: [] };
  let state = initialState({ scopeId: "lint", scopePrefix: "lint" });
  let offset = 0;
  let count = 0;
  const finishBlock = (end, endMode) => {
    block.end = end;
    block.endMode = endMode;
    for (const record of block.records) {
      record.start -= block.start;
      record.end -= block.start;
      record.commandRange.start -= block.start;
      record.commandRange.end -= block.start;
      for (const range of Object.values(record.paramRanges)) {
        range.start -= block.start;
        range.end -= block.start;
      }
      for (const ref of record.refs) {
        ref.start -= block.start;
        ref.end -= block.start;
      }
      for (const span of record.invalidNumbers || []) {
        span.start -= block.start;
        span.end -= block.start;
      }
    }
    if (block.records.length) blocks.push(block);
  };
  for (const lineWithNewline of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if ((count++ & 255) === 0 && isCancelled()) return null;
    const line = lineWithNewline.replace(/\r?\n$/, "");
    if (block.active === false && !/^\s*[+-]?PROG\b/i.test(line)) {
      offset += lineWithNewline.length;
      continue;
    }
    const nativeLine = ["code", "legacy"].includes(state.mode) ? nativeCommentLine(line) : line;
    if (!nativeLine.trim()) {
      offset += lineWithNewline.length;
      continue;
    }
    const entry = scanLine(nativeLine, state, resolver);
    state = entry.endState;
    for (const record of entry.records) {
      const compact = compactRecord(record, entry, offset, line, block.records.at(-1));
      if (!compact) continue;
      // An external APPLY cannot be inspected here. Keep the surrounding
      // program's static catalogue until the next explicit PROG header.
      if (/^[+$-]?APPLY$|^[+-]?SYS$/.test(compact.name) && block.module)
        state.module = block.module;
      if (compact.kind === "program") {
        finishBlock(compact.start, record.before.mode);
        block = {
          start: compact.start,
          headerEnd: compact.end,
          module: compact.module,
          active: !compact.name.startsWith("-"),
          records: [],
        };
        if (!block.active) state.mode = "code";
      }
      const previous = block.records.at(-1);
      if (compact.continuedFromPrevious && previous?.continued) {
        previous.end = compact.end;
        previous.raw += ` ${compact.raw}`;
        previous.rhs += ` ${compact.raw}`;
        previous.count = valueCount(previous.rhs);
        previous.hasRhs = Boolean(previous.rhs.trim());
        previous.refs.push(...compact.refs);
        if (compact.invalidNumbers)
          previous.invalidNumbers = [...(previous.invalidNumbers || []), ...compact.invalidNumbers];
        previous.continued = compact.continued;
        for (const [name, values] of Object.entries(compact.params))
          previous.params[name] = [...(previous.params[name] || []), ...values];
        for (const [name, expression] of Object.entries(compact.paramExpressions))
          previous.paramExpressions[name] = previous.paramExpressions[name]
            ? `${previous.paramExpressions[name]} ${expression}`
            : expression;
        for (const [name, range] of Object.entries(compact.paramRanges))
          previous.paramRanges[name] = previous.paramRanges[name]
            ? { start: previous.paramRanges[name].start, end: range.end }
            : range;
      } else block.records.push(compact);
    }
    const lastCommand = entry.records.findLast(
      (record) =>
        ["command", "program"].includes(record.kind) || upper(record.tokens[0]?.value) === "UNIT",
    );
    if (upper(lastCommand?.tokens[0]?.value) === "UNIT") {
      state.command = null;
      state.tableHeader = null;
    }
    offset += lineWithNewline.length;
  }
  finishBlock(text.length, state.mode);
  blocks.scannedLines = count;
  return blocks;
}

function lexicalBlocks(previous, text, keywords, isCancelled) {
  if (previous?.text === text)
    return {
      blocks: previous.blocks,
      scannedLines: 0,
      parsedRecords: 0,
      reusedLexicalModules: previous.blocks.length,
    };
  if (previous) {
    const before = previous.text;
    let prefix = 0;
    const length = Math.min(before.length, text.length);
    while (prefix < length && before[prefix] === text[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < length - prefix &&
      before[before.length - suffix - 1] === text[text.length - suffix - 1]
    )
      suffix++;
    const oldEnd = before.length - suffix;
    const changed = previous.blocks.findIndex(
      (block) =>
        block.module && prefix >= block.headerEnd && prefix < block.end && oldEnd <= block.end,
    );
    if (changed >= 0 && !isCancelled()) {
      const oldBlock = previous.blocks[changed];
      const delta = text.length - before.length;
      const replacement = scanBlocks(
        text.slice(oldBlock.start, oldBlock.end + delta),
        keywords,
        isCancelled,
      );
      if (!replacement) return null;
      if (
        replacement.length === 1 &&
        replacement[0].module === oldBlock.module &&
        replacement[0].endMode === oldBlock.endMode
      ) {
        const block = replacement[0];
        const blocks = previous.blocks.map((existing, index) => {
          if (index < changed) return existing;
          const value = index === changed ? block : existing;
          const shift = index === changed ? oldBlock.start : delta;
          return {
            ...value,
            start: value.start + shift,
            end: value.end + shift,
            headerEnd: value.headerEnd + shift,
          };
        });
        return {
          blocks,
          scannedLines: replacement.scannedLines,
          parsedRecords: block.records.length,
          reusedLexicalModules: blocks.length - 1,
        };
      }
    }
  }
  const blocks = scanBlocks(text, keywords, isCancelled);
  return (
    blocks && {
      blocks,
      scannedLines: blocks.scannedLines,
      parsedRecords: blocks.reduce((count, block) => count + block.records.length, 0),
      reusedLexicalModules: 0,
    }
  );
}

const cloneSymbols = (symbols) =>
  new Map([...symbols].map(([name, indices]) => [name, indices && new Set(indices)]));
function cloneFlow(flow) {
  return {
    ...flow,
    local: cloneSymbols(flow.local),
    persistent: cloneSymbols(flow.persistent),
    context: { ...flow.context },
  };
}
function joinSymbols(left, right) {
  const result = cloneSymbols(left);
  for (const [name, indices] of right) {
    if (!result.has(name)) result.set(name, indices && new Set(indices));
    else if (!result.get(name) || !indices) result.set(name, null);
    else for (const index of indices) result.get(name).add(index);
  }
  return result;
}
function joinFlow(left, right) {
  const context = {};
  for (const name of new Set([...Object.keys(left.context), ...Object.keys(right.context)]))
    context[name] = name.startsWith("$err:")
      ? left.context[name] === right.context[name]
        ? left.context[name]
        : null
      : Boolean(left.context[name] || right.context[name]);
  return {
    local: joinSymbols(left.local, right.local),
    persistent: joinSymbols(left.persistent, right.persistent),
    context,
    unknownVariables: left.unknownVariables || right.unknownVariables,
    unknownContext: left.unknownContext || right.unknownContext,
    unknownUnits: left.unknownUnits || right.unknownUnits,
    globalUnknownUnits: left.globalUnknownUnits || right.globalUnknownUnits,
  };
}
function signature(symbols) {
  return JSON.stringify(
    [...symbols]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, indices]) => [name, indices && [...indices].sort((a, b) => a - b)]),
  );
}
function declare(symbols, record) {
  const name = record.target;
  if (!name) return;
  if (record.count === null) {
    symbols.set(name, null);
    if (/^\d+$/.test(name)) symbols.set("$NUMERIC", null);
    return;
  }
  if (/^\d+$/.test(name) && !record.indexed) {
    for (let index = 0; index < Math.max(1, record.count); index++)
      symbols.set(String(Number(name) + index), new Set([0]));
    return;
  }
  if (record.indexed && record.writeIndex === null) {
    symbols.set(name, null);
    return;
  }
  const indices = symbols.get(name);
  if (symbols.has(name) && indices === null) return;
  const result = indices || new Set();
  const start = record.indexed ? record.writeIndex : 0;
  for (let index = 0; index < Math.max(1, record.count); index++) result.add(start + index);
  symbols.set(name, result);
}

function defGuards(record, symbols) {
  const expression = record.raw.replace(/^(?:IF|ELSEIF)\b/i, "").trim();
  if (/\bOR\b|\|\||\.OR\./i.test(expression)) return;
  const probe =
    /^\(*\s*DEF\s*\(\s*#?([A-Za-z_][A-Za-z0-9_]*|\d+)(?:\s*\(\s*(\d+)\s*\))?\s*\)/i.exec(
      expression,
    );
  if (!probe) return;
  const suffix = expression
    .slice(probe[0].length)
    .replace(/^\s*\)+\s*/, "")
    .trim();
  const exists =
    !suffix ||
    /^(?:>\s*0\b|>=\s*1\b|(?:<>|!=)\s*0\b|(?:==|=)\s*1\b|\.GT\.\s*0\b|\.GE\.\s*1\b|\.NE\.\s*0\b|\.EQ\.\s*1\b)/i.test(
      suffix,
    );
  if (!exists) return;
  const name = upper(probe[1]);
  if (probe[2] === undefined) symbols.set(name, null);
  else {
    if (symbols.has(name) && symbols.get(name) === null) return;
    const indices = symbols.get(name) || new Set();
    indices.add(Number(probe[2]));
    symbols.set(name, indices);
  }
}

function analyzeBlock(
  block,
  incoming,
  uncertainties,
  globalIncomplete,
  incomingUnknown,
  isCancelled,
  rules,
  incomingUnits,
  controlChecks,
  numberChecks,
) {
  if (block.active === false)
    return {
      diagnostics: [],
      persistent: cloneSymbols(incoming),
      unknownVariables: incomingUnknown,
      globalUnknownUnits: incomingUnits,
    };
  let flow = {
    local: cloneSymbols(incoming),
    persistent: cloneSymbols(incoming),
    context: {},
    unknownVariables: globalIncomplete || incomingUnknown,
    unknownContext: globalIncomplete,
    unknownUnits: incomingUnits,
    globalUnknownUnits: incomingUnits,
  };
  const diagnostics = [];
  const seen = new Set();
  const branches = [];
  const controls = [];
  let certainControls = !globalIncomplete;
  let invalidControls = false;
  let uncertaintyIndex = 0;
  let recordCount = 0;
  const emit = (code, message, record, ref, related) => {
    const key = `${code}:${record.start}:${ref?.start ?? ""}`;
    if (seen.has(key) || diagnostics.length >= MAX_DIAGNOSTICS) return;
    seen.add(key);
    diagnostics.push({
      code,
      message,
      start: ref?.start ?? record.start,
      end: ref?.end ?? record.end,
      recordStart: record.start,
      recordEnd: record.end,
      ...(related?.length ? { related } : {}),
    });
  };
  const controlLocation = (frame, message) => ({ ...frame.record.commandRange, message });
  const invalidateControls = () => {
    invalidControls = true;
    flow.unknownVariables = true;
    flow.unknownContext = true;
  };
  const missingCondition = (record) => {
    if (record.continued || record.raw.slice(record.name.length).replace(/[\s()]/g, "")) return;
    emit(
      "missing-control-condition",
      `${record.name} requires a condition expression.`,
      record,
      record.commandRange,
    );
    invalidateControls();
  };
  const checkControl = (record) => {
    if (!controlChecks || !certainControls || record.mode !== "code" || record.kind !== "control")
      return;
    if (record.name === "IF" || record.name === "LOOP") {
      if (record.name === "IF") missingCondition(record);
      // A bare LOOP is valid: CADINP supplies its documented 9999 iteration bound.
      controls.push({ kind: record.name, record, elseRecord: null });
      return;
    }
    const frame = controls.at(-1);
    const expected = record.name === "ENDLOOP" ? "LOOP" : "IF";
    if (!frame) {
      emit(
        "orphan-control",
        `${record.name} has no matching ${expected}.`,
        record,
        record.commandRange,
      );
      invalidateControls();
      return;
    }
    if (frame.kind !== expected) {
      emit(
        "invalid-control-nesting",
        `${record.name} requires ${expected}, but ${frame.kind} is still open.`,
        record,
        record.commandRange,
        [controlLocation(frame, `${frame.kind} opened here.`)],
      );
      invalidateControls();
    } else if (record.name === "ENDIF" || record.name === "ENDLOOP") controls.pop();
    else if (frame.elseRecord) {
      emit(
        "invalid-control-nesting",
        `${record.name} cannot follow ELSE in the same IF block.`,
        record,
        record.commandRange,
        [
          controlLocation(frame, "IF opened here."),
          {
            ...frame.elseRecord.commandRange,
            message: "ELSE already appeared here.",
          },
        ],
      );
      invalidateControls();
    } else if (record.name === "ELSE") frame.elseRecord = record;
    else if (record.name === "ELSEIF") missingCondition(record);
  };
  const requireContext = (key, record, parent, code) => {
    if (!flow.context[key] && !flow.unknownContext)
      emit(
        code,
        `${record.name} requires an earlier ${parent} record in this program.`,
        record,
        record.commandRange,
      );
  };
  for (const record of block.records) {
    if ((recordCount++ & 255) === 0 && isCancelled()) return null;
    while (
      uncertaintyIndex < uncertainties.length &&
      uncertainties[uncertaintyIndex].start <= record.end
    ) {
      const uncertainty = uncertainties[uncertaintyIndex++];
      if (record.kind !== "program" || uncertainty.end > record.start) certainControls = false;
      flow.unknownVariables = true;
      flow.unknownUnits = true;
      flow.globalUnknownUnits = true;
      if (
        uncertainty.kind !== "apply" &&
        !(record.kind === "program" && uncertainty.start <= record.start)
      )
        flow.unknownContext = true;
    }
    if (
      !["code", "legacy"].includes(record.mode) ||
      record.kind === "text" ||
      record.kind === "preprocessor"
    )
      continue;
    if (record.name === "@CDB" || record.name === "@KEY" || /^[+$-]?APPLY$/.test(record.name))
      flow.unknownVariables = true;
    if (!record.header && record.nativeCommand === "UNIT") flow.unknownUnits = true;
    if (!record.header && record.nativeCommand === "NORM" && record.params.UNIT) {
      flow.unknownUnits = true;
      flow.globalUnknownUnits = true;
    }
    if (record.kind === "end") {
      // END closes an input block's command contexts. Native SOFILOAD keeps
      // LET values for the next block, but requires a new LC before loading.
      flow.context = {};
      flow.unknownContext = false;
      continue;
    }
    if (["ELSE", "ELSEIF"].includes(record.name)) {
      const branch = branches.at(-1);
      if (branch?.kind === "IF") {
        branch.outcomes.push(flow);
        flow = cloneFlow(branch.before);
        branch.hasElse ||= record.name === "ELSE";
      }
    }
    checkControl(record);
    if (numberChecks)
      for (const span of record.invalidNumbers || [])
        emit(
          "invalid-number",
          `Invalid numeric literal '${span.text}': repeated decimal points.`,
          record,
          span,
        );
    if (invalidControls) {
      flow.unknownVariables = true;
      flow.unknownContext = true;
    }
    for (const ref of record.refs) {
      // A separately opened include fragment has no caller's variable scope.
      if (!block.module) continue;
      const exportRead = record.name === "STO" && !record.hasRhs && ref.name === record.target;
      if (ref.role !== "read" && !exportRead) continue;
      if (BUILTINS.has(ref.name) || EXTERNAL_VARIABLES.has(ref.name) || ref.name.startsWith("OPT_"))
        continue;
      if (/^\d+$/.test(ref.name) && flow.local.has("$NUMERIC")) continue;
      if (COORDINATE_MODULES.has(block.module) && /^COOR_[XYZ]$/.test(ref.name)) continue;
      const indices = flow.local.get(ref.name);
      if (!flow.local.has(ref.name)) {
        if (!flow.unknownVariables)
          emit(
            "variable-before-declaration",
            `#${ref.name} is not declared before this use in the analyzed input.`,
            record,
            ref,
          );
      } else if (ref.indexed && ref.index !== null && indices && !indices.has(ref.index)) {
        if (!flow.unknownVariables)
          emit(
            "array-index-not-declared",
            `Index ${ref.index} of #${ref.name} is not declared before this use in the analyzed input.`,
            record,
            ref,
          );
      }
    }
    if (record.name === "IF") {
      branches.push({ kind: "IF", before: cloneFlow(flow), outcomes: [], hasElse: false });
      defGuards(record, flow.local);
      continue;
    }
    if (["ELSE", "ELSEIF"].includes(record.name)) {
      if (record.name === "ELSEIF") defGuards(record, flow.local);
      continue;
    }
    if (record.name === "ENDIF") {
      const branch = branches.at(-1);
      if (branch?.kind === "IF") {
        branches.pop();
        branch.outcomes.push(flow);
        if (!branch.hasElse) branch.outcomes.push(branch.before);
        flow = branch.outcomes.reduce(joinFlow);
      }
      continue;
    }
    if (record.name === "LOOP") {
      branches.push({ kind: "LOOP", before: cloneFlow(flow) });
      if (record.target) flow.local.set(record.target, null);
      continue;
    }
    if (record.name === "ENDLOOP") {
      const branch = branches.at(-1);
      if (branch?.kind === "LOOP") {
        branches.pop();
        flow = joinFlow(branch.before, flow);
      }
      continue;
    }
    if (["LET", "STO"].includes(record.name) && record.target) {
      if (record.hasRhs || record.name === "LET") declare(flow.local, record);
      if (record.name === "STO" && flow.local.has(record.target)) {
        if (record.hasRhs) declare(flow.persistent, record);
        else
          flow.persistent.set(
            record.target,
            flow.local.get(record.target) && new Set(flow.local.get(record.target)),
          );
      }
    } else if (record.name === "RCL" && record.target) {
      if (record.target === "ALL") {
        flow.unknownVariables = true;
        for (const [name, indices] of flow.persistent)
          flow.local.set(name, indices && new Set(indices));
      } else {
        const indices = flow.persistent.get(record.target);
        flow.local.set(record.target, indices && new Set(indices));
      }
    } else if (record.name === "DEL" && record.target) {
      const pattern = record.raw.match(/^DEL\s*#([A-Za-z0-9_*?]+)/i)?.[1] || record.target;
      const expression = new RegExp(
        `^${upper(pattern)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\*/g, ".*")
          .replace(/\\\?/g, ".")}$`,
      );
      for (const symbols of [flow.local, flow.persistent])
        for (const name of symbols.keys()) if (expression.test(name)) symbols.delete(name);
    }
    for (const ref of record.refs)
      if (ref.role === "write" && record.name === "GETN") flow.local.set(ref.name, null);
    if (record.kind === "command" || record.kind === "record") rules.check(record, flow, emit);
    if (record.kind !== "command") continue;
    const command = record.command;
    if (block.module === "SOFILOAD") {
      if (command === "LC") flow.context.lc = true;
      else if (LOADS.has(command))
        requireContext("lc", record, "LC (LF)", "load-without-load-case");
      if (command === "LTD") {
        const values = record.params.OPT || [];
        const option = values.length === 1 ? upper(values[0]) : values.length ? null : "TASK";
        if (option === "TASK") {
          flow.context.ltd = true;
          flow.context.src = Boolean(record.params.SRC);
          flow.context.trg = Boolean(record.params.TRG);
        } else if (["SEL", "MOD", "IGN"].includes(option)) {
          requireContext("ltd", record, "LTD OPT TASK", "ltd-without-task");
          if (option === "MOD" && !flow.unknownContext && flow.context.ltd) {
            if (!record.params.SRC && !flow.context.src)
              emit(
                "ltd-mod-without-source",
                "LTD OPT MOD requires SRC, either here or in the preceding task.",
                record,
                record.commandRange,
              );
            if (!record.params.TRG && !flow.context.trg)
              emit(
                "ltd-mod-without-target",
                "LTD OPT MOD requires TRG, either here or in the preceding task.",
                record,
                record.commandRange,
              );
          }
          flow.context.src ||= Boolean(record.params.SRC);
          flow.context.trg ||= Boolean(record.params.TRG);
        } else if (option === null) flow.context.ltd = true;
      } else if (command === "LTDG")
        requireContext("ltd", record, "LTD OPT TASK", "ltdg-without-task");
      if (command === "TRB") flow.context.trb = true;
      else if (["TRBA", "TRBS", "TRBP", "TRBC"].includes(command))
        requireContext("trb", record, "TRB", "tributary-record-without-area");
    } else if (block.module === "AQUA") {
      if (command === "POLY") flow.context.poly = true;
      else if (command === "VERT")
        requireContext("poly", record, "POLY (QPOL)", "vertex-without-polygon");
    } else if (block.module === "MAXIMA") {
      if (command === "COMB") flow.context.comb = true;
      else if (["LC", "ACT"].includes(command))
        requireContext("comb", record, "COMB (KOMB)", "combination-record-without-combination");
    }
  }
  if (uncertaintyIndex < uncertainties.length) certainControls = false;
  if (controlChecks && block.module && certainControls) {
    if (controls.length) invalidateControls();
    for (const frame of controls)
      emit(
        "unclosed-control",
        `${frame.kind} is not closed before the end of this program; expected ${frame.kind === "IF" ? "ENDIF" : "ENDLOOP"}.`,
        frame.record,
        frame.record.commandRange,
      );
  }
  return {
    diagnostics,
    persistent: flow.persistent,
    unknownVariables: flow.unknownVariables,
    globalUnknownUnits: flow.globalUnknownUnits,
  };
}

function offsetPosition(text, offset) {
  const prefix = text.slice(0, Math.max(0, offset));
  const last = prefix.lastIndexOf("\n");
  return { line: prefix.split("\n").length - 1, character: prefix.length - last - 1 };
}

const sourceLocation = (location) => ({ uri: location.uri, range: location.range });

const sameLocation = (left, right) =>
  left.uri === right.uri &&
  left.range.start.line === right.range.start.line &&
  left.range.start.character === right.range.start.character &&
  left.range.end.line === right.range.end.line &&
  left.range.end.character === right.range.end.character;

class LintEngine {
  constructor() {
    this.cache = new Map();
    this.cacheBytes = 0;
    this.keywords = new Map();
    this.lexical = new Map();
    this.lexicalModules = 0;
    this.lexicalChars = 0;
    this.rules = new Map();
  }

  analyze({
    uri,
    text,
    segments = [],
    uncertainties = [],
    complete = true,
    version = "2026",
    language = "en",
    keywords,
    isCancelled = () => false,
  }) {
    const source = String(text || "");
    const locate = (start, end) =>
      mappedLocation(segments, start, end, (from, to) => ({
        uri,
        range: { start: offsetPosition(source, from), end: offsetPosition(source, to) },
      }));
    if (!keywords) {
      const key = `${version}:${language}`;
      if (!this.keywords.has(key)) {
        const { provider } = require("@lumine-code/sofistik-schema");
        this.keywords.set(key, provider().forRelease(version, language));
      }
      keywords = this.keywords.get(key);
    }
    const lexicalKey = `${uri}:${version}:${language}`;
    const lexical = lexicalBlocks(this.lexical.get(lexicalKey), source, keywords, isCancelled);
    const blocks = lexical?.blocks;
    const diagnostics = [];
    const metrics = {
      modules: blocks?.length || 0,
      analyzedModules: 0,
      reusedModules: 0,
      records: 0,
      diagnostics: 0,
      scannedLines: lexical?.scannedLines || 0,
      parsedRecords: lexical?.parsedRecords || 0,
      reusedLexicalModules: lexical?.reusedLexicalModules || 0,
    };
    if (!blocks || isCancelled()) return { cancelled: true, diagnostics: [], metrics };
    const oldLexical = this.lexical.get(lexicalKey);
    this.lexicalModules -= oldLexical?.blocks.length || 0;
    this.lexicalChars -= oldLexical?.text.length || 0;
    this.lexical.set(lexicalKey, { text: source, blocks });
    this.lexicalModules += blocks.length;
    this.lexicalChars += source.length;
    while (
      this.lexical.size > 8 ||
      this.lexicalModules > MAX_LEXICAL_MODULES ||
      this.lexicalChars > MAX_LEXICAL_CHARS
    ) {
      const oldest = this.lexical.keys().next().value;
      const discarded = this.lexical.get(oldest);
      this.lexicalModules -= discarded.blocks.length;
      this.lexicalChars -= discarded.text.length;
      this.lexical.delete(oldest);
    }
    let persistent = new Map();
    let incomingUnknown = false;
    let incomingUnits = false;
    const knownModules = new Set(keywords?.getModuleNames?.() || []);
    for (const block of blocks) {
      if (isCancelled()) return { cancelled: true, diagnostics: [], metrics };
      if (uncertainties.some((item) => item.start < block.start)) {
        incomingUnknown = true;
        incomingUnits = true;
      }
      metrics.records += block.records.length;
      const body = source.slice(block.start, block.end);
      const unknown = uncertainties
        .filter(
          (item) =>
            item.start >= block.start &&
            (item.start < block.end || (item.start === block.end && item.end === item.start)),
        )
        .map((item) => ({ ...item, start: item.start - block.start, end: item.end - block.start }));
      const uncertaintyKey = unknown.map((item) => [item.start, item.end, item.kind]);
      const fallbackUnknown = !complete && !uncertainties.length;
      const hash = createHash("sha256").update(body).digest("hex");
      const key = JSON.stringify([
        RULE_VERSION,
        version,
        language,
        block.module,
        hash,
        signature(persistent),
        uncertaintyKey,
        fallbackUnknown,
        incomingUnknown,
        incomingUnits,
      ]);
      let result = this.cache.get(key);
      if (result) metrics.reusedModules++;
      else {
        const module = keywords?.base?.normalizeModuleName(block.module || "") || block.module;
        const ruleKey = `${version}:${language}:${module}`;
        if (!this.rules.has(ruleKey)) {
          this.rules.set(ruleKey, compileRules(module, version, language, keywords));
          if (this.rules.size > 128) this.rules.delete(this.rules.keys().next().value);
        }
        result = analyzeBlock(
          block,
          persistent,
          unknown,
          fallbackUnknown,
          incomingUnknown,
          isCancelled,
          this.rules.get(ruleKey),
          incomingUnits,
          CONTROL_RELEASES.has(String(version)) && knownModules.has(module),
          CONTROL_RELEASES.has(String(version)) && (!module || knownModules.has(module)),
        );
        if (!result) return { cancelled: true, diagnostics: [], metrics };
        const weight =
          key.length * 2 +
          result.diagnostics.length * 512 +
          [...result.persistent].reduce(
            (size, [name, indices]) => size + name.length * 2 + 80 + (indices?.size || 0) * 16,
            0,
          );
        if (weight <= MAX_CACHE_BYTES) {
          result.weight = weight;
          this.cache.set(key, result);
          this.cacheBytes += weight;
          while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
            const oldest = this.cache.keys().next().value;
            this.cacheBytes -= this.cache.get(oldest).weight;
            this.cache.delete(oldest);
          }
        }
        metrics.analyzedModules++;
      }
      persistent = cloneSymbols(result.persistent);
      incomingUnknown = result.unknownVariables;
      incomingUnits = result.globalUnknownUnits;
      if (!result.diagnostics.length) continue;
      const header = locate(block.start, block.headerEnd || block.start);
      for (const issue of result.diagnostics) {
        if (diagnostics.length >= MAX_DIAGNOSTICS) break;
        const location = locate(block.start + issue.start, block.start + issue.end);
        const record = locate(block.start + issue.recordStart, block.start + issue.recordEnd);
        // A reusable block is analyzed in its caller's environment. Its exact
        // body location remains related so distinct invocations stay distinct.
        const primary = location.blockInvocation || location;
        const relatedInformation = [];
        const relate = (origin, message) => {
          if (
            !sameLocation(origin, primary) &&
            !relatedInformation.some((item) => sameLocation(item.location, origin))
          )
            relatedInformation.push({ location: sourceLocation(origin), message });
        };
        if (location.invocation)
          relate(location.invocation, "Input expanded from this invocation.");
        for (const definition of location.definitions || [])
          relate(definition, "Preprocessor value defined here.");
        for (const origin of location.origins || [])
          relate(origin, "Additional original source for this record.");
        for (const related of issue.related || []) {
          const origin = locate(block.start + related.start, block.start + related.end);
          relate(origin, related.message);
          for (const definition of origin.definitions || [])
            relate(definition, "Preprocessor value defined here.");
          for (const fragment of origin.origins || []) relate(fragment, related.message);
        }
        if (!sameLocation(primary, location)) relate(location, issue.message);
        diagnostics.push({
          uri: primary.uri,
          range: primary.range,
          severity: 2,
          source: "sofistik-linter",
          code: issue.code,
          message: issue.message,
          ...(relatedInformation.length ? { relatedInformation } : {}),
          data: {
            recordOrigin: sourceLocation(record),
            focusOrigin: sourceLocation(location),
            ...(record.origins ? { recordOrigins: record.origins } : {}),
            ...(location.origins ? { focusOrigins: location.origins } : {}),
            programAnchor: sourceLocation(header),
            ...(location.invocation ? { invocation: location.invocation } : {}),
            ...(location.blockInvocation ? { blockInvocation: location.blockInvocation } : {}),
          },
        });
      }
    }
    metrics.diagnostics = diagnostics.length;
    return { diagnostics, metrics };
  }

  clear() {
    this.cache.clear();
    this.cacheBytes = 0;
    this.keywords.clear();
    this.lexical.clear();
    this.lexicalModules = 0;
    this.lexicalChars = 0;
    this.rules.clear();
  }
}

module.exports = { LintEngine };
