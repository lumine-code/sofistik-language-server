const path = require("node:path");
const { SourceStore, MAX_INPUT_BYTES } = require("./source-store");
const {
  SourceResolver,
  canonicalUri,
  uriPath,
  fileIdentity,
  directoryIdentity,
} = require("./source-resolver");
const { EnvironmentContext } = require("./environment-context");
const { NavigationIndex } = require("./navigation-index");
const { CalculationDiagnostics } = require("./calculation-diagnostics");
const { sourceDiagnostics } = require("./source-diagnostics");
const { containsPosition, uniqueLocations } = require("./ranges");

function normalizedSettings(settings = {}) {
  return {
    textCase: settings.textCase === "lower" ? "lower" : "upper",
    encoding: String(settings.encoding || "utf-8"),
  };
}

/** Coordinates source, environment, navigation and imported-result ownership. */
class SofistikProject {
  constructor(rootPath, settings = {}, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.rootUri = canonicalUri(this.rootPath);
    this.settings = normalizedSettings(settings);
    this.options = options;
    this.stopped = false;
    this.sources = new SourceStore(this, options);
    this.sourceResolver = new SourceResolver();
    this.environment = new EnvironmentContext(this, options.resolver);
    this.navigation = new NavigationIndex(this);
    this.calculations = new CalculationDiagnostics(this);
    this.refreshEnvironment =
      options.refreshEnvironment ||
      (async (uri, directories = this.environmentDirectories(uri)) => {
        await this.refreshTargets(directories);
        return directories;
      });
    this.ready = this.initialize();
  }

  async initialize() {
    // The stdio server waits for initialized and its progress handshake before
    // starting the scan. Direct project consumers retain the immediate start.
    this.indexReady = this.options.indexingStart
      ? Promise.resolve(this.options.indexingStart).then(() => this.scanDirectory(this.rootPath))
      : this.scanDirectory(this.rootPath);
    // Keep context requests usable even if a background read fails. Global
    // indexing consumers still receive the original rejection when awaiting it.
    this.indexReady.catch(() => undefined);
  }

  async configure(settings) {
    if (this.stopped) return;
    this.settings = normalizedSettings(settings);
    this.invalidate();
    await this.refreshTargets();
    if (this.stopped) return;
    for (const document of [...this.documents.values()]) {
      const text = document.open ? document.text : await this.readInput(document.uri);
      if (this.stopped) return;
      if (this.documents.get(document.uri) !== document) continue;
      if (text === null) {
        this.documents.delete(document.uri);
      } else {
        document.text = text;
        document.target = this.targetFor(document.uri, { scopePrefix: document.uri });
        document.index = this.indexDocument(document);
      }
    }
    this.invalidate();
  }

  async watched(changes) {
    const directories = new Set(
      changes
        .filter(({ uri }) => this.isDefinitionUri(uri))
        .map(({ uri }) => directoryIdentity(uri)),
    );
    const affected = new Set(await this.refreshTargets(directories));
    for (const { uri, type } of changes) {
      if (this.stopped) return;
      const filePath = uriPath(uri);
      if (!filePath) continue;
      if (this.isDefinitionUri(uri)) {
        this.touchDocument(uri);
        continue;
      }
      if (path.extname(filePath).toLowerCase() === ".def") continue;
      const documentUri =
        [...this.documents.keys()].find((known) => fileIdentity(known) === fileIdentity(uri)) ||
        uri;
      if (this.documents.get(documentUri)?.open) continue;
      affected.add(documentUri);
      this.touchDocument(documentUri);
      if (type === 3) {
        this.documents.delete(documentUri);
        this.calculationDiagnostics.delete(documentUri);
        this.skippedInputs.delete(documentUri);
      } else {
        this.documents.delete(documentUri);
        await this.loadDocument(documentUri);
      }
    }
    for (const uri of affected) this.invalidate(uri);
    return [...affected];
  }

  includePaths(entry, include) {
    const uri = this.sourceResolver.staticInclude(entry, include);
    const filePath = uri && uriPath(uri);
    return filePath ? [filePath] : [];
  }

  async includeTargets(entry, include) {
    const uri = this.sourceResolver.staticInclude(entry, include);
    const document = uri ? await this.loadDocument(uri) : null;
    return document ? [document] : [];
  }

  diagnostics(uri) {
    return [...sourceDiagnostics(this, uri), ...(this.calculations.results.get(uri) || [])];
  }

  touchDocument(...args) {
    return this.sources.touchDocument(...args);
  }
  makeDocument(...args) {
    return this.sources.makeDocument(...args);
  }
  skipInput(...args) {
    return this.sources.skipInput(...args);
  }
  indexDocument(...args) {
    return this.sources.indexDocument(...args);
  }
  readInput(...args) {
    return this.sources.readInput(...args);
  }
  loadDocument(...args) {
    return this.sources.loadDocument(...args);
  }
  scanDirectory(...args) {
    return this.sources.scanDirectory(...args);
  }
  open(...args) {
    return this.sources.open(...args);
  }
  change(...args) {
    return this.sources.change(...args);
  }
  close(...args) {
    return this.sources.close(...args);
  }
  refreshTargets(...args) {
    return this.environment.refreshTargets(...args);
  }
  environmentDirectories(...args) {
    return this.environment.environmentDirectories(...args);
  }
  isDefinitionUri(...args) {
    return this.environment.isDefinitionUri(...args);
  }
  targetFor(...args) {
    return this.environment.targetFor(...args);
  }
  graphFor(...args) {
    return this.navigation.graphFor(...args);
  }
  occurrenceAt(...args) {
    return this.navigation.occurrenceAt(...args);
  }
  contextualViews(...args) {
    return this.navigation.contextualViews(...args);
  }
  catalogFor(...args) {
    return this.navigation.catalogFor(...args);
  }
  bindingsFor(...args) {
    return this.navigation.bindingsFor(...args);
  }
  definitions(...args) {
    return this.navigation.definitions(...args);
  }
  definitionCandidates(...args) {
    return this.navigation.definitionCandidates(...args);
  }
  references(...args) {
    return this.navigation.references(...args);
  }
  referenceCandidates(...args) {
    return this.navigation.referenceCandidates(...args);
  }
  visibleSymbols(...args) {
    return this.navigation.visibleSymbols(...args);
  }
  invalidate(...args) {
    return this.navigation.invalidate(...args);
  }
  importCalculationDiagnostics(...args) {
    return this.calculations.importCalculationDiagnostics(...args);
  }

  get documents() {
    return this.sources.documents;
  }
  get documentEpochs() {
    return this.sources.documentEpochs;
  }
  get skippedInputs() {
    return this.sources.skippedInputs;
  }
  get indexedInputs() {
    return this.sources.indexedInputs;
  }
  get views() {
    return this.navigation.views;
  }
  get contextIndexes() {
    return this.navigation.contextIndexes;
  }
  get revision() {
    return this.navigation.revision;
  }
  get targets() {
    return this.environment.targets;
  }
  get resolver() {
    return this.environment.resolver;
  }
  get calculationDiagnostics() {
    return this.calculations.results;
  }

  dispose() {
    this.stopped = true;
    this.navigation.dispose();
    this.sources.dispose();
    this.environment.dispose();
    this.calculations.dispose();
  }
}

module.exports = {
  SofistikProject,
  canonicalUri,
  containsPosition,
  normalizedSettings,
  uriPath,
  uniqueLocations,
  fileIdentity,
  MAX_INPUT_BYTES,
};
