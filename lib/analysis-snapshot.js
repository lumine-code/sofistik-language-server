const { targetIdentity } = require("./environment-context");
const { fileIdentity } = require("./source-resolver");

class AnalysisSnapshot {
  constructor(project, entry) {
    this.project = project;
    this.root = Object.freeze({
      ...project.sources.snapshot(entry),
      environment: targetIdentity(entry.target),
      encoding: project.settings.encoding,
    });
    this.sources = new Map();
    this.initialSources = null;
    this.definition = null;
  }

  captureInputs() {
    this.initialSources = this.project.sources.snapshots();
  }

  async read(uri) {
    const known = this.initialSources.get(fileIdentity(uri));
    const epoch = this.project.sources.epoch(uri);
    const text = known ? known.text : await this.project.readInput(uri);
    const snapshot = known || Object.freeze({ uri, text, epoch, version: 0 });
    this.sources.set(snapshot.uri, snapshot);
    return text === null ? null : { uri: snapshot.uri, text };
  }

  isCurrent() {
    const entry = this.project.documents.get(this.root.uri);
    if (
      !entry?.open ||
      entry.text !== this.root.text ||
      entry.version !== this.root.version ||
      targetIdentity(entry.target) !== this.root.environment ||
      this.project.settings.encoding !== this.root.encoding
    )
      return false;
    if (
      this.definition &&
      this.project.sources.epoch(this.definition.uri) !== this.definition.epoch
    )
      return false;
    return [...this.sources.values()].every((snapshot) => {
      if (this.project.sources.epoch(snapshot.uri) !== snapshot.epoch) return false;
      const current =
        this.project.documents.get(snapshot.uri) ||
        [...this.project.documents.values()].find(
          (document) => fileIdentity(document.uri) === fileIdentity(snapshot.uri),
        );
      return !current || (current.text === snapshot.text && current.version === snapshot.version);
    });
  }
}

module.exports = { AnalysisSnapshot };
