const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { SofistikDataProvider, SofistikEnvironmentResolver } = require("@lumine-code/sofistik-data");
const { createIndex } = require("./finder");

const INPUT_EXTENSIONS = new Set([".dat", ".gra", ".grb", ".results"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".archived"]);
const EMPTY_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function normalizedSettings(settings = {}) {
  return {
    textCase: settings.textCase === "lower" ? "lower" : "upper",
    encoding: String(settings.encoding || "utf-8"),
  };
}

function uriPath(uri) {
  try {
    return /^file:/i.test(uri) ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

function fileIdentity(uri) {
  const filePath = uriPath(uri);
  if (!filePath) return null;
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function targetIdentity(target) {
  return JSON.stringify([
    target.version,
    target.language,
    target.edition,
    target.root,
    target.installPath,
    target.installed,
    target.dataSupported,
    target.versionSource,
  ]);
}

function canonicalUri(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

function containsPosition(range, position) {
  if (!range) return false;
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return compare(range.start, position) <= 0 && compare(position, range.end) <= 0;
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = JSON.stringify(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class SofistikProject {
  constructor(rootPath, settings = {}, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.rootUri = canonicalUri(this.rootPath);
    this.definitionUri = canonicalUri(path.join(this.rootPath, "sofistik.def"));
    this.settings = normalizedSettings(settings);
    this.data = new SofistikDataProvider();
    this.resolver = options.resolver || new SofistikEnvironmentResolver();
    this.documents = new Map();
    this.calculationDiagnostics = new Map();
    this.views = new Map();
    this.documentEpochs = new Map();
    this.stopped = false;
    this.revision = 0;
    this.ready = this.initialize();
  }

  async initialize() {
    await this.readTarget();
    this.indexReady = this.scanDirectory(this.rootPath);
    // Keep context requests usable even if a background read fails. Global
    // indexing consumers still receive the original rejection when awaiting it.
    this.indexReady.catch(() => undefined);
  }

  async readTarget() {
    this.target = this.resolver.resolve({ projectPath: this.rootPath });
  }

  async refreshTarget() {
    if (this.stopped) return false;
    const selected = this.resolver.resolve({ projectPath: this.rootPath });
    if (targetIdentity(selected) === targetIdentity(this.target)) return false;
    this.target = selected;
    // No awaits inside this swap: every open document sees the same selection,
    // and background reads construct their indexes from the newest target.
    for (const document of this.documents.values()) {
      document.index = createIndex(
        document.text,
        this.targetFor(document.text, { scopePrefix: document.uri }),
      );
    }
    this.calculationDiagnostics.clear();
    this.invalidate();
    return true;
  }

  isDefinitionUri(uri) {
    const identity = fileIdentity(uri);
    return identity !== null && identity === fileIdentity(this.definitionUri);
  }

  targetFor(_text, inherited = {}) {
    const language = this.target.language;
    return {
      ...this.target,
      language,
      keywords: this.data.forRelease(this.target.version, language),
      ...inherited,
      ...(inherited.scopePrefix && !inherited.scopeId
        ? { scopeId: `${inherited.scopePrefix}:document:0` }
        : {}),
    };
  }

  invalidate() {
    this.revision++;
    this.views.clear();
    this.allViews = null;
    this.declarationCatalog = null;
  }

  touchDocument(uri) {
    this.documentEpochs.set(uri, (this.documentEpochs.get(uri) || 0) + 1);
  }

  makeDocument(uri, text, version = 0, open = false) {
    if (this.stopped) return null;
    const filePath = uriPath(uri);
    if (filePath && path.extname(filePath).toLowerCase() === ".def") return null;
    const entry = {
      uri,
      text,
      version,
      open,
      index: createIndex(text, this.targetFor(text, { scopePrefix: uri })),
    };
    this.documents.set(uri, entry);
    this.touchDocument(uri);
    this.invalidate();
    return entry;
  }

  async readInput(uri) {
    const filePath = uriPath(uri);
    if (!filePath || path.extname(filePath).toLowerCase() === ".def") return null;
    try {
      const bytes = await fs.readFile(filePath);
      if (bytes.includes(0)) return null;
      return new TextDecoder(this.settings.encoding, { fatal: true }).decode(bytes);
    } catch (error) {
      if (
        [
          "ENOENT",
          "ENOTDIR",
          "EACCES",
          "EPERM",
          "EISDIR",
          "ERR_ENCODING_INVALID_ENCODED_DATA",
        ].includes(error.code)
      )
        return null;
      throw error;
    }
  }

  async loadDocument(uri) {
    while (!this.stopped) {
      const existing = this.documents.get(uri);
      if (existing) return existing;
      const epoch = this.documentEpochs.get(uri) || 0;
      const text = await this.readInput(uri);
      if (this.stopped) return null;
      // A client buffer opened during the disk read always wins. A watched
      // change or close invalidates the older read even if no entry exists.
      const current = this.documents.get(uri);
      if (current) return current;
      if (epoch !== (this.documentEpochs.get(uri) || 0)) continue;
      return text === null ? null : this.makeDocument(uri, text);
    }
    return null;
  }

  async scanDirectory(directory) {
    if (this.stopped) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      if (this.stopped) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        await this.scanDirectory(entryPath);
      } else if (entry.isFile() && INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        await this.loadDocument(canonicalUri(entryPath));
      }
    }
  }

  open(document) {
    this.calculationDiagnostics.delete(document.uri);
    return this.makeDocument(document.uri, document.text, document.version, true);
  }

  change(uri, changes, version) {
    const document = this.documents.get(uri);
    if (!document?.open || version <= document.version) return;
    document.index.applyChanges(changes, version);
    document.text = document.index.text;
    document.version = version;
    const target = this.targetFor(document.text);
    if (target.language !== document.index.target?.language) {
      document.index = createIndex(document.text, { ...target, scopePrefix: uri });
    }
    this.calculationDiagnostics.delete(uri);
    this.invalidate();
  }

  async close(uri) {
    this.touchDocument(uri);
    this.documents.delete(uri);
    this.calculationDiagnostics.delete(uri);
    this.invalidate();
    return this.loadDocument(uri);
  }

  async configure(settings) {
    if (this.stopped) return;
    this.settings = normalizedSettings(settings);
    this.invalidate();
    await this.readTarget();
    if (this.stopped) return;
    for (const document of [...this.documents.values()]) {
      const text = document.open ? document.text : await this.readInput(document.uri);
      if (this.stopped) return;
      if (this.documents.get(document.uri) !== document) continue;
      if (text === null) {
        this.documents.delete(document.uri);
      } else {
        document.text = text;
        document.index = createIndex(text, this.targetFor(text, { scopePrefix: document.uri }));
      }
    }
    this.invalidate();
  }

  async watched(changes) {
    await this.refreshTarget();
    for (const { uri, type } of changes) {
      if (this.stopped) return;
      const filePath = uriPath(uri);
      if (!filePath || path.extname(filePath).toLowerCase() === ".def") continue;
      const documentUri =
        [...this.documents.keys()].find((known) => fileIdentity(known) === fileIdentity(uri)) ||
        uri;
      if (this.documents.get(documentUri)?.open) continue;
      this.touchDocument(documentUri);
      if (type === 3) {
        this.documents.delete(documentUri);
        this.calculationDiagnostics.delete(documentUri);
      } else {
        this.documents.delete(documentUri);
        await this.loadDocument(documentUri);
      }
    }
    this.invalidate();
  }

  async includeTargets(entry, include) {
    const value = String(include.argument || include.name || "")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (!value || include.kind === "dynamic" || /\$\(|#\(/.test(value)) return [];
    const sourcePath = uriPath(entry.uri);
    const paths = path.isAbsolute(value)
      ? [value]
      : [
          path.resolve(sourcePath ? path.dirname(sourcePath) : this.rootPath, value),
          path.resolve(this.rootPath, value),
        ];
    const found = [];
    for (const filePath of new Set(paths)) {
      const uri = canonicalUri(filePath);
      const document = await this.loadDocument(uri);
      if (document) found.push(document);
    }
    return found;
  }

  async graphFor(uri) {
    while (!this.stopped) {
      if (this.views.has(uri)) return this.views.get(uri);
      const revision = this.revision;
      const targetSnapshot = this.target;
      const starting = await this.loadDocument(uri);
      if (!starting || this.stopped) return [];
      const views = [];
      const seen = new Set();
      const observed = [];
      const valid = () =>
        !this.stopped &&
        targetSnapshot === this.target &&
        (revision === this.revision ||
          observed.every(
            ({ entry, index, text, version }) =>
              this.documents.get(entry.uri) === entry &&
              entry.index === index &&
              entry.text === text &&
              entry.version === version,
          ));
      const visit = async (entry, inherited = {}) => {
        if (!valid()) return;
        const contextKey = JSON.stringify([
          entry.uri,
          inherited.module || "",
          inherited.scopeId || "",
          inherited.command || "",
        ]);
        if (seen.has(contextKey)) return;
        seen.add(contextKey);
        observed.push({ entry, index: entry.index, text: entry.text, version: entry.version });
        const index = Object.keys(inherited).length
          ? createIndex(
              entry.text,
              this.targetFor(entry.text, { ...inherited, scopePrefix: entry.uri }),
            )
          : entry.index;
        const view = { ...entry, index, originUri: uri, contextKey };
        views.push(view);
        for (const include of index.includes()) {
          for (const target of await this.includeTargets(view, include)) {
            if (!valid()) return;
            await visit(target, {
              module: include.module,
              scopeId: include.scopeId,
              command: include.command,
            });
          }
        }
      };
      await visit(starting);
      if (this.stopped) return [];
      // Discovery may advance the revision without changing any dependency.
      // Validate the observed documents so a long include chain is traversed
      // once, while edits, replacement buffers and target changes force retry.
      if (!valid()) continue;
      this.views.set(uri, views);
      return views;
    }
    return [];
  }

  occurrenceAt(entry, position) {
    return (entry.index.occurrences || []).find((occurrence) =>
      containsPosition(occurrence.range, position),
    );
  }

  async contextualViews() {
    await this.ready;
    await this.indexReady;
    while (!this.stopped) {
      if (this.allViews) return this.allViews;
      const revision = this.revision;
      const views = [];
      const seen = new Set();
      for (const document of [...this.documents.values()]) {
        for (const view of await this.graphFor(document.uri)) {
          const key = `${view.originUri}:${view.contextKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          views.push(view);
        }
        if (this.stopped || revision !== this.revision) break;
      }
      if (this.stopped) return [];
      if (revision !== this.revision) continue;
      this.allViews = views;
      return views;
    }
    return [];
  }

  catalogFor(views) {
    if (this.declarationCatalog?.views === views) return this.declarationCatalog.names;
    const names = new Map();
    for (const view of views) {
      for (const declaration of view.index.declarations || []) {
        const key = `${declaration.namespace}:${declaration.name.toUpperCase()}`;
        const location = { uri: view.uri, range: declaration.selectionRange || declaration.range };
        if (!names.has(key)) names.set(key, []);
        names.get(key).push({ view, declaration, location, locationKey: JSON.stringify(location) });
      }
    }
    this.declarationCatalog = { views, names };
    return names;
  }

  bindingsFor(occurrence, sourceView, catalog) {
    if (occurrence.wildcard) return [];
    const matches = catalog.get(`${occurrence.namespace}:${occurrence.name.toUpperCase()}`) || [];
    if (occurrence.namespace !== "variable") {
      return matches.filter((item) => item.view.originUri === sourceView.originUri);
    }
    if (occurrence.storage === "persistent" && occurrence.role === "write") {
      const key = JSON.stringify({ uri: sourceView.uri, range: occurrence.range });
      return matches.filter(
        (item) => item.declaration.storage === "persistent" && item.locationKey === key,
      );
    }
    const local = matches.filter(
      ({ declaration }) =>
        declaration.storage !== "persistent" &&
        declaration.scopeId === occurrence.scopeId &&
        (declaration.macro || null) === (occurrence.macro || null),
    );
    return local.length
      ? local
      : matches.filter(({ declaration }) => declaration.storage === "persistent");
  }

  async definitions(uri, position) {
    while (!this.stopped) {
      const revision = this.revision;
      const result = await this.definitionCandidates(uri, position);
      if (this.stopped) return [];
      if (revision === this.revision) return result;
    }
    return [];
  }

  async definitionCandidates(uri, position) {
    const entry = await this.loadDocument(uri);
    if (!entry) return [];
    const include = entry.index
      .includes()
      .find((item) => containsPosition(item.selectionRange || item.range, position));
    const files = include ? await this.includeTargets(entry, include) : [];
    if (include?.kind === "static" && files.length) {
      return files.map((file) => ({ uri: file.uri, range: EMPTY_RANGE }));
    }
    const views = await this.contextualViews();
    const occurrences = views
      .filter((view) => view.uri === uri)
      .map((view) => ({ view, occurrence: this.occurrenceAt(view, position) }))
      .filter(({ occurrence }) => occurrence && !occurrence.wildcard);
    const catalog = this.catalogFor(views);
    const locations = files.map((file) => ({ uri: file.uri, range: EMPTY_RANGE }));
    for (const { view, occurrence } of occurrences) {
      locations.push(...this.bindingsFor(occurrence, view, catalog).map((item) => item.location));
    }
    return uniqueLocations(locations);
  }

  async references(uri, position, includeDeclaration = false) {
    while (!this.stopped) {
      const revision = this.revision;
      const result = await this.referenceCandidates(uri, position, includeDeclaration);
      if (this.stopped) return [];
      if (revision === this.revision) return result;
    }
    return [];
  }

  async referenceCandidates(uri, position, includeDeclaration) {
    const entry = await this.loadDocument(uri);
    if (!entry) return [];
    const views = await this.contextualViews();
    const occurrences = views
      .filter((view) => view.uri === uri)
      .map((view) => ({ view, occurrence: this.occurrenceAt(view, position) }))
      .filter(({ occurrence }) => occurrence && !occurrence.wildcard);
    if (!occurrences.length) return [];
    const locations = [];
    const catalog = this.catalogFor(views);
    const declarations = [];
    for (const { view: sourceView, occurrence } of occurrences) {
      const bindings = this.bindingsFor(occurrence, sourceView, catalog);
      const declarationKeys = new Set(bindings.map((item) => item.locationKey));
      declarations.push(...bindings.map((item) => item.location));
      for (const view of views) {
        if (occurrence.namespace !== "variable" && view.originUri !== sourceView.originUri)
          continue;
        for (const candidate of view.index.occurrences || []) {
          if (
            candidate.wildcard ||
            candidate.name.toUpperCase() !== occurrence.name.toUpperCase() ||
            candidate.namespace !== occurrence.namespace
          )
            continue;
          if (candidate.namespace === "variable") {
            const candidateBindings = this.bindingsFor(candidate, view, catalog);
            if (declarationKeys.size) {
              if (!candidateBindings.some((item) => declarationKeys.has(item.locationKey)))
                continue;
            } else if (
              candidate.scopeId !== occurrence.scopeId ||
              (candidate.macro || null) !== (occurrence.macro || null)
            )
              continue;
          }
          const location = { uri: view.uri, range: candidate.range };
          if (includeDeclaration || !declarationKeys.has(JSON.stringify(location)))
            locations.push(location);
        }
      }
    }
    if (includeDeclaration) locations.push(...declarations);
    return uniqueLocations(locations);
  }

  async visibleSymbols(uri) {
    const result = [];
    for (const view of await this.graphFor(uri)) result.push(...view.index.symbols());
    return result;
  }

  diagnostics(uri) {
    const document = this.documents.get(uri);
    if (!document?.open) return [];
    const diagnostics = (document.index.diagnostics || []).map((item) => ({
      severity: 2,
      source: "sofistik",
      ...item,
    }));
    const keywords = this.targetFor(document.text).keywords;
    const modules = new Set(keywords?.getModuleNames() || []);
    if (keywords) {
      for (const record of document.index.records) {
        if (record.kind !== "program") continue;
        const module = record.tokens.find((token) => token.role === "module");
        if (
          module &&
          module.type === "word" &&
          /^[a-z][a-z0-9]*$/i.test(module.value) &&
          !modules.has(module.value.toUpperCase())
        ) {
          diagnostics.push({
            range: {
              start: { line: record.range.start.line, character: module.start },
              end: { line: record.range.start.line, character: module.end },
            },
            severity: 1,
            source: "sofistik",
            code: "unknown-module",
            message: `Unknown module ${module.value} in the SOFiSTiK ${this.target.version} catalogue.`,
          });
        }
      }
    }
    if (!this.target.dataSupported) {
      diagnostics.push({
        range: EMPTY_RANGE,
        severity: 2,
        source: "sofistik",
        code: "unsupported-project-version",
        message: `No command schema is included for SOFiSTiK ${this.target.version}. Structural navigation remains available.`,
      });
    }
    return [...diagnostics, ...(this.calculationDiagnostics.get(uri) || [])];
  }

  async importCalculationDiagnostics(uri) {
    const document = this.documents.get(uri);
    const filePath = uriPath(uri);
    if (!document?.open || !filePath)
      throw new Error("Open a saved SOFiSTiK document before importing calculation diagnostics.");
    const snapshot = document.version;
    const saved = await this.readInput(uri);
    if (saved !== document.text.replace(/^\uFEFF/, ""))
      throw new Error("Save this document before importing calculation diagnostics.");
    const contents = await fs.readFile(
      filePath.replace(/\.[^.\\/]+$/, "") + ".error_positions",
      "utf8",
    );
    const sourceLines = document.text.split(/\r?\n/);
    const diagnostics = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !Number.isInteger(item.position?.line) ||
        item.position.line < 1 ||
        typeof item.position.text !== "string" ||
        typeof item.isError !== "boolean"
      )
        continue;
      const row = item.position.line - 1;
      const textLine = sourceLines[row];
      if (textLine === undefined) continue;
      diagnostics.push({
        range: {
          start: { line: row, character: 0 },
          end: { line: row, character: Math.max(1, textLine.length) },
        },
        severity: item.isError ? 1 : 3,
        source: "sofistik-calculation",
        code:
          typeof item.errornumber === "number" || typeof item.errornumber === "string"
            ? item.errornumber
            : undefined,
        message: item.position.text,
      });
    }
    if (this.documents.get(uri) !== document || document.version !== snapshot)
      return { uri, count: 0, discarded: true };
    this.calculationDiagnostics.set(uri, diagnostics);
    return { uri, count: diagnostics.length };
  }

  dispose() {
    this.stopped = true;
    this.invalidate();
    this.documents.clear();
    this.views.clear();
    this.calculationDiagnostics.clear();
    this.documentEpochs.clear();
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
};
