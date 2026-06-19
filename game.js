(() => {
  "use strict";

  // ===== 設定 =====
  const CELL = 8;          // テトロミノ1マスあたりの砂ピクセル数
  const COLS = 10;         // 盤面の横マス数
  const ROWS = 20;         // 盤面の縦マス数
  const GW = COLS * CELL;  // 砂グリッド横 (80)
  const GH = ROWS * CELL;  // 砂グリッド縦 (160)
  const PIX = 5;           // 砂1ピクセルの描画サイズ
  const W = GW * PIX;      // canvas内部幅 400
  const H = GH * PIX;      // canvas内部高 800

  // 4色パレット（砂の色）。0は空。※色は据え置き
  const PALETTE = [
    null,
    { r: 0xe8, g: 0x5d, b: 0x3a }, // 赤
    { r: 0x3d, g: 0xb0, b: 0x52 }, // 緑
    { r: 0x3a, g: 0x82, b: 0xe8 }, // 青
    { r: 0xf2, g: 0xc4, b: 0x33 }, // 黄
  ];
  const NCOL = 4;

  // テトロミノ定義（4x4グリッド内のセル座標）。
  // 既存7種 + 追加10種 = 全17種。すべて0..3の範囲に収め、回転を安全に。
  const SHAPES = {
    // --- 既存の7種 ---
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[1,0],[0,1],[1,1],[2,1]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
    // --- 追加10種 ---
    DOT:   [[1,1]],                              // 1マス
    DUO:   [[1,1],[2,1]],                         // 2マス
    TRI_I: [[0,1],[1,1],[2,1]],                   // 3マス直線
    TRI_L: [[1,1],[2,1],[1,2]],                   // 3マスL
    PLUS:  [[1,0],[0,1],[1,1],[2,1],[1,2]],       // 十字(5)
    U:     [[0,1],[2,1],[0,2],[1,2],[2,2]],       // U字(5)
    P5:    [[1,0],[2,0],[1,1],[2,1],[1,2]],       // P型(5)
    V5:    [[0,0],[0,1],[0,2],[1,2],[2,2]],       // V字(5)
    T5:    [[0,0],[1,0],[2,0],[1,1],[1,2]],       // T字(5)
    W5:    [[0,0],[0,1],[1,1],[1,2],[2,2]],       // W字(5)
  };
  const SHAPE_KEYS = Object.keys(SHAPES);

  // 左右対称で回転しても見た目が変わらない（=回転で位置がズレるだけ）ブロックは回転無効
  const NO_ROTATE = new Set(["DOT", "O", "PLUS"]);

  // ===== Canvas =====
  const cv = document.getElementById("cv");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const off = document.createElement("canvas");
  off.width = GW; off.height = GH;
  const octx = off.getContext("2d");
  const img = octx.createImageData(GW, GH);

  const nextCv = document.getElementById("nextCv");
  const nctx = nextCv.getContext("2d");
  const holdCv = document.getElementById("holdCv");
  const hctx = holdCv.getContext("2d");

  const scoreEl = document.getElementById("score");
  const finalScoreEl = document.getElementById("finalScore");

  // 画面（オーバーレイ）
  const screens = {
    home: document.getElementById("homeScreen"),
    pause: document.getElementById("pauseScreen"),
    gameover: document.getElementById("gameoverScreen"),
  };
  function showScreen(name) {
    for (const k in screens) screens[k].classList.toggle("hidden", k !== name);
  }
  function hideScreens() {
    for (const k in screens) screens[k].classList.add("hidden");
  }

  // ===== 状態 =====
  const grid = new Uint8Array(GW * GH);
  const noise = new Float32Array(GW * GH);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.78 + Math.random() * 0.32;

  let piece = null;
  let nextType = null;
  let nextColor = 0;
  let holdType = null;
  let holdColor = 0;
  let holdUsed = false;
  let score = 0;
  let running = false;
  let paused = false;
  let gameOver = false;

  let dropTimer = 0;
  const DROP_INTERVAL = 0.5;
  const SOFT_INTERVAL = 0.04;
  let softDrop = false;

  const idx = (x, y) => y * GW + x;

  // ===== ピース =====
  function makePiece(type, color) {
    return {
      type,
      color,
      cells: SHAPES[type].map(c => [c[0], c[1]]),
      cx: Math.floor((COLS - 4) / 2),
      cy: -2,
    };
  }

  function rotate(p) {
    if (NO_ROTATE.has(p.type)) return; // 対称ブロックは回転しない
    const rotated = p.cells.map(([x, y]) => [3 - y, x]);
    const test = { ...p, cells: rotated };
    if (!collide(test, 0, 0)) { p.cells = rotated; return; }
    for (const dx of [-1, 1, -2, 2]) {
      if (!collide(test, dx, 0)) { p.cells = rotated; p.cx += dx; return; }
    }
  }

  function collide(p, offCellX, offCellY) {
    for (const [bx, by] of p.cells) {
      const cellX = p.cx + bx + offCellX;
      const cellY = p.cy + by + offCellY;
      const sx0 = cellX * CELL;
      const sy0 = cellY * CELL;
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

  function randType() { return SHAPE_KEYS[(Math.random() * SHAPE_KEYS.length) | 0]; }
  function randColor() { return 1 + ((Math.random() * NCOL) | 0); }

  function spawn() {
    const type = nextType ?? randType();
    const color = nextColor || randColor();
    piece = makePiece(type, color);
    nextType = randType();
    nextColor = randColor();
    drawNext();
    if (collide(piece, 0, 0)) endGame();
  }

  function lockPiece() {
    stamp(piece);
    piece = null;
    holdUsed = false; // 設置したらホールド再使用可
    spawn();
  }

  // ホールド：現在のピースを保管。すでにある場合は入れ替え。1回設置するまで1度だけ。
  function doHold() {
    if (!piece || holdUsed) return;
    if (holdType === null) {
      holdType = piece.type;
      holdColor = piece.color;
      piece = null;
      holdUsed = true;
      spawn();
    } else {
      const t = holdType, c = holdColor;
      holdType = piece.type;
      holdColor = piece.color;
      piece = makePiece(t, c);
      holdUsed = true;
      if (collide(piece, 0, 0)) endGame();
    }
    drawHold();
  }

  // ===== 砂の物理 =====
  function stepSand() {
    for (let y = GH - 2; y >= 0; y--) {
      const leftFirst = Math.random() < 0.5;
      for (let i = 0; i < GW; i++) {
        const x = leftFirst ? i : GW - 1 - i;
        const c = grid[idx(x, y)];
        if (c === 0) continue;
        if (grid[idx(x, y + 1)] === 0) {
          grid[idx(x, y + 1)] = c;
          grid[idx(x, y)] = 0;
          continue;
        }
        const dir = Math.random() < 0.5 ? -1 : 1;
        for (const d of [dir, -dir]) {
          const nx = x + d;
          if (nx < 0 || nx >= GW) continue;
          if (grid[idx(nx, y + 1)] === 0 && grid[idx(nx, y)] === 0) {
            grid[idx(nx, y + 1)] = c;
            grid[idx(x, y)] = 0;
            break;
          }
        }
      }
    }
  }

  // ===== ライン消去：同色が左壁→右壁につながったら消す =====
  const visited = new Uint8Array(GW * GH);
  const qX = new Int16Array(GW * GH);
  const qY = new Int16Array(GW * GH);
  const compIdx = new Int32Array(GW * GH);

  function clearConnected() {
    visited.fill(0);
    let cleared = 0;

    for (let y = 0; y < GH; y++) {
      const start = idx(0, y);
      const c = grid[start];
      if (c === 0 || visited[start]) continue;

      let head = 0, tail = 0, n = 0;
      let touchRight = false;
      qX[tail] = 0; qY[tail] = y; tail++;
      visited[start] = 1;

      const tryPush = (ax, ay) => {
        const ai = idx(ax, ay);
        if (visited[ai] || grid[ai] !== c) return;
        visited[ai] = 1;
        qX[tail] = ax; qY[tail] = ay; tail++;
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
        for (let k = 0; k < n; k++) grid[compIdx[k]] = 0;
        cleared += n;
      }
    }

    if (cleared > 0) {
      score += cleared;
      scoreEl.textContent = score;
    }
  }

  // ===== 描画 =====
  function paintCell(data, gx, gy, p) {
    const gi = idx(gx, gy);
    const di = gi * 4;
    const b = noise[gi];
    data[di]   = Math.min(255, p.r * b) | 0;
    data[di+1] = Math.min(255, p.g * b) | 0;
    data[di+2] = Math.min(255, p.b * b) | 0;
    data[di+3] = 255;
  }

  function render() {
    const data = img.data;
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const gi = idx(x, y);
        const di = gi * 4;
        const c = grid[gi];
        if (c === 0) {
          data[di] = 0; data[di+1] = 0; data[di+2] = 0; data[di+3] = 255;
        } else {
          paintCell(data, x, y, PALETTE[c]);
        }
      }
    }

    if (piece) {
      const p = PALETTE[piece.color];
      for (const [bx, by] of piece.cells) {
        const sx0 = (piece.cx + bx) * CELL;
        const sy0 = (piece.cy + by) * CELL;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = sy0 + yy;
          if (gy < 0 || gy >= GH) continue;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = sx0 + xx;
            if (gx < 0 || gx >= GW) continue;
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
    for (const [x, y] of cells) {
      c2d.fillRect(ox + x * s, oy + y * s, s - 2, s - 2);
    }
  }

  function drawNext() { drawPreview(nctx, nextCv, nextType, nextColor); }
  function drawHold() { drawPreview(hctx, holdCv, holdType, holdColor); }

  function hardDrop() {
    if (!piece) return;
    while (!collide(piece, 0, 1)) piece.cy++;
    lockPiece();
  }

  // ===== ループ =====
  let lastTime = 0;
  let sandAccumulator = 0;
  const SAND_STEP = 1 / 120;

  function loop(t) {
    requestAnimationFrame(loop);
    if (!running || paused || gameOver) { lastTime = t; return; }
    const dt = Math.min((t - lastTime) / 1000, 0.05);
    lastTime = t;

    sandAccumulator += dt;
    let steps = 0;
    while (sandAccumulator >= SAND_STEP && steps < 4) {
      stepSand();
      sandAccumulator -= SAND_STEP;
      steps++;
    }
    clearConnected();

    if (piece) {
      dropTimer += dt;
      const interval = softDrop ? SOFT_INTERVAL : DROP_INTERVAL;
      if (dropTimer >= interval) {
        dropTimer = 0;
        if (!collide(piece, 0, 1)) piece.cy++;
        else lockPiece();
      }
    }

    render();
  }

  // ===== 操作（共通アクション） =====
  function moveLeft()  { if (piece && !collide(piece, -1, 0)) piece.cx--; }
  function moveRight() { if (piece && !collide(piece, 1, 0))  piece.cx++; }
  function doRotate()  { if (piece) rotate(piece); }

  // ===== キーボード =====
  document.addEventListener("keydown", (e) => {
    if (!running) {
      if (e.code === "Enter" || e.code === "Space") startGame();
      return;
    }
    if (e.code === "KeyP") { togglePause(); return; }
    if (paused || gameOver || !piece) return;

    switch (e.code) {
      case "ArrowLeft":  moveLeft();  e.preventDefault(); break;
      case "ArrowRight": moveRight(); e.preventDefault(); break;
      case "ArrowUp":
      case "KeyX":       doRotate();  e.preventDefault(); break;
      case "ArrowDown":  softDrop = true; e.preventDefault(); break;
      case "Space":      hardDrop();  e.preventDefault(); break;
      case "KeyC":       doHold();    e.preventDefault(); break;
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "ArrowDown") softDrop = false;
  });

  // ===== タッチコントローラー =====
  const repeatTimers = new Map();

  function startRepeat(act, fn) {
    fn();
    // 連続入力（押しっぱなしで繰り返し）
    const id = setInterval(fn, 90);
    repeatTimers.set(act, id);
  }
  function stopRepeat(act) {
    const id = repeatTimers.get(act);
    if (id) { clearInterval(id); repeatTimers.delete(act); }
  }

  document.querySelectorAll(".ctrl-btn").forEach((btn) => {
    const act = btn.dataset.act;

    const press = (e) => {
      e.preventDefault();
      if (!running || paused || gameOver) return;
      switch (act) {
        case "left":   startRepeat(act, moveLeft); break;
        case "right":  startRepeat(act, moveRight); break;
        case "down":   softDrop = true; break;
        case "rotate": doRotate(); break;
        case "hard":   hardDrop(); break;
        case "hold":   doHold(); break;
      }
    };
    const release = (e) => {
      e.preventDefault();
      if (act === "left" || act === "right") stopRepeat(act);
      if (act === "down") softDrop = false;
    };

    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
  });

  // ===== 一時停止 / 各ボタン =====
  function togglePause() {
    if (!running || gameOver) return;
    paused = !paused;
    if (paused) {
      softDrop = false;
      repeatTimers.forEach((id) => clearInterval(id));
      repeatTimers.clear();
      showScreen("pause");
    } else {
      hideScreens();
      lastTime = performance.now();
    }
  }

  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  document.getElementById("restartBtn").addEventListener("click", startGame);
  document.getElementById("startBtn").addEventListener("click", startGame);
  document.getElementById("retryBtn").addEventListener("click", startGame);
  function goHome() {
    running = false; gameOver = false; paused = false;
    grid.fill(0); piece = null;
    holdType = null; holdColor = 0; holdUsed = false;
    drawHold();
    render();
    showScreen("home");
  }
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.getElementById("pauseHomeBtn").addEventListener("click", goHome);

  // ===== 開始 / 終了 =====
  function startGame() {
    grid.fill(0);
    score = 0;
    scoreEl.textContent = "0";
    gameOver = false;
    paused = false;
    running = true;
    piece = null;
    nextType = null;
    nextColor = 0;
    holdType = null;
    holdColor = 0;
    holdUsed = false;
    softDrop = false;
    dropTimer = 0;
    sandAccumulator = 0;
    hideScreens();
    drawHold();
    spawn();
    lastTime = performance.now();
  }

  function endGame() {
    gameOver = true;
    running = false;
    finalScoreEl.textContent = score;
    showScreen("gameover");
  }

  // 初期表示
  showScreen("home");
  render();
  requestAnimationFrame(loop);
})();
