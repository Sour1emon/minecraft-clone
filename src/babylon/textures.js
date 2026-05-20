import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";

export const iconUris = {};
const textureCache = new Map();

function makeCanvasTexture(scene, type) {
  if (textureCache.has(type)) return textureCache.get(type);

  // DynamicTexture accepts a numeric size or object; use numeric for broader compatibility
  const texture = new DynamicTexture(`tex-${type}`, 16, scene, false);
  const ctx = texture.getContext();
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let baseColor, noiseColors;
  if (type === "dirt") { baseColor = [139, 69, 19]; noiseColors = [[107, 52, 16], [155, 86, 32]]; }
  else if (type === "stone") { baseColor = [128, 128, 128]; noiseColors = [[100, 100, 100], [150, 150, 150]]; }
  else if (type === "grass_top") { baseColor = [85, 170, 85]; noiseColors = [[68, 153, 68], [102, 187, 102]]; }
  else if (type === "wood_top") { baseColor = [139, 90, 43]; noiseColors = [[120, 75, 35], [150, 100, 50]]; }
  else if (type === "sand") { baseColor = [238, 214, 175]; noiseColors = [[200, 180, 140], [255, 230, 190]]; }

  if (type === "brick") {
    ctx.fillStyle = "#aaa";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#b22222";
    for (let r = 0; r < 4; r++) {
      const offset = r % 2 === 0 ? 0 : -8;
      for (let c = 0; c < 2; c++) ctx.fillRect(c * 16 + offset, r * 4, 15, 3);
    }
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = "rgba(0,0,0,0.2)";
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
  } else if (type === "grass_side") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const isGrass = y < 4 || (y < 6 && Math.random() > 0.5);
      const c = isGrass ? (Math.random() > 0.5 ? [85, 170, 85] : [68, 153, 68]) : (Math.random() > 0.5 ? [139, 69, 19] : [107, 52, 16]);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x, y, 1, 1);
    }
  } else if (type === "wood_side") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const stripe = (x + Math.floor(Math.random() * 1.5)) % 4;
      const c = stripe < 2 ? [107, 66, 38] : [74, 46, 27];
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(x, y, 1, 1);
    }
  } else if (type === "leaves") {
    ctx.fillStyle = "rgb(34,139,34)";
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 150; i++) {
      const x = rand(0, 15);
      const y = rand(0, 15);
      const p = Math.random();
      if (p < 0.4) ctx.clearRect(x, y, 1, 1);
      else {
        ctx.fillStyle = p < 0.7 ? "rgb(17,119,17)" : "rgb(50,170,50)";
        ctx.fillRect(x, y, 1, 1);
      }
    }
  } else if (["dirt", "stone", "grass_top", "wood_top", "sand"].includes(type)) {
    ctx.fillStyle = `rgb(${baseColor[0]},${baseColor[1]},${baseColor[2]})`;
    ctx.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 150; i++) {
      const nc = noiseColors[rand(0, 1)];
      ctx.fillStyle = `rgb(${nc[0]},${nc[1]},${nc[2]})`;
      ctx.fillRect(rand(0, 15), rand(0, 15), 1, 1);
    }
  }

  texture.update(false);
  texture.hasAlpha = type === "glass" || type === "leaves";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  textureCache.set(type, texture);
  iconUris[type] = texture.getContext().canvas.toDataURL();
  return texture;
}

export function getBlockTexture(scene, type) {
  return makeCanvasTexture(scene, type);
}

export function prewarmTextures(scene) {
  ["dirt", "stone", "grass_top", "grass_side", "wood_top", "wood_side", "leaves", "sand", "brick", "glass"].forEach((type) => {
    makeCanvasTexture(scene, type);
  });
  iconUris.grass = iconUris.grass_side;
  iconUris.wood = iconUris.wood_side;
}
