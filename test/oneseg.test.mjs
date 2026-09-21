import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OneSegFilter,
  SectionAssembler,
  AccessUnitSplitter,
  AdtsRepacketizer,
  crc32Mpeg2,
  isPartialReceptionPmtPid,
} from "../dist/oneseg.js";

/** Routing tests use placeholder ES packets, so ES re-packetizing is off. */
const RAW = { splitAccessUnits: false, repacketizeAdts: false };
const counters = new Map();
function packet(
  pid,
  payload,
  { start = true, scrambled = false, adaptation } = {},
) {
  const p = new Uint8Array(188).fill(0xff);
  const cc = counters.get(pid) ?? 0;
  counters.set(pid, (cc + 1) & 0x0f);
  p[0] = 0x47;
  p[1] = (start ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  p[3] = (scrambled ? 0x80 : 0) | (adaptation ? 0x30 : 0x10) | cc;
  let offset = 4;
  if (adaptation) {
    p[4] = adaptation.length;
    p.set(adaptation, 5);
    offset = 5 + adaptation.length;
  }
  p.set(payload, offset);
  return p;
}
function section(tableId, idExtension, version, body) {
  const length = 5 + body.length + 4;
  const s = new Uint8Array(3 + length);
  s.set([
    tableId,
    0xb0 | (length >> 8),
    length & 0xff,
    idExtension >> 8,
    idExtension & 0xff,
    0xc1 | (version << 1),
    0,
    0,
  ]);
  s.set(body, 8);
  const crc = crc32Mpeg2(s.subarray(0, s.length - 4));
  s.set(
    [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
    s.length - 4,
  );
  return s;
}
const pat = (programs, version = 0, tsid = 0x7fe0) =>
  section(
    0,
    tsid,
    version,
    programs.flatMap(([n, pid]) => [
      n >> 8,
      n & 0xff,
      0xe0 | (pid >> 8),
      pid & 0xff,
    ]),
  );
const pmt = (program, pcr, streams, version = 0) =>
  section(2, program, version, [
    0xe0 | (pcr >> 8),
    pcr & 0xff,
    0xf0,
    0,
    ...streams.flatMap(([type, pid, info = []]) => [
      type,
      0xe0 | (pid >> 8),
      pid & 0xff,
      0xf0 | (info.length >> 8),
      info.length & 0xff,
      ...info,
    ]),
  ]);
const psi = (pid, s) => packet(pid, Uint8Array.of(0, ...s));
const pes = (pid, byte, options) =>
  packet(pid, new Uint8Array(184).fill(byte), options);
const concat = (packets) => {
  const out = new Uint8Array(packets.length * 188);
  packets.forEach((p, i) => out.set(p, i * 188));
  return out;
};
const pidsOf = (data) => {
  const pids = [];
  for (let i = 0; i < data.length; i += 188)
    pids.push(((data[i + 1] & 0x1f) << 8) | data[i + 2]);
  return pids;
};
const HD = [
  [0x02, 0x100],
  [0x0f, 0x110],
  [0x06, 0x130],
];
const ONESEG = [
  [0x1b, 0x181],
  [0x0f, 0x184],
  [0x0d, 0x190],
  [0x06, 0x188],
];

test("MPEG-2 CRC-32 matches the standard check value and self-verifies", () => {
  assert.equal(crc32Mpeg2(new TextEncoder().encode("123456789")), 0x0376e6e7);
  const s = pat([[1, 0x100]]);
  assert.equal(crc32Mpeg2(s), 0);
  s[10] ^= 1;
  assert.notEqual(crc32Mpeg2(s), 0);
  assert.ok(
    isPartialReceptionPmtPid(0x1fc8) && isPartialReceptionPmtPid(0x1fcf),
  );
  assert.ok(
    !isPartialReceptionPmtPid(0x1fc7) && !isPartialReceptionPmtPid(0x1fd0),
  );
});

test("sections spanning packets, back-to-back sections and bad CRC", () => {
  const big = section(2, 1, 0, new Uint8Array(300).fill(0xab));
  const a = new SectionAssembler();
  assert.equal(
    a.push(Uint8Array.of(0, ...big.subarray(0, 183)), true, 0).length,
    0,
  );
  const [done] = a.push(big.subarray(183), false, 1);
  assert.deepEqual(done, big);
  // First packet's tail completes the section; pointer field points past it.
  const small = pat([[1, 0x100]]);
  const b = new SectionAssembler();
  b.push(Uint8Array.of(0, ...big.subarray(0, 183)), true, 5);
  const tail = big.subarray(183);
  const both = b.push(
    Uint8Array.of(tail.length, ...tail, ...small, ...small),
    true,
    6,
  );
  assert.deepEqual(both, [big, small, small]);
  // Continuity break drops the partial section instead of gluing a corrupt one.
  const c = new SectionAssembler();
  c.push(Uint8Array.of(0, ...big.subarray(0, 183)), true, 0);
  assert.equal(c.push(big.subarray(183), false, 3).length, 0);
  // Duplicate packet ignored, bad CRC rejected.
  const d = new SectionAssembler();
  assert.equal(d.push(Uint8Array.of(0, ...small), true, 9).length, 1);
  assert.equal(d.push(Uint8Array.of(0, ...small), true, 9).length, 0);
  const broken = small.slice();
  broken[9] ^= 0x10;
  assert.equal(d.push(Uint8Array.of(0, ...broken), true, 10).length, 0);
});

test("extracts the partial reception program and rewrites the PAT", () => {
  counters.clear();
  const filter = new OneSegFilter(RAW);
  const seen = [];
  filter.onPrograms = (p) => seen.push(p.map((x) => x.programNumber));
  const input = concat([
    pes(0x181, 1), // before PAT: dropped
    psi(
      0,
      pat([
        [0x0400, 0x101],
        [0x0401, 0x102],
        [0x0588, 0x1fc8],
      ]),
    ),
    psi(0x101, pmt(0x0400, 0x1ff, HD)),
    psi(0x1fc8, pmt(0x0588, 0x1ff, ONESEG)),
    pes(0x100, 2, { scrambled: true }),
    pes(0x181, 3),
    pes(0x184, 4),
    pes(0x190, 5),
    pes(0x188, 6),
    packet(0x1ff, new Uint8Array(0), {
      adaptation: new Uint8Array(182).fill(0),
    }),
    pes(0x181, 7, { scrambled: true }),
    packet(0x1fff, new Uint8Array(184)),
    pes(0x110, 8),
  ]);
  const out = filter.push(input);
  assert.deepEqual(seen, [[0x0400, 0x0401, 0x0588]]);
  assert.deepEqual(filter.program, {
    programNumber: 0x0588,
    pmtPid: 0x1fc8,
    partialReception: true,
  });
  assert.deepEqual([...filter.pids].sort(), [0x181, 0x184, 0x1ff]);
  assert.deepEqual(pidsOf(out), [0, 0x1fc8, 0x181, 0x184, 0x1ff]);
  // Rewritten PAT: single program, valid CRC, transport_stream_id preserved.
  const patPacket = out.subarray(0, 188);
  assert.equal(patPacket[3], 0x10);
  const s = patPacket.subarray(5, 5 + 16);
  assert.equal(crc32Mpeg2(s), 0);
  assert.deepEqual(
    [...s.subarray(0, 12)],
    [0, 0xb0, 13, 0x7f, 0xe0, 0xc1, 0, 0, 0x05, 0x88, 0xff, 0xc8],
  );
  assert.equal(out[188 * 4 + 3] & 0x30, 0x30); // PCR-only packet kept as-is
  // A second PAT arrival emits again with continuity counter 1 and same version.
  const again = filter.push(
    psi(
      0,
      pat([
        [0x0400, 0x101],
        [0x0401, 0x102],
        [0x0588, 0x1fc8],
      ]),
    ),
  );
  assert.equal(again.length, 188);
  assert.equal(again[3], 0x11);
  assert.equal(again[5 + 5], 0xc1);
  assert.equal(seen.length, 1);
});

test("explicit program selection, reselection and PAT changes", () => {
  counters.clear();
  const programs = [
    [0x0400, 0x101],
    [0x0588, 0x1fc8],
    [0x0589, 0x1fc9],
  ];
  const filter = new OneSegFilter({ ...RAW, programNumber: 0x0589 });
  let out = filter.push(
    concat([
      psi(0, pat(programs)),
      psi(0x1fc8, pmt(0x0588, 0x181, ONESEG)),
      psi(
        0x1fc9,
        pmt(0x0589, 0x281, [
          [0x1b, 0x281],
          [0x0f, 0x284],
        ]),
      ),
      pes(0x181, 1),
      pes(0x281, 2),
    ]),
  );
  assert.deepEqual(pidsOf(out), [0, 0x1fc9, 0x281]);
  assert.equal(out[5 + 5] & 0x3e, 0);
  filter.select(); // back to automatic: first partial reception program
  assert.equal(filter.program.programNumber, 0x0588);
  assert.equal(filter.pids.size, 0);
  out = filter.push(
    concat([
      pes(0x181, 3), // PMT not yet re-read after switching
      psi(0, pat(programs)),
      psi(0x1fc8, pmt(0x0588, 0x181, ONESEG)),
      pes(0x181, 4),
      pes(0x281, 5),
    ]),
  );
  assert.deepEqual(pidsOf(out), [0, 0x1fc8, 0x181]);
  assert.equal((out[5 + 5] >> 1) & 0x1f, 1); // output PAT version bumped on program change
  assert.deepEqual([...out.subarray(5 + 8, 5 + 12)], [0x05, 0x88, 0xff, 0xc8]);
  // Program disappears from a new PAT version: nothing selected, nothing forwarded.
  out = filter.push(concat([psi(0, pat([[0x0400, 0x101]], 1)), pes(0x181, 6)]));
  assert.equal(out.length, 0);
  assert.equal(filter.program, undefined);
  // PAT without any partial reception program and an unknown explicit program.
  const strict = new OneSegFilter({ ...RAW, programNumber: 0x9999 });
  assert.equal(strict.push(psi(0, pat(programs))).length, 0);
  assert.equal(strict.programs.length, 3);
  strict.reset();
  assert.equal(strict.programs.length, 0);
});

test("PMT version change updates forwarded PIDs and trailing bytes are ignored", () => {
  counters.clear();
  const filter = new OneSegFilter({ ...RAW, streamTypes: [0x1b] });
  const first = concat([
    psi(0, pat([[0x0588, 0x1fc8]])),
    psi(
      0x1fc8,
      pmt(0x0588, 0x1fff, [
        [0x1b, 0x181],
        [0x0f, 0x184],
      ]),
    ),
    pes(0x181, 1),
    pes(0x184, 2),
  ]);
  const withTail = new Uint8Array(first.length + 100);
  withTail.set(first);
  withTail.set(pes(0x181, 9).subarray(0, 100), first.length);
  assert.deepEqual(pidsOf(filter.push(withTail)), [0, 0x1fc8, 0x181]);
  const out = filter.push(
    concat([
      psi(0x1fc8, pmt(0x0588, 0x1fff, [[0x1b, 0x182]], 1)),
      pes(0x181, 3),
      pes(0x182, 4),
    ]),
  );
  assert.deepEqual(pidsOf(out), [0x1fc8, 0x182]);
});

// --- ES re-packetizing helpers ---
const ptsBytes = (pts) => [
  0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1),
  Math.floor(pts / 2 ** 22) & 0xff,
  0x01 | ((Math.floor(pts / 2 ** 15) & 0x7f) << 1),
  Math.floor(pts / 2 ** 7) & 0xff,
  0x01 | ((pts & 0x7f) << 1),
];
/** Build a PES (unbounded length when `length` is 0) as TS packets with adaptation stuffing. */
function pesPackets(pid, streamId, pts, payload, length = 0) {
  const header = [
    0,
    0,
    1,
    streamId,
    length >> 8,
    length & 0xff,
    0x80,
    0x80,
    5,
    ...ptsBytes(pts),
  ];
  const data = Uint8Array.of(...header, ...payload);
  const packets = [];
  for (let pos = 0; pos < data.length; pos += 184) {
    const chunk = data.subarray(pos, pos + 184);
    // Short final chunk: adaptation field (1 length byte + stuffing) fills the packet.
    const stuffing = 183 - chunk.length;
    packets.push(
      packet(pid, chunk, {
        start: pos === 0,
        adaptation:
          chunk.length < 184
            ? stuffing
              ? [0, ...new Array(stuffing - 1).fill(0xff)]
              : []
            : undefined,
      }),
    );
  }
  return packets;
}
/** Reassemble PES packets of one PID from TS output: [{pts, length, payload}]. */
function readPes(data, pid) {
  const list = [];
  let pes = [];
  const flush = () => {
    if (!pes.length) return;
    const buf = concatBytes(pes);
    pes = [];
    const pts =
      buf[7] & 0x80
        ? (buf[9] & 0x0e) * 2 ** 29 +
          buf[10] * 2 ** 22 +
          (buf[11] >> 1) * 2 ** 15 +
          buf[12] * 2 ** 7 +
          (buf[13] >> 1)
        : undefined;
    list.push({
      pts,
      length: (buf[4] << 8) | buf[5],
      payload: buf.subarray(9 + buf[8]),
    });
  };
  for (let i = 0; i + 188 <= data.length; i += 188) {
    if ((((data[i + 1] & 0x1f) << 8) | data[i + 2]) !== pid) continue;
    const afc = (data[i + 3] >> 4) & 3;
    const start = afc & 2 ? 5 + data[i + 4] : 4;
    if (data[i + 1] & 0x40) flush();
    if (afc & 1) pes.push(data.subarray(i + start, i + 188));
  }
  flush();
  return list;
}
const concatBytes = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((pos, p) => (out.set(p, pos), pos + p.length), 0);
  return out;
};
const AUD = [0, 0, 0, 1, 0x09, 0xf0];
const slice = (n, size = 300) => [0, 0, 0, 1, 0x41, ...new Array(size).fill(n)];
const adtsFrame = (n, size, channels = 0, sfi = 6) => {
  const length = 7 + size;
  return Uint8Array.of(
    0xff,
    0xf1, // MPEG-4, layer 0, no CRC
    (1 << 6) | (sfi << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
    ...new Array(size).fill(n),
  );
};

test("video PES with several access units is split with interpolated PTS", () => {
  counters.clear();
  const splitter = new AccessUnitSplitter(0x181);
  const au = (n) => [...AUD, ...slice(n)];
  const out = [];
  for (const p of pesPackets(0x181, 0xe0, 90000, [
    ...au(1),
    ...au(2),
    ...au(3),
  ]))
    splitter.push(p, out);
  // The last unit waits for the next PES so that its end is known.
  assert.equal(readPes(concatBytes(out), 0x181).length, 2);
  for (const p of pesPackets(0x181, 0xe0, 90000 + 3 * 3000, [
    ...au(4),
    ...au(5),
    ...au(6),
  ]))
    splitter.push(p, out);
  const list = readPes(concatBytes(out), 0x181);
  assert.deepEqual(
    list.map((p) => p.pts),
    [90000, 96006, 102012, 99000, 102000],
  );
  assert.equal(splitter.frameDuration, 3000); // measured from 3 units per PES
  list.forEach((p, i) => {
    assert.deepEqual([...p.payload.subarray(0, 6)], AUD);
    assert.equal(p.payload[p.payload.length - 1], i + 1);
    assert.equal(p.length, p.payload.length + 8);
  });
  // Continuity counters of the generated packets are consecutive.
  const cc = [];
  for (let i = 0; i < out.length; i++) cc.push(out[i][3] & 0x0f);
  cc.forEach((c, i) => i && assert.equal(c, (cc[i - 1] + 1) & 0x0f));
});

test("video access unit damaged by packet loss is dropped, later units keep timing", () => {
  counters.clear();
  const splitter = new AccessUnitSplitter(0x181);
  const au = (n) => [...AUD, ...slice(n, 400)];
  const packets = pesPackets(0x181, 0xe0, 90000, [
    ...au(1),
    ...au(2),
    ...au(3),
  ]);
  const out = [];
  packets.forEach((p, i) => {
    if (i === 3) return; // lose one packet inside unit 2
    splitter.push(p, out);
  });
  splitter.finish(out);
  const list = readPes(concatBytes(out), 0x181);
  assert.deepEqual(
    list.map((p) => [p.pts, p.payload[p.payload.length - 1]]),
    [
      [90000, 1],
      [90000 + 2 * 6006, 3],
    ],
  );
});

test("ADTS frames are re-packetized one per PES with PES timing and channel fix", () => {
  counters.clear();
  const audio = new AdtsRepacketizer(0x184);
  const frames = [1, 2, 3, 4, 5, 6].map((n) => adtsFrame(n, 200 + n));
  const stream = concatBytes(frames);
  // PES 1 holds frames 1-2 and the head of 3; PES 2 starts inside frame 3 (its PTS is for frame 4).
  const cut = frames[0].length + frames[1].length + 100;
  const out = [];
  for (const p of pesPackets(
    0x184,
    0xc0,
    900000,
    stream.subarray(0, cut),
    cut + 8,
  ))
    audio.push(p, out);
  for (const p of pesPackets(
    0x184,
    0xc0,
    900000 + 3 * 3840 + 90,
    stream.subarray(cut),
    stream.length - cut + 8,
  ))
    audio.push(p, out);
  const list = readPes(concatBytes(out), 0x184);
  assert.deepEqual(
    list.map((p) => p.pts),
    [900000, 903840, 907680, 911610, 915450, 919290],
  );
  list.forEach((p, i) => {
    assert.equal(p.payload.length, frames[i].length);
    assert.equal(p.length, p.payload.length + 8);
    assert.equal(p.payload[p.payload.length - 1], i + 1);
    // channel_configuration 0 -> 2, everything else untouched
    assert.equal(((p.payload[2] & 1) << 2) | (p.payload[3] >> 6), 2);
    assert.deepEqual([...p.payload.subarray(4)], [...frames[i].subarray(4)]);
    assert.equal(p.payload[2] & 0xfe, frames[i][2] & 0xfe);
  });
  // Explicit channel configuration is left alone; patching can be disabled.
  const keep = new AdtsRepacketizer(0x184, false);
  const out2 = [];
  for (const p of pesPackets(
    0x184,
    0xc0,
    1000,
    concatBytes([adtsFrame(1, 50, 0), adtsFrame(2, 50, 1)]),
  ))
    keep.push(p, out2);
  assert.deepEqual(
    readPes(concatBytes(out2), 0x184).map(
      (p) => ((p.payload[2] & 1) << 2) | (p.payload[3] >> 6),
    ),
    [0, 1],
  );
});

test("ADTS frame damaged by packet loss is dropped and the stream resyncs", () => {
  counters.clear();
  const audio = new AdtsRepacketizer(0x184);
  const frames = [1, 2, 3, 4, 5].map((n) => adtsFrame(n, 150));
  const packets = [
    ...pesPackets(0x184, 0xc0, 900000, concatBytes(frames)),
    ...pesPackets(0x184, 0xc0, 900000 + 5 * 3840, adtsFrame(6, 150)),
  ];
  const out = [];
  packets.forEach((p, i) => {
    if (i === 2) return; // inside frames 3 and 4
    audio.push(p, out);
  });
  const list = readPes(concatBytes(out), 0x184);
  const ids = list.map((p) => p.payload[p.payload.length - 1]);
  assert.deepEqual(ids, [1, 2, 5, 6]);
  assert.equal(list[3].pts, 900000 + 5 * 3840);
  // Timestamps stay monotonic and frame-spaced.
  list.forEach(
    (p, i) => i && assert.equal((p.pts - list[i - 1].pts) % 3840, 0),
  );
});
