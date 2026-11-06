import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collectAnchors,
  renderOps,
  snapPoint,
  type BondOrder,
  type DrawOp,
  type Pt,
} from "../lib/draw";
import { insertPicture } from "../lib/insert";
import type { HostName } from "../lib/host";

const W = 340;
const H = 300;
const FONT = '"Times New Roman", "Nimbus Roman", serif';

type Tool = "bond" | "free" | "erase" | "atom";

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: "bond", label: "化学键" },
  { id: "free", label: "画笔" },
  { id: "erase", label: "橡皮" },
  { id: "atom", label: "原子标注" },
];

const COLORS = ["#111827", "#dc2626", "#2563eb", "#059669", "#7c3aed"];

interface Props {
  host: HostName;
  notify: (text: string, ok?: boolean) => void;
}

export default function DrawPanel({ host, notify }: Props) {
  const [ops, setOps] = useState<DrawOp[]>([]);
  const [redoStack, setRedoStack] = useState<DrawOp[]>([]);
  const [tool, setTool] = useState<Tool>("bond");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(2.2);
  const [order, setOrder] = useState<BondOrder>(1);
  const [bondLength, setBondLength] = useState(46);
  const [snap, setSnap] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [label, setLabel] = useState("CH3");

  const [bg, setBg] = useState<{ url: string; opacity: number } | null>(null);
  const [draft, setDraft] = useState<DrawOp | null>(null);
  const [busy, setBusy] = useState(false);

  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);
  const bgOpacityRef = useRef(0.6);
  const dragRef = useRef<{ points: Pt[]; start: Pt | null; end: Pt | null } | null>(null);
  const draftRef = useRef<DrawOp | null>(null);

  const setDraftOp = (op: DrawOp | null) => {
    draftRef.current = op;
    setDraft(op);
  };

  if (!layerRef.current && typeof document !== "undefined") {
    layerRef.current = document.createElement("canvas");
  }

  const allOps = useMemo(() => (draft ? [...ops, draft] : ops), [ops, draft]);

  const redraw = useCallback(() => {
    const canvas = displayRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(W * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    if (showGrid) drawHexGrid(ctx, W, H, bondLength);

    const img = bgImgRef.current;
    if (img) {
      ctx.save();
      ctx.globalAlpha = bgOpacityRef.current;
      const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }

    const layer = layerRef.current!;
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const lctx = layer.getContext("2d");
    if (!lctx) return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderOps(lctx, allOps, W, H, { fontFamily: FONT });
    ctx.drawImage(layer, 0, 0, W, H);
  }, [allOps, showGrid, bondLength]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const toLogical = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toLogical(e);

    if (tool === "atom") {
      if (!label.trim()) {
        notify("请先填写原子标注内容", false);
        return;
      }
      setOps((prev) => [
        ...prev,
        { type: "text", color, x: p.x, y: p.y, text: label.trim(), size: 20 },
      ]);
      setRedoStack([]);
      return;
    }

    if (tool === "bond") {
      const anchors = collectAnchors(ops);
      let start = p;
      for (const a of anchors) {
        if (Math.hypot(a.x - p.x, a.y - p.y) < 12) {
          start = { ...a };
          break;
        }
      }
      dragRef.current = { points: [], start, end: start };
      setDraftOp({ type: "bond", color, width, order, x1: start.x, y1: start.y, x2: start.x, y2: start.y });
      return;
    }

    dragRef.current = { points: [p], start: p, end: p };
    setDraftOp(
      tool === "erase"
        ? { type: "erase", width: 18, points: [p] }
        : { type: "free", color, width, points: [p] }
    );
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toLogical(e);

    if (tool === "bond") {
      const anchors = collectAnchors(ops);
      const end = snapPoint(drag.start, p, bondLength, snap, anchors);
      drag.end = end;
      setDraftOp({
        type: "bond",
        color,
        width,
        order,
        x1: drag.start!.x,
        y1: drag.start!.y,
        x2: end.x,
        y2: end.y,
      });
      return;
    }

    const points = drag.points;
    const last = points[points.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1.6) {
      points.push(p);
      setDraftOp(
        tool === "erase"
          ? { type: "erase", width: 18, points: [...points] }
          : { type: "free", color, width, points: [...points] }
      );
    }
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    const current = draftRef.current;
    dragRef.current = null;
    setDraftOp(null);
    if (!drag || !current) return;

    if (current.type === "bond") {
      if (Math.hypot(current.x2 - current.x1, current.y2 - current.y1) < 6) return;
    } else if (current.type === "free" || current.type === "erase") {
      if (current.points.length === 0) return;
    }
    setOps((prev) => [...prev, current]);
    setRedoStack([]);
  };

  const undo = () => {
    setOps((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((r) => {
      if (!r.length) return r;
      const last = r[r.length - 1];
      setOps((prev) => [...prev, last]);
      return r.slice(0, -1);
    });
  };

  const clearAll = () => {
    setOps([]);
    setRedoStack([]);
    setDraftOp(null);
  };

  const importBackground = async (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      bgImgRef.current = img;
      setBg({ url, opacity: bgOpacityRef.current });
      redraw();
    };
    img.src = url;
  };

  const exportPng = (transparent: boolean): string => {
    const scale = 3;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    if (!transparent) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
    }
    const img = bgImgRef.current;
    if (img) {
      ctx.save();
      ctx.globalAlpha = bgOpacityRef.current;
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const dw = img.naturalWidth * s;
      const dh = img.naturalHeight * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }
    renderOps(ctx, ops, W, H, { fontFamily: FONT });
    return canvas.toDataURL("image/png").split(",")[1];
  };

  const handleInsert = async () => {
    if (host === "none") {
      notify("请先在三端 Office 中加载本加载项再插入", false);
      return;
    }
    if (!ops.length) {
      notify("画布还是空的", false);
      return;
    }
    setBusy(true);
    try {
      const base64 = exportPng(false);
      const msg = await insertPicture(host, base64, W, H);
      notify(msg);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="draw-toolbar">
        <div className="tool-group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tool ${tool === t.id ? "active" : ""}`}
              onClick={() => setTool(t.id)}
              title={t.label}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tool-group">
          <button type="button" className="icon-btn" onClick={undo} disabled={!ops.length} title="撤销">
            ↶
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={redo}
            disabled={!redoStack.length}
            title="重做"
          >
            ↷
          </button>
          <button type="button" className="icon-btn" onClick={clearAll} disabled={!ops.length} title="清空">
            ✕
          </button>
        </div>
      </div>

      {tool === "atom" && (
        <div className="inline-row">
          <input
            className="text-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="如 OH、CH3、NH2"
          />
          <span className="muted">点击画布放置</span>
        </div>
      )}

      <div className="draw-canvas-wrap">
        <canvas
          ref={displayRef}
          className={`draw-canvas tool-${tool}`}
          style={{ aspectRatio: `${W} / ${H}` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      <div className="inline-row wrap">
        <div className="segmented small">
          {([1, 2, 3] as BondOrder[]).map((o) => (
            <button
              key={o}
              type="button"
              className={order === o ? "active" : ""}
              onClick={() => setOrder(o)}
            >
              {o === 1 ? "单键" : o === 2 ? "双键" : "三键"}
            </button>
          ))}
        </div>
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
        </div>
      </div>

      <div className="inline-row">
        <label className="checkbox">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          30° 吸附
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          辅助网格
        </label>
        <label className="range-mini">
          键长
          <input
            type="range"
            min={30}
            max={70}
            value={bondLength}
            onChange={(e) => setBondLength(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="inline-row">
        <label className="file-btn">
          导入底图
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importBackground(f);
              e.target.value = "";
            }}
          />
        </label>
        {bg && (
          <button type="button" className="link-btn" onClick={() => {
            bgImgRef.current = null;
            setBg(null);
            redraw();
          }}>
            移除底图
          </button>
        )}
        <label className="range-mini">
          线宽
          <input
            type="range"
            min={1}
            max={6}
            step={0.2}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>

      <button className="primary" onClick={handleInsert} disabled={busy || host === "none"}>
        {busy ? "插入中…" : "插入结构图"}
      </button>

      <p className="tip">
        选「化学键」后从一点拖到另一点画键，端点会自动吸附到已有原子与 30° 方向上，便于画六元环；
        选「原子标注」可直接写 OH、CH3 等，数字自动变下标。
      </p>
    </div>
  );
}

function drawHexGrid(ctx: CanvasRenderingContext2D, w: number, h: number, L: number) {
  const R = Math.max(20, Math.min(L, 60));
  const dx = Math.sqrt(3) * R;
  const dy = 1.5 * R;
  ctx.save();
  ctx.strokeStyle = "#eef2f7";
  ctx.lineWidth = 1;
  for (let row = -1; row * dy < h + R; row++) {
    for (let col = -1; col * dx < w + dx; col++) {
      const cx = col * dx + (row % 2 !== 0 ? dx / 2 : 0);
      const cy = row * dy;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const px = cx + Math.cos(a) * R;
        const py = cy + Math.sin(a) * R;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}
