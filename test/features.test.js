const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { createIndex } = require("../lib/finder");
const { signatureHelp, completion, hover, semanticTokens } = require("../lib/features");

const keywords = new SofistikDataProvider().forRelease("2026", "en");

function projectFor(module, record) {
  const text = `+PROG ${module}\n${record}\nEND\n`;
  const index = createIndex(text, { version: "2026", language: "en", keywords });
  return {
    loadDocument: async () => ({
      text,
      index,
      target: { version: "2026", language: "en", keywords },
    }),
    settings: { textCase: "upper" },
  };
}

test("signature help selects the real BDK EIGE form containing the named parameters", async () => {
  const firstRecord = "EIGE TYPE 1 NEIG ";
  const first = await signatureHelp(projectFor("BDK", firstRecord), "untitled:fixture", {
    line: 1,
    character: firstRecord.length,
  });
  assert.equal(first.activeSignature, 0);
  assert.equal(first.activeParameter, 1);
  const secondRecord = "EIGE BEAM 1 LC 2 TYPE ";
  const second = await signatureHelp(projectFor("BDK", secondRecord), "untitled:fixture", {
    line: 1,
    character: secondRecord.length,
  });
  assert.equal(second.signatures.length, 2);
  assert.equal(second.activeSignature, 1);
  assert.equal(second.activeParameter, 2);
});

test("completion distinguishes a named enum value from the next parameter", async () => {
  const valueRecord = "GRP NO 1 VAL ";
  const values = await completion(projectFor("ASE", valueRecord), "untitled:fixture", {
    line: 1,
    character: valueRecord.length,
  });
  assert.ok(values.some((item) => item.label === "FULL"));
  assert.ok(values.every((item) => item.kind === 20));
  const parameterRecord = "GRP NO 1 VAL FULL ";
  const parameters = await completion(projectFor("ASE", parameterRecord), "untitled:fixture", {
    line: 1,
    character: parameterRecord.length,
  });
  assert.ok(parameters.some((item) => item.label === "FACS"));
  assert.ok(parameters.every((item) => item.kind === 5));
});

test("positional GRP values advance after named slots across hover, signatures and semantic tokens", async () => {
  const records = [
    "GRP NUMB 57 OFF SPRI",
    "GRP NUMB 57 OPTI OFF SPRI",
    "GRP NUMB 57 OPTI OFF etyp SPRI",
    "GRP 57 OFF SPRI",
  ];
  for (const module of ["RESULTS", "WING"]) {
    const slots = keywords.getCommandSchema(module, "GRP").forms[0].slots;
    for (const record of records) {
      const project = projectFor(module, record);
      const message = `${module}: ${record}`;
      for (const [activeParameter, value] of ["57", "OFF", "SPRI"].entries()) {
        const position = { line: 1, character: record.indexOf(value) + 1 };
        const result = await hover(project, "untitled:fixture", position);
        const slot = slots[activeParameter];
        assert.equal(
          result.contents.value,
          `${module} · GRP · ${slot.name} /${activeParameter + 1}` +
            (slot.enumValues.length ? `\n\n${slot.enumValues.join(", ")}` : ""),
          message,
        );
        const signature = await signatureHelp(project, "untitled:fixture", position);
        assert.equal(signature.activeParameter, activeParameter, `${message}: ${value}`);
      }
      const off = record.indexOf("OFF");
      const spri = record.indexOf("SPRI");
      const expectedTokens = { data: [1, off, 3, 0, 0, 0, spri - off, 4, 0, 0] };
      const entry = await project.loadDocument();
      assert.deepEqual(semanticTokens(entry), expectedTokens, message);
      assert.deepEqual(
        semanticTokens(entry, {
          start: { line: 1, character: off },
          end: { line: 1, character: spri + 4 },
        }),
        expectedTokens,
        message,
      );
      for (const value of ["OFF", "SPRI"]) {
        const partial = record.replace(value, value.slice(0, 2));
        const items = await completion(projectFor(module, partial), "untitled:fixture", {
          line: 1,
          character: record.indexOf(value) + 2,
        });
        assert.ok(
          items.some((item) => item.label === value && item.kind === 20),
          `${message}: ${value}`,
        );
      }
    }
  }
});

test("comma alternatives retain one GRP slot across language features and advance the following slot once", async () => {
  const cases = [
    { record: "GRP NUMB 31+#grp YES BEAM,GLN SING" },
    { record: "GRP NUMB 31+#grp YES BEAM, GLN SING" },
    { record: "GRP NUMB 31+#grp YES,OFF BEAM,GLN SING" },
    { record: "GRP NUMB 31+#grp OPTI YES, OFF ETYP BEAM, GLN GDIV SING" },
    { record: "GRP NUMB 31+#grp YES BEAM,'GLN' SING", quoted: "GLN" },
    { record: "GRP NUMB 31+#grp YES 'BEAM',GLN SING", quoted: "BEAM" },
  ];
  for (const { record, quoted } of cases) {
    const project = projectFor("WING", record);
    const values = [
      ["YES", "OPTI", 1],
      ["OFF", "OPTI", 1],
      ["BEAM", "ETYP", 2],
      ["GLN", "ETYP", 2],
      ["SING", "GDIV", 3],
    ].filter(([value]) => record.includes(value));
    const entry = await project.loadDocument();
    const expected = [];
    let previousCharacter = 0;
    for (const [value, parameter, activeParameter] of values) {
      const start = record.indexOf(value);
      const position = { line: 1, character: start + 1 };
      const result = await hover(project, "untitled:fixture", position);
      assert.equal(
        result.contents.value.split("\n")[0],
        `WING · GRP · ${parameter} /${activeParameter + 1}`,
        `${record}: ${value}`,
      );
      const signature = await signatureHelp(project, "untitled:fixture", position);
      assert.equal(signature.activeParameter, activeParameter, `${record}: ${value}`);
      const completions = await completion(project, "untitled:fixture", {
        line: 1,
        character: start + 2,
      });
      const item = completions.find((candidate) => candidate.label === value);
      assert.equal(item?.kind, 20, `${record}: ${value}`);
      assert.deepEqual(
        item.textEdit.range,
        { start: { line: 1, character: start }, end: { line: 1, character: start + 2 } },
        `${record}: ${value}`,
      );
      assert.deepEqual(
        semanticTokens(entry, {
          start: { line: 1, character: start },
          end: { line: 1, character: start + value.length },
        }),
        { data: value === quoted ? [] : [1, start, value.length, 0, 0] },
        `${record}: ${value}`,
      );
      if (value !== quoted) {
        expected.push(expected.length ? 0 : 1, start - previousCharacter, value.length, 0, 0);
        previousCharacter = start;
      }
    }
    assert.deepEqual(semanticTokens(entry), { data: expected }, record);
    assert.deepEqual(
      semanticTokens(entry, {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 0 },
      }),
      { data: expected },
      record,
    );
  }
});

test("completion after a comma inserts a new alternative without replacing the comma", async () => {
  for (const record of ["GRP NUMB 57 YES BEAM,", "GRP NUMB 57 YES BEAM, "]) {
    const position = { line: 1, character: record.length };
    const items = await completion(projectFor("WING", record), "untitled:fixture", position);
    assert.ok(items.length > 1, record);
    assert.ok(
      items.every((item) => item.kind === 20),
      record,
    );
    const gln = items.find((item) => item.label === "GLN");
    assert.ok(gln, record);
    assert.deepEqual(gln.textEdit.range, { start: position, end: position }, record);
  }
});

test("parameter completion keeps canonical slot order and conveys it through sortText", async () => {
  const record = "GRP NO 1 VAL FULL ";
  const items = await completion(projectFor("ASE", record), "untitled:fixture", {
    line: 1,
    character: record.length,
  });
  const names = keywords
    .getCommandSchema("ASE", "GRP")
    .forms[0].slots.map((slot) => slot.name)
    .filter(Boolean);
  assert.deepEqual(
    items.map((item) => item.label),
    names,
  );
  assert.deepEqual(
    items.slice(0, 4).map((item) => item.sortText),
    ["000000", "000001", "000002", "000003"],
  );
  assert.deepEqual(
    [...items].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label),
    names,
  );
});

test("fresh filtered completions preserve the same canonical rank as the unfiltered fields", async () => {
  const record = "GRP NO 1 F";
  const items = await completion(projectFor("ASE", record), "untitled:fixture", {
    line: 1,
    character: record.length,
  });
  assert.deepEqual(
    items.map((item) => item.label),
    ["FACS", "FACL", "FACD", "FACP", "FACT", "FACB"],
  );
  assert.equal(items[0].sortText, "000002");
  assert.equal(items.at(-1).sortText, "000028");
  const second = "GRP NO 1 PH";
  const ph = await completion(projectFor("ASE", second), "untitled:fixture", {
    line: 1,
    character: second.length,
  });
  assert.deepEqual(
    ph.map((item) => item.label),
    ["PHI", "PHIF", "PHIS"],
  );
  const value = "GRP NO 1 VAL F";
  const values = await completion(projectFor("ASE", value), "untitled:fixture", {
    line: 1,
    character: value.length,
  });
  assert.deepEqual(
    values.map((item) => item.label),
    ["FULL"],
  );
  assert.ok(values.every((item) => item.kind === 20));
});

test("compact parameter hover uses slash position and a complete naturally wrapping enum list", async () => {
  const project = projectFor("AQUA", "CONC NO 1 TYPE C");
  const result = await hover(project, "untitled:fixture", { line: 1, character: 12 });
  const values = keywords
    .getCommandSchema("AQUA", "CONC")
    .forms[0].slots.find((slot) => slot.name === "TYPE").enumValues;
  assert.equal(values.length, 69);
  assert.deepEqual(result.contents, {
    kind: "plaintext",
    value: `AQUA · CONC · TYPE /2\n\n${values.join(", ")}`,
  });
  assert.doesNotMatch(result.contents.value, /Slot|Catalogue type|2026|\bEN\b|…/);
  assert.ok(result.contents.value.endsWith("SSNI"));
});

test("hover stays quiet on modules, whitespace, comments and unrelated prose", async () => {
  const record = "GRP NO 1 VAL FULL $ a comment";
  const project = projectFor("ASE", record);
  for (const position of [
    { line: 0, character: 7 },
    { line: 1, character: 3 },
    { line: 1, character: 12 },
    { line: 1, character: 22 },
  ])
    assert.equal(await hover(project, "untitled:fixture", position), null);
  assert.equal(
    await hover(projectFor("ASE", "HEAD 'GRP FULL'"), "untitled:fixture", {
      line: 1,
      character: 7,
    }),
    null,
  );
  const number = await hover(project, "untitled:fixture", { line: 1, character: 7 });
  assert.equal(number.contents.value, "ASE · GRP · NO /1");
});

test("record hover lists complete LC and TRAI keys in schema order, including named text fields", async () => {
  for (const command of ["LC", "TRAI"]) {
    const schema = keywords.getCommandSchema("SOFILOAD", command);
    const names = schema.forms[0].slots.filter((slot) => slot.name).map((slot) => slot.name);
    const record = `${command.toLowerCase()} `;
    const result = await hover(projectFor("SOFILOAD", record), "untitled:fixture", {
      line: 1,
      character: 1,
    });
    assert.deepEqual(result.contents, {
      kind: "plaintext",
      value: `SOFILOAD · ${command}\n\n${names.join(", ")}`,
    });
    assert.deepEqual(result.range, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: command.length },
    });
    assert.doesNotMatch(result.contents.value, /Catalogue|Slot|2026|\bEN\b|…/);
    if (command === "LC") assert.equal(names.at(-1), "TITL");
    if (command === "TRAI") assert.equal(names.length, 29);
  }
});

test("record hover retains alternative form layouts without narrowing to typed parameters", async () => {
  const result = await hover(projectFor("BDK", "EIGE BEAM 1 LC 2"), "untitled:fixture", {
    line: 1,
    character: 1,
  });
  assert.equal(
    result.contents.value,
    "BDK · EIGE\n\nTYPE, NEIG, LCB\n\nBEAM, LC, TYPE, HORD, DNO, ENO",
  );
});

test("record hover rejects partial or unknown records and does not turn prose into record keys", async () => {
  for (const record of ["L", "UNKNOWN", "TRAI"]) {
    assert.equal(
      await hover(projectFor("ASE", record), "untitled:fixture", { line: 1, character: 0 }),
      null,
    );
  }
  assert.equal(
    await hover(projectFor("SOFILOAD", "HEAD 'LC TRAI'"), "untitled:fixture", {
      line: 1,
      character: 7,
    }),
    null,
  );
  const second = await hover(projectFor("SOFILOAD", "LC 1; TRAI TYPE LM1"), "untitled:fixture", {
    line: 1,
    character: 8,
  });
  assert.ok(second.contents.value.startsWith("SOFILOAD · TRAI\n\nTYPE, P1, P2"));
});
