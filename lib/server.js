const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  PositionEncodingKind,
  ResponseError,
  ErrorCodes,
  LSPErrorCodes,
  DidChangeWatchedFilesNotification,
  WorkDoneProgressCreateRequest,
} = require("vscode-languageserver/node");
const { SofistikProject, uriPath } = require("./project");
const features = require("./features");
const { LintService } = require("./lint-service");
const INDEXING_PROGRESS_TIMEOUT = 2000;

function startServer(
  connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout),
  options = {},
) {
  let project;
  let linter;
  let clientCapabilities;
  let queue = Promise.resolve();
  let shuttingDown = false;
  let startIndexing;
  let indexingProgress;
  let lastIndexingReport = 0;
  const lintWatches = new Set();

  const indexingMessage = () =>
    `Indexed ${project.indexedInputs} ${project.indexedInputs === 1 ? "file" : "files"}`;
  const reportIndexing = (count) => {
    if (!indexingProgress || shuttingDown) return;
    const now = Date.now();
    if (count !== 1 && now - lastIndexingReport < 100) return;
    indexingProgress.report(indexingMessage());
    lastIndexingReport = now;
  };
  const finishIndexing = () => {
    const progress = indexingProgress;
    indexingProgress = null;
    if (!progress) return;
    progress.report(indexingMessage());
    progress.done();
  };
  const indexWorkspace = async () => {
    try {
      if (clientCapabilities?.window?.workDoneProgress === true) {
        try {
          const token = randomUUID();
          let timer;
          const accepted = await Promise.race([
            connection.sendRequest(WorkDoneProgressCreateRequest.type, { token }).then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), INDEXING_PROGRESS_TIMEOUT);
            }),
          ]).finally(() => clearTimeout(timer));
          // Attach only after the reply, so a delayed reply after shutdown
          // or the deadline cannot allocate a reporter or revive progress.
          if (shuttingDown) return;
          if (accepted) {
            const progress = connection.window.attachWorkDoneProgress(token);
            indexingProgress = progress;
            progress.begin("Indexing CADINP project", undefined, "Discovering files", false);
          } else {
            connection.console.warn(
              "The client did not create indexing progress within 2 seconds; indexing will continue.",
            );
          }
        } catch (error) {
          // Progress is optional: a client rejecting its creation must not
          // prevent navigation from indexing the workspace.
          connection.console.warn(error.stack || error.message);
        }
      }
      startIndexing();
      await project.indexReady;
    } catch (error) {
      connection.console.error(error.stack || error.message);
    } finally {
      finishIndexing();
    }
  };

  const publish = (uri) => {
    const document = linter?.document(uri) || project.documents.get(uri);
    return connection.sendDiagnostics({
      uri,
      version: document?.open ? document.version : null,
      diagnostics: linter ? linter.diagnostics(uri) : project.diagnostics(uri),
    });
  };
  const publishLint = async (uri, targets = [uri]) => {
    if (clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
      const watchers = [];
      for (const dependency of linter.results.get(uri)?.dependencies || []) {
        const filePath = uriPath(dependency);
        if (!filePath || lintWatches.has(filePath)) continue;
        lintWatches.add(filePath);
        // Include names are not restricted to CADINP extensions or the root.
        watchers.push({
          globPattern: filePath.replaceAll("\\", "/").replace(/[?*{}[\]]/g, "\\$&"),
          kind: 7,
        });
      }
      if (watchers.length)
        await connection.client.register(DidChangeWatchedFilesNotification.type, { watchers });
    }
    if (!shuttingDown) await publishAffected(targets);
  };
  const publishAll = async () => {
    const targets = new Set(
      [...(linter?.contributions.values() || [])].map((target) => target.uri),
    );
    for (const document of project.documents.values()) {
      if (document.open) targets.add(document.uri);
    }
    await publishAffected(targets);
  };
  const publishAffected = async (uris) => {
    for (const uri of new Set(uris)) if (!shuttingDown) await publish(uri);
  };
  const diagnosticReport = (uri) => {
    const related = linter.relatedUris(uri);
    return {
      kind: "full",
      items: linter.diagnostics(uri),
      ...(related.length && {
        relatedDocuments: Object.fromEntries(
          related.map((target) => [target, { kind: "full", items: linter.diagnostics(target) }]),
        ),
      }),
    };
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
      for (const uri of affected) linter?.changed(uri);
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
    for (const document of project.documents.values()) {
      if (document.open) linter?.changed(document.uri);
    }
    await publishAll();
    notifyRefresh();
  };

  connection.onInitialize((params) => {
    clientCapabilities = params.capabilities;
    const rootPath =
      uriPath(params.rootUri || params.workspaceFolders?.[0]?.uri || "") || process.cwd();
    const indexingStart = new Promise((resolve) => {
      startIndexing = resolve;
    });
    project = new SofistikProject(rootPath, params.initializationOptions?.sofistik, {
      resolver: options.resolver,
      indexingStart,
      onIndexedInput: reportIndexing,
      onSkippedInput: (uri, reason) => connection.console.warn(`${uri}: ${reason}`),
      refreshEnvironment: (uri, directories) => enqueue(() => refreshTarget(uri, directories)),
    });
    linter = new LintService(project, {
      delay: options.lintDelay ?? 300,
      onResult: publishLint,
      onInvalidate: publishAffected,
      onError: (error) => connection.console.error(error.stack || error.message),
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
  connection.onInitialized(() => {
    // Neither the progress-create round trip nor the disk scan may hold the
    // document queue: open-buffer completion remains usable during indexing.
    void indexWorkspace();
    return enqueue(async () => {
      await configure();
      if (clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
        const pattern = clientCapabilities.workspace.didChangeWatchedFiles.relativePatternSupport
          ? { baseUri: project.rootUri, pattern: "**/*.{dat,gra,grb,results,def,inc}" }
          : path.join(project.rootPath, "**/*.{dat,gra,grb,results,def,inc}").replaceAll("\\", "/");
        await connection.client.register(DidChangeWatchedFilesNotification.type, {
          watchers: [{ globPattern: pattern, kind: 7 }],
        });
      }
    });
  });
  connection.onDidChangeConfiguration(({ settings }) => enqueue(() => configure(settings)));
  connection.onDidChangeWatchedFiles(({ changes }) =>
    enqueue(async () => {
      const affected = new Set(await project.watched(changes));
      for (const change of changes) {
        for (const uri of linter.changed(change.uri)) affected.add(uri);
      }
      await publishAffected(affected);
      notifyRefresh();
    }),
  );
  connection.onDidOpenTextDocument(({ textDocument }) =>
    enqueue(async () => {
      await refreshTarget(textDocument.uri);
      project.open(textDocument);
      linter.changed(textDocument.uri, { immediate: true });
      await publish(textDocument.uri);
    }),
  );
  connection.onDidChangeTextDocument(({ textDocument, contentChanges }) =>
    enqueue(async () => {
      await refreshTarget(textDocument.uri);
      project.change(textDocument.uri, contentChanges, textDocument.version);
      await publishAffected(linter.changed(textDocument.uri));
    }),
  );
  connection.onDidCloseTextDocument(({ textDocument }) =>
    enqueue(async () => {
      const targets = new Set(linter.close(textDocument.uri, { notify: false }));
      await project.close(textDocument.uri);
      for (const uri of linter.changed(textDocument.uri)) targets.add(uri);
      await publishAffected(targets);
    }),
  );
  connection.onDidSaveTextDocument(({ textDocument }) =>
    enqueue(async () => {
      await refreshTarget(textDocument.uri);
      linter.changed(textDocument.uri, { immediate: true });
    }),
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
    request(async ({ textDocument }, token) => {
      const document = project.documents.get(textDocument.uri);
      if (!document?.open) return diagnosticReport(textDocument.uri);
      const version = document.version;
      const result = await linter.wait(textDocument.uri, token);
      if (
        !token?.isCancellationRequested &&
        (project.documents.get(textDocument.uri) !== document ||
          document.version !== version ||
          (!result && linter.jobs.has(textDocument.uri)))
      )
        throw new ResponseError(LSPErrorCodes.ContentModified, "Document changed during analysis.");
      return diagnosticReport(textDocument.uri);
    }),
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
    finishIndexing();
    await queue;
    await linter?.dispose();
    project?.dispose();
    startIndexing?.();
    return null;
  });
  connection.onExit(() => {
    void linter?.dispose();
    project?.dispose();
    process.exit(shuttingDown ? 0 : 1);
  });
  process.stdin.once("end", () => {
    void linter?.dispose();
    project?.dispose();
  });
  connection.listen();
  return connection;
}

module.exports = { startServer };
