const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { LspClient } = require("./lsp-client");

function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  assert.ok(cli, "Run package round-trip through npm test so npm's CLI path is explicit.");
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

test(
  "packed server installs normally without native dependencies and serves offline requests",
  { timeout: 120000 },
  async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-distribution-"));
    let client;
    t.after(async () => {
      await client?.stop();
      assert.equal(path.dirname(temporary), os.tmpdir());
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const repository = path.resolve(__dirname, "..");
    const packResult = JSON.parse(
      npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], repository),
    );
    assert.equal(Object.keys(packResult).length, 1);
    const packed = Array.isArray(packResult)
      ? packResult[0]
      : packResult["@lumine-code/sofistik-language-server"];
    assert.equal(packed?.name, "@lumine-code/sofistik-language-server");
    assert.ok(packed.files.some((file) => file.path === "lib/finder.js"));
    assert.ok(!packed.files.some((file) => /\.wasm$|grammars\/|\.node$/.test(file.path)));
    const consumer = path.join(temporary, "consumer");
    await fs.mkdir(consumer);
    await fs.writeFile(
      path.join(consumer, "package.json"),
      '{"name":"sofistik-package-probe","private":true}\n',
    );
    const manifest = JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8"));
    for (const [name, selector] of Object.entries(manifest.dependencies)) {
      if (name.startsWith("@lumine-code/")) {
        const repositoryName = name.slice("@lumine-code/".length);
        assert.match(selector, new RegExp(`^github:lumine-code/${repositoryName}#[a-f0-9]{40}$`));
      } else {
        assert.doesNotMatch(selector, /^(?:github:|git[+:]|https?:|file:|workspace:)/);
      }
    }
    // Only this disposable consumer grants Git access, after checking the
    // trusted local tarball's immutable Lumine dependency selectors above.
    await fs.writeFile(path.join(consumer, ".npmrc"), "allow-git=all\n");
    npm(
      ["install", "--omit=dev", "--no-audit", "--no-fund", path.join(temporary, packed.filename)],
      consumer,
    );
    assert.doesNotMatch(
      npm(["ls", "--omit=dev", "--json"], consumer),
      /tree-sitter|node-gyp|node-addon-api/,
    );
    const requireConsumer = createRequire(path.join(consumer, "package.json"));
    const entryPath = requireConsumer.resolve("@lumine-code/sofistik-language-server/bin/cli.js");
    assert.equal(
      execFileSync(process.execPath, [entryPath, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      "1.0.0",
    );
    await fs.writeFile(path.join(consumer, "sofistik.def"), "SOF_VERSION = 2026\n");
    client = new LspClient(consumer, { entryPath });
    const result = await client.start();
    assert.equal(result.capabilities.positionEncoding, "utf-16");
    const uri = pathToFileURL(path.join(consumer, "model.dat")).href;
    client.open(uri, "+PROG ASE\nGRP NO 1 VAL FULL\nEND\n");
    const completion = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 13 },
    });
    assert.ok(completion.some((item) => item.label === "FULL"));
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
      { data: [1, 13, 4, 0, 0] },
    );
  },
);
