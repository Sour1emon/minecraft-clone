import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import RAPIER from "@dimforge/rapier3d-compat";
import SimplexNoise from "simplex-noise";

// --- Global Variables ---
let camera, scene, renderer, controls;
let raycaster;
let directionalLight, ambientLight;
let timeOfDay = 0;

// Rapier Physics
let world, characterController, playerBody, playerCollider;

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let canJump = false;
let renderDistanceChunks = 6;
let isRebinding = false;

const keyBinds = {
  forward: "KeyW", backward: "KeyS", left: "KeyA", right: "KeyD",
  jump: "Space", inventory: "KeyE", breakBlock: "Mouse0", placeBlock: "Mouse2",
  slot1:"Digit1",slot2:"Digit2",slot3:"Digit3",slot4:"Digit4",slot5:"Digit5",
  slot6:"Digit6",slot7:"Digit7",slot8:"Digit8",slot9:"Digit9",
};

let prevTime = performance.now();
const velocity = new THREE.Vector3();
let lastInventoryUpdate = 0;
const INVENTORY_UPDATE_THROTTLE = 50;
const BASE_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2);
let currentPixelRatio = BASE_PIXEL_RATIO;
let targetPixelRatio = BASE_PIXEL_RATIO;
let smoothedFrameMs = 16.7;
let lastDprEval = 0;

// --- Chunk System ---
const CHUNK_SIZE = 16;
// blockMap: "x,y,z" -> blockType string. Single source of truth for world state.
const blockMap = new Map();
// chunkBlockIndex: "cx,cz" -> Set("x,y,z"), allows fast per-chunk iteration.
const chunkBlockIndex = new Map();
// chunkMeshes: "cx,cz" -> { opaque: Mesh, transparent: Mesh } (rebuilt on change)
const chunkMeshes = new Map();
// Chunks dirty-flagged for rebuild next frame
const dirtyChunks = new Set();
// Generated terrain chunks (persists terrain data even if meshes unload)
const generatedChunks = new Set();
// Raycaster target list (opaque chunk meshes within range)
const visibleObjects = [];

const PHYSICS_CULLING_DISTANCE = 30;
// blockPhysics: "x,y,z" -> RAPIER rigidBody
const blockPhysics = new Map();
// Reused materials keyed by "texture|opaque/transparent"
const materialCache = new Map();

// Preallocated per-frame vectors
const _right = new THREE.Vector3();
const _front = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _moveVec = new THREE.Vector3();
const _blockMatrix = new THREE.Matrix4();
const _screenCenter = new THREE.Vector2(0, 0);
let _rapierMovement = null;
let needsVisibleRebuild = true;
let lastPlayerChunkX = Number.NaN;
let lastPlayerChunkZ = Number.NaN;
const terrainNoise = new SimplexNoise();
const TREE_NOISE_OFFSET = 1337;

// --- Texture Generation ---
const iconUris = {};
const textureCache = {};

function generateTexture(type) {
  if (textureCache[type]) return textureCache[type];
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext("2d", { alpha: true });
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let baseColor, noiseColors;
  if (type === "dirt") { baseColor=[139,69,19]; noiseColors=[[107,52,16],[155,86,32]]; }
  else if (type === "stone") { baseColor=[128,128,128]; noiseColors=[[100,100,100],[150,150,150]]; }
  else if (type === "grass_top") { baseColor=[85,170,85]; noiseColors=[[68,153,68],[102,187,102]]; }
  else if (type === "wood_top") { baseColor=[139,90,43]; noiseColors=[[120,75,35],[150,100,50]]; }
  else if (type === "sand") { baseColor=[238,214,175]; noiseColors=[[200,180,140],[255,230,190]]; }
  else if (type === "brick") {
    ctx.fillStyle="#aaa"; ctx.fillRect(0,0,16,16);
    ctx.fillStyle="#b22222";
    for (let r=0;r<4;r++){let o=r%2===0?0:-8;for(let c=0;c<2;c++)ctx.fillRect(c*16+o,r*4,15,3);}
    for (let i=0;i<30;i++){ctx.fillStyle=`rgba(0,0,0,0.2)`;ctx.fillRect(rand(0,15),rand(0,15),1,1);}
  } else if (type === "glass") {
    ctx.clearRect(0,0,16,16); ctx.fillStyle="rgba(200,220,255,0.4)"; ctx.fillRect(0,0,16,16);
    ctx.fillStyle="rgba(255,255,255,0.8)";
    ctx.fillRect(0,0,16,2);ctx.fillRect(0,14,16,2);ctx.fillRect(0,0,2,16);ctx.fillRect(14,0,2,16);ctx.fillRect(2,2,4,4);
  }
  if (type === "grass_side") {
    for (let y=0;y<16;y++) for (let x=0;x<16;x++) {
      let isG=y<4||(y<6&&Math.random()>0.5);
      let c=isG?(Math.random()>0.5?[85,170,85]:[68,153,68]):(Math.random()>0.5?[139,69,19]:[107,52,16]);
      ctx.fillStyle=`rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(x,y,1,1);
    }
  } else if (type === "wood_side") {
    for (let y=0;y<16;y++) for (let x=0;x<16;x++) {
      let s=(x+Math.floor(Math.random()*1.5))%4;
      let c=s<2?[107,66,38]:[74,46,27];
      ctx.fillStyle=`rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(x,y,1,1);
    }
  } else if (type === "leaves") {
    ctx.fillStyle=`rgb(34,139,34)`; ctx.fillRect(0,0,16,16);
    for (let i=0;i<150;i++){let x=rand(0,15),y=rand(0,15),p=Math.random();
      if(p<0.4)ctx.clearRect(x,y,1,1);else{ctx.fillStyle=p<0.7?"rgb(17,119,17)":"rgb(50,170,50)";ctx.fillRect(x,y,1,1);}}
  } else if (["dirt","stone","grass_top","wood_top","sand"].includes(type)) {
    ctx.fillStyle=`rgb(${baseColor[0]},${baseColor[1]},${baseColor[2]})`; ctx.fillRect(0,0,16,16);
    for (let i=0;i<150;i++){let nc=noiseColors[rand(0,1)];ctx.fillStyle=`rgb(${nc[0]},${nc[1]},${nc[2]})`;ctx.fillRect(rand(0,15),rand(0,15),1,1);}
  }
  iconUris[type] = canvas.toDataURL();
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache[type] = texture;
  return texture;
}

// Pre-generate all textures up front so there's no stutter on first block of each type
const TEX_TYPES = ["dirt","stone","grass_top","grass_side","wood_top","wood_side","leaves","sand","brick","glass"];
TEX_TYPES.forEach(generateTexture);
iconUris["grass"] = iconUris["grass_side"];
iconUris["wood"] = iconUris["wood_side"];

// --- Chunk Mesh Builder ---
// Face definitions: [normal dx,dy,dz], [4 vertices as offsets from block center], [uv coords]
// Vertex winding is CCW from outside.
const FACES = [
  // +X right
  { dir:[1,0,0],  verts:[[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5],[0.5,-0.5,0.5]],   uvs:[[0,0],[0,1],[1,1],[1,0]] },
  // -X left
  { dir:[-1,0,0], verts:[[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,-0.5]], uvs:[[0,0],[0,1],[1,1],[1,0]] },
  // +Y top
  { dir:[0,1,0],  verts:[[-0.5,0.5,-0.5],[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5]],   uvs:[[0,0],[0,1],[1,1],[1,0]] },
  // -Y bottom
  { dir:[0,-1,0], verts:[[-0.5,-0.5,0.5],[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5]], uvs:[[0,0],[0,1],[1,1],[1,0]] },
  // +Z front
  { dir:[0,0,1],  verts:[[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]],   uvs:[[0,0],[1,0],[1,1],[0,1]] },
  // -Z back
  { dir:[0,0,-1], verts:[[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5]], uvs:[[0,0],[1,0],[1,1],[0,1]] },
];

// Returns which texture to use for a given block type + face direction
function getFaceTexture(blockType, faceDir) {
  if (blockType === "grass") {
    if (faceDir[1] === 1) return "grass_top";
    if (faceDir[1] === -1) return "dirt";
    return "grass_side";
  }
  if (blockType === "wood") {
    if (faceDir[1] !== 0) return "wood_top";
    return "wood_side";
  }
  return blockType; // dirt, stone, sand, brick, glass, leaves all use single texture
}

const TRANSPARENT_TYPES = new Set(["glass", "leaves"]);
const WORLD_MIN_Y = -8;
const WORLD_MAX_Y = 48;

function getRenderDistanceBlocks() {
  return renderDistanceChunks * CHUNK_SIZE;
}

function getChunkCoordsFromWorld(x, z) {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
}

function getChunkKeyFromWorld(x, z) {
  const [cx, cz] = getChunkCoordsFromWorld(x, z);
  return `${cx},${cz}`;
}

function indexBlockInChunk(posKey, x, z) {
  const chunkKey = getChunkKeyFromWorld(x, z);
  let chunkSet = chunkBlockIndex.get(chunkKey);
  if (!chunkSet) {
    chunkSet = new Set();
    chunkBlockIndex.set(chunkKey, chunkSet);
  }
  chunkSet.add(posKey);
}

function unindexBlockFromChunk(posKey, x, z) {
  const chunkKey = getChunkKeyFromWorld(x, z);
  const chunkSet = chunkBlockIndex.get(chunkKey);
  if (!chunkSet) return;
  chunkSet.delete(posKey);
  if (chunkSet.size === 0) chunkBlockIndex.delete(chunkKey);
}

// Build or rebuild the mesh for one chunk.
// Iterates all blocks in the chunk, emits only faces whose neighbor is absent.
// Produces two meshes: opaque (single material atlas approach via groups) and transparent.
function buildChunkMesh(chunkX, chunkZ) {
  // Separate geometry arrays per texture type to avoid texture atlas complexity
  // Key: textureName -> { positions, normals, uvs, indices }
  const opaqueBufs = {};   // texName -> arrays
  const transBufs = {};    // texName -> arrays

  const blockKeys = chunkBlockIndex.get(`${chunkX},${chunkZ}`);
  if (!blockKeys || blockKeys.size === 0) return { opaqueBufs, transBufs };

  for (const posKey of blockKeys) {
    const [wx, wy, wz] = posKey.split(",").map(Number);
    const blockType = blockMap.get(posKey);
    if (!blockType) continue;

    const isTransparent = TRANSPARENT_TYPES.has(blockType);

    for (const face of FACES) {
      const [dx, dy, dz] = face.dir;
      const neighborKey = `${wx+dx},${wy+dy},${wz+dz}`;
      const neighbor = blockMap.get(neighborKey);

      // Skip this face if neighbor is a fully opaque block
      // (transparent blocks always show their faces next to other transparent blocks)
      if (neighbor && !TRANSPARENT_TYPES.has(neighbor)) continue;
      // Also skip if both are same transparent type (glass next to glass hides the face)
      if (neighbor && isTransparent && neighbor === blockType) continue;

      const texName = getFaceTexture(blockType, face.dir);
      const bufs = isTransparent ? transBufs : opaqueBufs;
      if (!bufs[texName]) bufs[texName] = { positions:[], normals:[], uvs:[], indices:[] };
      const buf = bufs[texName];

      const base = buf.positions.length / 3; // vertex index base
      for (let v = 0; v < 4; v++) {
        const [vx,vy,vz] = face.verts[v];
        buf.positions.push(wx+vx, wy+vy, wz+vz);
        buf.normals.push(dx, dy, dz);
        buf.uvs.push(face.uvs[v][0], face.uvs[v][1]);
      }
      // Two triangles per quad (CCW)
      buf.indices.push(base, base+1, base+2, base, base+2, base+3);
    }
  }

  return { opaqueBufs, transBufs };
}

// Creates Three.js meshes from geometry buffers for one chunk
function createChunkMeshObjects(chunkX, chunkZ, opaqueBufs, transBufs) {
  const meshes = [];

  const getChunkMaterial = (texName, transparent) => {
    const key = `${texName}|${transparent ? "t" : "o"}`;
    let mat = materialCache.get(key);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({
        map: generateTexture(texName),
        transparent,
        alphaTest: transparent ? 0.1 : 0,
        side: transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
      materialCache.set(key, mat);
    }
    return mat;
  };

  const buildMeshes = (bufs, transparent) => {
    for (const [texName, buf] of Object.entries(bufs)) {
      if (buf.indices.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions, 3));
      geo.setAttribute("normal",   new THREE.Float32BufferAttribute(buf.normals, 3));
      geo.setAttribute("uv",       new THREE.Float32BufferAttribute(buf.uvs, 2));
      geo.setIndex(buf.indices);

      const mat = getChunkMaterial(texName, transparent);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = !transparent;
      mesh.receiveShadow = true;
      mesh.userData = { chunkX, chunkZ, isTransparent: transparent };
      scene.add(mesh);
      meshes.push(mesh);
    }
  };

  buildMeshes(opaqueBufs, false);
  buildMeshes(transBufs, true);
  return meshes;
}

// Remove existing chunk meshes from scene and dispose GPU resources
function disposeChunkMeshes(chunkKey) {
  const existing = chunkMeshes.get(chunkKey);
  if (!existing) return;
  for (const mesh of existing) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    // Don't dispose materials/textures — they're shared across chunks
  }
  chunkMeshes.delete(chunkKey);
}

// Full rebuild for one chunk — called when dirty
function rebuildChunk(chunkX, chunkZ) {
  const chunkKey = `${chunkX},${chunkZ}`;
  disposeChunkMeshes(chunkKey);
  const { opaqueBufs, transBufs } = buildChunkMesh(chunkX, chunkZ);
  const meshes = createChunkMeshObjects(chunkX, chunkZ, opaqueBufs, transBufs);
  chunkMeshes.set(chunkKey, meshes);
}

// Mark a chunk and its face-adjacent neighbors dirty (needed when a block on a border changes)
function markChunkDirty(wx, wy, wz) {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cz = Math.floor(wz / CHUNK_SIZE);
  dirtyChunks.add(`${cx},${cz}`);
  // If block is on a chunk border, the adjacent chunk face-culling is also affected
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  if (lx === 0)             dirtyChunks.add(`${cx-1},${cz}`);
  if (lx === CHUNK_SIZE-1)  dirtyChunks.add(`${cx+1},${cz}`);
  if (lz === 0)             dirtyChunks.add(`${cx},${cz-1}`);
  if (lz === CHUNK_SIZE-1)  dirtyChunks.add(`${cx},${cz+1}`);
}

function flushDirtyChunks() {
  if (dirtyChunks.size === 0) return;
  const start = performance.now();
  const MAX_CHUNK_REBUILDS_PER_FRAME = 2;
  const MAX_CHUNK_REBUILD_TIME_MS = 3;
  let rebuilt = 0;

  while (dirtyChunks.size > 0 && rebuilt < MAX_CHUNK_REBUILDS_PER_FRAME) {
    const key = dirtyChunks.values().next().value;
    dirtyChunks.delete(key);
    const [cx, cz] = key.split(",").map(Number);
    rebuildChunk(cx, cz);
    rebuilt++;
    if (performance.now() - start >= MAX_CHUNK_REBUILD_TIME_MS) break;
  }

  // Delay visible list rebuild to the periodic culling step to avoid repeated scans in one frame.
  if (rebuilt > 0) needsVisibleRebuild = true;
}

// --- Block Map Helpers ---
function setBlockInternal(x, y, z, type, markDirty = true) {
  if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return false;
  const posKey = `${x},${y},${z}`;
  if (blockMap.has(posKey)) return false;
  blockMap.set(posKey, type);
  indexBlockInChunk(posKey, x, z);
  if (markDirty) markChunkDirty(x, y, z);
  return true;
}

function addBlock(x, y, z, type) {
  setBlockInternal(x, y, z, type, true);
}

function removeBlock(posKey) {
  if (!blockMap.has(posKey)) return;
  // Parse position from key
  const [x, y, z] = posKey.split(",").map(Number);
  blockMap.delete(posKey);
  unindexBlockFromChunk(posKey, x, z);
  markChunkDirty(x, y, z);
  // Remove physics if present
  const body = blockPhysics.get(posKey);
  if (body) { world.removeRigidBody(body); blockPhysics.delete(posKey); }
}

function clearWorld() {
  // Remove all chunk meshes
  for (const [key] of chunkMeshes) disposeChunkMeshes(key);
  chunkMeshes.clear();
  blockMap.clear();
  chunkBlockIndex.clear();
  generatedChunks.clear();
  blockPhysics.forEach(body => world.removeRigidBody(body));
  blockPhysics.clear();
  dirtyChunks.clear();
  visibleObjects.length = 0;
  needsVisibleRebuild = true;
  lastPlayerChunkX = Number.NaN;
  lastPlayerChunkZ = Number.NaN;
  playerBody.setTranslation(new RAPIER.Vector3(0, 5, 0), true);
  velocity.set(0, 0, 0);
}

// Rebuild the raycaster target list from visible opaque chunk meshes
function rebuildVisibleObjects() {
  visibleObjects.length = 0;
  const playerPos = camera ? camera.position : new THREE.Vector3();
  const renderDistanceBlocks = getRenderDistanceBlocks();
  for (const [key, meshes] of chunkMeshes) {
    const [cx, cz] = key.split(",").map(Number);
    const chunkWorldX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const chunkWorldZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
    const dist = Math.hypot(playerPos.x - chunkWorldX, playerPos.z - chunkWorldZ);
    if (dist < renderDistanceBlocks + CHUNK_SIZE) {
      for (const mesh of meshes) {
        if (!mesh.userData.isTransparent) visibleObjects.push(mesh);
      }
    }
  }
}

// --- Physics ---
function updatePhysicsBodies(playerPos) {
  const chunkRadius = Math.ceil(PHYSICS_CULLING_DISTANCE / CHUNK_SIZE) + 1;
  const playerChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
  const playerChunkZ = Math.floor(playerPos.z / CHUNK_SIZE);

  // Add physics for nearby blocks that lack it
  for (let cx = playerChunkX - chunkRadius; cx <= playerChunkX + chunkRadius; cx++) {
    for (let cz = playerChunkZ - chunkRadius; cz <= playerChunkZ + chunkRadius; cz++) {
      const chunkSet = chunkBlockIndex.get(`${cx},${cz}`);
      if (!chunkSet) continue;
      for (const posKey of chunkSet) {
        if (blockPhysics.has(posKey)) continue;
        const [wx, wy, wz] = posKey.split(",").map(Number);
        const dist = Math.hypot(wx - playerPos.x, wy - playerPos.y, wz - playerPos.z);
        if (dist < PHYSICS_CULLING_DISTANCE) {
          const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(wx, wy, wz));
          world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), rb);
          blockPhysics.set(posKey, rb);
        }
      }
    }
  }

  // Remove physics for blocks now out of range
  for (const [posKey, rb] of blockPhysics) {
    const [x, y, z] = posKey.split(",").map(Number);
    const dist = Math.hypot(x - playerPos.x, y - playerPos.y, z - playerPos.z);
    if (dist >= PHYSICS_CULLING_DISTANCE) {
      world.removeRigidBody(rb);
      blockPhysics.delete(posKey);
    }
  }
}

// --- World Generation ---
function generateWorld() {
  ensureChunksAroundPlayer(new THREE.Vector3(0, 0, 0));
}

function getTerrainHeight(x, z) {
  const continental = (terrainNoise.noise2D(x / 120, z / 120) + 1) * 0.5;
  const detail = (terrainNoise.noise2D(x / 40, z / 40) + 1) * 0.5;
  const peaks = (terrainNoise.noise2D(x / 18, z / 18) + 1) * 0.5;
  const h = Math.floor(-2 + continental * 12 + detail * 6 + peaks * 3);
  return Math.min(WORLD_MAX_Y - 6, Math.max(WORLD_MIN_Y + 2, h));
}

function shouldSpawnTree(x, z) {
  const v = (terrainNoise.noise2D((x + TREE_NOISE_OFFSET) / 24, (z - TREE_NOISE_OFFSET) / 24) + 1) * 0.5;
  return v > 0.87;
}

function addTreeToMap(x, y, z, touchedChunks) {
  const heightNoise = (terrainNoise.noise2D((x - TREE_NOISE_OFFSET) / 12, (z + TREE_NOISE_OFFSET) / 12) + 1) * 0.5;
  const h = 4 + Math.floor(heightNoise * 3);
  for (let i = 0; i < h; i++) {
    if (setBlockInternal(x, y + i, z, "wood", false)) touchedChunks.add(getChunkKeyFromWorld(x, z));
  }
  for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 2; lz++) for (let ly = h-2; ly <= h+1; ly++) {
    if (Math.abs(lx)===2 && Math.abs(lz)===2 && ly===h+1) continue;
    if (lx===0 && lz===0 && ly<h) continue;
    const wx = x + lx;
    const wy = y + ly;
    const wz = z + lz;
    if (setBlockInternal(wx, wy, wz, "leaves", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
  }
}

function generateChunk(chunkX, chunkZ) {
  const chunkKey = `${chunkX},${chunkZ}`;
  if (generatedChunks.has(chunkKey)) return;

  const touchedChunks = new Set([chunkKey]);
  const x0 = chunkX * CHUNK_SIZE;
  const z0 = chunkZ * CHUNK_SIZE;

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const wx = x0 + lx;
      const wz = z0 + lz;
      const height = getTerrainHeight(wx, wz);
      for (let y = WORLD_MIN_Y; y < height - 3; y++) {
        if (setBlockInternal(wx, y, wz, "stone", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
      }
      for (let y = Math.max(WORLD_MIN_Y, height - 3); y < height; y++) {
        if (setBlockInternal(wx, y, wz, "dirt", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
      }
      const topType = height <= 1 ? "sand" : "grass";
      if (setBlockInternal(wx, height, wz, topType, false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
      if (topType === "grass" && shouldSpawnTree(wx, wz)) {
        addTreeToMap(wx, height + 1, wz, touchedChunks);
      }
    }
  }

  generatedChunks.add(chunkKey);
  for (const dirtyKey of touchedChunks) dirtyChunks.add(dirtyKey);
  needsVisibleRebuild = true;
}

function unloadFarChunkMeshes(playerChunkX, playerChunkZ, keepRadius) {
  let removedAny = false;
  for (const key of chunkMeshes.keys()) {
    const [cx, cz] = key.split(",").map(Number);
    if (Math.abs(cx - playerChunkX) > keepRadius || Math.abs(cz - playerChunkZ) > keepRadius) {
      disposeChunkMeshes(key);
      removedAny = true;
    }
  }
  if (removedAny) needsVisibleRebuild = true;
}

function ensureChunksAroundPlayer(playerPos) {
  const playerChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
  const playerChunkZ = Math.floor(playerPos.z / CHUNK_SIZE);
  const generationRadius = Math.max(2, renderDistanceChunks + 1);
  const missingChunks = [];
  for (let cx = playerChunkX - generationRadius; cx <= playerChunkX + generationRadius; cx++) {
    for (let cz = playerChunkZ - generationRadius; cz <= playerChunkZ + generationRadius; cz++) {
      const key = `${cx},${cz}`;
      if (generatedChunks.has(key)) continue;
      const dist = Math.abs(cx - playerChunkX) + Math.abs(cz - playerChunkZ);
      missingChunks.push({ cx, cz, dist });
    }
  }
  missingChunks.sort((a, b) => a.dist - b.dist);
  const CHUNK_GEN_BUDGET_PER_UPDATE = 6;
  const count = Math.min(CHUNK_GEN_BUDGET_PER_UPDATE, missingChunks.length);
  for (let i = 0; i < count; i++) {
    const { cx, cz } = missingChunks[i];
    generateChunk(cx, cz);
  }
  unloadFarChunkMeshes(playerChunkX, playerChunkZ, generationRadius + 2);
}

// --- Inventory ---
let inventory = Array(36).fill(null);
let hotbarSelected = 0;
let isInventoryOpen = false;
inventory[0]={type:"grass",count:64}; inventory[1]={type:"dirt",count:64};
inventory[2]={type:"stone",count:64}; inventory[3]={type:"wood",count:64};
inventory[4]={type:"leaves",count:64}; inventory[5]={type:"sand",count:64};
inventory[6]={type:"brick",count:64}; inventory[7]={type:"glass",count:64};

let rollOverMesh;

init().then(animate);

async function init() {
  await RAPIER.init();
  world = new RAPIER.World(new RAPIER.Vector3(0.0, -30.0, 0.0));
  _rapierMovement = new RAPIER.Vector3(0, 0, 0);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 10, getRenderDistanceBlocks());

  ambientLight = new THREE.AmbientLight(0xeeeeee, 0.6);
  scene.add(ambientLight);

  directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(50, 100, 50);
  directionalLight.castShadow = false;
  directionalLight.shadow.mapSize.width = 1024;
  directionalLight.shadow.mapSize.height = 1024;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 200;
  directionalLight.shadow.camera.left = -50;
  directionalLight.shadow.camera.right = 50;
  directionalLight.shadow.camera.top = 50;
  directionalLight.shadow.camera.bottom = -50;
  directionalLight.shadow.bias = -0.001;
  directionalLight.shadow.normalBias = 0.02;
  scene.add(directionalLight);
  renderer = null; // will be set below

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

  const rendererInst = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  rendererInst.shadowMap.enabled = true;
  rendererInst.shadowMap.type = THREE.PCFShadowMap;
  rendererInst.shadowMap.autoUpdate = false;
  rendererInst.shadowMap.needsUpdate = true;
  rendererInst.setPixelRatio(currentPixelRatio);
  rendererInst.setSize(window.innerWidth, window.innerHeight);
  rendererInst.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(rendererInst.domElement);
  renderer = rendererInst;

  controls = new PointerLockControls(camera, renderer.domElement);

  const blocker = document.getElementById("blocker");
  const menuMain = document.getElementById("menu-main");
  const menuOptions = document.getElementById("menu-options");
  const menuGraphics = document.getElementById("menu-graphics");
  const menuControls = document.getElementById("menu-controls");

  function showMenu(menu) {
    [menuMain,menuOptions,menuGraphics,menuControls].forEach(m=>m.style.display="none");
    menu.style.display = "flex";
  }

  document.getElementById("btn-resume").addEventListener("click", ()=>controls.lock());
  document.getElementById("btn-options").addEventListener("click", ()=>showMenu(menuOptions));
  document.getElementById("btn-exit").addEventListener("click", ()=>{ clearWorld(); generateWorld(); controls.lock(); });
  document.getElementById("btn-graphics").addEventListener("click", ()=>showMenu(menuGraphics));
  document.getElementById("btn-controls").addEventListener("click", ()=>showMenu(menuControls));
  document.getElementById("btn-options-done").addEventListener("click", ()=>showMenu(menuMain));
  document.getElementById("btn-graphics-done").addEventListener("click", ()=>showMenu(menuOptions));
  document.getElementById("btn-controls-done").addEventListener("click", ()=>showMenu(menuOptions));

  const sliderRenderDist = document.getElementById("graphics-render-distance");
  const lblRenderDist = document.getElementById("lbl-render-distance");
  sliderRenderDist.min = "2";
  sliderRenderDist.max = "16";
  sliderRenderDist.step = "1";
  sliderRenderDist.value = String(renderDistanceChunks);
  lblRenderDist.innerText = `${renderDistanceChunks} chunks`;
  sliderRenderDist.addEventListener("input", (e)=>{
    renderDistanceChunks = parseInt(e.target.value, 10);
    lblRenderDist.innerText = `${renderDistanceChunks} chunks`;
    scene.fog.far = getRenderDistanceBlocks();
    needsVisibleRebuild = true;
  });

  document.querySelectorAll(".keybind-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      isRebinding = true;
      const targetBtn = e.target;
      const action = targetBtn.getAttribute("data-action");
      targetBtn.innerText = ">";
      const handleKey = ev=>{ ev.preventDefault(); finalize(ev.code, ev.code==="Space"?"SPACE":ev.code.replace("Key","")); };
      const handleMouse = ev=>{ ev.preventDefault(); finalize("Mouse"+ev.button,["Click L","Click M","Click R"][ev.button]||"Click"); };
      const finalize = (code, display)=>{
        keyBinds[action]=code; targetBtn.innerText=display;
        document.removeEventListener("keydown",handleKey);
        document.removeEventListener("mousedown",handleMouse);
        setTimeout(()=>{ isRebinding=false; },50);
      };
      setTimeout(()=>{ document.addEventListener("keydown",handleKey); document.addEventListener("mousedown",handleMouse); },10);
    });
  });

  controls.addEventListener("lock", ()=>{ blocker.style.display="none"; });
  controls.addEventListener("unlock", ()=>{ blocker.style.display="flex"; showMenu(menuMain); });
  scene.add(controls.getObject());

  const playerDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 5, 0);
  playerBody = world.createRigidBody(playerDesc);
  playerCollider = world.createCollider(RAPIER.ColliderDesc.capsule(0.8, 0.4), playerBody);
  characterController = world.createCharacterController(0.01);
  characterController.enableAutostep(0.5, 0.2, true);
  characterController.enableSnapToGround(0.5);
  controls.getObject().position.y = 5;

  document.addEventListener("keydown", e=>{ if(!isRebinding) onInputDown(e.code); });
  document.addEventListener("keyup",   e=>{ if(!isRebinding) onInputUp(e.code); });
  document.addEventListener("mousedown", e=>{ if(!isRebinding) onInputDown("Mouse"+e.button); });
  document.addEventListener("mouseup",   e=>{ if(!isRebinding) onInputUp("Mouse"+e.button); });
  document.addEventListener("contextmenu", e=>e.preventDefault());
  window.addEventListener("resize", ()=>{
    clearTimeout(window._resizeT);
    window._resizeT = setTimeout(()=>{
      camera.aspect = window.innerWidth/window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(currentPixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
    }, 150);
  });

  raycaster = new THREE.Raycaster();
  raycaster.far = 6;

  // Block highlight outline
  const rollOverGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
  rollOverMesh = new THREE.LineSegments(rollOverGeo, new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 }));
  rollOverMesh.visible = false;
  scene.add(rollOverMesh);

  renderInventory();
  selectHotbarSlot(0);
  generateWorld();
}

// --- Input ---
function onInputDown(inputStr) {
  switch(inputStr) {
    case keyBinds.forward:    moveForward=true; break;
    case keyBinds.left:       moveLeft=true; break;
    case keyBinds.backward:   moveBackward=true; break;
    case keyBinds.right:      moveRight=true; break;
    case keyBinds.jump:       if(canJump){ velocity.y+=15; canJump=false; } break;
    case keyBinds.breakBlock: performInteract("breakBlock"); break;
    case keyBinds.placeBlock: performInteract("placeBlock"); break;
    case keyBinds.inventory:  toggleInventory(); break;
    case keyBinds.slot1: selectHotbarSlot(0); break;
    case keyBinds.slot2: selectHotbarSlot(1); break;
    case keyBinds.slot3: selectHotbarSlot(2); break;
    case keyBinds.slot4: selectHotbarSlot(3); break;
    case keyBinds.slot5: selectHotbarSlot(4); break;
    case keyBinds.slot6: selectHotbarSlot(5); break;
    case keyBinds.slot7: selectHotbarSlot(6); break;
    case keyBinds.slot8: selectHotbarSlot(7); break;
    case keyBinds.slot9: selectHotbarSlot(8); break;
  }
}
function onInputUp(inputStr) {
  switch(inputStr) {
    case keyBinds.forward:  moveForward=false; break;
    case keyBinds.left:     moveLeft=false; break;
    case keyBinds.backward: moveBackward=false; break;
    case keyBinds.right:    moveRight=false; break;
  }
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
  } else {
    invScreen.style.display = "none";
    controls.lock();
  }
}

function selectHotbarSlot(i) { hotbarSelected=i; renderInventory(); }

let selectedInventorySlot = null;

function updateHotbarDisplay() {
  const hotbarDiv = document.getElementById("hotbar");
  const nameDiv = document.getElementById("hotbar-name");
  hotbarDiv.innerHTML = "";
  for (let i=0;i<9;i++) {
    const item = inventory[i];
    const slot = document.createElement("div");
    slot.className = `slot ${i===hotbarSelected?"active":""}`;
    if (item) {
      slot.style.backgroundImage = `url(${iconUris[item.type]})`;
      const c = document.createElement("div");
      c.className="slot-count"; c.innerText=item.count;
      slot.appendChild(c);
      if (i===hotbarSelected) nameDiv.innerText=item.type.toUpperCase();
    } else if (i===hotbarSelected) nameDiv.innerText="";
    hotbarDiv.appendChild(slot);
  }
}

function renderInventoryScreen() {
  if (!isInventoryOpen) return;
  const invGrid = document.getElementById("inventory-grid");
  const invHotbarGrid = document.getElementById("inventory-hotbar-grid");
  invGrid.innerHTML=""; invHotbarGrid.innerHTML="";

  const makeSlot = (i) => {
    const item = inventory[i];
    const slot = document.createElement("div");
    slot.className = `inv-slot ${selectedInventorySlot===i?"active":""}`;
    if (item) {
      slot.style.backgroundImage=`url(${iconUris[item.type]})`;
      const c=document.createElement("div"); c.className="inv-slot-count"; c.innerText=item.count;
      slot.appendChild(c);
    }
    slot.addEventListener("click", ()=>{
      if (selectedInventorySlot===null) { selectedInventorySlot=i; }
      else { const t=inventory[i]; inventory[i]=inventory[selectedInventorySlot]; inventory[selectedInventorySlot]=t; selectedInventorySlot=null; }
      updateHotbarDisplay(); renderInventoryScreen();
    });
    return slot;
  };
  for (let i=9;i<36;i++) invGrid.appendChild(makeSlot(i));
  for (let i=0;i<9;i++) invHotbarGrid.appendChild(makeSlot(i));
}

function renderInventory() {
  const now = performance.now();
  if (now - lastInventoryUpdate < INVENTORY_UPDATE_THROTTLE) return;
  lastInventoryUpdate = now;
  updateHotbarDisplay();
  if (isInventoryOpen) renderInventoryScreen();
}

// --- Interaction ---
function performInteract(actionName) {
  if (!controls.isLocked) return;
  raycaster.setFromCamera(_screenCenter, camera);
  const intersects = raycaster.intersectObjects(visibleObjects, false);
  if (!intersects.length || intersects[0].distance > 5) return;

  const intersect = intersects[0];
  const nx = intersect.face.normal.x;
  const ny = intersect.face.normal.y;
  const nz = intersect.face.normal.z;

  if (actionName === "breakBlock") {
    // Move hit point slightly inward (against face normal) to land inside the block.
    const bx = Math.round(intersect.point.x - nx * 0.5);
    const by = Math.round(intersect.point.y - ny * 0.5);
    const bz = Math.round(intersect.point.z - nz * 0.5);
    const posKey = `${bx},${by},${bz}`;
    const blockType = blockMap.get(posKey);
    if (blockType) {
      // Don't break below y = -2 (bedrock floor)
      if (by <= -2) return;
      removeBlock(posKey);
      // Add to inventory
      let added = false;
      for (let i=0;i<36;i++) {
        if (inventory[i]?.type===blockType && inventory[i].count<64) { inventory[i].count++; added=true; break; }
      }
      if (!added) for (let i=0;i<36;i++) { if(!inventory[i]){ inventory[i]={type:blockType,count:1}; break; } }
      renderInventory();
    }
  } else if (actionName === "placeBlock") {
    const item = inventory[hotbarSelected];
    if (!item || item.count <= 0) return;
    const px = Math.round(intersect.point.x + nx * 0.5);
    const py = Math.round(intersect.point.y + ny * 0.5);
    const pz = Math.round(intersect.point.z + nz * 0.5);
    addBlock(px, py, pz, item.type);
    item.count--;
    if (item.count===0) inventory[hotbarSelected]=null;
    renderInventory();
  }
}

// --- Main Loop ---
let lastCullingUpdate = 0;
const CULLING_UPDATE_INTERVAL = 500;
let lastRaycasterUpdate = 0;
const RAYCASTER_UPDATE_INTERVAL = 50; // 20fps for highlight is plenty
let lastSkyUpdate = 0;
const SKY_UPDATE_INTERVAL = 100;

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now();

  // Flush any dirty chunk rebuilds (from block place/break)
  flushDirtyChunks();

  // Day/Night cycle
  const rawDelta = (time - prevTime) / 1000;
  const frameMs = rawDelta * 1000;
  smoothedFrameMs = smoothedFrameMs * 0.9 + frameMs * 0.1;
  timeOfDay += rawDelta * (Math.PI * 2 / 120);
  if (timeOfDay > Math.PI * 2) timeOfDay -= Math.PI * 2;

  // Adaptive internal resolution: lower pixel ratio on sustained spikes, restore when stable.
  if (time - lastDprEval > 1000) {
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

  if (time - lastSkyUpdate > SKY_UPDATE_INTERVAL) {
    const sinTime = Math.sin(timeOfDay);
    const cosTime = Math.cos(timeOfDay);
    directionalLight.position.set(cosTime*100, sinTime*100, sinTime*40);
    const intensity = Math.max(0, sinTime);
    directionalLight.intensity = intensity * 1.5;
    if (intensity > 0) {
      scene.background.setHSL(0.55, 0.5, 0.5 + intensity*0.3);
      scene.fog.color.copy(scene.background);
      ambientLight.intensity = 0.2 + intensity*0.4;
    } else {
      scene.background.setHex(0x050515);
      scene.fog.color.copy(scene.background);
      ambientLight.intensity = 0.1;
    }
    lastSkyUpdate = time;
  }

  // Update shadow map only every 2 seconds
  if (!animate._lastShadow || time - animate._lastShadow > 2000) {
    renderer.shadowMap.needsUpdate = true;
    animate._lastShadow = time;
  }

  // Periodic physics + visible list update
  if (time - lastCullingUpdate > CULLING_UPDATE_INTERVAL) {
    updatePhysicsBodies(camera.position);

    const playerChunkX = Math.floor(camera.position.x / CHUNK_SIZE);
    const playerChunkZ = Math.floor(camera.position.z / CHUNK_SIZE);
    const movedChunk = playerChunkX !== lastPlayerChunkX || playerChunkZ !== lastPlayerChunkZ;
    ensureChunksAroundPlayer(camera.position);
    if (needsVisibleRebuild || movedChunk) {
      rebuildVisibleObjects();
      needsVisibleRebuild = false;
      lastPlayerChunkX = playerChunkX;
      lastPlayerChunkZ = playerChunkZ;
    }

    lastCullingUpdate = time;
  }

  if (controls.isLocked) {
    // Block highlight
    if (time - lastRaycasterUpdate > RAYCASTER_UPDATE_INTERVAL) {
      raycaster.setFromCamera(_screenCenter, camera);
      const hits = raycaster.intersectObjects(visibleObjects, false);
      if (hits.length && hits[0].distance <= 5) {
        const hit = hits[0];
        rollOverMesh.position.set(
          Math.round(hit.point.x - hit.face.normal.x * 0.5),
          Math.round(hit.point.y - hit.face.normal.y * 0.5),
          Math.round(hit.point.z - hit.face.normal.z * 0.5)
        );
        rollOverMesh.visible = true;
      } else {
        rollOverMesh.visible = false;
      }
      lastRaycasterUpdate = time;
    }

    const delta = Math.min(rawDelta, 0.1);
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= 30 * delta;

    _right.setFromMatrixColumn(camera.matrix, 0);
    _right.y = 0; _right.normalize();
    _front.crossVectors(_up, _right).normalize();
    _moveVec.set(0,0,0);
    if (moveForward)  _moveVec.add(_front);
    if (moveBackward) _moveVec.sub(_front);
    if (moveLeft)     _moveVec.sub(_right);
    if (moveRight)    _moveVec.add(_right);
    if (_moveVec.lengthSq() > 0) _moveVec.normalize().multiplyScalar(10 * delta);

    _rapierMovement.x = _moveVec.x;
    _rapierMovement.y = velocity.y * delta;
    _rapierMovement.z = _moveVec.z;

    characterController.computeColliderMovement(playerCollider, _rapierMovement);
    const cm = characterController.computedMovement();
    if (characterController.computedGrounded()) { canJump=true; if(velocity.y<0) velocity.y=0; }

    const np = playerBody.translation();
    np.x+=cm.x; np.y+=cm.y; np.z+=cm.z;
    playerBody.setNextKinematicTranslation(np);
    world.step();

    const pos = playerBody.translation();
    controls.getObject().position.set(pos.x, pos.y+0.8, pos.z);
  }

  prevTime = time;
  renderer.render(scene, camera);
}
