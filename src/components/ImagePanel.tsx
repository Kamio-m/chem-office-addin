import { useEffect, useRef, useState } from "react";
import { fileToDataUrl, loadImageSize, stripDataUrlPrefix } from "../lib/raster";
import { insertPicture } from "../lib/insert";
import type { HostName } from "../lib/host";

interface Props {
  host: HostName;
  notify: (text: string, ok?: boolean) => void;
}

interface LoadedImage {
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
}

export default function ImagePanel({ host, notify }: Props) {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [targetWidth, setTargetWidth] = useState(300);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("请选择图片文件", false);
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      const size = await loadImageSize(dataUrl);
      setImage({ dataUrl, naturalWidth: size.width, naturalHeight: size.height });
      setTargetWidth(Math.min(size.width, 320));
    } catch (err) {
      notify(err instanceof Error ? err.message : "图片读取失败", false);
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        void load(file);
        e.preventDefault();
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInsert = async () => {
    if (host === "none") {
      notify("请先在三端 Office 中加载本加载项再插入", false);
      return;
    }
    if (!image) {
      notify("请先选择一张图片", false);
      return;
    }
    setBusy(true);
    try {
      const ratio = image.naturalHeight / image.naturalWidth;
      const msg = await insertPicture(
        host,
        stripDataUrlPrefix(image.dataUrl),
        targetWidth,
        targetWidth * ratio
      );
      notify(msg);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), false);
    } finally {
      setBusy(false);
    }
  };

  const ratio = image ? image.naturalHeight / image.naturalWidth : 1;

  return (
    <div className="panel">
      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${image ? "has-image" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void load(file);
        }}
        onClick={() => fileRef.current?.click()}
      >
        {image ? (
          <img src={image.dataUrl} alt="待插入图片" />
        ) : (
          <>
            <div className="drop-icon">＋</div>
            <p>点击选择图片，或拖拽到此处</p>
            <p className="muted">也可以直接 Ctrl + V 粘贴截图</p>
          </>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
          e.target.value = "";
        }}
      />

      {image && (
        <>
          <div className="meta-row">
            <span>
              原始尺寸 {image.naturalWidth} × {image.naturalHeight}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => setImage(null)}
            >
              重新选择
            </button>
          </div>

          <div className="field">
            <div className="field-head">
              <label>插入宽度</label>
              <span className="num">{targetWidth} px · {Math.round(targetWidth * ratio)} px 高</span>
            </div>
            <input
              type="range"
              min={40}
              max={Math.max(640, image.naturalWidth)}
              value={targetWidth}
              onChange={(e) => setTargetWidth(Number(e.target.value))}
            />
          </div>
        </>
      )}

      <button className="primary" onClick={handleInsert} disabled={busy || !image || host === "none"}>
        {busy ? "插入中…" : "插入图片"}
      </button>

      <p className="tip">
        适合插入结构式截图、实验装置图、谱图等。插入后可在文档中直接拉伸调整大小。
      </p>
    </div>
  );
}
