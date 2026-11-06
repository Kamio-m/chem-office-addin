/**
 * 化学式标记语法解析
 *
 * 支持的写法：
 *   H2SO4                  → H₂SO₄（元素/右括号后的数字自动变下标）
 *   Ca(OH)2                → 下标自动
 *   CuSO4·5H2O             → 结晶水
 *   Fe^3+                  → Fe³⁺（^ 后为电荷，自动上标）
 *   SO4^2- / OH^-          → 上下标同时存在
 *   H_{2}O / x^{n}         → 花括号显式指定上下标内容
 *   2H2 + O2 ->[点燃] 2H2O → 箭头上方标注反应条件
 *   A <=> B                → 可逆箭头 ⇌
 *   ->[上|下]              → 用 | 分隔箭头上/下的条件
 */

export type ArrowKind = "right" | "left" | "both" | "equil" | "equals";

export type Token =
  | { kind: "text"; text: string }
  | { kind: "sub"; text: string }
  | { kind: "sup"; text: string }
  | { kind: "space"; width: number }
  | { kind: "arrow"; arrow: ArrowKind; above?: string; below?: string };

const ARROW_DEFS: Array<[string, ArrowKind]> = [
  ["<=>", "equil"],
  ["<->", "both"],
  ["->", "right"],
  ["<-", "left"],
  ["=>", "right"],
  ["=", "equals"],
  ["⇌", "equil"],
  ["⇄", "both"],
  ["→", "right"],
  ["←", "left"],
];

const SUBSCRIPT_ELIGIBLE = /[A-Za-z)\]}′'"]$/;

/** 读一段上下标内容：{...} 或 紧随的连续字符 */
function readScript(src: string, start: number): { value: string; next: number } {
  if (src[start] === "{") {
    const end = src.indexOf("}", start + 1);
    if (end === -1) return { value: src.slice(start + 1), next: src.length };
    return { value: src.slice(start + 1, end), next: end + 1 };
  }
  // 电荷写法：数字 + 正负号，例如 3+  2-  +
  const m = /^[0-9]*[+\-−]?/.exec(src.slice(start));
  if (m && m[0].length > 0) return { value: m[0], next: start + m[0].length };
  return { value: src[start] ?? "", next: start + 1 };
}

function readBracket(src: string, start: number): { value: string; next: number } {
  const end = src.indexOf("]", start + 1);
  if (end === -1) return { value: src.slice(start + 1), next: src.length };
  return { value: src.slice(start + 1, end), next: end + 1 };
}

/* ---------------- 元素符号大小写规范化 ---------------- */

/** 118 个元素符号（大小写正确） */
const ELEMENT_LIST =
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu " +
  "Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr " +
  "Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og";

const ELEMENTS = new Set(ELEMENT_LIST.split(" ").filter(Boolean));

/**
 * 两个字母都能单独成元素时（Co/Cu/Si 这类），按中学化学更常见的读法决定：
 * CO、NO、SO、PO 等拆成一氧化碳、一氧化氮这种写法，其余（Cu、Si、Sn、Bi）合成一个元素。
 */
const PREFER_SPLIT = new Set(["CO", "NO", "SO", "PO", "HO", "OS", "HF"]);

/** 括号里的物态符号，不能被改成大写 */
const STATE_SYMBOLS = new Set(["s", "l", "g", "aq"]);

/** 已经符合元素大小写（含 C+O 这种拆分读法）就原样返回 */
function isValidCasing(run: string): boolean {
  let i = 0;
  while (i < run.length) {
    const two = run.slice(i, i + 2);
    if (two.length === 2 && ELEMENTS.has(two)) {
      i += 2;
      continue;
    }
    if (!ELEMENTS.has(run[i])) return false;
    i += 1;
  }
  return true;
}

/** 把一段字母按元素表重建成正确大小写；遇到不认识的字母就整段不动 */
function rebuildRun(run: string): string {
  // 全大写（HCL、CUO）几乎都是随手大写敲的，一律重建；
  // 大小写混排的（NaCl、Ca(OH)2）只要已经合规就原样保留。
  const allCaps = /^[A-Z]+$/.test(run) && run.length >= 2;
  if (!allCaps && isValidCasing(run)) return run;

  let out = "";
  let i = 0;
  while (i < run.length) {
    const two = run.slice(i, i + 2);
    const pair = two.length === 2 ? two[0].toUpperCase() + two[1].toLowerCase() : "";
    const pairOk = two.length === 2 && ELEMENTS.has(pair);
    const single = run[i].toUpperCase();
    const singleOk = ELEMENTS.has(single);

    if (pairOk && singleOk) {
      const split = PREFER_SPLIT.has(pair.toUpperCase());
      out += split ? single : pair;
      i += split ? 1 : 2;
      continue;
    }
    if (pairOk) {
      out += pair;
      i += 2;
      continue;
    }
    if (singleOk) {
      out += single;
      i += 1;
      continue;
    }
    return run; // 有不认识的字母（aq、hv、n- 之类），保持原样
  }
  return out;
}

/**
 * 规范化学式里元素符号的大小写：HCL → HCl、NAOH → NaOH、CACO3 → CaCO3。
 *
 * 以下位置一律不动：
 *   - [ ] 里的反应条件（点燃、MnO2、hv…）
 *   - { } 里的显式上下标（x^{n} 的 n）
 *   - 括号里的物态符号 (s) (l) (g) (aq)
 *   - n- / e- 这类单字母前缀
 */
export function normalizeFormulaCase(src: string): string {
  let out = "";
  let i = 0;
  let bracket = 0;
  let brace = 0;
  let paren = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === "[") { bracket++; out += ch; i++; continue; }
    if (ch === "]") { bracket = Math.max(0, bracket - 1); out += ch; i++; continue; }
    if (ch === "{") { brace++; out += ch; i++; continue; }
    if (ch === "}") { brace = Math.max(0, brace - 1); out += ch; i++; continue; }
    if (ch === "(") { paren++; out += ch; i++; continue; }
    if (ch === ")") { paren = Math.max(0, paren - 1); out += ch; i++; continue; }

    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i++;
      continue;
    }

    let j = i;
    while (j < src.length && /[A-Za-z]/.test(src[j])) j++;
    const run = src.slice(i, j);
    const nextChar = src[j] ?? "";
    i = j;

    if (bracket > 0 || brace > 0) {
      out += run;
      continue;
    }
    if (paren > 0 && STATE_SYMBOLS.has(run.toLowerCase())) {
      out += run;
      continue;
    }
    // n-C4H9、e- 这类前缀保持小写
    if (run.length === 1 && /[a-z]/.test(run) && nextChar === "-") {
      out += run;
      continue;
    }
    out += rebuildRun(run);
  }
  return out;
}

export function parseLine(input: string): Token[] {
  const src = normalizeFormulaCase(input.replace(/\r/g, ""));
  const tokens: Token[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      tokens.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  const lastTextChar = (): string => {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.kind === "text") return t.text.slice(-1);
      if (t.kind === "space") return " ";
      return "";
    }
    return "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // 箭头
    const arrowDef = ARROW_DEFS.find(([literal]) => src.startsWith(literal, i));
    if (arrowDef) {
      flush();
      const [literal, kind] = arrowDef;
      i += literal.length;
      let above: string | undefined;
      let below: string | undefined;
      if (src[i] === "[") {
        const r = readBracket(src, i);
        i = r.next;
        const parts = r.value.split("|");
        const raw = parts[0].trim();
        if (raw) above = raw;
        const raw2 = (parts[1] ?? "").trim();
        if (raw2) below = raw2;
      }
      tokens.push({ kind: "arrow", arrow: kind, above, below });
      continue;
    }

    if (ch === "_" || ch === "^") {
      flush();
      const r = readScript(src, i + 1);
      i = r.next;
      if (r.value) {
        tokens.push({ kind: ch === "_" ? "sub" : "sup", text: r.value });
      }
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const prev = buffer ? buffer.slice(-1) : lastTextChar();
      if (prev && SUBSCRIPT_ELIGIBLE.test(prev)) {
        // 紧跟在元素符号 / 右括号后的数字 → 下标
        flush();
        const m = /^[0-9]+/.exec(src.slice(i))!;
        tokens.push({ kind: "sub", text: m[0] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === "+") {
      // 单独的加号是反应物分隔符，拆成独立 token 才能给它加间距
      // （电荷里的 + 已在 readScript 中被消费掉，不会走到这里）
      flush();
      tokens.push({ kind: "text", text: "+" });
      i++;
      continue;
    }

    if (ch === " ") {
      flush();
      let n = 0;
      while (src[i] === " ") {
        n++;
        i++;
      }
      tokens.push({ kind: "space", width: n });
      continue;
    }

    buffer += ch;
    i++;
  }

  flush();
  return tokens;
}

/* ---------------- 反应条件（等号 / 箭头上下的文字）定位与改写 ---------------- */

export interface ArrowSpan {
  /** 箭头符号在原文中的起始位置 */
  start: number;
  /** 含 [条件] 方括号在内的结束位置 */
  end: number;
  literal: string;
  kind: ArrowKind;
  above?: string;
  below?: string;
}

const ARROW_LITERALS = ARROW_DEFS.map(([literal]) => literal).sort((a, b) => b.length - a.length);

const ARROW_RE = new RegExp(
  `(${ARROW_LITERALS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(\\[[^\\]]*\\])?`,
  "g"
);

/** 扫出文中所有箭头（含其后的 [条件]） */
export function findArrows(src: string): ArrowSpan[] {
  const spans: ArrowSpan[] = [];
  ARROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARROW_RE.exec(src))) {
    const literal = m[1];
    const def = ARROW_DEFS.find(([l]) => l === literal);
    const bracket = m[2];
    let above: string | undefined;
    let below: string | undefined;
    if (bracket) {
      const inner = bracket.slice(1, -1);
      const parts = inner.split("|");
      const a = (parts[0] ?? "").trim();
      const b = (parts[1] ?? "").trim();
      if (a) above = a;
      if (b) below = b;
    }
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      literal,
      kind: def ? def[1] : "right",
      above,
      below,
    });
  }
  return spans;
}

/** 找光标所在（或最近的）箭头，用于「编辑已有条件」 */
export function arrowNearCaret(src: string, caret: number): ArrowSpan | null {
  const arrows = findArrows(src);
  if (!arrows.length) return null;

  const containing = arrows.find((a) => caret >= a.start && caret <= a.end);
  if (containing) return containing;

  // 只在本行里找，避免误改上一行/下一行的箭头
  const lineStart = src.lastIndexOf("\n", caret - 1) + 1;
  const nl = src.indexOf("\n", caret);
  const lineEnd = nl === -1 ? src.length : nl;
  const inLine = arrows.filter((a) => a.start >= lineStart && a.start <= lineEnd);
  if (!inLine.length) return null;

  const before = inLine.filter((a) => a.start <= caret).pop();
  return before ?? inLine[0];
}

/**
 * 把「上 / 下条件」写到光标附近的箭头上。
 * 两个条件都为空时去掉方括号；文中一个箭头都没有时，在光标处补一个等号。
 */
export function setArrowConditions(
  src: string,
  caret: number,
  above: string,
  below: string
): { text: string; caret: number } {
  const a = above.trim();
  const b = below.trim();
  const bracket = a || b ? `[${a}${b ? `|${b}` : ""}]` : "";

  const target = arrowNearCaret(src, caret);
  if (!target) {
    const insert = `=${bracket}`;
    const at = Math.min(Math.max(caret, 0), src.length);
    return { text: src.slice(0, at) + insert + src.slice(at), caret: at + insert.length };
  }

  const text = src.slice(0, target.start) + target.literal + bracket + src.slice(target.end);
  return { text, caret: target.start + target.literal.length + bracket.length };
}

/**
 * 按序号改写某个箭头的条件（面板里连续输入时用，避免光标位置变化导致锚点漂移）。
 * 两个条件都为空时去掉方括号。
 */
export function setArrowConditionsAt(
  src: string,
  index: number,
  above: string,
  below: string
): string {
  const arrows = findArrows(src);
  const target = arrows[index];
  if (!target) return src;
  const a = above.trim();
  const b = below.trim();
  const bracket = a || b ? `[${a}${b ? `|${b}` : ""}]` : "";
  return src.slice(0, target.start) + target.literal + bracket + src.slice(target.end);
}

/** 光标是否在某个「箭头 + [条件]」范围内；是则返回它的序号 */
export function arrowIndexAtCaret(src: string, caret: number): number | null {
  const arrows = findArrows(src);
  const i = arrows.findIndex((a) => caret >= a.start && caret <= a.end);
  return i === -1 ? null : i;
}

export function parseFormula(input: string): Token[][] {
  return input
    .split("\n")
    .map((line) => parseLine(line))
    .filter((line, _idx, arr) => line.length > 0 || arr.length === 1);
}

/** 纯文本模式：转换成 Unicode 上下标字符，便于粘贴到 Excel 单元格 */
const SUB_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ", i: "ᵢ", r: "ᵣ", u: "ᵤ", v: "ᵥ",
};

const SUP_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  n: "ⁿ", i: "ⁱ",
};

function mapChars(text: string, map: Record<string, string>): string {
  return Array.from(text)
    .map((c) => map[c] ?? c)
    .join("");
}

const ARROW_TEXT: Record<ArrowKind, string> = {
  right: "→",
  left: "←",
  both: "⇄",
  equil: "⇌",
  equals: "=",
};

/** 纯文本输出（Excel / PPT 文本框） */
export function toPlainText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.kind) {
      case "text":
        out += t.text;
        break;
      case "sub":
        out += mapChars(t.text, SUB_MAP);
        break;
      case "sup":
        out += mapChars(t.text, SUP_MAP);
        break;
      case "space":
        out += " ".repeat(t.width);
        break;
      case "arrow": {
        const cond = [t.above, t.below].filter(Boolean).join("");
        if (t.arrow === "right" && cond) out += `--${cond}-->`;
        else if (cond) out += `${ARROW_TEXT[t.arrow]}(${cond})`;
        else out += ARROW_TEXT[t.arrow];
        break;
      }
    }
  }
  return out;
}

export function formulaToPlainText(input: string): string {
  return parseFormula(input).map(toPlainText).join("\n");
}

/** 把 token 流合并成 "基团 + 下标 + 上标" 的原子，供 OMML 构造使用 */
export interface Atom {
  base?: string;
  sub?: string;
  sup?: string;
  space?: number;
  arrow?: { kind: ArrowKind; above?: string; below?: string };
}

export function groupAtoms(tokens: Token[]): Atom[] {
  const atoms: Atom[] = [];
  for (const t of tokens) {
    if (t.kind === "text") {
      atoms.push({ base: t.text });
    } else if (t.kind === "sub" || t.kind === "sup") {
      const prev = atoms[atoms.length - 1];
      if (prev && prev.base !== undefined && prev.space === undefined && !prev.arrow) {
        if (t.kind === "sub") prev.sub = (prev.sub ?? "") + t.text;
        else prev.sup = (prev.sup ?? "") + t.text;
      } else {
        atoms.push(t.kind === "sub" ? { sub: t.text } : { sup: t.text });
      }
    } else if (t.kind === "space") {
      atoms.push({ space: t.width });
    } else {
      atoms.push({ arrow: { kind: t.arrow, above: t.above, below: t.below } });
    }
  }
  return atoms;
}
