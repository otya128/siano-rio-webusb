/**
 * Extract a single (1seg / partial reception) program from an ISDB-T
 * transport stream so a generic MPEG-TS player can play it.
 *
 * Players like mpegts.js play the first program listed in the PAT, which in
 * ISDB-T is the scrambled MPEG-2 full-segment service. This filter rewrites
 * the PAT to reference only the chosen program, forwards its PMT, and passes
 * through only unscrambled elementary streams of playable types.
 */
const PACKET = 188;
const MAX_SECTION = 4096;
/** PMT PIDs reserved for partial reception (1seg) services (ARIB STD-B10). */
export function isPartialReceptionPmtPid(pid: number): boolean {
  return pid >= 0x1fc8 && pid <= 0x1fcf;
}
/** stream_type values that MSE-based players can decode. */
export const PLAYABLE_STREAM_TYPES: readonly number[] = [
  0x1b, // H.264
  0x24, // H.265
  0x0f, // ADTS AAC
  0x11, // LOAS AAC
  0x03, // MPEG-1 audio
  0x04, // MPEG-2 audio
];
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++)
      c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();
/** ITU-T H.222.0 Annex A CRC-32 (no reflection, no final XOR). Appended CRC makes the total 0. */
export function crc32Mpeg2(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data)
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}
/** Reassemble PSI sections carried on one PID, verifying CRC and continuity. */
export class SectionAssembler {
  private pending?: Uint8Array;
  private counter = -1;
  reset(): void {
    this.pending = undefined;
    this.counter = -1;
  }
  push(payload: Uint8Array, unitStart: boolean, counter: number): Uint8Array[] {
    const sections: Uint8Array[] = [];
    if (counter === this.counter) return sections; // duplicate packet
    const continuous = ((this.counter + 1) & 0x0f) === counter;
    this.counter = counter;
    if (!continuous) this.pending = undefined;
    if (!unitStart) {
      if (this.pending) this.feed(payload, false, sections);
      return sections;
    }
    if (!payload.length) return sections;
    const pointer = payload[0];
    if (this.pending)
      this.feed(payload.subarray(1, 1 + pointer), false, sections);
    this.pending = undefined;
    this.feed(payload.subarray(1 + pointer), true, sections);
    return sections;
  }
  private feed(bytes: Uint8Array, allowStart: boolean, out: Uint8Array[]) {
    let data = bytes;
    if (this.pending) {
      data = new Uint8Array(this.pending.length + bytes.length);
      data.set(this.pending);
      data.set(bytes, this.pending.length);
    }
    let pos = 0;
    while (data.length - pos >= 3 && (pos === 0 || allowStart)) {
      if (data[pos] === 0xff) {
        pos = data.length;
        break;
      }
      const total = 3 + (((data[pos + 1] & 0x0f) << 8) | data[pos + 2]);
      if (total > MAX_SECTION) {
        pos = data.length;
        break;
      }
      if (data.length - pos < total) break;
      const section = data.slice(pos, pos + total);
      if (crc32Mpeg2(section) === 0) out.push(section);
      pos += total;
    }
    const rest = data.subarray(pos);
    this.pending =
      rest.length && (pos === 0 || allowStart) && rest[0] !== 0xff
        ? rest.slice()
        : undefined;
  }
}
const PTS_MODULO = 2 ** 33;
/** 90 kHz ticks per frame at 29.97 / 2 Hz, the usual 1seg rate, used until measured. */
const DEFAULT_FRAME_DURATION = 6006;
const PES_MAX_LENGTH = 0xffff;
/**
 * Re-packetize one H.264 PID so that every PES carries a single access unit.
 *
 * ISDB-T 1seg video stores several access units (AUD-delimited frames) in one
 * PES whose PTS belongs to the first of them. Players that map one PES to one
 * sample (mpegts.js, MSE) then decode a burst of frames with the same
 * timestamp. Later frames get PTS + n × frame duration, where the duration
 * is measured from consecutive PES timestamps divided by their frame counts.
 */
/** Track the continuity counter of one PID to detect lost and duplicated packets. */
class ContinuityTracker {
  private last = -1;
  reset(): void {
    this.last = -1;
  }
  check(packet: Uint8Array): "ok" | "lost" | "duplicate" {
    const counter = packet[3] & 0x0f;
    const hasPayload = (packet[3] & 0x10) !== 0;
    const previous = this.last;
    if (hasPayload) this.last = counter;
    if (previous < 0 || !hasPayload) return "ok";
    if (counter === previous) return "duplicate";
    return ((previous + 1) & 0x0f) === counter ? "ok" : "lost";
  }
}
export class AccessUnitSplitter {
  private readonly continuity = new ContinuityTracker();
  private pending = new Uint8Array(0);
  private scanned = 0;
  private active = false;
  private corrupt = false;
  private lossInPes = false;
  private basePts = -1;
  private index = 0;
  private lastPts = -1;
  private lastCount = 0;
  private duration = DEFAULT_FRAME_DURATION;
  private counter = 0;
  constructor(readonly pid: number) {}
  /** Measured frame duration in 90 kHz ticks. */
  get frameDuration(): number {
    return this.duration;
  }
  reset(): void {
    this.continuity.reset();
    this.pending = new Uint8Array(0);
    this.scanned = 0;
    this.active = false;
    this.corrupt = this.lossInPes = false;
    this.basePts = this.lastPts = -1;
    this.index = this.lastCount = 0;
  }
  /** Consume one TS packet of this PID; generated packets are appended to `out`. */
  push(packet: Uint8Array, out: Uint8Array[]): void {
    const continuity = this.continuity.check(packet);
    if (continuity === "duplicate") return;
    if (continuity === "lost") {
      // The access unit being assembled is missing data: never emit it.
      this.corrupt = true;
      this.lossInPes = true;
    }
    const header = readPesHeader(packet);
    if (!header) return;
    const payload = packet.subarray(header.start);
    if (header.unitStart) {
      this.finish(out);
      this.active = true;
      this.index = 0;
      this.basePts =
        header.pts ??
        (this.lastPts < 0
          ? -1
          : Math.round(this.lastPts + this.lastCount * this.duration) %
            PTS_MODULO);
      if (
        header.pts !== undefined &&
        this.lastPts >= 0 &&
        this.lastCount &&
        !this.lossInPes
      ) {
        const measured =
          ((header.pts - this.lastPts + PTS_MODULO) % PTS_MODULO) /
          this.lastCount;
        if (measured >= 1000 && measured <= 15000) this.duration = measured;
      }
      this.lastPts = this.basePts;
      this.lastCount = 0;
      this.lossInPes = continuity === "lost";
    } else if (!this.active) return;
    this.append(payload);
    this.scan(out);
  }
  /** Emit the access unit still buffered from the current PES. */
  finish(out: Uint8Array[]): void {
    if (this.active && this.pending.length > 4) this.emit(this.pending, out);
    this.pending = new Uint8Array(0);
    this.scanned = 0;
    this.active = false;
    this.corrupt = false;
  }
  private append(bytes: Uint8Array) {
    if (!bytes.length) return;
    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending);
    merged.set(bytes, this.pending.length);
    this.pending = merged;
  }
  /** Cut at every AUD start code (00 00 01 09) that is preceded by data. */
  private scan(out: Uint8Array[]) {
    const data = this.pending;
    let unitStart = 0;
    for (let i = this.scanned; i + 3 < data.length; i++) {
      if (
        data[i] !== 0 ||
        data[i + 1] !== 0 ||
        data[i + 2] !== 1 ||
        (data[i + 3] & 0x1f) !== 9
      )
        continue;
      const boundary = i > 0 && data[i - 1] === 0 ? i - 1 : i;
      if (boundary > unitStart + 4)
        this.emit(data.subarray(unitStart, boundary), out);
      unitStart = boundary;
      i += 3;
    }
    if (unitStart) this.pending = data.slice(unitStart);
    this.scanned = Math.max(0, this.pending.length - 3);
  }
  private emit(unit: Uint8Array, out: Uint8Array[]) {
    const index = this.index++;
    this.lastCount++;
    if (this.corrupt) {
      this.corrupt = false;
      return;
    }
    if (this.basePts < 0) return; // no timestamp reference yet
    const pts = Math.round(this.basePts + index * this.duration) % PTS_MODULO;
    this.counter = writePes(this.pid, 0xe0, pts, unit, this.counter, out);
  }
}
/** Wrap `payload` in a PES packet and emit it as TS packets; returns the next continuity counter. */
function writePes(
  pid: number,
  streamId: number,
  pts: number | undefined,
  payload: Uint8Array,
  counter: number,
  out: Uint8Array[],
): number {
  const headerLength = pts === undefined ? 9 : 14;
  const pes = new Uint8Array(headerLength + payload.length);
  const bodyLength = pes.length - 6;
  pes.set([
    0,
    0,
    1,
    streamId,
    bodyLength > PES_MAX_LENGTH ? 0 : bodyLength >> 8,
    bodyLength > PES_MAX_LENGTH ? 0 : bodyLength & 0xff,
    0x80,
    pts === undefined ? 0x00 : 0x80,
    pts === undefined ? 0 : 5,
  ]);
  if (pts !== undefined) {
    pes[9] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
    pes[10] = Math.floor(pts / 2 ** 22) & 0xff;
    pes[11] = 0x01 | ((Math.floor(pts / 2 ** 15) & 0x7f) << 1);
    pes[12] = Math.floor(pts / 2 ** 7) & 0xff;
    pes[13] = 0x01 | ((pts & 0x7f) << 1);
  }
  pes.set(payload, headerLength);
  for (let pos = 0, first = true; pos < pes.length; first = false) {
    const remaining = pes.length - pos;
    const packet = new Uint8Array(PACKET);
    packet[0] = 0x47;
    packet[1] = (first ? 0x40 : 0) | (pid >> 8);
    packet[2] = pid & 0xff;
    packet[3] = counter;
    counter = (counter + 1) & 0x0f;
    let offset = 4;
    if (remaining < PACKET - 4) {
      const stuffing = PACKET - 5 - remaining;
      packet[3] |= 0x30;
      packet[4] = stuffing;
      if (stuffing) packet.fill(0xff, 6, 5 + stuffing);
      if (stuffing) packet[5] = 0x00;
      offset = 5 + stuffing;
    } else packet[3] |= 0x10;
    const take = Math.min(remaining, PACKET - offset);
    packet.set(pes.subarray(pos, pos + take), offset);
    pos += take;
    out.push(packet);
  }
  return counter;
}
/** Locate the ES payload of a TS packet, skipping the PES header on a unit start. */
function readPesHeader(
  packet: Uint8Array,
): { start: number; unitStart: boolean; pts?: number } | undefined {
  const control = (packet[3] >> 4) & 3;
  if (!(control & 1)) return;
  let start = control & 2 ? 5 + packet[4] : 4;
  if (start > PACKET) return;
  if (!(packet[1] & 0x40)) return { start, unitStart: false };
  const payload = packet.subarray(start);
  if (
    payload.length < 9 ||
    payload[0] !== 0 ||
    payload[1] !== 0 ||
    payload[2] !== 1
  )
    return;
  const headerLength = 9 + payload[8];
  if (headerLength > payload.length) return;
  start += headerLength;
  if (!(payload[7] & 0x80)) return { start, unitStart: true };
  const pts =
    (payload[9] & 0x0e) * 2 ** 29 +
    payload[10] * 2 ** 22 +
    (payload[11] >> 1) * 2 ** 15 +
    payload[12] * 2 ** 7 +
    (payload[13] >> 1);
  return { start, unitStart: true, pts };
}
const ADTS_HEADER = 7;
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
/**
 * Re-packetize one ADTS AAC PID so that every PES carries exactly one frame.
 *
 * Broadcast audio PES packets start and end in the middle of ADTS frames, with
 * the PES PTS belonging to the first frame that begins in the packet. mpegts.js
 * mishandles the fragments (a stale tail is re-used, short tails are dropped),
 * which corrupts frames, so frames are reassembled here and each gets its own
 * PES and PTS (PES PTS + n × frame duration).
 *
 * ARIB dual mono is signalled with channel_configuration = 0 and no
 * program_config_element; MSE rejects an AudioSpecificConfig with 0 channels,
 * so such headers are rewritten to `channelConfiguration`. The ADTS CRC, when
 * present, is left as is.
 */
export class AdtsRepacketizer {
  private readonly continuity = new ContinuityTracker();
  private buffer = new Uint8Array(0);
  /** Absolute stream offset of buffer[0]. */
  private consumed = 0;
  private synced = false;
  private boundaries: { offset: number; pts: number; used: boolean }[] = [];
  private basePts = -1;
  private index = 0;
  private counter = 0;
  constructor(
    readonly pid: number,
    readonly channelConfiguration: number | false = 2,
  ) {}
  reset(): void {
    this.continuity.reset();
    this.buffer = new Uint8Array(0);
    this.consumed = 0;
    this.synced = false;
    this.boundaries = [];
    this.basePts = -1;
    this.index = 0;
  }
  push(packet: Uint8Array, out: Uint8Array[]): void {
    const continuity = this.continuity.check(packet);
    if (continuity === "duplicate") return;
    if (continuity === "lost") {
      // Discard the partial frame; a decoder treats a damaged frame as fatal.
      this.consumed += this.buffer.length;
      this.buffer = new Uint8Array(0);
      this.synced = false;
    }
    const header = readPesHeader(packet);
    if (!header) return;
    if (header.unitStart && header.pts !== undefined)
      this.boundaries.push({
        offset: this.consumed + this.buffer.length,
        pts: header.pts,
        used: false,
      });
    const bytes = packet.subarray(header.start);
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    let pos = 0;
    for (;;) {
      const data = this.buffer;
      if (!this.synced) {
        while (pos + ADTS_HEADER <= data.length && !isAdtsHeader(data, pos))
          pos++;
        if (pos + ADTS_HEADER > data.length) break;
      }
      if (pos + ADTS_HEADER > data.length) break;
      const frameLength = adtsFrameLength(data, pos);
      if (!isAdtsHeader(data, pos) || frameLength < ADTS_HEADER) {
        this.synced = false;
        pos++;
        continue;
      }
      if (pos + frameLength > data.length) break;
      if (!this.synced) {
        // Confirm the first frame with the sync word of the one that follows.
        if (pos + frameLength + 2 > data.length) break;
        if (!isAdtsHeader(data, pos + frameLength)) {
          pos++;
          continue;
        }
        this.synced = true;
      }
      this.emit(data.slice(pos, pos + frameLength), this.consumed + pos, out);
      pos += frameLength;
    }
    if (pos) {
      this.buffer = this.buffer.slice(pos);
      this.consumed += pos;
    }
    // Forget boundaries that can no longer apply to a future frame.
    while (
      this.boundaries.length > 1 &&
      this.boundaries[1].offset <= this.consumed
    )
      this.boundaries.shift();
  }
  private emit(frame: Uint8Array, offset: number, out: Uint8Array[]) {
    const sampleRate = ADTS_SAMPLE_RATES[(frame[2] >> 2) & 0x0f] ?? 48000;
    const duration = (1024 * 90000) / sampleRate;
    // The PES PTS belongs to the first frame starting at or after the PES boundary.
    let boundary: { pts: number; used: boolean } | undefined;
    for (const b of this.boundaries) if (b.offset <= offset) boundary = b;
    if (boundary && !boundary.used) {
      boundary.used = true;
      this.basePts = boundary.pts;
      this.index = 0;
    }
    const index = this.index++;
    if (this.basePts < 0) return; // no timestamp reference yet
    const pts = Math.round(this.basePts + index * duration) % PTS_MODULO;
    if (
      this.channelConfiguration !== false &&
      (((frame[2] & 0x01) << 2) | (frame[3] >> 6)) === 0
    ) {
      frame[2] = (frame[2] & 0xfe) | ((this.channelConfiguration >> 2) & 1);
      frame[3] = (frame[3] & 0x3f) | ((this.channelConfiguration & 3) << 6);
    }
    this.counter = writePes(this.pid, 0xc0, pts, frame, this.counter, out);
  }
}
function isAdtsHeader(data: Uint8Array, pos: number): boolean {
  return data[pos] === 0xff && (data[pos + 1] & 0xf6) === 0xf0;
}
function adtsFrameLength(data: Uint8Array, pos: number): number {
  return (
    ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | (data[pos + 5] >> 5)
  );
}
export interface TsProgram {
  readonly programNumber: number;
  readonly pmtPid: number;
  readonly partialReception: boolean;
}
export interface ProgramFilterOptions {
  /** program_number to extract. Omit to take the first partial reception program. */
  programNumber?: number;
  /** stream_type values whose elementary streams are forwarded. */
  streamTypes?: Iterable<number>;
  /** Re-packetize H.264 video so each PES holds one access unit (default true). */
  splitAccessUnits?: boolean;
  /** Re-packetize ADTS audio so each PES holds one complete frame (default true). */
  repacketizeAdts?: boolean;
  /** channel_configuration written into ADTS headers that carry 0 (default 2, `false` keeps 0). */
  adtsChannelConfiguration?: number | false;
}
export class OneSegFilter {
  private readonly patSections = new SectionAssembler();
  private readonly pmtSections = new SectionAssembler();
  private readonly streamTypes: Set<number>;
  private preferred?: number;
  private patVersion = -1;
  private transportStreamId = -1;
  private readonly programsBySection = new Map<number, TsProgram[]>();
  private selected?: TsProgram;
  private forwarded = new Set<number>();
  private splitters = new Map<number, AccessUnitSplitter>();
  private patchers = new Map<number, AdtsRepacketizer>();
  private readonly splitAccessUnits: boolean;
  private readonly repacketizeAdts: boolean;
  private readonly adtsChannelConfiguration: number | false;
  private outputKey = "";
  private outputVersion = 0;
  private outputCounter = 0;
  private programList: readonly TsProgram[] = [];
  /** Called when the PAT program list changes. */
  onPrograms?: (programs: readonly TsProgram[]) => void;
  constructor(options: ProgramFilterOptions = {}) {
    this.preferred = options.programNumber;
    this.streamTypes = new Set(options.streamTypes ?? PLAYABLE_STREAM_TYPES);
    this.splitAccessUnits = options.splitAccessUnits ?? true;
    this.repacketizeAdts = options.repacketizeAdts ?? true;
    this.adtsChannelConfiguration = options.adtsChannelConfiguration ?? 2;
  }
  /** Programs listed in the most recent PAT. */
  get programs(): readonly TsProgram[] {
    return this.programList;
  }
  /** Program currently being extracted, once found in the PAT. */
  get program(): TsProgram | undefined {
    return this.selected;
  }
  /** Elementary/PCR PIDs forwarded from the selected PMT. */
  get pids(): ReadonlySet<number> {
    return this.forwarded;
  }
  /** Change the extracted program. Takes effect at the next PAT. */
  select(programNumber?: number): void {
    this.preferred = programNumber;
    this.updateSelection();
  }
  reset(): void {
    this.patSections.reset();
    this.pmtSections.reset();
    this.patVersion = this.transportStreamId = -1;
    this.programsBySection.clear();
    this.programList = [];
    this.selected = undefined;
    this.forwarded = new Set();
    this.splitters = new Map();
    this.patchers = new Map();
  }
  /** Input and output are whole 188-byte packets; a trailing partial packet is ignored. */
  push(packets: Uint8Array): Uint8Array<ArrayBuffer> {
    const output: Uint8Array[] = [];
    for (let pos = 0; pos + PACKET <= packets.length; pos += PACKET) {
      const packet = packets.subarray(pos, pos + PACKET);
      if (packet[0] !== 0x47 || packet[1] & 0x80) continue;
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      if (pid === 0x1fff) continue;
      const scrambled = (packet[3] & 0xc0) !== 0;
      const unitStart = (packet[1] & 0x40) !== 0;
      const control = (packet[3] >> 4) & 3;
      const counter = packet[3] & 0x0f;
      let payload: Uint8Array | undefined;
      if (control & 1) {
        const start = control & 2 ? 5 + packet[4] : 4;
        if (start <= PACKET) payload = packet.subarray(start);
      }
      if (pid === 0) {
        if (!payload || scrambled) continue;
        for (const section of this.patSections.push(
          payload,
          unitStart,
          counter,
        )) {
          const pat = this.handlePat(section);
          if (pat) output.push(pat);
        }
      } else if (this.selected && pid === this.selected.pmtPid) {
        if (scrambled) continue;
        output.push(packet);
        if (payload)
          for (const section of this.pmtSections.push(
            payload,
            unitStart,
            counter,
          ))
            this.handlePmt(section);
      } else if (this.forwarded.has(pid) && !scrambled) {
        const splitter = this.splitters.get(pid);
        const patcher = this.patchers.get(pid);
        if (splitter) splitter.push(packet, output);
        else if (patcher) patcher.push(packet, output);
        else output.push(packet);
      }
    }
    const result = new Uint8Array(output.length * PACKET);
    output.forEach((packet, i) => result.set(packet, i * PACKET));
    return result;
  }
  private handlePat(section: Uint8Array): Uint8Array | undefined {
    if (section[0] !== 0x00 || !(section[5] & 1)) return;
    const transportStreamId = (section[3] << 8) | section[4];
    const version = (section[5] >> 1) & 0x1f;
    if (
      version !== this.patVersion ||
      transportStreamId !== this.transportStreamId
    ) {
      this.programsBySection.clear();
      this.patVersion = version;
      this.transportStreamId = transportStreamId;
    }
    const programs: TsProgram[] = [];
    for (let i = 8; i + 4 <= section.length - 4; i += 4) {
      const programNumber = (section[i] << 8) | section[i + 1];
      const pmtPid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
      if (programNumber !== 0)
        programs.push({
          programNumber,
          pmtPid,
          partialReception: isPartialReceptionPmtPid(pmtPid),
        });
    }
    this.programsBySection.set(section[6], programs);
    const list = [...this.programsBySection.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, entries]) => entries);
    const key = (entries: readonly TsProgram[]) =>
      entries.map((p) => `${p.programNumber}:${p.pmtPid}`).join(",");
    if (key(list) !== key(this.programList)) {
      this.programList = Object.freeze(list);
      this.onPrograms?.(this.programList);
    }
    this.updateSelection();
    return this.buildPat();
  }
  private updateSelection() {
    const wanted =
      this.preferred === undefined
        ? this.programList.find((p) => p.partialReception)
        : this.programList.find((p) => p.programNumber === this.preferred);
    if (
      wanted?.programNumber === this.selected?.programNumber &&
      wanted?.pmtPid === this.selected?.pmtPid
    )
      return;
    this.selected = wanted;
    this.forwarded = new Set();
    this.splitters = new Map();
    this.patchers = new Map();
    this.pmtSections.reset();
  }
  private buildPat(): Uint8Array | undefined {
    const program = this.selected;
    if (!program) return;
    const key = `${this.transportStreamId}:${program.programNumber}:${program.pmtPid}`;
    if (key !== this.outputKey) {
      if (this.outputKey) this.outputVersion = (this.outputVersion + 1) & 0x1f;
      this.outputKey = key;
    }
    const section = Uint8Array.of(
      0x00,
      0xb0,
      13,
      this.transportStreamId >> 8,
      this.transportStreamId & 0xff,
      0xc1 | (this.outputVersion << 1),
      0,
      0,
      program.programNumber >> 8,
      program.programNumber & 0xff,
      0xe0 | (program.pmtPid >> 8),
      program.pmtPid & 0xff,
      0,
      0,
      0,
      0,
    );
    const crc = crc32Mpeg2(section.subarray(0, 12));
    section[12] = crc >>> 24;
    section[13] = (crc >>> 16) & 0xff;
    section[14] = (crc >>> 8) & 0xff;
    section[15] = crc & 0xff;
    const packet = new Uint8Array(PACKET).fill(0xff);
    packet.set([0x47, 0x40, 0x00, 0x10 | this.outputCounter, 0x00]);
    packet.set(section, 5);
    this.outputCounter = (this.outputCounter + 1) & 0x0f;
    return packet;
  }
  private handlePmt(section: Uint8Array) {
    const program = this.selected;
    if (!program || section[0] !== 0x02 || !(section[5] & 1)) return;
    if (((section[3] << 8) | section[4]) !== program.programNumber) return;
    const pids = new Set<number>();
    const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
    if (pcrPid !== 0x1fff) pids.add(pcrPid);
    const infoLength = ((section[10] & 0x0f) << 8) | section[11];
    const splitters = new Map<number, AccessUnitSplitter>();
    const patchers = new Map<number, AdtsRepacketizer>();
    for (let i = 12 + infoLength; i + 5 <= section.length - 4;) {
      const pid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
      if (this.streamTypes.has(section[i])) pids.add(pid);
      if (this.splitAccessUnits && section[i] === 0x1b)
        splitters.set(
          pid,
          this.splitters.get(pid) ?? new AccessUnitSplitter(pid),
        );
      if (this.repacketizeAdts && section[i] === 0x0f)
        patchers.set(
          pid,
          this.patchers.get(pid) ??
            new AdtsRepacketizer(pid, this.adtsChannelConfiguration),
        );
      i += 5 + (((section[i + 3] & 0x0f) << 8) | section[i + 4]);
    }
    this.forwarded = pids;
    this.splitters = splitters;
    this.patchers = patchers;
  }
}
