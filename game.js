(() => {
  "use strict";

  // ===== 共通設定 =====
  const CELL = 5;
  const COLS = 10;
  const ROWS = 20;
  const GW = COLS * CELL;  // 50
  const GH = ROWS * CELL;  // 100
  const PIX = 8;
  const W = GW * PIX;
  const H = GH * PIX;

  const PALETTE = [
    null,
    { r: 0xe8, g: 0x5d, b: 0x3a },
    { r: 0x3d, g: 0xb0, b: 0x52 },
    { r: 0x3a, g: 0x82, b: 0xe8 },
    { r: 0xf2, g: 0xc4, b: 0x33 },
  ];
  const NCOL = 4;

  // 落下速度の調整（初期1.0秒で考える時間を確保）
  const DROP_BASE = 1.0;
  const DROP_MIN = 0.15;
  const SPEED_STEP_SEC = 30;   // エンドレス/オンライン：何秒ごとに加速
  const SPEED_FACTOR = 0.85;
  const SOFT_INTERVAL = 0.028;
  const SAND_STEP = 1 / 120;
  const CLEAR_DURATION = 0.7;

  // ブラックサンド出現：3分超 → 15秒おき
  const BLACK_START_SEC = 180;
  const BLACK_INTERVAL_SEC = 15;

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
    // 連鎖しやすい縦長・横長ピース
    VERT4: [[1,0],[1,1],[1,2],[1,3]], // 縦長4マス
    HORI4: [[0,1],[1,1],[2,1],[3,1]], // 横長4マス（I字と同じだが追加で出現率UP）
    VERT3: [[1,0],[1,1],[1,2]], // 縦長3マス
    HORI3: [[0,1],[1,1],[2,1]], // 横長3マス
  };
  const SHAPE_KEYS = Object.keys(SHAPES);
  const NO_ROTATE = new Set(["DOT", "O", "PLUS"]); // VERT4, VERT3を削除（回転許可）

  const idx = (x, y) => y * GW + x;
  
  // 7-bag システム：全ピースが均等に出現
  let shapeBag = [];
  function create7Bag() {
    const bag = [...SHAPE_KEYS];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  }
  function getNextShape() {
    if (shapeBag.length === 0) shapeBag = create7Bag();
    return shapeBag.shift();
  }
  
  const randColor = () => 1 + ((Math.random() * NCOL) | 0);

  // 虹色お邪魔ブロックの色（毎回ランダム・隣り合う色は変える）
  function randomGarbageColors() {
    const colors = new Int8Array(GW);
    const bands = 8;
    const bw = GW / bands;
    let last = 0;
    for (let b = 0; b < bands; b++) {
      let c;
      do { c = randColor(); } while (c === last);
      last = c;
      const x0 = Math.floor(b * bw), x1 = Math.floor((b + 1) * bw);
      for (let x = x0; x < x1; x++) colors[x] = c;
    }
    return colors;
  }

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
    const nextCv2 = playerEl.querySelector(".nextCv2");
    const nctx2 = nextCv2.getContext("2d");
    const nextCv3 = playerEl.querySelector(".nextCv3");
    const nctx3 = nextCv3.getContext("2d");
    const holdCv = playerEl.querySelector(".holdCv");
    const hctx = holdCv.getContext("2d");
    const scoreEl = playerEl.querySelector(".pscore");

    const grid = new Uint8Array(GW * GH);   // 実際の色
    const hide = new Uint8Array(GW * GH);   // 1ならブラックサンド（色を隠す）
    const noise = new Float32Array(GW * GH);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.78 + Math.random() * 0.32;

    const visited = new Uint8Array(GW * GH);
    const qX = new Int16Array(GW * GH);
    const qY = new Int16Array(GW * GH);
    const compIdx = new Int32Array(GW * GH);

    const state = {
      piece: null,
      nextQueue: [], // 3個分のキュー [{ type, color, hidden }, ...]
      makeNextHidden: false,
      holdType: null, holdColor: 0, holdUsed: false,
      score: 0,
      softDrop: false,
      dropTimer: 0,
      sandAcc: 0,
      alive: true,
      clearList: null, clearElapsed: 0, clearCount: 0,
      chainCount: 0, // 連鎖カウント
      combo: 0, // コンボカウント
      laneCount: 0, // レーン消去カウント（オンライン対戦用）
      justLocked: false, // ピースを置いた直後かどうか
      garbageQueue: [],
      garbage: null,
    };

    function makePiece(type, color, hidden) {
      return {
        type, color, hidden: !!hidden,
        cells: SHAPES[type].map(c => [c[0], c[1]]),
        cx: Math.floor((COLS - 4) / 2),
        cy: -2,
      };
    }
    
    // NEXTキューを初期化（3個分）
    function fillNextQueue() {
      while (state.nextQueue.length < 3) {
        const type = getNextShape();
        const color = randColor();
        const hidden = state.makeNextHidden;
        state.makeNextHidden = false;
        state.nextQueue.push({ type, color, hidden });
      }
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
      const hb = p.hidden ? 1 : 0;
      for (const [bx, by] of p.cells) {
        const sx0 = (p.cx + bx) * CELL;
        const sy0 = (p.cy + by) * CELL;
        for (let yy = 0; yy < CELL; yy++) {
          const gy = sy0 + yy;
          if (gy < 0 || gy >= GH) continue;
          for (let xx = 0; xx < CELL; xx++) {
            const gx = sx0 + xx;
            if (gx < 0 || gx >= GW) continue;
            const gi = idx(gx, gy);
            grid[gi] = p.color;
            hide[gi] = hb;
          }
        }
      }
    }
    function spawn() {
      fillNextQueue();
      const next = state.nextQueue.shift();
      state.piece = makePiece(next.type, next.color, next.hidden);
      fillNextQueue();
      drawNext();
      if (collide(state.piece, 0, 0)) { state.alive = false; onTopOut(); }
    }
    function lockPiece() {
      stamp(state.piece);
      state.piece = null;
      state.holdUsed = false;
      state.justLocked = true; // ピースを置いた直後フラグ
      spawn();
    }
    function doHold() {
      if (!state.piece || state.holdUsed) return;
      // ブラックサンドはホールド不可（覗き見防止）
      if (state.piece.hidden) return;
      if (state.holdType === null) {
        state.holdType = state.piece.type; state.holdColor = state.piece.color;
        state.piece = null; state.holdUsed = true; spawn();
      } else {
        const t = state.holdType, c = state.holdColor;
        state.holdType = state.piece.type; state.holdColor = state.piece.color;
        state.piece = makePiece(t, c, false); state.holdUsed = true;
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
          const here = idx(x, y);
          const c = grid[here];
          if (c === 0) continue;
          const below = idx(x, y + 1);
          if (grid[below] === 0) {
            grid[below] = c; hide[below] = hide[here];
            grid[here] = 0; hide[here] = 0;
            continue;
          }
          const dir = Math.random() < 0.5 ? -1 : 1;
          for (const d of [dir, -dir]) {
            const nx = x + d;
            if (nx < 0 || nx >= GW) continue;
            const diag = idx(nx, y + 1);
            if (grid[diag] === 0 && grid[idx(nx, y)] === 0) {
              grid[diag] = c; hide[diag] = hide[here];
              grid[here] = 0; hide[here] = 0;
              break;
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
        // 右端に触れている かつ 4マス以上の場合のみ消える
        if (touchRight && n >= 4) {
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
      for (let k = 0; k < list.length; k++) { grid[list[k]] = 0; hide[list[k]] = 0; }
      
      // 連鎖・コンボ・レーンボーナスの計算
      state.chainCount++;
      state.combo++;
      state.laneCount++; // レーン消去カウント（常にカウント、リセットしない）
      let baseScore = state.clearCount;
      
      // 連鎖ボーナス（減衰システム）
      // 2連鎖=1.3倍、3連鎖=1.5倍、5連鎖=1.8倍、10連鎖=2.0倍（頭打ち）
      if (state.chainCount >= 2) {
        let chainMultiplier;
        if (state.chainCount <= 3) {
          chainMultiplier = 1.0 + state.chainCount * 0.15;
        } else if (state.chainCount <= 6) {
          chainMultiplier = 1.45 + (state.chainCount - 3) * 0.1;
        } else if (state.chainCount <= 10) {
          chainMultiplier = 1.75 + (state.chainCount - 6) * 0.05;
        } else {
          chainMultiplier = 2.0; // 10連鎖以降は2倍で頭打ち
        }
        baseScore = Math.floor(baseScore * chainMultiplier);
      }
      
      // コンボボーナス（連続消しで倍率UP、最大3倍）
      const comboMultiplier = Math.min(1 + state.combo * 0.08, 3.0);
      baseScore = Math.floor(baseScore * comboMultiplier);
      
      state.score += baseScore;
      scoreEl.textContent = state.score;
      
      // onClear: レーンは5回到達で発動
      const shouldSendGarbage = state.laneCount >= 5;
      onClear(state.clearCount, state.chainCount, state.laneCount, shouldSendGarbage);
      
      // 5レーン到達でリセット
      if (shouldSendGarbage) {
        state.laneCount = 0;
      }
      
      state.clearList = null; state.clearCount = 0;
      state.justLocked = false; // クリア後はフラグをリセット
    }

    function receiveGarbage(lines) { for (let i = 0; i < lines; i++) state.garbageQueue.push(1); }
    function spawnGarbageIfNeeded(dropInterval) {
      if (state.garbage || state.garbageQueue.length === 0) return;
      state.garbageQueue.shift();
      state.garbage = { y: 0, timer: 0, step: (dropInterval / CELL) / 2, colors: randomGarbageColors() };
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
        else { for (let x = 0; x < GW; x++) { if (grid[idx(x, bottom)] !== 0) { landed = true; break; } } }
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

    function setPx(data, gi, r, g, b) {
      const di = gi * 4;
      data[di] = r | 0; data[di+1] = g | 0; data[di+2] = b | 0; data[di+3] = 255;
    }
    function paintColor(data, gi, p, bright) {
      const bb = noise[gi] * (bright || 1);
      setPx(data, gi, Math.min(255, p.r * bb), Math.min(255, p.g * bb), Math.min(255, p.b * bb));
    }
    function paintBlack(data, gi, bright) {
      // ブラックサンド：色は分からないが形は見える暗いスレート色
      const bb = noise[gi] * (bright || 1);
      const v = 42 * bb;
      setPx(data, gi, v + 8, v + 8, v + 16);
    }
    function render() {
      const data = img.data;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const gi = idx(x, y);
          const c = grid[gi];
          if (c === 0) setPx(data, gi, 0, 0, 0);
          else if (hide[gi]) paintBlack(data, gi);
          else paintColor(data, gi, PALETTE[c]);
        }
      }
      if (state.clearList) {
        const t = state.clearElapsed / CLEAR_DURATION;
        const flash = 0.6 + 0.4 * Math.sin(state.clearElapsed * 30);
        const v = Math.max(0, Math.min(255, 255 * (1 - t) * flash)) | 0;
        const list = state.clearList;
        for (let k = 0; k < list.length; k++) setPx(data, list[k], v, v, v);
      }
      if (state.garbage) {
        const g = state.garbage;
        for (let ry = 0; ry < CELL; ry++) {
          const gy = g.y + ry; if (gy < 0 || gy >= GH) continue;
          for (let x = 0; x < GW; x++) paintColor(data, idx(x, gy), PALETTE[g.colors[x]], 1.15);
        }
      }
      if (state.piece) {
        const p = state.piece;
        const col = PALETTE[p.color];
        
        // ゴーストピース（着地予測）を描画
        let ghostY = p.cy;
        while (true) {
          const testPiece = { ...p, cy: ghostY + 1 };
          if (collide(testPiece, 0, 0)) break;
          ghostY++;
        }
        
        // ゴーストを半透明で描画（実際のピースと異なる位置の場合のみ）
        if (ghostY > p.cy) {
          for (const [bx, by] of p.cells) {
            const sx0 = (p.cx + bx) * CELL;
            const sy0 = (ghostY + by) * CELL;
            for (let yy = 0; yy < CELL; yy++) {
              const gy = sy0 + yy; if (gy < 0 || gy >= GH) continue;
              for (let xx = 0; xx < CELL; xx++) {
                const gx = sx0 + xx; if (gx < 0 || gx >= GW) continue;
                const gi = idx(gx, gy);
                if (p.hidden) {
                  // ブラックサンドのゴースト
                  const bb = noise[gi] * 0.4;
                  const v = 42 * bb;
                  setPx(data, gi, v + 8, v + 8, v + 16);
                } else {
                  // 通常のゴースト（半透明）
                  const bb = noise[gi] * 0.5;
                  setPx(data, gi, Math.min(255, col.r * bb), Math.min(255, col.g * bb), Math.min(255, col.b * bb));
                }
              }
            }
          }
        }
        
        // 実際のピースを描画
        for (const [bx, by] of p.cells) {
          const sx0 = (p.cx + bx) * CELL;
          const sy0 = (p.cy + by) * CELL;
          for (let yy = 0; yy < CELL; yy++) {
            const gy = sy0 + yy; if (gy < 0 || gy >= GH) continue;
            for (let xx = 0; xx < CELL; xx++) {
              const gx = sx0 + xx; if (gx < 0 || gx >= GW) continue;
              const gi = idx(gx, gy);
              if (p.hidden) paintBlack(data, gi, 1.1);
              else paintColor(data, gi, col);
            }
          }
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, GW, GH, 0, 0, W, H);
    }
    function drawPreview(c2d, canvas, type, color, hidden) {
      const size = canvas.width;
      c2d.clearRect(0, 0, size, size);
      if (!type) return;
      const cells = SHAPES[type];
      const s = size / 4.5;
      const ox = (size - 4 * s) / 2 + s * 0.25;
      const oy = (size - 4 * s) / 2 + s * 0.25;
      c2d.fillStyle = hidden ? "#23262f" : `rgb(${PALETTE[color].r},${PALETTE[color].g},${PALETTE[color].b})`;
      for (const [x, y] of cells) c2d.fillRect(ox + x * s, oy + y * s, s - 1, s - 1);
    }
    function drawNext() {
      if (state.nextQueue.length >= 1) {
        const n1 = state.nextQueue[0];
        drawPreview(nctx, nextCv, n1.type, n1.color, n1.hidden);
      }
      if (state.nextQueue.length >= 2) {
        const n2 = state.nextQueue[1];
        drawPreview(nctx2, nextCv2, n2.type, n2.color, n2.hidden);
      }
      if (state.nextQueue.length >= 3) {
        const n3 = state.nextQueue[2];
        drawPreview(nctx3, nextCv3, n3.type, n3.color, n3.hidden);
      }
    }
    function drawHold() { drawPreview(hctx, holdCv, state.holdType, state.holdColor, false); }

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
      
      // 連鎖・コンボのリセット条件：
      // ピースを置いた後、砂が落ち着いても何も消えなかった場合
      // レーン数はリセットしない（常にカウント）
      if (state.justLocked && state.clearList === null) {
        state.chainCount = 0;
        state.combo = 0;
        state.justLocked = false;
      }
      
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

    function reset(opts) {
      opts = opts || {};
      grid.fill(0); hide.fill(0);
      state.piece = null;
      state.nextQueue = [];
      state.makeNextHidden = false;
      state.holdType = null; state.holdColor = 0; state.holdUsed = false;
      state.score = 0;
      state.softDrop = false;
      state.dropTimer = 0; state.sandAcc = 0;
      state.alive = true;
      state.clearList = null; state.clearElapsed = 0; state.clearCount = 0;
      state.chainCount = 0; state.combo = 0;
      state.laneCount = 0;
      state.justLocked = false;
      state.garbageQueue = []; state.garbage = null;
      // 開始時のお邪魔ブロック（虹色・最下段から積む）
      const rows = opts.startGarbageRows || 0;
      for (let r = 0; r < rows; r++) {
        const colors = randomGarbageColors();
        const yTop = GH - (r + 1) * CELL;
        for (let ry = 0; ry < CELL; ry++) {
          const gy = yTop + ry; if (gy < 0) continue;
          for (let x = 0; x < GW; x++) grid[idx(x, gy)] = colors[x];
        }
      }
      scoreEl.textContent = "0";
      drawHold();
      fillNextQueue();
      drawNext();
      spawn();
    }

    // 次のピースをブラックサンドにする予約（キューの末尾に追加）
    function scheduleHiddenNext() {
      state.makeNextHidden = true;
      fillNextQueue();
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
      update, reset, render, actions, receiveGarbage, scheduleHiddenNext,
      get score() { return state.score; },
      get alive() { return state.alive; },
      get combo() { return state.combo; },
      get chain() { return state.chainCount; },
      get lane() { return state.laneCount; },
    };
  }

  // ===========================================================
  //  プロフィール（レベル解放 / エンドレス最高）
  // ===========================================================
  const PROFILE_KEY = "sandtetris_profile_v2";
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      if (p && typeof p.maxLevel === "number") return { maxLevel: p.maxLevel, endlessBest: p.endlessBest || 0 };
    } catch (e) {}
    return { maxLevel: 1, endlessBest: 0 };
  }
  let profile = loadProfile();
  function saveProfile() { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {} }

  // レベルのクリア目標：連鎖・コンボがあるので調整（Lv1=5000、以降+1500ずつ）
  function levelTarget(level) { return 5000 + (level - 1) * 1500; }
  // レベルごとの速度（高いほど速い）
  function levelDropInterval(level) { return Math.max(DROP_MIN, DROP_BASE * Math.pow(0.93, level - 1)); }
  // 開始時のお邪魔ブロック段数：10レベルごとに1段
  function levelStartRows(level) { return Math.floor((level - 1) / 10); }

  // ===========================================================
  //  通信（PeerJS / WebRTC）
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
          isHost = false;
          try { peer.destroy(); } catch (e) {}
          peer = new Peer();
          peer.on("open", () => { bindConn(peer.connect(hostId, { reliable: true })); });
          peer.on("error", (e2) => h.onError && h.onError(e2 && e2.type));
        } else { h.onError && h.onError(type); }
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
  const soloGoalEl = document.getElementById("soloGoal");
  const bannerEl = document.getElementById("banner");
  const oppScoreEl = document.getElementById("oppScore");
  const oppStateEl = document.getElementById("oppState");
  const oppLaneEl = document.getElementById("oppLane");
  const comboDisplayEl = document.getElementById("comboDisplay");
  const comboCountEl = comboDisplayEl.querySelector(".combo-count");
  const chainDisplayEl = document.getElementById("chainDisplay");
  const chainCountEl = chainDisplayEl.querySelector(".chain-count");

  const screens = {
    home: document.getElementById("homeScreen"),
    levelSelect: document.getElementById("levelSelect"),
    room: document.getElementById("roomScreen"),
    pause: document.getElementById("pauseScreen"),
    gameover: document.getElementById("gameoverScreen"),
    rules: document.getElementById("rulesScreen"),
  };
  function showScreen(name) { for (const k in screens) screens[k].classList.toggle("hidden", k !== name); }
  function hideScreens() { for (const k in screens) screens[k].classList.add("hidden"); }

  let mode = "solo"; // "solo" | "endless" | "online"
  let running = false, paused = false, over = false;
  let elapsed = 0;
  let game = null;
  let oppScore = 0, oppConnected = false, oppLane = 0;
  let soloLevel = 1, soloTarget = 3000, soloCleared = false;
  let blackTimer = 0;

  function ensureGame() { if (!game) game = createGame(playerEl, onLocalClear, onLocalTopOut); }

  function currentDropInterval() {
    if (mode === "solo") return levelDropInterval(soloLevel);
    const timeLevel = Math.floor(elapsed / SPEED_STEP_SEC);
    return Math.max(DROP_MIN, DROP_BASE * Math.pow(SPEED_FACTOR, timeLevel));
  }

  function onLocalClear(count, chain, lane, shouldSendGarbage) {
    if (mode === "online") {
      // レーン数を常に送信
      Net.send({ t: "lane", v: lane });
      
      // 5レーン到達でお邪魔ブロックを送る
      if (shouldSendGarbage) {
        Net.send({ t: "garbage", n: 1 });
        Net.send({ t: "score", v: game.score });
      }
    }
  }
  function onLocalTopOut() {
    if (mode === "online") { Net.send({ t: "dead", score: game.score }); endOnline(false); }
    else if (mode === "endless") endEndless();
    else endSolo();
  }

  function showBanner(text, ms) {
    bannerEl.textContent = text;
    bannerEl.classList.remove("hidden");
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => bannerEl.classList.add("hidden"), ms || 1800);
  }
  
  function updateComboDisplay(combo) {
    if (combo > 0) {
      comboCountEl.textContent = combo;
      const labelEl = comboDisplayEl.querySelector(".combo-label");
      labelEl.textContent = "COMBO"; // ラベルを戻す
      comboDisplayEl.classList.remove("hidden");
      // マイルストーン: 5, 10, 20, 30...
      const isMilestone = combo % 5 === 0 && combo >= 5;
      comboDisplayEl.classList.toggle("milestone", isMilestone);
      if (isMilestone) {
        showBanner(`${combo}コンボ！`, 500); // 0.5秒で消える
      }
      
      // 1秒後に自動的に消す
      clearTimeout(updateComboDisplay._timer);
      updateComboDisplay._timer = setTimeout(() => {
        comboDisplayEl.classList.add("hidden");
      }, 1000);
    } else {
      comboDisplayEl.classList.add("hidden");
      clearTimeout(updateComboDisplay._timer);
    }
  }
  
  function updateChainDisplay(chain) {
    if (chain > 0) {
      chainCountEl.textContent = chain;
      chainDisplayEl.classList.remove("hidden");
      
      // 1秒後に自動的に消す
      clearTimeout(updateChainDisplay._timer);
      updateChainDisplay._timer = setTimeout(() => {
        chainDisplayEl.classList.add("hidden");
      }, 1000);
    } else {
      chainDisplayEl.classList.add("hidden");
      clearTimeout(updateChainDisplay._timer);
    }
  }
  
  function updateLaneDisplay(lane) {
    // オンライン対戦時は常に表示（0でも表示）
    const currentLane = lane % 5; // 0-4の範囲
    comboCountEl.textContent = `${currentLane}/5`;
    const labelEl = comboDisplayEl.querySelector(".combo-label");
    labelEl.textContent = "レーン数"; // ラベルを変更
    comboDisplayEl.classList.remove("hidden");
    comboDisplayEl.classList.remove("milestone");
    
    // 5レーン到達でバナー表示
    if (lane > 0 && lane % 5 === 0) {
      showBanner(`5レーン達成！`, 500);
    }
  }

  function setModeClass() {
    appEl.classList.toggle("mode-solo", mode === "solo");
    appEl.classList.toggle("mode-endless", mode === "endless");
    appEl.classList.toggle("mode-online", mode === "online");
  }

  function startSolo(level) {
    mode = "solo";
    soloLevel = level;
    soloTarget = levelTarget(level);
    soloCleared = false;
    setModeClass();
    ensureGame();
    elapsed = 0; over = false; paused = false; running = true;
    blackTimer = BLACK_START_SEC - BLACK_INTERVAL_SEC;
    playLevelEl.textContent = level;
    soloGoalEl.textContent = `Lv.${level} ・ 目標 ${soloTarget} 点`;
    bannerEl.classList.add("hidden");
    comboDisplayEl.classList.add("hidden");
    chainDisplayEl.classList.add("hidden");
    
    // レーン数表示を元の位置に戻す
    const pstage = document.querySelector(".pstage");
    const pinfo = document.querySelector(".pinfo");
    if (pstage && comboDisplayEl) {
      if (pinfo && pinfo.contains(comboDisplayEl)) {
        pinfo.removeChild(comboDisplayEl);
      }
      if (!pstage.contains(comboDisplayEl)) {
        pstage.appendChild(comboDisplayEl);
      }
    }
    
    hideScreens();
    shapeBag = []; // 7-bagをリセット
    game.reset({ startGarbageRows: levelStartRows(level) });
    timerEl.textContent = "00:00";
    lastTime = performance.now();
  }

  function startEndless() {
    mode = "endless";
    setModeClass();
    ensureGame();
    elapsed = 0; over = false; paused = false; running = true;
    blackTimer = BLACK_START_SEC - BLACK_INTERVAL_SEC;
    bannerEl.classList.add("hidden");
    comboDisplayEl.classList.add("hidden");
    chainDisplayEl.classList.add("hidden");
    
    // レーン数表示を元の位置に戻す
    const pstage = document.querySelector(".pstage");
    const pinfo = document.querySelector(".pinfo");
    if (pstage && comboDisplayEl) {
      if (pinfo && pinfo.contains(comboDisplayEl)) {
        pinfo.removeChild(comboDisplayEl);
      }
      if (!pstage.contains(comboDisplayEl)) {
        pstage.appendChild(comboDisplayEl);
      }
    }
    
    hideScreens();
    shapeBag = []; // 7-bagをリセット
    game.reset();
    timerEl.textContent = "00:00";
    lastTime = performance.now();
  }

  function startOnline() {
    mode = "online";
    setModeClass();
    ensureGame();
    elapsed = 0; over = false; paused = false; running = true;
    oppScore = 0; oppConnected = true; oppLane = 0; updateOpp();
    blackTimer = BLACK_START_SEC - BLACK_INTERVAL_SEC;
    bannerEl.classList.add("hidden");
    chainDisplayEl.classList.add("hidden");
    hideScreens();
    
    // オンライン対戦時: レーン数表示をpinfoに移動
    const pinfo = document.querySelector(".pinfo");
    const pstage = document.querySelector(".pstage");
    if (pinfo && comboDisplayEl) {
      // 既にpinfoに含まれていない場合のみ移動
      if (!pinfo.contains(comboDisplayEl)) {
        // pstageから削除
        if (pstage && pstage.contains(comboDisplayEl)) {
          pstage.removeChild(comboDisplayEl);
        }
        // ホールドスロットの後に挿入
        const slots = pinfo.querySelectorAll(".slot");
        if (slots.length > 0) {
          const holdSlot = slots[0];
          if (holdSlot.nextSibling) {
            pinfo.insertBefore(comboDisplayEl, holdSlot.nextSibling);
          } else {
            pinfo.appendChild(comboDisplayEl);
          }
        }
      }
      comboDisplayEl.classList.remove("hidden");
    }
    
    shapeBag = []; // 7-bagをリセット
    game.reset();
    timerEl.textContent = "00:00";
    lastTime = performance.now();
  }

  function endSolo() {
    over = true; running = false;
    const cleared = soloCleared;
    document.getElementById("goTitle").textContent = cleared ? "レベルクリア！" : "ゲームオーバー";
    document.getElementById("goDesc").innerHTML = `スコア <b>${game.score}</b>　／　目標 ${soloTarget}`;
    const extra = document.getElementById("goExtra");
    if (cleared) {
      extra.classList.remove("hidden");
      extra.textContent = soloLevel + 1 <= profile.maxLevel ? `Lv.${soloLevel + 1} は解放済み` : "";
      if (!extra.textContent) extra.classList.add("hidden");
    } else extra.classList.add("hidden");
    showScreen("gameover");
  }

  function endEndless() {
    over = true; running = false;
    let best = false;
    if (game.score > profile.endlessBest) { profile.endlessBest = game.score; saveProfile(); best = true; }
    document.getElementById("goTitle").textContent = "ゲームオーバー";
    document.getElementById("goDesc").innerHTML = `スコア <b>${game.score}</b>　／　最高 ${profile.endlessBest}`;
    const extra = document.getElementById("goExtra");
    if (best) { extra.classList.remove("hidden"); extra.textContent = "自己ベスト更新！"; }
    else extra.classList.add("hidden");
    showScreen("gameover");
  }

  function endOnline(won) {
    if (over) return;
    over = true; running = false;
    document.getElementById("goExtra").classList.add("hidden");
    document.getElementById("goTitle").textContent = won ? "勝ち！" : "負け…";
    document.getElementById("goDesc").innerHTML = `あなた <b>${game ? game.score : 0}</b>　／　相手 <b>${oppScore}</b>`;
    showScreen("gameover");
  }

  function goHome() {
    running = false; over = false; paused = false;
    if (mode === "online") Net.reset();
    
    // レーン数表示を元の位置（pstage）に戻す
    const pstage = document.querySelector(".pstage");
    const pinfo = document.querySelector(".pinfo");
    if (pstage && comboDisplayEl) {
      // pinfoから削除
      if (pinfo && pinfo.contains(comboDisplayEl)) {
        pinfo.removeChild(comboDisplayEl);
      }
      // pstageに戻す（まだ含まれていない場合）
      if (!pstage.contains(comboDisplayEl)) {
        pstage.appendChild(comboDisplayEl);
      }
    }
    
    mode = "solo"; setModeClass();
    refreshHomeStats();
    showScreen("home");
  }

  function togglePause() {
    if (!running || over) return;
    if (mode === "online") return;
    paused = !paused;
    if (paused) { game.actions.softOff(); stopAllRepeat(); showScreen("pause"); }
    else { hideScreens(); lastTime = performance.now(); }
  }

  function updateOpp() {
    oppScoreEl.textContent = oppScore;
    oppStateEl.classList.toggle("on", oppConnected);
    if (oppLaneEl) {
      oppLaneEl.textContent = `${oppLane % 5}/5`;
    }
  }
  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function refreshHomeStats() {
    document.getElementById("homeMaxLevel").textContent = profile.maxLevel;
    document.getElementById("homeEndlessBest").textContent = profile.endlessBest;
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

    // ブラックサンド（エンドレス/オンライン：3分超で15秒おき）
    if (mode === "endless" || mode === "online") {
      if (elapsed >= BLACK_START_SEC && elapsed - blackTimer >= BLACK_INTERVAL_SEC) {
        blackTimer = elapsed;
        if (game) game.scheduleHiddenNext();
        showBanner("ブラックサンド出現！", 1200);
      }
    }

    if (game) {
      game.update(dt, currentDropInterval());
      
      // コンボ・連鎖・レーンの表示を更新
      if (mode === "online") {
        // オンライン対戦時はレーン数を表示
        updateLaneDisplay(game.lane);
      } else {
        // ソロ・エンドレスはコンボを表示
        updateComboDisplay(game.combo);
      }
      updateChainDisplay(game.chain);
    }

    // ソロ：目標スコア到達で即座にクリア
    if (mode === "solo" && !soloCleared && game && game.score >= soloTarget) {
      soloCleared = true;
      if (soloLevel + 1 > profile.maxLevel) { profile.maxLevel = soloLevel + 1; saveProfile(); }
      running = false;
      over = true;
      endSolo();
    }
  }

  // ===== 入力（キーボード） =====
  const KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right",
    ArrowUp: "rotate", KeyX: "rotate",
    ArrowDown: "soft", Space: "hard", KeyC: "hold",
  };
  const heldKeys = new Set();
  document.addEventListener("keydown", (e) => {
    if (!running) return;
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

  // ボタン操作（ホールド・ハードドロップのみ）
  document.querySelectorAll("#controller .ctrl-btn").forEach((btn) => {
    const act = btn.dataset.act;
    const press = (e) => {
      e.preventDefault();
      if (!running || paused || over || !game) return;
      if (act === "hard") game.actions.hard();
      else if (act === "hold") game.actions.hold();
    };
    btn.addEventListener("pointerdown", press);
  });

  // 盤面タップ・スワイプ操作
  const boardEl = document.querySelector(".board");
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  let isSwiping = false;
  let lastMoveTime = 0; // 最後に移動した時刻
  let isPointerDown = false; // ポインターが押されているか

  boardEl.addEventListener("pointerdown", (e) => {
    if (!running || paused || over || !game) return;
    isPointerDown = true;
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    touchStartTime = Date.now();
    isSwiping = false;
    lastMoveTime = 0;
  });

  boardEl.addEventListener("pointermove", (e) => {
    if (!running || paused || over || !game) return;
    // ポインターが押されていない場合は無視（ホバーバグ対策）
    if (!isPointerDown) return;
    if (touchStartTime === 0) return;
    
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const now = Date.now();
    
    // スワイプ判定（15px以上移動）
    if (dist > 15) {
      isSwiping = true;
      
      // 横スワイプ（左右移動）- 100ms間隔で制限
      if (Math.abs(dx) > Math.abs(dy)) {
        if (now - lastMoveTime >= 100) {
          if (dx > 0 && dx > 30) {
            game.actions.right();
            touchStartX = e.clientX; // 連続移動用
            lastMoveTime = now;
          } else if (dx < 0 && dx < -30) {
            game.actions.left();
            touchStartX = e.clientX; // 連続移動用
            lastMoveTime = now;
          }
        }
      }
      // 縦スワイプ（下移動）
      else if (dy > 30) {
        game.actions.softOn();
      }
    }
  });

  boardEl.addEventListener("pointerup", (e) => {
    if (!running || paused || over || !game) return;
    game.actions.softOff();
    
    // タップ判定（スワイプせず、200ms以内にリリース）
    const duration = Date.now() - touchStartTime;
    if (!isSwiping && duration < 200 && isPointerDown) {
      game.actions.rotate();
    }
    
    isPointerDown = false;
    touchStartTime = 0;
    isSwiping = false;
    lastMoveTime = 0;
  });

  boardEl.addEventListener("pointercancel", (e) => {
    if (game) game.actions.softOff();
    isPointerDown = false;
    touchStartTime = 0;
    isSwiping = false;
    lastMoveTime = 0;
  });
  
  // ポインターが盤面を離れた時もリセット
  boardEl.addEventListener("pointerleave", (e) => {
    if (game) game.actions.softOff();
    isPointerDown = false;
    touchStartTime = 0;
    isSwiping = false;
    lastMoveTime = 0;
  });

  // ===== レベル選択 UI =====
  let selLevel = 1;
  function refreshLevelSelect() {
    document.getElementById("levelSelValue").textContent = selLevel;
    const locked = selLevel > profile.maxLevel;
    document.getElementById("levelLock").classList.toggle("hidden", !locked);
    document.getElementById("levelInfo").textContent =
      `クリア目標 ${levelTarget(selLevel)} 点 ・ お邪魔 ${levelStartRows(selLevel)} 段`;
    document.getElementById("levelPlayBtn").disabled = locked;
    document.getElementById("levelPlayBtn").style.opacity = locked ? 0.4 : 1;
    document.getElementById("levelPrev").disabled = selLevel <= 1;
  }
  document.getElementById("levelPrev").addEventListener("click", () => { if (selLevel > 1) { selLevel--; refreshLevelSelect(); } });
  document.getElementById("levelNext").addEventListener("click", () => { selLevel++; refreshLevelSelect(); });
  document.getElementById("levelPlayBtn").addEventListener("click", () => { if (selLevel <= profile.maxLevel) startSolo(selLevel); });
  document.getElementById("levelBackBtn").addEventListener("click", goHome);

  // ===== オンライン：ロビー =====
  const roomStatus = document.getElementById("roomStatus");
  function setupNetHandlers() {
    Net.setHandlers({
      onWaiting: () => { roomStatus.textContent = "相手の参加を待っています…（同じあいことばで参加してもらってください）"; },
      onConnected: () => { roomStatus.textContent = "接続しました！対戦開始！"; setTimeout(() => startOnline(), 300); },
      onData: (d) => {
        if (!d || typeof d !== "object") return;
        if (d.t === "garbage") { if (game) game.receiveGarbage(Math.max(1, Math.min(4, d.n | 0))); }
        else if (d.t === "score") { oppScore = d.v || 0; updateOpp(); }
        else if (d.t === "lane") { oppLane = d.v || 0; updateOpp(); }
        else if (d.t === "dead") { oppScore = d.score || oppScore; updateOpp(); endOnline(true); }
      },
      onClose: () => {
        oppConnected = false; updateOpp();
        if (running && !over) endOnlineDisconnect();
        else roomStatus.textContent = "接続が切れました。";
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
    document.getElementById("goExtra").classList.add("hidden");
    document.getElementById("goTitle").textContent = "対戦終了";
    document.getElementById("goDesc").textContent = "相手との接続が切れました。";
    showScreen("gameover");
  }

  // ===== ボタン =====
  document.getElementById("soloBtn").addEventListener("click", () => {
    selLevel = profile.maxLevel; refreshLevelSelect(); showScreen("levelSelect");
  });
  document.getElementById("endlessBtn").addEventListener("click", startEndless);
  document.getElementById("onlineBtn").addEventListener("click", () => {
    roomStatus.textContent = ""; showScreen("room");
    setTimeout(() => document.getElementById("roomCode").focus(), 100);
  });
  document.getElementById("connectBtn").addEventListener("click", () => {
    const code = document.getElementById("roomCode").value.trim();
    if (!code) { roomStatus.textContent = "あいことばを入力してください。"; return; }
    roomStatus.textContent = "接続中…";
    setupNetHandlers(); Net.join(code);
  });
  document.getElementById("roomBackBtn").addEventListener("click", () => { Net.reset(); goHome(); });
  document.getElementById("pauseBtn").addEventListener("click", togglePause);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  document.getElementById("restartBtn").addEventListener("click", () => {
    if (mode === "solo") startSolo(soloLevel);
    else startEndless();
  });
  document.getElementById("retryBtn").addEventListener("click", () => {
    if (mode === "online") { Net.reset(); goHome(); }
    else if (mode === "endless") startEndless();
    else startSolo(soloLevel);
  });
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.getElementById("pauseHomeBtn").addEventListener("click", goHome);
  document.getElementById("rulesBtn").addEventListener("click", () => showScreen("rules"));
  document.getElementById("rulesBackBtn").addEventListener("click", goHome);

  // ===== Service Worker（自動更新） =====
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        // 1時間ごとに更新チェック
        setInterval(() => reg.update(), 60 * 60 * 1000);
      }).catch(() => {});
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return; refreshing = true; location.reload();
      });
    });
  }

  // 初期表示
  refreshHomeStats();
  showScreen("home");
  requestAnimationFrame(loop);
})();
