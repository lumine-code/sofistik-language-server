const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { CancellationTokenSource } = require("vscode-jsonrpc/node");
const { documentSymbolChunks, MAX_ROWS } = require("../lib/document-symbol-chunks");
const { LspClient } = require("./lsp-client");

const range = (line, end = line) => ({
  start: { line, character: 0 },
  end: { line: end, character: 8 },
});
const flatten = (symbols) => {
  const rows = [];
  const visit = (items, parent = -1) => {
    for (const item of items) {
      const index = rows.length;
      const coordinates = ({ start, end }) => [
        start.line,
        start.character,
        end.line,
        end.character,
      ];
      rows.push([
        item.name,
        item.kind,
        coordinates(item.range),
        coordinates(item.selectionRange),
        parent,
      ]);
      if (item.children) visit(item.children, index);
    }
  };
  visit(symbols);
  return rows;
};

test("chunks split a large single root, preserving DFS order, parent identity and both ranges", () => {
  const root = {
    name: "program",
    kind: 2,
    range: range(0, 4096),
    selectionRange: range(0),
    children: [],
  };
  for (let line = 1; line <= 4096; line++)
    root.children.push({
      name: `command${line}`,
      kind: 6,
      range: range(line),
      selectionRange: range(line),
    });
  const chunks = [...documentSymbolChunks([root])];
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.symbols.length <= MAX_ROWS));
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.symbols),
    flatten([root]),
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.offset),
    chunks.map((_chunk, i) => i * MAX_ROWS),
  );
});

test("chunk traversal also handles deeply nested symbol trees without recursion", () => {
  const roots = [];
  let children = roots;
  for (let depth = 0; depth < 12000; depth++) {
    const node = {
      name: "nested",
      kind: 2,
      range: range(0, 12000),
      selectionRange: range(0),
      children: [],
    };
    children.push(node);
    children = node.children;
  }
  let count = 0;
  for (const packet of documentSymbolChunks(roots)) {
    for (const row of packet.symbols) assert.equal(row[4], count++ - 1);
  }
  assert.equal(count, 12000);
});

async function fixture(t, negotiated, records = 2048) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-symbol-chunks-"));
  const client = new LspClient(root, {
    experimental: negotiated ? { lumineDocumentSymbolChunks: 1 } : undefined,
  });
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await client.start();
  const uri = pathToFileURL(path.join(root, "model.dat")).href;
  client.open(uri, `+PROG ASE\n${"GRP NO 1 VAL FULL\n".repeat(records)}END\n`);
  return { client, uri };
}

test("negotiated stdio packets preserve every ordinary document symbol", async (t) => {
  const { client, uri } = await fixture(t, true);
  const expected = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
  const token = "symbols";
  const result = await client.request("textDocument/documentSymbol", {
    textDocument: { uri },
    partialResultToken: token,
  });
  assert.equal(result, null);
  const chunks = client.notifications
    .filter((item) => item.method === "$/progress" && item.params.token === token)
    .map((item) => item.params.value);
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.symbols),
    flatten(expected),
  );
});

test("unnegotiated clients retain the standard hierarchy even with a partial token", async (t) => {
  const { client, uri } = await fixture(t, false);
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri },
    partialResultToken: "standard",
  });
  assert.ok(symbols[0].children.length >= 2048);
  assert.equal(
    client.notifications.some(
      (item) => item.method === "$/progress" && item.params.token === "standard",
    ),
    false,
  );
});

test("cancellation stops a negotiated stream between bounded packets", async (t) => {
  const { client, uri } = await fixture(t, true, 32768);
  const source = new CancellationTokenSource();
  t.after(() => source.dispose());
  let packets = 0;
  client.connection.onNotification("$/progress", ({ token }) => {
    if (token === "cancel-symbols" && ++packets === 1) source.cancel();
  });
  await assert.rejects(
    client.connection.sendRequest(
      "textDocument/documentSymbol",
      {
        textDocument: { uri },
        partialResultToken: "cancel-symbols",
      },
      source.token,
    ),
    (error) => error.code === -32800,
  );
  assert.ok(packets > 0 && packets < Math.ceil(32769 / MAX_ROWS));
});

test("a document edit rejects the old stream instead of completing with stale ranges", async (t) => {
  const { client, uri } = await fixture(t, true, 32768);
  let packets = 0;
  client.connection.onNotification("$/progress", ({ token }) => {
    if (token === "edit-symbols" && ++packets === 1)
      client.change(uri, [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: " " },
      ]);
  });
  await assert.rejects(
    client.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
      partialResultToken: "edit-symbols",
    }),
    (error) => error.code === -32801,
  );
  assert.ok(packets > 0 && packets < Math.ceil(32769 / MAX_ROWS));
});
