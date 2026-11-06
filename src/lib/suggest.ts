/**
 * 化学式输入的联想数据与匹配逻辑。
 *
 * 匹配策略：
 *  1. 光标在 `[...]` 里（反应条件）→ 只联想反应条件
 *  2. 当前整行已输入的内容能作为某条常用反应的前缀 → 联想常用反应
 *  3. 否则按「当前这一个词」做前缀匹配 → 化合物 / 离子 / 元素
 */

export type SuggestKind = "ion" | "condition" | "online";

export interface Suggestion {
  /** 接受后替换进去的文本 */
  text: string;
  /** 展示的主文本 */
  label: string;
  /** 右侧灰色说明 */
  hint?: string;
  kind: SuggestKind;
}

export interface SuggestResult {
  /** 替换起点（相对整段文本的绝对下标） */
  from: number;
  /** 替换终点，一般就是光标位置 */
  to: number;
  list: Suggestion[];
}

const IONS: Array<[string, string]> = [
  ["H^+", "氢离子"], ["Na^+", "钠离子"], ["K^+", "钾离子"], ["NH4^+", "铵根离子"],
  ["Ca^2+", "钙离子"], ["Mg^2+", "镁离子"], ["Al^3+", "铝离子"],
  ["Fe^2+", "亚铁离子"], ["Fe^3+", "铁离子"], ["Cu^2+", "铜离子"],
  ["Zn^2+", "锌离子"], ["Ag^+", "银离子"], ["Ba^2+", "钡离子"],
  ["Cl^-", "氯离子"], ["OH^-", "氢氧根"], ["NO3^-", "硝酸根"],
  ["SO4^2-", "硫酸根"], ["CO3^2-", "碳酸根"], ["HCO3^-", "碳酸氢根"],
  ["MnO4^-", "高锰酸根"], ["PO4^3-", "磷酸根"],
];

const CONDITIONS: Array<[string, string]> = [
  ["点燃", "燃烧"], ["加热", "Δ"], ["高温", "煅烧"], ["催化剂", ""],
  ["通电", "电解"], ["光照", ""], ["浓硫酸", "脱水"], ["稀硫酸", ""],
  ["高温高压", "合成氨"], ["酸性条件", ""], ["碱性条件", ""],
];



function toSuggestion(kind: SuggestKind, [text, hint]: [string, string]): Suggestion {
  return { text, label: text, hint: hint || undefined, kind };
}

/** 光标所在的「当前词」的起点 */
export function wordStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9()·\u4e00-\u9fa5]/.test(text[i - 1])) i--;
  return i;
}

/** 光标是否在未闭合的 [...] 里，返回其起点 */
function bracketStart(text: string, caret: number): number | null {
  let depth = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "]") {
      if (depth === 0) return null;
      depth--;
    } else if (ch === "[") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

const MAX = 6;

export function getSuggestions(text: string, caret: number): SuggestResult | null {
  if (caret > text.length) caret = text.length;

  // 1. 反应条件
  const bStart = bracketStart(text, caret);
  if (bStart !== null) {
    const typed = text.slice(bStart + 1, caret);
    const list = CONDITIONS.filter(([name]) =>
      typed ? name.startsWith(typed) && name !== typed : true
    ).map((c) => toSuggestion("condition", c));
    return list.length ? { from: bStart + 1, to: caret, list: list.slice(0, MAX) } : null;
  }

  // 3. 当前词前缀匹配
  const wStart = wordStart(text, caret);
  const word = text.slice(wStart, caret);

  // 光标在词外 / 空输入：不弹任何联想（历史记录已按需求移除）
  if (!word) return null;

  const lower = word.toLowerCase();
  const starts = (s: string) => {
    const l = s.toLowerCase();
    // 前缀匹配；输入 ≥2 字符时，仅大小写不同的（co → CO）也算命中
    return (l.startsWith(lower) && s.length > word.length) || (lower.length >= 2 && l === lower);
  };

  const formulas = IONS.filter(([sym]) => starts(sym)).map((i) => toSuggestion("ion", i));

  const merged = formulas;
  return merged.length ? { from: wStart, to: caret, list: merged } : null;
}

