"use strict";

const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { preprocess } = require("./preprocessor");
const { LintEngine } = require("./lint-engine");
const { filterDiagnostics } = require("./lint-codes");

const data = new SofistikDataProvider();
const engine = new LintEngine();
const cache = new Map();
const reads = new Map();
let nextRead = 0;

parentPort.on("message", async (message) => {
  if (message.type === "source") {
    const read = reads.get(message.readId);
    reads.delete(message.readId);
    read?.resolve(message.source);
    return;
  }
  if (message.type === "cancel") {
    for (const [readId, read] of reads) {
      if (read.id !== message.id) continue;
      reads.delete(readId);
      read.resolve(null);
    }
    return;
  }
  if (message.type !== "lint") return;
  const { id, entry, options, cancellation } = message;
  const flag = new Int32Array(cancellation);
  const isCancelled = () => Atomics.load(flag, 0) !== 0;
  const sources = new Map([[entry.uri, entry.text]]);
  const readSource = (uri) =>
    new Promise((resolve) => {
      const readId = ++nextRead;
      reads.set(readId, {
        id,
        resolve: (source) => {
          if (source) sources.set(source.uri, source.text);
          resolve(source);
        },
      });
      parentPort.postMessage({ type: "read", id, readId, uri });
    });
  try {
    const start = performance.now();
    const expanded = await preprocess(entry, { ...options, cache, readSource, isCancelled });
    if (isCancelled())
      throw Object.assign(new Error("Analysis superseded."), { name: "AbortError" });
    const preprocessorMs = performance.now() - start;
    const result = engine.analyze({
      ...expanded,
      uri: entry.uri,
      version: options.version,
      language: options.language,
      keywords: data.forRelease(options.version, options.language),
      isCancelled,
    });
    if (cache.size > 128) cache.clear();
    parentPort.postMessage({
      type: "result",
      id,
      result: {
        ...result,
        diagnostics: filterDiagnostics(
          [...expanded.diagnostics, ...result.diagnostics].map((diagnostic) => ({
            ...diagnostic,
            uri: diagnostic.uri || entry.uri,
          })),
          {
            uri: entry.uri,
            sources,
            ignore: options.defines?.NOQA,
          },
        ),
        dependencies: expanded.dependencies,
        metrics: {
          ...result.metrics,
          preprocessorMs,
          totalMs: performance.now() - start,
          expandedBytes: Buffer.byteLength(expanded.text),
        },
      },
    });
  } catch (error) {
    parentPort.postMessage({ type: "error", id, name: error.name, message: error.message });
  }
});
