import { inflateRawSync } from "node:zlib";

export interface InclineScanResult {
  checkedFiles: string[];
  hasIncline: boolean;
  evidence: string;
}

const MAX_INFLATED_BYTES = 50 * 1024 * 1024;

/**
 * Scan an OSW ZIP (raw bytes) for incline evidence without third-party deps.
 * Parses the ZIP central directory, inflates `edges*.geojson` entries, and
 * reports whether any edge carries an incline tag.
 */
export function scanZipForIncline(zip: Uint8Array): InclineScanResult {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = readCentralDirectory(zip, view);
  const checkedFiles: string[] = [];
  let inflatedTotal = 0;
  for (const entry of entries) {
    if (!/edges.*\.geojson$/i.test(entry.name)) continue;
    if (entry.method !== 0 && entry.method !== 8) continue;
    checkedFiles.push(entry.name);
    const data = sliceEntryData(zip, view, entry);
    if (!data) continue;
    let text: string;
    try {
      const raw = entry.method === 8 ? inflateRawSync(data) : data;
      inflatedTotal += raw.byteLength;
      if (inflatedTotal > MAX_INFLATED_BYTES) {
        return {
          checkedFiles,
          hasIncline: false,
          evidence: `Stopped after ${MAX_INFLATED_BYTES} inflated bytes without an incline verdict.`,
        };
      }
      text = Buffer.from(raw).toString("utf-8");
    } catch {
      continue;
    }
    if (/"incline"\s*:/i.test(text)) {
      return {
        checkedFiles,
        hasIncline: true,
        evidence: `Found an "incline" tag in ${entry.name}.`,
      };
    }
  }
  if (checkedFiles.length === 0) {
    return {
      checkedFiles,
      hasIncline: false,
      evidence: "No edges*.geojson entries found in the ZIP.",
    };
  }
  return {
    checkedFiles,
    hasIncline: false,
    evidence: `Scanned ${checkedFiles.length} edges file(s); no "incline" tag found.`,
  };
}

interface ZipEntry {
  name: string;
  method: number;
  localHeaderOffset: number;
  compressedSize: number;
}

function readCentralDirectory(zip: Uint8Array, view: DataView): ZipEntry[] {
  // Locate End Of Central Directory (scan last 64KB + 22 for the signature).
  const eocdSig = 0x06054b50;
  const start = Math.max(0, zip.byteLength - 65557);
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (cursor + 46 > zip.byteLength) break;
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLen);
    entries.push({ name: Buffer.from(nameBytes).toString("utf-8"), method, localHeaderOffset, compressedSize });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function sliceEntryData(zip: Uint8Array, view: DataView, entry: ZipEntry): Uint8Array | undefined {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zip.byteLength) return undefined;
  if (view.getUint32(offset, true) !== 0x04034b50) return undefined;
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > zip.byteLength) return undefined;
  return zip.subarray(dataStart, dataStart + entry.compressedSize);
}
