// ISDB-T front end ported from smsdvb-main.c (Siano Mobile Silicon, Uri Shkolnik). GPL-2.0-or-later.
import {
  Bandwidth,
  DeviceMode,
  DVBT_BDA_CONTROL_MSG_ID,
  HIF_TASK,
  Msg,
} from "./messages.js";
import {
  encodeMessage,
  type Message,
  ProtocolError,
  u32le,
} from "./protocol.js";
import type { SmsCore } from "./core.js";

/** SMSHOSTLIB_CONSTELLATION_ET mapped as sms_to_modulation_table. */
export type Modulation = "QPSK" | "16QAM" | "64QAM" | "DQPSK" | "unknown";
/** SMSHOSTLIB_CODE_RATE_ET mapped as sms_to_code_rate_table. */
export type CodeRate = "1/2" | "2/3" | "3/4" | "5/6" | "7/8" | "unknown";
export interface LayerStatistics {
  /** false when the firmware reports 255 (layer does not exist) or no segments. */
  present: boolean;
  codeRate: CodeRate;
  modulation: Modulation;
  /** Post Viterbi BER in 1e-5 units; undefined when the firmware reports N/A. */
  ber?: number;
  berErrorCount: number;
  berBitCount: number;
  preBer?: number;
  /** Transport stream PER in percent; undefined when N/A. */
  tsPer?: number;
  errorTsPackets: number;
  totalTsPackets: number;
  timeInterleaving: number;
  segments: number;
  tmccErrors: number;
}
/** struct sms_isdbt_stats / sms_isdbt_stats_ex */
export interface Statistics {
  /** MSG_SMS_GET_STATISTICS_EX_RES carries the extended block. */
  extended: boolean;
  statisticsType: number;
  rfLocked: boolean;
  demodLocked: boolean;
  externalLnaOn: boolean;
  snrDb: number;
  rssiDbm: number;
  inBandPowerDbm: number;
  carrierOffsetHz: number;
  frequencyHz: number;
  bandwidthMhz: number;
  /** ISDB-T mode 1..3; 0 when unknown. */
  transmissionMode: number;
  /** 0 - acquisition, 1 - locked */
  modemState: number;
  /** Guard interval as 1/n; 0 when unknown. */
  guardIntervalDenominator: number;
  systemType: number;
  partialReception: boolean;
  layers: LayerStatistics[];
  segmentNumber?: number;
  tuneBandwidth?: number;
  receptionQuality?: number;
  ewsAlertActive?: boolean;
  lnaOn?: boolean;
  rfAgcLevel?: number;
  bbAgcLevel?: number;
  firmwareErrorCount?: number;
  firmwareErrorHistory?: number[];
  mrcSnrDb?: number;
  /** SNR in dB with 16 fractional bits divided out. */
  snrFullResolutionDb?: number;
}
export type IsdbtBandwidth = "13seg" | "3seg" | "1seg";
export interface TuneOptions {
  /** Default 13seg, as smsdvb_isdbt_set_frontend() picks BW_ISDBT_13SEG for Pele/Rio. */
  bandwidth?: IsdbtBandwidth;
  /** isdbt_sb_segment_idx for ISDB-Tsb reception. */
  segmentIndex?: number;
}
export const MODULATIONS: readonly Modulation[] = [
  "QPSK",
  "16QAM",
  "64QAM",
  "DQPSK",
];
export const CODE_RATES: readonly CodeRate[] = [
  "1/2",
  "2/3",
  "3/4",
  "5/6",
  "7/8",
];
const table = <T>(value: number, values: readonly T[], fallback: T): T =>
  value < values.length ? values[value] : fallback;
const optional = (value: number) => (value === 0xffffffff ? undefined : value);
const LAYER_WORDS = 12;
function parseLayer(view: DataView, offset: number): LayerStatistics {
  const u = (i: number) => view.getUint32(offset + i * 4, true);
  const segments = u(10);
  return {
    present: segments > 0 && segments < 13,
    codeRate: table(u(0), CODE_RATES, "unknown"),
    modulation: table(u(1), MODULATIONS, "unknown"),
    ber: optional(u(2)),
    berErrorCount: u(3),
    berBitCount: u(4),
    preBer: optional(u(5)),
    tsPer: optional(u(6)),
    errorTsPackets: u(7),
    totalTsPackets: u(8),
    timeInterleaving: u(9),
    segments,
    tmccErrors: u(11),
  };
}
/** sms_to_isdbt_mode() / sms_to_isdbt_guard_interval() keep only the values the firmware documents. */
const isdbtMode = (mode: number) => (mode >= 1 && mode <= 3 ? mode : 0);
const guardInterval = (value: number) =>
  [4, 8, 16, 32].includes(value) ? value : 0;
/**
 * Parse the payload of MSG_SMS_GET_STATISTICS_RES (ISDB-T mode) or, with
 * extended=true, MSG_SMS_GET_STATISTICS_EX_RES after its request_result word.
 */
export function parseIsdbtStatistics(
  payload: Uint8Array,
  extended: boolean,
): Statistics {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const words = payload.length >> 2;
  const u = (i: number) => (i < words ? view.getUint32(i * 4, true) : 0);
  const s = (i: number) => (i < words ? view.getInt32(i * 4, true) : 0);
  if (words < 2) throw new ProtocolError("Short statistics response");
  const statisticsType = u(0);
  const base: Statistics = {
    extended,
    statisticsType,
    rfLocked: !!u(2),
    demodLocked: !!u(3),
    externalLnaOn: !!u(4),
    snrDb: s(5),
    rssiDbm: s(6),
    inBandPowerDbm: s(7),
    carrierOffsetHz: s(8),
    frequencyHz: u(9),
    bandwidthMhz: u(10),
    transmissionMode: isdbtMode(u(11)),
    modemState: u(12),
    guardIntervalDenominator: guardInterval(u(13)),
    systemType: u(14),
    partialReception: !!u(15),
    layers: [],
  };
  // Firmware 2.1 reports only lock status and signal strength, the latter in the transmission_mode slot.
  if (!extended && statisticsType === 0) {
    return {
      ...base,
      snrDb: 0,
      rssiDbm: 0,
      inBandPowerDbm: s(11),
      carrierOffsetHz: 0,
      frequencyHz: 0,
      bandwidthMhz: 0,
      transmissionMode: 0,
      modemState: 0,
      guardIntervalDenominator: 0,
      systemType: 0,
      partialReception: false,
    };
  }
  const numLayers = Math.min(Math.max(u(16), 1), 3);
  let layerOffset = 17;
  if (extended) {
    base.segmentNumber = u(17);
    base.tuneBandwidth = u(18);
    layerOffset = 19;
  }
  for (let i = 0; i < numLayers; i++) {
    const offset = (layerOffset + i * LAYER_WORDS) * 4;
    if (offset + LAYER_WORDS * 4 > payload.length) break;
    base.layers.push(parseLayer(view, offset));
  }
  if (extended) {
    const p = layerOffset + 3 * LAYER_WORDS; // reserved1
    if (p + 10 <= words) {
      base.receptionQuality = u(p + 2);
      base.ewsAlertActive = !!u(p + 3);
      base.lnaOn = !!u(p + 4);
      base.rfAgcLevel = u(p + 5);
      base.bbAgcLevel = u(p + 6);
      base.firmwareErrorCount = u(p + 7);
      base.firmwareErrorHistory = Array.from(
        payload.subarray((p + 8) * 4, (p + 10) * 4),
      );
    }
    if (p + 12 <= words) {
      base.mrcSnrDb = s(p + 10);
      base.snrFullResolutionDb = u(p + 11) / 65536;
    }
  }
  return base;
}
/** UHF channel center frequency in kHz (473 1/7 MHz for channel 13). */
export function channelFrequency(channel: number): number {
  if (!Number.isInteger(channel) || channel < 13 || channel > 62)
    throw new RangeError("UHF channel must be 13–62");
  return 473143 + (channel - 13) * 6000;
}
export type FrontendStatus = "unknown" | "no-signal" | "signal" | "locked";
/** smsdvb_client_t: tune, PID filters and statistics for a device in ISDB-T mode. */
export class IsdbtFrontend {
  /** fe_status as last reported by a response or indication. */
  status: FrontendStatus = "unknown";
  private statistics?: Statistics;
  private statisticsAt = -Infinity;
  private readonly pids = new Set<number>();
  constructor(private readonly core: SmsCore) {}
  get lastStatistics(): Statistics | undefined {
    return this.statistics;
  }
  get pidFilters(): readonly number[] {
    return [...this.pids];
  }
  private message(type: number, payload: Uint8Array | ArrayLike<number> = []) {
    return encodeMessage(type, payload, DVBT_BDA_CONTROL_MSG_ID, HIF_TASK);
  }
  private request(type: number, payload: Uint8Array, responseType: number) {
    return this.core.transport.request(
      this.message(type, payload),
      responseType,
      2000,
    );
  }
  /** smsdvb_isdbt_set_frontend(); Rio has no LNA control, so a single tune request. */
  async tune(frequencyHz: number, options: TuneOptions = {}): Promise<void> {
    if (
      !Number.isInteger(frequencyHz) ||
      frequencyHz < 44250000 ||
      frequencyHz > 867250000
    )
      throw new RangeError("Frequency must be 44250000–867250000 Hz");
    const segmentIndex = options.segmentIndex ?? 0;
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0)
      throw new RangeError("Invalid segment index");
    const bandwidth = {
      "13seg": Bandwidth.BW_ISDBT_13SEG,
      "3seg": Bandwidth.BW_ISDBT_3SEG,
      "1seg": Bandwidth.BW_ISDBT_1SEG,
    }[options.bandwidth ?? "13seg"];
    if (bandwidth === undefined) throw new RangeError("Invalid bandwidth");
    this.status = "unknown";
    this.statistics = undefined;
    this.statisticsAt = -Infinity;
    await this.request(
      Msg.MSG_SMS_ISDBT_TUNE_REQ,
      u32le(frequencyHz, bandwidth, 12000000, segmentIndex),
      Msg.MSG_SMS_ISDBT_TUNE_RES,
    );
  }
  /** smsdvb_start_feed(): 0x2000 selects the whole transport stream. */
  async addPidFilter(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid < 0 || pid > 0x2000)
      throw new RangeError("PID must be 0–0x2000");
    await this.core.transport.send(
      this.message(Msg.MSG_SMS_ADD_PID_FILTER_REQ, u32le(pid)),
    );
    this.pids.add(pid);
  }
  /** smsdvb_stop_feed() */
  async removePidFilter(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid < 0 || pid > 0x2000)
      throw new RangeError("PID must be 0–0x2000");
    await this.core.transport.send(
      this.message(Msg.MSG_SMS_REMOVE_PID_FILTER_REQ, u32le(pid)),
    );
    this.pids.delete(pid);
  }
  /** smsdvb_send_statistics_request(): rate limited to one request per 100 ms. */
  async readStatistics(): Promise<Statistics> {
    const now = performance.now();
    if (this.statistics && now - this.statisticsAt < 100)
      return this.statistics;
    const extended = this.core.fwVersion >= 0x800;
    const reply = await this.request(
      extended
        ? Msg.MSG_SMS_GET_STATISTICS_EX_REQ
        : Msg.MSG_SMS_GET_STATISTICS_REQ,
      new Uint8Array(0),
      extended
        ? Msg.MSG_SMS_GET_STATISTICS_EX_RES
        : Msg.MSG_SMS_GET_STATISTICS_RES,
    );
    this.statisticsAt = performance.now();
    return this.handleStatistics(reply);
  }
  private handleStatistics(reply: Message): Statistics {
    const extended = reply.type === Msg.MSG_SMS_GET_STATISTICS_EX_RES;
    // MSG_SMS_GET_STATISTICS_EX_RES starts with sms_msg_statistics_info.request_result.
    const statistics = parseIsdbtStatistics(
      extended ? reply.payload.subarray(4) : reply.payload,
      extended,
    );
    this.statistics = statistics;
    this.status = statistics.demodLocked
      ? "locked"
      : statistics.rfLocked
        ? "signal"
        : "no-signal";
    return statistics;
  }
  /** Messages delivered outside a request (smsdvb_onresponse()). Returns true when consumed. */
  handleMessage(message: Message): boolean {
    switch (message.type) {
      case Msg.MSG_SMS_SIGNAL_DETECTED_IND:
        this.status = "locked";
        return true;
      case Msg.MSG_SMS_NO_SIGNAL_IND:
        this.status = "no-signal";
        return true;
      case Msg.MSG_SMS_GET_STATISTICS_RES:
      case Msg.MSG_SMS_GET_STATISTICS_EX_RES:
        try {
          this.handleStatistics(message);
        } catch {
          return false;
        }
        return true;
      case Msg.MSG_SMS_ISDBT_TUNE_RES:
      case Msg.MSG_SMS_RF_TUNE_RES:
      case Msg.MSG_SMS_ADD_PID_FILTER_RES:
      case Msg.MSG_SMS_REMOVE_PID_FILTER_RES:
        return true;
    }
    return false;
  }
  /** Poll statistics until the demodulator locks. */
  async waitLock(timeoutMs = 2000, intervalMs = 100): Promise<Statistics> {
    const start = performance.now();
    let statistics = await this.readStatistics();
    while (!statistics.demodLocked && performance.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      statistics = await this.readStatistics();
    }
    return statistics;
  }
  static isIsdbtMode(mode: number): boolean {
    return mode === DeviceMode.ISDBT || mode === DeviceMode.ISDBT_BDA;
  }
}
