const fs = require("node:fs/promises");
const path = require("node:path");
const { createIndex, createNavigationIndex, applyTextChanges } = require("./finder");
const { canonicalUri, uriPath, fileIdentity } = require("./source-resolver");

const INPUT_EXTENSIONS = new Set([".dat", ".gra", ".grb", ".results"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".archived"]);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/** Owns source generations, bounded disk decoding and open-buffer indexes. */
class SourceStore {
  constructor(project, options = {}) {
    this.project = project;
    this.documents = new Map();
    this.documentEpochs = new Map();
    this.skippedInputs = new Map();
    this.onSkippedInput = options.onSkippedInput || (() => {});
    this.onIndexedInput = options.onIndexedInput || (() => {});
    this.indexedInputs = 0;
    this.stopped = false;
  }

  epoch(uri) {
    return this.documentEpochs.get(fileIdentity(uri)) || 0;
  }

  touchDocument(uri) {
    const key = fileIdentity(uri);
    const next = this.epoch(uri) + 1;
    this.documentEpochs.set(key, next);
  }

  snapshot(entry) {
    return Object.freeze({
      uri: entry.uri,
      text: entry.text,
      version: entry.version,
      epoch: this.epoch(entry.uri),
    });
  }

  snapshots() {
    return new Map(
      [...this.documents.values()].map((entry) => [fileIdentity(entry.uri), this.snapshot(entry)]),
    );
  }

  makeDocument(uri, text, version = 0, open = false) {
    if (this.stopped) return null;
    const filePath = uriPath(uri);
    if (filePath && path.extname(filePath).toLowerCase() === ".def") return null;
    const target = this.project.targetFor(uri, { scopePrefix: uri });
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
    this.project.invalidate(entry.uri);
    return entry;
  }

  skipInput(uri) {
    if (this.stopped) return;
    const reason = `Language services are disabled for inputs larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MiB.`;
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
        const decoder = new TextDecoder(this.project.settings.encoding, { fatal: true });
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
      const epoch = this.epoch(uri);
      const text = await this.project.readInput(uri);
      if (this.stopped) return null;
      // A client buffer opened during the disk read always wins. A watched
      // change or close invalidates the older read even if no entry exists.
      const current = this.documents.get(uri);
      if (current) return current;
      if (epoch !== this.epoch(uri)) continue;
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
        const document = await this.loadDocument(canonicalUri(entryPath));
        if (document && !this.stopped) this.onIndexedInput(++this.indexedInputs);
      }
    }
  }

  open(document) {
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
    this.project.invalidate(uri);
  }

  async close(uri) {
    this.touchDocument(uri);
    this.documents.delete(uri);
    this.project.invalidate(uri);
    return this.loadDocument(uri);
  }

  dispose() {
    this.stopped = true;
    this.documents.clear();
    this.documentEpochs.clear();
    this.skippedInputs.clear();
  }
}

module.exports = { SourceStore, MAX_INPUT_BYTES };
