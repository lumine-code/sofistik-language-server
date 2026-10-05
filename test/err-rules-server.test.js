"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { LspClient } = require("./lsp-client");
const { codeFor } = require("../lib/lint-codes");

async function fixture(t, version = "2026", language = "EN") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-err-rules-stdio-"));
  const definition = path.join(root, "sofistik.def");
  await fs.writeFile(definition, `SOF_VERSION=${version}\nSOF_LANGUAGE=${language}\n`);
  const client = new LspClient(root);
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await client.start();
  const uri = pathToFileURL(path.join(root, "model.dat")).href;
  const diagnostics = async () =>
    (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items;
  const configure = async (version, language, extra = "") => {
    await fs.writeFile(definition, `SOF_VERSION=${version}\nSOF_LANGUAGE=${language}\n${extra}`);
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(definition).href, type: 2 }],
    });
  };
  return { uri, client, diagnostics, configure };
}

test("stdio diagnostics select the ERR release and German bindings after definition changes", async (t) => {
  const { uri, client, diagnostics, configure } = await fixture(t, "2018");
  const code = codeFor("dbmerg-negative-load-case");
  assert.equal(code, "DM001");
  client.open(uri, "+PROG DBMERG\nLC NO -1\nEND\n");
  assert.equal(
    (await diagnostics()).some((item) => item.code === code),
    false,
  );
  await configure("2025", "EN");
  const english = (await diagnostics()).find((item) => item.code === code);
  assert.ok(english);
  assert.equal(english.range.start.line, 0);
  assert.equal(english.relatedInformation.at(-1).location.range.start.line, 1);

  await configure("2025", "DE");
  client.change(uri, [{ text: "+PROG DBMERG\nLF NR -1\nENDE\n" }], 2);
  assert.ok((await diagnostics()).some((item) => item.code === code));
  await configure("2018", "DE");
  assert.equal(
    (await diagnostics()).some((item) => item.code === code),
    false,
  );
});

test("stdio exposes prefix codes and honors local and project NOQA for new ERR findings", async (t) => {
  const { uri, client, diagnostics, configure } = await fixture(t);
  const code = codeFor("rely-var-distribution-xor");
  assert.match(code, /^RL\d{3}$/);
  client.open(uri, "+PROG RELY\nVAR NAME rv TYPE NORM TID 1 P1 1 P2 0.1\nEND\n");
  const initial = (await diagnostics()).find((item) => item.code === code);
  assert.ok(initial);
  assert.equal(initial.data.rule, "rely-var-distribution-xor");
  assert.equal(initial.source, "sofistik-linter");
  client.change(
    uri,
    [{ text: `+PROG RELY\nVAR NAME rv TYPE NORM TID 1 P1 1 P2 0.1 ! noqa: ${code}\nEND\n` }],
    2,
  );
  assert.equal(
    (await diagnostics()).some((item) => item.code === code),
    false,
  );

  client.change(uri, [{ text: "+PROG RELY\nVAR NAME rv TYPE NORM TID 1 P1 1 P2 0.1\nEND\n" }], 3);
  await configure("2026", "EN", `NOQA=${code} $ keep other rules enabled\n`);
  assert.equal(
    (await diagnostics()).some((item) => item.code === code),
    false,
  );
  await configure("2026", "EN");
  assert.ok((await diagnostics()).some((item) => item.code === code));
});

test("stdio keeps numeric expression values unknown and attaches definite row errors to PROG", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const code = codeFor("aqb-creep-humidity-range");
  client.open(uri, "+PROG AQB\nEIGE RH 110/2\nEND\n");
  assert.equal(
    (await diagnostics()).some((item) => item.code === code),
    false,
  );
  client.change(uri, [{ text: "+PROG AQB\nEIGE RH TEMP\n110 20\n50 20\nEND\n" }], 2);
  const rows = (await diagnostics()).filter((item) => item.code === code);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].range.start.line, 0);
  assert.equal(rows[0].relatedInformation.at(-1).location.range.start.line, 2);
});
