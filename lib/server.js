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
  options = {},
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
  const publishAffected = async (uris) => {
    for (const uri of uris) {
      if (project.documents.get(uri)?.open) await publish(uri);
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
  const request =
    (handler, workspace = false) =>
    async (params, token) => {
      if (!project || shuttingDown) return null;
      await enqueue(async () => {
        if (!token?.isCancellationRequested) {
          const uri = params.textDocument?.uri || params.arguments?.[0]?.uri;
          await refreshTarget(workspace ? undefined : uri);
        }
      });
      if (shuttingDown) return null;
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
  const notifyRefresh = () => {
    // The client can request tokens while handling this request. Never hold
    // the document mutation queue until the client's refresh response arrives.
    void refresh().catch((error) => connection.console.error(error.stack || error.message));
  };
  const refreshTarget = async (uri, requestedDirectories) => {
    const directories =
      requestedDirectories || (uri === undefined ? null : project.environmentDirectories(uri));
    const affected = await project.refreshTargets(directories);
    if (affected.length) {
      await publishAffected(affected);
      notifyRefresh();
    }
    return directories;
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
    notifyRefresh();
  };

  connection.onInitialize((params) => {
    clientCapabilities = params.capabilities;
    const rootPath =
      uriPath(params.rootUri || params.workspaceFolders?.[0]?.uri || "") || process.cwd();
    project = new SofistikProject(rootPath, params.initializationOptions?.sofistik, {
      resolver: options.resolver,
      refreshEnvironment: (uri, directories) => enqueue(() => refreshTarget(uri, directories)),
    });
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
      await publishAffected(await project.watched(changes));
      notifyRefresh();
    }),
  );
  connection.onDidOpenTextDocument(({ textDocument }) =>
    enqueue(async () => {
      await refreshTarget(textDocument.uri);
      project.open(textDocument);
      await publish(textDocument.uri);
    }),
  );
  connection.onDidChangeTextDocument(({ textDocument, contentChanges }) =>
    enqueue(async () => {
      await refreshTarget(textDocument.uri);
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
  connection.onDidSaveTextDocument(({ textDocument }) =>
    enqueue(() => refreshTarget(textDocument.uri)),
  );

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
  connection.onWorkspaceSymbol(
    request(async ({ query }) => {
      await project.indexReady;
      return features.workspaceSymbols(project, query);
    }, true),
  );
  connection.onDefinition(
    request(({ textDocument, position }) => project.definitions(textDocument.uri, position), true),
  );
  connection.onReferences(
    request(
      ({ textDocument, position, context }) =>
        project.references(textDocument.uri, position, context?.includeDeclaration),
      true,
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
