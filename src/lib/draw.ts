/** 结构式绘制的数据模型与渲染 */

import { drawFormulaText } from "./drawText";

export type BondOrder = 1 | 2 | 3;

export interface Pt {
  x: number;
  y: number;
}

export type DrawOp =
  | { type: "free"; color: string; width: number; points: Pt[] }
  | { type: "erase"; width: number; points: Pt[] }
  | {
      type: "bond";
      color: string;
      width: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      order: BondOrder;
    }
  | { type: "text"; color: string; x: number; y: number; text: string; size: number };

export interface DrawStyle {
  color: string;
  width: number;
  order: BondOrder;
  bondLength: number;
  fontSize: number;
  snap: boolean;
}

const TAU = Math.PI * 2;

function strokePolyline(ctx: CanvasRenderingContext2D, points: Pt[], width: number, color: string) {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, width / 2, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function strokeBond(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  order: BondOrder,
  width: number,
  color: string
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const gap = width * 3.2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";

  const line = (ox: number, oy: number) => {
    ctx.beginPath();
    ctx.moveTo(x1 + ox, y1 + oy);
    ctx.lineTo(x2 + ox, y2 + oy);
    ctx.stroke();
  };

  if (order === 1) {
    line(0, 0);
  } else if (order === 2) {
    line(nx * gap * 0.5, ny * gap * 0.5);
    line(-nx * gap * 0.5, -ny * gap * 0.5);
  } else {
    line(0, 0);
    line(nx * gap, ny * gap);
    line(-nx * gap, -ny * gap);
  }
  ctx.restore();
}

export interface RenderOpts {
  fontFamily: string;
}

/** 把操作序列重绘到描边层（支持橡皮擦的 destination-out 语义） */
export function renderOps(
  ctx: CanvasRenderingContext2D,
  ops: DrawOp[],
  width: number,
  height: number,
  opts: RenderOpts
) {
  ctx.clearRect(0, 0, width, height);

  for (const op of ops) {
    if (op.type === "free") {
      strokePolyline(ctx, op.points, op.width, op.color);
    } else if (op.type === "erase") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      strokePolyline(ctx, op.points, op.width, "#000");
      ctx.restore();
    } else if (op.type === "bond") {
      strokeBond(ctx, op.x1, op.y1, op.x2, op.y2, op.order, op.width, op.color);
    } else if (op.type === "text") {
      drawFormulaText(ctx, op.text, op.x, op.y, op.size, op.color, opts.fontFamily);
    }
  }
}

/** 收集所有锚点，用于把新键吸附到已有原子上 */
export function collectAnchors(ops: DrawOp[]): Pt[] {
  const pts: Pt[] = [];
  for (const op of ops) {
    if (op.type === "bond") {
      pts.push({ x: op.x1, y: op.y1 }, { x: op.x2, y: op.y2 });
    } else if (op.type === "text") {
      pts.push({ x: op.x, y: op.y });
    }
  }
  return pts;
}

/** 按 30° 晶格吸附（六元环等角度的标准画法） */
export function snapPoint(
  anchor: Pt | null,
  raw: Pt,
  bondLength: number,
  snapAngle: boolean,
  anchors: Pt[]
): Pt {
  // 优先吸附到已有原子
  for (const a of anchors) {
    if (Math.hypot(a.x - raw.x, a.y - raw.y) < 12) return { ...a };
  }

  if (!anchor) return raw;
  const dx = raw.x - anchor.x;
  const dy = raw.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 3) return raw;

  if (!snapAngle) return raw;

  const step = Math.PI / 6;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = dist < bondLength * 0.55 ? dist : bondLength;
  return {
    x: anchor.x + Math.cos(angle) * length,
    y: anchor.y + Math.sin(angle) * length,
  };
}
