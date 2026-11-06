import { useEffect } from "react";
import type { Suggestion } from "../lib/suggest";
import type { CaretPoint } from "../lib/caret";

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  ion: "离子",
  condition: "条件",
  online: "在线",
};

const PANEL_WIDTH = 258;

interface Props {
  list: Suggestion[];
  active: number;
  anchor: CaretPoint;
  onPick: (s: Suggestion) => void;
  onHover: (index: number) => void;
}

export default function SuggestList({ list, active, anchor, onPick, onHover }: Props) {
  // 限制在输入框宽度内，避免贴出面板右边缘
  const width = Math.max(180, Math.min(PANEL_WIDTH, anchor.width));
  const left = Math.max(0, Math.min(anchor.left, anchor.width - width));
  const top = anchor.top + anchor.height + 4;

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".suggest-item.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      className="suggest-list"
      style={{ top, left, width }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {list.map((s, i) => (
        <div
          key={`${s.kind}-${s.text}`}
          className={`suggest-item ${i === active ? "active" : ""}`}
          title={`${s.text}${s.hint ? "  —  " + s.hint : ""}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(s)}
        >
          <span className={`suggest-kind kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
          <span className="suggest-text">{s.label}</span>
          {s.hint && <span className="suggest-hint">{s.hint}</span>}
        </div>
      ))}
      <div className="suggest-foot">
        <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Tab</kbd> 补全 · <kbd>Esc</kbd> 关闭
      </div>
    </div>
  );
}
