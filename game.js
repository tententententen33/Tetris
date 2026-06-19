(() => {
  "use strict";

  // ===== 共通設定 =====
  const CELL = 5;          // テトロミノ1マスあたりの砂ピクセル数（小さくして砂粒を約1.5倍に）
  const COLS = 10;
  const ROWS = 20;
  const GW = COLS * CELL;  // 50
  const GH = ROWS * CELL;  // 100
  const PIX = 8;           // 内部canvasの砂1粒の描画サイズ
  const W = GW * PIX;      // 400
  const H = GH * PIX;      // 800

  const PALETTE = [
    null,
    { r: 0xe8, g: 0x5d, b: 0x3a }, // 赤
    { r: 0x3d, g: 0xb0, b: 0x52 }, // 緑
    { r: 0x3a, g: 0x82, b: 0xe8 }, // 青
    { r: 0xf2, g: 0xc4, b: 0x33 }, // 黄
  ];
  const NCOL = 4;

  // 難易度：落下間隔のベースを短めに。30秒ごとに徐々に加速。
  const DROP_BASE = 0.34;     // 開始時の落下間隔(秒)
  const DROP_MIN = 0.07;      // 下限
  const SPEED_STEP_SEC = 30;  // 何秒ごとに加速するか
  const SPEED_FACTOR = 0.85;  // 1段階ごとに間隔を×0.85（=徐々に速く）
  const SOFT_INTERVAL = 0.028;
  const SAND_STEP = 1 / 120;
  const CLEAR_DURATION = 0.7; // 消去アニメの長さ(秒)。ゆっくり見せる。

  // 17種類のブロック（4x4内）
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

  // 虹色ガベージの色（横方向に色が変化）
  function rainbowColor(x) {
    return 1 + (Math.floor((x / GW) * 8) % NCOL);
  }

  // ===========================================================
  //  Game：1プレイヤー分の盤面・ロジック
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
      // 消去アニメ
      clearList: null, clearElapsed: 0, clearCount: 0,
      // ガベージ（虹色ブロック）
      garbageQueue: [],   // 待機中の本数
      garbage: null,      // 現在落下中: { y, step, timer, colors:Int8Array }
    };

    // ---- ピース ----
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
      if (collide(state.piece, 0, 0)) {
        state.alive = false;
        onTopOut();
      }
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
        state.holdType = state.piece.type;
        state.holdColor = state.piece.color;
        state.piece = null;
        state.holdUsed = true;
        spawn();
      } else {
        const t = state.holdType, c = state.holdColor;
        state.holdType = state.piece.type;
        state.holdColor = state.piece.color;
        state.piece = makePiece(t, c);
        state.holdUsed = true;
        if (collide(state.piece, 0, 0)) { state.alive = false; onTopOut(); }
      }
      drawHold();
    }
    function hardDrop() {
      if (!state.piece) return;
      while (!collide(state.piece, 0, 1)) state.piece.cy++;
      lockPiece();
    }

    // ---- 砂の物理 ----
    function stepSand() {
      for (let y = GH - 2; y >= 0; y--) {
        const leftFirst = Math.random() < 0.5;
        for (let i = 0; i < GW; i++) {
          const x = leftFirst ? i : GW - 1 - i;
          const c = grid[idx(x, y)];
          if (c === 0) continue;
          if (grid[idx(x, y + 1)] === 0) {
            grid[idx(x, y + 1)] = c; grid[idx(x, y)] = 0; continue;
          }
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

    // ---- 消去判定（同色が左端→右端でつながる） ----
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
      onClear(state.clearCount); // 相手にガベージ送信など
      state.clearList = null;
      state.clearCount = 0;
    }

    // ---- ガベージ（虹色ブロック） ----
    function receiveGarbage(lines) {
      for (let i = 0; i < lines; i++) state.garbageQueue.push(1);
    }
    function spawnGarbageIfNeeded(dropInterval) {
      if (state.garbage || state.garbageQueue.length === 0) return;
      state.garbageQueue.shift();
      const colors = new Int8Array(GW);
      for (let x = 0; x < GW; x++) colors[x] = rainbowColor(x);
      // ブロックの落下スピードはピースの約2倍：1砂行あたりの時間
      const stepTime = (dropInterval / CELL) / 2;
      state.garbage = { y: 0, timer: 0, step: stepTime, colors };
    }
    function updateGarbage(dt, dropInterval) {
      spawnGarbageIfNeeded(dropInterval);
      const g = state.garbage;
      if (!g) return;
      g.step = (dropInterval / CELL) / 2; // 速度を常に追従
      g.timer += dt;
      while (g.timer >= g.step) {
        g.timer -= g.step;
        const bottom = g.y + CELL; // 次に占有する行
        let landed = false;
        if (bottom >= GH) landed = true;
        else {
          for (let x = 0; x < GW; x++) {
            if (grid[idx(x, bottom)] !== 0) { landed = true; break; }
          }
        }
        if (landed) {
          // 砂として焼き付け
          for (let ry = 0; ry < CELL; ry++) {
            const gy = g.y + ry;
            if (gy < 0 || gy >= GH) continue;
            for (let x = 0; x < GW; x++) {
              if (grid[idx(x, gy)] === 0) grid[idx(x, gy)] = g.colors[x];
            }
          }
          state.garbage = null;
          return;
        }
        g.y++;
      }
    }

    // ---- 描画 ----
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
      // 消去アニメ：対象セルを白く点滅させながらフェードして消す
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
      // 落下中ガベージ
      if (state.garbage) {
        const g = state.garbage;
        for (let ry = 0; ry < CELL; ry++) {
          const gy = g.y + ry;
          if (gy < 0 || gy >= GH) continue;
          for (let x = 0; x < GW; x++) {
            paintCell(data, x, gy, PALETTE[g.colors[x]], 1.15);
          }
        }
      }
      // 現在のピース
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

    // ---- 更新 ----
    function update(dt, dropInterval) {
      if (!state.alive) { render(); return; }

      // 消去アニメ中は盤面を凍結してゆっくり見せる
      if (state.clearList) {
        state.clearElapsed += dt;
        if (state.clearElapsed >= CLEAR_DURATION) finishClear();
        render();
        return;
      }

      // 砂シミュレーション
      state.sandAcc += dt;
      let steps = 0;
      while (state.sandAcc >= SAND_STEP && steps < 4) {
        stepSand(); state.sandAcc -= SAND_STEP; steps++;
      }

      updateGarbage(dt, dropInterval);
      detectClear();
      if (state.clearList) { render(); return; }

      // ピース落下
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

    // 入力アクション
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
      update, reset, render, actions,
      receiveGarbage,
      get score() { return state.score; },
      get alive() { return state.alive; },
      clearStillRunning: () => !!state.clearList,
    };
  }

  // ===========================================================
  //  マネージャ：ソロ / 対戦の制御
  // ===========================================================
  const appEl = document.getElementById("app");
  const players = Array.from(document.querySelectorAll(".player"));
  const timerEl = document.getElementById("timer");

  const screens = {
    home: document.getElementById("homeScreen"),
    pause: document.getElementById("pauseScreen"),
    gameover: document.getElementById("gameoverScreen"),
  };
  function showScreen(name) {
    for (const k in screens) screens[k].classList.toggle("hidden", k !== name);
  }
  function hideScreens() { for (const k in screens) screens[k].classList.add("hidden"); }

  let mode = "solo";
  let running = false, paused = false, over = false;
  let elapsed = 0;
  let games = [];

  function currentDropInterval() {
    const level = Math.floor(elapsed / SPEED_STEP_SEC);
    return Math.max(DROP_MIN, DROP_BASE * Math.pow(SPEED_FACTOR, level));
  }

  function buildGames() {
    if (mode === "versus") {
      const g0 = createGame(players[0], (n) => { if (games[1]) games[1].receiveGarbage(1); }, () => topOut(0));
      const g1 = createGame(players[1], (n) => { if (games[0]) games[0].receiveGarbage(1); }, () => topOut(1));
      games = [g0, g1];
    } else {
      const g0 = createGame(players[0], () => {}, () => topOut(0));
      games = [g0];
    }
  }

  function topOut(i) {
    if (over) return;
    if (mode === "solo") {
      endGame();
    } else {
      // 片方が積み上がったら決着
      endGame(i);
    }
  }

  function startGame(newMode) {
    if (newMode) mode = newMode;
    appEl.classList.toggle("mode-versus", mode === "versus");
    appEl.classList.toggle("mode-solo", mode === "solo");
    buildGames();
    elapsed = 0;
    over = false; paused = false; running = true;
    hideScreens();
    games.forEach(g => g.reset());
    timerEl.textContent = "00:00";
    lastTime = performance.now();
  }

  function endGame(loserIndex) {
    over = true; running = false;
    const goTitle = document.getElementById("goTitle");
    const goDesc = document.getElementById("goDesc");
    if (mode === "versus") {
      const winner = loserIndex === 0 ? "Player 2" : "Player 1";
      goTitle.textContent = `${winner} の勝ち！`;
      goDesc.innerHTML = `P1 ${games[0].score} 点 ／ P2 ${games[1].score} 点`;
    } else {
      goTitle.textContent = "ゲームオーバー";
      goDesc.innerHTML = `スコア <span id="finalScore">${games[0].score}</span>`;
    }
    showScreen("gameover");
  }

  function goHome() {
    running = false; over = false; paused = false;
    showScreen("home");
  }

  function togglePause() {
    if (!running || over) return;
    paused = !paused;
    if (paused) {
      games.forEach(g => g.actions.softOff());
      stopAllRepeat();
      showScreen("pause");
    } else {
      hideScreens();
      lastTime = performance.now();
    }
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
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
    const drop = currentDropInterval();
    for (const g of games) g.update(dt, drop);
  }

  // ===== 入力（キーボード） =====
  // モードごとのキー割り当て
  const SOLO_MAP = {
    ArrowLeft: [0, "left"], ArrowRight: [0, "right"],
    ArrowUp: [0, "rotate"], KeyX: [0, "rotate"],
    ArrowDown: [0, "soft"], Space: [0, "hard"], KeyC: [0, "hold"],
  };
  const VS_MAP = {
    // Player 1
    KeyA: [0, "left"], KeyD: [0, "right"], KeyW: [0, "rotate"],
    KeyS: [0, "soft"], ShiftLeft: [0, "hard"], KeyQ: [0, "hold"],
    // Player 2
    ArrowLeft: [1, "left"], ArrowRight: [1, "right"], ArrowUp: [1, "rotate"],
    ArrowDown: [1, "soft"], Slash: [1, "hard"], Period: [1, "hold"],
  };
  function activeMap() { return mode === "versus" ? VS_MAP : SOLO_MAP; }

  const heldKeys = new Set();

  document.addEventListener("keydown", (e) => {
    if (!running) {
      if (e.code === "Enter") startGame();
      return;
    }
    if (e.code === "KeyP") { togglePause(); e.preventDefault(); return; }
    if (paused || over) return;

    const map = activeMap();
    const bind = map[e.code];
    if (!bind) return;
    e.preventDefault();
    const [gi, act] = bind;
    const g = games[gi];
    if (!g) return;

    if (act === "soft") { g.actions.softOn(); return; }
    // 移動系は押しっぱなしリピート（keydownリピートに任せるが、初回のみ即実行）
    if (act === "left" || act === "right") {
      g.actions[act]();
      return;
    }
    if (heldKeys.has(e.code) && (act === "rotate" || act === "hard" || act === "hold")) return; // 連射防止
    heldKeys.add(e.code);
    g.actions[act]();
  });

  document.addEventListener("keyup", (e) => {
    heldKeys.delete(e.code);
    const map = activeMap();
    const bind = map[e.code];
    if (!bind) return;
    const [gi, act] = bind;
    const g = games[gi];
    if (g && act === "soft") g.actions.softOff();
  });

  // ===== タッチコントローラー（ソロ：games[0]） =====
  const repeatTimers = new Map();
  function startRepeat(key, fn) { fn(); repeatTimers.set(key, setInterval(fn, 90)); }
  function stopRepeat(key) { const id = repeatTimers.get(key); if (id) { clearInterval(id); repeatTimers.delete(key); } }
  function stopAllRepeat() { repeatTimers.forEach(id => clearInterval(id)); repeatTimers.clear(); }

  document.querySelectorAll("#controller .ctrl-btn").forEach((btn) => {
    const act = btn.dataset.act;
    const press = (e) => {
      e.preventDefault();
      if (!running || paused || over) return;
      const g = games[0]; if (!g) return;
      switch (act) {
        case "left":   startRepeat("left", g.actions.left); break;
        case "right":  startRepeat("right", g.actions.right); break;
        case "down":   g.actions.softOn(); break;
        case "rotate": g.actions.rotate(); break;
        case "hard":   g.actions.hard(); break;
        case "hold":   g.actions.hold(); break;
      }
    };
    const release = (e) => {
      e.preventDefault();
      const g = games[0];
      if (act === "left" || act === "right") stopRepeat(act);
      if (act === "down" && g) g.actions.softOff();
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
  });

  // ===== ボタン =====
  document.getElementById("startBtn").addEventListener("click", () => startGame("solo"));
  document.getElementById("vsBtn").addEventListener("click", () => startGame("versus"));
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  document.getElementById("restartBtn").addEventListener("click", () => startGame());
  document.getElementById("retryBtn").addEventListener("click", () => startGame());
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.getElementById("pauseHomeBtn").addEventListener("click", goHome);

  // 初期表示
  showScreen("home");
  requestAnimationFrame(loop);
})();
