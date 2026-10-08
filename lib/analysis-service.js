"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const { CODES, filterDiagnostics } = require("./lint-codes");

const { fileIdentity: identity, directoryIdentity } = require("./source-resolver");
const { AnalysisSnapshot } = require("./analysis-snapshot");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** One persistent worker and one replaceable job per open entry document. */
class AnalysisService {
  constructor(
    project,
    { delay = 100, onResult = () => {}, onInvalidate = () => {}, onError = () => {} } = {},
  ) {
    this.project = project;
    this.delay = delay;
    this.onResult = onResult;
    this.onInvalidate = onInvalidate;
    this.onError = onError;
    this.jobs = new Map();
    this.ready = new Map();
    this.results = new Map();
    this.contributions = new Map();
    this.related = new Map();
    this.references = new Map();
    this.callers = new Map();
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
    const target = this.contributions.get(identity(uri));
    const diagnostics = [];
    for (const contribution of target?.roots.values() || []) {
      if (this.isCurrent(contribution.job) && !this.isReferencedEntry(contribution.job.uri))
        diagnostics.push(...contribution.diagnostics);
    }
    return this.standardDiagnostics(diagnostics);
  }

  standardDiagnostics(diagnostics) {
    const unique = new Map();
    for (const item of diagnostics) {
      const key = JSON.stringify([
        item.range,
        item.code,
        item.message,
        item.severity,
        item.source,
        item.tags,
        item.codeDescription,
      ]);
      const existing = unique.get(key);
      if (existing) {
        const related = [
          ...(existing.relatedInformation || []),
          ...(item.relatedInformation || []),
        ];
        if (related.length) {
          const locations = new Map(related.map((entry) => [JSON.stringify(entry), entry]));
          existing.relatedInformation = [...locations.values()];
        }
      } else {
        const diagnostic = { ...item };
        delete diagnostic.uri;
        unique.set(key, diagnostic);
      }
    }
    return [...unique.values()];
  }

  relatedUris(uri) {
    const active = (this.results.get(uri) || this.jobs.get(uri))?.targets || [];
    return [...new Set([...active, ...(this.related.get(identity(uri)) || [])])].filter(
      (target) => identity(target) !== identity(uri),
    );
  }

  isReferencedEntry(uri) {
    const key = identity(uri);
    for (const caller of this.callers.get(key) || []) {
      if (!this.document(caller)?.open || (!this.results.has(caller) && !this.jobs.has(caller)))
        continue;
      // Transitive dependency sets identify a reciprocal relationship. Keep
      // both analyses in a cycle so every entry cannot suppress the others.
      if (this.references.get(key)?.has(identity(caller))) continue;
      return true;
    }
    return false;
  }

  replaceReferences(uri, targets, { notify = true } = {}) {
    const rootKey = identity(uri);
    const previous = this.references.get(rootKey) || new Map();
    const next = new Map(
      targets
        .filter((target) => identity(target) !== identity(uri))
        .map((target) => [identity(target), target]),
    );
    const candidates = new Set([uri, ...previous.values(), ...next.values()]);
    const before = new Map(
      [...candidates].map((target) => [target, this.isReferencedEntry(target)]),
    );
    for (const key of previous.keys()) {
      const callers = this.callers.get(key);
      callers?.delete(uri);
      if (callers && !callers.size) this.callers.delete(key);
    }
    if (next.size) this.references.set(rootKey, next);
    else this.references.delete(rootKey);
    for (const key of next.keys()) {
      const callers = this.callers.get(key) || new Set();
      callers.add(uri);
      this.callers.set(key, callers);
    }
    const affected = new Set();
    for (const target of candidates) {
      const removed = previous.has(identity(target)) && !next.has(identity(target));
      if (before.get(target) === this.isReferencedEntry(target) && !removed) continue;
      affected.add(target);
      const entry = this.results.get(target) || this.jobs.get(target);
      for (const destination of entry?.targets || []) affected.add(destination);
    }
    if (notify && affected.size && !this.stopped)
      Promise.resolve(this.onInvalidate([...affected])).catch(this.onError);
    return [...affected];
  }

  reference(job, uri) {
    if (job.cancelled || this.jobs.get(job.uri) !== job) return;
    const targets = [...(this.references.get(identity(job.uri))?.values() || []), uri];
    this.replaceReferences(job.uri, targets);
  }

  trackRelated(uri, targets) {
    const key = identity(uri);
    const related = this.related.get(key) || new Set();
    for (const target of targets) if (identity(target) !== key) related.add(target);
    // Retain removed targets for full pull reports that clear older findings.
    // Open entry sessions can accumulate arbitrary include names over time.
    while (related.size > 2048) related.delete(related.values().next().value);
    this.related.set(key, related);
  }

  register(job) {
    const targets = new Set([
      job.uri,
      ...[...job.sources.values()]
        .filter((source) => source.text !== null)
        .map((source) => source.uri),
    ]);
    const groups = new Map();
    for (const diagnostic of job.diagnostics) {
      const targetUri = this.document(diagnostic.uri || job.uri)?.uri || diagnostic.uri || job.uri;
      const key = identity(targetUri);
      if (!groups.has(key)) groups.set(key, { uri: targetUri, diagnostics: [] });
      groups.get(key).diagnostics.push(diagnostic);
      targets.add(targetUri);
    }
    for (const [key, group] of groups) {
      const target = this.contributions.get(key) || { uri: group.uri, roots: new Map() };
      target.roots.set(job.uri, { job, diagnostics: group.diagnostics });
      this.contributions.set(key, target);
    }
    job.targets = [...targets];
    this.trackRelated(job.uri, targets);
    return [...new Set([...targets, ...this.relatedUris(job.uri)])];
  }

  diagnostics(uri) {
    const entry = this.document(uri);
    const job = this.results.get(uri) || this.jobs.get(uri);
    const sources = new Map([[uri, entry?.text || ""]]);
    for (const source of job?.sources.values() || []) {
      if (source.text !== null) sources.set(source.uri, source.text);
    }
    // Native control diagnostics require the expanded caller context. A raw
    // index may contain inactive branches or only one side of an include.
    const original = (this.project.diagnostics?.(uri) || []).filter(
      (item) => item.code !== "orphan-control" || item.source === "sofistik-calculation",
    );
    const isStatic = (item) =>
      item.source !== "sofistik-calculation" && Object.hasOwn(CODES, item.code);
    const staticIssues = original.filter(isStatic);
    return this.standardDiagnostics([
      ...filterDiagnostics(staticIssues, { uri, sources, ignore: job?.ignore }),
      ...original.filter((item) => !isStatic(item)),
      ...this.cached(uri),
    ]);
  }

  isCurrent(job) {
    return !this.stopped && !job.cancelled && job.snapshot.isCurrent();
  }

  pendingDiagnosticJobs(uri) {
    const key = identity(uri);
    const matches = (target) => identity(target) === key;
    const pending = [];
    for (const job of this.jobs.values()) {
      if (
        matches(job.uri) ||
        job.targets.some(matches) ||
        job.pendingDependencies.some(matches) ||
        job.dependencies.some(matches) ||
        this.references.get(identity(job.uri))?.has(key)
      ) {
        pending.push(job);
        continue;
      }
      for (const source of job.sources.keys()) {
        if (!matches(source)) continue;
        pending.push(job);
        break;
      }
    }
    return pending;
  }

  changed(uri, { immediate = false } = {}) {
    const affected = new Set();
    const definition = /(?:^|\/)sofistik\.def$/i.test(uri);
    for (const [rootUri, result] of [...this.results, ...this.jobs]) {
      if (
        (definition && directoryIdentity(rootUri) === directoryIdentity(uri)) ||
        identity(rootUri) === identity(uri) ||
        result.dependencies?.some((dependency) => identity(dependency) === identity(uri)) ||
        result.pendingDependencies?.some((dependency) => identity(dependency) === identity(uri)) ||
        [...result.sources.keys()].some((dependency) => identity(dependency) === identity(uri))
      )
        affected.add(rootUri);
    }
    const current = this.document(uri);
    if (current?.open) affected.add(current.uri);
    const targets = new Set(affected);
    for (const rootUri of affected) {
      for (const target of this.relatedUris(rootUri)) targets.add(target);
      this.schedule(rootUri, { immediate, notify: false });
      for (const target of this.references.get(identity(rootUri))?.values() || []) {
        targets.add(target);
        const referenced = this.results.get(target) || this.jobs.get(target);
        for (const destination of referenced?.targets || []) targets.add(destination);
      }
    }
    // Every affected root must be pending before a shared source can publish.
    if (targets.size && !this.stopped)
      Promise.resolve(this.onInvalidate([...targets])).catch(this.onError);
    return [...targets];
  }

  schedule(uri, { immediate = false, notify = true } = {}) {
    const previous = this.results.get(uri) || this.jobs.get(uri);
    const dependencies = previous
      ? [
          ...new Set([
            ...previous.dependencies,
            ...(previous.pendingDependencies || []),
            ...previous.sources.keys(),
          ]),
        ]
      : [];
    const entry = this.document(uri);
    if (this.stopped || !entry?.open || this.project.skippedInputs.has(entry.uri)) {
      this.close(uri, { notify });
      return Promise.resolve(null);
    }
    this.forget(uri, { retainReferences: true, notify: false });
    const done = deferred();
    const snapshot = new AnalysisSnapshot(this.project, entry);
    const job = {
      ...done,
      snapshot,
      id: ++this.nextId,
      uri: entry.uri,
      text: entry.text,
      version: entry.version,
      targetVersion: entry.target.version,
      language: entry.target.language,
      encoding: this.project.settings.encoding,
      sources: snapshot.sources,
      dependencies: [],
      pendingDependencies: dependencies,
      targets: previous?.targets || [],
      ignore: previous?.ignore,
      cancellation: new SharedArrayBuffer(4),
    };
    this.jobs.set(job.uri, job);
    const staticIncludes =
      entry.index
        ?.includes?.()
        .flatMap((include) =>
          (this.project.includePaths?.(entry, include) || []).map(
            (filePath) => pathToFileURL(filePath).href,
          ),
        ) || [];
    const included = previous ? [...previous.sources.keys()] : [];
    const targets = new Set([
      job.uri,
      ...job.targets,
      ...this.replaceReferences(job.uri, [...included, ...staticIncludes], { notify: false }),
    ]);
    // Install the replacement before reporting invalidation, so publication
    // can wait for current positions instead of clearing the client's markers.
    if (notify) Promise.resolve(this.onInvalidate([...targets])).catch(this.onError);
    const start = () => {
      job.timer = null;
      if (this.jobs.get(job.uri) !== job) {
        job.resolve(null);
        return;
      }
      if (!this.isCurrent(job)) {
        this.schedule(job.uri);
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
    return this.waitFor(promise, token);
  }

  async waitFor(promise, token) {
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

  async waitDiagnostics(uri, token) {
    const document = this.document(uri);
    const version = document?.version;
    if (document?.open && !this.project.skippedInputs.has(document.uri))
      await this.wait(document.uri, token);
    while (!this.stopped && !token?.isCancellationRequested) {
      if (this.document(uri) !== document || document?.version !== version) return null;
      const jobs = new Set(
        [uri, ...this.relatedUris(uri)].flatMap((target) => this.pendingDiagnosticJobs(target)),
      );
      if (!jobs.size) return this.results.get(document?.uri || uri) || null;
      // Another entry can contribute findings to this file or a related include.
      // Wait for every pending contributor before returning a full LSP report.
      await this.waitFor(Promise.all([...jobs].map((job) => job.promise)), token);
    }
    return null;
  }

  forget(uri, { retainReferences = false, notify = true } = {}) {
    const result = this.results.get(uri);
    const targets = result?.targets || [];
    for (const targetUri of targets) {
      const key = identity(targetUri);
      const target = this.contributions.get(key);
      target?.roots.delete(uri);
      if (target && !target.roots.size) this.contributions.delete(key);
    }
    this.results.delete(uri);
    const job = this.jobs.get(uri);
    if (job) {
      clearTimeout(job.timer);
      job.cancelled = true;
      Atomics.store(new Int32Array(job.cancellation), 0, 1);
      if (this.active === job) this.worker?.postMessage({ type: "cancel", id: job.id });
      job.resolve(null);
      this.jobs.delete(uri);
      this.ready.delete(uri);
    }
    const affected = new Set([...targets, ...(job?.targets || []), job?.uri].filter(Boolean));
    if (!retainReferences)
      for (const target of this.replaceReferences(uri, [], { notify: false })) affected.add(target);
    if (notify && affected.size && !this.stopped)
      Promise.resolve(this.onInvalidate([...affected])).catch(this.onError);
  }

  close(uri, { notify = true } = {}) {
    const targets = new Set([
      uri,
      ...this.relatedUris(uri),
      ...(this.results.get(uri)?.targets || []),
    ]);
    for (const target of this.replaceReferences(uri, [], { notify: false })) targets.add(target);
    this.forget(uri, { notify: false, retainReferences: true });
    this.related.delete(identity(uri));
    if (notify && !this.stopped)
      Promise.resolve(this.onInvalidate([...targets])).catch(this.onError);
    return [...targets];
  }

  startWorker() {
    if (this.worker) return;
    const worker = new Worker(path.join(__dirname, "analysis-worker.js"));
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
    job.snapshot.captureInputs();
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
        type: "analyze",
        id: job.id,
        entry: { uri: job.uri, text: job.text },
        cancellation: job.cancellation,
        options: {
          defines,
          defineOrigins: job.defineOrigins,
          version: job.targetVersion,
          language: job.language,
        },
      });
    } catch (error) {
      this.onError(error);
      this.finish({ type: "error", id: job.id });
    }
  }

  async readSource(job, uri) {
    const source = await job.snapshot.read(uri);
    job.dependencies.push(uri);
    const snapshot = [...job.sources.values()].find(
      (entry) => identity(entry.uri) === identity(uri),
    );
    this.reference(job, snapshot?.uri || uri);
    return source;
  }

  async defines(job) {
    const definitionUri = this.project.environment.definitionUri(job.uri);
    job.definitionEpoch = definitionUri ? this.project.sources.epoch(definitionUri) : null;
    const definition = await this.project.environment.definitions(job.uri, job.encoding);
    job.defineOrigins = definition.origins;
    if (definition.uri) {
      job.dependencies.push(definition.uri);
      job.snapshot.definition = Object.freeze({
        uri: definition.uri,
        text: definition.text,
        epoch: job.definitionEpoch,
        defines: Object.freeze({ ...definition.defines }),
        origins: definition.origins,
      });
    }
    return definition.defines;
  }

  finish(message) {
    const job = this.active;
    if (!job || message.id !== job.id) return;
    this.active = null;
    job.snapshot.initialSources = null;
    const current = message.type === "result" && this.isCurrent(job);
    if (current) {
      if (this.jobs.get(job.uri) === job) this.jobs.delete(job.uri);
      const dependencies = [...new Set([...job.dependencies, ...message.result.dependencies])];
      const result = {
        uri: job.uri,
        version: job.version,
        snapshot: job.snapshot,
        sources: job.sources,
        ignore: job.ignore,
        ...message.result,
        dependencies,
        pendingDependencies: [],
      };
      this.results.set(job.uri, result);
      const targets = this.register(result);
      for (const target of this.replaceReferences(job.uri, [...job.sources.keys()], {
        notify: false,
      }))
        targets.push(target);
      job.resolve(result);
      Promise.resolve(this.onResult(job.uri, targets)).catch(this.onError);
    } else {
      job.resolve(null);
      // An input can change before an include's first read established its
      // dependency. A rejected snapshot must still converge to current input.
      if (message.type === "result" && !job.cancelled && this.document(job.uri)?.open)
        this.schedule(job.uri);
      else if (this.jobs.get(job.uri) === job) {
        this.jobs.delete(job.uri);
        const targets = new Set([
          job.uri,
          ...job.targets,
          ...job.sources.keys(),
          ...this.relatedUris(job.uri),
          ...this.replaceReferences(job.uri, [], { notify: false }),
        ]);
        if (!this.stopped) Promise.resolve(this.onInvalidate([...targets])).catch(this.onError);
      }
    }
    this.worker?.unref();
    this.drain();
  }

  dispose() {
    this.stopped = true;
    for (const uri of this.jobs.keys()) this.forget(uri);
    this.results.clear();
    this.contributions.clear();
    this.related.clear();
    this.references.clear();
    this.callers.clear();
    const worker = this.worker;
    this.worker = null;
    return worker?.terminate();
  }
}

module.exports = { AnalysisService };
