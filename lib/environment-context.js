const fs = require("node:fs/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { commentIndex } = require("./lint-codes");
const path = require("node:path");
const { SofistikSchemaProvider, getMetadata } = require("@lumine-code/sofistik-schema");
const { SofistikContextResolver } = require("@lumine-code/sofistik-context");
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
  constructor(resolver) {
    this.stopped = false;
    this.data = new SofistikSchemaProvider();
    this.versions = getMetadata().versions;
    this.resolver =
      resolver ||
      new SofistikContextResolver({
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

  refreshTargets(directories = null) {
    if (this.stopped) return [];
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
    return [...changed.keys()];
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
    this.stopped = true;
    this.targets.clear();
  }
}

module.exports = { EnvironmentContext, targetIdentity };
