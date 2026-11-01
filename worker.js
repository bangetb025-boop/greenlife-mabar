import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 4;
const TTL = 30 * 24 * 3600 * 1000; // dunia dihapus kalau 30 hari tidak dikunjungi
const SAVE_EVERY = 5000;
const num = (v) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
const clean = (s) => String(s || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14) || "Petani";
const att = (w) => w.deserializeAttachment();

export class Room extends DurableObject {
  liveSocks() { return this.ctx.getWebSockets().filter((w) => att(w)); }

  async getWorld() {
    if (this.world === undefined) this.world = (await this.ctx.storage.get("world")) || null;
    return this.world;
  }
  async putWorld(force) {
    if (!this.world) return;
    const now = Date.now();
    if (!force && this.lastPut && now - this.lastPut < SAVE_EVERY) return;
    this.lastPut = now;
    await this.ctx.storage.put("world", this.world);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const created = await this.ctx.storage.get("created");
    if (request.headers.get("Upgrade") !== "websocket") {
      if (url.searchParams.get("info") === "1") {
        const w = await this.getWorld();
        const lv = this.liveSocks();
        return new Response(JSON.stringify({ v: 8, created: !!created, hasWorld: !!w, ageSec: w && w.at ? Math.round((Date.now() - w.at) / 1000) : null, host: lv.some((s) => att(s).host), players: lv.map((s) => att(s).name) }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      return new Response("GreenLife Mabar room", { status: 426 });
    }
    const mode = url.searchParams.get("mode") === "create" ? "create" : "join";
    const live = this.liveSocks();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const refuse = (m) => { server.send(JSON.stringify({ t: "err", m })); server.close(1000, "refused"); };

    if (mode === "create" && created) refuse("Kode ini sudah dipakai desa lain. Buat desa baru lagi untuk mendapat kode lain.");
    else if (mode === "join" && !created) refuse("Desa mabar dengan kode ini tidak ditemukan. Periksa kodenya.");
    else if (live.length >= MAX_PLAYERS) refuse("Desa penuh (maksimal " + MAX_PLAYERS + " pemain).");
    else {
      if (!created) await this.ctx.storage.put("created", Date.now());
      const world = await this.getWorld();
      const hasHost = live.some((w) => att(w).host);
      const me = { id: crypto.randomUUID().slice(0, 6), name: clean(url.searchParams.get("name")), host: !hasHost, at: Date.now() };
      server.serializeAttachment(me);
      const away = !live.length && world && world.at ? Date.now() - world.at : 0;
      server.send(JSON.stringify({ t: "welcome", id: me.id, host: me.host, players: live.map(att), world: world ? { p: world.p, w: world.w } : null, away, v: 8 }));
      this.broadcast(server, { t: "join", id: me.id, name: me.name, host: me.host });
      await this.ctx.storage.setAlarm(Date.now() + TTL);
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

  async alarm() {
    if (this.liveSocks().length) { await this.ctx.storage.setAlarm(Date.now() + TTL); return; }
    await this.ctx.storage.deleteAll();
    this.world = undefined;
  }

  async webSocketMessage(ws, msg) {
    const me = att(ws);
    if (!me || typeof msg !== "string" || msg.length > 4000) return;
    let d;
    try { d = JSON.parse(msg); } catch (_) { return; }
    if (d.t === "pos" && msg.length <= 400) {
      this.broadcast(ws, { t: "pos", id: me.id, n: me.name, h: me.host ? 1 : 0, x: num(d.x), y: num(d.y), z: num(d.z), r: num(d.r), m: d.m ? 1 : 0, s: num(d.s), a: typeof d.a === "string" ? d.a.slice(0, 12) : "" });
    } else if (d.t === "plot") {
      if (!Array.isArray(d.a) || d.a.length > 6) return;
      const i = num(d.i) | 0;
      if (i >= 0 && i < 200) {
        const w = (await this.getWorld()) || (this.world = { p: [], w: null, at: 0 });
        w.p[i] = d.a; w.at = Date.now();
        await this.putWorld(false);
      }
      this.broadcast(ws, { t: "plot", id: me.id, i, a: d.a });
    } else if (d.t === "mach") {
      // mesin dibeli pemain mana pun: jadi milik dunia, tidak bisa dihapus lagi
      if (d.k !== "pump" && d.k !== "harv") return;
      const w = (await this.getWorld()) || (this.world = { p: [], w: null, at: 0 });
      w.w = w.w || {}; w.w[d.k] = 1; w.at = Date.now();
      await this.putWorld(true);
      this.broadcast(ws, { t: "mach", id: me.id, k: d.k });
    } else if (d.t === "fill") {
      this.broadcast(ws, { t: "fill", id: me.id, n: Math.max(0, Math.min(40, num(d.n))) });
    } else if ((d.t === "world" || d.t === "full" || d.t === "npc") && me.host) {
      const out = { t: d.t, id: me.id };
      if (d.w && typeof d.w === "object") out.w = { t: num(d.w.t), rain: d.w.rain ? 1 : 0, rin: num(d.w.rin), day: num(d.w.day), pump: d.w.pump ? 1 : 0, harv: d.w.harv ? 1 : 0, fuel: num(d.w.fuel) };
      if (Array.isArray(d.p) && d.p.length <= 80) out.p = d.p;
      if (Array.isArray(d.n) && d.n.length <= 150) out.n = d.n;
      if (d.t !== "npc") {
        const w = (await this.getWorld()) || (this.world = { p: [], w: null, at: 0 });
        if (out.p) w.p = out.p;
        if (out.w) { const pv = w.w || {}; w.w = out.w; w.w.pump = pv.pump || out.w.pump ? 1 : 0; w.w.harv = pv.harv || out.w.harv ? 1 : 0; out.w.pump = w.w.pump; out.w.harv = w.w.harv; }
        w.at = Date.now();
        await this.putWorld(false);
      }
      this.broadcast(ws, out);
    }
  }

  async gone(ws) {
    const me = att(ws);
    if (!me) return;
    const rest = this.liveSocks().filter((w) => w !== ws);
    this.broadcast(ws, { t: "leave", id: me.id, name: me.name });
    if (me.host && rest.length) {
      rest.sort((a, b) => att(a).at - att(b).at);
      const nx = rest[0], a = att(nx);
      a.host = true; nx.serializeAttachment(a);
      try { nx.send(JSON.stringify({ t: "promote" })); } catch (_) {}
      this.broadcast(ws, { t: "hostchg", id: a.id });
    }
    if (this.world) this.world.at = Date.now();
    await this.putWorld(true);
  }
  async webSocketClose(ws) { await this.gone(ws); try { ws.close(); } catch (_) {} }
  async webSocketError(ws) { await this.gone(ws); }
}

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(/^\/room\/([A-Za-z0-9-]{4,12})$/);
    if (!m) return new Response("GreenLife Mabar OK v8");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
    return stub.fetch(request);
  },
};
