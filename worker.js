import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 4;
const GRACE = 60000; // tuan rumah boleh terputus 60 detik tanpa membubarkan ruangan
const num = (v) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
const clean = (s) => String(s || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14) || "Petani";

export class Room extends DurableObject {
  liveSocks() {
    return this.ctx.getWebSockets().filter((w) => { const a = w.deserializeAttachment(); return a && !a.replaced; });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      if (url.searchParams.get("info") === "1") {
        const lv = this.liveSocks();
        const hg0 = (await this.ctx.storage.get("hg")) || 0;
        return new Response(JSON.stringify({ v: 5, host: lv.some((w) => w.deserializeAttachment().host), grace: !!(hg0 && Date.now() - hg0 < GRACE), players: lv.map((w) => w.deserializeAttachment().name) }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      return new Response("GreenLife Mabar room", { status: 426 });
    }
    const wantHost = url.searchParams.get("host") === "1";
    const resume = url.searchParams.get("resume") || "";
    const live = this.liveSocks();
    const hostSock = live.find((w) => w.deserializeAttachment().host);
    const hg = (await this.ctx.storage.get("hg")) || 0;
    const hk = await this.ctx.storage.get("hk");
    const grace = !hostSock && hg && Date.now() - hg < GRACE;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const refuse = (m) => { server.send(JSON.stringify({ t: "err", m })); server.close(1000, "refused"); };

    if (wantHost) {
      const resuming = !!(resume && hk && resume === hk);
      if (hostSock && !resuming) refuse("Kode ini sedang dipakai. Buka desa lagi untuk mendapat kode baru.");
      else if (!hostSock && hk && !resuming && grace) refuse("Kode ini baru saja dipakai tuan rumah lain. Pakai kode baru.");
      else {
        if (hostSock && resuming) {
          const a = hostSock.deserializeAttachment(); a.replaced = true; hostSock.serializeAttachment(a);
          try { hostSock.close(1000, "replaced"); } catch (_) {}
        }
        let id = resuming ? await this.ctx.storage.get("hid") : null;
        let key = resuming ? hk : null;
        if (!id) { id = crypto.randomUUID().slice(0, 6); key = crypto.randomUUID(); await this.ctx.storage.put("hid", id); await this.ctx.storage.put("hk", key); }
        const me = { id, name: clean(url.searchParams.get("name")), host: true };
        server.serializeAttachment(me);
        await this.ctx.storage.delete("hg");
        await this.ctx.storage.deleteAlarm();
        const players = live.filter((w) => !w.deserializeAttachment().host).map((w) => w.deserializeAttachment());
        server.send(JSON.stringify({ t: "welcome", id: me.id, key, players, v: 5 }));
        this.broadcast(server, { t: "hostback" });
        this.broadcast(server, { t: "join", id: me.id, name: me.name, host: true });
      }
    } else if (!hostSock && !grace) refuse("Ruangan tidak ditemukan atau tuan rumah belum membuka desa.");
    else if (live.length >= MAX_PLAYERS) refuse("Ruangan penuh (maksimal " + MAX_PLAYERS + " pemain).");
    else {
      const me = { id: crypto.randomUUID().slice(0, 6), name: clean(url.searchParams.get("name")), host: false };
      server.serializeAttachment(me);
      server.send(JSON.stringify({ t: "welcome", id: me.id, players: live.map((w) => w.deserializeAttachment()), hostAway: !hostSock, v: 5 }));
      this.broadcast(server, { t: "join", id: me.id, name: me.name, host: false });
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

  async endRoom() {
    this.broadcast(null, { t: "end" });
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, "end"); } catch (_) {} }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    if (this.liveSocks().some((w) => w.deserializeAttachment().host)) return;
    await this.endRoom();
  }

  async webSocketMessage(ws, msg) {
    const me = ws.deserializeAttachment();
    if (!me || me.replaced || typeof msg !== "string" || msg.length > 4000) return;
    let d;
    try { d = JSON.parse(msg); } catch (_) { return; }
    if (d.t === "pos" && msg.length <= 400) {
      this.broadcast(ws, { t: "pos", id: me.id, n: me.name, h: me.host ? 1 : 0, x: num(d.x), y: num(d.y), z: num(d.z), r: num(d.r), m: d.m ? 1 : 0 });
    } else if (d.t === "plot") {
      if (Array.isArray(d.a) && d.a.length <= 6) this.broadcast(ws, { t: "plot", id: me.id, i: num(d.i) | 0, a: d.a });
    } else if ((d.t === "world" || d.t === "full") && me.host) {
      const out = { t: d.t, id: me.id };
      if (d.w && typeof d.w === "object") out.w = { t: num(d.w.t), rain: d.w.rain ? 1 : 0, rin: num(d.w.rin), day: num(d.w.day) };
      if (Array.isArray(d.p) && d.p.length <= 80) out.p = d.p;
      if (typeof d.to === "string") {
        const s = JSON.stringify(out);
        for (const w of this.ctx.getWebSockets()) {
          const a = w.deserializeAttachment();
          if (a && !a.replaced && a.id === d.to) { try { w.send(s); } catch (_) {} }
        }
      } else this.broadcast(ws, out);
    } else if (d.t === "bye" && me.host) {
      await this.endRoom();
    }
  }

  async gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me || me.replaced) return;
    if (me.host) {
      await this.ctx.storage.put("hg", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + GRACE);
      this.broadcast(ws, { t: "hostgone" });
    } else this.broadcast(ws, { t: "leave", id: me.id, name: me.name });
  }
  async webSocketClose(ws) { await this.gone(ws); try { ws.close(); } catch (_) {} }
  async webSocketError(ws) { await this.gone(ws); }
}

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(/^\/room\/([A-Za-z0-9-]{4,12})$/);
    if (!m) return new Response("GreenLife Mabar OK v5");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
    return stub.fetch(request);
  },
};
