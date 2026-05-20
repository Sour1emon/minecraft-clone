export const CHUNK_SIZE = 16;
export const WORLD_MIN_Y = -8;
export const WORLD_MAX_Y = 48;
export const TREE_NOISE_OFFSET = 1337;

export const BLOCK_TYPES = [
  "dirt",
  "stone",
  "grass",
  "wood",
  "leaves",
  "sand",
  "brick",
  "glass",
];

export const TRANSPARENT_TYPES = new Set(["glass", "leaves"]);

export const PERFORMANCE = {
  lowQualityMode: true,
  shadows: false,
  adaptiveRes: true,
};

export const KEY_BINDS = {
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
