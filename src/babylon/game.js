import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera.js";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer.js";
import SimplexNoise from "simplex-noise";

import { CHUNK_SIZE, PERFORMANCE, KEY_BINDS } from "./constants.js";
import { iconUris, prewarmTextures, getBlockTexture } from "./textures.js";
import { createTerrainSystem } from "./terrain.js";

// Physics tuning constants (module-level so helper functions can access them)
const GRAVITY = 1.2; // units per second^2
const JUMP_VELOCITY = 0.35; // initial upward velocity when jumping

export async function startGame() {
  const canvas = getOrCreateCanvas();
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, disableWebGL2Support: false });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.81, 0.92, 1.0);
  scene.collisionsEnabled = true;
  // physics constants are module-level

  const terrainNoise = new SimplexNoise();
  let needsVisibleRefresh = true;
  const terrain = createTerrainSystem({
    scene,
    noise: terrainNoise,
    getTexture: getBlockTexture,
    markVisibleDirty: () => { needsVisibleRefresh = true; },
  });

  const PLAYER_HALF_WIDTH = 0.35;
  const PLAYER_HALF_HEIGHT = 1.2; // taller player
  const camera = new UniversalCamera("camera", new Vector3(0, 10, 0), scene);
  camera.attachControl(canvas, true);
  camera.minZ = 0.1;
  camera.fov = Math.PI / 3;
  camera.speed = 0.35;
  camera.angularSensibility = 2000;
  camera.checkCollisions = false;
  camera.applyGravity = false;
  camera.ellipsoid = new Vector3(PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT, PLAYER_HALF_WIDTH);
  camera.keysUp = [];
  camera.keysDown = [];
  camera.keysLeft = [];
  camera.keysRight = [];

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.9;
  hemi.diffuse = new Color3(0.95, 0.95, 0.95);
  hemi.groundColor = new Color3(0.25, 0.25, 0.3);

  const sun = new DirectionalLight("sun", new Vector3(-0.35, -1, -0.2), scene);
  sun.position = new Vector3(50, 100, 50);
  sun.intensity = PERFORMANCE.shadows ? 1.1 : 0.8;
  sun.shadowEnabled = PERFORMANCE.shadows;
  sun.specular = new Color3(0.9, 0.85, 0.8);

  prewarmTextures(scene);
  terrain.generateChunksImmediate(0, 0, 2);
  // Lighting: shadow generator and subtle bloom/glow
  let shadowGen = null;
  if (PERFORMANCE.shadows) {
    shadowGen = new ShadowGenerator(2048, sun);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 8;
    shadowGen.usePoissonSampling = true;
  }
  if (shadowGen && typeof terrain.registerShadowGenerator === 'function') terrain.registerShadowGenerator(shadowGen);

  // subtle glow layer for highlights
  try { new GlowLayer('glow', scene, { mainTextureSamples: 1 }).intensity = 0.2; } catch (e) { /* ignore if not available */ }

  // fog for depth and atmosphere
  scene.fogMode = 2; // exponential
  scene.fogDensity = PERFORMANCE.lowQualityMode ? 0.003 : 0.006;
  scene.fogColor = new Color3(0.53, 0.81, 0.92);
  syncSpawn(camera, terrain);
  terrain.ensureChunksAroundPlayer(camera.position);

  const ui = bindUi({ scene, camera, terrain, engine, canvas, sun });
  ui.updateInventoryHUD();

  // Create a simple viewmodel hand / block holder
  let hand = null;
  let handMat = null;
  let lastHotbar = ui.hotbarSelected();
  try {
    hand = MeshBuilder.CreateBox('hand', { size: 0.5 }, scene);
    hand.parent = camera;
    hand.position = new Vector3(0.6, -0.6, 1.2);
    hand.rotation = new Vector3(-0.2, 0.4, 0);
    handMat = new StandardMaterial('handMat', scene);
    handMat.diffuseColor = new Color3(0.8, 0.6, 0.4);
    hand.material = handMat;
    hand.isPickable = false;
    hand.alwaysSelectAsActiveMesh = true;
  } catch (e) { hand = null; }

  // quick debug ground so the scene isn't completely empty while diagnosing
  try {
    const debugMat = new StandardMaterial("debugMat", scene);
    debugMat.diffuseColor = new Color3(0.2, 0.6, 0.2);
    const debugGround = MeshBuilder.CreateGround("debugGround", { width: 200, height: 200 }, scene);
    debugGround.position.y = -2;
    debugGround.material = debugMat;
    debugGround.isPickable = false;
  } catch (e) {
    // ignore if imports not available
  }

  // status overlay to help debug generation and meshes
  const statusDiv = document.createElement('div');
  statusDiv.style.position = 'fixed';
  statusDiv.style.left = '8px';
  statusDiv.style.top = '8px';
  statusDiv.style.padding = '6px 8px';
  statusDiv.style.background = 'rgba(0,0,0,0.6)';
  statusDiv.style.color = 'white';
  statusDiv.style.fontFamily = 'monospace';
  statusDiv.style.zIndex = '50';
  statusDiv.style.fontSize = '12px';
  document.body.appendChild(statusDiv);
  // status interval moved below until movement state variables are initialized

  // highlight lines for the targeted block (single reusable Lines mesh)
  let highlightLines = null;
  let lastTargetKey = null;

  let prevTime = performance.now();
  let smoothedFrameMs = 16.7;
  let lastCullingUpdate = 0;
  let lastRayUpdate = 0;
  let lastSkyUpdate = 0;
  let targetPixelRatio = Math.min(window.devicePixelRatio, PERFORMANCE.lowQualityMode ? 1.25 : 2);
  let currentPixelRatio = targetPixelRatio;
  engine.setHardwareScalingLevel(1 / currentPixelRatio);

  const gravityVelocity = new Vector3(0, 0, 0);
  let canJump = true;
  // debug movement state
  let lastMove = new Vector3(0, 0, 0);
  let collisionEvents = 0;

  // status overlay updater (references movement state)
  setInterval(() => {
    const pos = camera.position;
    statusDiv.innerText = `chunks=${terrain.chunkMeshes.size} blocks=${terrain.blockMap.size} pos=${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} vel=${gravityVelocity.y.toFixed(2)} canJump=${canJump} move=${lastMove.x.toFixed(2)},${lastMove.y.toFixed(2)},${lastMove.z.toFixed(2)} collisions=${collisionEvents}`;
  }, 250);

  const pressed = new Set();
  window.addEventListener("keydown", (ev) => {
    pressed.add(ev.code);
    if (ev.code === KEY_BINDS.jump && canJump) {
      gravityVelocity.y = JUMP_VELOCITY;
      canJump = false;
    }
    if (ev.code === KEY_BINDS.inventory) ui.toggleInventory();
    if (ev.code.startsWith("Digit")) ui.selectHotbar(parseInt(ev.code.replace("Digit", ""), 10) - 1);
  });
  window.addEventListener("keyup", (ev) => pressed.delete(ev.code));
  window.addEventListener("mousedown", (ev) => {
    if (ev.button === 0) performBlockAction("break", { scene, camera, terrain, ui });
    if (ev.button === 2) performBlockAction("place", { scene, camera, terrain, ui });
  });
  window.addEventListener("contextmenu", (ev) => ev.preventDefault());

  bindMenu({ ui, terrain, camera, engine, canvas, scene, pressed });

  // movement and collision helpers (scoped so they can access local state like
  // `PLAYER_HALF_WIDTH`, `lastMove`, and `collisionEvents` without relying on
  // module-level hoisting)
  function collidesAt(position, terrain) {
    const halfWidth = PLAYER_HALF_WIDTH;
    const halfHeight = PLAYER_HALF_HEIGHT;
    const minX = Math.floor(position.x - halfWidth);
    const maxX = Math.floor(position.x + halfWidth);
    const minY = Math.floor(position.y - halfHeight);
    const maxY = Math.floor(position.y + halfHeight);
    const minZ = Math.floor(position.z - halfWidth);
    const maxZ = Math.floor(position.z + halfWidth);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (terrain.getBlockType(x, y, z)) {
            collisionEvents++;
            return true;
          }
        }
      }
    }
    return false;
  }

  function updateMovement(camera, terrain, pressed, gravityVelocity, deltaSeconds, setCanJump) {
    const speed = 4.5 * deltaSeconds;
    const forwardDir = camera.getDirection(Vector3.Forward()).normalize();
    // compute right-hand vector as cross(up, forward) so signs are consistent
    const right = Vector3.Cross(Vector3.Up(), forwardDir).normalize();
    const move = new Vector3();
    // forward should move along the camera's forward vector
    if (pressed.has(KEY_BINDS.forward)) move.addInPlace(forwardDir);
    if (pressed.has(KEY_BINDS.backward)) move.subtractInPlace(forwardDir);
    if (pressed.has(KEY_BINDS.left)) move.subtractInPlace(right);
    if (pressed.has(KEY_BINDS.right)) move.addInPlace(right);
    move.y = 0;
    try { lastMove.copyFrom(move); } catch (e) { /* ignore if not available */ }
    if (move.lengthSquared() > 0) move.normalize().scaleInPlace(speed);

    gravityVelocity.y -= GRAVITY * deltaSeconds;
    const next = camera.position.clone();

    next.x += move.x;
    if (!collidesAt(next, terrain)) camera.position.x = next.x;

    next.copyFrom(camera.position);
    next.z += move.z;
    if (!collidesAt(next, terrain)) camera.position.z = next.z;

    next.copyFrom(camera.position);
    next.y += gravityVelocity.y;
    if (!collidesAt(next, terrain)) {
      camera.position.y = next.y;
      setCanJump(false);
    } else {
      if (gravityVelocity.y < 0) gravityVelocity.y = 0;
      setCanJump(true);
    }

    if (camera.position.y < -20) camera.position.y = 20;
  }

  engine.runRenderLoop(() => {
    const now = performance.now();
    const rawDelta = (now - prevTime) / 1000;
    const frameMs = rawDelta * 1000;
    smoothedFrameMs = smoothedFrameMs * 0.9 + frameMs * 0.1;
    prevTime = now;

    terrain.flushDirtyChunks();

    if (PERFORMANCE.adaptiveRes && now - lastCullingUpdate > 1000) {
      if (smoothedFrameMs > 23) targetPixelRatio = Math.max(0.7, targetPixelRatio - 0.1);
      else if (smoothedFrameMs < 16) targetPixelRatio = Math.min(window.devicePixelRatio, targetPixelRatio + 0.1);
      if (Math.abs(targetPixelRatio - currentPixelRatio) >= 0.05) {
        currentPixelRatio = targetPixelRatio;
        engine.setHardwareScalingLevel(1 / currentPixelRatio);
      }
    }

    if (now - lastSkyUpdate > 100) {
      const dayT = ((now / 120000) % 1) * Math.PI * 2;
      const sunHeight = Math.sin(dayT);
      sun.direction = new Vector3(Math.cos(dayT), -Math.max(0.15, Math.sin(dayT)), Math.sin(dayT));
      hemi.intensity = 0.25 + Math.max(0, sunHeight) * 0.75;
      const skyStrength = Math.max(0.35, 0.7 + sunHeight * 0.2);
      scene.clearColor = new Color4(0.53 * skyStrength, 0.81 * skyStrength, 0.92 * skyStrength, 1.0);
      lastSkyUpdate = now;
    }

    if (now - lastCullingUpdate > 1000) {
      terrain.ensureChunksAroundPlayer(camera.position);
      lastCullingUpdate = now;
    }

    if (needsVisibleRefresh) {
      ui.refreshPickTargets();
      needsVisibleRefresh = false;
    }
    // update block highlight (ray from camera center)
    try {
      const pickRay = camera.getForwardRay(6);
      const pick = scene.pickWithRay(pickRay, (mesh) => mesh && mesh.isPickable);
      if (pick?.hit && pick.pickedPoint) {
        const point = pick.pickedPoint;
        const normal = typeof pick.getNormal === "function"
          ? (pick.getNormal(true) || pick.getNormal(false) || pickRay.direction.scale(-1))
          : pickRay.direction.scale(-1);
        function axisTarget(coord, n) {
          const base = Math.floor(coord);
          if (n > 0.5) return base - 1; // clicked +face -> base is at next integer
          if (n < -0.5) return base;  // clicked -face -> base is at integer
          return base; // no strong normal on this axis
        }
        // For highlighting we want the block that was hit (the block being pointed at)
        const tx = axisTarget(point.x + 0.00001, normal.x);
        const ty = axisTarget(point.y + 0.00001, normal.y);
        const tz = axisTarget(point.z + 0.00001, normal.z);
        const key = `${tx},${ty},${tz}`;
        // only show highlight if there is actually a block at the targeted coords
        if (!terrain.getBlockType(tx, ty, tz)) {
          lastTargetKey = null;
          if (highlightLines) { highlightLines.dispose(); highlightLines = null; }
        } else if (key !== lastTargetKey) {
          lastTargetKey = key;
          if (highlightLines) {
            highlightLines.dispose();
            highlightLines = null;
          }
          const x = tx + 0.5;
          const y = ty + 0.5;
          const z = tz + 0.5;
          const s = 0.5;
          const corners = [
            new Vector3(x - s, y - s, z - s),
            new Vector3(x + s, y - s, z - s),
            new Vector3(x + s, y + s, z - s),
            new Vector3(x - s, y + s, z - s),
            new Vector3(x - s, y - s, z + s),
            new Vector3(x + s, y - s, z + s),
            new Vector3(x + s, y + s, z + s),
            new Vector3(x - s, y + s, z + s),
          ];
          const lines = [
            corners[0], corners[1], corners[2], corners[3], corners[0],
            corners[4], corners[5], corners[6], corners[7], corners[4],
            corners[5], corners[1], corners[2], corners[6], corners[7], corners[3]
          ];
          // create lines mesh
          highlightLines = MeshBuilder.CreateLines("highlightLines", { points: lines, updatable: false, instance: null }, scene);
          if (highlightLines) highlightLines.color = new Color3(1, 1, 1);
        }
      } else {
        lastTargetKey = null;
        if (highlightLines) { highlightLines.dispose(); highlightLines = null; }
      }
    } catch (e) {
      // ignore picking exceptions
    }

    updateMovement(camera, terrain, pressed, gravityVelocity, rawDelta, canJumpRef => { canJump = canJumpRef; });
    terrain.ensureChunksAroundPlayer(camera.position);
    // update viewmodel hand texture and simple bobbing animation
    try {
      if (hand) {
        const selected = ui.hotbarSelected();
        if (selected !== lastHotbar) {
          lastHotbar = selected;
          const item = ui.inventory ? ui.inventory[selected] : null;
          const texType = item ? (item.type === 'grass' ? 'grass_side' : (item.type === 'wood' ? 'wood_side' : item.type)) : null;
          if (texType) handMat.diffuseTexture = getBlockTexture(scene, texType);
          else handMat.diffuseTexture = null;
        }
        const moveMag = Math.min(1, Math.sqrt(lastMove.lengthSquared()));
        const t = performance.now();
        const bob = Math.sin(t * 0.006) * 0.02 * moveMag;
        hand.position.y = -0.6 + bob;
        hand.rotation.x = -0.2 + Math.sin(t * 0.004) * 0.02 * moveMag;
        hand.rotation.z = 0.4 + Math.cos(t * 0.005) * 0.02 * moveMag;
      }
    } catch (e) { /* ignore viewmodel errors */ }
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

function getOrCreateCanvas() {
  let canvas = document.getElementById("renderCanvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "renderCanvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    document.body.prepend(canvas);
  }
  return canvas;
}

function syncSpawn(camera, terrain) {
  const top = terrain.findHighestBlockNearby(0, 0, 2) ?? terrain.getTerrainHeight(0, 0);
  camera.position.set(0, top + 4, 0);
}

function bindMenu({ ui, terrain, camera, engine, canvas, scene, pressed }) {
  const blocker = document.getElementById("blocker");
  const menuMain = document.getElementById("menu-main");
  const menuOptions = document.getElementById("menu-options");
  const menuGraphics = document.getElementById("menu-graphics");
  const menuControls = document.getElementById("menu-controls");
  const showMenu = (menu) => {
    [menuMain, menuOptions, menuGraphics, menuControls].forEach((m) => { if (m) m.style.display = "none"; });
    if (menu) {
      // clear input state when showing a menu to avoid stuck movement
      pressed.clear();
      menu.style.display = "flex";
    }
  };

  document.getElementById("btn-resume")?.addEventListener("click", () => canvas.requestPointerLock());
  document.getElementById("btn-options")?.addEventListener("click", () => showMenu(menuOptions));
  document.getElementById("btn-exit")?.addEventListener("click", () => {
    terrain.clearWorld();
    terrain.generateChunksImmediate(0, 0, 2);
    syncSpawn(camera, terrain);
    ui.updateInventoryHUD();
    canvas.requestPointerLock();
  });
  document.getElementById("btn-graphics")?.addEventListener("click", () => showMenu(menuGraphics));
  document.getElementById("btn-controls")?.addEventListener("click", () => showMenu(menuControls));
  document.getElementById("btn-options-done")?.addEventListener("click", () => showMenu(menuMain));
  document.getElementById("btn-graphics-done")?.addEventListener("click", () => showMenu(menuOptions));
  document.getElementById("btn-controls-done")?.addEventListener("click", () => showMenu(menuOptions));

  const slider = document.getElementById("graphics-render-distance");
  const label = document.getElementById("lbl-render-distance");
  if (slider && label) {
    slider.min = "2";
    slider.max = "16";
    slider.step = "1";
    slider.value = "6";
    label.innerText = "6 chunks";
    slider.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      label.innerText = `${value} chunks`;
    });
  }

  window.addEventListener("blur", () => { if (blocker) blocker.style.display = "flex"; pressed.clear(); showMenu(menuMain); });
  canvas.addEventListener("click", () => canvas.requestPointerLock());

  // Hide/show blocker based on pointer lock state so menu can be dismissed properly
  function onPointerLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      if (blocker) blocker.style.display = "none";
    } else {
      if (blocker) blocker.style.display = "flex";
      pressed.clear();
      showMenu(menuMain);
    }
  }
  document.addEventListener("pointerlockchange", onPointerLockChange);
  // ensure initial state reflects whether pointer is locked
  onPointerLockChange();
}

function bindUi({ scene, terrain, canvas }) {
  const hotbar = document.getElementById("hotbar");
  const hotbarName = document.getElementById("hotbar-name");
  const invScreen = document.getElementById("inventory-screen");
  const invGrid = document.getElementById("inventory-grid");
  const invHotbarGrid = document.getElementById("inventory-hotbar-grid");
  const inventory = Array(36).fill(null);
  inventory[0] = { type: "grass", count: 64 };
  inventory[1] = { type: "dirt", count: 64 };
  inventory[2] = { type: "stone", count: 64 };
  inventory[3] = { type: "wood", count: 64 };
  inventory[4] = { type: "leaves", count: 64 };
  inventory[5] = { type: "sand", count: 64 };
  inventory[6] = { type: "brick", count: 64 };
  inventory[7] = { type: "glass", count: 64 };
  // add a few more starter items
  inventory[8] = { type: "brick", count: 32 };
  inventory[9] = { type: "glass", count: 16 };
  inventory[10] = { type: "sand", count: 64 };
  let hotbarSelected = 0;
  let isInventoryOpen = false;
  let selectedInventorySlot = null;
  let visibleTargets = [];
  // drag state for inventory
  let dragging = null; // { index, item }
  let dragElem = null;

  function updateInventoryHUD() {
    if (!hotbar) return;
    hotbar.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement("div");
      const slotNum = document.createElement('div');
      slotNum.className = 'slot-number';
      slotNum.innerText = String(i + 1);
      slot.className = `slot ${i === hotbarSelected ? "active" : ""}`;
      slot.dataset.index = String(i);
      slot.appendChild(slotNum);
      const item = inventory[i];
      if (item) {
        const displayType = item.type === "grass" ? "grass_side" : item.type === "wood" ? "wood_side" : item.type;
        if (iconUris[displayType]) slot.style.backgroundImage = `url(${iconUris[displayType]})`;
        const count = document.createElement("div");
        count.className = "slot-count";
        count.innerText = item.count;
        slot.appendChild(count);
        if (i === hotbarSelected) hotbarName.innerText = item.type.toUpperCase();
      } else if (i === hotbarSelected) {
        hotbarName.innerText = "";
      }
      // attach drag start
      slot.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        if (!inventory[i]) return;
        dragging = { index: i, item: { ...inventory[i] } };
        dragElem = document.createElement("div");
        dragElem.style.position = "fixed";
        dragElem.style.left = `${ev.clientX + 8}px`;
        dragElem.style.top = `${ev.clientY + 8}px`;
        dragElem.style.width = "44px";
        dragElem.style.height = "44px";
        dragElem.style.pointerEvents = "none";
        dragElem.style.zIndex = "10000";
        dragElem.style.backgroundRepeat = "no-repeat";
        dragElem.style.backgroundPosition = "center";
        dragElem.style.backgroundSize = "contain";
        dragElem.style.imageRendering = "pixelated";
        dragElem.style.opacity = "0.98";
        const displayType = inventory[i].type === "grass" ? "grass_side" : inventory[i].type === "wood" ? "wood_side" : inventory[i].type;
        if (iconUris[displayType]) dragElem.style.backgroundImage = `url(${iconUris[displayType]})`;
        else { dragElem.style.background = "#666"; dragElem.style.border = "1px solid #222"; }
        // count overlay
        const countOver = document.createElement('div');
        countOver.className = 'drag-count';
        countOver.innerText = String(inventory[i].count || '');
        dragElem.appendChild(countOver);
        document.body.appendChild(dragElem);
      });

      hotbar.appendChild(slot);
    }

    if (isInventoryOpen && invScreen && invGrid && invHotbarGrid) {
      invGrid.innerHTML = "";
      invHotbarGrid.innerHTML = "";
      const makeSlot = (i) => {
        const item = inventory[i];
        const slot = document.createElement("div");
        slot.className = `inv-slot ${selectedInventorySlot === i ? "active" : ""}`;
        slot.dataset.index = String(i);
        if (item) {
          const displayType = item.type === "grass" ? "grass_side" : item.type === "wood" ? "wood_side" : item.type;
          if (iconUris[displayType]) slot.style.backgroundImage = `url(${iconUris[displayType]})`;
          const count = document.createElement("div");
          count.className = "inv-slot-count";
          count.innerText = item.count;
          slot.appendChild(count);
        }
        slot.addEventListener("click", () => {
          if (selectedInventorySlot === null) selectedInventorySlot = i;
          else {
            const temp = inventory[i];
            inventory[i] = inventory[selectedInventorySlot];
            inventory[selectedInventorySlot] = temp;
            selectedInventorySlot = null;
          }
          updateInventoryHUD();
        });

        // drag start for inventory slots
        slot.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          if (!inventory[i]) return;
          dragging = { index: i, item: { ...inventory[i] } };
          dragElem = document.createElement("div");
          dragElem.style.position = "fixed";
          dragElem.style.left = `${ev.clientX + 8}px`;
          dragElem.style.top = `${ev.clientY + 8}px`;
          dragElem.style.width = "44px";
          dragElem.style.height = "44px";
          dragElem.style.pointerEvents = "none";
          dragElem.style.zIndex = "10000";
          dragElem.style.backgroundRepeat = "no-repeat";
          dragElem.style.backgroundPosition = "center";
          dragElem.style.backgroundSize = "contain";
          dragElem.style.imageRendering = "pixelated";
          dragElem.style.opacity = "0.98";
          const displayType = inventory[i].type === "grass" ? "grass_side" : inventory[i].type === "wood" ? "wood_side" : inventory[i].type;
          if (iconUris[displayType]) dragElem.style.backgroundImage = `url(${iconUris[displayType]})`;
          else { dragElem.style.background = "#666"; dragElem.style.border = "1px solid #222"; }
          const countOver = document.createElement('div');
          countOver.className = 'drag-count';
          countOver.innerText = String(inventory[i].count || '');
          dragElem.appendChild(countOver);
          document.body.appendChild(dragElem);
        });
        return slot;
      };
      for (let i = 9; i < 36; i++) invGrid.appendChild(makeSlot(i));
      for (let i = 0; i < 9; i++) invHotbarGrid.appendChild(makeSlot(i));
    }
  }

  // global drag handlers
  document.addEventListener("mousemove", (ev) => {
    if (dragElem) {
      dragElem.style.left = `${ev.clientX + 8}px`;
      dragElem.style.top = `${ev.clientY + 8}px`;
    }
  });
  document.addEventListener("mouseup", (ev) => {
    if (!dragging) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    let targetIndex = null;
    if (el) {
      const slotEl = el.closest('.slot, .inv-slot');
      if (slotEl && slotEl.dataset.index) targetIndex = parseInt(slotEl.dataset.index, 10);
    }
    if (targetIndex === null) {
      // cancelled - leave item where it was
      dragging = null;
      if (dragElem) { dragElem.remove(); dragElem = null; }
      updateInventoryHUD();
      return;
    }
    // perform merge/swap logic
    const src = dragging.index;
    const dst = targetIndex;
    const srcItem = inventory[src];
    const dstItem = inventory[dst];
    if (!dstItem) {
      // move
      inventory[dst] = srcItem;
      inventory[src] = null;
    } else if (dstItem.type === srcItem.type) {
      // merge up to 64
      const capacity = 64;
      const space = capacity - dstItem.count;
      const transfer = Math.min(space, srcItem.count);
      dstItem.count += transfer;
      srcItem.count -= transfer;
      if (srcItem.count <= 0) inventory[src] = null;
    } else {
      // swap
      inventory[src] = dstItem;
      inventory[dst] = srcItem;
    }
    dragging = null;
    if (dragElem) { dragElem.remove(); dragElem = null; }
    updateInventoryHUD();
  });

  function selectHotbar(index) {
    hotbarSelected = Math.max(0, Math.min(8, index));
    updateInventoryHUD();
  }

  function toggleInventory() {
    isInventoryOpen = !isInventoryOpen;
    if (invScreen) invScreen.style.display = isInventoryOpen ? "block" : "none";
    if (isInventoryOpen) document.exitPointerLock?.();
    else canvas.requestPointerLock();
    updateInventoryHUD();
  }

  function refreshPickTargets() {
    visibleTargets = [];
    for (const meshes of terrain.chunkMeshes.values()) visibleTargets.push(...meshes);
  }

  return { inventory, hotbarSelected: () => hotbarSelected, selectHotbar, toggleInventory, updateInventoryHUD, refreshPickTargets };
}

function performBlockAction(mode, { scene, camera, terrain, ui }) {
  // Allow block actions even when pointer isn't locked (easier testing).
  const ray = camera.getForwardRay(6);
  const pick = scene.pickWithRay(ray, (mesh) => mesh && mesh.isPickable);
  if (!pick?.hit || !pick.pickedPoint) return;
  const point = pick.pickedPoint;
  const normal = typeof pick.getNormal === "function"
    ? (pick.getNormal(true) || pick.getNormal(false) || ray.direction.scale(-1))
    : ray.direction.scale(-1);
  function axisTargetForAction(coord, n, mode) {
    const base = Math.floor(coord);
    if (n > 0.5) return mode === 'break' ? base - 1 : base;
    if (n < -0.5) return mode === 'break' ? base : base - 1;
    return base;
  }
  const targetX = axisTargetForAction(point.x + 0.00001, normal.x, mode);
  const targetY = axisTargetForAction(point.y + 0.00001, normal.y, mode);
  const targetZ = axisTargetForAction(point.z + 0.00001, normal.z, mode);
  const key = `${targetX},${targetY},${targetZ}`;

  if (mode === "break") {
    terrain.removeBlock(key);
  } else {
    const item = ui.inventory[ui.hotbarSelected()];
    if (!item || item.count <= 0) return;
    if (terrain.addBlock(targetX, targetY, targetZ, item.type)) {
      item.count -= 1;
      if (item.count === 0) ui.inventory[ui.hotbarSelected()] = null;
    }
  }
  ui.updateInventoryHUD();
}

// movement helpers moved into `startGame` to access local state

function canvasFor(scene) {
  return scene.getEngine().getRenderingCanvas();
}
