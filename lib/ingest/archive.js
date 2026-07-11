"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Readable, Transform } = require("node:stream");
const zlib = require("node:zlib");

const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

async function listZipEntries(zipFile) {
  const handle = await fsp.open(zipFile, "r");
  try {
    const stat = await handle.stat();
    const eocd = await readZipEndOfCentralDirectory(handle, stat.size);
    if (eocd.centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error(`Central directory too large in ${zipFile}: ${eocd.centralDirectorySize} bytes`);
    }

    const centralDirectory = await readAt(handle, eocd.centralDirectorySize, eocd.centralDirectoryOffset);
    return parseCentralDirectory(centralDirectory, eocd.entriesTotal).map((entry) => ({
      ...entry,
      centralDirectoryOffset: eocd.centralDirectoryOffset,
    }));
  } finally {
    await handle.close();
  }
}

async function openZipEntryStream(zipFile, entry) {
  const handle = await fsp.open(zipFile, "r");
  let stat;
  let localHeader;
  try {
    stat = await handle.stat();
    localHeader = await readZipLocalHeader(handle, entry.localHeaderOffset);
  } finally {
    await handle.close();
  }

  if (entry.flags & 0x0001) {
    throw new Error(`Encrypted ZIP entries are not supported: ${entry.fileName}`);
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.fileName}`);
  }
  if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)) {
    throw new Error(`Invalid ZIP entry sizes for ${entry.fileName}`);
  }

  const expectedName = entry.fileNameBytes || Buffer.from(entry.fileName, "utf8");
  if (!localHeader.fileNameBytes.equals(expectedName)) {
    throw new Error(`ZIP local filename does not match central directory for ${entry.fileName}`);
  }
  if (localHeader.method !== entry.method) {
    throw new Error(`ZIP local compression method does not match central directory for ${entry.fileName}`);
  }
  if (localHeader.flags !== entry.flags) {
    throw new Error(`ZIP local flags do not match central directory for ${entry.fileName}`);
  }

  const archiveDataEnd = Number.isSafeInteger(entry.centralDirectoryOffset)
    ? entry.centralDirectoryOffset
    : stat.size;
  if (archiveDataEnd < 0 || archiveDataEnd > stat.size) {
    throw new Error(`Invalid ZIP central directory offset for ${entry.fileName}`);
  }
  if (localHeader.dataOffset > archiveDataEnd || entry.compressedSize > archiveDataEnd - localHeader.dataOffset) {
    throw new Error(`ZIP compressed payload exceeds archive data bounds for ${entry.fileName}`);
  }

  if (entry.compressedSize === 0) return Readable.from([]).pipe(createZipValidationStream(entry));

  const compressed = fs.createReadStream(zipFile, {
    start: localHeader.dataOffset,
    end: localHeader.dataOffset + entry.compressedSize - 1,
  });
  let payload = compressed;
  let compressedBytesConsumed = null;
  if (entry.method === 8) {
    const inflater = zlib.createInflateRaw();
    compressedBytesConsumed = () => inflater.bytesWritten;
    payload = compressed.pipe(inflater);
  }
  return payload.pipe(createZipValidationStream(entry, compressedBytesConsumed));
}

async function readZipEndOfCentralDirectory(handle, fileSize) {
  const scanSize = Math.min(fileSize, 22 + 0xffff);
  const scanStart = fileSize - scanSize;
  const buffer = await readAt(handle, scanSize, scanStart);
  let sawTruncatedCandidate = false;
  let lastCandidateError = null;

  for (let pos = buffer.length - 22; pos >= 0; pos -= 1) {
    if (buffer.readUInt32LE(pos) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(pos + 20);
    const candidateLength = 22 + commentLength;
    if (pos + candidateLength > buffer.length) {
      sawTruncatedCandidate = true;
      continue;
    }
    if (pos + candidateLength !== buffer.length) continue;

    try {
      const candidate = await parseZipEndOfCentralDirectoryCandidate(handle, buffer, scanStart, pos);
      const expectedCentralEnd = candidate.centralDirectoryOffset + candidate.centralDirectorySize;
      if (!Number.isSafeInteger(expectedCentralEnd)) continue;
      if (expectedCentralEnd !== candidate.centralDirectoryEnd) continue;
      return candidate;
    } catch (error) {
      lastCandidateError = error;
    }
  }

  if (lastCandidateError) throw lastCandidateError;
  if (sawTruncatedCandidate) throw new Error("Truncated ZIP end of central directory");
  throw new Error("ZIP end of central directory was not found");
}

async function parseZipEndOfCentralDirectoryCandidate(handle, buffer, scanStart, offset) {
  const eocdOffset = scanStart + offset;
  const diskNumber = buffer.readUInt16LE(offset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(offset + 6);
  const entriesDisk = buffer.readUInt16LE(offset + 8);
  const entriesTotal = buffer.readUInt16LE(offset + 10);
  const centralDirectorySize = buffer.readUInt32LE(offset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(offset + 16);
  const needsZip64 =
    entriesDisk === 0xffff ||
    entriesTotal === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff;

  if (!needsZip64) {
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesDisk !== entriesTotal) {
      throw new Error("Multi-disk ZIP archives are not supported");
    }
    return {
      entriesTotal,
      centralDirectorySize,
      centralDirectoryOffset,
      centralDirectoryEnd: eocdOffset,
    };
  }

  if (eocdOffset < 20) throw new Error("ZIP64 locator is missing");
  const locator = await readAt(handle, 20, eocdOffset - 20);
  if (locator.readUInt32LE(0) !== 0x07064b50) {
    throw new Error("ZIP64 locator signature was not found");
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }

  const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
  const zip64Header = await readAt(handle, 56, zip64EocdOffset);
  if (zip64Header.readUInt32LE(0) !== 0x06064b50) {
    throw new Error("ZIP64 end of central directory signature was not found");
  }

  const zip64DiskNumber = zip64Header.readUInt32LE(16);
  const zip64CentralDirectoryDisk = zip64Header.readUInt32LE(20);
  const zip64EntriesDisk = readUInt64LEAsNumber(zip64Header, 24);
  const zip64EntriesTotal = readUInt64LEAsNumber(zip64Header, 32);
  if (
    zip64DiskNumber !== 0 ||
    zip64CentralDirectoryDisk !== 0 ||
    zip64EntriesDisk !== zip64EntriesTotal ||
    (diskNumber !== 0xffff && diskNumber !== 0) ||
    (centralDirectoryDisk !== 0xffff && centralDirectoryDisk !== 0) ||
    (entriesDisk !== 0xffff && entriesDisk !== zip64EntriesTotal)
  ) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }

  return {
    entriesTotal: zip64EntriesTotal,
    centralDirectorySize: readUInt64LEAsNumber(zip64Header, 40),
    centralDirectoryOffset: readUInt64LEAsNumber(zip64Header, 48),
    centralDirectoryEnd: zip64EocdOffset,
  };
}

function parseCentralDirectory(buffer, expectedEntries) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length && entries.length < expectedEntries) {
    if (offset + 46 > buffer.length) {
      throw new Error("Truncated ZIP central directory entry");
    }
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Unexpected ZIP central directory signature");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const variableStart = offset + 46;
    const variableEnd = variableStart + fileNameLength + extraLength + commentLength;

    if (variableEnd > buffer.length) {
      throw new Error("Truncated ZIP central directory variable data");
    }

    const fileNameBytes = Buffer.from(buffer.subarray(variableStart, variableStart + fileNameLength));
    const fileName = fileNameBytes.toString("utf8");
    const extra = buffer.subarray(variableStart + fileNameLength, variableStart + fileNameLength + extraLength);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const zip64 = parseZip64Extra(extra, {
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      compressedSize = zip64.compressedSize;
      uncompressedSize = zip64.uncompressedSize;
      localHeaderOffset = zip64.localHeaderOffset;
    }
    entries.push({ fileName, fileNameBytes, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset = variableEnd;
  }

  if (entries.length !== expectedEntries) {
    throw new Error(`ZIP central directory entry count mismatch: expected ${expectedEntries}, got ${entries.length}`);
  }
  if (offset !== buffer.length) {
    throw new Error("Unexpected trailing data in ZIP central directory");
  }
  return entries;
}

function parseZip64Extra(extra, values) {
  let offset = 0;
  let { compressedSize, uncompressedSize, localHeaderOffset } = values;

  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > extra.length) break;

    if (headerId === 0x0001) {
      let pos = dataStart;
      const readRequiredValue = () => {
        if (pos + 8 > dataEnd) throw new Error("Truncated ZIP64 extra field");
        const value = readUInt64LEAsNumber(extra, pos);
        pos += 8;
        return value;
      };
      if (uncompressedSize === 0xffffffff) uncompressedSize = readRequiredValue();
      if (compressedSize === 0xffffffff) compressedSize = readRequiredValue();
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = readRequiredValue();
      return { compressedSize, uncompressedSize, localHeaderOffset };
    }

    offset = dataEnd;
  }

  throw new Error("ZIP64 extra field is missing required size or offset data");
}

async function readZipLocalHeader(handle, localHeaderOffset) {
  const fixed = await readAt(handle, 30, localHeaderOffset);
  if (fixed.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Unexpected ZIP local file header signature");
  }

  const fileNameLength = fixed.readUInt16LE(26);
  const extraLength = fixed.readUInt16LE(28);
  const variable = await readAt(handle, fileNameLength + extraLength, localHeaderOffset + 30);
  return {
    flags: fixed.readUInt16LE(6),
    method: fixed.readUInt16LE(8),
    fileNameBytes: variable.subarray(0, fileNameLength),
    dataOffset: localHeaderOffset + 30 + fileNameLength + extraLength,
  };
}

function createZipValidationStream(entry, compressedBytesConsumed) {
  let bytes = 0;
  let checksum = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.uncompressedSize) {
        callback(new Error(`ZIP entry expanded beyond its declared size for ${entry.fileName}`));
        return;
      }
      checksum = zlib.crc32(chunk, checksum);
      callback(null, chunk);
    },
    flush(callback) {
      const consumed = compressedBytesConsumed?.();
      if (consumed != null && consumed !== entry.compressedSize) {
        callback(new Error(`ZIP deflate stream has trailing compressed data for ${entry.fileName}`));
        return;
      }
      if (bytes !== entry.uncompressedSize) {
        callback(new Error(`ZIP uncompressed size mismatch for ${entry.fileName}: expected ${entry.uncompressedSize}, got ${bytes}`));
        return;
      }
      if (checksum !== entry.crc32) {
        callback(new Error(`ZIP CRC32 mismatch for ${entry.fileName}: expected ${entry.crc32}, got ${checksum}`));
        return;
      }
      callback();
    },
  });
}

async function readAt(handle, length, position) {
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(position) || length < 0 || position < 0) {
    throw new Error(`Invalid read: length=${length}, position=${position}`);
  }
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`Short read: expected ${length}, got ${bytesRead}`);
  }
  return buffer;
}

function readUInt64LEAsNumber(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP value exceeds JavaScript safe integer: ${value.toString()}`);
  }
  return Number(value);
}

module.exports = {
  listZipEntries,
  openZipEntryStream,
};
