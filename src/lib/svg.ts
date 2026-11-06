import { type Token, type ArrowKind } from "./chem";

export interface RenderOptions {
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  padding?: number;
}

const DEFAULT_FONT = '"Times New Roman", "Nimbus Roman", "Liberation Serif", serif';

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

function measureText(text: string, size: number, family: string): number {
  const key = `${size}|${family}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;

  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (!measureCtx) return text.length * size * 0.55;

  measureCtx.font = `${size}px ${family}`;
  const w = measureCtx.measureText(text).width;
  widthCache.set(key, w);
  return w;
}

type Item =
  | { k: "text"; x: number; y: number; size: number; text: string }
  | { k: "arrow"; x: number; y: number; w: number; kind: ArrowKind; above?: { text: string; size: number; y: number }; below?: { text: string; size: number; y: number } };

interface LineLayout {
  items: Item[];
  width: number;
  top: number;
  bottom: number;
}

const SUB_SCALE = 0.64;
const SUP_SCALE = 0.64;

/** 反应式分隔符：加号两边要留出呼吸感，否则 H₂+Cl₂ 会挤成一团 */
function isSeparator(text: string): boolean {
  return /^[+=＋]$/.test(text.trim());
}

function layoutLine(
  tokens: Token[],
  F: number,
  family: string,
  minArrowWidth = 0
): LineLayout {
  const items: Item[] = [];
  const spaceUnit = measureText(" ", F, family) || F * 0.28;

  let x = 0;
  let top = -F * 0.82;
  let bottom = F * 0.22;

  const pushText = (text: string, size: number, dy: number) => {
    if (!text) return;
    items.push({ k: "text", x, y: dy, size, text });
    x += measureText(text, size, family);
    top = Math.min(top, dy - size * 0.82);
    bottom = Math.max(bottom, dy + size * 0.22);
  };

  let prevKind: Token["kind"] | null = null;

  for (const t of tokens) {
    switch (t.kind) {
      case "text": {
        const sep = isSeparator(t.text);
        if (sep && x > 0 && prevKind !== "space") x += F * 0.18;
        pushText(t.text, F, 0);
        if (sep) x += F * 0.18;
        break;
      }
      case "sub":
        pushText(t.text, F * SUB_SCALE, F * 0.19);
        break;
      case "sup":
        pushText(t.text, F * SUP_SCALE, -F * 0.40);
        break;
      case "space":
        x += spaceUnit * t.width;
        break;
      case "arrow": {
        // 箭头对齐到字母（大写高度）的垂直中线：基线之上 0.33em
        if (x > 0 && prevKind !== "space") x += F * 0.28;
        const axis = -F * 0.33;
        const condSize = F * 0.54;
        const arrowLen = arrowLength(t.arrow, F);
        const aboveW = t.above ? measureText(t.above, condSize, family) : 0;
        const belowW = t.below ? measureText(t.below, condSize, family) : 0;
        const w = Math.max(arrowLen, aboveW, belowW, minArrowWidth) + F * 0.28;

        const item: Item = { k: "arrow", x, y: axis, w, kind: t.arrow };
        // 等号有两条横线，占用更多竖向空间，条件要再往上（下）让一点
        const signHalf = t.arrow === "equals" ? F * 0.082 : 0;
        if (t.above) {
          // 条件紧贴符号上方：基线距离符号外缘约 0.2em
          const y = axis - F * 0.2 - signHalf;
          item.above = { text: t.above, size: condSize, y };
          top = Math.min(top, y - condSize * 0.82);
        }
        if (t.below) {
          const y = axis + F * 0.2 + signHalf + condSize * 0.72;
          item.below = { text: t.below, size: condSize, y };
          bottom = Math.max(bottom, y + condSize * 0.22);
        }
        items.push(item);
        x += w + F * 0.28;
        break;
      }
    }
    prevKind = t.kind;
  }

  return { items, width: x, top, bottom };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 各类箭头的默认长度（等号略短，视觉上和「=」更接近） */
function arrowLength(kind: ArrowKind, F: number): number {
  if (kind === "equals") return F * 1.15;
  if (kind === "equil") return F * 1.35;
  return F * 1.5;
}

function arrowSvg(item: Extract<Item, { k: "arrow" }>, F: number, color: string): string {
  const { x, y, w, kind } = item;
  const stroke = F * 0.055;
  const headLen = F * 0.2;
  const headHalf = F * 0.105;
  const parts: string[] = [];

  const line = (x1: number, x2: number, yy: number) =>
    `<line x1="${x1.toFixed(2)}" y1="${yy.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${yy.toFixed(2)}" stroke="${color}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round"/>`;

  const head = (tipX: number, yy: number, dir: 1 | -1) =>
    `<polygon points="${tipX.toFixed(2)},${yy.toFixed(2)} ${(tipX - dir * headLen).toFixed(2)},${(yy - headHalf).toFixed(2)} ${(tipX - dir * headLen).toFixed(2)},${(yy + headHalf).toFixed(2)}" fill="${color}"/>`;

  if (kind === "equals") {
    // 无机反应用等号：两条平行横线，条件同样叠在上方
    const dy = F * 0.082;
    parts.push(line(x, x + w, y - dy));
    parts.push(line(x, x + w, y + dy));
  } else if (kind === "equil") {
    const dy = F * 0.115;
    parts.push(line(x + headLen * 0.7, x + w, y - dy));
    parts.push(head(x + w, y - dy, 1));
    parts.push(line(x, x + w - headLen * 0.7, y + dy));
    parts.push(head(x, y + dy, -1));
  } else {
    const start = kind === "left" ? x + headLen * 0.7 : x;
    const end = kind === "right" ? x + w - headLen * 0.7 : x + w;
    parts.push(line(start, end, y));
    if (kind === "right" || kind === "both") parts.push(head(x + w, y, 1));
    if (kind === "left" || kind === "both") parts.push(head(x, y, -1));
  }
  return parts.join("");
}

/** 把化学式渲染成 SVG 字符串（预览与位图插入共用同一套排版） */
export function renderTokensToSvg(allTokens: Token[][], opts: RenderOptions = {}): { svg: string; width: number; height: number } {
  const F = opts.fontSize ?? 26;
  const color = opts.color ?? "#111827";
  const family = opts.fontFamily ?? DEFAULT_FONT;
  const padding = opts.padding ?? Math.round(F * 0.42);
  const lineGap = F * 0.62;

  // 先扫一遍所有箭头，取最长的那条，让多行方程式的箭头等长对齐
  const condSize = F * 0.54;
  let uniformArrow = 0;
  for (const line of allTokens) {
    for (const t of line) {
      if (t.kind !== "arrow") continue;
      const aboveW = t.above ? measureText(t.above, condSize, family) : 0;
      const belowW = t.below ? measureText(t.below, condSize, family) : 0;
      const base = arrowLength(t.arrow, F);
      uniformArrow = Math.max(uniformArrow, base, aboveW, belowW);
    }
  }

  const layouts = allTokens
    .filter((t) => t.length > 0)
    .map((t) => layoutLine(t, F, family, uniformArrow));
  const lines = layouts.length ? layouts : [layoutLine([], F, family)];

  const maxWidth = Math.max(...lines.map((l) => l.width), F);
  const totalHeight =
    lines.reduce((acc, l) => acc + (l.bottom - l.top), 0) + lineGap * (lines.length - 1);

  const body: string[] = [];
  let cursor = 0;

  for (const l of lines) {
    const dy = cursor - l.top;
    for (const item of l.items) {
      if (item.k === "text") {
        body.push(
          `<text x="${(padding + item.x).toFixed(2)}" y="${(padding + dy + item.y).toFixed(2)}" ` +
            `font-family='${family}' font-size="${item.size.toFixed(2)}" fill="${color}">${esc(item.text)}</text>`
        );
      } else {
        // 箭头必须和文字一样加上 padding 偏移（x 和 y 都要），
        // 否则箭头会整体左移、上移一个 padding 的距离：
        // 横向上表现为条件看起来偏右，纵向上表现为箭头浮在字的上半截。
        const translated: Extract<Item, { k: "arrow" }> = {
          ...item,
          x: item.x + padding,
          y: item.y + dy + padding,
        };
        body.push(arrowSvg(translated, F, color));
        const cx = padding + item.x + item.w / 2;
        if (item.above) {
          body.push(
            `<text x="${cx.toFixed(2)}" y="${(padding + dy + item.above.y).toFixed(2)}" text-anchor="middle" ` +
              `font-family='${family}' font-size="${item.above.size.toFixed(2)}" fill="${color}">${esc(item.above.text)}</text>`
          );
        }
        if (item.below) {
          body.push(
            `<text x="${cx.toFixed(2)}" y="${(padding + dy + item.below.y).toFixed(2)}" text-anchor="middle" ` +
              `font-family='${family}' font-size="${item.below.size.toFixed(2)}" fill="${color}">${esc(item.below.text)}</text>`
          );
        }
      }
    }
    cursor += l.bottom - l.top + lineGap;
  }

  const width = Math.ceil(maxWidth + padding * 2);
  const height = Math.ceil(totalHeight + padding * 2);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${body.join("")}</svg>`;

  return { svg, width, height };
}
