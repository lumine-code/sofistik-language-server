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
    return uri.startsWith("file:") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
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
    this.stopped = false;
    this.revision = 0;
    this.ready = this.initialize();
  }

  async initialize() {
    await this.readTarget();
    await this.scanDirectory(this.rootPath);
  }

  async readTarget() {
    try {
      this.definitionText = await fs.readFile(path.join(this.rootPath, "sofistik.def"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      this.definitionText = "";
    }
    this.target = this.resolver.resolve({ projectPath: this.rootPath });
  }

  targetFor(_text, inherited = {}) {
    const language = this.target.language;
    return {
      ...this.target,
      language,
      keywords: this.data.forRelease(this.target.version, language),
      ...inherited,
    };
  }

  invalidate() {
    this.revision++;
    this.views.clear();
    this.allViews = null;
  }

  makeDocument(uri, text, version = 0, open = false) {
    const entry = {
      uri,
      text,
      version,
      open,
      index: createIndex(text, this.targetFor(text, { scopePrefix: uri })),
    };
    this.documents.set(uri, entry);
    this.invalidate();
    return entry;
  }

  async readInput(uri) {
    const filePath = uriPath(uri);
    if (!filePath) return null;
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
    const existing = this.documents.get(uri);
    if (existing) return existing;
    const text = await this.readInput(uri);
    return text === null ? null : this.makeDocument(uri, text);
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
    this.documents.delete(uri);
    this.calculationDiagnostics.delete(uri);
    this.invalidate();
    return this.loadDocument(uri);
  }

  async configure(settings) {
    this.settings = normalizedSettings(settings);
    await this.readTarget();
    for (const document of this.documents.values()) {
      const text = document.open ? document.text : await this.readInput(document.uri);
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
    if (changes.some(({ uri }) => uri === this.definitionUri)) {
      await this.configure(this.settings);
    }
    for (const { uri, type } of changes) {
      if (uri === this.definitionUri || this.documents.get(uri)?.open) continue;
      if (type === 3) {
        this.documents.delete(uri);
        this.calculationDiagnostics.delete(uri);
      } else {
        this.documents.delete(uri);
        await this.loadDocument(uri);
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
    if (this.views.has(uri)) return this.views.get(uri);
    const starting = await this.loadDocument(uri);
    if (!starting) return [];
    const views = [];
    const seen = new Set();
    const visit = async (entry, inherited = {}) => {
      const key = `${entry.uri}:${inherited.module || ""}:${inherited.scopeId || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      const index = Object.keys(inherited).length
        ? createIndex(
            entry.text,
            this.targetFor(entry.text, { ...inherited, scopePrefix: entry.uri }),
          )
        : entry.index;
      const view = { ...entry, index };
      views.push(view);
      for (const include of index.includes()) {
        for (const target of await this.includeTargets(view, include)) {
          // Cycles are bounded by the path as well as contextual identity.
          if (views.some((item) => item.uri === target.uri && item.index === target.index))
            continue;
          await visit(target, {
            module: include.module,
            scopeId: include.scopeId,
            command: include.command,
          });
        }
      }
    };
    await visit(starting);
    this.views.set(uri, views);
    return views;
  }

  occurrenceAt(entry, position) {
    return (entry.index.occurrences || []).find((occurrence) =>
      containsPosition(occurrence.range, position),
    );
  }

  async contextualViews() {
    if (this.allViews) return this.allViews;
    const views = [];
    const seen = new Set();
    for (const document of [...this.documents.values()]) {
      for (const view of await this.graphFor(document.uri)) {
        const key = `${view.uri}:${view.index.records[0]?.context?.scopeId || ""}:${view.index.records[0]?.context?.module || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        views.push(view);
      }
    }
    this.allViews = views;
    return views;
  }

  async definitions(uri, position) {
    const entry = await this.loadDocument(uri);
    if (!entry) return [];
    const include = entry.index
      .includes()
      .find((item) => containsPosition(item.selectionRange || item.range, position));
    if (include) {
      const files = await this.includeTargets(entry, include);
      if (files.length) return files.map((file) => ({ uri: file.uri, range: EMPTY_RANGE }));
    }
    const views = await this.contextualViews();
    const occurrences = views
      .filter((view) => view.uri === uri)
      .map((view) => this.occurrenceAt(view, position))
      .filter(Boolean);
    if (!occurrences.length) return [];
    const locations = [];
    for (const occurrence of occurrences) {
      const local = [];
      const persistent = [];
      for (const view of views) {
        for (const declaration of view.index.declarations || []) {
          if (
            declaration.name.toUpperCase() !== occurrence.name.toUpperCase() ||
            declaration.namespace !== occurrence.namespace
          )
            continue;
          const location = {
            uri: view.uri,
            range: declaration.selectionRange || declaration.range,
          };
          if (occurrence.namespace === "variable") {
            if (declaration.storage === "persistent") persistent.push(location);
            else if (
              declaration.scopeId === occurrence.scopeId &&
              (declaration.macro || null) === (occurrence.macro || null)
            )
              local.push(location);
          } else {
            local.push(location);
          }
        }
      }
      locations.push(...(local.length ? local : persistent));
    }
    return uniqueLocations(locations);
  }

  async references(uri, position, includeDeclaration = false) {
    const entry = await this.loadDocument(uri);
    if (!entry) return [];
    const views = await this.contextualViews();
    const occurrences = views
      .filter((view) => view.uri === uri)
      .map((view) => this.occurrenceAt(view, position))
      .filter(Boolean);
    if (!occurrences.length) return [];
    const locations = [];
    const declarationLocations = await this.definitions(uri, position);
    const declarationKeys = new Set(declarationLocations.map((item) => JSON.stringify(item)));
    const persistent = views.some((view) =>
      (view.index.declarations || []).some(
        (declaration) =>
          declaration.storage === "persistent" &&
          declarationKeys.has(
            JSON.stringify({
              uri: view.uri,
              range: declaration.selectionRange || declaration.range,
            }),
          ),
      ),
    );
    for (const occurrence of occurrences) {
      for (const view of views) {
        for (const candidate of view.index.occurrences || []) {
          if (
            candidate.name.toUpperCase() !== occurrence.name.toUpperCase() ||
            candidate.namespace !== occurrence.namespace
          )
            continue;
          if (
            candidate.namespace === "variable" &&
            !persistent &&
            (candidate.scopeId !== occurrence.scopeId ||
              (candidate.macro || null) !== (occurrence.macro || null))
          )
            continue;
          const location = { uri: view.uri, range: candidate.range };
          if (includeDeclaration || !declarationKeys.has(JSON.stringify(location)))
            locations.push(location);
        }
      }
    }
    if (includeDeclaration) locations.push(...declarationLocations);
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
        if (module && !modules.has(module.value.toUpperCase())) {
          diagnostics.push({
            range: module.range || record.range,
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
    this.documents.clear();
    this.views.clear();
    this.calculationDiagnostics.clear();
  }
}

module.exports = {
  SofistikProject,
  canonicalUri,
  containsPosition,
  normalizedSettings,
  uriPath,
  uniqueLocations,
};
