import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { FrameParser, encodeControl, encodePty, KIND_CONTROL, KIND_PTY }
  from "../../protocol/src/frame.ts";

export function connect() {
  // RETRO_SOCKET first, same precedence as paths.ts: a test that wants an
  // isolated daemon has to be able to point at its socket.
  const path = process.env.RETRO_SOCKET
    ?? join(process.env.RETRO_HOME ?? join(homedir(), ".retro"), "retrod.sock");
  const sock = net.createConnection(path);
  const parser = new FrameParser();
  const handlers = { control: [], pty: [] };
  sock.on("data", (c) => {
    for (const f of parser.push(c)) {
      if (f.kind === KIND_CONTROL) handlers.control.forEach((h) => h(f.json));
      else handlers.pty.forEach((h) => h(f.ptyId, f.data));
    }
  });
  return {
    sock,
    send: (o) => sock.write(encodeControl(o)),
    type: (id, s) => sock.write(encodePty(id, Buffer.from(s))),
    onControl: (h) => handlers.control.push(h),
    onPty: (h) => handlers.pty.push(h),
    close: () => sock.destroy(),
    ready: () => new Promise((r) => sock.once("connect", r)),
  };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
