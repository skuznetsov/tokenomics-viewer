"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Readable } = require("node:stream");
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
    return parseCentralDirectory(centralDirectory, eocd.entriesTotal);
  } finally {
    await handle.close();
  }
}

async function openZipEntryStream(zipFile, entry) {
  const handle = await fsp.open(zipFile, "r");
  let localHeader;
  try {
    localHeader = await readZipLocalHeader(handle, entry.localHeaderOffset);
  } finally {
    await handle.close();
  }

  if (entry.compressedSize === 0) {
    return Readable.from([]);
  }

  const compressed = fs.createReadStream(zipFile, {
    start: localHeader.dataOffset,
    end: localHeader.dataOffset + entry.compressedSize - 1,
  });

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return compressed.pipe(zlib.createInflateRaw());
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.fileName}`);
}

async function readZipEndOfCentralDirectory(handle, fileSize) {
  const scanSize = Math.min(fileSize, 22 + 0xffff);
  const scanStart = fileSize - scanSize;
  const buffer = await readAt(handle, scanSize, scanStart);

  let eocdOffsetInBuffer = -1;
  for (let pos = buffer.length - 22; pos >= 0; pos -= 1) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffsetInBuffer = pos;
      break;
    }
  }

  if (eocdOffsetInBuffer < 0) {
    throw new Error("ZIP end of central directory was not found");
  }

  const eocdOffset = scanStart + eocdOffsetInBuffer;
  const commentLength = buffer.readUInt16LE(eocdOffsetInBuffer + 20);
  const expectedLength = 22 + commentLength;
  if (eocdOffsetInBuffer + expectedLength > buffer.length) {
    throw new Error("Truncated ZIP end of central directory");
  }

  const diskNumber = buffer.readUInt16LE(eocdOffsetInBuffer + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 6);
  const entriesDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 8);
  const entriesTotal = buffer.readUInt16LE(eocdOffsetInBuffer + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffsetInBuffer + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffsetInBuffer + 16);

  const needsZip64 =
    entriesDisk === 0xffff ||
    entriesTotal === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff;

  if (!needsZip64) {
    return { entriesTotal, centralDirectorySize, centralDirectoryOffset };
  }

  if (eocdOffset < 20) {
    throw new Error("ZIP64 locator is missing");
  }

  const locator = await readAt(handle, 20, eocdOffset - 20);
  if (locator.readUInt32LE(0) !== 0x07064b50) {
    throw new Error("ZIP64 locator signature was not found");
  }

  const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
  const zip64Header = await readAt(handle, 56, zip64EocdOffset);
  if (zip64Header.readUInt32LE(0) !== 0x06064b50) {
    throw new Error("ZIP64 end of central directory signature was not found");
  }

  const zip64DiskNumber = zip64Header.readUInt32LE(16);
  const zip64CentralDirectoryDisk = zip64Header.readUInt32LE(20);
  if (diskNumber !== 0xffff && diskNumber !== zip64DiskNumber) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (centralDirectoryDisk !== 0xffff && centralDirectoryDisk !== zip64CentralDirectoryDisk) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }

  return {
    entriesTotal: readUInt64LEAsNumber(zip64Header, 32),
    centralDirectorySize: readUInt64LEAsNumber(zip64Header, 40),
    centralDirectoryOffset: readUInt64LEAsNumber(zip64Header, 48),
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

    const fileName = buffer.toString("utf8", variableStart, variableStart + fileNameLength);
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

    entries.push({ fileName, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset = variableEnd;
  }

  return entries;
}

function parseZip64Extra(extra, values) {
  let offset = 0;
  let {
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  } = values;

  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > extra.length) break;

    if (headerId === 0x0001) {
      let pos = dataStart;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (localHeaderOffset === 0xffffffff) {
        localHeaderOffset = readUInt64LEAsNumber(extra, pos);
      }
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
  return {
    dataOffset: localHeaderOffset + 30 + fileNameLength + extraLength,
  };
}

async function readAt(handle, length, position) {
  if (length < 0 || position < 0) {
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
