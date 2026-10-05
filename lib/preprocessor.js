const { basename, dirname, extname, resolve, win32 } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const DIRECTIVE = /^\s*#([a-z]+)\b(.*)$/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const ZERO = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eEdD][+-]?\d+)?$/;
const MACRO_NAME = /^[a-z][^$\s]{0,39}$/i;

function sourceLocation(uri, line, text) {
  return {
    uri,
    range: { start: { line, character: 0 }, end: { line, character: text.length } },
  };
}

function abortIfCancelled(isCancelled) {
  if (isCancelled?.()) {
    const error = new Error("Preprocessor request cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function compile(source, cache, isCancelled, maxSourceLines = 250_000) {
  const cached = cache?.get(source.uri);
  if (cached?.text === source.text && cached.maxSourceLines === maxSourceLines) return cached.lines;
  const lines = [];
  let start = 0;
  let line = 0;
  while (start < source.text.length) {
    if ((line & 255) === 0) abortIfCancelled(isCancelled);
    if (line >= maxSourceLines) {
      lines.truncated = sourceLocation(source.uri, line, "");
      break;
    }
    const end = source.text.indexOf("\n", start);
    const last = end < 0 ? source.text.length : end;
    const text = source.text.slice(start, last).replace(/\r$/, "");
    const directive = DIRECTIVE.exec(text);
    lines.push({
      text,
      newline: end < 0 ? "" : "\n",
      location: sourceLocation(source.uri, line++, text),
      directive: directive?.[1].toUpperCase(),
      argument: directive?.[2] ?? "",
    });
    start = last + 1;
  }
  if (cache && source.text.length <= 8 * 1024 * 1024 && lines.length <= 250_000) {
    cache.delete(source.uri);
    let retained = source.text.length;
    let retainedLines = lines.length;
    for (const value of cache.values()) {
      retained += value.text?.length ?? 0;
      retainedLines += value.lines?.length ?? 0;
    }
    while (cache.size >= 128 || retained > 8 * 1024 * 1024 || retainedLines > 250_000) {
      const key = cache.keys().next().value;
      if (key === undefined) break;
      retained -= cache.get(key).text?.length ?? 0;
      retainedLines -= cache.get(key).lines?.length ?? 0;
      cache.delete(key);
    }
    cache.set(source.uri, { text: source.text, lines, maxSourceLines });
  }
  return lines;
}

// CADINP comments do not affect directive arguments. $(...) is a substitution,
// whereas an unquoted dollar sign or exclamation mark starts a comment.
function commentStart(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      if (character === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (character === "'" || character === '"') quote = character;
    else if (
      (character === "!" && text[i + 1] !== "=") ||
      (character === "$" && text[i + 1] !== "(")
    )
      return i;
  }
  return text.length;
}

function unquote(text) {
  if ((text[0] === "'" || text[0] === '"') && text.at(-1) === text[0])
    return text.slice(1, -1).replaceAll(text[0] + text[0], text[0]);
  return text;
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

function primaryName(uri) {
  try {
    const name = basename(decodeURIComponent(new URL(uri).pathname));
    return name.slice(0, name.length - extname(name).length);
  } catch {
    return "";
  }
}

function compareStrings(left, right) {
  left = unquote(left.trim());
  right = unquote(right.trim());
  const width = Math.max(left.length, right.length);
  const numeric = NUMBER.test(left) && NUMBER.test(right);
  left = numeric ? left.padStart(width, " ") : left.padEnd(width, " ");
  right = numeric ? right.padStart(width, " ") : right.padEnd(width, " ");
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Expand SPS directives into one in-memory buffer. readSource receives an absolute
 * file URI and may return a newer open-buffer version instead of reading disk.
 * A shared cache retains compiled source lines only, never macro/environment state.
 * Segments retain original lines and the outermost block/file invocation. Zero-width
 * uncertainty markers identify omitted input without manufacturing CADINP records.
 * maxSourceLines defaults to 250,000 lines per source, including generated directives.
 */
async function preprocess(entry, options = {}) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxDepth = options.maxDepth ?? 32;
  const maxOperations = options.maxOperations ?? 1_000_000;
  const maxSourceLines =
    Number.isSafeInteger(options.maxSourceLines) && options.maxSourceLines >= 0
      ? options.maxSourceLines
      : 250_000;
  const macros = new Map();
  const parts = [];
  const segments = [];
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const dependencies = new Set([entry.uri]);
  const uncertainties = [];
  const conditions = [];
  const sources = new Map([[entry.uri, entry]]);
  let offset = 0;
  let bytes = 0;
  let operations = 0;
  let stopped = false;
  let complete = true;

  const supplied =
    options.defines instanceof Map ? options.defines : Object.entries(options.defines ?? {});
  const name = primaryName(entry.uri);
  for (const [key, value] of [["NAME", name], ["PROJECT", name], ...supplied])
    macros.set(key.toUpperCase(), { value: String(value) });

  function report(location, invocation, code, message, severity = 1) {
    const anchor = invocation ?? location;
    const key = `${anchor.uri}:${anchor.range.start.line}:${code}:${message}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    const diagnostic = {
      ...anchor,
      severity,
      source: "sofistik-preprocessor",
      code,
      message,
      data: { recordOrigin: location },
    };
    if (anchor !== location)
      diagnostic.relatedInformation = [{ location, message: "Original preprocessor source." }];
    diagnostics.push(diagnostic);
  }

  function uncertain(kind, start = offset, end = start) {
    complete = false;
    uncertainties.push({ start, end, kind });
  }

  function limit(location, invocation, message) {
    if (!stopped) {
      report(location, invocation, "expansion-limit", message);
      uncertain("limit");
    }
    stopped = true;
  }

  function tick(location, invocation) {
    abortIfCancelled(options.isCancelled);
    if (++operations > maxOperations)
      limit(
        location,
        invocation,
        "Preprocessor work limit exceeded; remaining input was not analysed.",
      );
    return !stopped;
  }

  function expand(text, location, invocation, stack = [], depth = 0) {
    if (!text.includes("$(")) return { text, valid: true };
    if (depth >= maxDepth) {
      report(
        location,
        invocation,
        "macro-depth",
        "Preprocessor substitution nesting limit exceeded.",
      );
      return { text, valid: false };
    }
    let result = "";
    let resultBytes = 0;
    const append = (value) => {
      if (stopped) return;
      resultBytes += Buffer.byteLength(value);
      if (resultBytes > maxBytes) {
        limit(
          location,
          invocation,
          "Expanded preprocessor text exceeds the configured size limit.",
        );
        result = "";
      } else result += value;
    };
    let cursor = 0;
    let valid = true;
    while (cursor < text.length && !stopped) {
      const start = text.indexOf("$(", cursor);
      if (start < 0) {
        append(text.slice(cursor));
        break;
      }
      if (!tick(location, invocation)) break;
      append(text.slice(cursor, start));
      if (stopped) break;
      let end = start + 2;
      let nesting = 1;
      for (; end < text.length && nesting; end++) {
        if (text[end] === "(") nesting++;
        else if (text[end] === ")") nesting--;
      }
      if (nesting) {
        report(
          location,
          invocation,
          "unclosed-substitution",
          "Preprocessor substitution has no closing parenthesis.",
        );
        append(text.slice(start));
        valid = false;
        break;
      }
      const expression = text.slice(start, end);
      const expandedName = expand(
        text.slice(start + 2, end - 1),
        location,
        invocation,
        stack,
        depth + 1,
      );
      const key = expandedName.text.trim().toUpperCase();
      const macro = expandedName.valid ? macros.get(key) : null;
      if (!expandedName.valid) {
        append(expression);
        valid = false;
      } else if (!macro) {
        report(
          location,
          invocation,
          "undefined-macro",
          `Preprocessor parameter ${expandedName.text} is not defined.`,
        );
        append(expression);
        valid = false;
      } else if (stack.includes(key)) {
        report(
          location,
          invocation,
          "recursive-macro",
          `Recursive preprocessor substitution: ${[...stack, key].join(" -> ")}.`,
        );
        append(expression);
        valid = false;
      } else if (macro.lines) {
        report(
          location,
          invocation,
          "block-substitution",
          `Preprocessor block ${key} must be inserted with #INCLUDE.`,
        );
        append(expression);
        valid = false;
      } else {
        const replacement = expand(macro.value, location, invocation, [...stack, key], depth + 1);
        append(replacement.text);
        valid &&= replacement.valid;
      }
      cursor = end;
    }
    return { text: result, valid: valid && !stopped };
  }

  function condition(argument, location, invocation) {
    const input = argument.slice(0, commentStart(argument)).trim();
    const expansion = expand(input, location, invocation);
    if (!expansion.valid) return null;
    const expression = expansion.text.trim();
    // Find the operator outside quotes; quoted values may themselves contain '='.
    let quote = null;
    let match = null;
    for (let i = 0; i < expression.length; i++) {
      if (quote) {
        if (expression[i] === quote) quote = null;
      } else if (expression[i] === "'" || expression[i] === '"') quote = expression[i];
      else if (/[<>=!]/.test(expression[i])) {
        const operator = /^(?:==|!=|<=|>=|<\s*>|=|<|>)/.exec(expression.slice(i));
        if (operator) {
          match = { index: i, operator: operator[0], end: i + operator[0].length };
          break;
        }
      }
    }
    if (match) {
      const order = compareStrings(expression.slice(0, match.index), expression.slice(match.end));
      switch (match.operator.replaceAll(" ", "")) {
        case "=":
        case "==":
          return order === 0;
        case "!=":
        case "<>":
          return order !== 0;
        case "<":
          return order < 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        case ">=":
          return order >= 0;
      }
    }
    let value;
    if (input.includes("$(") || NUMBER.test(expression) || /^["']/.test(expression))
      value = unquote(expression);
    else {
      if (!MACRO_NAME.test(expression)) {
        report(
          location,
          invocation,
          "unsupported-condition",
          "Preprocessor condition must be a parameter name or a string comparison.",
          2,
        );
        return null;
      }
      const macro = macros.get(expression.toUpperCase());
      if (!macro) return false;
      if (macro.lines) return macro.lines.some((line) => line.text.trim());
      const result = expand(macro.value, location, invocation);
      if (!result.valid) return null;
      value = result.text.trim();
    }
    return value !== "" && !ZERO.test(value);
  }

  function emit(text, location, invocation, valid = true) {
    if (stopped) return;
    const size = Buffer.byteLength(text);
    if (bytes + size > maxBytes) {
      limit(location, invocation, "Expanded preprocessor text exceeds the configured size limit.");
      return;
    }
    if (!text) return;
    const start = offset;
    parts.push(text);
    offset += text.length;
    bytes += size;
    segments.push({ start, end: offset, origin: location, ...(invocation ? { invocation } : {}) });
    if (!valid) uncertain("macro", start, offset);
    if (/^\s*\+?APPLY\b/i.test(text)) uncertain("apply", start, offset);
  }

  async function process(lines, invocation = null, depth = 0) {
    const active = () => !conditions.length || conditions.at(-1).active;
    for (let index = 0; index < lines.length && !stopped; index++) {
      const line = lines[index];
      const { text, location, directive } = line;
      if (!tick(location, invocation)) break;
      const argument = line.argument.slice(0, commentStart(line.argument)).trim();
      if (directive === "IF") {
        const parent = active();
        const value = parent ? condition(argument, location, invocation) : false;
        if (conditions.length >= maxDepth) {
          limit(location, invocation, "Preprocessor conditional nesting limit exceeded.");
          break;
        }
        if (value === null) uncertain("conditional");
        conditions.push({
          parent,
          active: parent && value === true,
          matched: value === true,
          unknown: value === null,
          location,
          invocation,
          elseSeen: false,
        });
        continue;
      }
      if (["ELSE", "ELSEIF", "ELIF", "ENDIF"].includes(directive)) {
        const frame = conditions.at(-1);
        if (!frame || (frame.elseSeen && directive !== "ENDIF")) {
          report(
            location,
            invocation,
            "unmatched-conditional",
            `#${directive} has no matching open #IF branch.`,
          );
          uncertain("conditional");
        } else if (directive === "ENDIF") conditions.pop();
        else if (directive === "ELSE") {
          frame.active = frame.parent && !frame.matched && !frame.unknown;
          frame.matched ||= frame.active;
          frame.elseSeen = true;
        } else {
          const value =
            frame.parent && !frame.matched && !frame.unknown
              ? condition(argument, location, invocation)
              : false;
          if (value === null) uncertain("conditional");
          frame.unknown ||= value === null;
          frame.active = frame.parent && !frame.matched && value === true;
          frame.matched ||= frame.active;
        }
        continue;
      }
      if (directive === "DEFINE") {
        const equals = argument.indexOf("=");
        if (equals < 0) {
          let end = index + 1;
          let nesting = 1;
          for (; end < lines.length; end++) {
            if ((end & 255) === 0) abortIfCancelled(options.isCancelled);
            if (
              lines[end].directive === "DEFINE" &&
              !lines[end].argument.slice(0, commentStart(lines[end].argument)).includes("=")
            )
              nesting++;
            if (lines[end].directive === "ENDDEF" && --nesting === 0) break;
          }
          if (end >= lines.length) {
            if (lines.truncated) {
              limit(
                lines.truncated,
                invocation,
                `Preprocessor source exceeds the configured limit of ${maxSourceLines} lines.`,
              );
              break;
            }
            report(
              location,
              invocation,
              "unclosed-definition",
              "Preprocessor block has no matching #ENDDEF.",
            );
            uncertain("unsupported");
            break;
          }
          if (active()) {
            const name = expand(argument, location, invocation);
            if (name.valid && MACRO_NAME.test(name.text))
              macros.set(name.text.toUpperCase(), { lines: lines.slice(index + 1, end) });
            else {
              if (name.valid)
                report(
                  location,
                  invocation,
                  "invalid-macro-name",
                  "Preprocessor names must start with a letter and contain at most 40 characters without spaces or '$'.",
                );
              uncertain("unsupported");
            }
          }
          index = end;
        } else if (active()) {
          const name = expand(argument.slice(0, equals).trim(), location, invocation);
          if (name.valid && MACRO_NAME.test(name.text))
            macros.set(name.text.toUpperCase(), { value: argument.slice(equals + 1).trim() });
          else {
            if (name.valid)
              report(
                location,
                invocation,
                "invalid-macro-name",
                "Preprocessor names must start with a letter and contain at most 40 characters without spaces or '$'.",
              );
            uncertain("unsupported");
          }
        }
        continue;
      }
      if (!active()) continue;
      if (directive === "UNDEF") {
        const name = expand(argument, location, invocation);
        if (name.valid) macros.delete(name.text.toUpperCase());
        else uncertain("macro");
      } else if (directive === "INCLUDE") {
        const result = expand(argument, location, invocation);
        if (!result.valid) {
          uncertain("include");
          continue;
        }
        const name = unquote(result.text.trim());
        const macro = macros.get(name.toUpperCase());
        const nextInvocation = invocation ?? location;
        if (depth >= maxDepth) {
          report(
            location,
            invocation,
            "include-depth",
            "Preprocessor block/file inclusion nesting limit exceeded.",
          );
          uncertain("include");
          continue;
        }
        if (macro?.lines) await process(macro.lines, nextInvocation, depth + 1);
        else if (macro) {
          const value = expand(macro.value, location, nextInvocation);
          if (value.valid && /^\s*#[a-z]+\b/im.test(value.text)) {
            const generated = compile(
              { uri: location.uri, text: value.text + line.newline },
              undefined,
              options.isCancelled,
              maxSourceLines,
            );
            const mapped = generated.map((item) => ({ ...item, location }));
            if (generated.truncated) mapped.truncated = location;
            await process(mapped, nextInvocation, depth + 1);
          } else emit(value.text + line.newline, location, nextInvocation, value.valid);
        } else {
          let uri;
          let source;
          try {
            uri = includeUri(name, location.uri);
            if (uri) {
              dependencies.add(uri);
              source = sources.get(uri);
              if (!source) {
                source = await options.readSource?.(uri);
                if (source) sources.set(uri, source);
              }
            }
          } catch {
            // The caller may report unavailable buffers through null or a read error.
          }
          if (!source) {
            report(
              location,
              invocation,
              "missing-include",
              `Cannot resolve preprocessor include ${name || "(empty name)"}.`,
            );
            uncertain("include");
          } else {
            const included = compile(source, options.cache, options.isCancelled, maxSourceLines);
            const last = included.at(-1);
            const separated =
              last && !last.newline
                ? [...included.slice(0, -1), { ...last, newline: "\n" }]
                : included;
            if (included.truncated) separated.truncated = included.truncated;
            await process(separated, nextInvocation, depth + 1);
          }
        }
      } else if (directive) {
        report(
          location,
          invocation,
          "unsupported-directive",
          `#${directive} cannot be expanded by the language server.`,
          2,
        );
        uncertain("unsupported");
      } else {
        const end = commentStart(text);
        const result = expand(text.slice(0, end), location, invocation);
        if (
          result.valid &&
          result.text !== text.slice(0, end) &&
          /^\s*#[a-z]+\b/im.test(result.text)
        ) {
          if (depth >= maxDepth) {
            report(
              location,
              invocation,
              "macro-depth",
              "Preprocessor substitution nesting limit exceeded.",
            );
            uncertain("macro");
          } else {
            const generated = compile(
              { uri: location.uri, text: result.text + text.slice(end) + line.newline },
              undefined,
              options.isCancelled,
              maxSourceLines,
            );
            const mapped = generated.map((item) => ({ ...item, location }));
            if (generated.truncated) mapped.truncated = location;
            await process(mapped, invocation ?? location, depth + 1);
          }
        } else
          emit(result.text + text.slice(end) + line.newline, location, invocation, result.valid);
      }
    }
    if (lines.truncated)
      limit(
        lines.truncated,
        invocation,
        `Preprocessor source exceeds the configured limit of ${maxSourceLines} lines.`,
      );
  }

  await process(compile(entry, options.cache, options.isCancelled, maxSourceLines));
  for (const frame of conditions) {
    if (stopped) break;
    report(
      frame.location,
      frame.invocation,
      "unclosed-conditional",
      "Preprocessor #IF has no matching #ENDIF.",
    );
    uncertain("conditional");
  }
  return {
    text: parts.join(""),
    segments,
    diagnostics,
    dependencies: [...dependencies],
    uncertainties,
    complete,
  };
}

module.exports = { preprocess };
