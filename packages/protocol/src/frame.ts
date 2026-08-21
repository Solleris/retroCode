/**
 * Frame codec for the Retro socket.
 *
 * Two frame kinds share the same socket, deliberately:
 *
 *   CONTROL  header + JSON       — readable, debuggable with `socat`
 *   PTY      header + id + bytes — hot path, no base64
 *
 * A noisy build dumps megabytes per second. Pushing that through JSON would
 * cost ~33% for base64 plus the parse, which is why pty bytes get their own
 * frame. The control channel stays JSON because being readable while
 * debugging is worth more than the microseconds.
 *
 * Layout:  [kind:u8][len:u32be][payload:len]
 *   kind=0  payload = utf8 JSON
 *   kind=1  payload = [idLen:u16be][id:utf8][data:...]
 */

export const KIND_CONTROL = 0;
export const KIND_PTY = 1;

const HEADER = 5;
/** Refuse absurd frames before allocating — a corrupt socket must not become an OOM. */
const MAX_PAYLOAD = 64 * 1024 * 1024;

export type Frame =
  | { kind: typeof KIND_CONTROL; json: unknown }
  | { kind: typeof KIND_PTY; ptyId: string; data: Buffer };

export function encodeControl(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.allocUnsafe(HEADER);
  head.writeUInt8(KIND_CONTROL, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export function encodePty(ptyId: string, data: Buffer): Buffer {
  const id = Buffer.from(ptyId, "utf8");
  const head = Buffer.allocUnsafe(HEADER + 2);
  head.writeUInt8(KIND_PTY, 0);
  head.writeUInt32BE(2 + id.length + data.length, 1);
  head.writeUInt16BE(id.length, HEADER);
  return Buffer.concat([head, id, data]);
}

/**
 * Accumulates socket chunks and emits complete frames.
 *
 * A socket hands over arbitrary boundaries: one frame may arrive in five
 * chunks, or five frames in a single one. This class is the only thing
 * between that and the rest of the system, so it is deliberately boring and
 * testable.
 */
export class FrameParser {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: Frame[] = [];

    for (;;) {
      if (this.#buf.length < HEADER) break;
      const kind = this.#buf.readUInt8(0);
      const len = this.#buf.readUInt32BE(1);

      if (len > MAX_PAYLOAD) throw new Error(`frame of ${len} bytes exceeds the cap`);
      if (this.#buf.length < HEADER + len) break;

      const payload = this.#buf.subarray(HEADER, HEADER + len);
      this.#buf = this.#buf.subarray(HEADER + len);

      if (kind === KIND_CONTROL) {
        out.push({ kind: KIND_CONTROL, json: JSON.parse(payload.toString("utf8")) });
      } else if (kind === KIND_PTY) {
        const idLen = payload.readUInt16BE(0);
        out.push({
          kind: KIND_PTY,
          ptyId: payload.subarray(2, 2 + idLen).toString("utf8"),
          // copy: the subarray points into the accumulator, which gets recycled
          data: Buffer.from(payload.subarray(2 + idLen)),
        });
      } else {
        throw new Error(`unknown frame kind: ${kind}`);
      }
    }
    return out;
  }
}
