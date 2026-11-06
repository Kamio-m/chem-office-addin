/**
 * 结构图识别（在线 · OSRA）。
 *
 * 这里只做两件事：把用户选的图压到合理尺寸、交给本地服务转发。
 * 识别由 NCI 的在线 OSRA 完成，返回标准 MOL——直接喂给 Ketcher，
 * 加载出来是**真正的分子**，可以选原子、改键、补基团，不是贴图。
 *
 * 为什么不做二值化/放大一类的预处理：
 * 实测插值放大不产生任何新信息，真正决定识别率的是原图本身的清晰度。
 * 所以这里只缩小、不放大。
 */

export interface OnlineOcrResult {
  /** 标准 MDL MOL 文本 */
  mol: string;
  /** 图里识别出几个结构（目前只取第一个） */
  count: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片打不开，换一张试试"));
    img.src = src;
  });
}

async function toPngBase64(src: string, maxSide: number): Promise<string> {
  const img = await loadImage(src);
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("图片尺寸异常");
  const k = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));

  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  // 透明/深色底统一压到白底上
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL("image/png").split(",")[1];
}

/** 文件 → 压到 maxSide 以内（只缩不放）的 PNG base64 */
export async function fileToPngBase64(file: Blob, maxSide = 1600): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    return await toPngBase64(url, maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** dataURL → 同上（「图片导入」页签里已经有 dataURL，不用再读文件） */
export function dataUrlToPngBase64(dataUrl: string, maxSide = 1600): Promise<string> {
  return toPngBase64(dataUrl, maxSide);
}

/** 交给本地服务转发到在线识别（避免浏览器直连的 CORS 问题） */
export async function recognizeOnline(pngBase64: string): Promise<OnlineOcrResult> {
  const res = await fetch("/api/ocr-online", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ png: pngBase64 }),
  });
  if (!res.ok) throw new Error("本地服务没有响应（HTTP " + res.status + "）");
  const data = (await res.json()) as OnlineOcrResult & { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error || "在线识别失败");
  if (!data.mol) throw new Error("在线识别没有返回结构");
  return data;
}
