"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { LintEngine } = require("../lib/lint-engine");
const { compileRules } = require("../lib/err-rule-engine");
const { preprocess } = require("../lib/preprocessor");
const registry = require("../lib/err-rules.json");
const fixtures = require("./err-rule-fixtures.json");
const audit = require("../docs/err-rule-audit.json");

const provider = new SofistikDataProvider();
const modulesFor = (rule) => (Array.isArray(rule.module) ? rule.module : [rule.module]);
const testedVariants = new Set();
let matrixCases = 0;

function translateBody(text, variant, rule, language) {
  if (language !== "de") return text;
  for (const binding of Object.values(variant.parameters || {})) {
    if (binding.en && binding.de && binding.en !== binding.de)
      text = text.replace(new RegExp(`\\b${binding.en}\\b`, "g"), binding.de);
  }
  const english = variant.commands.en?.[0];
  const german = variant.commands.de?.[0];
  if (english && german && english !== german)
    text = text.replace(new RegExp(`\\b${english}\\b`, "g"), german);
  // These literals are explicitly paired in DBPRIN's bilingual ERR grammar;
  // alphabetical positions in enum lists cannot supply a translation.
  if (rule.id === "dbprin-beam-stiffness-unsupported") {
    for (const [englishLiteral, germanLiteral] of Object.entries({
      BEAM: "STAB",
      STIF: "STEI",
      NODE: "KNOT",
      DISP: "VERS",
      FORC: "SCHN",
    }))
      text = text.replace(new RegExp(`\\b${englishLiteral}\\b`, "g"), germanLiteral);
  }
  return text;
}

function casesFor(rule, variant, metadata, language) {
  const examples = metadata.fixtures?.[language] || metadata.fixtures || {};
  const nativeExamples = Boolean(metadata.fixtures?.[language]);
  return ["invalid", "valid", "dynamic"].flatMap((kind) =>
    (examples[kind] || []).map((text) => ({
      kind,
      text: nativeExamples ? text : translateBody(text, variant, rule, language),
    })),
  );
}

function input(text, module, language) {
  return /^\s*[+$-]?PROG\b/im.test(text)
    ? text + "\n"
    : `+PROG ${module}\n${text}\n${language === "de" ? "ENDE" : "END"}\n`;
}

async function analyze(engine, text, version = "2026", language = "en") {
  const uri = "file:///err-rule-fixture.dat";
  const expanded = await preprocess({ uri, text }, { readSource: async () => null });
  return engine.analyze({
    ...expanded,
    uri,
    version,
    language,
    keywords: provider.forRelease(version, language),
  });
}

for (const rule of registry.rules) {
  test(`ERR ${rule.id}: real preprocessing and lint across every verified release and language`, async () => {
    const engine = new LintEngine();
    const metadata = fixtures[rule.id];
    assert.ok(Array.isArray(metadata), `Missing fixtures for ${rule.id}`);
    assert.equal(metadata.length, rule.variants.length, `Fixture variants drifted for ${rule.id}`);
    for (let index = 0; index < rule.variants.length; index++) {
      const variant = rule.variants[index];
      if (variant.invalid === undefined) continue;
      for (const version of variant.versions) {
        for (const language of Object.keys(variant.commands)) {
          if (!variant.commands[language].length) continue;
          const examples = casesFor(rule, variant, metadata[index], language);
          assert.ok(
            examples.some(({ kind }) => kind === "invalid"),
            `No negative fixture for ${rule.id}/${index}/${language}`,
          );
          assert.ok(
            examples.some(({ kind }) => kind === "valid"),
            `No positive fixture for ${rule.id}/${index}/${language}`,
          );
          assert.ok(
            examples.some(({ kind }) => kind === "dynamic"),
            `No unknown-value fixture for ${rule.id}/${index}/${language}`,
          );
          for (const module of modulesFor(rule)) {
            const compiled = compileRules(
              module,
              version,
              language,
              provider.forRelease(version, language),
            );
            assert.ok(
              compiled.rules.some(({ rule: active }) => active.id === rule.id),
              `Rule dropped by schema: ${rule.id}/${module}/${version}/${language}`,
            );
            for (const example of examples) {
              const text = input(example.text, module, language);
              const result = await analyze(engine, text, version, language);
              const found = result.diagnostics.some((issue) => issue.code === rule.id);
              assert.equal(
                found,
                example.kind === "invalid",
                `${rule.id}/${module}/${version}/${language}/${example.kind}\n${text}\n${JSON.stringify(result.diagnostics)}`,
              );
              matrixCases++;
            }
            testedVariants.add(`${rule.id}:${index}:${version}:${language}:${module}`);
          }
        }
      }
    }
  });
}

test("all checking variants have matrix coverage and unsupported releases activate no ERR rule", (t) => {
  for (const rule of registry.rules) {
    for (let index = 0; index < rule.variants.length; index++) {
      const variant = rule.variants[index];
      if (variant.invalid === undefined) continue;
      for (const version of variant.versions)
        for (const language of Object.keys(variant.commands))
          for (const module of modulesFor(rule)) {
            if (!variant.commands[language].length) continue;
            assert.ok(testedVariants.has(`${rule.id}:${index}:${version}:${language}:${module}`));
          }
    }
    for (const module of modulesFor(rule))
      assert.equal(
        compileRules(module, "2099", "en", provider.forRelease("2026", "en")).rules.length,
        0,
      );
  }
  assert.ok(
    matrixCases > 1000,
    "The registry must be exercised through its complete fixture matrix.",
  );
  t.diagnostic(`${matrixCases} complete preprocessing/lint fixture cases passed.`);
});

test("public ERR codes are unique letter prefixes and every public schema module has a prefix", () => {
  const codes = registry.rules.map((rule) => rule.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((code) => typeof code === "string" && /^[A-Z]+\d{3}$/.test(code)));
  const prefixes = Object.values(registry.modulePrefixes);
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const version of registry.releases)
    for (const language of ["en", "de"]) {
      const keywords = provider.forRelease(version, language);
      for (const module of keywords.getModuleNames()) {
        const canonical = keywords.base.normalizeModuleName(module);
        assert.ok(
          registry.modulePrefixes[canonical],
          `No diagnostic prefix for ${module}/${version}/${language}`,
        );
      }
    }
});

test("audit covers every source catalogue and rule evidence matches committed release digests", () => {
  const metadata = provider.getMetadata();
  const expected = new Set(
    Object.values(metadata.provenance.releases).flatMap((release) =>
      release.catalogues.map((catalogue) => catalogue.file),
    ),
  );
  const reviewed = new Set(
    audit.coverage.map((item) => `${String(item.errModule || item.module).toLowerCase()}.err`),
  );
  assert.deepEqual([...reviewed].sort(), [...expected].sort());
  for (const rule of registry.rules) {
    const references = audit.evidence[rule.id];
    assert.ok(references?.length, `No source evidence for ${rule.id}`);
    for (const variant of rule.variants)
      for (const version of variant.versions)
        assert.ok(
          references.some((reference) => reference.version === version),
          `Unverified release ${rule.id}/${version}`,
        );
    for (const reference of references) {
      const filename = (reference.catalog || reference.file).split("/").at(-1);
      const catalogue = metadata.provenance.releases[reference.version].catalogues.find(
        (source) => source.file === filename,
      );
      assert.equal(
        reference.sha256,
        catalogue?.sha256,
        `Source changed: ${rule.id}/${reference.version}/${filename}`,
      );
    }
  }
});

test("numeric rules preserve unresolved expressions and units without calculating CADINP", async () => {
  const engine = new LintEngine();
  for (const value of ["110/2", "#humidity", "110[%]", "'110'", "''110''"]) {
    const result = await analyze(engine, `+PROG AQB\nEIGE RH ${value}\nEND\n`);
    assert.equal(
      result.diagnostics.some((issue) => issue.code === "aqb-creep-humidity-range"),
      false,
      value,
    );
  }
  const old = await analyze(engine, "+PROG DBMERG\nLC NO -1\nEND\n", "2018");
  assert.equal(
    old.diagnostics.some((issue) => issue.code === "dbmerg-negative-load-case"),
    false,
  );
  const current = await analyze(engine, "+PROG DBMERG\nLC NO -1\nEND\n", "2025");
  assert.ok(current.diagnostics.some((issue) => issue.code === "dbmerg-negative-load-case"));
});

test("implicit unit overrides inhibit converted bounds and persist across intermediate END", async () => {
  const source =
    "+PROG FEACHECK\nUNIT 1299 1\nSOFT SRX1 -1\nEND\nSOFT SRX1 -1\n+PROG FEACHECK\nSOFT SRX1 -1\nEND\n";
  const result = await analyze(new LintEngine(), source);
  const findings = result.diagnostics.filter((issue) => issue.code === "feacheck-soft-input");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].range.start.line, 6);
  const uncertain = await analyze(
    new LintEngine(),
    "+PROG FEACHECK\n#include 'missing.inc'\nSOFT SRX1 -1\nEND\n",
  );
  assert.equal(
    uncertain.diagnostics.some((issue) => issue.code === "feacheck-soft-input"),
    false,
  );
});

test("a changed NORM unit selection invalidates following unit-dependent cached modules", async () => {
  const engine = new LintEngine();
  const original = "+PROG AQUA\nNORM DC EN\nEND\n+PROG FEACHECK\nSOFT SRX1 -1\nEND\n";
  assert.ok(
    (await analyze(engine, original)).diagnostics.some(
      (issue) => issue.code === "feacheck-soft-input",
    ),
  );
  const changed = await analyze(engine, original.replace("NORM DC EN", "NORM DC EN UNIT 5"));
  assert.equal(
    changed.diagnostics.some((issue) => issue.code === "feacheck-soft-input"),
    false,
  );
  assert.equal(changed.metrics.reusedModules, 0);
});

test("table headers are inert while implicit rows still receive numeric diagnostics", async () => {
  const engine = new LintEngine();
  const rows = await analyze(engine, "+PROG AQB\nEIGE RH TEMP\n110 20\n50 20\nEND\n");
  const issues = rows.diagnostics.filter((issue) => issue.code === "aqb-creep-humidity-range");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].data.recordOrigin.range.start.line, 2);
  const header = await analyze(engine, "+PROG STAR\nNSTR KMIN KMAX\n0.5 2\n0.6 2\nEND\n");
  assert.equal(
    header.diagnostics.some((issue) => issue.code === "star-one-nstr"),
    false,
  );
});

test("joined branch contexts do not prove a duplicate until a definite later declaration", async () => {
  const engine = new LintEngine();
  const source = "+PROG STAR\nLET#flag 1\nIF #flag\nNSTR KMIN 0.5\nENDIF\nNSTR KMIN 0.6\nEND\n";
  const uncertain = await analyze(engine, source);
  assert.equal(
    uncertain.diagnostics.some((issue) => issue.code === "star-one-nstr"),
    false,
  );
  const definite = await analyze(
    engine,
    source.replace("NSTR KMIN 0.6\nEND", "NSTR KMIN 0.6\nNSTR KMIN 0.7\nEND"),
  );
  const issues = definite.diagnostics.filter((issue) => issue.code === "star-one-nstr");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].data.recordOrigin.range.start.line, 6);
});

test("local UNIT uncertainty survives END but resets at the next PROG", async () => {
  const engine = new LintEngine();
  const result = await analyze(
    engine,
    "+PROG FEACHECK\nUNIT 1299 1\nEND\nSOFT MR1L 2 MR1U 1\nEND\n+PROG FEACHECK\nSOFT MR1L 2 MR1U 1\nEND\n",
  );
  const issues = result.diagnostics.filter((item) => item.code === "feacheck-soft-input");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].data.recordOrigin.range.start.line, 6);
});

test("a global NORM UNIT change invalidates a later unchanged module's cached assumptions", async () => {
  const engine = new LintEngine();
  const source = "+PROG AQUA\nNORM DC EN\nEND\n+PROG FEACHECK\nSOFT MR1L 2 MR1U 1\nEND\n";
  const original = await analyze(engine, source);
  assert.ok(original.diagnostics.some((item) => item.code === "feacheck-soft-input"));
  const changed = await analyze(engine, source.replace("NORM DC EN", "NORM DC EN UNIT 5"));
  assert.equal(
    changed.diagnostics.some((item) => item.code === "feacheck-soft-input"),
    false,
  );
});

test("a possible branch unit override prevents assuming the original implicit scale", async () => {
  const engine = new LintEngine();
  const result = await analyze(
    engine,
    "+PROG FEACHECK\nLET#flag 1\nIF #flag\nUNIT 1299 1\nENDIF\nSOFT MR1L 2 MR1U 1\nEND\n",
  );
  assert.equal(
    result.diagnostics.some((item) => item.code === "feacheck-soft-input"),
    false,
  );
});

test("unavailable input may change implicit units and suppresses dependent numeric conclusions", async () => {
  const engine = new LintEngine();
  const result = await analyze(
    engine,
    "+PROG FEACHECK\n#INCLUDE 'missing.dat'\nSOFT MR1L 2 MR1U 1\nEND\n",
  );
  assert.equal(
    result.diagnostics.some((item) => item.code === "feacheck-soft-input"),
    false,
  );
});
