const EMPTY_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function containsPosition(range, position) {
  if (!range) return false;
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return compare(range.start, position) <= 0 && compare(position, range.end) <= 0;
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((location) => {
    const key = JSON.stringify(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { containsPosition, uniqueLocations, EMPTY_RANGE };
