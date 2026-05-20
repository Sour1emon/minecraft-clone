use noise::{NoiseFn, Perlin};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ── constants ──────────────────────────────────────────────────────────
const CHUNK_SIZE: i32 = 16;
const WORLD_MIN_Y: i32 = -8;
const WORLD_MAX_Y: i32 = 48;
const Y_EXTENT: i32 = WORLD_MAX_Y - WORLD_MIN_Y + 1;
const Y_EXTENT_USIZE: usize = Y_EXTENT as usize;

// block type IDs (match your JS)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Block {
    Air = 0,
    Dirt,
    Stone,
    Grass,
    Wood,
    Leaves,
    Sand,
    Brick,
    Glass,
}
impl Block {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Block::Dirt,
            2 => Block::Stone,
            3 => Block::Grass,
            4 => Block::Wood,
            5 => Block::Leaves,
            6 => Block::Sand,
            7 => Block::Brick,
            8 => Block::Glass,
            _ => Block::Air,
        }
    }
    fn is_opaque(self) -> bool {
        !matches!(self, Block::Air | Block::Glass | Block::Leaves)
    }
    fn is_transparent(self) -> bool {
        matches!(self, Block::Glass | Block::Leaves)
    }
}

// ── chunk storage ──────────────────────────────────────────────────────
struct Chunk {
    data: Box<[Block; (CHUNK_SIZE * CHUNK_SIZE * Y_EXTENT) as usize]>,
}
impl Chunk {
    fn new() -> Self {
        Chunk {
            data: vec![Block::Air; (CHUNK_SIZE * CHUNK_SIZE * Y_EXTENT) as usize]
                .into_boxed_slice()
                .try_into()
                .unwrap(),
        }
    }
    fn index(x: i32, y: i32, z: i32) -> usize {
        let ly = (y - WORLD_MIN_Y) as usize;
        (ly * (CHUNK_SIZE as usize * CHUNK_SIZE as usize))
            + (z as usize * CHUNK_SIZE as usize)
            + x as usize
    }
    fn get(&self, x: i32, y: i32, z: i32) -> Block {
        if !(0..CHUNK_SIZE).contains(&x)
            || !(0..CHUNK_SIZE).contains(&z)
            || !(WORLD_MIN_Y..=WORLD_MAX_Y).contains(&y)
        {
            return Block::Air;
        }
        self.data[Self::index(x, y, z)]
    }
    fn set(&mut self, x: i32, y: i32, z: i32, block: Block) {
        if !(0..CHUNK_SIZE).contains(&x) || z < 0 || !(0..CHUNK_SIZE).contains(&z) {
            return;
        }
        self.data[Self::index(x, y, z)] = block;
    }
}

// ── global world state ─────────────────────────────────────────────────
static mut WORLD: Option<HashMap<(i32, i32), Chunk>> = None;
static mut NOISE: Option<Perlin> = None;

fn world() -> &'static mut HashMap<(i32, i32), Chunk> {
    unsafe { WORLD.as_mut().unwrap() }
}
fn noise() -> &'static Perlin {
    unsafe { NOISE.as_ref().unwrap() }
}

// ── initialization exports ────────────────────────────────────────────
#[wasm_bindgen]
pub fn init_world() {
    unsafe {
        WORLD = Some(HashMap::new());
    }
}

#[wasm_bindgen]
pub fn init_noise(seed: u32) {
    unsafe {
        NOISE = Some(Perlin::new(seed));
    }
}

// ── world queries (replace blockMap.get) ──────────────────────────────
#[wasm_bindgen]
pub fn get_block(wx: i32, wy: i32, wz: i32) -> u8 {
    let (cx, cz) = world_to_chunk(wx, wz);
    let lx = wx - cx * CHUNK_SIZE;
    let lz = wz - cz * CHUNK_SIZE;
    let chunk = world().get(&(cx, cz));
    match chunk {
        Some(c) => c.get(lx, wy, lz) as u8,
        None => Block::Air as u8,
    }
}

// ── terrain height ─────────────────────────────────────────────────────
fn terrain_height(wx: f64, wz: f64) -> i32 {
    let perlin = noise();
    let continental = (perlin.get([wx / 120.0, wz / 120.0]) + 1.0) * 0.5;
    let detail = (perlin.get([wx / 40.0, wz / 40.0]) + 1.0) * 0.5;
    let peaks = (perlin.get([wx / 18.0, wz / 18.0]) + 1.0) * 0.5;
    let h = (-2.0 + continental * 12.0 + detail * 6.0 + peaks * 3.0) as i32;
    h.clamp(WORLD_MIN_Y + 2, WORLD_MAX_Y - 6)
}

fn should_spawn_tree(wx: f64, wz: f64) -> bool {
    let v = (noise().get([(wx + 1337.0) / 24.0, (wz - 1337.0) / 24.0]) + 1.0) * 0.5;
    v > 0.87
}

// ── chunk generation ───────────────────────────────────────────────────
#[wasm_bindgen]
pub fn generate_chunk(cx: i32, cz: i32) {
    {
        let world = world();
        if world.contains_key(&(cx, cz)) {
            return;
        }
    }
    let mut chunk = Chunk::new();
    let x0 = cx * CHUNK_SIZE;
    let z0 = cz * CHUNK_SIZE;

    for lx in 0..CHUNK_SIZE {
        for lz in 0..CHUNK_SIZE {
            let wx = (x0 + lx) as f64;
            let wz = (z0 + lz) as f64;
            let h = terrain_height(wx, wz);
            let top_type = if h <= 1 { Block::Sand } else { Block::Grass };

            // Fill stone and dirt layers
            for y in WORLD_MIN_Y..=h {
                let block = if y <= h - 3 {
                    Block::Stone
                } else if y < h {
                    Block::Dirt
                } else {
                    top_type
                };
                chunk.set(lx, y, lz, block);
            }

            // Tree placement
            if top_type == Block::Grass && should_spawn_tree(wx, wz) {
                let tree_h_offset =
                    (noise().get([(wx + 1337.0) / 12.0, (wz - 1337.0) / 12.0]) + 1.0) * 1.5;
                let trunk_h = (4 + tree_h_offset as i32).clamp(3, 6);
                for i in 0..trunk_h {
                    chunk.set(lx, h + 1 + i, lz, Block::Wood);
                }
                // Leaves
                let leaf_y_start = h + trunk_h - 2;
                let leaf_y_end = h + trunk_h + 1;
                for dx in -2..=2 {
                    for dz in -2..=2 {
                        for dy in leaf_y_start..=leaf_y_end {
                            if dx == 0_i32 && dz == 0_i32 && dy < h + trunk_h {
                                continue;
                            }
                            if dx.abs() == 2 && dz.abs() == 2 && dy == leaf_y_end {
                                continue;
                            }
                            let lx2 = lx + dx;
                            let lz2 = lz + dz;
                            let wy2 = dy;
                            if (0..CHUNK_SIZE).contains(&lx2) && (0..CHUNK_SIZE).contains(&lz2) {
                                chunk.set(lx2, wy2, lz2, Block::Leaves);
                            }
                        }
                    }
                }
            }
        }
    }
    world().insert((cx, cz), chunk);
}

// ── helper: get block from world (with chunk border resolution) ───────
fn world_get_block(wx: i32, wy: i32, wz: i32) -> Block {
    let (cx, cz) = world_to_chunk(wx, wz);
    let lx = wx - cx * CHUNK_SIZE;
    let lz = wz - cz * CHUNK_SIZE;
    if let Some(chunk) = world().get(&(cx, cz)) {
        chunk.get(lx, wy, lz)
    } else {
        Block::Air
    }
}

fn world_to_chunk(wx: i32, wz: i32) -> (i32, i32) {
    (wx.div_euclid(CHUNK_SIZE), wz.div_euclid(CHUNK_SIZE))
}

// ── mesh building (the big performance part) ─────────────────────────
// Face geometry data (identical to your JS)
const FACE_VERTICES: [[[f32; 3]; 4]; 6] = [
    // +X right
    [
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
        [0.5, -0.5, 0.5],
    ],
    // -X left
    [
        [-0.5, -0.5, 0.5],
        [-0.5, 0.5, 0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, -0.5],
    ],
    // +Y top
    [
        [-0.5, 0.5, -0.5],
        [-0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
        [0.5, 0.5, -0.5],
    ],
    // -Y bottom
    [
        [-0.5, -0.5, 0.5],
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, -0.5, 0.5],
    ],
    // +Z front
    [
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
    ],
    // -Z back
    [
        [0.5, -0.5, -0.5],
        [-0.5, -0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [0.5, 0.5, -0.5],
    ],
];

const FACE_UVS: [[[f32; 2]; 4]; 6] = [
    [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
    [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
    [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
    [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
    [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
    [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
];

const FACE_DIRS: [[i32; 3]; 6] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

const TEX_AIR: u8 = 0;
const TEX_DIRT: u8 = 1;
const TEX_STONE: u8 = 2;
const TEX_GRASS_TOP: u8 = 3;
const TEX_GRASS_SIDE: u8 = 4;
const TEX_WOOD_TOP: u8 = 5;
const TEX_WOOD_SIDE: u8 = 6;
const TEX_LEAVES: u8 = 7;
const TEX_SAND: u8 = 8;
const TEX_BRICK: u8 = 9;
const TEX_GLASS: u8 = 10;

fn face_texture(block: Block, face_dir: &[i32; 3]) -> u8 {
    match block {
        Block::Grass => {
            if face_dir[1] == 1 {
                TEX_GRASS_TOP
            } else if face_dir[1] == -1 {
                TEX_DIRT
            } else {
                TEX_GRASS_SIDE
            }
        }
        Block::Wood => {
            if face_dir[1] != 0 {
                TEX_WOOD_TOP
            } else {
                TEX_WOOD_SIDE
            }
        }
        Block::Dirt => TEX_DIRT,
        Block::Stone => TEX_STONE,
        Block::Leaves => TEX_LEAVES,
        Block::Sand => TEX_SAND,
        Block::Brick => TEX_BRICK,
        Block::Glass => TEX_GLASS,
        Block::Air => TEX_AIR,
    }
}

// Returns (opaque_vertex_data, opaque_indices, trans_vertex_data, trans_indices)
// Vertex layout: [px, py, pz, nx, ny, nz, u, v] – 8 floats per vertex.
pub struct MeshOutput {
    pub opaque_vertices: Vec<f32>,
    pub opaque_indices: Vec<u32>,
    pub transparent_vertices: Vec<f32>,
    pub transparent_indices: Vec<u32>,
}

// add this struct
struct MeshGroup {
    tex_id: u8,
    opaque_vertices: Vec<f32>,
    opaque_indices: Vec<u32>,
    transparent_vertices: Vec<f32>,
    transparent_indices: Vec<u32>,
}

fn build_chunk_mesh_internal(cx: i32, cz: i32) -> Vec<MeshGroup> {
    let chunk = match world().get(&(cx, cz)) {
        Some(c) => c,
        None => return vec![],
    };

    // We'll build one group per texture ID seen in the chunk
    let mut groups: Vec<MeshGroup> = Vec::new();
    // Find which texture IDs are used? We can just collect while iterating.
    // For simplicity, create a map from tex_id -> group index.
    let mut group_map: std::collections::HashMap<u8, usize> = std::collections::HashMap::new();

    for y in WORLD_MIN_Y..=WORLD_MAX_Y {
        for lz in 0..CHUNK_SIZE {
            for lx in 0..CHUNK_SIZE {
                let wx = cx * CHUNK_SIZE + lx;
                let wz = cz * CHUNK_SIZE + lz;
                let block = chunk.get(lx, y, lz);
                if block == Block::Air {
                    continue;
                }
                let is_transparent = block.is_transparent();

                for face_idx in 0..6 {
                    let dir = &FACE_DIRS[face_idx];
                    let nx = wx + dir[0];
                    let ny = y + dir[1];
                    let nz = wz + dir[2];
                    let neighbor = world_get_block(nx, ny, nz);

                    if neighbor != Block::Air && !neighbor.is_transparent() {
                        continue;
                    }
                    if is_transparent && neighbor == block {
                        continue;
                    }

                    let tex_id = face_texture(block, dir);
                    let group_idx = *group_map.entry(tex_id).or_insert_with(|| {
                        let idx = groups.len();
                        groups.push(MeshGroup {
                            tex_id,
                            opaque_vertices: Vec::new(),
                            opaque_indices: Vec::new(),
                            transparent_vertices: Vec::new(),
                            transparent_indices: Vec::new(),
                        });
                        idx
                    });

                    let group = &mut groups[group_idx];
                    let (verts_buf, idx_buf) = if is_transparent {
                        (
                            &mut group.transparent_vertices,
                            &mut group.transparent_indices,
                        )
                    } else {
                        (&mut group.opaque_vertices, &mut group.opaque_indices)
                    };

                    let base = (verts_buf.len() / 8) as u32;
                    let verts = &FACE_VERTICES[face_idx];
                    let uvs = &FACE_UVS[face_idx];
                    let norm = [dir[0] as f32, dir[1] as f32, dir[2] as f32];

                    for v in 0..4 {
                        let pos = verts[v];
                        verts_buf.push(wx as f32 + pos[0]);
                        verts_buf.push(y as f32 + pos[1]); // correct wy
                        verts_buf.push(wz as f32 + pos[2]);
                        verts_buf.push(norm[0]);
                        verts_buf.push(norm[1]);
                        verts_buf.push(norm[2]);
                        verts_buf.push(uvs[v][0]);
                        verts_buf.push(uvs[v][1]);
                    }
                    idx_buf.push(base);
                    idx_buf.push(base + 1);
                    idx_buf.push(base + 2);
                    idx_buf.push(base);
                    idx_buf.push(base + 2);
                    idx_buf.push(base + 3);
                }
            }
        }
    }
    groups
}

#[wasm_bindgen]
pub fn build_chunk_mesh(cx: i32, cz: i32) -> Vec<u8> {
    let groups = build_chunk_mesh_internal(cx, cz);
    let group_count = groups.len() as u32;

    // calculate buffer size
    let mut size = 4; // group count
    for g in &groups {
        size += 4 + 4 + 4 + 4 + 4; // tex_id + 4 counts (all u32)
        size += g.opaque_vertices.len() * 4;
        size += g.opaque_indices.len() * 4;
        size += g.transparent_vertices.len() * 4;
        size += g.transparent_indices.len() * 4;
    }

    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&group_count.to_le_bytes());

    for g in &groups {
        buf.extend_from_slice(&(g.tex_id as u32).to_le_bytes()); // store as u32 for simplicity
        buf.extend_from_slice(&((g.opaque_vertices.len() / 8) as u32).to_le_bytes());
        buf.extend_from_slice(&(g.opaque_indices.len() as u32).to_le_bytes());
        buf.extend_from_slice(&((g.transparent_vertices.len() / 8) as u32).to_le_bytes());
        buf.extend_from_slice(&(g.transparent_indices.len() as u32).to_le_bytes());

        // append data
        let push_floats = |b: &mut Vec<u8>, v: &[f32]| {
            b.extend_from_slice(unsafe {
                std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4)
            });
        };
        let push_u32s = |b: &mut Vec<u8>, v: &[u32]| {
            b.extend_from_slice(unsafe {
                std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4)
            });
        };

        push_floats(&mut buf, &g.opaque_vertices);
        push_u32s(&mut buf, &g.opaque_indices);
        push_floats(&mut buf, &g.transparent_vertices);
        push_u32s(&mut buf, &g.transparent_indices);
    }
    buf
}

// ── DDA raycast (replaces raycaster for block interaction) ───────────
#[wasm_bindgen]
pub fn raycast_block(
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_dist: f32,
) -> JsValue {
    // Standard DDA
    let mut t = 0.0f32;
    let mut ix = ox.floor() as i32;
    let mut iy = oy.floor() as i32;
    let mut iz = oz.floor() as i32;
    let step_x = if dx > 0.0 { 1 } else { -1 };
    let step_y = if dy > 0.0 { 1 } else { -1 };
    let step_z = if dz > 0.0 { 1 } else { -1 };
    let t_delta_x = if dx.abs() < 1e-6 {
        f32::MAX
    } else {
        1.0 / dx.abs()
    };
    let t_delta_y = if dy.abs() < 1e-6 {
        f32::MAX
    } else {
        1.0 / dy.abs()
    };
    let t_delta_z = if dz.abs() < 1e-6 {
        f32::MAX
    } else {
        1.0 / dz.abs()
    };
    let mut t_max_x = if dx > 0.0 {
        ((ix + 1) as f32 - ox) / dx
    } else {
        (ix as f32 - ox) / dx
    };
    let mut t_max_y = if dy > 0.0 {
        ((iy + 1) as f32 - oy) / dy
    } else {
        (iy as f32 - oy) / dy
    };
    let mut t_max_z = if dz > 0.0 {
        ((iz + 1) as f32 - oz) / dz
    } else {
        (iz as f32 - oz) / dz
    };

    let mut last_face = [0i32; 3];

    while t < max_dist {
        let block = world_get_block(ix, iy, iz);
        if block != Block::Air {
            // Return hit info as JSON-like object
            let hit_x = ix as f32;
            let hit_y = iy as f32;
            let hit_z = iz as f32;
            let result = serde_json::json!({
                "blockX": ix,
                "blockY": iy,
                "blockZ": iz,
                "faceNormal": last_face,
            });
            return JsValue::from_str(&result.to_string());
        }
        if t_max_x < t_max_y {
            if t_max_x < t_max_z {
                ix += step_x;
                t = t_max_x;
                t_max_x += t_delta_x;
                last_face = [-step_x, 0, 0];
            } else {
                iz += step_z;
                t = t_max_z;
                t_max_z += t_delta_z;
                last_face = [0, 0, -step_z];
            }
        } else {
            if t_max_y < t_max_z {
                iy += step_y;
                t = t_max_y;
                t_max_y += t_delta_y;
                last_face = [0, -step_y, 0];
            } else {
                iz += step_z;
                t = t_max_z;
                t_max_z += t_delta_z;
                last_face = [0, 0, -step_z];
            }
        }
    }
    JsValue::null() // no hit
}

#[wasm_bindgen]
pub fn set_block(wx: i32, wy: i32, wz: i32, block_id: u8) {
    let (cx, cz) = world_to_chunk(wx, wz);
    let lx = wx - cx * CHUNK_SIZE;
    let lz = wz - cz * CHUNK_SIZE;

    let world = world();
    let chunk = world.entry((cx, cz)).or_insert_with(Chunk::new);
    chunk.set(lx, wy, lz, Block::from_u8(block_id));
}
