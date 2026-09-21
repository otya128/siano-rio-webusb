/** Structural subset of WebUSB; native USBDevice and test doubles both fit. */
export interface UsbEndpoint {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
}
export interface UsbAlternate {
  readonly alternateSetting: number;
  readonly endpoints: readonly UsbEndpoint[];
}
export interface UsbConfiguration {
  readonly configurationValue: number;
  readonly interfaces: readonly {
    readonly interfaceNumber: number;
    readonly alternates: readonly UsbAlternate[];
  }[];
}
export interface UsbDevice {
  readonly opened: boolean;
  readonly productName?: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly configuration: UsbConfiguration | null;
  readonly configurations: readonly UsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  selectAlternateInterface(number: number, alternate: number): Promise<void>;
  releaseInterface(number: number): Promise<void>;
  transferOut(
    endpoint: number,
    data: BufferSource,
  ): Promise<{ status: string; bytesWritten: number }>;
  transferIn(
    endpoint: number,
    length: number,
  ): Promise<{ status: string; data?: DataView }>;
}
export interface DeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}
export interface UsbAccess {
  requestDevice(options: { filters: DeviceFilter[] }): Promise<UsbDevice>;
  getDevices(): Promise<UsbDevice[]>;
}
export function browserUsb(): UsbAccess {
  const usb = (
    globalThis.navigator as (Navigator & { usb?: UsbAccess }) | undefined
  )?.usb;
  if (!usb)
    throw new Error(
      "WebUSB is unavailable. Use a WebUSB-capable browser on HTTPS or localhost.",
    );
  return usb;
}
