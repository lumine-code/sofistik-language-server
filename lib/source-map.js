const comparePosition = (left, right) => left.line - right.line || left.character - right.character;

function locationKey(location) {
  const { start, end } = location.range;
  return `${location.uri}:${start.line}:${start.character}:${end.line}:${end.character}`;
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = locationKey(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clippedOrigin(piece, start, end) {
  const origin = piece.origin;
  const { start: from, end: to } = origin.range;
  const contentEnd = piece.contentEnd ?? piece.end;
  const length = Math.max(0, contentEnd - piece.start);
  const affine =
    piece.affine !== false && from.line === to.line && to.character - from.character === length;
  if (!affine) return origin;
  const localStart = Math.min(length, Math.max(0, start - piece.start));
  const localEnd = Math.min(length, Math.max(localStart, end - piece.start));
  return {
    uri: origin.uri,
    range: {
      start: { line: from.line, character: from.character + localStart },
      end: { line: from.line, character: from.character + localEnd },
    },
  };
}

/** Map a UTF-16 expanded span to use-site source ranges, without a character map. */
function mappedLocation(segments, start, end, fallback) {
  const otherwise = () => (typeof fallback === "function" ? fallback(start, end) : fallback);
  if (!segments?.length) return otherwise();
  const point = end <= start;
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  if (point && low === segments.length && segments.at(-1).end === start) low--;
  const locations = [];
  const definitions = [];
  let invocation;
  let blockInvocation;
  for (let index = low; index < segments.length; index++) {
    const segment = segments[index];
    if (point ? segment.start > start : segment.start >= end) break;
    if (!segment.origin || segment.end < start) continue;
    invocation ??= segment.invocation;
    blockInvocation ??= segment.blockInvocation;
    if (segment.definitions) definitions.push(...segment.definitions);
    const pieces = segment.pieces || [segment];
    let pieceStart = 0;
    let pieceEnd = pieces.length;
    while (pieceStart < pieceEnd) {
      const middle = (pieceStart + pieceEnd) >>> 1;
      const piece = pieces[middle];
      const before =
        piece.end < start || (!point && piece.end === start && piece.start !== piece.end);
      if (before) pieceStart = middle + 1;
      else pieceEnd = middle;
    }
    for (let pieceIndex = pieceStart; pieceIndex < pieces.length; pieceIndex++) {
      const piece = pieces[pieceIndex];
      if (piece.start > end) break;
      const empty = piece.start === piece.end;
      const overlaps = point
        ? piece.start <= start && piece.end >= start
        : empty
          ? piece.start >= start && piece.start <= end
          : piece.start < end && piece.end > start;
      if (!overlaps || !piece.origin) continue;
      locations.push(clippedOrigin(piece, Math.max(start, piece.start), Math.min(end, piece.end)));
      if (piece.definitions) definitions.push(...piece.definitions);
    }
    // Normalized/synthetic line breaks have no content characters to project.
    if (!locations.length && point && start >= (segment.contentEnd ?? segment.end))
      locations.push(clippedOrigin(segment, start, start));
    if (point) break;
  }
  if (!locations.length) return otherwise();
  const originals = uniqueLocations(locations);
  const primary = originals[0];
  let first = primary.range.start;
  let last = primary.range.end;
  for (const location of originals) {
    if (location.uri !== primary.uri) continue;
    if (comparePosition(location.range.start, first) < 0) first = location.range.start;
    if (comparePosition(location.range.end, last) > 0) last = location.range.end;
  }
  const relatedDefinitions = uniqueLocations(definitions);
  const separateOrigins = originals.some(
    (location) =>
      location.uri !== primary.uri ||
      location.range.start.line !== primary.range.start.line ||
      location.range.end.line !== primary.range.start.line,
  );
  return {
    uri: primary.uri,
    range: { start: first, end: last },
    ...(invocation ? { invocation } : {}),
    ...(blockInvocation ? { blockInvocation } : {}),
    ...(relatedDefinitions.length ? { definitions: relatedDefinitions } : {}),
    ...(separateOrigins ? { origins: originals } : {}),
  };
}

module.exports = { mappedLocation };
