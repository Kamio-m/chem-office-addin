import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseFormula,
  formulaToPlainText,
  findArrows,
  arrowIndexAtCaret,
  setArrowConditionsAt,
} from "../lib/chem";
import { renderTokensToSvg } from "../lib/svg";
import { svgToPngBase64 } from "../lib/raster";
import { insertFormula, modesForHost, defaultModeForHost, preloadContentWidth, type InsertMode } from "../lib/insert";
import {
  getSuggestions,
  wordStart,
  type Suggestion,
  type SuggestResult,
} from "../lib/suggest";
import { fetchOnlineSuggestions, type OnlineState } from "../lib/remote";
import { getCaretPoint, type CaretPoint } from "../lib/caret";
import { readScopedDraft, saveScopedDraft } from "../lib/docKey";
import SuggestList from "./SuggestList";
import type { HostName } from "../lib/host";

const MODE_LABEL: Record<InsertMode, string> = {
  rich: "可编辑公式",
  image: "图片",
  text: "纯文本",
};

const SYMBOLS = ["→", "=", "⇌", "↑", "↓", "Δ", "·", "^+", "^-", "=[]", "→[]"];

const TEMPLATES: Array<{ name: string; value: string }> = [
  { name: "— 常用模板 —", value: "" },
  { name: "燃烧反应", value: "CH4 + 2O2 ->[点燃] CO2 + 2H2O" },
  { name: "中和反应", value: "HCl + NaOH = NaCl + H2O" },
  { name: "电离方程式", value: "H2SO4 = 2H^+ + SO4^2-" },
  { name: "可逆反应", value: "N2 + 3H2 <=>[高温高压|催化剂] 2NH3" },
  { name: "沉淀与气体", value: "Ca(OH)2 + CO2 = CaCO3↓ + H2O" },
  { name: "结晶水合物", value: "CuSO4·5H2O" },
  { name: "有机物简式", value: "CH3-CH2-OH" },
];

// 新文档从空白开始（要示例就用「常用模板」下拉，或看输入框占位提示）
const EMPTY_TEXT = "";
const RECENT_KEY = "chem-addin.recent";
const DRAFT_KEY = "chem-addin.formula-draft";

/** 反应条件快捷词：点一下填到「上」或「下」输入框 */
const CONDITION_CHIPS = ["点燃", "加热", "高温", "催化剂", "通电", "光照", "浓硫酸", "MnO2"];

function readDraft(): string | null {
  try {
    const raw = readScopedDraft(DRAFT_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function saveDraft(value: string) {
  saveScopedDraft(DRAFT_KEY, JSON.stringify(value));
}


function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(value: string): string[] {
  const v = value.trim();
  if (!v) return readRecent();
  const next = [v, ...readRecent().filter((x) => x !== v)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式忽略 */
  }
  return next;
}

interface Props {
  host: HostName;
  notify: (text: string, ok?: boolean) => void;
}

export default function FormulaPanel({ host, notify }: Props) {
  // 从草稿恢复：同一文档内切换页签 / 关面板 / 刷新都还在；新文档则是空白
  const [text, setText] = useState<string>(() => readDraft() ?? EMPTY_TEXT);
  const [fontSize, setFontSize] = useState(26);
  const [mode, setMode] = useState<InsertMode>(defaultModeForHost(host));
  // 图片插入大小：按字号等比缩放，1 = 字号原尺寸（不会超过版心宽度）
  const [insertScale, setInsertScale] = useState(0.75);
  const [whiteBg, setWhiteBg] = useState(false);
  const [busy, setBusy] = useState(false);

  const [, setRecent] = useState<string[]>(readRecent); // 仅记录，联想界面已不再展示历史
  const [suggest, setSuggest] = useState<SuggestResult | null>(null);
  const [online, setOnline] = useState<Suggestion[]>([]);
  const [onlineState, setOnlineState] = useState<OnlineState>("idle");
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<CaretPoint>({ top: 0, left: 0, height: 20, width: 260 });

  // 反应条件（等号 / 箭头上、下两行）：只在光标落在 =[ … ] 里时出现
  const [condIndex, setCondIndex] = useState<number | null>(null);
  const [condAbove, setCondAbove] = useState("");
  const [condBelow, setCondBelow] = useState("");
  const [condTarget, setCondTarget] = useState<"above" | "below">("above");

  // 撤销 / 重做：受控 textarea 的原生撤销常被 React 重置，自己存一份历史
  const pastRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const lastRecordRef = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const aboveRef = useRef<HTMLInputElement>(null);
  const belowRef = useRef<HTMLInputElement>(null);
  // 补全后（或按 Esc 后）抑制一次，避免列表立刻又弹出来
  const suppressRef = useRef<string | null>(null);

  const pushHistory = (prev: string, merge: boolean) => {
    const now = Date.now();
    // 连续打字合并成一步（500ms 内），否则撤销会一个字一个字往回退
    if (merge && pastRef.current.length && now - lastRecordRef.current < 500) {
      lastRecordRef.current = now;
      futureRef.current = [];
      setCanRedo(false);
      return;
    }
    pastRef.current.push(prev);
    if (pastRef.current.length > 120) pastRef.current.shift();
    futureRef.current = [];
    lastRecordRef.current = now;
    setCanUndo(true);
    setCanRedo(false);
  };

  /** 所有改文本的地方都走这里，保证有撤销记录 */
  const updateText = (next: string, merge = false) => {
    if (next === text) return;
    pushHistory(text, merge);
    setText(next);
  };

  const undo = () => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const prev = pastRef.current.pop();
    if (prev === undefined) return;
    futureRef.current.push(text);
    setText(prev);
    setSuggest(null);
    setOnline([]);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(true);
    lastRecordRef.current = 0;
    requestAnimationFrame(() => {
      if (!el) return;
      const c = Math.min(caret, prev.length);
      el.focus();
      el.setSelectionRange(c, c);
    });
  };

  const redo = () => {
    const next = futureRef.current.pop();
    if (next === undefined) return;
    pastRef.current.push(text);
    setText(next);
    setSuggest(null);
    setOnline([]);
    setCanUndo(true);
    setCanRedo(futureRef.current.length > 0);
    lastRecordRef.current = 0;
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  // 草稿自动保存：删了/切走/关面板都能再找回来
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(text), 400);
    return () => clearTimeout(timer);
  }, [text]);

  const modes = modesForHost(host).length ? modesForHost(host) : (["rich", "image", "text"] as InsertMode[]);
  const activeMode = modes.includes(mode) ? mode : modes[0];

  const lines = useMemo(() => parseFormula(text), [text]);
  const rendered = useMemo(
    () => renderTokensToSvg(lines, { fontSize, color: "#111827" }),
    [lines, fontSize]
  );
  const plainText = useMemo(() => formulaToPlainText(text), [text]);

  /** 括号是否配对，仅作轻提示 */
  const parenBalance = useMemo(() => {
    let diff = 0;
    for (const ch of text) {
      if (ch === "(") diff++;
      else if (ch === ")") diff--;
    }
    return diff;
  }, [text]);

  // 提前量好版心宽度，插入图片时才能"插入即最终尺寸"，不会先显示大图再缩
  useEffect(() => {
    if (host === "word") void preloadContentWidth();
  }, [host]);

  // 输入框随内容自动增高
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const refresh = useCallback(
    (value: string, caret: number) => {
      // 刚补全完（或按了 Esc）的这次不要立刻再弹出来
      if (suppressRef.current !== null && value === suppressRef.current) {
        setSuggest(null);
        return;
      }
      // 光标在 =[ … ] 里：条件由下方面板负责，别再弹旧的条件联想挡住它
      if (arrowIndexAtCaret(value, caret) !== null) {
        setSuggest(null);
        setOnline([]);
        setOnlineState("idle");
        return;
      }
      const el = taRef.current;
      if (el) setAnchor(getCaretPoint(el, caret));
      setSuggest(getSuggestions(value, caret));
      setActive(0);
    },
    []
  );

  // 在线联想：输入 2 个以上字母时去问 PubChem，失败/超时就静默回落到本地库
  useEffect(() => {
    // 刚补全完 / 按了 Esc：这次不查、不弹
    if (suppressRef.current !== null && text === suppressRef.current) {
      setOnline([]);
      setOnlineState("idle");
      return;
    }

    const el = taRef.current;
    const caret = el ? el.selectionStart ?? text.length : text.length;
    const token = text.slice(wordStart(text, caret), caret);

    // 只联想化学式：令牌 ≥2 字符、只含字母和数字（大小写均可，PubChem 侧过滤无机物）
    if (token.length < 2 || !/^[A-Za-z][A-Za-z0-9]*$/.test(token)) {
      setOnline([]);
      setOnlineState("idle");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    setOnlineState("loading");

    const timer = setTimeout(() => {
      fetchOnlineSuggestions(token, controller.signal)
        .then((items) => {
          // 与已输入完全相同的式子不算「补全」，直接丢掉（H2O 不该再提示 H2O）
          const useful = items.filter(
            (i) => i.text.toUpperCase() !== token.toUpperCase()
          );
          setOnline(useful);
          setOnlineState(useful.length ? "ok" : "off");
        })
        .catch(() => {
          setOnline([]);
          setOnlineState("off");
        })
        .finally(() => clearTimeout(timeout));
    }, 350);

    return () => {
      clearTimeout(timer);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [text]);

  // 在线结果排在前面；同一条化学式若本地有中文名，用中文名当提示、并去掉本地重复项
  const items = useMemo(() => {
    const localList = suggest?.list ?? [];
    const localByText = new Map(localList.map((s) => [s.text, s]));

    const mergedOnline = online.map((o) => {
      const local = localByText.get(o.text);
      return local?.hint ? { ...o, hint: local.hint } : o;
    });
    const restLocal = localList.filter((s) => !online.some((o) => o.text === s.text));

    return [...mergedOnline, ...restLocal].slice(0, 6);
  }, [online, suggest]);

  const pick = (s: Suggestion) => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    // 统一替换当前这个词（在线/本地化学式都以词为单位）
    const from = wordStart(text, caret);
    const next = text.slice(0, from) + s.text + text.slice(caret);
    const nextCaret = from + s.text.length;
    updateText(next);
    // 补全完就别再弹了，等用户继续打字再说
    suppressRef.current = next;
    setSuggest(null);
    setOnline([]);
    setOnlineState("idle");
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (suppressRef.current !== null && value !== suppressRef.current) {
      suppressRef.current = null; // 用户又动了，恢复联想
    }
    updateText(value, true);
    refresh(value, e.target.selectionStart);
    syncCondFromCaret(value, e.target.selectionStart);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 自己接管撤销/重做（受控 textarea 的原生撤销会被 React 冲掉）
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }

    // Esc 随时能关掉补全（并且不再马上弹回来）
    if (e.key === "Escape") {
      e.preventDefault();
      suppressRef.current = text;
      setSuggest(null);
      setOnline([]);
      setOnlineState("idle");
      return;
    }

    if (items.length) {
      const n = items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + n) % n);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pick(items[Math.min(active, n - 1)]);
        return;
      }
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        refresh(el.value, el.selectionStart);
        syncCondFromCaret(el.value, el.selectionStart);
      });
    }
  };

  const insertAtCursor = (symbol: string) => {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + symbol + text.slice(end);
    // "->[]" 插入后把光标停在方括号中间，紧接着就能选反应条件
    const caret = start + (symbol.endsWith("[]") ? symbol.length - 1 : symbol.length);
    updateText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      refresh(next, caret);
      // 插的是 "=[]" 时光标正好在括号里 → 立刻带出条件面板
      syncCondFromCaret(next, caret);
    });
  };

  /** 边输入边生效：把条件直接写回文中的 =[ … ] */
  const writeCond = (index: number, above: string, below: string) => {
    const next = setArrowConditionsAt(text, index, above, below);
    updateText(next, true);
  };

  /** 光标是否落在 =[ … ] 里；在则展开面板并带出当前值，不在则收起 */
  const syncCondFromCaret = (value: string, caret: number) => {
    const idx = arrowIndexAtCaret(value, caret);
    if (idx === null) {
      setCondIndex(null);
      return;
    }
    if (idx === condIndex) return; // 正在编辑同一个箭头，别把输入框冲掉
    const arrow = findArrows(value)[idx];
    setCondIndex(idx);
    setCondAbove(arrow?.above ?? "");
    setCondBelow(arrow?.below ?? "");
  };

  /** 快捷条件词：填进「上」或「下」并立即写入 */
  const addCondChip = (word: string) => {
    if (condIndex === null) return;
    if (condTarget === "below") {
      setCondBelow(word);
      writeCond(condIndex, condAbove, word);
    } else {
      setCondAbove(word);
      writeCond(condIndex, word, condBelow);
    }
  };

  /** 是否含有带条件的反应箭头 */
  const hasCondition = useMemo(
    () => lines.some((line) => line.some((t) => t.kind === "arrow" && (t.above || t.below))),
    [lines]
  );

  /**
   * Word 的公式引擎没法把反应条件正确居中（limUpp 会缩小文字，
   * 矩阵的 m:mcJc 又不生效），所以含条件时默认改用图片插入，
   * 由我们自己的排版引擎渲染，居中是代码保证的。
   */
  const effectiveMode: InsertMode = activeMode === "rich" && hasCondition ? "image" : activeMode;

  const handleInsert = async () => {
    if (host === "none") {
      notify("请先在三端 Office 中加载本加载项再插入", false);
      return;
    }
    if (!text.trim()) {
      notify("请先输入化学式", false);
      return;
    }
    setBusy(true);
    try {
      const base64 = await svgToPngBase64(
        rendered.svg,
        rendered.width,
        rendered.height,
        3,
        whiteBg ? "#ffffff" : undefined
      );
      const outcome = await insertFormula({
        host,
        lines,
        mode: effectiveMode,
        base64,
        widthPx: rendered.width,
        heightPx: rendered.height,
        plainText,
        scale: insertScale,
      });
      setRecent(pushRecent(text));
      notify(
        activeMode === "rich" && hasCondition
          ? "含反应条件，已用图片插入（Word 公式无法让条件居中）"
          : outcome.message
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="field">
        <div className="field-head">
          <label htmlFor="formula-input">化学式 / 反应式</label>
          <span
            className={`online-dot ${onlineState}`}
            title={
              onlineState === "loading"
                ? "正在查询 PubChem…"
                : onlineState === "ok"
                  ? "在线结果来自 PubChem（化学式）"
                  : onlineState === "off"
                    ? "在线接口不可用，已回落到本地库"
                    : "输入两个以上字母会在线查询 PubChem"
            }
          />
          <select
            className="template-select"
            value=""
            onChange={(e) => {
              if (e.target.value) updateText(e.target.value);
            }}
          >
            {TEMPLATES.map((t) => (
              <option key={t.name} value={t.value}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="editor-wrap">
          <textarea
            id="formula-input"
            ref={taRef}
            value={text}
            spellCheck={false}
            rows={3}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onClick={(e) => {
              refresh(e.currentTarget.value, e.currentTarget.selectionStart);
              syncCondFromCaret(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onBlur={() => {
              // 失焦时在线结果也要一起收掉，否则只剩在线条目时列表不会消失
              setSuggest(null);
              setOnline([]);
              setOnlineState("idle");
            }}
            placeholder="输入化学式，例如 H2SO4；输入 H2 会出现联想"
          />
          {items.length > 0 && (
            <SuggestList
              list={items}
              active={Math.min(active, items.length - 1)}
              anchor={anchor}
              onPick={pick}
              onHover={setActive}
            />
          )}
        </div>

        <div className="symbols">
          {SYMBOLS.map((s) => (
            <button key={s} className="chip" onClick={() => insertAtCursor(s)} type="button">
              {s.trim() || s}
            </button>
          ))}
        </div>

        <div className="edit-tools">
          <button type="button" className="mini" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
            ↶ 撤销
          </button>
          <button type="button" className="mini" onClick={redo} disabled={!canRedo} title="Ctrl+Y">
            ↷ 重做
          </button>
          <button
            type="button"
            className="mini"
            onClick={() => {
              updateText("");
              setCondAbove("");
              setCondBelow("");
              setSuggest(null);
              setOnline([]);
            }}
            disabled={!text}
          >
            清空
          </button>
        </div>

        {condIndex !== null && (
          <div className="cond-block">
            <div className="cond-head">
              <span className="cond-title">反应条件</span>
              <span className="cond-sub">
                {condIndex !== null && findArrows(text)[condIndex]?.kind === "equals"
                  ? "等号"
                  : "箭头"}
                上方 / 下方
              </span>
              <button
                type="button"
                className="cond-close"
                onClick={() => setCondIndex(null)}
                title="收起"
              >
                ×
              </button>
            </div>
            <div className="cond-body">
              <div className="cond-row">
                <span className="cond-label">上</span>
                <input
                  ref={aboveRef}
                  className="cond-input"
                  value={condAbove}
                  placeholder="如 点燃、高温"
                  onChange={(e) => {
                    setCondAbove(e.target.value);
                    setCondTarget("above");
                    if (condIndex !== null) writeCond(condIndex, e.target.value, condBelow);
                  }}
                  onFocus={() => setCondTarget("above")}
                />
              </div>
              <div className="cond-row">
                <span className="cond-label">下</span>
                <input
                  ref={belowRef}
                  className="cond-input"
                  value={condBelow}
                  placeholder="如 催化剂、Δ"
                  onChange={(e) => {
                    setCondBelow(e.target.value);
                    setCondTarget("below");
                    if (condIndex !== null) writeCond(condIndex, condAbove, e.target.value);
                  }}
                  onFocus={() => setCondTarget("below")}
                />
              </div>

              <div className="cond-chips">
                {CONDITION_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`chip ${condTarget === "below" ? "to-below" : ""}`}
                    onClick={() => addCondChip(c)}
                    title={`填到「${condTarget === "below" ? "下" : "上"}」`}
                  >
                    {c}
                  </button>
                ))}
              </div>

              <p className="tip">输入即生效；两行都清空就去掉条件。</p>
            </div>
          </div>
        )}

        <p className={`tip ${parenBalance !== 0 ? "warn" : ""}`}>
          {parenBalance !== 0
            ? `括号没有配对（${parenBalance > 0 ? "少了 " + parenBalance + " 个 )" : "多了 " + -parenBalance + " 个 )"}）`
            : "数字自动下标，^ 表示电荷；条件写在 =[上方|下方]，如 =[点燃]、=[高温高压|催化剂]。删除后可按 Ctrl+Z 撤销。"}
        </p>
      </div>

      <div className="field">
        <div className="field-head">
          <label>预览</label>
          <div className="size-control">
            <span>字号</span>
            <input
              type="range"
              min={16}
              max={44}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
            <span className="num">{fontSize}</span>
          </div>
        </div>
        <div
          className={`preview-box ${whiteBg ? "white" : ""}`}
          dangerouslySetInnerHTML={{ __html: rendered.svg }}
        />
      </div>

      <div className="field">
        <div className="field-head">
          <label>插入方式</label>
          <label className="checkbox">
            <input type="checkbox" checked={whiteBg} onChange={(e) => setWhiteBg(e.target.checked)} />
            白色背景
          </label>
        </div>
        <div className="segmented">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className={activeMode === m ? "active" : ""}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        {effectiveMode === "image" && (
          <div className="scale-row">
            <span className="scale-caption">插入大小</span>
            <div className="segmented scale-seg">
              {[
                { v: 0.5, label: "小" },
                { v: 0.75, label: "中" },
                { v: 1, label: "大" },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  className={insertScale === o.v ? "active" : ""}
                  onClick={() => setInsertScale(o.v)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {activeMode === "rich" && hasCondition && (
          <p className="tip warn">
            检测到反应条件：Word 的公式引擎没法让条件在箭头上方居中（会缩小并偏左），
            插入时会<strong>自动改用图片</strong>，效果与上方预览完全一致。
          </p>
        )}
        <p className="tip">
          {activeMode === "rich" &&
            !hasCondition &&
            "以 Word 原生公式（OMML）插入，可在文档里直接编辑、随正文字号缩放。"}
          {activeMode === "image" && "以高清位图插入，大小按「字号 × 插入大小」等比缩放，最多不超过版心宽度。"}
          {activeMode === "text" && "以纯文本 + Unicode 上下标插入，可直接参与单元格计算与检索。"}
        </p>
      </div>

      <button className="primary" onClick={handleInsert} disabled={busy || host === "none"}>
        {busy ? "插入中…" : `插入到 ${host === "none" ? "文档" : hostLabel(host)}`}
      </button>
    </div>
  );
}

function hostLabel(host: HostName) {
  return host === "word" ? "Word" : host === "excel" ? "单元格" : "幻灯片";
}
