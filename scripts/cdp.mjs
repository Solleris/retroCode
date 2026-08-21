/**
 * A minimal CDP driver to exercise the real UI.
 *
 * The tool that was missing: without being able to evaluate JS in the renderer
 * and dispatch clicks, every "it works" was inference from the daemon's log —
 * and that is exactly why broken UI slipped through several times.
 *
 * usage: node scripts/cdp.mjs '<js expression>'
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page; is the app running with --remote-debugging-port?"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push("[EXCEPTION] " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  }
});

const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

// screenshot mode: node scripts/cdp.mjs --shot /path.png
if (process.argv[2] === "--shot") {
  await send("Page.enable");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[3], Buffer.from(shot.result.data, "base64"));
  console.log("screenshot:", process.argv[3]);
  ws.close();
  process.exit(0);
}

const expr = process.argv[2];
const r = await send("Runtime.evaluate", {
  expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
});

if (r.result?.exceptionDetails) {
  console.log("EXCEPTION:", r.result.exceptionDetails.exception?.description
    ?? r.result.exceptionDetails.text);
} else {
  const v = r.result?.result?.value;
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
await new Promise((r) => setTimeout(r, 400));
if (logs.length) console.log("--- console ---\n" + logs.join("\n"));
ws.close();
