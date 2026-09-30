const path = require("node:path");
const {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  PositionEncodingKind,
  ResponseError,
  ErrorCodes,
  LSPErrorCodes,
  DidChangeWatchedFilesNotification,
} = require("vscode-languageserver/node");
const { SofistikProject, uriPath } = require("./project");
const features = require("./features");

function startServer(
  connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout),
) {
  let project;
  let clientCapabilities;
  let queue = Promise.resolve();
  let shuttingDown = false;

  const publish = (uri) => {
    const document = project.documents.get(uri);
    return connection.sendDiagnostics({
      uri,
      version: document?.open ? document.version : undefined,
      diagnostics: project.diagnostics(uri),
    });
  };
  const publishAll = async () => {
    for (const document of project.documents.values()) {
      if (document.open) await publish(document.uri);
    }
  };
  const enqueue = (operation) => {
    queue = queue
      .then(async () => {
        if (shuttingDown) return;
        await project.ready;
        return operation();
      })
      .catch((error) => connection.console.error(error.stack || error.message));
    return queue;
  };
  const request = (handler) => async (params, token) => {
    await queue;
    if (!project || shuttingDown) return null;
    await project.ready;
    if (token?.isCancellationRequested)
      throw new ResponseError(LSPErrorCodes.RequestCancelled, "Request cancelled.");
    const result = await handler(params, token);
    if (token?.isCancellationRequested)
      throw new ResponseError(LSPErrorCodes.RequestCancelled, "Request cancelled.");
    return result;
  };
  const refresh = async () => {
    if (clientCapabilities?.workspace?.semanticTokens?.refreshSupport) {
      await connection.languages.semanticTokens.refresh();
    }
    if (clientCapabilities?.workspace?.diagnostics?.refreshSupport) {
      await connection.languages.diagnostics.refresh();
    }
  };
  const configure = async (settings) => {
    let options = settings?.sofistik;
    if (!options && clientCapabilities?.workspace?.configuration) {
      options = await connection.workspace.getConfiguration({
        scopeUri: project.rootUri,
        section: "sofistik",
      });
    }
    await project.configure(options || {});
    await publishAll();
    await refresh();
  };

  connection.onInitialize((params) => {
    clientCapabilities = params.capabilities;
    const rootPath =
      uriPath(params.rootUri || params.workspaceFolders?.[0]?.uri || "") || process.cwd();
    project = new SofistikProject(rootPath, params.initializationOptions?.sofistik);
    return {
      serverInfo: { name: "sofistik-language-server", version: require("../package.json").version },
      capabilities: {
        positionEncoding: PositionEncodingKind.UTF16,
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: true },
        completionProvider: { triggerCharacters: ["#", "$", " ", "="] },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: [" ", "\t"], retriggerCharacters: [" ", "\t"] },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        semanticTokensProvider: {
          legend: { tokenTypes: ["enumMember"], tokenModifiers: [] },
          full: true,
          range: true,
        },
        diagnosticProvider: {
          identifier: "sofistik",
          interFileDependencies: true,
          workspaceDiagnostics: false,
        },
        executeCommandProvider: { commands: ["sofistik.readCalculationDiagnostics"] },
        workspace: { workspaceFolders: { supported: false, changeNotifications: false } },
      },
    };
  });
  connection.onInitialized(() =>
    enqueue(async () => {
      await configure();
      if (clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
        const pattern = clientCapabilities.workspace.didChangeWatchedFiles.relativePatternSupport
          ? { baseUri: project.rootUri, pattern: "**/*.{dat,gra,grb,results,def}" }
          : path.join(project.rootPath, "**/*.{dat,gra,grb,results,def}").replaceAll("\\", "/");
        await connection.client.register(DidChangeWatchedFilesNotification.type, {
          watchers: [{ globPattern: pattern, kind: 7 }],
        });
      }
    }),
  );
  connection.onDidChangeConfiguration(({ settings }) => enqueue(() => configure(settings)));
  connection.onDidChangeWatchedFiles(({ changes }) =>
    enqueue(async () => {
      await project.watched(changes);
      await publishAll();
      await refresh();
    }),
  );
  connection.onDidOpenTextDocument(({ textDocument }) =>
    enqueue(async () => {
      project.open(textDocument);
      await publish(textDocument.uri);
    }),
  );
  connection.onDidChangeTextDocument(({ textDocument, contentChanges }) =>
    enqueue(async () => {
      project.change(textDocument.uri, contentChanges, textDocument.version);
      await publish(textDocument.uri);
    }),
  );
  connection.onDidCloseTextDocument(({ textDocument }) =>
    enqueue(async () => {
      await project.close(textDocument.uri);
      await connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
    }),
  );
  connection.onDidSaveTextDocument(() => {});

  connection.onCompletion(
    request(({ textDocument, position }) =>
      features.completion(project, textDocument.uri, position),
    ),
  );
  connection.onHover(
    request(({ textDocument, position }) => features.hover(project, textDocument.uri, position)),
  );
  connection.onSignatureHelp(
    request(({ textDocument, position }) =>
      features.signatureHelp(project, textDocument.uri, position),
    ),
  );
  connection.onDocumentSymbol(
    request(async ({ textDocument }) => {
      const entry = await project.loadDocument(textDocument.uri);
      return entry ? features.documentSymbols(entry) : [];
    }),
  );
  connection.onWorkspaceSymbol(request(({ query }) => features.workspaceSymbols(project, query)));
  connection.onDefinition(
    request(({ textDocument, position }) => project.definitions(textDocument.uri, position)),
  );
  connection.onReferences(
    request(({ textDocument, position, context }) =>
      project.references(textDocument.uri, position, context?.includeDeclaration),
    ),
  );
  connection.languages.semanticTokens.on(
    request(async ({ textDocument }) => {
      const entry = await project.loadDocument(textDocument.uri);
      return entry ? features.semanticTokens(entry) : { data: [] };
    }),
  );
  connection.languages.semanticTokens.onRange(
    request(async ({ textDocument, range }) => {
      const entry = await project.loadDocument(textDocument.uri);
      return entry ? features.semanticTokens(entry, range) : { data: [] };
    }),
  );
  connection.languages.diagnostics.on(
    request(({ textDocument }) => ({ kind: "full", items: project.diagnostics(textDocument.uri) })),
  );
  connection.onExecuteCommand(
    request(async ({ command, arguments: args }) => {
      if (command !== "sofistik.readCalculationDiagnostics" || typeof args?.[0]?.uri !== "string") {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Unknown SOFiSTiK command or missing document URI.",
        );
      }
      const result = await project.importCalculationDiagnostics(args[0].uri);
      await publish(args[0].uri);
      return result;
    }),
  );
  connection.onShutdown(async () => {
    shuttingDown = true;
    await queue;
    project?.dispose();
    return null;
  });
  connection.onExit(() => {
    project?.dispose();
    process.exit(shuttingDown ? 0 : 1);
  });
  process.stdin.once("end", () => project?.dispose());
  connection.listen();
  return connection;
}

module.exports = { startServer };
