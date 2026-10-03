const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikProject, canonicalUri, MAX_INPUT_BYTES } = require("../lib/project");
const { completion, workspaceSymbols } = require("../lib/features");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-memory-"));
  let project;
  t.after(async () => {
    project?.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    root,
    uri: (name) => canonicalUri(path.join(root, name)),
    start: async (options) => {
      project = new SofistikProject(root, {}, options);
      await project.ready;
      await project.indexReady;
      return project;
    },
  };
}

test("workspace indexing and include navigation fit a bounded heap for generated records", async (t) => {
  const { root } = await fixture(t);
  for (let file = 0; file < 6; file++) {
    await fs.writeFile(
      path.join(root, `part${file}.dat`),
      `+PROG ASE\nLET#size${file} 1\n` + "GRP NO 1 VAL FULL\n".repeat(20000) + "END\n",
    );
  }
  await fs.writeFile(
    path.join(root, "main.dat"),
    "+PROG ASE\n" +
      Array.from({ length: 6 }, (_, file) => `#include 'part${file}.dat'`).join("\n") +
      "\nEND\n",
  );
  const projectModule = path.resolve(__dirname, "../lib/project.js");
  const featuresModule = path.resolve(__dirname, "../lib/features.js");
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { SofistikProject, canonicalUri } = require(process.argv[1]);
    const { workspaceSymbols } = require(process.argv[2]);
    (async () => {
      const project = new SofistikProject(process.argv[3]);
      await project.ready;
      await project.indexReady;
      assert.equal(project.documents.size, 7);
      assert.equal(workspaceSymbols(project, 'size').length, 6);
      const views = await project.graphFor(canonicalUri(path.join(process.argv[3], 'main.dat')));
      assert.equal(views.length, 7);
      assert.equal((await project.contextualViews()).filter(view => view.uri.endsWith('main.dat')).length, 1);
      global.gc();
      console.log('indexed with 128 MiB heap');
      project.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = execFileSync(
    process.execPath,
    ["--max-old-space-size=128", "--expose-gc", "-e", script, projectModule, featuresModule, root],
    { encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  assert.match(result, /indexed with 128 MiB heap/);
});

test("oversized disk inputs are reported before indexing and recover after shrinking", async (t) => {
  const { root, uri, start } = await fixture(t);
  const oversized = path.join(root, "generated.results");
  const file = await fs.open(oversized, "w");
  await file.truncate(MAX_INPUT_BYTES + 1);
  await file.close();
  await fs.writeFile(path.join(root, "main.dat"), "+PROG ASE\nLET#small 1\nEND\n");
  const skipped = [];
  const project = await start({ onSkippedInput: (...args) => skipped.push(args) });
  assert.equal(project.documents.has(uri("generated.results")), false);
  assert.equal(project.documents.has(uri("main.dat")), true);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0][1], /32 MiB/);
  assert.equal(await project.loadDocument(uri("generated.results")), null);
  assert.equal(skipped.length, 1);
  await fs.writeFile(oversized, "+PROG ASE\nLET#recovered 1\nEND\n");
  await project.watched([{ uri: uri("generated.results"), type: 2 }]);
  assert.equal(project.skippedInputs.has(uri("generated.results")), false);
  assert.equal(workspaceSymbols(project, "recovered").length, 1);
});

test("inputs above 8 MiB retain language services from disk and in open buffers", async (t) => {
  const { root, uri, start } = await fixture(t);
  const text = "$" + " ".repeat(8 * 1024 * 1024) + "\n+PROG ASE\nGRP NO 1 VAL \nEND\n";
  await fs.writeFile(path.join(root, "main.dat"), text);
  const project = await start();
  const main = uri("main.dat");
  assert.equal(project.documents.get(main).text, text);
  assert.equal(project.skippedInputs.has(main), false);
  project.open({ uri: main, version: 1, text });
  assert.deepEqual(project.diagnostics(main), []);
  assert.ok(
    (await completion(project, main, { line: 2, character: 13 })).some(
      (item) => item.label === "FULL",
    ),
  );
});

test("oversized buffers accept incremental edits and resume language services", async (t) => {
  const { uri, start } = await fixture(t);
  const project = await start();
  const main = uri("main.dat");
  const text = "$" + " ".repeat(MAX_INPUT_BYTES);
  project.open({ uri: main, version: 1, text });
  assert.equal(project.documents.get(main).text, text);
  assert.equal(project.diagnostics(main)[0].code, "input-size-limit");
  assert.deepEqual(await completion(project, main, { line: 0, character: 0 }), []);
  project.change(
    main,
    [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } },
        text: "+PROG ASE\nGRP NO 1 VAL ",
      },
    ],
    2,
  );
  assert.deepEqual(project.diagnostics(main), []);
  assert.ok(
    (await completion(project, main, { line: 1, character: 13 })).some(
      (item) => item.label === "FULL",
    ),
  );
  project.change(main, [{ text }], 3);
  assert.equal(project.diagnostics(main)[0].code, "input-size-limit");
  project.change(main, [{ text: "+PROG ASE\nLET#restored 1\nEND\n" }], 4);
  assert.deepEqual(project.diagnostics(main), []);
  assert.equal(workspaceSymbols(project, "restored").length, 1);
});

test("chunked disk decoding preserves multibyte characters and rejects binary inputs", async (t) => {
  const { root, uri, start } = await fixture(t);
  const text = "$" + " ".repeat(65534) + "ą😀\n+PROG ASE\nLET#size 1\nEND\n";
  await fs.writeFile(path.join(root, "main.dat"), text);
  await fs.writeFile(path.join(root, "binary.grb"), Buffer.from([1, 0, 2]));
  const project = await start();
  assert.equal(project.documents.get(uri("main.dat")).text, text);
  assert.equal(workspaceSymbols(project, "size").length, 1);
  assert.equal(project.documents.has(uri("binary.grb")), false);
});

test("pending disk size checks cannot replace the current buffer's size diagnostic", async (t) => {
  const { root, uri, start } = await fixture(t);
  const project = await start();
  const main = uri("main.dat");
  const file = await fs.open(path.join(root, "main.dat"), "w");
  await file.truncate(MAX_INPUT_BYTES + 1);
  await file.close();
  const oversizedRead = project.readInput(main);
  project.open({ uri: main, version: 1, text: "+PROG ASE\nLET#small 1\nEND\n" });
  assert.equal(await oversizedRead, null);
  assert.deepEqual(project.diagnostics(main), []);

  await fs.writeFile(path.join(root, "main.dat"), "+PROG ASE\nEND\n");
  const smallRead = project.readInput(main);
  project.open({ uri: main, version: 2, text: "$" + " ".repeat(MAX_INPUT_BYTES) });
  assert.equal(await smallRead, "+PROG ASE\nEND\n");
  assert.equal(project.diagnostics(main)[0].code, "input-size-limit");
});
