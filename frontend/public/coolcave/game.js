/**
 * COOLCAVE // 4-COLOR RETRO RECREATION
 * - LEVELS 1 TO 4 UNTOUCHED (0, 500, 1100, 1800)
 * - 6 EXTRA LEVELS (5 TO 10) GRADUALLY SLIGHTLY FASTER, STILL DOABLE
 * - WALLS, OBSTACLES, OVERLAYS STRICTLY ORIGINAL INK AND BG
 * - TRAIL DRAWN IN DARKER INTERMEDIATE COLOR, PADDLE IN INK OVER IT LAST
 * - FLICKER-FREE OPTIMIZATION, COMPACT CODE, ALL-CAPS
 */

(function () {
  'use strict';

  const W = 320;
  const H = 240;
  const PLAYER_X = 64;
  const AVATAR_W = 16;
  const AVATAR_H = 4;
  const HALF_H = 2;

  // Gentle floaty inertia
  const GRAVITY = 0.024;
  const THRUST = -0.048;
  const MAX_VY = 0.95;

  // Levels 1 to 4 UNTOUCHED; 6 extra levels (5 to 10) gradually slightly faster and 100% doable
  const LEVELS = [
    { level: 1,  minScore: 0,    gap: 150, maxSlope: 0.8, obsChance: 0.15, minPassage: 64 },
    { level: 2,  minScore: 500,  gap: 128, maxSlope: 1.0, obsChance: 0.24, minPassage: 60 },
    { level: 3,  minScore: 1100, gap: 108, maxSlope: 1.2, obsChance: 0.32, minPassage: 56 },
    { level: 4,  minScore: 1800, gap: 90,  maxSlope: 1.4, obsChance: 0.40, minPassage: 52 },
    { level: 5,  minScore: 2500, gap: 86,  maxSlope: 1.42, obsChance: 0.42, minPassage: 50, extraTickRate: 0.08 },
    { level: 6,  minScore: 3200, gap: 82,  maxSlope: 1.44, obsChance: 0.45, minPassage: 50, extraTickRate: 0.16 },
    { level: 7,  minScore: 4000, gap: 78,  maxSlope: 1.46, obsChance: 0.48, minPassage: 48, extraTickRate: 0.24 },
    { level: 8,  minScore: 4800, gap: 74,  maxSlope: 1.48, obsChance: 0.50, minPassage: 48, extraTickRate: 0.32 },
    { level: 9,  minScore: 5700, gap: 70,  maxSlope: 1.50, obsChance: 0.52, minPassage: 48, extraTickRate: 0.40 },
    { level: 10, minScore: 6600, gap: 68,  maxSlope: 1.50, obsChance: 0.55, minPassage: 48, extraTickRate: 0.48 }
  ];

  // 4 Colors: bg, mid1, trail (darker intermediate), ink (paddle)
  const THEMES = {
    light: {
      bg: '#8fa475', mid1: '#5e754a', trail: '#364d24', ink: '#111a0e',
      rgb: [[143, 164, 117], [94, 117, 74], [54, 77, 36], [17, 26, 14]]
    },
    dark: {
      bg: '#0a0e0a', mid1: '#15520e', trail: '#259d12', ink: '#39ff14',
      rgb: [[10, 14, 10], [21, 82, 14], [37, 157, 18], [57, 255, 20]]
    }
  };

  // 3x5 Pixel Font
  const GLYPHS = {
    '0':[7,5,5,5,7],'1':[2,6,2,2,7],'2':[7,1,7,4,7],'3':[7,1,7,1,7],'4':[5,5,7,1,1],
    '5':[7,4,7,1,7],'6':[7,4,7,5,7],'7':[7,1,2,2,2],'8':[7,5,7,5,7],'9':[7,5,7,1,7],
    'A':[2,5,7,5,5],'B':[6,5,6,5,6],'C':[7,4,4,4,7],'D':[6,5,5,5,6],'E':[7,4,6,4,7],
    'F':[7,4,6,4,4],'G':[7,4,5,5,7],'H':[5,5,7,5,5],'I':[7,2,2,2,7],'J':[1,1,1,5,7],
    'K':[5,6,4,6,5],'L':[4,4,4,4,7],'M':[5,7,5,5,5],'N':[6,5,5,5,5],'O':[7,5,5,5,7],
    'P':[7,5,7,4,4],'Q':[7,5,5,7,1],'R':[6,5,6,5,5],'S':[7,4,7,1,7],'T':[7,2,2,2,2],
    'U':[5,5,5,5,7],'V':[5,5,5,2,2],'W':[5,5,5,7,5],'X':[5,5,2,5,5],'Y':[5,5,2,2,2],
    'Z':[7,1,2,4,7],' ':[0,0,0,0,0],'-':[0,0,7,0,0],':':[0,2,0,2,0],'!':[2,2,2,0,2],
    '.':[0,0,0,0,2],'[':[6,4,4,4,6],']':[3,1,1,1,3],'*':[0,5,2,5,0],'/':[1,1,2,4,4]
  };

  function renderPixelText(ctx, text, x, y, scale, color) {
    ctx.fillStyle = color;
    let cx = Math.round(x);
    const upper = String(text).toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const g = GLYPHS[upper[i]] || GLYPHS[' '];
      for (let r = 0; r < 5; r++) {
        const row = g[r];
        for (let c = 0; c < 3; c++) {
          if ((row & (1 << (2 - c))) !== 0) {
            ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
          }
        }
      }
      cx += 4 * scale;
    }
  }

  class CoolCave {
    constructor() {
      this.canvas = document.getElementById('cave-canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.ctx.imageSmoothingEnabled = false;

      this.levelText = document.getElementById('level-text');
      this.scoreText = document.getElementById('score-text');
      this.bestText = document.getElementById('best-text');
      this.themeBtn = document.getElementById('theme-btn');

      this.themeMode = 'light';
      this.theme = THEMES[this.themeMode];

      // Double-buffered video memory
      this.videoBuffer = document.createElement('canvas');
      this.videoBuffer.width = W;
      this.videoBuffer.height = H;
      this.vCtx = this.videoBuffer.getContext('2d', { alpha: false });
      this.vCtx.imageSmoothingEnabled = false;

      this.shiftBuffer = document.createElement('canvas');
      this.shiftBuffer.width = W;
      this.shiftBuffer.height = H;
      this.sCtx = this.shiftBuffer.getContext('2d', { alpha: false });
      this.sCtx.imageSmoothingEnabled = false;

      this.storageKey = 'coolcave_best_score';
      this.highScore = this.loadBest();
      this.isNewRecord = false;

      this.state = 'TITLE'; // TITLE, PLAYING, CRASHING, GAMEOVER
      this.levelIdx = 0;
      this.currentLevel = LEVELS[this.levelIdx];
      this.levelNoticeTimer = 0;

      // HUD cache to eliminate DOM layout thrashing & flicker
      this.hudScore = -1;
      this.hudLevel = -1;
      this.hudBest = -1;

      this.playerY = H / 2;
      this.prevPlayerY = H / 2;
      this.playerVy = 0;
      this.isThrusting = false;

      this.distance = 0;
      this.scrollTicks = 0;
      this.centerY = H / 2;
      this.targetCenterY = H / 2;
      this.centerTimer = 0;
      this.activeObstacle = null;
      this.obstacleCooldown = 80;
      this.columnData = [];

      this.crashX = 0;
      this.crashY = 0;
      this.crashTimer = 0;
      this.explosionRays = [];
      this.extraAccum = 0;

      this.initEvents();
      this.updateHud(true);
      this.initWorld();
      this.render();

      requestAnimationFrame(this.loop.bind(this));
    }

    loadBest() {
      try {
        const val = localStorage.getItem(this.storageKey);
        return val ? parseInt(val, 10) || 0 : 0;
      } catch (e) { return 0; }
    }

    saveBest(score) {
      this.highScore = score;
      try { localStorage.setItem(this.storageKey, score.toString()); } catch (e) {}
      this.updateHud(true);
    }

    updateHud(force) {
      const curScore = Math.floor(this.distance);
      const curLvl = this.currentLevel.level;
      if (force || curLvl !== this.hudLevel) {
        this.levelText.textContent = 'LVL: ' + curLvl;
        this.hudLevel = curLvl;
      }
      if (force || curScore !== this.hudScore) {
        this.scoreText.textContent = 'SCORE: ' + curScore;
        this.hudScore = curScore;
      }
      if (force || this.highScore !== this.hudBest) {
        this.bestText.textContent = 'BEST: ' + this.highScore;
        this.hudBest = this.highScore;
      }
    }

    toggleTheme() {
      this.themeMode = this.themeMode === 'light' ? 'dark' : 'light';
      this.theme = THEMES[this.themeMode];
      document.body.className = this.themeMode === 'dark' ? 'theme-dark' : '';
      this.swapBufferPalette();
    }

    swapBufferPalette() {
      const img = this.vCtx.getImageData(0, 0, W, H);
      const data = img.data;
      const isDark = (this.themeMode === 'dark');
      const targetRgb = this.theme.rgb;

      for (let i = 0; i < data.length; i += 4) {
        const g = data[i + 1];
        let idx = 0;
        if (isDark) {
          if (g > 140) idx = 0;
          else if (g > 95) idx = 1;
          else if (g > 45) idx = 2;
          else idx = 3;
        } else {
          if (g < 30) idx = 0;
          else if (g < 90) idx = 1;
          else if (g < 200) idx = 2;
          else idx = 3;
        }
        const c = targetRgb[idx];
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
      }
      this.vCtx.putImageData(img, 0, 0);
    }

    initEvents() {
      const onAction = (e, val) => {
        if (e.target.tagName === 'BUTTON') return;
        if (e.type.startsWith('key') && e.code !== 'Space' && e.code !== 'ArrowUp' && e.code !== 'KeyW') return;
        if (e.cancelable && !e.type.startsWith('key')) e.preventDefault();

        if (val) {
          if (this.state === 'TITLE' || this.state === 'GAMEOVER') this.startNewGame();
          this.isThrusting = true;
        } else {
          this.isThrusting = false;
        }
      };

      window.addEventListener('keydown', e => onAction(e, true));
      window.addEventListener('keyup', e => onAction(e, false));
      this.canvas.addEventListener('mousedown', e => onAction(e, true));
      window.addEventListener('mouseup', e => onAction(e, false));
      this.canvas.addEventListener('touchstart', e => onAction(e, true), { passive: false });
      window.addEventListener('touchend', e => onAction(e, false), { passive: false });
      window.addEventListener('touchcancel', e => onAction(e, false), { passive: false });

      this.themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    isRamBit(worldX, y) {
      return (((worldX * 19 + y * 31) ^ (worldX >> 1) ^ (y << 2)) & 3) !== 0;
    }

    drawColumnToBuffer(screenX, col, worldX) {
      this.vCtx.fillStyle = this.theme.bg;
      this.vCtx.fillRect(screenX, 0, 1, H);

      // Top Cave Wall (strictly original ink)
      this.vCtx.fillStyle = this.theme.ink;
      if (col.topY > 0) {
        this.vCtx.fillRect(screenX, col.topY - 1, 1, 1);
        for (let y = 0; y < col.topY - 1; y++) {
          if (this.isRamBit(worldX, y)) this.vCtx.fillRect(screenX, y, 1, 1);
        }
      }

      // Bottom Cave Wall (strictly original ink)
      if (col.bottomY < H) {
        this.vCtx.fillRect(screenX, col.bottomY, 1, 1);
        for (let y = col.bottomY + 1; y < H; y++) {
          if (this.isRamBit(worldX, y)) this.vCtx.fillRect(screenX, y, 1, 1);
        }
      }

      // Obstacle (strictly original ink)
      if (col.obstacle) {
        this.vCtx.fillRect(screenX, col.obstacle.y, 1, col.obstacle.height);
      }
    }

    initWorld() {
      this.vCtx.fillStyle = this.theme.bg;
      this.vCtx.fillRect(0, 0, W, H);

      this.columnData = [];
      this.centerY = H / 2;
      this.targetCenterY = H / 2;
      this.centerTimer = 0;
      this.activeObstacle = null;
      this.obstacleCooldown = 80;

      const gap = this.currentLevel.gap;
      for (let x = 0; x < W; x++) {
        const col = {
          topY: Math.round((H - gap) / 2),
          bottomY: Math.round((H + gap) / 2),
          obstacle: null
        };
        this.columnData.push(col);
        this.drawColumnToBuffer(x, col, x);
      }

      // Initial trail (darker intermediate color) and active paddle (ink) in screen buffer
      this.vCtx.fillStyle = this.theme.trail;
      this.vCtx.fillRect(0, Math.round(this.playerY - HALF_H), PLAYER_X, AVATAR_H);
      this.vCtx.fillStyle = this.theme.ink;
      this.vCtx.fillRect(PLAYER_X, Math.round(this.playerY - HALF_H), AVATAR_W, AVATAR_H);
    }

    startNewGame() {
      this.state = 'PLAYING';
      this.distance = 0;
      this.scrollTicks = 0;
      this.playerY = H / 2;
      this.prevPlayerY = H / 2;
      this.playerVy = 0;
      this.isThrusting = false;
      this.isNewRecord = false;
      this.crashTimer = 0;
      this.explosionRays = [];

      this.levelIdx = 0;
      this.currentLevel = LEVELS[0];
      this.levelNoticeTimer = 0;

      this.initWorld();
      this.updateHud(true);
    }

    updateProgression() {
      const dist = Math.floor(this.distance);
      let newIdx = 0;
      for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (dist >= LEVELS[i].minScore) {
          newIdx = i;
          break;
        }
      }
      if (newIdx !== this.levelIdx) {
        this.levelIdx = newIdx;
        this.currentLevel = LEVELS[this.levelIdx];
        this.levelNoticeTimer = 90;
        this.updateHud(true);
      }
    }

    generateNextColumn() {
      const lvl = this.currentLevel;
      const gap = lvl.gap;

      if (this.centerTimer <= 0) {
        const margin = gap / 2 + 16;
        this.targetCenterY = margin + Math.random() * (H - margin * 2);
        this.centerTimer = 25 + Math.floor(Math.random() * 35);
      } else {
        this.centerTimer--;
      }

      const delta = this.targetCenterY - this.centerY;
      this.centerY += Math.max(-lvl.maxSlope, Math.min(lvl.maxSlope, delta * 0.08));

      const topY = Math.max(6, Math.round(this.centerY - gap / 2));
      const bottomY = Math.min(H - 6, Math.round(this.centerY + gap / 2));

      let obsSlice = null;
      if (this.activeObstacle) {
        this.activeObstacle.currentCol++;
        obsSlice = { y: this.activeObstacle.y, height: this.activeObstacle.height };
        if (this.activeObstacle.currentCol === this.activeObstacle.width) {
          this.activeObstacle = null;
          this.obstacleCooldown = 75 + Math.floor(Math.random() * 45);
        }
      } else {
        if (this.obstacleCooldown <= 0) {
          const room = bottomY - topY;
          const maxObsH = room - lvl.minPassage;
          if (maxObsH >= 16 && Math.random() < lvl.obsChance) {
            const obsH = Math.round(16 + Math.random() * (maxObsH - 16));
            const obsY = (Math.random() < 0.5) ? topY : (bottomY - obsH);
            this.activeObstacle = { y: obsY, height: obsH, width: 10, currentCol: 1 };
            obsSlice = { y: obsY, height: obsH };
          }
        } else {
          this.obstacleCooldown--;
        }
      }

      return { topY, bottomY, obstacle: obsSlice };
    }

    triggerCrash(hitX, hitY) {
      this.state = 'CRASHING';
      this.crashX = hitX;
      this.crashY = hitY;
      this.crashTimer = 120; // 2 seconds

      const finalScore = Math.floor(this.distance);
      if (finalScore > this.highScore) {
        this.isNewRecord = true;
        this.saveBest(finalScore);
      }

      this.explosionRays = [];
      const numRays = 140;
      for (let i = 0; i < numRays; i++) {
        const angle = (i / numRays) * Math.PI * 2;
        const baseLen = 50 + (i % 5) * 45 + Math.random() * 40;
        this.explosionRays.push({ angle, baseLen });
      }
    }

    stepSimulation() {
      if (this.state === 'CRASHING') {
        this.crashTimer--;
        if (this.crashTimer <= 0) this.state = 'GAMEOVER';
        return;
      }
      if (this.state !== 'PLAYING') return;

      this.scrollTicks++;
      this.distance += 0.25;
      this.updateProgression();
      this.updateHud(false);

      if (this.levelNoticeTimer > 0) this.levelNoticeTimer--;

      // 1. Vertical floaty inertia
      this.prevPlayerY = this.playerY;
      this.playerVy += (this.isThrusting ? THRUST : GRAVITY);
      this.playerVy = Math.max(-MAX_VY, Math.min(MAX_VY, this.playerVy));
      this.playerY += this.playerVy;

      // 2. Shift the video buffer 1px left
      this.sCtx.drawImage(this.videoBuffer, 0, 0);
      this.vCtx.drawImage(this.shiftBuffer, -1, 0);

      // 3. Compose rightmost column (strictly original ink)
      this.columnData.shift();
      const newCol = this.generateNextColumn();
      this.columnData.push(newCol);
      this.drawColumnToBuffer(W - 1, newCol, this.scrollTicks + W);

      // 4. "Cheat" when shifting left:
      // Recolor the paddle that was just shifted to PLAYER_X - 1 with the darker trail color!
      const curTop = Math.round(this.playerY - HALF_H);
      const prevTop = Math.round(this.prevPlayerY - HALF_H);
      const minY = Math.min(curTop, prevTop);
      const maxY = Math.max(curTop, prevTop) + AVATAR_H;

      this.vCtx.fillStyle = this.theme.trail;
      this.vCtx.fillRect(PLAYER_X - 1, minY, AVATAR_W, maxY - minY);

      // 5. Over that, draw the real paddle in ink last!
      this.vCtx.fillStyle = this.theme.ink;
      this.vCtx.fillRect(PLAYER_X, curTop, AVATAR_W, AVATAR_H);

      // 6. Collision Check for full 16x4 paddle
      const avatarTop = this.playerY - HALF_H;
      const avatarBottom = this.playerY + HALF_H;
      let hit = false, hitX = PLAYER_X + AVATAR_W, hitY = this.playerY;

      if (avatarTop <= 2 || avatarBottom >= H - 2) {
        hit = true;
        hitY = Math.max(3, Math.min(H - 3, this.playerY));
      }

      if (!hit) {
        for (let x = PLAYER_X; x <= PLAYER_X + AVATAR_W; x++) {
          const col = this.columnData[x];
          if (col) {
            if (avatarTop <= col.topY) { hit = true; hitX = x; hitY = col.topY; break; }
            if (avatarBottom >= col.bottomY) { hit = true; hitX = x; hitY = col.bottomY; break; }
            if (col.obstacle) {
              const obs = col.obstacle;
              if (avatarBottom >= obs.y && avatarTop <= obs.y + obs.height) {
                hit = true; hitX = x; hitY = this.playerY; break;
              }
            }
          }
        }
      }

      if (hit) this.triggerCrash(hitX, hitY);
    }

    render() {
      // Direct video buffer blit (paddle in ink & trail in darker intermediate color)
      this.ctx.drawImage(this.videoBuffer, 0, 0);

      // Calm 2-second explosion animation (strictly ink & bg)
      if (this.state === 'CRASHING' || this.state === 'GAMEOVER') {
        const phase = Math.floor(this.crashTimer / 30) % 2;
        const growth = Math.min(1.0, (120 - this.crashTimer) / 40);
        this.ctx.lineWidth = 1.5;

        for (let i = 0; i < this.explosionRays.length; i++) {
          const ray = this.explosionRays[i];
          const isInk = (i % 2 === phase);
          this.ctx.strokeStyle = isInk ? this.theme.ink : this.theme.bg;
          const rLen = ray.baseLen * growth;
          this.ctx.beginPath();
          this.ctx.moveTo(this.crashX, this.crashY);
          this.ctx.lineTo(this.crashX + Math.cos(ray.angle) * rLen, this.crashY + Math.sin(ray.angle) * rLen);
          this.ctx.stroke();
        }
      }

      // In-Game Level Notice
      if (this.levelNoticeTimer > 0 && this.state === 'PLAYING') {
        renderPixelText(this.ctx, 'LEVEL ' + this.currentLevel.level, 116, 30, 2, this.theme.ink);
      }

      // Overlays (strictly original ink and bg)
      if (this.state === 'TITLE') {
        renderPixelText(this.ctx, 'COOLCAVE', 80, 68, 4, this.theme.ink);
        renderPixelText(this.ctx, 'HOLD [SPACE] / CLICK TO FLY', 61, 130, 2, this.theme.ink);
        renderPixelText(this.ctx, 'RELEASE TO DRIFT DOWN', 42, 155, 2, this.theme.ink);
      } else if (this.state === 'GAMEOVER') {
        const bw = 176, bh = 100, bx = (W - bw) / 2, by = (H - bh) / 2;
        this.ctx.fillStyle = this.theme.bg;
        this.ctx.fillRect(bx, by, bw, bh);

        this.ctx.fillStyle = this.theme.ink;
        this.ctx.fillRect(bx + 16, by + 8, bw - 32, 18);
        renderPixelText(this.ctx, 'GAME OVER', bx + 40, by + 12, 2, this.theme.bg);

        const curScore = Math.floor(this.distance);
        renderPixelText(this.ctx, 'SCORE: ' + curScore, bx + 42, by + 34, 2, this.theme.ink);

        if (this.isNewRecord) {
          renderPixelText(this.ctx, '* NEW RECORD! *', bx + 28, by + 50, 2, this.theme.ink);
        } else {
          renderPixelText(this.ctx, 'BEST:  ' + this.highScore, bx + 42, by + 50, 2, this.theme.ink);
        }

        renderPixelText(this.ctx, 'REACHED LVL ' + this.currentLevel.level, bx + 36, by + 68, 1, this.theme.ink);
        renderPixelText(this.ctx, 'TAP / [SPACE] TO RETRY', bx + 22, by + 82, 1, this.theme.ink);
      }
    }

    loop() {
      this.stepSimulation();
      // Only for levels > 4: subtle extra tick rate for gradual speedup, level 1-4 untouched
      if (this.state === 'PLAYING' && this.currentLevel.extraTickRate) {
        this.extraAccum += this.currentLevel.extraTickRate;
        if (this.extraAccum >= 1.0) {
          this.extraAccum -= 1.0;
          this.stepSimulation();
        }
      }
      this.render();
      requestAnimationFrame(this.loop.bind(this));
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.coolcave = new CoolCave();
  });
})();
