"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { CODES, commentIndex, filterDiagnostics } = require("./lint-codes");

const identity = (uri) => {
  try {
    const filePath = path.resolve(fileURLToPath(uri));
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  } catch {
    return uri;
  }
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** One persistent worker and one replaceable job per open entry document. */
class LintService {
  constructor(project, { delay = 300, onResult = () => {}, onError = () => {} } = {}) {
    this.project = project;
    this.delay = delay;
    this.onResult = onResult;
    this.onError = onError;
    this.jobs = new Map();
    this.ready = new Map();
    this.results = new Map();
    this.nextId = 0;
    this.stopped = false;
  }

  document(uri) {
    return (
      this.project.documents.get(uri) ||
      [...this.project.documents.values()].find((entry) => identity(entry.uri) === identity(uri))
    );
  }

  cached(uri) {
    const result = this.results.get(uri);
    return result && this.isCurrent(result) ? result.diagnostics : [];
  }

  diagnostics(uri) {
    const entry = this.document(uri);
    const job = this.results.get(uri) || this.jobs.get(uri);
    const sources = new Map([[uri, entry?.text || ""]]);
    for (const source of job?.sources.values() || []) {
      if (source.text !== null) sources.set(source.uri, source.text);
    }
    const original = this.project.diagnostics(uri);
    const isStatic = (item) =>
      item.source !== "sofistik-calculation" && Object.hasOwn(CODES, item.code);
    const staticIssues = original.filter(isStatic);
    return [
      ...filterDiagnostics(staticIssues, { uri, sources, ignore: job?.ignore }),
      ...original.filter((item) => !isStatic(item)),
      ...this.cached(uri),
    ];
  }

  isCurrent(job) {
    const root = this.document(job.uri);
    if (
      this.stopped ||
      job.cancelled ||
      !root?.open ||
      root.text !== job.text ||
      root.version !== job.version ||
      root.target.version !== job.targetVersion ||
      root.target.language !== job.language ||
      this.project.settings.encoding !== job.encoding
    )
      return false;
    return [...job.sources.values()].every((snapshot) => {
      if ((this.project.documentEpochs.get(snapshot.uri) || 0) !== snapshot.epoch) return false;
      const current = this.document(snapshot.uri);
      return !current || (current.text === snapshot.text && current.version === snapshot.version);
    });
  }

  changed(uri, { immediate = false } = {}) {
    const affected = new Set();
    const definition = /(?:^|\/)sofistik\.def$/i.test(uri);
    for (const [rootUri, result] of [...this.results, ...this.jobs]) {
      if (
        definition ||
        identity(rootUri) === identity(uri) ||
        result.dependencies?.some((dependency) => identity(dependency) === identity(uri)) ||
        [...result.sources.keys()].some((dependency) => identity(dependency) === identity(uri))
      )
        affected.add(rootUri);
    }
    const current = this.document(uri);
    if (current?.open) affected.add(current.uri);
    for (const rootUri of affected) this.schedule(rootUri, { immediate });
    return [...affected];
  }

  schedule(uri, { immediate = false } = {}) {
    const previous = this.results.get(uri) || this.jobs.get(uri);
    const dependencies = previous
      ? [...new Set([...previous.dependencies, ...previous.sources.keys()])]
      : [];
    this.forget(uri);
    const entry = this.document(uri);
    if (this.stopped || !entry?.open || this.project.skippedInputs.has(entry.uri))
      return Promise.resolve(null);
    const done = deferred();
    const job = {
      ...done,
      id: ++this.nextId,
      uri: entry.uri,
      text: entry.text,
      version: entry.version,
      targetVersion: entry.target.version,
      language: entry.target.language,
      encoding: this.project.settings.encoding,
      sources: new Map(),
      dependencies,
      ignore: previous?.ignore,
      cancellation: new SharedArrayBuffer(4),
    };
    this.jobs.set(job.uri, job);
    const start = () => {
      job.timer = null;
      if (this.jobs.get(job.uri) !== job || !this.isCurrent(job)) {
        job.resolve(null);
        return;
      }
      this.ready.set(job.uri, job);
      this.drain();
    };
    if (immediate) start();
    else job.timer = setTimeout(start, this.delay);
    return job.promise;
  }

  async wait(uri, token) {
    if (!this.document(uri)?.open || this.stopped) return null;
    const cached = this.results.get(uri);
    if (cached && this.isCurrent(cached)) return cached;
    const promise = this.jobs.get(uri)?.promise || this.schedule(uri, { immediate: true });
    if (!token?.onCancellationRequested) return promise;
    if (token.isCancellationRequested) return null;
    let subscription;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          subscription = token.onCancellationRequested(() => resolve(null));
        }),
      ]);
    } finally {
      subscription?.dispose();
    }
  }

  forget(uri) {
    this.results.delete(uri);
    const job = this.jobs.get(uri);
    if (!job) return;
    clearTimeout(job.timer);
    job.cancelled = true;
    Atomics.store(new Int32Array(job.cancellation), 0, 1);
    if (this.active === job) this.worker?.postMessage({ type: "cancel", id: job.id });
    job.resolve(null);
    this.jobs.delete(uri);
    this.ready.delete(uri);
  }

  startWorker() {
    if (this.worker) return;
    const worker = new Worker(path.join(__dirname, "lint-worker.js"));
    this.worker = worker;
    worker.on("message", (message) => {
      if (message.type === "read") {
        const job = this.active;
        const reading =
          job?.id === message.id && !job.cancelled ? this.readSource(job, message.uri) : null;
        Promise.resolve(reading)
          .catch((error) => {
            this.onError(error);
            return null;
          })
          .then((source) => {
            if (this.worker === worker)
              worker.postMessage({ type: "source", readId: message.readId, source });
          });
        return;
      }
      this.finish(message);
    });
    worker.on("error", (error) => {
      this.onError(error);
      if (this.worker === worker) this.worker = null;
      void worker.terminate();
      this.finish({ type: "error", id: this.active?.id });
    });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.finish({ type: "error", id: this.active?.id });
    });
    worker.unref();
  }

  async drain() {
    if (this.stopped || this.active || !this.ready.size) return;
    const [uri, job] = this.ready.entries().next().value;
    this.ready.delete(uri);
    this.active = job;
    job.initialSources = new Map(
      [...this.project.documents.values()].map((entry) => [
        identity(entry.uri),
        {
          uri: entry.uri,
          text: entry.text,
          version: entry.version,
          epoch: this.project.documentEpochs.get(entry.uri) || 0,
        },
      ]),
    );
    try {
      const defines = await this.defines(job);
      job.ignore = defines.NOQA;
      if (!this.isCurrent(job)) {
        this.finish({ type: "error", id: job.id });
        return;
      }
      this.startWorker();
      this.worker.ref();
      this.worker.postMessage({
        type: "lint",
        id: job.id,
        entry: { uri: job.uri, text: job.text },
        cancellation: job.cancellation,
        options: { defines, version: job.targetVersion, language: job.language },
      });
    } catch (error) {
      this.onError(error);
      this.finish({ type: "error", id: job.id });
    }
  }

  async readSource(job, uri) {
    const known = job.initialSources.get(identity(uri));
    const epoch = this.project.documentEpochs.get(uri) || 0;
    const text = known ? known.text : await this.project.readInput(uri);
    const snapshot = known || { uri, text, epoch, version: 0 };
    job.sources.set(snapshot.uri, snapshot);
    job.dependencies.push(uri);
    return text === null ? null : { uri: snapshot.uri, text };
  }

  async defines(job) {
    let name = "untitled";
    let definition;
    try {
      const filePath = fileURLToPath(job.uri);
      name = path.basename(filePath, path.extname(filePath));
      definition = pathToFileURL(path.join(path.dirname(filePath), "sofistik.def")).href;
    } catch {
      // Unsaved buffers have no adjacent filesystem definition.
    }
    const defines = { NAME: name, PROJECT: name };
    if (!definition) return defines;
    job.dependencies.push(definition);
    try {
      const bytes = await fs.readFile(fileURLToPath(definition));
      if (bytes.length > 64 * 1024) return defines;
      const text = new TextDecoder(job.encoding, { fatal: true }).decode(bytes);
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:SET\s+)?([A-Z][\w.-]*)\s*=\s*(.*?)\s*$/i);
        if (match) {
          defines[match[1].toUpperCase()] = match[2]
            .slice(0, commentIndex(match[2], false))
            .trimEnd();
        }
      }
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code)
      )
        throw error;
    }
    return defines;
  }

  finish(message) {
    const job = this.active;
    if (!job || message.id !== job.id) return;
    this.active = null;
    job.initialSources = null;
    const current = message.type === "result" && this.isCurrent(job);
    if (this.jobs.get(job.uri) === job) this.jobs.delete(job.uri);
    if (current) {
      const dependencies = [...new Set([...job.dependencies, ...message.result.dependencies])];
      Object.assign(job, message.result, { dependencies });
      this.results.set(job.uri, job);
      job.resolve(job);
      Promise.resolve(this.onResult(job.uri)).catch(this.onError);
    } else {
      job.resolve(null);
      // An input can change before an include's first read established its
      // dependency. A rejected snapshot must still converge to current input.
      if (message.type === "result" && !job.cancelled && this.document(job.uri)?.open)
        this.schedule(job.uri);
    }
    this.worker?.unref();
    this.drain();
  }

  dispose() {
    this.stopped = true;
    for (const uri of this.jobs.keys()) this.forget(uri);
    this.results.clear();
    const worker = this.worker;
    this.worker = null;
    return worker?.terminate();
  }
}

module.exports = { LintService };
