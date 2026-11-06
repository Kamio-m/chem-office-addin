import { parseLine } from "./chem";

/**
 * 在 canvas 上绘制带自动下标的化学标注（如 CH3 → CH₃），
 * 与 SVG 渲染共用同一套标记语法，只是放大缩小由 canvas 字体控制。
 */
export function drawFormulaText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  size: number,
  color: string,
  family: string
) {
  const tokens = parseLine(text);
  const parts: Array<{ str: string; size: number; dy: number; dx: number }> = [];
  let width = 0;

  for (const t of tokens) {
    if (t.kind === "space") {
      width += size * 0.28 * t.width;
      continue;
    }
    if (t.kind === "arrow") {
      width += size * 0.9;
      continue;
    }
    const isScript = t.kind === "sub" || t.kind === "sup";
    const fontSize = isScript ? size * 0.64 : size;
    const dy = t.kind === "sub" ? size * 0.19 : t.kind === "sup" ? -size * 0.36 : 0;
    if (!t.text) continue;

    ctx.font = `${fontSize}px ${family}`;
    const w = ctx.measureText(t.text).width;
    parts.push({ str: t.text, size: fontSize, dy, dx: width });
    width += w;
  }

  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const originX = cx - width / 2;
  for (const p of parts) {
    ctx.font = `${p.size}px ${family}`;
    ctx.fillText(p.str, originX + p.dx, cy + p.dy);
  }
  ctx.restore();
}
