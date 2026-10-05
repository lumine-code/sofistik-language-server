"use strict";

const { SchemaResolver, upper } = require("./schema-resolver");

const UNKNOWN = Symbol("unknown scalar");
const PATTERNS = new WeakMap();
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const OPERATORS = new Set([
  "all",
  "any",
  "not",
  "xor",
  "exactly-one",
  "present",
  "absent",
  "eq",
  "ne",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "compare",
  "context",
  "command",
  "prefix",
  "pattern",
  "number",
  "integer",
  "explicit",
]);
const stateKey = (key) => (String(key).startsWith("$err:") ? String(key) : `$err:${key}`);

// This is deliberately not a CADINP expression evaluator. Units, arithmetic,
// variable references and lists cannot manufacture a known numeric value.
function scalar(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : UNKNOWN;
  if (typeof raw !== "string") return UNKNOWN;
  const text = raw.trim();
  if (NUMBER.test(text)) {
    const number = Number(text.replace(/[dD]/, "e"));
    return Number.isFinite(number) ? number : UNKNOWN;
  }
  if (!text) return "";
  if ((text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) {
    const quote = text[0];
    const width =
      text.length >= 4 && text.startsWith(quote + quote) && text.endsWith(quote + quote) ? 2 : 1;
    const body = text.slice(width, -width).replaceAll(quote + quote, quote);
    if (body.includes("#") || body.includes("$(")) return UNKNOWN;
    return upper(body);
  }
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(text) || text === "-" ? upper(text) : UNKNOWN;
}

function booleanAll(values) {
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

function booleanAny(values) {
  if (values.includes(true)) return true;
  return values.includes(null) ? null : false;
}

function compare(left, right, operation) {
  if (left === UNKNOWN || right === UNKNOWN || left === undefined || right === undefined)
    return null;
  if (typeof left !== typeof right) return null;
  if (["lt", "lte", "gt", "gte"].includes(operation)) {
    if (typeof left !== "number" || typeof right !== "number") return null;
    if (operation === "lt") return left < right;
    if (operation === "lte") return left <= right;
    if (operation === "gt") return left > right;
    return left >= right;
  }
  const equal =
    typeof left === "string" && typeof right === "string"
      ? upper(left) === upper(right)
      : left === right;
  return operation === "ne" ? !equal : equal;
}

function validateCondition(condition, parameters, ruleId) {
  if (condition === undefined || typeof condition === "boolean") return;
  if (!condition || !OPERATORS.has(condition.op))
    throw new Error(`Invalid predicate in ERR rule ${ruleId}.`);
  const requireParameter = (parameter) => {
    if (!Object.hasOwn(parameters, parameter))
      throw new Error(`Unknown logical parameter ${parameter} in ERR rule ${ruleId}.`);
  };
  if (condition.param) requireParameter(condition.param);
  if (condition.op === "compare") {
    for (const operand of [condition.left, condition.right]) {
      if (typeof operand === "string") requireParameter(operand);
      else if (operand?.param) requireParameter(operand.param);
      else if (!operand || (!operand.context && !Object.hasOwn(operand, "value")))
        throw new Error(`Invalid operand in ERR rule ${ruleId}.`);
    }
    if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(condition.relation))
      throw new Error(`Invalid comparison in ERR rule ${ruleId}.`);
  }
  if (condition.op === "pattern")
    PATTERNS.set(
      condition,
      new RegExp(condition.pattern ?? condition.value, condition.flags || ""),
    );
  for (const child of condition.conditions || []) validateCondition(child, parameters, ruleId);
  if (condition.condition) validateCondition(condition.condition, parameters, ruleId);
}

function operandValue(operand, read, flow) {
  if (typeof operand === "string") return read(operand).value;
  if (operand.param) return read(operand.param).value;
  if (operand.context) {
    const key = stateKey(operand.context);
    if (
      flow.unknownContext ||
      !Object.hasOwn(flow.context || {}, key) ||
      flow.context[key] === null
    )
      return UNKNOWN;
    return flow.context[key];
  }
  return operand.value;
}

function parameterReader(record, bindings, defaults, uncertain = false, flow, unitFields) {
  const cache = new Map();
  const read = (logical) => {
    if (cache.has(logical)) return cache.get(logical);
    if (uncertain) {
      const result = { present: null, value: UNKNOWN };
      cache.set(logical, result);
      return result;
    }
    const name = bindings[logical];
    const values = record.params?.[name];
    const supplied = Array.isArray(values) ? values : values === undefined ? [] : [values];
    let present = supplied.length > 0;
    let value = Object.hasOwn(record.paramExpressions || {}, name)
      ? scalar(record.paramExpressions[name])
      : supplied.length === 1
        ? scalar(supplied[0])
        : UNKNOWN;
    // An empty quoted value does not satisfy a required filename/identifier.
    if (value === "") present = false;
    if (!present && Object.hasOwn(defaults, logical)) value = scalar(defaults[logical]);
    // UNIT overrides can change the interpretation of a bare dimensional
    // value. Presence stays known even when its converted magnitude does not.
    if (flow?.unknownUnits && unitFields?.has(name)) value = UNKNOWN;
    const result = { present, value, name, supplied: supplied.length > 0 };
    cache.set(logical, result);
    return result;
  };
  read.command = upper(record.nativeCommand || record.name || record.command);
  read.explicit =
    record.explicit ?? (record.kind === "command" && !record.tableHeader && !record.header);
  return read;
}

function evaluate(condition, read, flow) {
  if (condition === undefined) return true;
  if (typeof condition === "boolean") return condition;
  switch (condition.op) {
    case "all":
      return booleanAll(condition.conditions.map((child) => evaluate(child, read, flow)));
    case "any":
      return booleanAny(condition.conditions.map((child) => evaluate(child, read, flow)));
    case "not": {
      const result = evaluate(condition.condition, read, flow);
      return result === null ? null : !result;
    }
    case "xor":
    case "exactly-one": {
      const values = condition.conditions.map((child) => evaluate(child, read, flow));
      const count = values.filter((value) => value === true).length;
      if (count > 1) return false;
      return values.includes(null) ? null : count === 1;
    }
    case "present":
      return read(condition.param).present;
    case "absent":
      return read(condition.param).present === null ? null : !read(condition.param).present;
    case "context": {
      if (flow.unknownContext) return null;
      const key = stateKey(condition.key);
      const value = Object.hasOwn(flow.context || {}, key) ? flow.context[key] : false;
      return value === null ? null : compare(value, condition.value ?? true, "eq");
    }
    case "compare":
      return compare(
        operandValue(condition.left, read, flow),
        operandValue(condition.right, read, flow),
        condition.relation,
      );
    case "in": {
      const value = read(condition.param).value;
      if (value === UNKNOWN) return null;
      if (!condition.values.some((allowed) => typeof allowed === typeof value)) return null;
      return booleanAny(condition.values.map((allowed) => compare(value, allowed, "eq")));
    }
    case "command":
      return (condition.values || [condition.value]).some((name) => upper(name) === read.command);
    case "explicit":
      return Boolean(read.explicit);
    case "prefix": {
      const value = read(condition.param).value;
      if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_.-]*$/.test(value)) return null;
      return (condition.values || [condition.value]).some((prefix) =>
        value.startsWith(upper(prefix)),
      );
    }
    case "pattern": {
      const value = read(condition.param).value;
      if (typeof value !== "string") return null;
      const pattern = PATTERNS.get(condition);
      pattern.lastIndex = 0;
      return pattern.test(value);
    }
    case "number": {
      const value = read(condition.param).value;
      return value === UNKNOWN ? null : typeof value === "number";
    }
    case "integer": {
      const value = read(condition.param).value;
      return typeof value === "number" ? Number.isInteger(value) : null;
    }
    default:
      return compare(read(condition.param).value, condition.value, condition.op);
  }
}

function validRange(range, record) {
  return (
    range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start <= range.end &&
    (!Number.isInteger(record.start) || range.start >= record.start) &&
    (!Number.isInteger(record.end) || range.end <= record.end)
  );
}

// Collect only branches that prove the predicate's result. A true alternative
// must not borrow the location of an unrelated false or unknown alternative.
function collectProof(condition, result, read, flow, proof) {
  if (!condition || typeof condition === "boolean" || result === null) return;
  if (condition.op === "not") {
    collectProof(condition.condition, !result, read, flow, proof);
    return;
  }
  if (["all", "any", "xor", "exactly-one"].includes(condition.op)) {
    const children = condition.conditions.map((child) => ({
      child,
      value: evaluate(child, read, flow),
    }));
    const multiple =
      ["xor", "exactly-one"].includes(condition.op) &&
      children.filter((item) => item.value === true).length > 1;
    for (const { child, value } of children) {
      if (value === null) continue;
      if (condition.op === "all" && result === false && value !== false) continue;
      if (condition.op === "any" && result === true && value !== true) continue;
      if (multiple && value !== true) continue;
      collectProof(child, value, read, flow, proof);
    }
    return;
  }
  if (condition.op === "compare") {
    for (const operand of [condition.left, condition.right]) {
      if (typeof operand === "string") proof.parameters.add(operand);
      else if (operand.param) proof.parameters.add(operand.param);
      else if (operand.context) proof.command = true;
    }
    return;
  }
  if (condition.param) {
    proof.parameters.add(condition.param);
    if (["present", "absent"].includes(condition.op) && !read(condition.param).supplied)
      proof.missing = true;
  } else if (["context", "command", "explicit"].includes(condition.op)) proof.command = true;
}

function diagnosticFocus(condition, read, flow, record) {
  if (!record.paramRanges && !record.commandRange) return undefined;
  const proof = { parameters: new Set(), command: false, missing: false };
  collectProof(condition, true, read, flow, proof);
  if (proof.missing)
    return validRange(record.commandRange, record)
      ? { start: record.commandRange.start, end: record.commandRange.end }
      : undefined;
  const ranges = new Map();
  for (const logical of proof.parameters) {
    const parameter = read(logical);
    if (!parameter.supplied) {
      proof.command = true;
      continue;
    }
    const range = record.paramRanges?.[parameter.name];
    if (!validRange(range, record)) return undefined;
    ranges.set(`${range.start}:${range.end}`, range);
  }
  if (ranges.size === 1) {
    const range = ranges.values().next().value;
    return { start: range.start, end: range.end };
  }
  // A cross-field violation cannot identify which editable value is wrong.
  // Keep the complete record rather than selecting an arbitrary field.
  if (ranges.size > 1) return undefined;
  return proof.command && validRange(record.commandRange, record)
    ? { start: record.commandRange.start, end: record.commandRange.end }
    : undefined;
}

function applyUpdates(updates, read, flow, guard = true) {
  if (!updates?.length) return;
  flow.context ||= {};
  for (const update of updates) {
    const when = booleanAll([guard, evaluate(update.when, read, flow)]);
    if (when === false) continue;
    const key = stateKey(update.key);
    const value = update.fromParam ? read(update.fromParam).value : update.value;
    const known = value !== UNKNOWN && value !== undefined;
    if (when === null) {
      if (!known || flow.context[key] !== value) flow.context[key] = null;
    } else flow.context[key] = known ? value : null;
  }
}

function modulesFor(rule) {
  return rule.modules || (Array.isArray(rule.module) ? rule.module : [rule.module]);
}

function defaultRegistry() {
  return require("./err-rules.json");
}

/** Compile one release/language's supported rules into native-command buckets. */
function compileRules(module, version, language, keywords, registry = defaultRegistry()) {
  const selectedModule = upper(module);
  const selectedVersion = String(version);
  const selectedLanguage = String(language).toLowerCase();
  const resolver = new SchemaResolver(keywords);
  const byCommand = new Map();
  const activeRules = [];
  for (const rule of registry.rules || []) {
    if (!modulesFor(rule).some((name) => name === "*" || upper(name) === selectedModule)) continue;
    const variants = (rule.variants || []).filter((variant) =>
      variant.versions?.map(String).includes(selectedVersion),
    );
    for (const variant of variants) {
      const commands = variant.commands?.[selectedLanguage] || [];
      if (!commands.length) continue;
      const parameters = {};
      for (const [logical, binding] of Object.entries(variant.parameters || {})) {
        const native = typeof binding === "string" ? binding : binding[selectedLanguage];
        if (native) parameters[logical] = upper(native);
      }
      validateCondition(variant.when, parameters, rule.id);
      validateCondition(variant.invalid, parameters, rule.id);
      for (const update of variant.updates || []) {
        validateCondition(update.when, parameters, rule.id);
        if (update.fromParam && !Object.hasOwn(parameters, update.fromParam))
          throw new Error(`Unknown update parameter ${update.fromParam} in ERR rule ${rule.id}.`);
      }
      const unitFields = new Map();
      const compiled = { rule, variant, parameters, unitFields };
      const supported = [];
      const availableParameters = new Set();
      for (const command of commands) {
        const info = resolver.lookup(selectedModule, command);
        if (!info) continue;
        supported.push(command);
        for (const name of info.params.keys()) availableParameters.add(name);
        unitFields.set(
          upper(command),
          new Set(
            [...info.params]
              .filter(([_name, slots]) =>
                slots.some((slot) => {
                  const code = Number(slot.dataTypeCode);
                  return Number.isInteger(code) && code >= 1000 && code <= 1999;
                }),
              )
              .map(([name]) => name),
          ),
        );
      }
      // Parent observers and child checks can use different fields. Verify the
      // release's complete command group, then index each supported command.
      if (Object.values(parameters).some((name) => !availableParameters.has(name))) continue;
      for (const command of supported) {
        const name = upper(command);
        if (!byCommand.has(name)) byCommand.set(name, []);
        byCommand.get(name).push(compiled);
      }
      if (supported.length) activeRules.push(compiled);
    }
  }
  return {
    byCommand,
    rules: activeRules,
    check(record, flow, emit) {
      const native = upper(record.nativeCommand || record.name);
      const selectedCommand = byCommand.has(native) ? native : upper(record.command);
      const checks = byCommand.get(selectedCommand);
      if (!checks || record.header || record.tableHeader) return;
      const uncertain = Boolean(record.continued || record.ambiguous);
      for (const { rule, variant, parameters, unitFields } of checks) {
        const read = parameterReader(
          record,
          parameters,
          variant.defaults || {},
          uncertain,
          flow,
          unitFields.get(selectedCommand),
        );
        const applies = evaluate(variant.when, read, flow);
        if (
          !uncertain &&
          applies === true &&
          variant.invalid &&
          evaluate(variant.invalid, read, flow) === true
        )
          emit(
            rule.id,
            variant.message || rule.message || `${native} violates ${rule.id}.`,
            record,
            diagnosticFocus(variant.invalid, read, flow, record),
          );
        // Observers remain active independently of a child-check guard. Each
        // update owns its condition and makes uncertain effects explicit.
        applyUpdates(variant.updates, read, flow, uncertain ? null : true);
      }
    },
  };
}

module.exports = { compileRules };
