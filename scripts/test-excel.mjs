#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateMonthlyWorkbook, filenameFor } = require('../public/excel.js');
const decoder = new TextDecoder();

const expectedEntries = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
];

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function unzipStoredArchive(archive) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034B50) {
    assert.ok(offset + 30 <= bytes.length, 'ZIP local header is truncated');
    const flags = view.getUint16(offset + 6, true);
    const compression = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    assert.equal(flags & 0x0008, 0, 'ZIP must not use an unparsed data descriptor');
    assert.equal(compression, 0, 'browser XLSX ZIP entries must use the supported stored method');
    assert.equal(compressedSize, uncompressedSize, 'stored ZIP sizes must match');
    assert.ok(dataEnd <= bytes.length, 'ZIP entry data is truncated');

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataEnd);
    assert.equal(crc32(data), checksum, `ZIP CRC mismatch for ${name}`);
    assert.ok(!entries.has(name), `duplicate ZIP entry: ${name}`);
    entries.set(name, data);
    offset = dataEnd;
  }

  assert.equal(view.getUint32(offset, true), 0x02014B50, 'ZIP central directory is missing');
  return entries;
}

const payload = {
  year: 2026,
  month: 7,
  username: '../admin/report',
  employee_name: '山田 <script>& 太郎',
  default_one_way_fare: 230,
  default_trip_type: 'round_trip',
  overtime_threshold_minutes: 10_800,
  records: [
    {
      id: 1,
      work_date: '2026-07-01',
      day_of_week: 3,
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      work_minutes: 480,
      transport_one_way_fee: 230,
      transport_trip_type: 'round_trip',
      transport_fee: 460,
      memo: '=HYPERLINK("https://example.invalid","click")',
      created_at: '2026-07-01T00:00:00Z',
    },
    {
      id: 2,
      work_date: '2026-07-20',
      day_of_week: 1,
      is_holiday: true,
      holiday_name: '海の日',
      work_type: 'holiday',
      memo: '確認',
      created_at: '2026-07-20T00:00:00Z',
    },
  ],
};

const archive = generateMonthlyWorkbook(payload);
assert.ok(archive instanceof Uint8Array, 'generator must return Uint8Array');
assert.ok(archive.length > 10_000, 'generated workbook is unexpectedly small');

const entries = unzipStoredArchive(archive);
assert.deepEqual([...entries.keys()].sort(), [...expectedEntries].sort());

const workbook = decoder.decode(entries.get('xl/workbook.xml'));
const attendance = decoder.decode(entries.get('xl/worksheets/sheet1.xml'));
const summary = decoder.decode(entries.get('xl/worksheets/sheet2.xml'));

assert.match(workbook, /sheet name="勤怠一覧"/);
assert.match(workbook, /sheet name="月次サマリー"/);
assert.match(workbook, /_xlnm\.Print_Area/);
assert.match(attendance, /氏名：山田 &lt;script&gt;&amp; 太郎/);
assert.match(attendance, /<f>H6\*IF\(I6=&quot;往復&quot;,2,1\)<\/f><v>460<\/v>/);
assert.match(attendance, /<f>MAX\(0,MOD\(E6-D6,1\)-F6\/1440\)<\/f><v>0\.3333333333333333<\/v>/);
assert.match(attendance, /海の日 \/ 確認/);
assert.match(attendance, /=HYPERLINK\(&quot;https:\/\/example\.invalid&quot;,&quot;click&quot;\)/);
assert.doesNotMatch(attendance, /<f>[^<]*HYPERLINK/i, 'user text must not become an Excel formula');
assert.match(attendance, /state="frozen"/);
assert.match(summary, /COUNTIF\(/);
assert.match(summary, /SUMIF\(/);
assert.match(summary, /会社基準超過/);

const filename = filenameFor(payload);
assert.equal(filename, '勤怠表_admin_report_202607.xlsx');
assert.doesNotMatch(filename, /[\\/:*?"<>|]/);

console.log(`Excel workbook structure verified (${archive.length} bytes, ${entries.size} entries).`);
