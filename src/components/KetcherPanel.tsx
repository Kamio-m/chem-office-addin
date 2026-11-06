import { useEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone";
import "ketcher-react/dist/index.css";
import { insertPicture, preloadContentWidth } from "../lib/insert";
import { readScopedDraft, saveScopedDraft } from "../lib/docKey";
import { fileToPngBase64, recognizeOnline } from "../lib/ocr";
import type { HostName } from "../lib/host";

/** 画板草稿的存储键（会按文档追加后缀，见 lib/docKey） */
const DRAFT_KEY = "chem-addin.ket-draft";

/** 单例：Indigo 的 WASM 服务，初始化一次即可 */
const structServiceProvider = new StandaloneStructServiceProvider();

// 插入宽度上限：内容多（长反应、多行结构）时 320 会缩得太小，放宽到 480；
// Word 里仍可手动拉伸。
// 统一输出规格：无论画了多少内容，导出图宽度一律 1200px（高清），
// 高度按内容比例——"画幅"固定，内容永远完整。插入 Word 时再按版心宽度显示。
const OUTPUT_WIDTH = 1200;

interface Props {
  host: HostName;
  notify: (text: string, ok?: boolean) => void;
}

export default function KetcherPanel({ host, notify }: Props) {
  const ketcherRef = useRef<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [hint, setHint] = useState("正在加载结构式编辑器…");

  // 提前量好版心宽度：结构图插入时一步到位，不会先按原图大小显示再缩回去
  useEffect(() => {
    if (host === "word") void preloadContentWidth();
  }, [host]);

  // 画板草稿自动暂存：切到「化学式 / 图片导入」页签（组件被卸载）或刷新页面后，
  // 切回来内容还在。Ketcher 原生格式 KET 完整保留结构、箭头、手绘文字。
  useEffect(() => {
    if (!ready) return;
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    // 恢复上次草稿（按文档隔离：同文档还在，新文档是空白）
    try {
      const saved = readScopedDraft(DRAFT_KEY);
      if (saved && saved.length > 20) {
        void Promise.resolve(ketcher.setMolecule(saved)).catch(() => {});
      }
    } catch {
      /* 草稿不可用就按空画布开始 */
    }

    // 定时保存 + 卸载前再存一次
    const save = () => {
      try {
        void Promise.resolve(ketcher.getKet())
          .then((ket: string) => {
            if (ket && ket.length > 20) {
              saveScopedDraft(DRAFT_KEY, ket);
            }
          })
          .catch(() => {});
      } catch {
        /* 忽略保存失败 */
      }
    };
    const timer = window.setInterval(save, 1500);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, [ready]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!ready) setHint("编辑器加载较慢，首次需要下载 Indigo 引擎，请稍候…");
    }, 6000);
    return () => clearTimeout(timer);
  }, [ready]);

  /**
   * 首选导出：直接把 Ketcher 画布的 SVG 快照转成 PNG——所见即所得。
   * Indigo 的 generateImage 走 SMILES/RXN 重新排版，箭头上方的手绘标注
   * （如 H₂）会丢、箭头会跑位；画布快照则画成什么样就插成什么样。
   * 返回已裁掉空白边距、按 MAX_WIDTH 缩放的 PNG；失败返回 null 走兜底链路。
   */
  const snapshotCanvasPng = async (): Promise<{ base64: string; width: number; height: number } | null> => {
    try {
      // 画布 svg = 文档里最大的那个（结构画布区，宽度通常远大于工具栏图标）
      let svg: SVGSVGElement | null = null;
      let best = 0;
      for (const s of Array.from(document.querySelectorAll("svg"))) {
        const r = s.getBoundingClientRect();
        if (r.width > best && r.width > 150 && r.height > 100) {
          best = r.width;
          svg = s as SVGSVGElement;
        }
      }
      if (!svg) return null;

      // 坐标系：一律用画布自身的 viewBox（唯一可靠的全局坐标）。
      // getBBox() 返回的是层内局部坐标（不含层自身 transform），会让内容错位缩小。
      // 做法：可视区向外扩 30% 作为取景框（覆盖画到边上的内容），
      // 超出部分的空白由后面的像素裁白边修掉。
      const rawVb = svg.getAttribute("viewBox") || `0 0 ${svg.clientWidth} ${svg.clientHeight}`;
      const parts = rawVb.split(/[\s,]+/);
      const vx = Number(parts[0]);
      const vy = Number(parts[1]);
      const vw = Number(parts[2] || svg.clientWidth);
      const vh = Number(parts[3] || svg.clientHeight);
      if (!vw || !vh) return null;
      const PAD = 0.05; // 边界线已标出可画区，导出严格按纸面（仅留极小余量）
      const vb = `${vx - vw * PAD} ${vy - vh * PAD} ${vw * (1 + 2 * PAD)} ${vh * (1 + 2 * PAD)}`;
      const w = vw * (1 + 2 * PAD);
      const h = vh * (1 + 2 * PAD);

      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
      clone.setAttribute("viewBox", vb); // 关键：必须显式覆盖，否则沿用原始可视区
      clone.setAttribute("width", String(w));
      clone.setAttribute("height", String(h));

      // 删除纯辅助层：背景板（满画布矩形）、选择框、悬停高亮、警告标记、序号
      try {
        for (const g of Array.from(
          clone.querySelectorAll(
            '[class*="backgroundLayer"], [class*="selectionPlateLayer"], [class*="selectionPointsLayer"], [class*="hoveringLayer"], [class*="warningsLayer"], [class*="indicesLayer"]'
          )
        )) {
          g.remove();
        }
      } catch {
        /* 辅助层删除失败不影响导出 */
      }

      // 保险：剔除任何粘进快照的滚动条/辅助元素。
      // 判定特征——class 含 scroll，或贴着画布右缘/下缘的细长条（宽<20 或高<20，
      // 且长度超过画布对应边的 60%），这些在化学结构里不可能出现。
      try {
        for (const el of Array.from(clone.querySelectorAll("*"))) {
          const cls = (el.getAttribute("class") || "").toLowerCase();
          if (cls.includes("scroll") || cls.includes("scrollbar")) {
            el.remove();
            continue;
          }
          let b: DOMRect | null = null;
          try {
            b = (el as SVGGraphicsElement).getBBox?.() ?? null;
          } catch {
            b = null;
          }
          if (!b) continue;
          const thinVertical = b.width < 20 && b.height > h * 0.6;
          const thinHorizontal = b.height < 20 && b.width > w * 0.6;
          if (thinVertical || thinHorizontal) el.remove();
        }
      } catch {
        /* 剔除失败不影响导出 */
      }

      const xml = new XMLSerializer().serializeToString(clone);
      const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("SVG 加载失败"));
        img.src = svgDataUrl;
      });

      // 统一输出规格：画布宽度固定为 OUTPUT_WIDTH，高度按内容比例
      const renderScale = OUTPUT_WIDTH / w;
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * renderScale);
      cv.height = Math.round(h * renderScale);
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);

      // 扫描非白像素，裁掉四周空白，只留结构本体
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let minX = cv.width;
      let minY = cv.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          // 白色判定阈值 240：把画布里可能存在的浅灰辅助线一并排除，
          // 只保留真正的结构笔画（黑/彩色）
          const white = data[i + 3] < 8 || (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
          if (!white) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) return null;

      const pad = 14;
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(cv.width, maxX + pad);
      maxY = Math.min(cv.height, maxY + pad);
      const cw = maxX - minX;
      const ch = maxY - minY;
      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      out.getContext("2d")?.drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);

      const blob = await new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), "image/png"));
      if (!blob) return null;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsDataURL(blob);
      });
      // 插入尺寸要按「布局像素」回算：cw/ch 是放大到 1200px 之后的尺寸，
      // 直接拿去插入会把一个小苯环当成 1200px 宽的图，撑满整页。
      return {
        base64: dataUrl.split(",")[1],
        width: Math.max(1, Math.round(cw / renderScale)),
        height: Math.max(1, Math.round(ch / renderScale)),
      };
    } catch {
      return null;
    }
  };

  /** 把任意 PNG blob 统一成输出规格：1200 宽 + 裁白边，返回 base64 与尺寸 */
  const blobToFinal = async (
    blob: Blob
  ): Promise<{ base64: string; width: number; height: number } | null> => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsDataURL(blob);
      });
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("图片解析失败"));
        img.src = dataUrl;
      });
      const scale = OUTPUT_WIDTH / img.width;
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);

      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let minX = cv.width;
      let minY = cv.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          const white =
            data[i + 3] < 8 || (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
          if (!white) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) return null;
      const pad = 16;
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(cv.width, maxX + pad);
      maxY = Math.min(cv.height, maxY + pad);
      const cw = maxX - minX;
      const ch = maxY - minY;
      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      out.getContext("2d")?.drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);
      const png = await new Promise<Blob | null>((resolve) =>
        out.toBlob((b) => resolve(b), "image/png")
      );
      if (!png) return null;
      const finalUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsDataURL(png);
      });
      // 同样按布局像素回算：cw/ch 是 1200px 规格化之后的像素
      return {
        base64: finalUrl.split(",")[1],
        width: Math.max(1, Math.round(cw / scale)),
        height: Math.max(1, Math.round(ch / scale)),
      };
    } catch {
      return null;
    }
  };

  const exportPng = async (): Promise<{ base64: string; width: number; height: number }> => {
    const ketcher = ketcherRef.current;
    if (!ketcher) throw new Error("编辑器还没准备好");

    // 优先 MOL / RXN，而不是 KET。
    // KET 里存着 Ketcher 自己的原子序号，Indigo 渲染时会把这些序号
    // 当成原子标签画出来——导出的图上会出现一堆 #6 #8 #12。
    // MOL/RXN 是标准格式，只有连接关系，不带这些内部标记。
    let structStr = "";
    try {
      const rxn = await ketcher.getRxn();
      if (rxn && rxn.includes("$RXN")) structStr = rxn;
    } catch {
      /* 继续 */
    }
    if (!structStr) {
      try {
        const mol = await ketcher.getMolfile();
        if (mol && mol.trim()) structStr = mol;
      } catch {
        /* 继续 */
      }
    }
    if (!structStr) {
      try {
        const smiles = await ketcher.getSmiles();
        if (smiles && smiles.trim()) structStr = smiles;
      } catch {
        /* 继续 */
      }
    }

    if (structStr) {
      try {
        const blob: Blob = await ketcher.generateImage(structStr, {
          outputFormat: "png",
          backgroundColor: "255,255,255",
        });
        const out = await blobToFinal(blob);
        if (out) return out;
      } catch {
        /* 落到下面的兜底 */
      }
    }

    // 兜底一：KET（手绘标注这类内容只有 KET 能完整保留）
    try {
      const ket: string = await ketcher.getKet();
      if (ket && ket.trim().length > 20) {
        const blob: Blob = await ketcher.generateImage(ket, {
          outputFormat: "png",
          backgroundColor: "255,255,255",
        });
        const out = await blobToFinal(blob);
        if (out) return out;
      }
    } catch {
      /* 落到画布快照 */
    }

    // 兜底二：画布快照
    const snap = await snapshotCanvasPng();
    if (snap) return snap;
    throw new Error("导出失败：画布可能为空");
  };

  const handleInsert = async () => {
    if (host === "none") {
      notify("请先在三端 Office 中加载本加载项再插入", false);
      return;
    }
    setBusy(true);
    try {
      const { base64, width, height } = await exportPng();
      const msg = await insertPicture(host, base64, width, height);
      notify(msg);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), false);
    } finally {
      setBusy(false);
    }
  };

  const loadDemo = () => {
    try {
      ketcherRef.current?.setMolecule("c1ccccc1");
    } catch {
      notify("载入示例失败", false);
    }
  };

  /**
   * 图片识别：选图 → 上传识别 → SMILES 落到画板。
   * 落下来的是真正的分子结构，不是贴图——可以直接选原子、改键、加基团，
   * 改完再点「插入结构式」。
   */
  const handleOcrFile = async (file: File) => {
    if (!ready) return;
    setOcrBusy(true);
    notify("正在识别结构图（高峰期需排队，请稍候）");
    try {
      const png = await fileToPngBase64(file);
      const out = await recognizeOnline(png);
      // OSRA 返回的是标准 MOL，Ketcher 直接解析成可编辑分子
      await Promise.resolve(ketcherRef.current?.setMolecule(out.mol));
      const extra = out.count > 1 ? `（图中共 ${out.count} 个结构，取了第一个）` : "";
      notify(`识别完成${extra}，可直接在画板上修改`);
    } catch (err) {
      notify("识别失败：" + (err instanceof Error ? err.message : String(err)), false);
    } finally {
      setOcrBusy(false);
    }
  };

  return (
    <div className="panel ketcher-panel">
      <div className="ketcher-host">
        <Editor
          staticResourcesUrl=""
          structServiceProvider={structServiceProvider}
          errorHandler={(message: string) => notify(message || "结构式编辑器出错", false)}
          onInit={(ketcher: any) => {
            ketcherRef.current = ketcher;
            // 便于本地排查导出问题
            (window as any).__ketcher = ketcher;
            setReady(true);
          }}
        />
        {!ready && <div className="ketcher-loading">{hint}</div>}
      </div>

      <div className="inline-row">
        <button
          type="button"
          className="file-btn"
          onClick={() => fileRef.current?.click()}
          disabled={!ready || ocrBusy}
          title="选一张结构式图片，识别后转成可编辑结构"
        >
          {ocrBusy ? "识别中…" : "图片识别"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/bmp,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = "";
            if (f) void handleOcrFile(f);
          }}
        />
        <button type="button" className="file-btn" onClick={loadDemo}>
          示例
        </button>
        <button
          type="button"
          className="file-btn"
          onClick={() => {
            try {
              ketcherRef.current?.setMolecule("");
            } catch {
              /* 忽略 */
            }
          }}
        >
          清空
        </button>
      </div>

      <button className="primary" onClick={handleInsert} disabled={busy || !ready || host === "none"}>
        {busy ? "插入中…" : "插入结构式"}
      </button>

      <p className="tip">
        由 Ketcher（EPAM 开源）驱动：支持键、环、立体化学、原子标签、模板与 SMILES 导入。
        「图片识别」把结构图转成**可编辑的分子**，落到画板上之后能选原子、改键、补基团，
        核对无误再点「插入结构式」。识别走 NCI 的在线 OSRA，需要联网、图片会上传；
        图片越清晰越准。
      </p>
    </div>
  );
}
