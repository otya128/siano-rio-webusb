// Scatter format from it9175_loadFW, (c) 2015-2016 trinity19683. GPL-3.0-only.
/** Parse fully before writing anything; descriptors are forward, data are reversed. */
export function firmwarePackets(image: Uint8Array): Uint8Array[] {
  let offset = 0;
  const packets: Uint8Array[] = [];
  const requireBytes = (n: number) => {
    if (offset + n > image.length) throw new Error("Truncated firmware image");
  };
  do {
    requireBytes(1);
    const bank = image[offset++];
    let blocks: { address: number; data: Uint8Array }[] = [];
    let used = 0;
    const flush = () => {
      if (!blocks.length) return;
      const packet = new Uint8Array(4 + used);
      packet.set([3, bank, 0, blocks.length]);
      blocks.forEach((block, i) =>
        packet.set(
          [block.address >> 8, block.address & 255, block.data.length],
          4 + i * 3,
        ),
      );
      let p = 4 + blocks.length * 3;
      for (const block of [...blocks].reverse()) {
        packet.set(block.data, p);
        p += block.data.length;
      }
      packets.push(packet);
      blocks = [];
      used = 0;
    };
    while (true) {
      requireBytes(2);
      const length = (image[offset] << 8) | image[offset + 1];
      offset += 2;
      if (length === 0) {
        flush();
        break;
      }
      requireBytes(2 + length);
      const address = (image[offset] << 8) | image[offset + 1];
      offset += 2;
      if (address + length > 0x10000)
        throw new Error("Firmware block exceeds bank");
      for (let i = 0; i < length;) {
        if (44 - used <= 3 || blocks.length === 3) flush();
        const count = Math.min(length - i, 44 - used - 3);
        blocks.push({
          address: address + i,
          data: image.slice(offset + i, offset + i + count),
        });
        i += count;
        used += count + 3;
        if (used === 44 || blocks.length === 3) flush();
      }
      offset += length;
    }
    requireBytes(1);
  } while (image[offset] !== 0);
  if (offset !== image.length - 1) throw new Error("Trailing firmware data");
  if (!packets.length) throw new Error("Empty firmware image");
  return packets;
}
