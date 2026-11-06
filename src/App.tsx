import { lazy, Suspense, useEffect, useState } from "react";
import { detectHost, type HostInfo } from "./lib/host";
import FormulaPanel from "./components/FormulaPanel";
import ImagePanel from "./components/ImagePanel";

// Ketcher 体积较大（含 Indigo WASM），单独分包、按需加载
const KetcherPanel = lazy(() => import("./components/KetcherPanel"));

type Tab = "formula" | "draw" | "image";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "formula", label: "化学式" },
  { id: "draw", label: "结构式" },
  { id: "image", label: "图片导入" },
];

export interface ToastState {
  text: string;
  ok: boolean;
}

export default function App() {
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    // 方便在浏览器里直接调试某个页签：index.html?tab=draw
    const q = new URLSearchParams(window.location.search).get("tab");
    return q === "draw" || q === "image" ? q : "formula";
  });
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    detectHost().then(setHostInfo);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = (text: string, ok = true) => setToast({ text, ok });

  const host = hostInfo?.host ?? "none";

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <path
                d="M16 3.5 26.5 9.5v11L16 26.5 5.5 20.5v-11L16 3.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinejoin="round"
              />
              <circle cx="16" cy="15" r="3.1" fill="currentColor" />
            </svg>
          </span>
          <div className="brand-text">
            <h1>化学工具</h1>
          </div>
          <span className="build-tag" title="构建时间，用于核对版本">
            {typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__.slice(5) : ""}
          </span>
          {hostInfo && (
            <span className={`host-chip ${hostInfo.inOffice ? "on" : "off"}`}>
              {hostInfo.inOffice ? hostInfo.label : "预览模式"}
            </span>
          )}
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-body">
        {!hostInfo && <div className="loading">正在连接 Office…</div>}
        {hostInfo && tab === "formula" && <FormulaPanel host={host} notify={notify} />}
        {hostInfo && tab === "draw" && (
          <Suspense fallback={<div className="loading">正在加载结构式编辑器…</div>}>
            <KetcherPanel host={host} notify={notify} />
          </Suspense>
        )}
        {hostInfo && tab === "image" && <ImagePanel host={host} notify={notify} />}
      </main>

      {hostInfo && !hostInfo.inOffice && (
        <div className="hint-bar">
          当前为浏览器预览，插入功能需在 Word / Excel / PowerPoint 中加载本加载项后使用。
        </div>
      )}

      {toast && <div className={`toast ${toast.ok ? "ok" : "err"}`}>{toast.text}</div>}
    </div>
  );
}
