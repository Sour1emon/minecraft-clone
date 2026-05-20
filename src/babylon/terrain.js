import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

import { CHUNK_SIZE, WORLD_MIN_Y, WORLD_MAX_Y, TRANSPARENT_TYPES } from "./constants.js";

const FACES = [
  { dir: [1, 0, 0], verts: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { dir: [-1, 0, 0], verts: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { dir: [0, 1, 0], verts: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { dir: [0, -1, 0], verts: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { dir: [0, 0, 1], verts: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { dir: [0, 0, -1], verts: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
];

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
  return blockType;
}

export function createTerrainSystem({ scene, noise, getTexture, markVisibleDirty }) {
  const blockMap = new Map();
  const chunkBlockIndex = new Map();
  const chunkMeshes = new Map();
  const dirtyChunks = new Set();
  const generatedChunks = new Set();
  const materialCache = new Map();
  let shadowGenerator = null;

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

  function getTerrainHeight(x, z) {
    // fractal Brownian motion for smoother, more natural height
    function fbm(nx, nz, octaves, lacunarity = 2, gain = 0.5) {
      let amp = 1.0;
      let freq = 1.0;
      let sum = 0.0;
      let max = 0.0;
      for (let i = 0; i < octaves; i++) {
        sum += amp * (noise.noise2D(nx * freq, nz * freq) * 0.5 + 0.5);
        max += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / max;
    }

    const nx = x / 100;
    const nz = z / 100;
    const continental = fbm(nx, nz, 3, 2, 0.6); // large features
    const detail = fbm(x / 30, z / 30, 4, 2, 0.5); // small-scale variation
    const peaks = fbm(x / 12, z / 12, 2, 2, 0.7); // sharper peaks
    const base = -3 + continental * 14; // base continent height
    const h = Math.floor(base + detail * 6 + Math.max(0, peaks - 0.45) * 12);
    return Math.min(WORLD_MAX_Y - 6, Math.max(WORLD_MIN_Y + 2, h));
  }

  function shouldSpawnTree(x, z) {
    const v = (noise.noise2D((x + 1337) / 24, (z - 1337) / 24) + 1) * 0.5;
    return v > 0.6;
  }

  // small utility to classify biome at world coords
  function getBiomeAt(x, z) {
    const t = (noise.noise2D(x / 120, z / 120) + 1) * 0.5; // temperature-ish
    const m = (noise.noise2D((x + 5000) / 60, (z - 5000) / 60) + 1) * 0.5; // moisture-ish
    if (t > 0.75 && m < 0.4) return 'desert';
    if (t < 0.35) return 'taiga';
    if (m > 0.65) return 'forest';
    return 'plains';
  }

  // village tracking to avoid overlapping villages
  const generatedVillages = new Set();

  function setBlockInternal(x, y, z, type, markDirty = true) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return false;
    const posKey = `${x},${y},${z}`;
    if (blockMap.has(posKey)) return false;
    blockMap.set(posKey, type);
    indexBlockInChunk(posKey, x, z);
    if (markDirty) markChunkDirty(x, y, z);
    return true;
  }

  function addTreeToMap(x, y, z, touchedChunks) {
    const heightNoise = (noise.noise2D((x - 1337) / 12, (z + 1337) / 12) + 1) * 0.5;
    const trunkHeight = 4 + Math.floor(heightNoise * 3);
    for (let i = 0; i < trunkHeight; i++) {
      if (setBlockInternal(x, y + i, z, "wood", false)) touchedChunks.add(getChunkKeyFromWorld(x, z));
    }
    for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 2; lz++) for (let ly = trunkHeight - 2; ly <= trunkHeight + 1; ly++) {
      if (Math.abs(lx) === 2 && Math.abs(lz) === 2 && ly === trunkHeight + 1) continue;
      if (lx === 0 && lz === 0 && ly < trunkHeight) continue;
      const wx = x + lx;
      const wy = y + ly;
      const wz = z + lz;
      if (setBlockInternal(wx, wy, wz, "leaves", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
    }
  }

  function rebuildChunk(chunkX, chunkZ) {
    const chunkKey = `${chunkX},${chunkZ}`;
    const existing = chunkMeshes.get(chunkKey);
    if (existing) {
      // dispose meshes but do NOT dispose shared materials/textures (they're cached)
      existing.forEach((mesh) => mesh.dispose(false, false));
      chunkMeshes.delete(chunkKey);
    }

    const blockKeys = chunkBlockIndex.get(chunkKey);
    if (!blockKeys || blockKeys.size === 0) return;

    const buffers = new Map();
    for (const posKey of blockKeys) {
      const [wx, wy, wz] = posKey.split(",").map(Number);
      const blockType = blockMap.get(posKey);
      if (!blockType) continue;
      const isTransparent = TRANSPARENT_TYPES.has(blockType);

      for (const face of FACES) {
        const [dx, dy, dz] = face.dir;
        const neighborKey = `${wx + dx},${wy + dy},${wz + dz}`;
        const neighbor = blockMap.get(neighborKey);
        if (neighbor && !TRANSPARENT_TYPES.has(neighbor)) continue;
        if (neighbor && isTransparent && neighbor === blockType) continue;

        const texName = getFaceTexture(blockType, face.dir);
        const bufKey = `${texName}|${isTransparent ? "t" : "o"}`;
        if (!buffers.has(bufKey)) buffers.set(bufKey, { texName, transparent: isTransparent, positions: [], normals: [], uvs: [], indices: [] });
        const buf = buffers.get(bufKey);
        const base = buf.positions.length / 3;

        for (let v = 0; v < 4; v++) {
          const [vx, vy, vz] = face.verts[v];
          // store positions relative to the chunk origin so blocks occupy [x,x+1) world space
          buf.positions.push((wx + 0.5 - (chunkX * CHUNK_SIZE)) + vx, (wy + 0.5) + vy, (wz + 0.5 - (chunkZ * CHUNK_SIZE)) + vz);
          buf.normals.push(dx, dy, dz);
          // Flip V because canvas-based textures have origin at top-left
          buf.uvs.push(face.uvs[v][0], 1 - face.uvs[v][1]);
        }
        buf.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    const chunkList = [];
    const materialKey = (texName, transparent) => `${texName}|${transparent ? "t" : "o"}`;
    for (const [key, buf] of buffers) {
      if (buf.indices.length === 0) continue;
      const geo = new VertexData();
      geo.positions = buf.positions;
      geo.normals = buf.normals;
      geo.uvs = buf.uvs;
      geo.indices = buf.indices;

      const mesh = new Mesh(`chunk-${chunkKey}-${key}`, scene);
      geo.applyToMesh(mesh, true);
      // position the mesh at the chunk origin (vertices are stored relative to this)
      mesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
      // avoid freezing world matrix until bounds are validated (prevents incorrect culling)
      // mesh.freezeWorldMatrix();
      mesh.checkCollisions = true;
      mesh.isPickable = true;
      mesh.metadata = { chunkKey, texKey: key };

      const matKey = materialKey(buf.texName, buf.transparent);
      let material = materialCache.get(matKey);
      if (!material) {
        material = new StandardMaterial(`mat-${matKey}`, scene);
        material.diffuseTexture = getTexture(scene, buf.texName);
        // Render both sides to avoid issues with winding and missing faces
        material.backFaceCulling = false;
        material.alpha = buf.transparent ? 0.9 : 1;
        materialCache.set(matKey, material);
      }
      mesh.material = material;
      // receive and cast shadows when a generator is registered
      try { mesh.receiveShadows = true; } catch (e) { /* ignore */ }
      if (shadowGenerator) {
        try { shadowGenerator.addShadowCaster(mesh, true); } catch (e) { /* ignore */ }
      }
      chunkList.push(mesh);
    }

    if (chunkList.length > 0) chunkMeshes.set(chunkKey, chunkList);
  }

  function registerShadowGenerator(gen) {
    shadowGenerator = gen;
    // add current chunk meshes to generator
    for (const meshes of chunkMeshes.values()) {
      for (const m of meshes) {
        try { shadowGenerator.addShadowCaster(m, true); m.receiveShadows = true; } catch (e) { /* ignore */ }
      }
    }
  }

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
    markVisibleDirty();
  }

  function flushDirtyChunks() {
    if (dirtyChunks.size === 0) return;
    const key = dirtyChunks.values().next().value;
    dirtyChunks.delete(key);
    const [cx, cz] = key.split(",").map(Number);
    rebuildChunk(cx, cz);
  }

  function generateChunk(chunkX, chunkZ) {
    const chunkKey = `${chunkX},${chunkZ}`;
    if (generatedChunks.has(chunkKey)) return;

    const touchedChunks = new Set([chunkKey]);
    const x0 = chunkX * CHUNK_SIZE;
    const z0 = chunkZ * CHUNK_SIZE;

    // generate terrain with simple biomes and occasional villages
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = x0 + lx;
        const wz = z0 + lz;
        // biome noise determines surface type
        const b = (noise.noise2D(wx / 80, wz / 80) + 1) * 0.5;
        let biome = 'plains';
        if (b > 0.7) biome = 'desert';
        else if (b < 0.2) biome = 'mountain';

        const height = getTerrainHeight(wx, wz);
        for (let y = WORLD_MIN_Y; y < height - 3; y++) {
          if (setBlockInternal(wx, y, wz, "stone", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
        }
        for (let y = Math.max(WORLD_MIN_Y, height - 3); y < height; y++) {
          if (setBlockInternal(wx, y, wz, "dirt", false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
        }
        let topType = 'grass';
        if (biome === 'desert') topType = 'sand';
        else if (biome === 'mountain') topType = 'stone';
        if (setBlockInternal(wx, height, wz, topType, false)) touchedChunks.add(getChunkKeyFromWorld(wx, wz));
        if (topType === 'grass' && shouldSpawnTree(wx, wz)) addTreeToMap(wx, height + 1, wz, touchedChunks);
      }
    }

    // Improved village generation: place only in plains biome and avoid overlaps
    const villageNoise = (noise.noise2D(chunkX * 0.5 + 91.7, chunkZ * 0.5 - 47.3) + 1) * 0.5;
    const chunkCenterX = x0 + Math.floor(CHUNK_SIZE / 2);
    const chunkCenterZ = z0 + Math.floor(CHUNK_SIZE / 2);
    const centerBiome = getBiomeAt(chunkCenterX, chunkCenterZ);
    const villageKey = `${chunkX},${chunkZ}`;
    if (villageNoise > 0.94 && centerBiome === 'plains' && !generatedVillages.has(villageKey)) {
      generatedVillages.add(villageKey);
      const houses = 1 + Math.floor(((noise.noise2D(chunkX + 3.3, chunkZ - 2.7) + 1) * 0.5) * 3);
      const placed = [];
      for (let h = 0; h < houses; h++) {
        // deterministic-ish placement within chunk to reduce overlaps
        const hx = x0 + 2 + (h % Math.max(1, CHUNK_SIZE - 6));
        const hz = z0 + 2 + Math.floor(h / Math.max(1, Math.floor(CHUNK_SIZE / 5))) * 4;
        const ground = getTerrainHeight(hx, hz);
        // prepare foundation
        for (let x = hx - 1; x <= hx + 3; x++) for (let z = hz - 1; z <= hz + 3; z++) {
          if (setBlockInternal(x, ground, z, 'dirt', true)) touchedChunks.add(getChunkKeyFromWorld(x, z));
          // clear above
          for (let y = ground + 1; y <= ground + 4; y++) {
            const key = `${x},${y},${z}`;
            if (blockMap.has(key)) { blockMap.delete(key); unindexBlockFromChunk(key, x, z); }
          }
        }
        // walls
        for (let x = hx; x < hx + 3; x++) for (let z = hz; z < hz + 3; z++) for (let y = ground + 1; y < ground + 3; y++) {
          if (x === hx || x === hx + 2 || z === hz || z === hz + 2) setBlockInternal(x, y, z, 'wood', true);
        }
        // window and door (remove block for doorway)
        setBlockInternal(hx + 1, ground + 1, hz + 2, 'glass', true);
        const doorKey = `${hx + 1},${ground + 1},${hz}`;
        if (blockMap.has(doorKey)) { blockMap.delete(doorKey); unindexBlockFromChunk(doorKey, hx + 1, hz); }
        // roof
        for (let x = hx - 1; x <= hx + 3; x++) for (let z = hz - 1; z <= hz + 3; z++) setBlockInternal(x, ground + 3, z, 'brick', true);
        placed.push({ hx, hz });
      }
      // connect houses with dirt paths and low fences
      for (const p of placed) {
        const cx = chunkCenterX;
        const cz = chunkCenterZ;
        const steps = Math.max(Math.abs(cx - p.hx), Math.abs(cz - p.hz));
        for (let s = 0; s <= steps; s++) {
          const px = Math.round(p.hx + (cx - p.hx) * (s / steps));
          const pz = Math.round(p.hz + (cz - p.hz) * (s / steps));
          const py = getTerrainHeight(px, pz);
          setBlockInternal(px, py, pz, 'dirt', true);
          if (s % 4 === 0) setBlockInternal(px, py + 1, pz, 'wood', true);
        }
      }
    }

    generatedChunks.add(chunkKey);
    for (const dirtyKey of touchedChunks) dirtyChunks.add(dirtyKey);
    markVisibleDirty();
  }

  function generateChunksImmediate(centerChunkX, centerChunkZ, radius) {
    for (let cx = centerChunkX - radius; cx <= centerChunkX + radius; cx++) {
      for (let cz = centerChunkZ - radius; cz <= centerChunkZ + radius; cz++) {
        generateChunk(cx, cz);
        rebuildChunk(cx, cz);
      }
    }
  }

  function unloadFarChunkMeshes(playerChunkX, playerChunkZ, keepRadius) {
    for (const key of Array.from(chunkMeshes.keys())) {
      const [cx, cz] = key.split(",").map(Number);
      if (Math.abs(cx - playerChunkX) > keepRadius || Math.abs(cz - playerChunkZ) > keepRadius) {
        chunkMeshes.get(key).forEach((mesh) => mesh.dispose(false, false));
        chunkMeshes.delete(key);
      }
    }
  }

  function ensureChunksAroundPlayer(playerPos) {
    const playerChunkX = Math.floor(playerPos.x / CHUNK_SIZE);
    const playerChunkZ = Math.floor(playerPos.z / CHUNK_SIZE);
    const radius = Math.max(2, 6 + 1);
    const missingChunks = [];

    for (let cx = playerChunkX - radius; cx <= playerChunkX + radius; cx++) {
      for (let cz = playerChunkZ - radius; cz <= playerChunkZ + radius; cz++) {
        const key = `${cx},${cz}`;
        if (generatedChunks.has(key)) continue;
        const dist = Math.abs(cx - playerChunkX) + Math.abs(cz - playerChunkZ);
        missingChunks.push({ cx, cz, dist });
      }
    }

    missingChunks.sort((a, b) => a.dist - b.dist);
    const count = Math.min(3, missingChunks.length);
    for (let i = 0; i < count; i++) {
      const { cx, cz } = missingChunks[i];
      generateChunk(cx, cz);
    }

    unloadFarChunkMeshes(playerChunkX, playerChunkZ, radius + 2);
  }

  function getBlockType(x, y, z) {
    return blockMap.get(`${x},${y},${z}`) || null;
  }

  function addBlock(x, y, z, type) {
    return setBlockInternal(x, y, z, type, true);
  }

  function removeBlock(posKey) {
    if (!blockMap.has(posKey)) return;
    const [x, y, z] = posKey.split(",").map(Number);
    blockMap.delete(posKey);
    unindexBlockFromChunk(posKey, x, z);
    markChunkDirty(x, y, z);
  }

  function clearWorld() {
    for (const meshes of chunkMeshes.values()) meshes.forEach((mesh) => mesh.dispose(false, false));
    chunkMeshes.clear();
    // dispose cached materials/textures since we're clearing the whole world
    for (const mat of materialCache.values()) {
      try { mat.dispose(true); } catch (e) { /* ignore disposal errors */ }
    }
    materialCache.clear();
    blockMap.clear();
    chunkBlockIndex.clear();
    dirtyChunks.clear();
    generatedChunks.clear();
    markVisibleDirty();
  }

  function findHighestBlockNearby(x, z, radius) {
    let found = null;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
          if (blockMap.has(`${x + dx},${y},${z + dz}`)) {
            if (found === null || y > found) found = y;
            break;
          }
        }
      }
    }
    return found;
  }

  return {
    blockMap,
    chunkMeshes,
    dirtyChunks,
    generatedChunks,
    flushDirtyChunks,
    generateChunk,
    generateChunksImmediate,
    ensureChunksAroundPlayer,
    unloadFarChunkMeshes,
    rebuildChunk,
    markChunkDirty,
    getTerrainHeight,
    getBlockType,
    addBlock,
    removeBlock,
    clearWorld,
    findHighestBlockNearby,
    registerShadowGenerator,
  };
}
