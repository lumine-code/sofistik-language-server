const { createNavigationIndex } = require("./finder");
const { directoryIdentity, fileIdentity, canonicalUri } = require("./source-resolver");
const { containsPosition, uniqueLocations, EMPTY_RANGE } = require("./ranges");

/** Raw lexical reachability and caller-specific declaration bindings. */
class NavigationIndex {
  constructor(project) {
    this.project = project;
    this.views = new Map();
    this.contextIndexes = new Map();
    this.dependencies = new Map();
    this.revision = 0;
  }

  invalidate(uri) {
    this.revision++;
    if (uri) {
      for (const [root, views] of this.views) {
        if (
          views.some((view) => fileIdentity(view.uri) === fileIdentity(uri)) ||
          this.dependencies.get(root)?.has(fileIdentity(uri))
        ) {
          this.views.delete(root);
          this.dependencies.delete(root);
        }
      }
      for (const key of this.contextIndexes.keys()) {
        if (fileIdentity(JSON.parse(key)[0]) === fileIdentity(uri)) this.contextIndexes.delete(key);
      }
    } else {
      this.views.clear();
      this.contextIndexes.clear();
      this.dependencies.clear();
    }
    this.allViews = null;
    this.declarationCatalog = null;
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

  async graphFor(uri) {
    while (!this.project.stopped) {
      const refreshed = (await this.project.refreshEnvironment(uri)) || new Set();
      if (this.project.stopped) return [];
      if (this.views.has(uri)) return this.views.get(uri);
      const revision = this.revision;
      const starting = await this.project.loadDocument(uri);
      if (!starting || this.project.stopped) return [];
      const views = [];
      const seen = new Set();
      const observed = [];
      const dependencies = new Set([fileIdentity(uri)]);
      const valid = () =>
        !this.project.stopped &&
        (revision === this.revision ||
          observed.every(
            ({ entry, index, text, version }) =>
              this.project.documents.get(entry.uri) === entry &&
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
            [...this.project.environmentDirectories(entry.uri)].filter(
              (directory) => !refreshed.has(directory),
            ),
          );
          const directories = await this.project.refreshEnvironment(entry.uri, pendingDirectories);
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
              this.project.skippedInputs.has(entry.uri) ? "" : entry.text,
              this.project.targetFor(entry.uri, { ...inherited, scopePrefix: entry.uri }),
            );
            this.contextIndexes.set(contextKey, index);
          }
        }
        const view = { ...entry, index, originUri: uri, contextKey };
        views.push(view);
        for (const include of index.includes()) {
          const candidate = this.project.sourceResolver.staticInclude(view, include);
          if (candidate) dependencies.add(fileIdentity(candidate));
          for (const target of await this.project.includeTargets(view, include)) {
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
      if (this.project.stopped) return [];
      // Discovery may advance the revision without changing any dependency.
      // Validate the observed documents so a long include chain is traversed
      // once, while edits, replacement buffers and target changes force retry.
      if (!valid()) continue;
      this.views.set(uri, views);
      this.dependencies.set(uri, dependencies);
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
    await this.project.ready;
    await this.project.indexReady;
    while (!this.project.stopped) {
      if (this.allViews) return this.allViews;
      const revision = this.revision;
      const views = [];
      const seen = new Set();
      for (const document of [...this.project.documents.values()]) {
        for (const view of await this.graphFor(document.uri)) {
          const key = `${view.originUri}:${view.contextKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          views.push(view);
        }
        if (this.project.stopped || revision !== this.revision) break;
      }
      if (this.project.stopped) return [];
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
    while (!this.project.stopped) {
      const revision = this.revision;
      const result = await this.definitionCandidates(uri, position);
      if (this.project.stopped) return [];
      if (revision === this.revision) return result;
    }
    return [];
  }

  async definitionCandidates(uri, position) {
    const entry = await this.project.loadDocument(uri);
    if (!entry) return [];
    const include = entry.index
      .includes()
      .find((item) => containsPosition(item.selectionRange || item.range, position));
    const files = include ? await this.project.includeTargets(entry, include) : [];
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
    while (!this.project.stopped) {
      const revision = this.revision;
      const result = await this.referenceCandidates(uri, position, includeDeclaration);
      if (this.project.stopped) return [];
      if (revision === this.revision) return result;
    }
    return [];
  }

  async referenceCandidates(uri, position, includeDeclaration) {
    const entry = await this.project.loadDocument(uri);
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

  dispose() {
    this.invalidate();
  }
}

module.exports = { NavigationIndex };
