import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 4;
const num = (v) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
const clean = (s) => String(s || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14) || "Petani";

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("GreenLife Mabar room", { status: 426 });
    const url = new URL(request.url);
    const wantHost = url.searchParams.get("host") === "1";
    const socks = this.ctx.getWebSockets().filter((w) => w.deserializeAttachment());
    const hasHost = socks.some((w) => w.deserializeAttachment().host);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const refuse = (m) => {
      server.send(JSON.stringify({ t: "err", m }));
      server.close(1000, "refused");
    };
    if (!wantHost && !hasHost) refuse("Ruangan tidak ditemukan atau tuan rumah belum membuka desa.");
    else if (wantHost && hasHost) refuse("Kode ini sedang dipakai. Buka desa lagi untuk mendapat kode baru.");
    else if (socks.length >= MAX_PLAYERS) refuse("Ruangan penuh (maksimal " + MAX_PLAYERS + " pemain).");
    else {
      const me = { id: crypto.randomUUID().slice(0, 6), name: clean(url.searchParams.get("name")), host: wantHost };
      server.serializeAttachment(me);
      const players = socks.map((w) => w.deserializeAttachment()).filter(Boolean);
      server.send(JSON.stringify({ t: "welcome", id: me.id, players }));
      this.broadcast(server, { t: "join", id: me.id, name: me.name, host: me.host });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(except, obj) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try { w.send(s); } catch (_) {}
    }
  }

  webSocketMessage(ws, msg) {
    const me = ws.deserializeAttachment();
    if (!me || typeof msg !== "string" || msg.length > 400) return;
    let d;
    try { d = JSON.parse(msg); } catch (_) { return; }
    if (d.t === "pos") this.broadcast(ws, { t: "pos", id: me.id, x: num(d.x), y: num(d.y), z: num(d.z), r: num(d.r), m: d.m ? 1 : 0 });
  }

  gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (me.host) {
      this.broadcast(ws, { t: "end" });
      for (const w of this.ctx.getWebSockets()) if (w !== ws) { try { w.close(1000, "host left"); } catch (_) {} }
    } else this.broadcast(ws, { t: "leave", id: me.id, name: me.name });
  }
  webSocketClose(ws) { this.gone(ws); try { ws.close(); } catch (_) {} }
  webSocketError(ws) { this.gone(ws); }
}

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(/^\/room\/([A-Za-z0-9-]{4,12})$/);
    if (!m) return new Response("GreenLife Mabar OK");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
    return stub.fetch(request);
  },
};
