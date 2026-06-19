(() => {
  "use strict";

  // ===== 共通設定 =====
  const CELL = 5;
  const COLS = 10;
  const ROWS = 20;
  const GW = COLS * CELL;  // 50
  const GH = ROWS * CELL;  // 100
  const PIX = 8;
  const W = GW * PIX;      // 400
  const H = GH * PIX;      // 800

  const PALETTE = [
    null,
    { r: 0xe8, g: 0x5d, b: 0x3a },
    { r: 0x3d, g: 0xb0, b: 0x52 },
    { r: 0x3a, g: 0x82, b: 0xe8 },
    { r: 0xf2, g: 0xc4, b: 0x33 },
  ];
  const NCOL = 4;

  const DROP_BASE = 0.34;
  const DROP_MIN = 0.06;
  const SPEED_STEP_SEC = 30;
  const SPEED_FACTOR = 0.85;
  const SOFT_INTERVAL = 0.028;
  const SAND_STEP = 1 / 120;
  const CLEAR_DURATION = 0.7;

  const SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[1,0],[0,1],[1,1],[2,1]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
    DOT:   [[1,1]],
    DUO:   [[1,1],[2,1]],
    TRI_I: [[0,1],[1,1],[2,1]],
    TRI_L: [[1,1],[2,1],[1,2]],
    PLUS:  [[1,0],[0,1],[1,1],[2,1],[1,2]],
    U:     [[0,1],[2,1],[0,2],[1,2],[2,2]],
    P5:    [[1,0],[2,0],[1,1],[2,1],[1,2]],
    V5:    [[0,0],[0,1],[0,2],[1,2],[2,2]],
    T5:    [[0,0],[1,0],[2,0],[1,1],[1,2]],
    W5:    [[0,0],[0,1],[1,1],[1,2],[2,2]],
  };
  const SHAPE_KEYS = Object.keys(SHAPES);
  const NO_ROTATE = new Set(["DOT", "O", "PLUS"]);

  const idx = (x, y) => y * GW + x;
  const randType = () => SHAPE_KEYS[(Math.random() * SHAPE_KEYS.length) | 0];
  const randColor = () => 1 + ((Math.random() * NCOL) | 0);
  const rainbowColor = (x) => 1 + (Math.floor((x / GW) * 8) % NCOL);

  // ===========================================================
  //  Game：1プレイヤー分の盤面
  // ===========================================================
  function createGame(playerEl, onClear, onTopOut) {
    const cv = playerEl.querySelector(".board");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const off = document.createElement("canvas");
    off.width = GW; off.height = GH;
    const octx = off.getContext("2d");
    const img = octx.createImageData(GW, GH);

    const nextCv = playerEl.querySelector(".nextCv");
    const nctx = nextCv.getContext("2d");
    const holdCv = playerEl.querySelector(".holdCv");
    const hctx = holdCv.getContext("2d");
    const scoreEl = playerEl.querySelector(".pscore");

    const grid = new Uint8Array(GW * GH);
    const noise = new Float32Array(GW * GH);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.78 + Math.random() * 0.32;

    const visited = new Uint8Array(GW * GH);
    const qX = new Int16Array(GW * GH);
    const qY = new Int16Array(GW * GH);
    const compIdx = new Int32Array(GW * GH);

    const state = {
      piece: null,
      nextType: null, nextColor: 0,
      holdType: null, holdColor: 0, holdUsed: false,
      score: 0,
      softDrop: false,
      dropTimer: 0,
      sandAcc: 0,
      alive: true,
      clearList: null, clearElapsed: 0, clearCount: 0,
      garbageQueue: [],
      garbage: null,
    };

    function makePiece(type, color) {
      return {
        type, color,
        cells: SHAPES[type].map(c => [c[0], c[1]]),
        cx: Math.floor((COLS - 4) / 2),
        cy: -2,
      };
    }
    function collide(p, ox, oy) {
      for (const [bx, by] of p.cells) {
        const sx0 = (p.cx + bx + ox) * CELL;
        const sy0 = (p.cy + by + oy) * CELL;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = sy0 + yy;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = sx0 + xx;
            if (gx < 0 || gx >= GW || gy >= GH) return true;
            if (gy < 0) continue;
            if (grid[idx(gx, gy)] !== 0) return true;
          }
        }
      }
      return false;
    }
    function rotate(p) {
      if (NO_ROTATE.has(p.type)) return;
      const rotated = p.cells.map(([x, y]) => [3 - y, x]);
      const test = { ...p, cells: rotated };
      if (!collide(test, 0, 0)) { p.cells = rotated; return; }
      for (const dx of [-1, 1, -2, 2]) {
        if (!collide(test, dx, 0)) { p.cells = rotated; p.cx += dx; return; }
      }
    }
    function stamp(p) {
      for (const [bx, by] of p.cells) {
        const sx0 = (p.cx + bx) * CELL;
        const sy0 = (p.cy + by) * CELL;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = sy0 + yy;
          if (gy < 0 || gy >= GH) continue;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = sx0 + xx;
            if (gx < 0 || gx >= GW) continue;
            grid[idx(gx, gy)] = p.color;
          }
        }
      }
    }
    function spawn() {
      const type = state.nextType ?? randType();
      const color = state.nextColor || randColor();
      state.piece = makePiece(type, color);
      state.nextType = randType();
      state.nextColor = randColor();
      drawNext();
      if (collide(state.piece, 0, 0)) { state.alive = false; onTopOut(); }
    }
    function lockPiece() {
      stamp(state.piece);
      state.piece = null;
      state.holdUsed = false;
      spawn();
    }
    function doHold() {
      if (!state.piece || state.holdUsed) return;
      if (state.holdType === null) {
        state.holdType = state.piece.type; state.holdColor = state.piece.color;
        state.piece = null; state.holdUsed = true; spawn();
      } else {
        const t = state.holdType, c = state.holdColor;
        state.holdType = state.piece.type; state.holdColor = state.piece.color;
        state.piece = makePiece(t, c); state.holdUsed = true;
        if (collide(state.piece, 0, 0)) { state.alive = false; onTopOut(); }
      }
      drawHold();
    }
    function hardDrop() {
      if (!state.piece) return;
      while (!collide(state.piece, 0, 1)) state.piece.cy++;
      lockPiece();
    }

    function stepSand() {
      for (let y = GH - 2; y >= 0; y--) {
        const leftFirst = Math.random() < 0.5;
        for (let i = 0; i < GW; i++) {
          const x = leftFirst ? i : GW - 1 - i;
          const c = grid[idx(x, y)];
          if (c === 0) continue;
          if (grid[idx(x, y + 1)] === 0) { grid[idx(x, y + 1)] = c; grid[idx(x, y)] = 0; continue; }
          const dir = Math.random() < 0.5 ? -1 : 1;
          for (const d of [dir, -dir]) {
            const nx = x + d;
            if (nx < 0 || nx >= GW) continue;
            if (grid[idx(nx, y + 1)] === 0 && grid[idx(nx, y)] === 0) {
              grid[idx(nx, y + 1)] = c; grid[idx(x, y)] = 0; break;
            }
          }
        }
      }
    }

    function detectClear() {
      visited.fill(0);
      const result = [];
      let count = 0;
      for (let y = 0; y < GH; y++) {
        const start = idx(0, y);
        const c = grid[start];
        if (c === 0 || visited[start]) continue;
        let head = 0, tail = 0, n = 0, touchRight = false;
        qX[tail] = 0; qY[tail] = y; tail++; visited[start] = 1;
        const tryPush = (ax, ay) => {
          const ai = idx(ax, ay);
          if (visited[ai] || grid[ai] !== c) return;
          visited[ai] = 1; qX[tail] = ax; qY[tail] = ay; tail++;
        };
        while (head < tail) {
          const cx = qX[head], cy = qY[head]; head++;
          compIdx[n++] = idx(cx, cy);
          if (cx === GW - 1) touchRight = true;
          if (cx > 0)      tryPush(cx - 1, cy);
          if (cx < GW - 1) tryPush(cx + 1, cy);
          if (cy > 0)      tryPush(cx, cy - 1);
          if (cy < GH - 1) tryPush(cx, cy + 1);
        }
        if (touchRight) {
          for (let k = 0; k < n; k++) result.push(compIdx[k]);
          count += n;
        }
      }
      if (result.length > 0) {
        state.clearList = result;
        state.clearElapsed = 0;
        state.clearCount = count;
      }
    }
    function finishClear() {
      const list = state.clearList;
      for (let k = 0; k < list.length; k++) grid[list[k]] = 0;
      state.score += state.clearCount;
      scoreEl.textContent = state.score;
      onClear(state.clearCount);
      state.clearList = null; state.clearCount = 0;
    }

    function receiveGarbage(lines) {
      for (let i = 0; i < lines; i++) state.garbageQueue.push(1);
    }
    function spawnGarbageIfNeeded(dropInterval) {
      if (state.garbage || state.garbageQueue.length === 0) return;
      state.garbageQueue.shift();
      const colors = new Int8Array(GW);
      for (let x = 0; x < GW; x++) colors[x] = rainbowColor(x);
      state.garbage = { y: 0, timer: 0, step: (dropInterval / CELL) / 2, colors };
    }
    function updateGarbage(dt, dropInterval) {
      spawnGarbageIfNeeded(dropInterval);
      const g = state.garbage;
      if (!g) return;
      g.step = (dropInterval / CELL) / 2;
      g.timer += dt;
      while (g.timer >= g.step) {
        g.timer -= g.step;
        const bottom = g.y + CELL;
        let landed = false;
        if (bottom >= GH) landed = true;
        else {
          for (let x = 0; x < GW; x++) { if (grid[idx(x, bottom)] !== 0) { landed = true; break; } }
        }
        if (landed) {
          for (let ry = 0; ry < CELL; ry++) {
            const gy = g.y + ry;
            if (gy < 0 || gy >= GH) continue;
            for (let x = 0; x < GW; x++) { if (grid[idx(x, gy)] === 0) grid[idx(x, gy)] = g.colors[x]; }
          }
          state.garbage = null;
          return;
        }
        g.y++;
      }
    }

    function paintCell(data, gx, gy, p, bright) {
      const gi = idx(gx, gy);
      const di = gi * 4;
      const b = noise[gi] * (bright || 1);
      data[di]   = Math.min(255, p.r * b) | 0;
      data[di+1] = Math.min(255, p.g * b) | 0;
      data[di+2] = Math.min(255, p.b * b) | 0;
      data[di+3] = 255;
    }
    function render() {
      const data = img.data;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const gi = idx(x, y); const di = gi * 4; const c = grid[gi];
          if (c === 0) { data[di]=0; data[di+1]=0; data[di+2]=0; data[di+3]=255; }
          else paintCell(data, x, y, PALETTE[c]);
        }
      }
      if (state.clearList) {
        const t = state.clearElapsed / CLEAR_DURATION;
        const flash = 0.6 + 0.4 * Math.sin(state.clearElapsed * 30);
        const v = Math.max(0, Math.min(255, 255 * (1 - t) * flash)) | 0;
        const list = state.clearList;
        for (let k = 0; k < list.length; k++) {
          const di = list[k] * 4;
          data[di] = v; data[di+1] = v; data[di+2] = v; data[di+3] = 255;
        }
      }
      if (state.garbage) {
        const g = state.garbage;
        for (let ry = 0; ry < CELL; ry++) {
          const gy = g.y + ry; if (gy < 0 || gy >= GH) continue;
          for (let x = 0; x < GW; x++) paintCell(data, x, gy, PALETTE[g.colors[x]], 1.15);
        }
      }
      if (state.piece) {
        const p = PALETTE[state.piece.color];
        for (const [bx, by] of state.piece.cells) {
          const sx0 = (state.piece.cx + bx) * CELL;
          const sy0 = (state.piece.cy + by) * CELL;
          for (let yy = 0; yy < CELL; yy++) {
            const gy = sy0 + yy; if (gy < 0 || gy >= GH) continue;
            for (let xx = 0; xx < CELL; xx++) {
              const gx = sx0 + xx; if (gx < 0 || gx >= GW) continue;
              paintCell(data, gx, gy, p);
            }
          }
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, GW, GH, 0, 0, W, H);
    }
    function drawPreview(c2d, canvas, type, color) {
      const size = canvas.width;
      c2d.clearRect(0, 0, size, size);
      if (!type) return;
      const cells = SHAPES[type];
      const s = size / 4.5;
      const ox = (size - 4 * s) / 2 + s * 0.25;
      const oy = (size - 4 * s) / 2 + s * 0.25;
      const p = PALETTE[color];
      c2d.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      for (const [x, y] of cells) c2d.fillRect(ox + x * s, oy + y * s, s - 1, s - 1);
    }
    function drawNext() { drawPreview(nctx, nextCv, state.nextType, state.nextColor); }
    function drawHold() { drawPreview(hctx, holdCv, state.holdType, state.holdColor); }

    function update(dt, dropInterval) {
      if (!state.alive) { render(); return; }
      if (state.clearList) {
        state.clearElapsed += dt;
        if (state.clearElapsed >= CLEAR_DURATION) finishClear();
        render();
        return;
      }
      state.sandAcc += dt;
      let steps = 0;
      while (state.sandAcc >= SAND_STEP && steps < 4) { stepSand(); state.sandAcc -= SAND_STEP; steps++; }
      updateGarbage(dt, dropInterval);
      detectClear();
      if (state.clearList) { render(); return; }
      if (state.piece) {
        state.dropTimer += dt;
        const interval = state.softDrop ? SOFT_INTERVAL : dropInterval;
        if (state.dropTimer >= interval) {
          state.dropTimer = 0;
          if (!collide(state.piece, 0, 1)) state.piece.cy++;
          else lockPiece();
        }
      }
      render();
    }

    function reset() {
      grid.fill(0);
      state.piece = null;
      state.nextType = null; state.nextColor = 0;
      state.holdType = null; state.holdColor = 0; state.holdUsed = false;
      state.score = 0;
      state.softDrop = false;
      state.dropTimer = 0; state.sandAcc = 0;
      state.alive = true;
      state.clearList = null; state.clearElapsed = 0; state.clearCount = 0;
      state.garbageQueue = []; state.garbage = null;
      scoreEl.textContent = "0";
      drawHold(); drawNext();
      spawn();
    }

    const actions = {
      left:  () => { if (state.piece && !collide(state.piece, -1, 0)) state.piece.cx--; },
      right: () => { if (state.piece && !collide(state.piece, 1, 0)) state.piece.cx++; },
      rotate:() => { if (state.piece) rotate(state.piece); },
      hard:  () => hardDrop(),
      hold:  () => doHold(),
      softOn:  () => { state.softDrop = true; },
      softOff: () => { state.softDrop = false; },
    };

    return {
      update, reset, render, actions, receiveGarbage,
      get score() { return state.score; },
      get alive() { return state.alive; },
    };
  }

  // ===========================================================
  //  プロフィール（レベル / 経験値）：localStorageに保存
  // ===========================================================
  const PROFILE_KEY = "sandtetris_profile_v1";
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      if (p && typeof p.level === "number" && typeof p.xp === "number") return p;
    } catch (e) {}
    return { level: 1, xp: 0 };
  }
  let profile = loadProfile();
  function saveProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
  }
  // レベルごとの必要経験値
  function xpToNext(level) { return 300 + (level - 1) * 250; }
  // スコアをXpに換算して加算。レベルアップ数を返す。
  function awardXp(score) {
    profile.xp += score;
    let ups = 0;
    while (profile.xp >= xpToNext(profile.level)) {
      profile.xp -= xpToNext(profile.level);
      profile.level++;
      ups++;
    }
    saveProfile();
    return ups;
  }

  // ===========================================================
  //  通信（PeerJS / WebRTC）：合言葉で同じ部屋に入る
  // ===========================================================
  const Net = (() => {
    let peer = null, conn = null, isHost = false;
    let h = {};
    function setHandlers(x) { h = x; }
    function reset() {
      try { if (conn) conn.close(); } catch (e) {}
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = null; conn = null; isHost = false;
    }
    function send(obj) { try { if (conn && conn.open) conn.send(obj); } catch (e) {} }
    function bindConn(c) {
      conn = c;
      c.on("open", () => h.onConnected && h.onConnected(isHost));
      c.on("data", (d) => h.onData && h.onData(d));
      c.on("close", () => h.onClose && h.onClose());
      c.on("error", () => h.onClose && h.onClose());
    }
    function join(code) {
      reset();
      if (typeof Peer === "undefined") { h.onError && h.onError("no-lib"); return; }
      const clean = code.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || "room";
      const hostId = "sandtetris-v1-" + clean;
      isHost = true;
      peer = new Peer(hostId);
      peer.on("open", () => h.onWaiting && h.onWaiting());
      peer.on("connection", (c) => { if (conn) { try { c.close(); } catch (e) {} return; } bindConn(c); });
      peer.on("error", (err) => {
        const type = err && err.type;
        if (type === "unavailable-id") {
          // 既にホストがいる → ゲストとして接続
          isHost = false;
          try { peer.destroy(); } catch (e) {}
          peer = new Peer();
          peer.on("open", () => { bindConn(peer.connect(hostId, { reliable: true })); });
          peer.on("error", (e2) => h.onError && h.onError(e2 && e2.type));
        } else {
          h.onError && h.onError(type);
        }
      });
    }
    return { join, send, reset, setHandlers, get isHost() { return isHost; } };
  })();

  // ===========================================================
  //  マネージャ
  // ===========================================================
  const appEl = document.getElementById("app");
  const playerEl = document.querySelector('.player[data-player="0"]');
  const timerEl = document.getElementById("timer");
  const playLevelEl = document.getElementById("playLevel");
  const oppScoreEl = document.getElementById("oppScore");
  const oppStateEl = document.getElementById("oppState");

  const screens = {
    home: document.getElementById("homeScreen"),
    room: document.getElementById("roomScreen"),
    pause: document.getElementById("pauseScreen"),
    gameover: document.getElementById("gameoverScreen"),
  };
  function showScreen(name) { for (const k in screens) screens[k].classList.toggle("hidden", k !== name); }
  function hideScreens() { for (const k in screens) screens[k].classList.add("hidden"); }

  let mode = "solo"; // "solo" | "online"
  let running = false, paused = false, over = false;
  let elapsed = 0;
  let game = null;
  let oppScore = 0, oppConnected = false;

  function currentDropInterval() {
    const timeLevel = Math.floor(elapsed / SPEED_STEP_SEC);
    // ソロはプレイヤーレベルでも難化（2レベルごとに1段階速くスタート）
    const startLevel = mode === "solo" ? Math.floor((profile.level - 1) / 2) : 0;
    return Math.max(DROP_MIN, DROP_BASE * Math.pow(SPEED_FACTOR, timeLevel + startLevel));
  }

  function onLocalClear(count) {
    if (mode === "online") {
      Net.send({ t: "garbage", n: 1 });
      Net.send({ t: "score", v: game.score });
    }
  }
  function onLocalTopOut() {
    if (mode === "online") {
      Net.send({ t: "dead", score: game.score });
      endOnline(false);
    } else {
      endSolo();
    }
  }

  function startGame() {
    appEl.classList.toggle("mode-online", mode === "online");
    appEl.classList.toggle("mode-solo", mode === "solo");
    if (!game) game = createGame(playerEl, onLocalClear, onLocalTopOut);
    elapsed = 0; over = false; paused = false; running = true;
    oppScore = 0; updateOpp();
    playLevelEl.textContent = profile.level;
    hideScreens();
    game.reset();
    timerEl.textContent = "00:00";
    lastTime = performance.now();
  }

  function endSolo() {
    over = true; running = false;
    const score = game.score;
    const before = { level: profile.level, xp: profile.xp };
    const ups = awardXp(score);
    document.getElementById("goTitle").textContent = "ゲームオーバー";
    document.getElementById("goDesc").innerHTML = `スコア <b>${score}</b>　／　獲得XP <b>+${score}</b>`;
    const box = document.getElementById("goLevelBox");
    box.classList.remove("hidden");
    document.getElementById("goLevel").textContent = profile.level;
    const need = xpToNext(profile.level);
    document.getElementById("goXpText").textContent = `${profile.xp} / ${need} XP`;
    document.getElementById("goXpFill").style.width = Math.min(100, (profile.xp / need) * 100) + "%";
    const note = document.getElementById("goLevelUp");
    if (ups > 0) { note.classList.remove("hidden"); note.textContent = `レベルアップ！ Lv.${before.level} → Lv.${profile.level}`; }
    else note.classList.add("hidden");
    refreshHomeProfile();
    showScreen("gameover");
  }

  function endOnline(won) {
    if (over) return;
    over = true; running = false;
    document.getElementById("goLevelBox").classList.add("hidden");
    document.getElementById("goTitle").textContent = won ? "勝ち！" : "負け…";
    document.getElementById("goDesc").innerHTML = `あなた <b>${game ? game.score : 0}</b>　／　相手 <b>${oppScore}</b>`;
    showScreen("gameover");
  }

  function goHome() {
    running = false; over = false; paused = false;
    if (mode === "online") Net.reset();
    mode = "solo";
    appEl.classList.remove("mode-online");
    appEl.classList.add("mode-solo");
    refreshHomeProfile();
    showScreen("home");
  }

  function togglePause() {
    if (!running || over) return;
    if (mode === "online") return; // オンラインは一時停止なし（相手がいるため）
    paused = !paused;
    if (paused) { game.actions.softOff(); stopAllRepeat(); showScreen("pause"); }
    else { hideScreens(); lastTime = performance.now(); }
  }

  function updateOpp() {
    oppScoreEl.textContent = oppScore;
    oppStateEl.classList.toggle("on", oppConnected);
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function refreshHomeProfile() {
    document.getElementById("homeLevel").textContent = profile.level;
    const need = xpToNext(profile.level);
    document.getElementById("homeXpText").textContent = `${profile.xp} / ${need} XP`;
    document.getElementById("homeXpFill").style.width = Math.min(100, (profile.xp / need) * 100) + "%";
  }

  // ===== ループ =====
  let lastTime = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    if (!running || paused || over) { lastTime = t; return; }
    const dt = Math.min((t - lastTime) / 1000, 0.05);
    lastTime = t;
    elapsed += dt;
    timerEl.textContent = fmtTime(elapsed);
    if (game) game.update(dt, currentDropInterval());
  }

  // ===== 入力（キーボード：ソロ/オンラインともゲーム0を操作） =====
  const KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right",
    ArrowUp: "rotate", KeyX: "rotate",
    ArrowDown: "soft", Space: "hard", KeyC: "hold",
  };
  const heldKeys = new Set();
  document.addEventListener("keydown", (e) => {
    if (!running) { if (e.code === "Enter") { /* ホームで何もしない */ } return; }
    if (e.code === "KeyP") { togglePause(); e.preventDefault(); return; }
    if (paused || over || !game) return;
    const act = KEYMAP[e.code];
    if (!act) return;
    e.preventDefault();
    if (act === "soft") { game.actions.softOn(); return; }
    if (act === "left" || act === "right") { game.actions[act](); return; }
    if (heldKeys.has(e.code)) return;
    heldKeys.add(e.code);
    game.actions[act]();
  });
  document.addEventListener("keyup", (e) => {
    heldKeys.delete(e.code);
    if (game && KEYMAP[e.code] === "soft") game.actions.softOff();
  });

  // ===== タッチコントローラー =====
  const repeatTimers = new Map();
  function startRepeat(key, fn) { fn(); repeatTimers.set(key, setInterval(fn, 90)); }
  function stopRepeat(key) { const id = repeatTimers.get(key); if (id) { clearInterval(id); repeatTimers.delete(key); } }
  function stopAllRepeat() { repeatTimers.forEach(id => clearInterval(id)); repeatTimers.clear(); }

  document.querySelectorAll("#controller .ctrl-btn").forEach((btn) => {
    const act = btn.dataset.act;
    const press = (e) => {
      e.preventDefault();
      if (!running || paused || over || !game) return;
      switch (act) {
        case "left":   startRepeat("left", game.actions.left); break;
        case "right":  startRepeat("right", game.actions.right); break;
        case "down":   game.actions.softOn(); break;
        case "rotate": game.actions.rotate(); break;
        case "hard":   game.actions.hard(); break;
        case "hold":   game.actions.hold(); break;
      }
    };
    const release = (e) => {
      e.preventDefault();
      if (act === "left" || act === "right") stopRepeat(act);
      if (act === "down" && game) game.actions.softOff();
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
  });

  // ===== オンライン：ロビー処理 =====
  const roomStatus = document.getElementById("roomStatus");
  function setupNetHandlers() {
    Net.setHandlers({
      onWaiting: () => { roomStatus.textContent = "相手の参加を待っています…（同じあいことばで参加してもらってください）"; },
      onConnected: (host) => {
        oppConnected = true;
        roomStatus.textContent = "接続しました！対戦開始！";
        mode = "online";
        setTimeout(() => startGame(), 300);
      },
      onData: (d) => {
        if (!d || typeof d !== "object") return;
        if (d.t === "garbage") { if (game) game.receiveGarbage(Math.max(1, Math.min(4, d.n | 0))); }
        else if (d.t === "score") { oppScore = d.v || 0; updateOpp(); }
        else if (d.t === "dead") { oppScore = d.score || oppScore; updateOpp(); endOnline(true); }
      },
      onClose: () => {
        oppConnected = false; updateOpp();
        if (running && !over) { endOnlineDisconnect(); }
        else { roomStatus.textContent = "接続が切れました。"; }
      },
      onError: (type) => {
        if (type === "no-lib") roomStatus.textContent = "通信ライブラリを読み込めませんでした。インターネット接続を確認してください。";
        else if (type === "peer-unavailable") roomStatus.textContent = "相手が見つかりませんでした。もう一度お試しください。";
        else roomStatus.textContent = "接続エラー: " + (type || "unknown");
      },
    });
  }
  function endOnlineDisconnect() {
    over = true; running = false;
    document.getElementById("goLevelBox").classList.add("hidden");
    document.getElementById("goTitle").textContent = "対戦終了";
    document.getElementById("goDesc").textContent = "相手との接続が切れました。";
    showScreen("gameover");
  }

  // ===== ボタン =====
  document.getElementById("startBtn").addEventListener("click", () => { mode = "solo"; startGame(); });
  document.getElementById("onlineBtn").addEventListener("click", () => {
    roomStatus.textContent = "";
    showScreen("room");
    setTimeout(() => document.getElementById("roomCode").focus(), 100);
  });
  document.getElementById("connectBtn").addEventListener("click", () => {
    const code = document.getElementById("roomCode").value.trim();
    if (!code) { roomStatus.textContent = "あいことばを入力してください。"; return; }
    roomStatus.textContent = "接続中…";
    setupNetHandlers();
    Net.join(code);
  });
  document.getElementById("roomBackBtn").addEventListener("click", () => { Net.reset(); goHome(); });
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  document.getElementById("restartBtn").addEventListener("click", () => { mode = "solo"; startGame(); });
  document.getElementById("retryBtn").addEventListener("click", () => {
    if (mode === "online") { Net.reset(); goHome(); }
    else { mode = "solo"; startGame(); }
  });
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.getElementById("pauseHomeBtn").addEventListener("click", goHome);

  // 初期表示
  refreshHomeProfile();
  showScreen("home");
  requestAnimationFrame(loop);
})();
