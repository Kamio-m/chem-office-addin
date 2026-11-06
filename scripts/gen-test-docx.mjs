import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../.tmp/docx");
const bundlePath = resolve(__dirname, "../.tmp/omml-bundle.mjs");

mkdirSync(resolve(__dirname, "../.tmp"), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export { buildWordOoxml } from "./src/lib/omml.ts"; export { parseFormula } from "./src/lib/chem.ts";`,
    resolveDir: resolve(__dirname, ".."),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  outfile: bundlePath,
  logLevel: "error",
});

const { buildWordOoxml, parseFormula } = await import(pathToFileURL(bundlePath).href);

rmSync(root, { recursive: true, force: true });
mkdirSync(resolve(root, "word"), { recursive: true });
mkdirSync(resolve(root, "_rels"), { recursive: true });

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

// 从 flat OPC 里抽出 body，组装成一个真正的 docx 部件
const sample = process.argv[2] || "2H2 + O2 ->[点燃] 2H2O\nFe^3+ + 3OH^- -> Fe(OH)3↓";
const flat = buildWordOoxml(parseFormula(sample));
const body = /<w:body>([\s\S]*)<\/w:body>/.exec(flat)?.[1] ?? "";

const documentXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${body}</w:body></w:document>`;

writeFileSync(resolve(root, "word/document.xml"), documentXml, "utf8");

writeFileSync(
  resolve(root, "[Content_Types].xml"),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`,
  "utf8"
);

writeFileSync(
  resolve(root, "_rels/.rels"),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`,
  "utf8"
);

console.log("wrote parts to", root);
