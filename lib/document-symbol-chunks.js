// Version 1 of the negotiated Lumine document-symbol stream. Flattening before
// batching bounds a packet even when a single program contains the whole file.
const VERSION = 1;
const MAX_ROWS = 256;
const MAX_BYTES = 48 * 1024;

const coordinates = ({ start, end }) => [start.line, start.character, end.line, end.character];

function* documentSymbolChunks(symbols) {
  const stack = [{ symbols, next: 0, parent: -1 }];
  let offset = 0;
  let rows = [];
  let bytes = 0;
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.next === frame.symbols.length) {
      stack.pop();
      continue;
    }
    const symbol = frame.symbols[frame.next++];
    const row = [
      symbol.name,
      symbol.kind,
      coordinates(symbol.range),
      coordinates(symbol.selectionRange),
      frame.parent,
    ];
    const size = Buffer.byteLength(JSON.stringify(row));
    if (rows.length && (rows.length === MAX_ROWS || bytes + size > MAX_BYTES)) {
      yield { version: VERSION, offset, symbols: rows };
      offset += rows.length;
      rows = [];
      bytes = 0;
    }
    const index = offset + rows.length;
    rows.push(row);
    bytes += size;
    if (symbol.children?.length) stack.push({ symbols: symbol.children, next: 0, parent: index });
  }
  if (rows.length) yield { version: VERSION, offset, symbols: rows };
}

module.exports = { documentSymbolChunks, VERSION, MAX_ROWS, MAX_BYTES };
