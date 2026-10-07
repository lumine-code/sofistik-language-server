const fs = require("node:fs/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { commentIndex } = require("./lint-codes");
const path = require("node:path");
const { SofistikDataProvider, getMetadata } = require("@lumine-code/sofistik-data");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-env");
const { canonicalUri, uriPath, directoryIdentity } = require("./source-resolver");

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

/** Composes installation selection with the bundled schema catalogue. */
class EnvironmentContext {
  constructor(project, resolver) {
    this.project = project;
    this.data = new SofistikDataProvider();
    this.versions = getMetadata().versions;
    this.resolver =
      resolver ||
      new SofistikEnvironmentResolver({
        fallbackVersion: () => this.versions.at(-1),
      });
    this.targets = new Map();
  }

  select(options) {
    const target = this.resolver.resolve(options);
    return Object.freeze({
      ...target,
      dataSupported: this.versions.includes(String(target.version)),
    });
  }

  async refreshTargets(directories = null) {
    if (this.project.stopped) return [];
    const changed = new Map();
    const selections = directories
      ? [...directories].flatMap((directory) =>
          this.targets.has(directory) ? [[directory, this.targets.get(directory)]] : [],
        )
      : this.targets;
    for (const [directory, cached] of selections) {
      const selected = this.select(
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
    for (const document of this.project.documents.values()) {
      if (!changed.has(directoryIdentity(document.uri))) continue;
      document.target = this.targetFor(document.uri, { scopePrefix: document.uri });
      document.index = this.project.indexDocument(document);
      this.project.calculationDiagnostics.delete(document.uri);
      affected.push(document.uri);
    }
    for (const uri of affected) this.project.invalidate(uri);
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
      const document = this.project.documents.get(current);
      if (!document) continue;
      for (const include of document.index.includes()) {
        for (const filePath of this.project.includePaths(document, include)) {
          const candidate = canonicalUri(filePath);
          directories.add(directoryIdentity(candidate));
          if (this.project.documents.has(candidate)) pending.push(candidate);
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
        target: this.select(filePath ? { filePath } : { readDefinition: false }),
      };
      this.targets.set(directory, cached);
    }
    const target = cached.target;
    return {
      ...inherited,
      ...target,
      keywords: target.dataSupported ? this.data.forRelease(target.version, target.language) : null,
      ...(inherited.scopePrefix && !inherited.scopeId
        ? { scopeId: `${inherited.scopePrefix}:document:0` }
        : {}),
    };
  }

  definitionUri(uri) {
    const filePath = uriPath(uri);
    return filePath ? canonicalUri(path.join(path.dirname(filePath), "sofistik.def")) : null;
  }

  async definitions(uri, encoding) {
    const origins = {};
    let text = null;
    let name = "untitled";
    let definition;
    try {
      const filePath = fileURLToPath(uri);
      name = path.basename(filePath, path.extname(filePath));
      definition = pathToFileURL(path.join(path.dirname(filePath), "sofistik.def")).href;
    } catch {
      // Unsaved buffers have no adjacent filesystem definition.
    }
    const defines = { NAME: name, PROJECT: name };
    if (!definition) return { defines, origins, uri: null, text };
    try {
      const bytes = await fs.readFile(fileURLToPath(definition));
      if (bytes.length > 64 * 1024) return { defines, origins, uri: definition, text };
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
        const match = line.match(/^\s*(?:SET\s+)?([A-Z][\w.-]*)\s*=\s*(.*?)\s*$/i);
        if (match) {
          defines[match[1].toUpperCase()] = match[2]
            .slice(0, commentIndex(match[2], false))
            .trimEnd();
          let start = line.indexOf("=") + 1;
          while (/\s/.test(line[start] || "")) start++;
          origins[match[1].toUpperCase()] = {
            uri: definition,
            range: {
              start: { line: lineNumber, character: start },
              end: { line: lineNumber, character: start + defines[match[1].toUpperCase()].length },
            },
          };
        }
      }
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code)
      )
        throw error;
    }
    return { defines, origins, uri: definition, text };
  }

  dispose() {
    this.targets.clear();
  }
}

module.exports = { EnvironmentContext, targetIdentity };
