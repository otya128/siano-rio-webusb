/** Recover 188-byte MPEG-TS packet boundaries across arbitrarily split USB reads. */
export class TsPacketFramer {
  private pending = new Uint8Array(0);
  private synced = false;
  droppedBytes = 0;
  push(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(this.pending.length + chunk.length);
    data.set(this.pending);
    data.set(chunk, this.pending.length);
    const packets: Uint8Array[] = [];
    let pos = 0;
    while (data.length - pos >= 188) {
      if (!this.synced) {
        // Three sync bytes prevent locking onto random payload bytes.
        if (data.length - pos < 377) break;
        if (
          data[pos] !== 0x47 ||
          data[pos + 188] !== 0x47 ||
          data[pos + 376] !== 0x47
        ) {
          pos++;
          this.droppedBytes++;
          continue;
        }
        this.synced = true;
      }
      if (data[pos] !== 0x47) {
        this.synced = false;
        continue;
      }
      packets.push(data.subarray(pos, pos + 188));
      pos += 188;
    }
    this.pending = data.slice(pos);
    const output = new Uint8Array(packets.length * 188);
    packets.forEach((packet, i) => output.set(packet, i * 188));
    return output;
  }
}
