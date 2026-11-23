// SodDrop party server: Cloudflare Worker + one Durable Object per party code.
//
//   POST/ANY  /party/<CODE>/ws   WebSocket upgrade -> room <CODE>
//   GET       /health            liveness check
//   *                            static assets (index.html, audio/, ...)
//
// Bindings (see wrangler.toml): PARTY (Durable Object), ASSETS (static site).

const MAX_PLAYERS = 10;
const MAX_MESSAGE = 1400;

const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clean = name =>
  typeof name === 'string' ? name.replace(/[^\w \-.]/g, '').trim().slice(0, 12) : '';

export class Party {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.members = new Map(); // id -> {id,name,ready,host,alive,ws}
    this.phase = 'lobby'; // lobby | countdown | playing
    this.mode = 1; // team size: 1 solo, 2 duo, 3 trio, 4 squad
    this.endsAt = 0;
    this.timer = null;
    this.code = '';
    this.countdownMs = Math.max(500, Number((env && env.COUNTDOWN_MS) || 5000));
  }

  fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('websocket required', { status: 426 });
    if (this.members.size >= MAX_PLAYERS) return new Response('party full', { status: 409 });
    if (!this.code) {
      const url = new URL(req.url);
      this.code = (url.searchParams.get('code') || '').toUpperCase().slice(0, 8);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Registers a socket as a party member and greets it with the current room state.
  attach(ws) {
    ws.accept();
    const id = 'p' + Math.random().toString(36).slice(2, 10);
    const member = {
      id,
      name: 'Player',
      ready: false,
      host: this.members.size === 0,
      alive: true,
      ws,
    };
    this.members.set(id, member);
    ws.addEventListener('message', ev => {
      try {
        this.onMessage(member, ev.data);
      } catch (e) {
        /* malformed traffic is ignored */
      }
    });
    ws.addEventListener('close', () => this.onClose(member));
    ws.addEventListener('error', () => this.onClose(member));
    this.tell(member, {
      t: 'welcome',
      id,
      code: this.code,
      phase: this.phase,
      mode: this.mode,
      endsAt: this.endsAt,
      members: this.roster(),
    });
    this.broadcast();
    return member;
  }

  onMessage(member, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let m;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello':
      case 'name': {
        const n = clean(m.name);
        if (n) member.name = n;
        if (m.t === 'hello') member.ready = false;
        this.broadcast();
        break;
      }
      case 'mode': {
        // Only the host picks the team size; everyone else follows the broadcast.
        if (member.host) this.mode = clamp(Math.round(Number(m.v) || 1), 1, 4);
        this.broadcast();
        break;
      }
      case 'ready': {
        member.ready = !!m.v;
        this.maybeCountdown();
        this.broadcast();
        break;
      }
      case 'start': {
        if (member.host) this.begin();
        break;
      }
      case 'pos': {
        member.alive = m.alive !== false;
        this.relay(member, {
          t: 'state',
          id: member.id,
          name: member.name,
          x: num(m.x),
          y: num(m.y),
          z: num(m.z),
          yaw: num(m.yaw),
          st: typeof m.st === 'string' ? m.st.slice(0, 8) : 'ground',
          hp: num(m.hp),
          alive: member.alive,
        });
        break;
      }
      // a shot fired somewhere in the match: other clients pan it from the muzzle position
      case 'shot': {
        this.relay(member, {
          t: 'shot',
          w: typeof m.w === 'string' ? m.w.slice(0, 10) : 'ar',
          x: num(m.x), y: num(m.y), z: num(m.z),
        });
        break;
      }
      case 'hit': {
        const target = this.members.get(m.target);
        if (target && target !== member && member.alive)
          this.tell(target, {
            t: 'hit',
            dmg: clamp(num(m.dmg) || 10, 1, 45),
            head: !!m.head,
            from: member.name,
          });
        break;
      }
      // ---- shared match state: host-authoritative bots and player-built structures ----
      case 'bs': {
        // compact bot snapshot from the host: [[id,team,x,y,z,yaw,state,hp,weapon,alive],...]
        if (!Array.isArray(m.a) || m.a.length > 14) return;
        this.relay(member, { t: 'bs', a: m.a });
        break;
      }
      case 'build': {
        if (typeof m.i !== 'string' || ['w', 'f', 'r'].indexOf(m.k) < 0) return;
        this.relay(member, {
          t: 'build',
          i: m.i.slice(0, 24),
          k: m.k,
          x: num(m.x), y: num(m.y), z: num(m.z),
          yw: num(m.yw),
          tm: clamp(Math.round(Number(m.tm) || 1), 1, 6),
        });
        break;
      }
      case 'sdam':
        this.relay(member, { t: 'sdam', i: String(m.i).slice(0, 24), d: clamp(num(m.d) || 0, 0, 400) });
        break;
      case 'sdel':
        this.relay(member, { t: 'sdel', i: String(m.i).slice(0, 24) });
        break;
      case 'bhit':
        this.relay(member, {
          t: 'bhit',
          id: Math.round(Number(m.id) || 0),
          d: clamp(num(m.d) || 1, 1, 70),
          from: member.name,
        });
        break;
      // leaving mid-match: out of the round, but still in the party (and can ready up again)
      case 'leave': {
        member.alive = false;
        if (member.host) {
          const next = [...this.members.values()].find(m => m !== member);
          if (next) {
            next.host = true;
            member.host = false;
          }
        }
        this.relay(member, { t: 'died', id: member.id, name: member.name });
        this.broadcast();
        this.maybeReset();
        break;
      }
      case 'died': {
        if (member.alive) {
          member.alive = false;
          this.relay(member, { t: 'died', id: member.id, name: member.name });
          this.broadcast();
          this.maybeReset();
        }
        break;
      }
      case 'tolobby': {
        // Any member can end the round: the party goes back to the lobby for everyone.
        if (this.phase !== 'lobby') this.toLobby();
        this.announceLobby(member.name);
        break;
      }
    }
  }

  onClose(member) {
    if (!this.members.has(member.id)) return;
    this.members.delete(member.id);
    if (member.host) {
      const next = this.members.values().next().value;
      if (next) next.host = true;
    }
    if (this.phase === 'countdown') this.toLobby();
    else this.broadcast();
  }

  roster() {
    const mode = this.mode || 1;
    return [...this.members.values()].map((m, i) => ({
      id: m.id,
      name: m.name,
      ready: m.ready,
      host: m.host,
      alive: m.alive,
      team: 1, // a party is one squad: every member shares the same team id
      mode,
    }));
  }

  tell(member, msg) {
    try {
      member.ws.send(JSON.stringify(msg));
    } catch (e) {}
  }

  relay(from, msg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m === from) continue;
      try {
        m.ws.send(data);
      } catch (e) {}
    }
  }

  broadcast() {
    const msg = JSON.stringify({
      t: 'roster',
      members: this.roster(),
      phase: this.phase,
      mode: this.mode,
      endsAt: this.endsAt,
    });
    for (const m of this.members.values()) {
      try {
        m.ws.send(msg);
      } catch (e) {}
    }
  }

  // Everyone in the party is ready -> run the shared countdown.
  maybeCountdown() {
    if (this.phase !== 'lobby' || !this.members.size) return;
    for (const m of this.members.values()) if (!m.ready) return;
    this.phase = 'countdown';
    this.endsAt = Date.now() + this.countdownMs;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.begin(), this.countdownMs);
    this.broadcast();
    this.announceCountdown();
  }

  // Tells every client the room is back in the lobby, so nobody stays stuck in a match.
  announceLobby(by) {
    const msg = JSON.stringify({ t: 'tolobby', by: by || '' });
    for (const m of this.members.values()) {
      try {
        m.ws.send(msg);
      } catch (e) {}
    }
  }

  // Dedicated ping so clients can run the number ticker even if they miss a roster.
  announceCountdown() {
    const msg = JSON.stringify({ t: 'countdown', endsAt: this.endsAt, mode: this.mode });
    for (const m of this.members.values()) {
      try {
        m.ws.send(msg);
      } catch (e) {}
    }
  }

  begin() {
    this.timer = null;
    if (!this.members.size) return this.toLobby();
    this.phase = 'playing';
    this.endsAt = 0;
    for (const m of this.members.values()) m.alive = true;
    // One seed per match so every player rides the exact same battle bus.
    const start = JSON.stringify({ t: 'start', seed: (Math.random() * 1e9) | 0, mode: this.mode });
    for (const m of this.members.values()) {
      try {
        m.ws.send(start);
      } catch (e) {}
    }
    this.broadcast();
  }

  toLobby() {
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'lobby';
    this.endsAt = 0;
    for (const m of this.members.values()) {
      m.ready = false;
      m.alive = true;
    }
    this.broadcast();
  }

  // Back to the party lobby once every player in the match is out.
  maybeReset() {
    if (this.phase !== 'playing') return;
    for (const m of this.members.values()) if (m.alive) return;
    this.toLobby();
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const room = /^\/party\/([A-Za-z0-9]{4,8})\/ws$/.exec(url.pathname);
    if (room) {
      const code = room[1].toUpperCase();
      const stub = env.PARTY.get(env.PARTY.idFromName(code));
      const target = new URL(req.url);
      target.pathname = '/room';
      target.searchParams.set('code', code);
      return stub.fetch(new Request(target.toString(), req));
    }

    if (url.pathname === '/health') return new Response('soddrop party ok');

    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },
};
