// Port of smscoreapi.c device start-up (Siano Mobile Silicon, Uri Shkolnik, Anatoly Greenblat). GPL-2.0-or-later.
import {
  DeviceMode,
  type DeviceModeValue,
  Msg,
  SMS_PROTOCOL_MAX_ROUNDTRIP_MS,
} from "./messages.js";
import {
  downloadChunks,
  firmwareChecksum,
  parseFirmware,
  reloadAddress,
} from "./firmware.js";
import { delay, encodeMessage, ProtocolError, u32le } from "./protocol.js";
import type { WebUsbTransport } from "./transport.js";

/** struct sms_version_res */
export interface VersionInfo {
  /** e.g. 0x2270 for SMS2270 "Rio" */
  chipModel: number;
  step: number;
  metalFix: number;
  /** 255 while the ROM is running, otherwise a DeviceMode value. */
  firmwareId: number;
  /** Bit mask of DeviceMode values the running firmware serves. */
  supportedProtocols: number;
  firmwareVersion: string;
  romVersion: string;
  label: string;
}
export interface DeviceInfo extends VersionInfo {
  /** Mode the device runs after start-up (sms_boards default: ISDBT_BDA for Rio). */
  mode: DeviceModeValue;
  firmwareDownloaded: boolean;
}
export interface StartOptions {
  /** DeviceMode value; sms_boards[SMS1XXX_BOARD_SIANO_RIO].default_mode = ISDBT_BDA. */
  mode?: DeviceModeValue;
  /** Contents of isdbt_rio.inp; required only while the ROM or another mode's firmware is running. */
  firmware?: Uint8Array;
  /** sms_board.mtu / crystal: MSG_SMS_SET_MAX_TX_MSG_LEN_REQ / MSG_SMS_NEW_CRYSTAL_REQ when set. */
  mtu?: number;
  crystal?: number;
  log?: (line: string) => void;
}
const dotted = (bytes: Uint8Array) => Array.from(bytes).join(".");
export function parseVersion(payload: Uint8Array): VersionInfo {
  if (payload.length < 48)
    throw new ProtocolError("Short MSG_SMS_GET_VERSION_EX_RES");
  const view = new DataView(payload.buffer, payload.byteOffset, 48);
  const label = payload.subarray(14, 48);
  const end = label.indexOf(0);
  return {
    chipModel: view.getUint16(0, true),
    step: payload[2],
    metalFix: payload[3],
    firmwareId: payload[4],
    supportedProtocols: payload[5],
    firmwareVersion: dotted(payload.subarray(6, 10)),
    romVersion: dotted(payload.subarray(10, 14)),
    label: new TextDecoder("latin1").decode(
      end < 0 ? label : label.subarray(0, end),
    ),
  };
}
/** smscore_device_t state that outlives a single request. */
export class SmsCore {
  mode: DeviceModeValue = DeviceMode.NONE;
  modesSupported = 0;
  /** rom_ver_major << 8 | rom_ver_minor; selects the statistics request. */
  fwVersion = 0;
  version?: VersionInfo;
  constructor(
    readonly transport: WebUsbTransport,
    private readonly log?: (line: string) => void,
  ) {}
  private request(
    type: number,
    payload: Uint8Array | ArrayLike<number>,
    responseType: number,
    timeoutMs = SMS_PROTOCOL_MAX_ROUNDTRIP_MS,
  ) {
    return this.transport.request(
      encodeMessage(type, payload),
      responseType,
      timeoutMs,
    );
  }
  /** smscore_detect_mode(): MSG_SMS_GET_VERSION_EX_REQ, retried once after a resume indication. */
  async detectMode(): Promise<VersionInfo> {
    const send = () =>
      this.request(
        Msg.MSG_SMS_GET_VERSION_EX_REQ,
        [],
        Msg.MSG_SMS_GET_VERSION_EX_RES,
      );
    let reply;
    try {
      reply = await send();
    } catch (error) {
      if (this.transport.closed) throw error;
      this.log?.("MSG_SMS_GET_VERSION_EX_REQ failed first try");
      await this.transport.waitFor(Msg.MSG_SMS_SLEEP_RESUME_COMP_IND, 5000)
        .message;
      reply = await send();
    }
    const version = parseVersion(reply.payload);
    this.log?.(
      `Firmware id ${version.firmwareId} prots 0x${version.supportedProtocols.toString(16)} ver ${version.romVersion}`,
    );
    this.mode =
      version.firmwareId === 255
        ? DeviceMode.NONE
        : (version.firmwareId as DeviceModeValue);
    this.modesSupported = version.supportedProtocols;
    const [major, minor] = version.romVersion.split(".").map(Number);
    this.fwVersion = (major << 8) | minor;
    this.version = version;
    return version;
  }
  /** smscore_load_firmware_family2() */
  async loadFirmware(image: Uint8Array): Promise<void> {
    const firmware = parseFirmware(image);
    let memAddress = firmware.startAddress;
    this.log?.(
      `loading FW to addr 0x${memAddress.toString(16)} size ${firmware.length}`,
    );
    if (this.mode !== DeviceMode.NONE) {
      this.log?.("sending reload command.");
      await this.request(
        Msg.MSG_SW_RELOAD_START_REQ,
        [],
        Msg.MSG_SW_RELOAD_START_RES,
      );
      memAddress = reloadAddress(firmware);
    }
    for (const chunk of downloadChunks(firmware, memAddress))
      await this.request(
        Msg.MSG_SMS_DATA_DOWNLOAD_REQ,
        chunk,
        Msg.MSG_SMS_DATA_DOWNLOAD_RES,
      );
    this.log?.(
      `sending MSG_SMS_DATA_VALIDITY_REQ expecting 0x${firmwareChecksum(firmware).toString(16)}`,
    );
    const validity = await this.request(
      Msg.MSG_SMS_DATA_VALIDITY_REQ,
      u32le(firmware.startAddress, firmware.length, 0),
      Msg.MSG_SMS_DATA_VALIDITY_RES,
    );
    if (validity.payload.length >= 4)
      this.log?.(
        `MSG_SMS_DATA_VALIDITY_RES, checksum = 0x${new DataView(validity.payload.buffer, validity.payload.byteOffset).getUint32(0, true).toString(16)}`,
      );
    if (this.mode === DeviceMode.NONE) {
      this.log?.("sending MSG_SMS_SWDOWNLOAD_TRIGGER_REQ");
      await this.request(
        Msg.MSG_SMS_SWDOWNLOAD_TRIGGER_REQ,
        // entry point, priority, stack size, parameter, task id
        u32le(firmware.startAddress, 6, 0x200, 0, 4),
        Msg.MSG_SMS_SWDOWNLOAD_TRIGGER_RES,
      );
    } else {
      await this.transport.send(encodeMessage(Msg.MSG_SW_RELOAD_EXEC_REQ));
    }
    // backward compatibility - wait to device_ready_done for not more than 400 ms
    await delay(400);
  }
  /** smscore_init_device() */
  initDevice(mode: DeviceModeValue): Promise<unknown> {
    return this.request(
      Msg.MSG_SMS_INIT_DEVICE_REQ,
      u32le(mode),
      Msg.MSG_SMS_INIT_DEVICE_RES,
    );
  }
  /** smscore_set_device_mode() for SMS_DEVICE_FAMILY2. */
  async setDeviceMode(
    mode: DeviceModeValue,
    firmware?: Uint8Array,
  ): Promise<{ firmwareDownloaded: boolean }> {
    if (mode <= DeviceMode.NONE || mode >= DeviceMode.MAX)
      throw new RangeError(`invalid mode specified ${mode}`);
    await this.detectMode();
    if (this.mode === mode) {
      this.log?.(`device mode ${mode} already set`);
      return { firmwareDownloaded: false };
    }
    let firmwareDownloaded = false;
    if (!(this.modesSupported & (1 << mode))) {
      if (!firmware)
        throw new Error(
          `Device runs ${this.mode === DeviceMode.NONE ? "the ROM" : `mode ${this.mode}`} and needs a firmware image (isdbt_rio.inp) for mode ${mode}`,
        );
      await this.loadFirmware(firmware);
      firmwareDownloaded = true;
      this.log?.("firmware download success");
    } else {
      this.log?.(`mode ${mode} is already supported by running firmware`);
    }
    if (this.fwVersion >= 0x800) await this.initDevice(mode);
    this.mode = mode;
    // smscore_set_device_mode() always finishes with a second MSG_SMS_INIT_DEVICE_REQ.
    await this.initDevice(mode);
    return { firmwareDownloaded };
  }
  /** smscore_configure_board(): these two are sent without waiting for a reply. */
  async configureBoard(options: StartOptions): Promise<void> {
    if (options.mtu)
      await this.transport.send(
        encodeMessage(Msg.MSG_SMS_SET_MAX_TX_MSG_LEN_REQ, u32le(options.mtu)),
      );
    if (options.crystal)
      await this.transport.send(
        encodeMessage(Msg.MSG_SMS_NEW_CRYSTAL_REQ, u32le(options.crystal)),
      );
  }
  /** smscore_start_device() */
  async start(options: StartOptions = {}): Promise<DeviceInfo> {
    const mode = options.mode ?? DeviceMode.ISDBT_BDA;
    const { firmwareDownloaded } = await this.setDeviceMode(
      mode,
      options.firmware,
    );
    await this.configureBoard(options);
    if (firmwareDownloaded) {
      // Not done upstream; refreshes the reported ids so they describe the firmware now running.
      await this.detectMode();
      this.mode = mode;
    }
    return { ...this.version!, mode, firmwareDownloaded };
  }
}
