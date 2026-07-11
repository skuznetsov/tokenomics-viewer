"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { listZipEntries, openZipEntryStream } = require("../lib/ingest/archive");

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP64_SIGNATURE = Buffer.from([0x50, 0x4b, 0x06, 0x06]);

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries, { comment = Buffer.alloc(0), centralTrailing = Buffer.alloc(0) } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0);
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
      localParts.push(descriptor);
    }

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length + (entry.dataDescriptor ? 16 : 0);
  }

  const centralDirectory = Buffer.concat([...centralParts, centralTrailing]);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makeZip64({ data = Buffer.from("zip64"), name = "entry.jsonl" } = {}) {
  const nameBytes = Buffer.from(name);
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4);
  extra.writeBigUInt64LE(BigInt(data.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  const central = Buffer.alloc(46 + nameBytes.length + extra.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(0xffffffff, 42);
  nameBytes.copy(central, 46);
  extra.copy(central, 46 + nameBytes.length);

  const centralOffset = local.length + data.length;
  const zip64Offset = centralOffset + central.length;
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt32LE(45, 12);
  zip64.writeUInt32LE(0, 16);
  zip64.writeUInt32LE(0, 20);
  zip64.writeBigUInt64LE(1n, 24);
  zip64.writeBigUInt64LE(1n, 32);
  zip64.writeBigUInt64LE(BigInt(central.length), 40);
  zip64.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 4);
  eocd.writeUInt16LE(0xffff, 6);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([local, data, central, zip64, locator, eocd]);
}

function writeFixture(buffer, name = "fixture.zip") {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-archive-test-"));
  const filename = Path.join(directory, name);
  fs.writeFileSync(filename, buffer);
  return filename;
}

function find(buffer, signature) {
  const offset = buffer.indexOf(signature);
  assert.notEqual(offset, -1, `missing signature ${signature.toString("hex")}`);
  return offset;
}

function findLast(buffer, signature) {
  const offset = buffer.lastIndexOf(signature);
  assert.notEqual(offset, -1, `missing signature ${signature.toString("hex")}`);
  return offset;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listedEntry(buffer) {
  const filename = writeFixture(buffer);
  const entries = await listZipEntries(filename);
  assert.equal(entries.length, 1);
  return { filename, entry: entries[0] };
}

test("streams stored, deflated, and data-descriptor entries with exact metadata", async () => {
  for (const entry of [
    { name: "stored.jsonl", data: Buffer.from("stored\n"), method: 0 },
    { name: "deflated.jsonl", data: Buffer.from("deflated\n"), method: 8 },
    { name: "descriptor.jsonl", data: Buffer.from("descriptor\n"), method: 8, dataDescriptor: true },
  ]) {
    const { filename, entry: listed } = await listedEntry(makeZip([entry]));
    assert.deepEqual(await readStream(await openZipEntryStream(filename, listed)), entry.data);
  }
});

test("selects an EOCD whose comment terminates at EOF, not a signature in the comment", async () => {
  const comment = Buffer.concat([EOCD_SIGNATURE, Buffer.alloc(18)]);
  const { filename } = await listedEntry(makeZip([{ name: "entry.jsonl", data: "ok" }], { comment }));
  assert.equal((await listZipEntries(filename)).length, 1);

  await assert.rejects(
    () => listZipEntries(writeFixture(Buffer.concat([makeZip([{ name: "entry.jsonl", data: "ok" }]), Buffer.from("trailing")]))),
    /ZIP end of central directory was not found/i,
  );
});

test("rejects central-directory count and consumption mismatches", async () => {
  const countMismatch = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const countEocd = findLast(countMismatch, EOCD_SIGNATURE);
  countMismatch.writeUInt16LE(2, countEocd + 8);
  countMismatch.writeUInt16LE(2, countEocd + 10);
  await assert.rejects(() => listZipEntries(writeFixture(countMismatch)), /central directory entry count mismatch/i);

  const trailing = makeZip([{ name: "entry.jsonl", data: "ok" }], { centralTrailing: Buffer.from("junk") });
  await assert.rejects(() => listZipEntries(writeFixture(trailing)), /unexpected trailing data in ZIP central directory/i);
});

test("rejects classic and ZIP64 multi-disk archives", async () => {
  const classic = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const classicEocd = findLast(classic, EOCD_SIGNATURE);
  classic.writeUInt16LE(1, classicEocd + 4);
  await assert.rejects(() => listZipEntries(writeFixture(classic)), /multi-disk ZIP archives are not supported/i);

  const zip64 = makeZip64();
  const zip64Header = find(zip64, ZIP64_SIGNATURE);
  zip64.writeUInt32LE(1, zip64Header + 16);
  await assert.rejects(() => listZipEntries(writeFixture(zip64)), /multi-disk ZIP archives are not supported/i);
});

test("rejects truncated ZIP64 extra values with a controlled error", async () => {
  const zip64 = makeZip64();
  const central = find(zip64, CENTRAL_SIGNATURE);
  const nameLength = zip64.readUInt16LE(central + 28);
  const extra = central + 46 + nameLength;
  zip64.writeUInt16LE(8, extra + 2);
  await assert.rejects(() => listZipEntries(writeFixture(zip64)), /truncated ZIP64 extra field/i);
});

test("validates method and encryption before the empty-entry fast path", async () => {
  const unsupported = makeZip([{ name: "empty.jsonl", data: Buffer.alloc(0), method: 99 }]);
  const unsupportedFixture = await listedEntry(unsupported);
  await assert.rejects(
    () => openZipEntryStream(unsupportedFixture.filename, unsupportedFixture.entry),
    /unsupported ZIP compression method 99/i,
  );

  const encrypted = makeZip([{ name: "empty.jsonl", data: Buffer.alloc(0), method: 0, flags: 1 }]);
  const encryptedFixture = await listedEntry(encrypted);
  await assert.rejects(
    () => openZipEntryStream(encryptedFixture.filename, encryptedFixture.entry),
    /encrypted ZIP entries are not supported/i,
  );
});

test("validates local filename, method, and flags", async () => {
  const filename = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const local = find(filename, LOCAL_SIGNATURE);
  filename[local + 30] = "x".charCodeAt(0);
  const fixture = await listedEntry(filename);
  await assert.rejects(() => openZipEntryStream(fixture.filename, fixture.entry), /local filename does not match/i);

  const method = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const methodLocal = find(method, LOCAL_SIGNATURE);
  method.writeUInt16LE(8, methodLocal + 8);
  const methodFixture = await listedEntry(method);
  await assert.rejects(() => openZipEntryStream(methodFixture.filename, methodFixture.entry), /local compression method does not match/i);

  const flags = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const flagsLocal = find(flags, LOCAL_SIGNATURE);
  flags.writeUInt16LE(0x0008, flagsLocal + 6);
  const flagsFixture = await listedEntry(flags);
  await assert.rejects(() => openZipEntryStream(flagsFixture.filename, flagsFixture.entry), /local flags do not match/i);
});

test("rejects compressed payload ranges that reach the central directory", async () => {
  const zip = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const central = find(zip, CENTRAL_SIGNATURE);
  zip.writeUInt32LE(1000, central + 20);
  const fixture = await listedEntry(zip);
  await assert.rejects(() => openZipEntryStream(fixture.filename, fixture.entry), /compressed payload exceeds archive data bounds/i);
});

test("rejects trailing garbage after a valid deflate stream", async () => {
  const original = makeZip([{ name: "entry.jsonl", data: "ok", method: 8 }]);
  const oldCentral = find(original, CENTRAL_SIGNATURE);
  const oldEocd = findLast(original, EOCD_SIGNATURE);
  const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const zip = Buffer.concat([
    original.subarray(0, oldCentral),
    garbage,
    original.subarray(oldCentral),
  ]);
  const central = oldCentral + garbage.length;
  const eocd = oldEocd + garbage.length;
  zip.writeUInt32LE(original.readUInt32LE(oldCentral + 20) + garbage.length, central + 20);
  zip.writeUInt32LE(central, eocd + 16);

  const fixture = await listedEntry(zip);
  await assert.rejects(
    async () => readStream(await openZipEntryStream(fixture.filename, fixture.entry)),
    /trailing compressed data/i,
  );
});

test("streams large declared entries instead of imposing an in-memory size cap", async () => {
  const zip = makeZip([{ name: "entry.jsonl", data: "ok" }]);
  const central = find(zip, CENTRAL_SIGNATURE);
  zip.writeUInt32LE(0x10000001, central + 24);
  const fixture = await listedEntry(zip);
  assert.equal(fixture.entry.uncompressedSize, 0x10000001);
  await assert.rejects(
    async () => readStream(await openZipEntryStream(fixture.filename, fixture.entry)),
    /uncompressed size mismatch/i,
  );
});

test("validates streamed output size and CRC without buffering the entry", async () => {
  const badCrc = makeZip([{ name: "entry.jsonl", data: "ok", method: 8 }]);
  const badCrcCentral = find(badCrc, CENTRAL_SIGNATURE);
  badCrc.writeUInt32LE(0, badCrcCentral + 16);
  const badCrcFixture = await listedEntry(badCrc);
  await assert.rejects(
    async () => readStream(await openZipEntryStream(badCrcFixture.filename, badCrcFixture.entry)),
    /CRC32 mismatch/i,
  );

  const badSize = makeZip([{ name: "entry.jsonl", data: "ok", method: 0 }]);
  const badSizeCentral = find(badSize, CENTRAL_SIGNATURE);
  badSize.writeUInt32LE(3, badSizeCentral + 24);
  const badSizeFixture = await listedEntry(badSize);
  await assert.rejects(
    async () => readStream(await openZipEntryStream(badSizeFixture.filename, badSizeFixture.entry)),
    /uncompressed size mismatch/i,
  );
});
