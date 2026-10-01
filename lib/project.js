const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { SofistikDataProvider, SofistikEnvironmentResolver } = require("@lumine-code/sofistik-data");
const { createIndex, createNavigationIndex, applyTextChanges } = require("./finder");

const INPUT_EXTENSIONS = new Set([".dat", ".gra", ".grb", ".results"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".archived"]);
const EMPTY_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

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

function directoryIdentity(uri) {
  const filePath = uriPath(uri);
  return filePath ? fileIdentity(canonicalUri(path.dirname(filePath))) : null;
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
    this.settings = normalizedSettings(settings);
    this.data = new SofistikDataProvider();
    this.resolver = options.resolver || new SofistikEnvironmentResolver();
    this.refreshEnvironment =
      options.refreshEnvironment ||
      (async (uri, directories = this.environmentDirectories(uri)) => {
        await this.refreshTargets(directories);
        return directories;
      });
    this.documents = new Map();
    this.targets = new Map();
    this.calculationDiagnostics = new Map();
    this.views = new Map();
    this.documentEpochs = new Map();
    this.skippedInputs = new Map();
    this.onSkippedInput = options.onSkippedInput || (() => {});
    this.contextIndexes = new Map();
    this.stopped = false;
    this.revision = 0;
    this.ready = this.initialize();
  }

  async initialize() {
    this.indexReady = this.scanDirectory(this.rootPath);
    // Keep context requests usable even if a background read fails. Global
    // indexing consumers still receive the original rejection when awaiting it.
    this.indexReady.catch(() => undefined);
  }

  async refreshTargets(directories = null) {
    if (this.stopped) return [];
    const changed = new Map();
    const selections = directories
      ? [...directories].flatMap((directory) =>
          this.targets.has(directory) ? [[directory, this.targets.get(directory)]] : [],
        )
      : this.targets;
    for (const [directory, cached] of selections) {
      const selected = this.resolver.resolve(
        cached.filePath ? { filePath: cached.filePath } : { readDefinition: false },
      );
      if (targetIdentity(selected) === targetIdentity(cached.target)) continue;
      changed.set(directory, selected);
    }
    if (!changed.size) return [];
    for (const [directory, selected] of changed) this.targets.get(directory).target = selected;
    const affected = [];
    // Resolve first, then swap without awaits. Each source keeps its directory's
    // exact selection, including files reached through another input's include.
    for (const document of this.documents.values()) {
      if (!changed.has(directoryIdentity(document.uri))) continue;
      document.target = this.targetFor(document.uri, { scopePrefix: document.uri });
      document.index = this.indexDocument(document);
      this.calculationDiagnostics.delete(document.uri);
      affected.push(document.uri);
    }
    if (affected.length) this.invalidate();
    return affected;
  }

  environmentDirectories(uri) {
    const directories = new Set([directoryIdentity(uri)]);
    const pending = [uri];
    const seen = new Set();
    // Include reachability lives in current lexical indexes, independently of
    // cached contextual views that any source edit invalidates.
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const document = this.documents.get(current);
      if (!document) continue;
      for (const include of document.index.includes()) {
        for (const filePath of this.includePaths(document, include)) {
          const candidate = canonicalUri(filePath);
          directories.add(directoryIdentity(candidate));
          if (this.documents.has(candidate)) pending.push(candidate);
        }
      }
    }
    return directories;
  }

  isDefinitionUri(uri) {
    const filePath = uriPath(uri);
    if (!filePath) return false;
    const name = path.basename(filePath);
    return (process.platform === "win32" ? name.toLowerCase() : name) === "sofistik.def";
  }

  targetFor(uri, inherited = {}) {
    const directory = directoryIdentity(uri);
    let cached = this.targets.get(directory);
    if (!cached) {
      const filePath = uriPath(uri) || undefined;
      cached = {
        filePath,
        target: this.resolver.resolve(filePath ? { filePath } : { readDefinition: false }),
      };
      this.targets.set(directory, cached);
    }
    const target = cached.target;
    return {
      ...inherited,
      ...target,
      keywords: this.data.forRelease(target.version, target.language),
      ...(inherited.scopePrefix && !inherited.scopeId
        ? { scopeId: `${inherited.scopePrefix}:document:0` }
        : {}),
    };
  }

  invalidate() {
    this.revision++;
    this.views.clear();
    this.contextIndexes.clear();
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
    const target = this.targetFor(uri, { scopePrefix: uri });
    const entry = {
      uri,
      text,
      version,
      open,
      target,
    };
    entry.index = this.indexDocument(entry);
    this.documents.set(uri, entry);
    this.touchDocument(uri);
    this.invalidate();
    return entry;
  }

  skipInput(uri) {
    if (this.stopped) return;
    const reason = "Language services are disabled for inputs larger than 8 MiB.";
    if (!this.skippedInputs.has(uri)) this.onSkippedInput(uri, reason);
    this.skippedInputs.set(uri, reason);
  }

  indexDocument(document) {
    if (Buffer.byteLength(document.text, "utf8") > MAX_INPUT_BYTES) {
      this.skipInput(document.uri);
      const index = createIndex("", document.target);
      index.contextAt = () => null;
      return index;
    }
    this.skippedInputs.delete(document.uri);
    return document.open
      ? createIndex(document.text, document.target)
      : createNavigationIndex(document.text, document.target);
  }

  async readInput(uri) {
    const filePath = uriPath(uri);
    if (!filePath || path.extname(filePath).toLowerCase() === ".def") return null;
    try {
      const file = await fs.open(filePath, "r");
      try {
        const stats = await file.stat();
        if (this.stopped) return null;
        if (stats.size > MAX_INPUT_BYTES) {
          if (!this.documents.get(uri)?.open) this.skipInput(uri);
          return null;
        }
        const decoder = new TextDecoder(this.settings.encoding, { fatal: true });
        const buffer = Buffer.alloc(64 * 1024);
        const chunks = [];
        let size = 0;
        while (true) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (this.stopped) return null;
          if (!bytesRead) break;
          size += bytesRead;
          if (size > MAX_INPUT_BYTES) {
            if (!this.documents.get(uri)?.open) this.skipInput(uri);
            return null;
          }
          const bytes = buffer.subarray(0, bytesRead);
          if (bytes.includes(0)) return null;
          chunks.push(decoder.decode(bytes, { stream: true }));
        }
        chunks.push(decoder.decode());
        if (!this.documents.get(uri)?.open) this.skippedInputs.delete(uri);
        return chunks.join("");
      } finally {
        await file.close();
      }
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
    const text = applyTextChanges(document.text, changes);
    if (this.skippedInputs.has(uri) || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      // Apply LSP ranges to the real buffer even while its full index is disabled.
      document.text = text;
      document.index = this.indexDocument(document);
    } else {
      document.index.applyChanges(changes, version);
      document.text = document.index.text;
    }
    document.version = version;
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
      if (!filePath || path.extname(filePath).toLowerCase() === ".def") continue;
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
    this.invalidate();
    return [...affected];
  }

  includePaths(entry, include) {
    const value = String(include.argument || include.name || "")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (!value || include.kind === "dynamic" || /\$\(|#\(/.test(value)) return [];
    const sourcePath = uriPath(entry.uri);
    return path.isAbsolute(value)
      ? [value]
      : [
          path.resolve(sourcePath ? path.dirname(sourcePath) : this.rootPath, value),
          path.resolve(this.rootPath, value),
        ];
  }

  async includeTargets(entry, include) {
    const found = [];
    for (const filePath of new Set(this.includePaths(entry, include))) {
      const uri = canonicalUri(filePath);
      const document = await this.loadDocument(uri);
      if (document) found.push(document);
    }
    return found;
  }

  async graphFor(uri) {
    while (!this.stopped) {
      const refreshed = (await this.refreshEnvironment(uri)) || new Set();
      if (this.stopped) return [];
      if (this.views.has(uri)) return this.views.get(uri);
      const revision = this.revision;
      const starting = await this.loadDocument(uri);
      if (!starting || this.stopped) return [];
      const views = [];
      const seen = new Set();
      const observed = [];
      const valid = () =>
        !this.stopped &&
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
        if (!refreshed.has(directoryIdentity(entry.uri))) {
          // An uncached intermediate can reveal a previously indexed input
          // whose definition was outside the initial include-directory walk.
          const pendingDirectories = new Set(
            [...this.environmentDirectories(entry.uri)].filter(
              (directory) => !refreshed.has(directory),
            ),
          );
          const directories = await this.refreshEnvironment(entry.uri, pendingDirectories);
          for (const directory of directories || []) refreshed.add(directory);
          if (!valid()) return;
        }
        const contextKey = JSON.stringify([
          entry.uri,
          inherited.module || "",
          inherited.scopeId || "",
          inherited.command || "",
        ]);
        if (seen.has(contextKey)) return;
        seen.add(contextKey);
        observed.push({ entry, index: entry.index, text: entry.text, version: entry.version });
        let index = entry.index;
        if (Object.keys(inherited).length) {
          index = this.contextIndexes.get(contextKey);
          if (!index) {
            index = createNavigationIndex(
              this.skippedInputs.has(entry.uri) ? "" : entry.text,
              this.targetFor(entry.uri, { ...inherited, scopePrefix: entry.uri }),
            );
            this.contextIndexes.set(contextKey, index);
          }
        }
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
    if (this.skippedInputs.has(uri))
      diagnostics.push({
        range: EMPTY_RANGE,
        severity: 2,
        source: "sofistik",
        code: "input-size-limit",
        message: this.skippedInputs.get(uri),
      });
    const target = document.target;
    const keywords = target.keywords;
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
            message: `Unknown module ${module.value} in the SOFiSTiK ${target.version} catalogue.`,
          });
        }
      }
    }
    if (!target.dataSupported) {
      diagnostics.push({
        range: EMPTY_RANGE,
        severity: 2,
        source: "sofistik",
        code: "unsupported-project-version",
        message: `No command schema is included for SOFiSTiK ${target.version}. Structural navigation remains available.`,
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
    const targetSnapshot = document.target;
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
    if (
      this.documents.get(uri) !== document ||
      document.version !== snapshot ||
      document.target !== targetSnapshot
    )
      return { uri, count: 0, discarded: true };
    this.calculationDiagnostics.set(uri, diagnostics);
    return { uri, count: diagnostics.length };
  }

  dispose() {
    this.stopped = true;
    this.invalidate();
    this.documents.clear();
    this.targets.clear();
    this.views.clear();
    this.calculationDiagnostics.clear();
    this.documentEpochs.clear();
    this.skippedInputs.clear();
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
