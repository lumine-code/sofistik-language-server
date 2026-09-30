const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

function timeout(promise, label, milliseconds = 10000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

class LspClient {
  constructor(rootPath, options = {}) {
    this.rootPath = rootPath;
    this.entryPath = options.entryPath || path.join(__dirname, "../bin/cli.js");
    this.settings = { textCase: "upper", encoding: "utf-8" };
    this.notifications = [];
    this.stderr = "";
  }

  async start() {
    this.child = spawn(process.execPath, [this.entryPath, "--stdio"], {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.connection.onRequest("workspace/configuration", ({ items }) =>
      items.map(() => this.settings),
    );
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.onRequest("workspace/semanticTokens/refresh", () => null);
    this.connection.onRequest("workspace/diagnostic/refresh", () => null);
    this.connection.onNotification((method, params) => {
      this.notifications.push({ method, params });
    });
    this.connection.listen();
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).href,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
          semanticTokens: { refreshSupport: true },
          diagnostics: { refreshSupport: true },
        },
        textDocument: {
          semanticTokens: {
            requests: { full: true, range: true },
            tokenTypes: ["enumMember"],
            tokenModifiers: [],
            formats: ["relative"],
          },
        },
      },
    });
    this.notify("initialized", {});
    return result;
  }

  request(method, params) {
    return timeout(this.connection.sendRequest(method, params), method).catch((error) => {
      throw new Error(`${error.message}; stderr: ${this.stderr}`, { cause: error });
    });
  }

  notify(method, params) {
    return this.connection.sendNotification(method, params);
  }

  open(uri, text, version = 1) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "sofistik", version, text },
    });
  }

  change(uri, contentChanges, version = 2) {
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges });
  }

  async stop() {
    if (!this.child) return;
    try {
      if (this.child.exitCode === null) {
        await timeout(this.connection.sendRequest("shutdown"), "shutdown", 2000);
        this.notify("exit");
        if (this.child.exitCode === null)
          await timeout(new Promise((resolve) => this.child.once("exit", resolve)), "exit", 2000);
      }
    } finally {
      if (this.child.exitCode === null) this.child.kill();
      this.connection.dispose();
    }
  }
}

module.exports = { LspClient };
