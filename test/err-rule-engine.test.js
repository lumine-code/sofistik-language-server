"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compileRules } = require("../lib/err-rule-engine");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { LintEngine } = require("../lib/lint-engine");

const keywords = {
  getCommandSchema(module, command) {
    if (module !== "TEST") return null;
    const names = {
      LOAD: ["A", "B", "MODE"],
      LAST: ["X", "Y", "ART"],
      START: ["MODE"],
      NEXT: [],
    }[command];
    return names ? { forms: [{ slots: names.map((name) => ({ name })) }] } : null;
  },
};
const variant = (invalid, options = {}) => ({
  versions: ["2025", "2026"],
  commands: { en: ["LOAD"], de: ["LAST"] },
  parameters: {
    first: { en: "A", de: "X" },
    second: { en: "B", de: "Y" },
    mode: { en: "MODE", de: "ART" },
  },
  invalid,
  ...options,
});
const registry = (...variants) => ({
  rules: variants.map((item, index) => ({
    id: `rule-${index}`,
    code: `T${index + 1}`,
    module: "TEST",
    message: `Rule ${index}`,
    variants: [item],
  })),
});
function run(pack, params, options = {}) {
  const engine = compileRules(
    "TEST",
    options.version || "2026",
    options.language || "en",
    options.keywords || keywords,
    pack,
  );
  const messages = [];
  const flow = options.flow || { context: {}, unknownContext: false };
  const record = { name: options.name || "LOAD", params, ...options.record };
  engine.check(record, flow, (id, message, source, focus) =>
    messages.push({ id, message, source, focus }),
  );
  return { messages, flow, engine };
}

test("numeric bounds inspect literals and skip CADINP expressions, lists and units", () => {
  const pack = registry(variant({ op: "lte", param: "first", value: 0 }));
  for (const value of ["0", "-1", "-1D-2"])
    assert.equal(run(pack, { A: [value] }).messages.length, 1);
  for (const value of ["1", "AUTO", "#value", "1-2", "-1[sec]", "(-1)", "'0'", "1(3)"])
    assert.deepEqual(run(pack, { A: [value] }).messages, []);
  assert.deepEqual(run(pack, { A: ["-1", "-2"] }).messages, []);
  assert.deepEqual(run(pack, {}).messages, []);
});

test("variants select exact supported versions, native language bindings and available schemas", () => {
  const pack = registry(variant({ op: "lt", param: "first", value: 0 }));
  assert.equal(run(pack, { A: ["-1"] }, { version: "2025" }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["-1"] }, { version: "2024" }).messages, []);
  assert.equal(run(pack, { X: ["-1"] }, { language: "de", name: "LAST" }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["-1"] }, { language: "de" }).messages, []);
  assert.deepEqual(run(pack, { A: ["-1"] }, { language: "fr" }).messages, []);
  const unavailable = registry(
    variant(
      { op: "lt", param: "first", value: 0 },
      { parameters: { first: { en: "NOT_IN_THIS_RELEASE", de: "X" } } },
    ),
  );
  assert.equal(run(unavailable, {}).engine.rules.length, 0);
});

test("numeric comparisons and conditional requirements preserve unknown guard values", () => {
  const pack = registry(
    variant({ op: "compare", left: "first", right: "second", relation: "gt" }),
    variant({ op: "absent", param: "second" }, { when: { op: "eq", param: "mode", value: "DAT" } }),
  );
  assert.equal(run(pack, { A: ["2"], B: ["1"] }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["#a"], B: ["1"] }).messages, []);
  assert.equal(run(pack, { MODE: ["'dat'"] }).messages.length, 1);
  assert.deepEqual(run(pack, { MODE: ["#mode"] }).messages, []);
  assert.deepEqual(run(pack, { MODE: ["DAT"], B: ["#filename"] }).messages, []);
  assert.deepEqual(run(pack, {}).messages, []);
});

test("required and xor checks use supplied values without computing dynamic contents", () => {
  const pack = registry(
    variant({
      op: "not",
      condition: {
        op: "exactly-one",
        conditions: [
          { op: "present", param: "first" },
          { op: "present", param: "second" },
        ],
      },
    }),
  );
  assert.equal(run(pack, {}).messages.length, 1);
  assert.equal(run(pack, { A: ["''"] }).messages.length, 1);
  assert.equal(run(pack, { A: ["#a"], B: ["#b"] }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["#a"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["0"] }).messages, []);
});

test("all/any/not use three-valued logic instead of treating unknown as false", () => {
  const known = { op: "eq", param: "mode", value: "DAT" };
  const dynamic = { op: "lt", param: "first", value: 0 };
  const all = registry(variant({ op: "all", conditions: [known, dynamic] }));
  const any = registry(variant({ op: "any", conditions: [known, dynamic] }));
  const not = registry(variant({ op: "not", condition: dynamic }));
  assert.deepEqual(run(all, { MODE: ["DAT"], A: ["#a"] }).messages, []);
  assert.equal(run(any, { MODE: ["DAT"], A: ["#a"] }).messages.length, 1);
  assert.deepEqual(run(any, { MODE: ["OTHER"], A: ["#a"] }).messages, []);
  assert.deepEqual(run(not, { A: ["#a"] }).messages, []);
});

test("state updates precede later context checks and uncertain branches never prove duplicates", () => {
  const pack = registry(
    variant(undefined, {
      commands: { en: ["START"], de: [] },
      parameters: { mode: { en: "MODE" } },
      updates: [{ key: "started", value: true }],
    }),
    variant(
      { op: "not", condition: { op: "context", key: "started", value: true } },
      { commands: { en: ["NEXT"], de: [] }, parameters: {} },
    ),
  );
  const flow = { context: {}, unknownContext: false };
  assert.equal(run(pack, {}, { name: "NEXT", flow }).messages.length, 1);
  run(pack, {}, { name: "START", flow });
  assert.equal(flow.context["$err:started"], true);
  assert.deepEqual(run(pack, {}, { name: "NEXT", flow }).messages, []);
  flow.context["$err:started"] = null;
  assert.deepEqual(run(pack, {}, { name: "NEXT", flow }).messages, []);
  flow.context["$err:started"] = false;
  flow.unknownContext = true;
  assert.deepEqual(run(pack, {}, { name: "NEXT", flow }).messages, []);
});

test("unknown update guards invalidate state and defaults apply only when explicitly configured", () => {
  const pack = registry(
    variant(undefined, {
      when: { op: "eq", param: "mode", value: "DAT" },
      updates: [{ key: "mode", fromParam: "mode" }],
    }),
  );
  const flow = { context: { "$err:mode": "OLD" }, unknownContext: false };
  run(pack, { MODE: ["#kind"] }, { flow });
  assert.equal(flow.context["$err:mode"], null);
  const withDefault = registry(
    variant({ op: "eq", param: "mode", value: "DAT" }, { defaults: { mode: "DAT" } }),
  );
  assert.equal(run(withDefault, {}).messages.length, 1);
  assert.equal(run(withDefault, { MODE: ["#kind"] }).messages.length, 0);
});

test("checks are indexed per native command and incomplete or ambiguous records are ignored", () => {
  const pack = registry(variant({ op: "lt", param: "first", value: 0 }));
  const result = run(pack, { A: ["-1"] }, { name: "UNRELATED" });
  assert.deepEqual([...result.engine.byCommand.keys()], ["LOAD"]);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(run(pack, { A: ["-1"] }, { record: { continued: true } }).messages, []);
  assert.deepEqual(run(pack, { A: ["-1"] }, { record: { ambiguous: true } }).messages, []);
});

test("invalid registry predicates fail at compilation instead of silently weakening checks", () => {
  assert.throws(
    () => run(registry(variant({ op: "eq", param: "typo", value: 1 })), {}),
    /Unknown logical parameter/,
  );
  assert.throws(
    () => run(registry(variant({ op: "eval-js", param: "first" })), {}),
    /Invalid predicate/,
  );
});

test("command guards use native names and prefix checks require a known identifier", () => {
  const pack = registry(
    variant(
      { op: "not", condition: { op: "prefix", param: "mode", values: ["G", "Q"] } },
      { when: { op: "command", values: ["LOAD", "LAST"] } },
    ),
  );
  assert.deepEqual(run(pack, { MODE: ["G_1"] }).messages, []);
  assert.equal(run(pack, { MODE: ["A_1"] }).messages.length, 1);
  assert.equal(run(pack, { ART: ["A_1"] }, { language: "de", name: "LAST" }).messages.length, 1);
  assert.deepEqual(run(pack, { MODE: ["#action"] }).messages, []);
  assert.deepEqual(run(pack, { MODE: ["'some prose'"] }).messages, []);
});

test("comparison operands can reference tracked state without inventing a missing numeric value", () => {
  const pack = registry(
    variant({
      op: "compare",
      left: { param: "first" },
      right: { context: "number" },
      relation: "eq",
    }),
  );
  const flow = { context: { "$err:number": 7 }, unknownContext: false };
  assert.equal(run(pack, { A: ["7"] }, { flow }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["8"] }, { flow }).messages, []);
  assert.deepEqual(run(pack, { A: ["#number"] }, { flow }).messages, []);
  assert.deepEqual(run(pack, { A: ["0"] }).messages, []);
  flow.unknownContext = true;
  assert.deepEqual(run(pack, { A: ["7"] }, { flow }).messages, []);
});

test("pattern constraints validate known strings and skip numbers and unresolved values", () => {
  const pack = registry(
    variant({ op: "not", condition: { op: "pattern", param: "mode", value: "^[A-Za-z]" } }),
  );
  assert.deepEqual(run(pack, { MODE: ["G_1"] }).messages, []);
  assert.equal(run(pack, { MODE: ["'0NAME'"] }).messages.length, 1);
  assert.deepEqual(run(pack, { MODE: ["#action"] }).messages, []);
  assert.deepEqual(run(pack, { MODE: ["7"] }).messages, []);
});

test("numeric allowed sets do not reject nonnumeric aliases or quoted numeric strings", () => {
  const pack = registry(
    variant({ op: "not", condition: { op: "in", param: "first", values: [0.2, 0.3] } }),
  );
  assert.equal(run(pack, { A: ["0.4"] }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["0.2"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["ELAS"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["'0.4'"] }).messages, []);
  const guard = registry(variant({ op: "number", param: "first" }));
  assert.equal(run(guard, { A: ["0.4"] }).messages.length, 1);
  assert.deepEqual(run(guard, { A: ["ELAS"] }).messages, []);
  assert.deepEqual(run(guard, { A: ["#value"] }).messages, []);
  const different = registry(variant({ op: "ne", param: "first", value: 0 }));
  assert.deepEqual(run(different, { A: ["'0'"] }).messages, []);
  assert.deepEqual(run(different, { A: ["NONE"] }).messages, []);
});

test("cross-record bindings use the schema union and observer updates ignore child-check guards", () => {
  const pack = registry(
    variant(
      {
        op: "all",
        conditions: [
          { op: "context", key: "mode", value: "DAT" },
          { op: "lt", param: "first", value: 0 },
        ],
      },
      {
        commands: { en: ["START", "LOAD"], de: [] },
        parameters: { first: { en: "A" }, mode: { en: "MODE" } },
        when: { op: "command", values: ["LOAD"] },
        updates: [{ key: "mode", fromParam: "mode", when: { op: "command", values: ["START"] } }],
      },
    ),
  );
  const flow = { context: {}, unknownContext: false };
  const observed = run(pack, { MODE: ["DAT"] }, { name: "START", flow });
  assert.deepEqual([...observed.engine.byCommand.keys()], ["START", "LOAD"]);
  assert.equal(flow.context["$err:mode"], "DAT");
  assert.deepEqual(observed.messages, []);
  assert.equal(run(pack, { A: ["-1"] }, { flow }).messages.length, 1);
  assert.equal(flow.context["$err:mode"], "DAT");
});

test("nativeCommand selects implicit German rows while explicit guards exclude rows and headers", () => {
  const pack = registry(
    variant({ op: "lt", param: "first", value: 0 }, { when: { op: "command", values: ["LAST"] } }),
  );
  const row = { name: "17", nativeCommand: "LAST", command: "LOAD", kind: "record" };
  assert.equal(run(pack, { X: ["-1"] }, { language: "de", record: row }).messages.length, 1);
  const explicit = registry(
    variant({ op: "lt", param: "first", value: 0 }, { when: { op: "explicit" } }),
  );
  assert.deepEqual(
    run(explicit, { A: ["-1"] }, { record: { kind: "record", nativeCommand: "LOAD" } }).messages,
    [],
  );
  assert.deepEqual(
    run(explicit, { A: ["-1"] }, { record: { kind: "command", tableHeader: true } }).messages,
    [],
  );
  assert.equal(run(explicit, { A: ["-1"] }, { record: { kind: "command" } }).messages.length, 1);
});

test("ambiguous or unfinished observers make context unknown while table headers have no effects", () => {
  const pack = registry(
    variant(undefined, {
      commands: { en: ["START"], de: [] },
      parameters: { mode: { en: "MODE" } },
      updates: [{ key: "started", value: true }],
    }),
    variant(
      { op: "not", condition: { op: "context", key: "started", value: true } },
      { commands: { en: ["NEXT"], de: [] }, parameters: {} },
    ),
  );
  for (const flag of ["ambiguous", "continued"]) {
    const flow = { context: {}, unknownContext: false };
    assert.deepEqual(run(pack, {}, { name: "START", flow, record: { [flag]: true } }).messages, []);
    assert.equal(flow.context["$err:started"], null);
    assert.deepEqual(run(pack, {}, { name: "NEXT", flow }).messages, []);
  }
  const flow = { context: {}, unknownContext: false };
  run(pack, {}, { name: "START", flow, record: { header: true } });
  assert.deepEqual(flow.context, {});
  assert.equal(run(pack, {}, { name: "NEXT", flow }).messages.length, 1);
});

test("integer predicates accept literal integers and leave computed or nonnumeric values unknown", () => {
  const pack = registry(
    variant({
      op: "all",
      conditions: [
        { op: "integer", param: "first" },
        { op: "gt", param: "first", value: 1 },
      ],
    }),
  );
  assert.equal(run(pack, { A: ["2"] }).messages.length, 1);
  assert.deepEqual(run(pack, { A: ["2.5"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["1"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["#number"] }).messages, []);
  assert.deepEqual(run(pack, { A: ["AUTO"] }).messages, []);
});

test("unit overrides suppress implicit magnitudes while presence and dimensionless controls remain known", () => {
  const unitKeywords = {
    getCommandSchema(module, command) {
      if (module !== "TEST" || command !== "LOAD") return null;
      return {
        forms: [
          {
            slots: [
              { name: "A", dataTypeCode: "1299" },
              { name: "B", dataTypeCode: "9999" },
              { name: "MODE", dataTypeCode: null },
            ],
          },
        ],
      };
    },
  };
  const pack = registry(
    variant({ op: "lt", param: "first", value: 0 }),
    variant({ op: "lt", param: "second", value: 0 }),
    variant({ op: "absent", param: "first" }),
  );
  const overridden = { context: {}, unknownContext: false, unknownUnits: true };
  const current = run(pack, { A: ["-1"], B: ["-1"] }, { keywords: unitKeywords, flow: overridden });
  assert.deepEqual(
    current.messages.map((item) => item.id),
    ["rule-1"],
  );
  const missing = run(pack, { B: ["1"] }, { keywords: unitKeywords, flow: overridden });
  assert.deepEqual(
    missing.messages.map((item) => item.id),
    ["rule-2"],
  );
  const defaultUnits = run(pack, { A: ["-1"], B: ["-1"] }, { keywords: unitKeywords });
  assert.deepEqual(
    defaultUnits.messages.map((item) => item.id),
    ["rule-0", "rule-1"],
  );
});

test("unit metadata stays scoped to its native command when observers share parameter names", () => {
  const unitKeywords = {
    getCommandSchema(module, command) {
      if (module !== "TEST" || !["LOAD", "START"].includes(command)) return null;
      return {
        forms: [{ slots: [{ name: "A", dataTypeCode: command === "LOAD" ? "1006" : null }] }],
      };
    },
  };
  const pack = registry(
    variant(
      { op: "lt", param: "first", value: 0 },
      { commands: { en: ["LOAD", "START"] }, parameters: { first: { en: "A" } } },
    ),
  );
  const flow = { context: {}, unknownContext: false, unknownUnits: true };
  assert.deepEqual(run(pack, { A: ["-1"] }, { flow, keywords: unitKeywords }).messages, []);
  assert.equal(
    run(pack, { A: ["-1"] }, { flow, keywords: unitKeywords, name: "START" }).messages.length,
    1,
  );
});

test("actual FEACHECK fraction units become unknown while AQB fixed humidity stays assessable", () => {
  const provider = new SofistikDataProvider();
  const keywords = provider.forRelease("2026", "en");
  const messages = [];
  const flow = { context: {}, unknownContext: false, unknownUnits: true };
  const check = (module, record) =>
    compileRules(module, "2026", "en", keywords).check(record, flow, (id) => messages.push(id));
  check("FEACHECK", { name: "SOFT", params: { MR1L: ["2"], MR1U: ["1"] } });
  assert.equal(messages.includes("feacheck-soft-input"), false);
  check("AQB", { name: "EIGE", params: { RH: ["110"] } });
  assert.ok(messages.includes("aqb-creep-humidity-range"));
  flow.unknownUnits = false;
  check("FEACHECK", { name: "SOFT", params: { MR1L: ["2"], MR1U: ["1"] } });
  assert.ok(messages.includes("feacheck-soft-input"));
});

test("a decisive numeric alternative focuses its actual value instead of a false sibling", () => {
  const pack = registry(
    variant({
      op: "any",
      conditions: [
        { op: "lt", param: "first", value: 0 },
        { op: "gt", param: "second", value: 1 },
      ],
    }),
  );
  const record = {
    start: 10,
    end: 40,
    commandRange: { start: 10, end: 14 },
    paramRanges: { A: { start: 17, end: 18 }, B: { start: 21, end: 24 } },
  };
  const selected = run(pack, { A: ["0"], B: ["2.5"] }, { record });
  assert.deepEqual(selected.messages[0].focus, { start: 21, end: 24 });
  const ambiguous = run(pack, { A: ["-1"], B: ["2.5"] }, { record });
  assert.equal(ambiguous.messages[0].focus, undefined);
});

test("required fields and context prerequisites focus the command without inventing a missing span", () => {
  const record = { start: 10, end: 30, commandRange: { start: 10, end: 14 }, paramRanges: {} };
  const missing = registry(variant({ op: "absent", param: "first" }));
  assert.deepEqual(run(missing, {}, { record }).messages[0].focus, record.commandRange);
  const context = registry(variant({ op: "context", key: "active", value: false }));
  assert.deepEqual(run(context, {}, { record }).messages[0].focus, record.commandRange);
  const conditional = registry(
    variant({
      op: "all",
      conditions: [
        { op: "eq", param: "mode", value: "DAT" },
        { op: "absent", param: "first" },
      ],
    }),
  );
  assert.deepEqual(
    run(
      conditional,
      { MODE: ["DAT"] },
      { record: { ...record, paramRanges: { MODE: { start: 20, end: 23 } } } },
    ).messages[0].focus,
    record.commandRange,
  );
});

test("cross-field comparisons and invalid ranges keep whole-record fallback", () => {
  const compare = registry(
    variant({ op: "compare", left: "first", right: "second", relation: "gt" }),
  );
  const record = {
    start: 10,
    end: 30,
    commandRange: { start: 10, end: 14 },
    paramRanges: { A: { start: 17, end: 18 }, B: { start: 21, end: 22 } },
  };
  assert.equal(run(compare, { A: ["2"], B: ["1"] }, { record }).messages[0].focus, undefined);
  const numeric = registry(variant({ op: "lt", param: "first", value: 0 }));
  assert.equal(
    run(numeric, { A: ["-1"] }, { record: { ...record, paramRanges: { A: { start: 0, end: 2 } } } })
      .messages[0].focus,
    undefined,
  );
});

test("real ERR numeric and selector families retain exact parameter spans in related information", () => {
  const engine = new LintEngine();
  const humidity = engine
    .analyze({ uri: "file:///focus.dat", text: "+PROG AQB\nEIGE RH 110\nEND\n" })
    .diagnostics.find((item) => item.code === "aqb-creep-humidity-range");
  assert.ok(humidity);
  assert.deepEqual(humidity.data.focusOrigin.range, {
    start: { line: 1, character: 8 },
    end: { line: 1, character: 11 },
  });
  const selector = engine
    .analyze({ uri: "file:///focus.dat", text: "+PROG COLUMN\nFIRE R 45\nEND\n" })
    .diagnostics.find((item) => item.code === "column-fire-class-supported");
  assert.ok(selector);
  assert.deepEqual(selector.data.focusOrigin.range, {
    start: { line: 1, character: 7 },
    end: { line: 1, character: 9 },
  });
});

test("real ERR missing-field and missing-parent families retain command blame", () => {
  const engine = new LintEngine();
  const required = engine
    .analyze({ uri: "file:///focus.dat", text: "+PROG RELY\nVAR TYPE NORM P1 1 P2 0.1\nEND\n" })
    .diagnostics.find((item) => item.code === "rely-var-name-required");
  assert.ok(required);
  assert.deepEqual(required.data.focusOrigin.range, {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 3 },
  });
  const parent = engine
    .analyze({ uri: "file:///focus.dat", text: "+PROG AQUA\nVERT NO 1 Y 0 Z 0\nEND\n" })
    .diagnostics.find((item) => item.code === "vertex-without-polygon");
  assert.ok(parent);
  assert.deepEqual(parent.data.focusOrigin.range, {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 4 },
  });
});

test("parameter focus follows semicolon records, continuations and implicit table rows", () => {
  const engine = new LintEngine();
  const cases = [
    { source: "+PROG AQB\nEIGE RH 50; EIGE RH 110\nEND\n", line: 1, start: 20, end: 23 },
    { source: "+PROG AQB\nEIGE MNO 1 $$\nRH 110\nEND\n", line: 2, start: 3, end: 6 },
    { source: "+PROG AQB\nEIGE RH TEMP\n110 20\nEND\n", line: 2, start: 0, end: 3 },
  ];
  for (const item of cases) {
    const issue = engine
      .analyze({ uri: "file:///focus.dat", text: item.source })
      .diagnostics.find((diagnostic) => diagnostic.code === "aqb-creep-humidity-range");
    assert.ok(issue, item.source);
    assert.deepEqual(
      issue.data.focusOrigin.range,
      {
        start: { line: item.line, character: item.start },
        end: { line: item.line, character: item.end },
      },
      item.source,
    );
  }
});

test("real multi-field conflicts retain the complete record as their focus", () => {
  const engine = new LintEngine();
  const cases = [
    {
      module: "DBPRIN",
      body: "ITEM TYPE BEAM KIND STIF",
      rule: "dbprin-beam-stiffness-unsupported",
    },
    { module: "FEACHECK", body: "SOFT MR1L 2 MR1U 1", rule: "feacheck-soft-input" },
  ];
  for (const item of cases) {
    const issue = engine
      .analyze({ uri: "file:///focus.dat", text: `+PROG ${item.module}\n${item.body}\nEND\n` })
      .diagnostics.find((diagnostic) => diagnostic.code === item.rule);
    assert.ok(issue);
    const whole = {
      start: { line: 1, character: 0 },
      end: { line: 1, character: item.body.length },
    };
    assert.deepEqual(issue.data.focusOrigin.range, whole);
    assert.deepEqual(issue.data.recordOrigin.range, whole);
  }
});
