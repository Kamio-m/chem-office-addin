import { groupAtoms, type Token, type ArrowKind } from "./chem";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

const ARROW_CHAR: Record<ArrowKind, string> = {
  right: "⟶",
  left: "⟵",
  both: "⟷",
  equil: "⇌",
  equals: "=",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 直立（非斜体）数学文本，符合化学式的书写习惯 */
function run(text: string): string {
  if (!text) return "";
  return `<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
}

function lineToOmml(tokens: Token[]): string {
  const atoms = groupAtoms(tokens);
  const out: string[] = [];

  for (const a of atoms) {
    if (a.arrow) {
      const arrowRun = run(ARROW_CHAR[a.arrow.kind]);

      // 没有条件时直接用箭头字符，保持轻量
      if (!a.arrow.above && !a.arrow.below) {
        out.push(arrowRun);
        continue;
      }

      // 有条件时用 limUpp / limLow。
      // 注意：Word 会把 lim 里的文字缩到约 60%，而且矩阵的 m:mcJc 居中实测不生效，
      // 所以「含反应条件」的公式默认不走 OMML，改由 FormulaPanel 用图片插入。
      // 这里保留一份可用的降级结构，仅在用户强制选择文字公式时使用。
      let node = arrowRun;
      if (a.arrow.below) {
        node = `<m:limLow><m:e>${node}</m:e><m:lim>${run(a.arrow.below)}</m:lim></m:limLow>`;
      }
      if (a.arrow.above) {
        node = `<m:limUpp><m:e>${node}</m:e><m:lim>${run(a.arrow.above)}</m:lim></m:limUpp>`;
      }
      out.push(node);
      continue;
    }
    if (a.space !== undefined) {
      out.push(run(" ".repeat(Math.min(a.space, 3))));
      continue;
    }
    const base = a.base ?? "";
    if (a.sub && a.sup) {
      out.push(`<m:sSubSup><m:e>${run(base)}</m:e><m:sub>${run(a.sub)}</m:sub><m:sup>${run(a.sup)}</m:sup></m:sSubSup>`);
    } else if (a.sub) {
      out.push(`<m:sSub><m:e>${run(base)}</m:e><m:sub>${run(a.sub)}</m:sub></m:sSub>`);
    } else if (a.sup) {
      out.push(`<m:sSup><m:e>${run(base)}</m:e><m:sup>${run(a.sup)}</m:sup></m:sSup>`);
    } else {
      out.push(run(base));
    }
  }
  return out.join("");
}

/** 生成 Word 的 insertOoxml 可接受的 Flat OPC 包（含原生可编辑公式） */
export function buildWordOoxml(lines: Token[][]): string {
  const paragraphs = lines
    .map(
      (tokens) =>
        `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>` +
        `<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr>` +
        `<m:oMath>${lineToOmml(tokens)}</m:oMath></m:oMathPara></w:p>`
    )
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">` +
    `<pkg:part pkg:name="/word/document.xml" ` +
    `pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">` +
    `<pkg:xmlData>` +
    `<w:document xmlns:w="${W_NS}" xmlns:m="${M_NS}"><w:body>${paragraphs}</w:body></w:document>` +
    `</pkg:xmlData></pkg:part></pkg:package>`
  );
}
