import { buildWordOoxml } from "./omml";
import type { Token } from "./chem";
import { isSetSupported, type HostName } from "./host";

export type InsertMode = "rich" | "image" | "text";

export interface InsertOutcome {
  method: InsertMode;
  message: string;
}

const PX_TO_PT = 0.75;

export function modesForHost(host: HostName): InsertMode[] {
  switch (host) {
    case "word":
      return ["rich", "image", "text"];
    case "excel":
      return ["text", "image"];
    case "powerpoint":
      return ["image", "text"];
    default:
      return [];
  }
}

export function defaultModeForHost(host: HostName): InsertMode {
  switch (host) {
    case "word":
      return "rich";
    case "excel":
      return "text";
    case "powerpoint":
      return "image";
    default:
      return "image";
  }
}

/** ---------- Word ---------- */

async function wordInsertOoxml(lines: Token[][]) {
  const ooxml = buildWordOoxml(lines);
  await Word.run(async (context) => {
    const range = context.document.getSelection();
    range.insertOoxml(ooxml, Word.InsertLocation.replace);
    await context.sync();
  });
}

interface ImageOptions {
  /** 公式图的额外缩放（0.6~1），字号已经决定基础大小 */
  scale?: number;
}

/**
 * 版心宽度缓存。
 *
 * 为什么要缓存：插入图片时如果先 insert、再单独 sync 去读页面设置、最后才设宽高，
 * Word 会先把图片按原始像素（1200px ≈ 900pt）显示一帧，然后才缩到目标尺寸——
 * 看起来就是"刷一下从小变大/从大变小"的拉伸感。把宽高和插入放在同一个批次里提交，
 * 就不会有这个中间态；版心宽度提前量好存起来即可。
 */
let contentWidthCache: number | null = null;

async function measureContentWidth(context: Word.RequestContext): Promise<number | null> {
  try {
    const setup = context.document.sections.getFirst().pageSetup;
    setup.load("pageWidth,leftMargin,rightMargin");
    await context.sync();
    const width = setup.pageWidth - setup.leftMargin - setup.rightMargin;
    return width > 100 ? width : null;
  } catch {
    return null;
  }
}

/** 面板挂载时先量一次版心，保证第一次插入就没有中间态 */
export async function preloadContentWidth(): Promise<void> {
  if (contentWidthCache !== null) return;
  try {
    await Word.run(async (context) => {
      contentWidthCache = await measureContentWidth(context);
    });
  } catch {
    /* 拿不到就按自然尺寸插入 */
  }
}

async function wordInsertImage(
  base64: string,
  wPx: number,
  hPx: number,
  opts: ImageOptions = {}
) {
  const scale = opts.scale ?? 1;
  const naturalPt = wPx * PX_TO_PT * scale;
  // 有缓存就一步到位；没有也先按自然尺寸提交，避免插入时闪一下大图
  const widthPt = contentWidthCache ? Math.min(naturalPt, contentWidthCache) : naturalPt;

  await Word.run(async (context) => {
    const range = context.document.getSelection();
    const picture = range.insertInlinePictureFromBase64(base64, Word.InsertLocation.replace);
    picture.width = widthPt;
    picture.height = (hPx / wPx) * widthPt;
    await context.sync(); // 插入 + 定尺寸在同一个批次里提交

    if (contentWidthCache === null) {
      // 首次插入才补量版心；只有内容比版心还宽时才需要再校正一次
      const measured = await measureContentWidth(context);
      if (measured) {
        contentWidthCache = measured;
        if (naturalPt > measured) {
          picture.width = measured;
          picture.height = (hPx / wPx) * measured;
          await context.sync();
        }
      }
    }
  });
}

async function wordInsertText(text: string) {
  await Word.run(async (context) => {
    const range = context.document.getSelection();
    range.insertText(text, Word.InsertLocation.replace);
    await context.sync();
  });
}

/** ---------- Excel ---------- */

async function excelInsertText(text: string) {
  await Excel.run(async (context) => {
    const cell = context.workbook.getSelectedRange().getCell(0, 0);
    cell.values = [[text]];
    await context.sync();
  });
}

async function excelInsertImage(
  base64: string,
  wPx: number,
  hPx: number,
  opts: ImageOptions = {}
) {
  const scale = opts.scale ?? 1;
  await Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    const shape = sheet.shapes.addImage(base64);
    shape.width = wPx * PX_TO_PT * scale;
    shape.height = hPx * PX_TO_PT * scale;
    await context.sync();
  });
}

/** ---------- PowerPoint ---------- */

async function getActiveSlide(context: PowerPoint.RequestContext): Promise<PowerPoint.Slide> {
  const selected = context.presentation.getSelectedSlides();
  selected.load("items");
  await context.sync();
  if (selected.items.length > 0) return selected.items[0];
  return context.presentation.slides.getItemAt(0);
}

/**
 * PowerPoint 的 Office.js 没有 addPicture，官方做法是给几何形状填充图片：
 * 添加矩形 → fill.setImage → 去掉边框。需要 PowerPointApi 1.8。
 */
/**
 * PowerPoint 里没法把图片插进文本流（图片永远是浮动形状），
 * 也没有「光标坐标」的接口。折中做法：以当前正在编辑的文本框为锚点，
 * 落在它的左下角下方一点——视觉上就是“接着光标所在的那段文字往下放”，
 * 而不是像原来那样固定钉在幻灯片左上角。
 */
async function pptInsertAnchor(
  context: PowerPoint.RequestContext,
  w: number,
  h: number
): Promise<{ left: number; top: number }> {
  // 默认 16:9（960×540 pt）居中；拿不到选中形状时用它
  const fallback = { left: (960 - w) / 2, top: (540 - h) / 2 };
  try {
    if (!isSetSupported("PowerPointApi", "1.5")) return fallback;
    const selected = context.presentation.getSelectedShapes();
    selected.load("items");
    await context.sync();
    const shape = selected.items[0];
    if (!shape) return fallback;
    shape.load("left,top,width,height");
    await context.sync();
    const left = Math.max(0, Math.min(shape.left, 960 - w));
    const top = Math.max(0, Math.min(shape.top + shape.height + 6, 540 - h));
    return { left, top };
  } catch {
    return fallback;
  }
}

async function pptInsertImage(
  base64: string,
  wPx: number,
  hPx: number,
  opts: ImageOptions = {}
) {
  if (!isSetSupported("PowerPointApi", "1.8")) {
    throw new Error("当前 PowerPoint 版本不支持直接插入图片，请改用「纯文本」插入方式");
  }
  const scale = opts.scale ?? 1;
  await PowerPoint.run(async (context) => {
    const slide = await getActiveSlide(context);
    const width = wPx * PX_TO_PT * scale;
    const height = hPx * PX_TO_PT * scale;
    const { left, top } = await pptInsertAnchor(context, width, height);
    const shape = slide.shapes.addGeometricShape("Rectangle", {
      left,
      top,
      width,
      height,
    });
    shape.fill.setImage(base64);
    shape.lineFormat.visible = false;
    shape.altTextTitle = "化学式";
    await context.sync();
  });
}

async function pptInsertText(text: string, wPx: number, hPx: number) {
  await PowerPoint.run(async (context) => {
    const slide = await getActiveSlide(context);
    const width = Math.max(wPx * PX_TO_PT, 120);
    const height = Math.max(hPx * PX_TO_PT, 32);
    const { left, top } = await pptInsertAnchor(context, width, height);
    const box = slide.shapes.addTextBox(text, {
      left,
      top,
      width,
      height,
    });
    box.textFrame.wordWrap = false;
    await context.sync();
  });
}

/** ---------- 对外统一入口 ---------- */

export interface InsertFormulaArgs {
  host: HostName;
  lines: Token[][];
  mode: InsertMode;
  base64: string;
  widthPx: number;
  heightPx: number;
  plainText: string;
  /** 插入大小倍率（0.6~1），不传按 1 */
  scale?: number;
}

export async function insertFormula(args: InsertFormulaArgs): Promise<InsertOutcome> {
  const { host, lines, mode, base64, widthPx, heightPx, plainText } = args;
  const scale = args.scale ?? 1;

  if (host === "none") throw new Error("当前不在 Office 宿主中，无法插入。");

  if (mode === "rich" && host === "word") {
    try {
      await wordInsertOoxml(lines);
      return { method: "rich", message: "已插入可编辑公式" };
    } catch (err) {
      console.warn("OMML 插入失败，降级为图片", err);
      await wordInsertImage(base64, widthPx, heightPx, { scale });
      return { method: "image", message: "公式插入失败，已改用图片插入" };
    }
  }

  if (mode === "image") {
    if (host === "word") {
      await wordInsertImage(base64, widthPx, heightPx, { scale });
    } else if (host === "excel") {
      await excelInsertImage(base64, widthPx, heightPx, { scale });
    } else {
      try {
        await pptInsertImage(base64, widthPx, heightPx, { scale });
      } catch (err) {
        console.warn("PPT 图片插入失败，降级为文本", err);
        await pptInsertText(plainText, widthPx, heightPx);
        return { method: "text", message: "图片插入不可用，已改用纯文本插入" };
      }
    }
    return { method: "image", message: "已插入图片" };
  }

  if (host === "word") await wordInsertText(plainText);
  else if (host === "excel") await excelInsertText(plainText);
  else await pptInsertText(plainText, widthPx, heightPx);
  return { method: "text", message: "已插入纯文本（Unicode 上下标）" };
}

/** 结构图 / 导入图片的插入：三端一致，都是插图片 */
export async function insertPicture(
  host: HostName,
  base64: string,
  widthPx: number,
  heightPx: number
): Promise<string> {
  if (host === "word") {
    // 结构图按自身内容大小插入（最多不超过版心宽度）：
    // 一个苯环就该是两厘米左右，而不是拉满整页。
    await wordInsertImage(base64, widthPx, heightPx);
    return "已插入图片到光标位置";
  }
  if (host === "excel") {
    await excelInsertImage(base64, widthPx, heightPx);
    return "已插入图片到当前工作表";
  }
  if (host === "powerpoint") {
    await pptInsertImage(base64, widthPx, heightPx);
    return "已插入图片到当前幻灯片";
  }
  throw new Error("当前不在 Office 宿主中，无法插入。");
}
