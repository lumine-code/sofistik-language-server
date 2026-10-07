const path = require("node:path");
const { dirname, resolve, win32 } = path;
const { fileURLToPath, pathToFileURL } = require("node:url");

function uriPath(uri) {
  try {
    return /^file:/i.test(uri) ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

function canonicalUri(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

function fileIdentity(uri) {
  const filePath = uriPath(uri);
  if (!filePath) return uri;
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function directoryIdentity(uri) {
  const filePath = uriPath(uri);
  return filePath ? fileIdentity(canonicalUri(path.dirname(filePath))) : null;
}

function canonicalFileUri(uri) {
  try {
    return pathToFileURL(fileURLToPath(uri)).href;
  } catch {
    // Synthetic Unix URIs in tests are not native absolute paths on Windows.
    return new URL(uri).href.replaceAll("[", "%5B").replaceAll("]", "%5D");
  }
}

function includeUri(name, base) {
  if (/^file:/i.test(name)) return canonicalFileUri(name);
  if (win32.isAbsolute(name) && /^[a-z]:[\\/]/i.test(name)) {
    const uri = new URL("file:///");
    uri.pathname = "/" + name.replaceAll("\\", "/");
    return canonicalFileUri(uri);
  }
  if (/^\\\\/.test(name)) {
    const [host, ...parts] = name.slice(2).split("\\");
    const uri = new URL(`file://${host}/`);
    uri.pathname = "/" + parts.join("/");
    return canonicalFileUri(uri);
  }
  const uri = new URL(base);
  if (uri.protocol !== "file:") return null;
  try {
    return pathToFileURL(resolve(dirname(fileURLToPath(uri)), name.replaceAll("\\", "/"))).href;
  } catch {
    const path = name.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    return canonicalFileUri(new URL(path, uri));
  }
}

/** Every file include resolves relative to its owning source, including nested includes. */
class SourceResolver {
  include(name, sourceUri) {
    return includeUri(name, sourceUri);
  }

  staticInclude(entry, include) {
    let name = String(include.argument || include.name || "").trim();
    const quote = name[0];
    if ((quote === "'" || quote === '"') && name.at(-1) === quote)
      name = name.slice(1, -1).replaceAll(quote + quote, quote);
    if (!name || include.kind === "dynamic" || /\$\(|#\(/.test(name)) return null;
    return this.include(name, entry.uri);
  }
}

module.exports = {
  SourceResolver,
  includeUri,
  canonicalUri,
  uriPath,
  fileIdentity,
  directoryIdentity,
};
