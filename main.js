import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import RAPIER from "@dimforge/rapier3d-compat";

import wasmInit, * as wasmModule from "./public/wasm-voxel/wasm_voxel.js";
await wasmInit();
const wasm = wasmModule;
await wasm.init_world();
wasm.init_noise(42); // seed for terrain noise

// ── Block type ↔ WASM ID mapping ──
const BLOCK_IDS = {
  air: 0,
  dirt: 1,
  stone: 2,
  grass: 3,
  wood: 4,
  leaves: 5,
  sand: 6,
  brick: 7,
  glass: 8,
};
const ID_BLOCK = Object.fromEntries(
  Object.entries(BLOCK_IDS).map(([k, v]) => [v, k]),
);
function blockTypeToId(type) {
  return BLOCK_IDS[type] ?? 0;
}
function idToBlockType(id) {
  return ID_BLOCK[id];
}

// ── Texture ID → name (must match Rust face_texture order) ──
const TEXTURE_NAMES = [
  null, // 0 - air/unused
  "dirt", // 1
  "stone", // 2
  "grass_top", // 3
  "grass_side", // 4
  "wood_top", // 5
  "wood_side", // 6
  "leaves", // 7
  "sand", // 8
  "brick", // 9
  "glass", // 10
];

// ── Global Variables ──
let camera, scene, renderer, controls;
let raycaster;
let directionalLight, ambientLight;
let timeOfDay = 0;

// Rapier Physics
let world, characterController, playerBody, playerCollider;
let moveForward = false,
  moveBackward = false,
  moveLeft = false,
  moveRight = false;
let canJump = false;
let renderDistanceChunks = 6;
let isRebinding = false;

const keyBinds = {
  forward: "KeyW",
  backward: "KeyS",
  left: "KeyA",
  right: "KeyD",
  jump: "Space",
  inventory: "KeyE",
  breakBlock: "Mouse0",
  placeBlock: "Mouse2",
  slot1: "Digit1",
  slot2: "Digit2",
  slot3: "Digit3",
  slot4: "Digit4",
  slot5: "Digit5",
  slot6: "Digit6",
  slot7: "Digit7",
  slot8: "Digit8",
  slot9: "Digit9",
};

let prevTime = performance.now();
const velocity = new THREE.Vector3();
let lastInventoryUpdate = 0;
const INVENTORY_UPDATE_THROTTLE = 50;
const PERFORMANCE = { lowQualityMode: true, shadows: false, adaptiveRes: true };
const BASE_PIXEL_RATIO = Math.min(
  window.devicePixelRatio,
  PERFORMANCE.lowQualityMode ? 1.25 : 2,
);
let currentPixelRatio = BASE_PIXEL_RATIO;
let targetPixelRatio = BASE_PIXEL_RATIO;
let smoothedFrameMs = 16.7;
let lastDprEval = 0;

// ── Chunk System ──
const CHUNK_SIZE = 16;
const chunkMeshes = new Map();
const dirtyChunks = new Set();
const generatedChunksJS = new Set();
const visibleObjects = [];
const PHYSICS_CULLING_DISTANCE = 30;
const blockPhysics = new Map();
const materialCache = new Map();

// Preallocated vectors
const _right = new THREE.Vector3();
const _front = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _moveVec = new THREE.Vector3();
const _screenCenter = new THREE.Vector2(0, 0);
let _rapierMovement = null;
let needsVisibleRebuild = true;
let lastPlayerChunkX = NaN;
let lastPlayerChunkZ = NaN;

// ── Texture Generation ──
const iconUris = {};
const textureCache = {};
function generateTexture(type) {
  if (textureCache[type]) return textureCache[type];
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d", { alpha: true });
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let baseColor, noiseColors;
  if (type === "dirt") {
    baseColor = [139, 69, 19];
    noiseColors = [
      [107, 52, 16],
      [155, 86, 32],
    ];
  } else if (type === "stone") {
    baseColor = [128, 128, 128];
    noiseColors = [
      [100, 100, 100],
      [150, 150, 150],
    ];
  } else if (type === "grass_top") {
    baseColor = [85, 170, 85];
    noiseColors = [
      [68, 153, 68],
      [102, 187, 102],
    ];
  } else if (type === "wood_top") {
    baseColor = [139, 90, 43];
    noiseColors = [
      [120, 75, 35],
      [150, 100, 50],
    ];
  } else if (type === "sand") {
    baseColor = [238, 214, 175];
    noiseColors = [
      [200, 180, 140],
      [255, 230, 190],
    ];
  } else if (type === "brick") {
    ctx.fillStyle = "#aaa";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#b22222";
    for (let r = 0; r < 4; r++) {
      let o = r % 2 === 0 ? 0 : -8;
      for (let c = 0; c < 2; c++) ctx.fillRect(c * 16 + o, r * 4, 15, 3);
    }
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = `rgba(0,0,0,0.2)`;
      ctx.fillRect(rand(0, 15), rand(0, 15), 1, 1);
    }
  } else if (type === "glass") {
    ctx.clearRect(0, 0, 16, 16);
    ctx.fillStyle = "rgba(200,220,255,0.4)";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(0, 0, 16, 2);
    ctx.fillRect(0, 14, 16, 2);
    ctx.fillRect(0, 0, 2, 16);
    ctx.fillRect(14, 0, 2, 16);
    ctx.fillRect(2, 2, 4, 4);
  }
  if (type === "grass_side") {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let isG = y < 4 || (y < 6 && Math.random() > 0.5);
        let c = isG
          ? Math.random() > 0.5
            ? [85, 170, 85]
            : [68, 153, 68]
          : Math.random() > 0.5
            ? [139, 69, 19]
            : [107, 52, 16];
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(x, y, 1, 1);
      }
  } else if (type === "wood_side") {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let s = (x + Math.floor(Math.random() * 1.5)) % 4;
        let c = s < 2 ? [107, 66, 38] : [74, 46, 27];
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(x, y, 1, 1);
      }
  } else if (type === "leaves") {
    ctx.fillStyle = `rgb(34,139,34)`;
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 150; i++) {
      let x = rand(0, 15),
        y = rand(0, 15),
        p = Math.random();
      if (p < 0.4) ctx.clearRect(x, y, 1, 1);
      else {
        ctx.fillStyle = p < 0.7 ? "rgb(17,119,17)" : "rgb(50,170,50)";
        ctx.fillRect(x, y, 1, 1);
      }
    }
  } else if (
    ["dirt", "stone", "grass_top", "wood_top", "sand"].includes(type)
  ) {
    ctx.fillStyle = `rgb(${baseColor[0]},${baseColor[1]},${baseColor[2]})`;
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 150; i++) {
      let nc = noiseColors[rand(0, 1)];
      ctx.fillStyle = `rgb(${nc[0]},${nc[1]},${nc[2]})`;
      ctx.fillRect(rand(0, 15), rand(0, 15), 1, 1);
    }
  }
  iconUris[type] = canvas.toDataURL();
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache[type] = texture;
  return texture;
}
const TEX_TYPES = [
  "dirt",
  "stone",
  "grass_top",
  "grass_side",
  "wood_top",
  "wood_side",
  "leaves",
  "sand",
  "brick",
  "glass",
];
// Generate all textures immediately so they exist before first mesh build
TEX_TYPES.forEach(generateTexture);

// ── Chunk Mesh Helper (reads WASM buffer with per-texture groups) ──
function createChunkMeshFromWasm(cx, cz) {
  const buffer = wasm.build_chunk_mesh(cx, cz);
  if (!buffer || buffer.length < 4) return [];

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  let offset = 0;
  const groupCount = view.getUint32(offset, true);
  offset += 4;

  const meshes = [];

  for (let g = 0; g < groupCount; g++) {
    const texId = view.getUint32(offset, true);
    offset += 4;
    const opVC = view.getUint32(offset, true);
    offset += 4;
    const opIC = view.getUint32(offset, true);
    offset += 4;
    const trVC = view.getUint32(offset, true);
    offset += 4;
    const trIC = view.getUint32(offset, true);
    offset += 4;

    const texName = TEXTURE_NAMES[texId] || "dirt";

    const makeMesh = (vertCount, idxCount, transparent) => {
      if (vertCount === 0 || idxCount === 0) return null;
      const vertData = new Float32Array(
        buffer.buffer,
        buffer.byteOffset + offset,
        vertCount * 8,
      );
      offset += vertCount * 8 * 4;
      const idxData = new Uint32Array(
        buffer.buffer,
        buffer.byteOffset + offset,
        idxCount,
      );
      offset += idxCount * 4;

      const geo = new THREE.BufferGeometry();
      const interleaved = new THREE.InterleavedBuffer(vertData, 8);
      geo.setAttribute(
        "position",
        new THREE.InterleavedBufferAttribute(interleaved, 3, 0, false),
      );
      geo.setAttribute(
        "normal",
        new THREE.InterleavedBufferAttribute(interleaved, 3, 3, false),
      );
      geo.setAttribute(
        "uv",
        new THREE.InterleavedBufferAttribute(interleaved, 2, 6, false),
      );
      geo.setIndex(new THREE.Uint32BufferAttribute(idxData, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();

      const matKey = `${texName}|${transparent ? "t" : "o"}`;
      let mat = materialCache.get(matKey);
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({
          map: generateTexture(texName),
          transparent,
          alphaTest: transparent ? 0.1 : 0,
          side: transparent ? THREE.DoubleSide : THREE.FrontSide,
        });
        materialCache.set(matKey, mat);
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = !transparent;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData = { chunkX: cx, chunkZ: cz, isTransparent: transparent };
      return mesh;
    };

    const opaqueMesh = makeMesh(opVC, opIC, false);
    if (opaqueMesh) meshes.push(opaqueMesh);
    const transMesh = makeMesh(trVC, trIC, true);
    if (transMesh) meshes.push(transMesh);
  }

  return meshes;
}

// ── Mark chunks dirty for mesh rebuild ──
function markChunkDirty(wx, wy, wz) {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cz = Math.floor(wz / CHUNK_SIZE);
  dirtyChunks.add(`${cx},${cz}`);
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  if (lx === 0) dirtyChunks.add(`${cx - 1},${cz}`);
  if (lx === CHUNK_SIZE - 1) dirtyChunks.add(`${cx + 1},${cz}`);
  if (lz === 0) dirtyChunks.add(`${cx},${cz - 1}`);
  if (lz === CHUNK_SIZE - 1) dirtyChunks.add(`${cx},${cz + 1}`);
}

function markChunkDirtyByCoords(cx, cz) {
  dirtyChunks.add(`${cx},${cz}`);
}

// ── Flush dirty chunks ──
function flushDirtyChunks() {
  if (dirtyChunks.size === 0) return;
  const MAX_REBUILDS = PERFORMANCE.lowQualityMode ? 1 : 4;
  let rebuilt = 0;
  while (dirtyChunks.size > 0 && rebuilt < MAX_REBUILDS) {
    const key = dirtyChunks.values().next().value;
    dirtyChunks.delete(key);
    const [cx, cz] = key.split(",").map(Number);
    disposeChunkMeshes(key);
    const meshes = createChunkMeshFromWasm(cx, cz);
    meshes.forEach((m) => scene.add(m));
    chunkMeshes.set(key, meshes);
    rebuilt++;
  }
  if (rebuilt > 0) needsVisibleRebuild = true;
}

function disposeChunkMeshes(key) {
  const meshes = chunkMeshes.get(key);
  if (!meshes) return;
  for (const m of meshes) {
    scene.remove(m);
    m.geometry.dispose();
  }
  chunkMeshes.delete(key);
}

function rebuildVisibleObjects() {
  visibleObjects.length = 0;
  const camPos = camera.position;
  const renderDist = renderDistanceChunks * CHUNK_SIZE;
  const frustum = new THREE.Frustum();
  const mat = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  frustum.setFromProjectionMatrix(mat);
  for (const [key, meshes] of chunkMeshes) {
    const [cx, cz] = key.split(",").map(Number);
    const worldX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const worldZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
    const dist = Math.hypot(camPos.x - worldX, camPos.z - worldZ);
    if (dist < renderDist + CHUNK_SIZE) {
      for (const mesh of meshes) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox
          .clone()
          .applyMatrix4(mesh.matrixWorld);
        if (frustum.intersectsBox(box)) visibleObjects.push(mesh);
      }
    }
  }
}

// ── World generation via WASM ──
function generateChunk(cx, cz) {
  if (!generatedChunksJS.has(`${cx},${cz}`)) {
    wasm.generate_chunk(cx, cz);
    generatedChunksJS.add(`${cx},${cz}`);
    markChunkDirtyByCoords(cx, cz);
  }
}

function generateWorld() {
  generateChunksAround(new THREE.Vector3(0, 0, 0));
}

function generateChunksAround(pos) {
  const pcx = Math.floor(pos.x / CHUNK_SIZE);
  const pcz = Math.floor(pos.z / CHUNK_SIZE);
  const radius = Math.max(2, renderDistanceChunks + 1);
  const missing = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      if (!generatedChunksJS.has(`${cx},${cz}`)) {
        const dist = Math.abs(dx) + Math.abs(dz);
        missing.push({ cx, cz, dist });
      }
    }
  }
  missing.sort((a, b) => a.dist - b.dist);
  let budget = PERFORMANCE.lowQualityMode ? 3 : 6;
  if (smoothedFrameMs > 28) budget = Math.max(1, Math.floor(budget / 2));
  for (let i = 0; i < Math.min(budget, missing.length); i++) {
    const { cx, cz } = missing[i];
    generateChunk(cx, cz);
  }
}

function unloadFarChunkMeshes(playerChunkX, playerChunkZ, keepRadius) {
  let removed = false;
  for (const key of chunkMeshes.keys()) {
    const [cx, cz] = key.split(",").map(Number);
    if (
      Math.abs(cx - playerChunkX) > keepRadius ||
      Math.abs(cz - playerChunkZ) > keepRadius
    ) {
      disposeChunkMeshes(key);
      removed = true;
    }
  }
  if (removed) needsVisibleRebuild = true;
}

function ensureChunksAroundPlayer(playerPos) {
  const pcx = Math.floor(playerPos.x / CHUNK_SIZE);
  const pcz = Math.floor(playerPos.z / CHUNK_SIZE);
  const movedChunk = pcx !== lastPlayerChunkX || pcz !== lastPlayerChunkZ;
  generateChunksAround(playerPos);
  const radius = Math.max(2, renderDistanceChunks + 2);
  unloadFarChunkMeshes(pcx, pcz, radius);
  if (movedChunk) {
    needsVisibleRebuild = true;
    lastPlayerChunkX = pcx;
    lastPlayerChunkZ = pcz;
  }
}

// ── Physics helpers ──
function updatePhysicsBodies(playerPos) {
  const halfDist = PHYSICS_CULLING_DISTANCE / 2;
  const px = Math.round(playerPos.x),
    py = Math.round(playerPos.y),
    pz = Math.round(playerPos.z);
  for (let dx = -halfDist; dx <= halfDist; dx++) {
    for (let dy = -halfDist; dy <= halfDist; dy++) {
      for (let dz = -halfDist; dz <= halfDist; dz++) {
        const wx = px + dx,
          wy = py + dy,
          wz = pz + dz;
        const blockId = wasm.get_block(wx, wy, wz);
        if (blockId === 0) continue;
        const key = `${wx},${wy},${wz}`;
        if (blockPhysics.has(key)) continue;
        const neighbors = [
          wasm.get_block(wx + 1, wy, wz),
          wasm.get_block(wx - 1, wy, wz),
          wasm.get_block(wx, wy + 1, wz),
          wasm.get_block(wx, wy - 1, wz),
          wasm.get_block(wx, wy, wz + 1),
          wasm.get_block(wx, wy, wz - 1),
        ];
        const isExposed = neighbors.some((id) => id === 0);
        if (!isExposed) continue;

        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(wx, wy, wz),
        );
        world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), rb);
        blockPhysics.set(key, rb);
      }
    }
  }
  for (const [key, rb] of blockPhysics) {
    const [x, y, z] = key.split(",").map(Number);
    const dist = Math.hypot(x - playerPos.x, y - playerPos.y, z - playerPos.z);
    const neighbors = [
      wasm.get_block(x + 1, y, z),
      wasm.get_block(x - 1, y, z),
      wasm.get_block(x, y + 1, z),
      wasm.get_block(x, y - 1, z),
      wasm.get_block(x, y, z + 1),
      wasm.get_block(x, y, z - 1),
    ];
    const isExposed = neighbors.some((id) => id === 0);
    if (dist >= PHYSICS_CULLING_DISTANCE || !isExposed) {
      world.removeRigidBody(rb);
      blockPhysics.delete(key);
    }
  }
}

// ── Player spawn & world clearing ──
function positionPlayerAtSpawn(x, z) {
  const wx = Math.round(x),
    wz = Math.round(z);
  let highest = null;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = 48; y >= -8; y--) {
        if (wasm.get_block(wx + dx, y, wz + dz) !== 0) {
          if (highest === null || y > highest) highest = y;
          break;
        }
      }
    }
  }
  const spawnY = (highest ?? 0) + 3.5;
  if (playerBody) {
    playerBody.setNextKinematicTranslation({ x, y: spawnY, z });
  }
  controls.getObject().position.set(x, spawnY + 0.8, z);
}

function clearWorld() {
  for (const key of chunkMeshes.keys()) disposeChunkMeshes(key);
  chunkMeshes.clear();
  blockPhysics.forEach((b) => world.removeRigidBody(b));
  blockPhysics.clear();
  dirtyChunks.clear();
  generatedChunksJS.clear();
  wasm.init_world();
  wasm.init_noise(42);
  visibleObjects.length = 0;
  needsVisibleRebuild = true;
  lastPlayerChunkX = NaN;
  lastPlayerChunkZ = NaN;
}

// ── Inventory ──
let inventory = Array(36).fill(null);
let hotbarSelected = 0;
let isInventoryOpen = false;
let selectedInventorySlot = null;

inventory[0] = { type: "grass", count: 64 };
inventory[1] = { type: "dirt", count: 64 };
inventory[2] = { type: "stone", count: 64 };
inventory[3] = { type: "wood", count: 64 };
inventory[4] = { type: "leaves", count: 64 };
inventory[5] = { type: "sand", count: 64 };
inventory[6] = { type: "brick", count: 64 };
inventory[7] = { type: "glass", count: 64 };

function updateHotbarDisplay() {
  const hotbarDiv = document.getElementById("hotbar");
  const nameDiv = document.getElementById("hotbar-name");
  hotbarDiv.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const item = inventory[i];
    const slot = document.createElement("div");
    slot.className = `slot ${i === hotbarSelected ? "active" : ""}`;
    if (item) {
      const displayType =
        item.type === "grass"
          ? "grass_side"
          : item.type === "wood"
            ? "wood_side"
            : item.type;
      if (!iconUris[displayType]) generateTexture(displayType);
      slot.style.backgroundImage = `url(${iconUris[displayType]})`;
      const countDiv = document.createElement("div");
      countDiv.className = "slot-count";
      countDiv.innerText = item.count;
      slot.appendChild(countDiv);
      if (i === hotbarSelected) nameDiv.innerText = item.type.toUpperCase();
    } else if (i === hotbarSelected) {
      nameDiv.innerText = "";
    }
    hotbarDiv.appendChild(slot);
  }
}

function renderInventoryScreen() {
  if (!isInventoryOpen) return;
  const invGrid = document.getElementById("inventory-grid");
  const invHotbarGrid = document.getElementById("inventory-hotbar-grid");
  invGrid.innerHTML = "";
  invHotbarGrid.innerHTML = "";

  const makeSlot = (i) => {
    const item = inventory[i];
    const slot = document.createElement("div");
    slot.className = `inv-slot ${selectedInventorySlot === i ? "active" : ""}`;
    if (item) {
      const displayType =
        item.type === "grass"
          ? "grass_side"
          : item.type === "wood"
            ? "wood_side"
            : item.type;
      if (!iconUris[displayType]) generateTexture(displayType);
      slot.style.backgroundImage = `url(${iconUris[displayType]})`;
      const countDiv = document.createElement("div");
      countDiv.className = "inv-slot-count";
      countDiv.innerText = item.count;
      slot.appendChild(countDiv);
    }
    slot.addEventListener("click", () => {
      if (selectedInventorySlot === null) {
        selectedInventorySlot = i;
      } else {
        const temp = inventory[i];
        inventory[i] = inventory[selectedInventorySlot];
        inventory[selectedInventorySlot] = temp;
        selectedInventorySlot = null;
      }
      updateHotbarDisplay();
      renderInventoryScreen();
    });
    return slot;
  };
  for (let i = 9; i < 36; i++) invGrid.appendChild(makeSlot(i));
  for (let i = 0; i < 9; i++) invHotbarGrid.appendChild(makeSlot(i));
}

function renderInventory() {
  const now = performance.now();
  if (now - lastInventoryUpdate < INVENTORY_UPDATE_THROTTLE) return;
  lastInventoryUpdate = now;
  updateHotbarDisplay();
  if (isInventoryOpen) renderInventoryScreen();
}

function selectHotbarSlot(i) {
  hotbarSelected = i;
  renderInventory();
}

// ── Interaction (WASM raycast) ──
function performInteract(action) {
  if (!controls.isLocked) return;
  const cam = camera;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const hit = wasm.raycast_block(
    cam.position.x,
    cam.position.y,
    cam.position.z,
    dir.x,
    dir.y,
    dir.z,
    5.0,
  );
  if (!hit) return;
  const data = JSON.parse(hit);
  const bx = data.blockX,
    by = data.blockY,
    bz = data.blockZ;
  const [fnx, fny, fnz] = data.faceNormal;

  if (action === "breakBlock") {
    if (by <= -2) return;
    const blockId = wasm.get_block(bx, by, bz);
    if (blockId === 0) return;
    const blockType = idToBlockType(blockId);
    wasm.set_block(bx, by, bz, 0);
    markChunkDirty(bx, by, bz);
    updatePhysicsBodies(camera.position);

    let added = false;
    for (let i = 0; i < 36; i++) {
      if (inventory[i]?.type === blockType && inventory[i].count < 64) {
        inventory[i].count++;
        added = true;
        break;
      }
    }
    if (!added)
      for (let i = 0; i < 36; i++) {
        if (!inventory[i]) {
          inventory[i] = { type: blockType, count: 1 };
          break;
        }
      }
    renderInventory();
  } else if (action === "placeBlock") {
    const item = inventory[hotbarSelected];
    if (!item || item.count <= 0) return;
    const px = bx + fnx,
      py = by + fny,
      pz = bz + fnz;
    const blockId = blockTypeToId(item.type);
    wasm.set_block(px, py, pz, blockId);
    markChunkDirty(px, py, pz);
    updatePhysicsBodies(camera.position);
    item.count--;
    if (item.count === 0) inventory[hotbarSelected] = null;
    renderInventory();
  }
}

// ── UI Helpers ──
function showMenu(menu) {
  [
    document.getElementById("menu-main"),
    document.getElementById("menu-options"),
    document.getElementById("menu-graphics"),
    document.getElementById("menu-controls"),
  ].forEach((m) => (m.style.display = "none"));
  menu.style.display = "flex";
}

function toggleInventory() {
  isInventoryOpen = !isInventoryOpen;
  const invScreen = document.getElementById("inventory-screen");
  const blocker = document.getElementById("blocker");
  if (isInventoryOpen) {
    controls.unlock();
    invScreen.style.display = "block";
    blocker.style.display = "block";
    document.getElementById("menu-main").style.display = "none";
    selectedInventorySlot = null;
    renderInventory();
  } else {
    invScreen.style.display = "none";
    controls.lock();
  }
}

// ── Init & Main Loop ──
let rollOverMesh;
init().then(animate);

async function init() {
  await RAPIER.init();
  world = new RAPIER.World(new RAPIER.Vector3(0.0, -30.0, 0.0));
  _rapierMovement = new RAPIER.Vector3(0, 0, 0);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 10, renderDistanceChunks * CHUNK_SIZE);

  ambientLight = new THREE.AmbientLight(0xeeeeee, 0.6);
  scene.add(ambientLight);
  directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(50, 100, 50);
  directionalLight.castShadow = false;
  scene.add(directionalLight);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );

  renderer = new THREE.WebGLRenderer({
    antialias: !PERFORMANCE.lowQualityMode,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(currentPixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, renderer.domElement);

  // ── Menu and Keybind Setup ──
  const blocker = document.getElementById("blocker");
  const menuMain = document.getElementById("menu-main");
  const menuOptions = document.getElementById("menu-options");
  const menuGraphics = document.getElementById("menu-graphics");
  const menuControls = document.getElementById("menu-controls");

  document.getElementById("btn-resume").addEventListener("click", () => {
    controls.lock();
  });
  document.getElementById("btn-options").addEventListener("click", () => {
    showMenu(menuOptions);
  });
  document.getElementById("btn-exit").addEventListener("click", () => {
    clearWorld();
    generateWorld();
    positionPlayerAtSpawn(0, 0);
    controls.lock();
  });
  document.getElementById("btn-graphics").addEventListener("click", () => {
    showMenu(menuGraphics);
  });
  document.getElementById("btn-controls").addEventListener("click", () => {
    showMenu(menuControls);
  });
  document.getElementById("btn-options-done").addEventListener("click", () => {
    showMenu(menuMain);
  });
  document.getElementById("btn-graphics-done").addEventListener("click", () => {
    showMenu(menuOptions);
  });
  document.getElementById("btn-controls-done").addEventListener("click", () => {
    showMenu(menuOptions);
  });

  // Graphics settings
  const sliderRenderDist = document.getElementById("graphics-render-distance");
  const lblRenderDist = document.getElementById("lbl-render-distance");
  sliderRenderDist.addEventListener("input", (e) => {
    renderDistanceChunks = parseInt(e.target.value, 10);
    lblRenderDist.innerText = `${renderDistanceChunks} chunks`;
    scene.fog.far = renderDistanceChunks * CHUNK_SIZE;
    needsVisibleRebuild = true;
  });

  const btnQuality = document.getElementById("btn-toggle-quality");
  btnQuality.addEventListener("click", () => {
    PERFORMANCE.lowQualityMode = !PERFORMANCE.lowQualityMode;
    btnQuality.innerText = `Graphics: ${PERFORMANCE.lowQualityMode ? "Fast" : "Fancy"}`;
  });
  const btnShadows = document.getElementById("btn-toggle-shadows");
  btnShadows.addEventListener("click", () => {
    PERFORMANCE.shadows = !PERFORMANCE.shadows;
    btnShadows.innerText = `Shadows: ${PERFORMANCE.shadows ? "ON" : "OFF"}`;
    renderer.shadowMap.enabled = PERFORMANCE.shadows;
  });
  const btnAdaptive = document.getElementById("btn-toggle-adaptive-res");
  btnAdaptive.addEventListener("click", () => {
    PERFORMANCE.adaptiveRes = !PERFORMANCE.adaptiveRes;
    btnAdaptive.innerText = `Adaptive Res: ${PERFORMANCE.adaptiveRes ? "ON" : "OFF"}`;
    if (!PERFORMANCE.adaptiveRes) {
      currentPixelRatio = BASE_PIXEL_RATIO;
      renderer.setPixelRatio(currentPixelRatio);
    }
  });

  // Key rebinding
  document.querySelectorAll(".keybind-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      isRebinding = true;
      const targetBtn = e.target;
      const action = targetBtn.getAttribute("data-action");
      targetBtn.innerText = ">";
      const handleKey = (ev) => {
        ev.preventDefault();
        finalize(
          ev.code,
          ev.code === "Space" ? "SPACE" : ev.code.replace("Key", ""),
        );
      };
      const handleMouse = (ev) => {
        ev.preventDefault();
        finalize(
          "Mouse" + ev.button,
          ["Click L", "Click M", "Click R"][ev.button] || "Click",
        );
      };
      const finalize = (code, display) => {
        keyBinds[action] = code;
        targetBtn.innerText = display;
        document.removeEventListener("keydown", handleKey);
        document.removeEventListener("mousedown", handleMouse);
        setTimeout(() => {
          isRebinding = false;
        }, 50);
      };
      setTimeout(() => {
        document.addEventListener("keydown", handleKey);
        document.addEventListener("mousedown", handleMouse);
      }, 10);
    });
  });

  controls.addEventListener("lock", () => {
    blocker.style.display = "none";
  });
  controls.addEventListener("unlock", () => {
    blocker.style.display = "flex";
    showMenu(menuMain);
  });
  scene.add(controls.getObject());

  // Player physics
  playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0),
  );
  playerCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(0.8, 0.4),
    playerBody,
  );
  characterController = world.createCharacterController(0.01);
  characterController.enableAutostep(0.5, 0.2, true);
  characterController.enableSnapToGround(0.5);

  document.addEventListener("keydown", (e) => {
    if (!isRebinding) onInputDown(e.code);
  });
  document.addEventListener("keyup", (e) => {
    if (!isRebinding) onInputUp(e.code);
  });
  document.addEventListener("mousedown", (e) => {
    if (!isRebinding) onInputDown("Mouse" + e.button);
  });
  document.addEventListener("mouseup", (e) => {
    if (!isRebinding) onInputUp("Mouse" + e.button);
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", () => {
    clearTimeout(window._resizeT);
    window._resizeT = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(currentPixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
    }, 150);
  });

  // Highlight mesh
  raycaster = new THREE.Raycaster();
  const highlightGeo = new THREE.BoxGeometry(1, 1, 1);
  const edgesGeo = new THREE.EdgesGeometry(highlightGeo);
  rollOverMesh = new THREE.LineSegments(
    edgesGeo,
    new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 }),
  );
  rollOverMesh.scale.set(1.002, 1.002, 1.002);
  rollOverMesh.visible = false;
  scene.add(rollOverMesh);

  renderInventory();
  selectHotbarSlot(0);

  // Generate initial terrain and spawn
  generateChunksAround(new THREE.Vector3(0, 0, 0));
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      generateChunk(0 + dx, 0 + dz);
      rebuildChunkForced(0 + dx, 0 + dz);
    }
  }
  positionPlayerAtSpawn(0, 0);
  updatePhysicsBodies(camera.position);
  world.step();
}

function rebuildChunkForced(cx, cz) {
  const key = `${cx},${cz}`;
  disposeChunkMeshes(key);
  const meshes = createChunkMeshFromWasm(cx, cz);
  meshes.forEach((m) => scene.add(m));
  chunkMeshes.set(key, meshes);
}

// ── Input ──
function onInputDown(inputStr) {
  switch (inputStr) {
    case keyBinds.forward:
      moveForward = true;
      break;
    case keyBinds.left:
      moveLeft = true;
      break;
    case keyBinds.backward:
      moveBackward = true;
      break;
    case keyBinds.right:
      moveRight = true;
      break;
    case keyBinds.jump:
      if (canJump) {
        velocity.y += 15;
        canJump = false;
      }
      break;
    case keyBinds.breakBlock:
      performInteract("breakBlock");
      break;
    case keyBinds.placeBlock:
      performInteract("placeBlock");
      break;
    case keyBinds.inventory:
      toggleInventory();
      break;
    case keyBinds.slot1:
      selectHotbarSlot(0);
      break;
    case keyBinds.slot2:
      selectHotbarSlot(1);
      break;
    case keyBinds.slot3:
      selectHotbarSlot(2);
      break;
    case keyBinds.slot4:
      selectHotbarSlot(3);
      break;
    case keyBinds.slot5:
      selectHotbarSlot(4);
      break;
    case keyBinds.slot6:
      selectHotbarSlot(5);
      break;
    case keyBinds.slot7:
      selectHotbarSlot(6);
      break;
    case keyBinds.slot8:
      selectHotbarSlot(7);
      break;
    case keyBinds.slot9:
      selectHotbarSlot(8);
      break;
  }
}
function onInputUp(inputStr) {
  switch (inputStr) {
    case keyBinds.forward:
      moveForward = false;
      break;
    case keyBinds.left:
      moveLeft = false;
      break;
    case keyBinds.backward:
      moveBackward = false;
      break;
    case keyBinds.right:
      moveRight = false;
      break;
  }
}

// ── Main Loop ──
let lastCullingUpdate = 0;
const CULLING_UPDATE_INTERVAL = 1000;
let lastRaycasterUpdate = 0;
const RAYCASTER_UPDATE_INTERVAL = 50;
let lastSkyUpdate = 0;
const SKY_UPDATE_INTERVAL = 100;

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now();

  flushDirtyChunks();

  const rawDelta = (time - prevTime) / 1000;
  const frameMs = rawDelta * 1000;
  smoothedFrameMs = smoothedFrameMs * 0.9 + frameMs * 0.1;
  timeOfDay += rawDelta * ((Math.PI * 2) / 120);
  if (timeOfDay > Math.PI * 2) timeOfDay -= Math.PI * 2;

  // Adaptive resolution
  if (PERFORMANCE.adaptiveRes && time - lastDprEval > 1000) {
    if (smoothedFrameMs > 23) {
      targetPixelRatio = Math.max(0.7, targetPixelRatio - 0.1);
    } else if (smoothedFrameMs < 16) {
      targetPixelRatio = Math.min(BASE_PIXEL_RATIO, targetPixelRatio + 0.1);
    }
    if (Math.abs(targetPixelRatio - currentPixelRatio) >= 0.05) {
      currentPixelRatio = targetPixelRatio;
      renderer.setPixelRatio(currentPixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
    lastDprEval = time;
  }

  // Day/night cycle
  if (time - lastSkyUpdate > SKY_UPDATE_INTERVAL) {
    const sinTime = Math.sin(timeOfDay);
    const cosTime = Math.cos(timeOfDay);
    directionalLight.position.set(cosTime * 100, sinTime * 100, sinTime * 40);
    const intensity = Math.max(0, sinTime);
    directionalLight.intensity = intensity * 1.5;
    if (intensity > 0) {
      scene.background.setHSL(0.55, 0.5, 0.5 + intensity * 0.3);
      scene.fog.color.copy(scene.background);
      ambientLight.intensity = 0.2 + intensity * 0.4;
    } else {
      scene.background.setHex(0x050515);
      scene.fog.color.copy(scene.background);
      ambientLight.intensity = 0.1;
    }
    lastSkyUpdate = time;
  }

  // Physics & chunk management
  if (time - lastCullingUpdate > CULLING_UPDATE_INTERVAL) {
    updatePhysicsBodies(camera.position);
    const pcx = Math.floor(camera.position.x / CHUNK_SIZE);
    const pcz = Math.floor(camera.position.z / CHUNK_SIZE);
    const moved = pcx !== lastPlayerChunkX || pcz !== lastPlayerChunkZ;
    ensureChunksAroundPlayer(camera.position);
    if (moved) {
      needsVisibleRebuild = true;
      lastPlayerChunkX = pcx;
      lastPlayerChunkZ = pcz;
    }
    lastCullingUpdate = time;
  }

  if (needsVisibleRebuild) {
    rebuildVisibleObjects();
    needsVisibleRebuild = false;
  }

  if (controls.isLocked) {
    // Highlight block using WASM raycast
    if (time - lastRaycasterUpdate > RAYCASTER_UPDATE_INTERVAL) {
      const cam = camera;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const hit = wasm.raycast_block(
        cam.position.x,
        cam.position.y,
        cam.position.z,
        dir.x,
        dir.y,
        dir.z,
        5.0,
      );
      if (hit) {
        const data = JSON.parse(hit);
        rollOverMesh.position.set(
          data.blockX,
          data.blockY,
          data.blockZ,
        );
        rollOverMesh.visible = true;
      } else {
        rollOverMesh.visible = false;
      }
      lastRaycasterUpdate = time;
    }

    // Player movement
    const delta = Math.min(rawDelta, 0.1);
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= 30 * delta;
    _right.setFromMatrixColumn(camera.matrix, 0);
    _right.y = 0;
    _right.normalize();
    _front.crossVectors(_up, _right).normalize();
    _moveVec.set(0, 0, 0);
    if (moveForward) _moveVec.add(_front);
    if (moveBackward) _moveVec.sub(_front);
    if (moveLeft) _moveVec.sub(_right);
    if (moveRight) _moveVec.add(_right);
    if (_moveVec.lengthSq() > 0)
      _moveVec.normalize().multiplyScalar(10 * delta);
    _rapierMovement.x = _moveVec.x;
    _rapierMovement.y = velocity.y * delta;
    _rapierMovement.z = _moveVec.z;
    characterController.computeColliderMovement(
      playerCollider,
      _rapierMovement,
    );
    const cm = characterController.computedMovement();
    if (characterController.computedGrounded()) {
      canJump = true;
      if (velocity.y < 0) velocity.y = 0;
    }
    const np = playerBody.translation();
    np.x += cm.x;
    np.y += cm.y;
    np.z += cm.z;
    playerBody.setNextKinematicTranslation(np);
    world.step();
    const pos = playerBody.translation();
    controls.getObject().position.set(pos.x, pos.y + 0.8, pos.z);
  }

  prevTime = time;
  renderer.render(scene, camera);
}
