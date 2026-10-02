const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { LspClient } = require("./lsp-client");

const SOURCE = "+PROG ASE\nHEAD 'Example ą😀'\nLET#size 1\nGRP NO #size VAL FULL\nEND\n";
const params = (uri, line, character) => ({ textDocument: { uri }, position: { line, character } });

async function fixture(t, definition = "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-lsp-"));
  const filePath = path.join(root, "model.dat");
  await fs.writeFile(path.join(root, "sofistik.def"), definition);
  await fs.writeFile(filePath, SOURCE);
  const client = new LspClient(root);
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const initialized = await client.start();
  const uri = pathToFileURL(filePath).href;
  client.open(uri, SOURCE);
  return { root, filePath, uri, client, initialized };
}

test("real stdio server exercises advertised language features and incremental lifecycle", async (t) => {
  const { uri, client, initialized } = await fixture(t);
  const caps = initialized.capabilities;
  assert.equal(caps.positionEncoding, "utf-16");
  assert.equal(caps.workspace.workspaceFolders.supported, false);
  assert.equal(caps.textDocumentSync.change, 2);
  assert.deepEqual(caps.semanticTokensProvider.legend.tokenTypes, ["enumMember"]);
  assert.equal(caps.semanticTokensProvider.full, true);
  assert.equal(caps.semanticTokensProvider.range, true);
  assert.equal(caps.renameProvider, undefined);
  assert.equal(caps.documentFormattingProvider, undefined);
  const completions = await client.request("textDocument/completion", params(uri, 3, 17));
  assert.ok(completions.some((item) => item.label === "FULL"));
  assert.ok(completions.every((item) => item.kind === 20));
  const hover = await client.request("textDocument/hover", params(uri, 3, 15));
  assert.match(hover.contents.value, /GRP · VAL/);
  const recordHover = await client.request("textDocument/hover", params(uri, 3, 1));
  assert.ok(recordHover.contents.value.startsWith("ASE · GRP\n\nNO, VAL, FACS"));
  const signatures = await client.request("textDocument/signatureHelp", params(uri, 3, 19));
  assert.match(signatures.signatures[0].label, /^GRP NO VAL /);
  assert.equal(signatures.activeParameter, 1);
  const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
  assert.ok(symbols.some((item) => item.name.toLowerCase() === "size"));
  const workspace = await client.request("workspace/symbol", { query: "siz" });
  assert.ok(workspace.some((item) => item.location.uri === uri));
  const definitions = await client.request("textDocument/definition", params(uri, 3, 10));
  assert.equal(definitions[0].uri, uri);
  assert.equal(definitions[0].range.start.line, 2);
  const references = await client.request("textDocument/references", {
    ...params(uri, 2, 6),
    context: { includeDeclaration: false },
  });
  assert.deepEqual(
    references.map((item) => item.range.start.line),
    [3],
  );
  assert.deepEqual(
    await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    { data: [3, 17, 4, 0, 0] },
  );
  assert.deepEqual(
    await client.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
    }),
    { data: [3, 17, 4, 0, 0] },
  );
  assert.deepEqual(
    (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    [],
  );
  client.change(uri, [
    { range: { start: { line: 3, character: 17 }, end: { line: 3, character: 21 } }, text: "NO" },
  ]);
  assert.deepEqual(
    await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    { data: [3, 17, 2, 0, 0] },
  );
  client.notify("textDocument/didClose", { textDocument: { uri } });
  assert.deepEqual(
    (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    [],
  );
  const untitled = "untitled:lumine-fixture.dat";
  client.open(untitled, SOURCE);
  assert.ok(
    (await client.request("textDocument/completion", params(untitled, 3, 17))).some(
      (item) => item.label === "FULL",
    ),
  );
  assert.equal(client.stderr, "");
});

test("semantic tokens preserve string highlighting while quoted enums keep completion and hover", async (t) => {
  const { uri, client } = await fixture(t);
  const quotedValues = ["'FULL'", '"FULL"', "''FULL''", '""FULL""'];
  client.change(uri, [
    {
      text: [
        "+PROG ASE",
        "GRP NO 1 VAL FULL",
        ...quotedValues.map((value, index) => `GRP NO ${index + 2} VAL ${value}`),
        "GRP NO 6 VAL NO",
        "END",
        "",
      ].join("\n"),
    },
  ]);
  const assertTokens = async (data) => {
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
      { data },
    );
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/range", {
        textDocument: { uri },
        range: { start: { line: 1, character: 0 }, end: { line: 7, character: 0 } },
      }),
      { data },
    );
  };
  const unquotedTokens = [1, 13, 4, 0, 0, 5, 13, 2, 0, 0];
  await assertTokens(unquotedTokens);
  for (const [index, value] of quotedValues.entries()) {
    const line = index + 2;
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/range", {
        textDocument: { uri },
        range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
      }),
      { data: [] },
    );
    const character = 13 + value.indexOf("FULL") + 2;
    const completions = await client.request(
      "textDocument/completion",
      params(uri, line, character),
    );
    assert.ok(
      completions.some((item) => item.label === "FULL"),
      value,
    );
    const hover = await client.request("textDocument/hover", params(uri, line, character));
    assert.match(hover.contents.value, /ASE · GRP · VAL/, value);
    assert.match(hover.contents.value, /FULL/, value);
  }
  client.change(
    uri,
    [
      {
        range: { start: { line: 1, character: 13 }, end: { line: 1, character: 17 } },
        text: "'FULL'",
      },
    ],
    3,
  );
  await assertTokens([6, 13, 2, 0, 0]);
  client.change(
    uri,
    [
      {
        range: { start: { line: 1, character: 13 }, end: { line: 1, character: 19 } },
        text: "FULL",
      },
    ],
    4,
  );
  await assertTokens(unquotedTokens);
  assert.equal(client.stderr, "");
});

test("sibling definition changes invalidate enums; file headers never override file settings", async (t) => {
  const { root, uri, client } = await fixture(t);
  client.change(uri, [{ text: "@ SOFiSTiK 1999 DE\n" + SOURCE }]);
  assert.ok(
    (await client.request("textDocument/completion", params(uri, 4, 17))).some(
      (item) => item.label === "FULL",
    ),
  );
  assert.deepEqual(
    (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    [],
  );
  const definitionPath = path.join(root, "sofistik.def");
  await fs.writeFile(definitionPath, "SOF_VERSION = 1999\n");
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: pathToFileURL(definitionPath).href, type: 2 }],
  });
  assert.deepEqual(
    await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    { data: [] },
  );
  const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.ok(diagnostics.items.some((item) => item.code === "unsupported-project-version"));
  const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
  assert.ok(symbols.some((item) => item.name.toLowerCase() === "size"));
  await fs.writeFile(definitionPath, "SOF_VERSION = 2026\n");
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: pathToFileURL(definitionPath).href, type: 2 }],
  });
  assert.deepEqual(
    await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    { data: [4, 17, 4, 0, 0] },
  );
});

test("manual JSONL import merges findings and clears only calculated diagnostics after edits", async (t) => {
  const { root, uri, client } = await fixture(t);
  await fs.writeFile(
    path.join(root, "model.error_positions"),
    [
      JSON.stringify({
        errornumber: 100,
        isError: true,
        position: { line: 4, text: "Example calculation error" },
      }),
      "not-json",
      JSON.stringify({
        errornumber: 101,
        isError: false,
        position: { line: 2, text: "Example note" },
      }),
      JSON.stringify({ isError: true, position: { line: 999, text: "Invalid position" } }),
    ].join("\n"),
  );
  const result = await client.request("workspace/executeCommand", {
    command: "sofistik.readCalculationDiagnostics",
    arguments: [{ uri }],
  });
  assert.equal(result.count, 2);
  const report = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.deepEqual(
    report.items.map((item) => item.source),
    ["sofistik-calculation", "sofistik-calculation"],
  );
  assert.equal(report.items[0].range.start.line, 3);
  client.change(uri, [{ text: SOURCE + "ENDLOOP\n" }]);
  const changed = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.ok(changed.items.every((item) => item.source !== "sofistik-calculation"));
  assert.ok(changed.items.length > 0);
  await assert.rejects(
    client.request("workspace/executeCommand", { command: "wrong.command", arguments: [] }),
    /Unknown SOFiSTiK/,
  );
});

test("two real processes keep project releases independent", async (t) => {
  const supported = await fixture(t);
  const unsupported = await fixture(t, "SOF_VERSION = 1999\n");
  assert.notEqual(supported.client.child.pid, unsupported.client.child.pid);
  assert.notDeepEqual(
    await supported.client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: supported.uri },
    }),
    { data: [] },
  );
  assert.deepEqual(
    await unsupported.client.request("textDocument/semanticTokens/full", {
      textDocument: { uri: unsupported.uri },
    }),
    { data: [] },
  );
});
