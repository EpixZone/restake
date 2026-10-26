import Long from 'long';

const MAX_UINT64 = '18446744073709551615';

// REST integers are decimal strings. Never round them through a JS number or
// signed Long before constructing the protobuf signing document.
export function uint64(value, field = 'value') {
  if (Long.isLong(value)) value = value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Unsafe uint64 ${field}`);
    }
    value = value.toString();
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) ||
      value.length > MAX_UINT64.length ||
      (value.length === MAX_UINT64.length && value > MAX_UINT64)) {
    throw new Error(`Invalid uint64 ${field}`);
  }
  return Long.fromString(value, true);
}
