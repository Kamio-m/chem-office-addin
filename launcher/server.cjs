/*
 * 化学工具 · Office 加载项 一体化启动器
 *
 * 打包成 exe 后：内嵌前端静态资源与清单，启动本地 https 服务，
 * 自动把加载项注册到当前用户的 Office。
 * 开发状态下也可以直接 `node launcher/server.cjs` 运行（会读 dist/ 目录）。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const readline = require("node:readline");
const { execFile, execFileSync } = require("node:child_process");

const ADDIN_ID = "3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23";
const ADDIN_NAME = "化学工具";
const PORT = Number(process.env.CHEM_PORT) || 3000;
const WEF_DEVELOPER_KEY = "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer";

const APP_DATA = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "ChemOfficeAddin"
);
const DIST_DIR = path.join(__dirname, "..", "dist");
const PROJECT_DIR = path.join(__dirname, "..");

/* ---------------- 内嵌资源 ---------------- */

let seaModule = null;
try {
  seaModule = require("node:sea");
} catch {
  seaModule = null;
}

const IS_SEA = Boolean(seaModule && seaModule.isSea && seaModule.isSea());

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
};

function devPath(name) {
  if (name === "manifest.xml") return path.join(PROJECT_DIR, "manifest.xml");
  if (name.startsWith("cert/")) return path.join(__dirname, name);
  return path.join(DIST_DIR, name);
}

function readAsset(name, assetKey) {
  if (IS_SEA) {
    try {
      const buf = seaModule.getAsset(assetKey);
      return Buffer.from(buf);
    } catch {
      return null;
    }
  }
  const file = devPath(name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

/* ---------------- 证书 ---------------- */

function pickCert() {
  const forceBundled = process.env.CHEM_ADDIN_BUNDLED_CERT === "1";

  // 1) 复用 office-addin-dev-certs 生成的证书（通常已被系统信任）
  if (!forceBundled) {
    const devDir = path.join(os.homedir(), ".office-addin-dev-certs");
    const devCrt = path.join(devDir, "localhost.crt");
    const devKey = path.join(devDir, "localhost.key");
    if (fs.existsSync(devCrt) && fs.existsSync(devKey)) {
      return {
        cert: fs.readFileSync(devCrt),
        key: fs.readFileSync(devKey),
        certPath: devCrt,
        source: "office-addin-dev-certs",
      };
    }
  }

  // 2) 用内嵌证书，解包到用户目录
  const outCrt = path.join(APP_DATA, "localhost.crt");
  const outKey = path.join(APP_DATA, "localhost.key");
  if (!fs.existsSync(outCrt) || !fs.existsSync(outKey)) {
    const cert = readAsset("cert/localhost.crt", "cert/localhost.crt");
    const key = readAsset("cert/localhost.key", "cert/localhost.key");
    if (!cert || !key) throw new Error("找不到可用的 https 证书");
    fs.mkdirSync(APP_DATA, { recursive: true });
    fs.writeFileSync(outCrt, cert);
    fs.writeFileSync(outKey, key);
  }
  return {
    cert: fs.readFileSync(outCrt),
    key: fs.readFileSync(outKey),
    certPath: outCrt,
    source: "内置证书",
  };
}

function runCertutil(args) {
  return new Promise((resolve) => {
    execFile("certutil", args, { windowsHide: true }, (err) => resolve(!err));
  });
}

/** 如果系统还不信任本证书，装进「当前用户 → 受信任的根证书颁发机构」 */
async function ensureTrusted(certPath) {
  if (!fs.existsSync(certPath)) return false;
  const ok = await runCertutil(["-user", "-addstore", "Root", certPath]);
  return ok;
}

/* ---------------- Office 注册 ---------------- */

function writeManifest() {
  const manifest = readAsset("manifest.xml", "manifest.xml");
  if (!manifest) throw new Error("找不到内嵌的 manifest.xml");
  fs.mkdirSync(APP_DATA, { recursive: true });
  const target = path.join(APP_DATA, "manifest.xml");
  fs.writeFileSync(target, manifest);
  return target;
}

function register(manifestPath) {
  try {
    execFileSync(
      "reg",
      ["add", WEF_DEVELOPER_KEY, "/v", ADDIN_ID, "/t", "REG_SZ", "/d", manifestPath, "/f"],
      { windowsHide: true }
    );
    execFileSync(
      "reg",
      ["add", WEF_DEVELOPER_KEY, "/v", "RefreshAddins", "/t", "REG_DWORD", "/d", "1", "/f"],
      { windowsHide: true }
    );
    return "reg";
  } catch {
    // 某些安全策略会限制 reg.exe，退回 PowerShell 的注册表提供程序
    const ps = [
      "$k='HKCU:\\SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer'",
      "New-Item -Path $k -Force | Out-Null",
      `New-ItemProperty -Path $k -Name '${ADDIN_ID}' -Value '${String(manifestPath).replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`,
      "New-ItemProperty -Path $k -Name 'RefreshAddins' -Value 1 -PropertyType DWord -Force | Out-Null",
    ].join("; ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
    });
    return "powershell";
  }
}

function unregister() {
  try {
    execFileSync("reg", ["delete", WEF_DEVELOPER_KEY, "/v", ADDIN_ID, "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  } catch {
    /* fallthrough */
  }
  try {
    const ps =
      "$k='HKCU:\\SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer';" +
      `Remove-ItemProperty -Path $k -Name '${ADDIN_ID}' -ErrorAction SilentlyContinue`;
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    /* 本来就没注册 */
  }
}

/* ---------------- 静态服务 ---------------- */

/* ---------------- 在线联想（PubChem 代理） ---------------- */

const suggestCache = new Map(); // q -> { at, items }
const SUGGEST_TTL = 10 * 60 * 1000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { "User-Agent": "ChemTools/1.0 (office addin)" } },
      (resp) => {
        if (resp.statusCode !== 200) {
          resp.resume();
          reject(new Error("HTTP " + resp.statusCode));
          return;
        }
        let data = "";
        resp.setEncoding("utf8");
        resp.on("data", (chunk) => {
          data += chunk;
          if (data.length > 200000) resp.destroy();
        });
        resp.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
        resp.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

/**
 * PubChem 的自动补全返回的是一堆名字和化学式混在一起，
 * 这里只把「化学式」抽出来，并按用户输入的前缀严格过滤。
 *   输入 H2S → H2SO4 / H2SO3 / H2Se / H2SiO3 ...
 */
function extractFormulas(terms, prefix) {
  const ELEMENT_TOKENS = new Set(
    'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ')
  );
  /**
   * 只放行无机化学式：
   *  1. 全部元素 token 都是真实元素符号（KNOLL→L 不是元素，滤掉）
   *  2. 含 C 又含 H 视为有机物滤过（CH4/CH3COOH/葡萄糖…），
   *     碳酸盐体系（CO3/HCO3/H2CO3）与氰/硫氰酸盐例外，仍属无机
   */
  function isInorganic(f) {
    const tokens = f.match(/[A-Z][a-z]?/g) || [];
    if (!tokens.length) return false;
    for (const t of tokens) if (!ELEMENT_TOKENS.has(t)) return false;
    const hasC = tokens.indexOf('C') >= 0;
    const hasH = tokens.indexOf('H') >= 0;
    if (hasC && hasH && !/(CO3|SCN|OCN|CNO|CN)/.test(f)) return false;
    return true;
  }

  const candidate = /[A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*/g;
  const valid = /^(?:[A-Z][a-z]?\d*)+$/;
  const found = new Map();

  for (const term of terms) {
    const hits = String(term).match(candidate) || [];
    for (const hit of hits) {
      if (!valid.test(hit)) continue;
      if (!isInorganic(hit)) continue; // 无机物之外一律滤过
      if (!hit.toUpperCase().startsWith(prefix.toUpperCase())) continue;
      if (hit.toUpperCase() === prefix.toUpperCase()) continue; // 已经输完了，没得补
      if (hit.length < prefix.length + 1) continue;
      if (!found.has(hit)) {
        const src = String(term);
        // 名字里的「(化学式)」尾巴去掉，只留化合物名当提示
        let hint = src === hit ? "" : src.split("(")[0].trim() || src;
        if (hint === hit) hint = "";
        found.set(hit, hint.slice(0, 24));
      }
    }
  }

  return [...found.entries()].slice(0, 4).map(([formula, name]) => ({ formula, name }));
}

/**
 * 用 PubChem 的自动补全来找化学式。
 * 任何一步失败都直接抛出，由前端回落到本地库。
 */
async function handleSuggest(q) {
  const term = q.trim();
  if (term.length < 2) return [];

  const cached = suggestCache.get(term);
  if (cached && Date.now() - cached.at < SUGGEST_TTL) return cached.items;

  const ac = await fetchJson(
    `https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/${encodeURIComponent(term)}?json`,
    2500
  );
  const terms = (ac && ac.dictionary_terms && ac.dictionary_terms.compound) || [];
  let items = extractFormulas(terms, term);

  // 名字里没带「(化学式)」的条目，反查 PubChem 拿分子式再过滤（并发，单个 1.2s 超时）
  const noFormula = terms.filter((n) => !/\(.+\)/.test(String(n))).slice(0, 3);
  if (noFormula.length && items.length < 4) {
    const looked = await Promise.all(
      noFormula.map(async (name) => {
        try {
          const p = await fetchJson(
            `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(
              name
            )}/property/MolecularFormula/JSON`,
            1200
          );
          const f =
            (p && p.PropertyTable && p.PropertyTable.Properties && p.PropertyTable.Properties[0] &&
              p.PropertyTable.Properties[0].MolecularFormula) || "";
          return f ? `${name} (${f})` : "";
        } catch {
          return "";
        }
      })
    );
    const merged = new Map(items.map((i) => [i.formula, i]));
    for (const it of extractFormulas(looked.filter(Boolean), term)) {
      if (!merged.has(it.formula)) merged.set(it.formula, it);
    }
    items = [...merged.values()].slice(0, 4);
  }

  suggestCache.set(term, { at: Date.now(), items });
  if (suggestCache.size > 300) suggestCache.clear();
  return items;
}

/** 读请求体（带大小上限），/api/ocr-online 用 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}


/* ---------------- 在线结构识别（OSRA） ---------------- */
/*
 * 契约：传一张 PNG，拿回标准 MDL MOL。
 *
 * 背后是 NCI（美国国立癌症研究所）的官方在线 OSRA 服务——目前唯一
 * 「免费 + 准确 + 稳定」的组合。实测阿司匹林 / 咖啡因 / 布洛芬三个分子，
 * 杂原子一个没丢；而 Imago、MolVec 连阿司匹林的 4 个氧都认不出。
 *
 * OSRA 网页的流程是：上传时带一个随机 fid，结果写到 /tmp/osra-<fid>/ 下
 *   done    → 识别出的结构数量
 *   ctab.N  → 第 N 个结构的 MOL（行分隔符是 '|'，要还原成换行）
 * 这里把这套流程脚本化。换服务只需改下面两个常量和三个 fetch 函数。
 */

const OSRA_BASE = (process.env.CHEM_OCR_ENDPOINT || "https://cactus.nci.nih.gov").replace(/\/+$/, "");
const OSRA_CGI = `${OSRA_BASE}/cgi-bin/osra/index.cgi`;
const OSRA_TIMEOUT_MS = 75000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

/** 上传图片，返回本次任务的 fid */
async function submitOsraJob(buf) {
  const fid = String(Math.floor(Math.random() * 900000) + 100000);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "image/png" }), "structure.png");
  fd.append("fid", fid);
  const res = await fetchWithTimeout(OSRA_CGI, { method: "POST", body: fd }, 60000);
  if (!res.ok) throw new Error("上传失败（HTTP " + res.status + "）");
  return fid;
}

/** 轮询 done，直到它给出结构数量 */
async function waitOsraDone(fid, deadline) {
  while (Date.now() < deadline) {
    await sleep(1200);
    let res;
    try {
      res = await fetchWithTimeout(`${OSRA_BASE}/tmp/osra-${fid}/done`, {}, 15000);
    } catch {
      continue; // 目录还没生成，继续等
    }
    if (!res.ok) continue;
    const txt = (await res.text()).trim();
    if (!txt) continue;
    const n = Number(txt);
    return Number.isFinite(n) ? n : 0;
  }
  throw new Error("识别超时，对方没有返回结果，稍后再试");
}

/** 拉第 index 个结构的 MOL，并把 '|' 还原成换行 */
async function fetchOsraMol(fid, index) {
  const res = await fetchWithTimeout(`${OSRA_BASE}/tmp/osra-${fid}/ctab.${index}`, {}, 20000);
  if (!res.ok) throw new Error("读取结果失败（HTTP " + res.status + "）");
  const raw = await res.text();

  const parts = raw.split("|");
  if (parts.length && parts[0] === "") parts.shift();

  // OSRA/OpenBabel 出来的头只有两行（程序行 + 空行），紧接着就是 counts。
  // 标准 MDL 要求三行头（名称/程序/注释），不补这一行的话解析器会把
  // counts 当成注释读，整个分子就废了。
  const mol = "\n" + parts.join("\n").replace(/\s+$/, "");

  if (!/M\s+END/.test(mol)) throw new Error("对方返回的结果不完整");
  return mol;
}

/*
 * 本地限流：这个功能依赖 NCI 的公共服务，不是给人当批量接口用的。
 * 每分钟最多 5 次——正常手点根本到不了，但能挡住脚本刷。
 */
const OCR_RATE_LIMIT = 5;
const OCR_RATE_WINDOW = 60 * 1000;
let ocrHits = [];

function checkOcrRate() {
  const now = Date.now();
  ocrHits = ocrHits.filter((t) => now - t < OCR_RATE_WINDOW);
  if (ocrHits.length >= OCR_RATE_LIMIT) {
    const wait = Math.ceil((OCR_RATE_WINDOW - (now - ocrHits[0])) / 1000);
    throw new Error(`识别太频繁了，请 ${wait} 秒后再试`);
  }
  ocrHits.push(now);
}

async function handleOnlineOcr(pngBase64) {
  const raw = String(pngBase64 || "").replace(/^data:image\/\w+;base64,/, "");
  if (!raw) throw new Error("没有收到图片");
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) throw new Error("图片解码失败");
  if (buf.length > 8 * 1024 * 1024) throw new Error("图片太大（超过 8MB），先裁剪一下");

  checkOcrRate();

  const fid = await submitOsraJob(buf);
  const count = await waitOsraDone(fid, Date.now() + OSRA_TIMEOUT_MS);
  if (!count) throw new Error("图片里没找到可识别的结构");

  const mol = await fetchOsraMol(fid, 0);
  return { mol, count };
}

function createServer(credentials) {
  return https.createServer({ key: credentials.key, cert: credentials.cert }, (req, res) => {
    let urlPath;
    let search = "";
    try {
      const raw = req.url || "/";
      const qi = raw.indexOf("?");
      urlPath = decodeURIComponent(qi >= 0 ? raw.slice(0, qi) : raw);
      search = qi >= 0 ? raw.slice(qi) : "";
    } catch {
      urlPath = "/";
    }
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

    // 在线联想代理：浏览器直接请求 PubChem 会被 CORS 拦，由本地服务中转
    if (urlPath === "/api/chem/suggest") {
      const q = new URLSearchParams(search).get("q") || "";
      handleSuggest(q)
        .then((items) => json(res, 200, { ok: true, items }))
        .catch((err) => json(res, 200, { ok: false, error: String(err && err.message) }));
      return;
    }

    // 在线 OCR：同样收 base64 PNG，转发给在线服务，回来的是 SMILES
    if (urlPath === "/api/ocr-online" && req.method === "POST") {
      readBody(req, 14 * 1024 * 1024)
        .then((body) => {
          let payload = {};
          try {
            payload = JSON.parse(body || "{}");
          } catch {
            throw new Error("请求格式不对");
          }
          return handleOnlineOcr(payload.png);
        })
        .then((out) => json(res, 200, { ok: true, ...out }))
        .catch((err) => {
          const msg = String((err && err.message) || err);
          console.log("  [ocr-online] " + msg);
          json(res, 200, { ok: false, error: msg });
        });
      return;
    }

    const name = urlPath.replace(/^\/+/, "");
    const body = readAsset(name, name);

    if (process.env.CHEM_ADDIN_VERBOSE === "1") {
      const ua = String(req.headers["user-agent"] || "").slice(0, 60);
      console.log(
        "  " + new Date().toTimeString().slice(0, 8) + "  " + (body ? "200" : "404") + "  " + urlPath + "  ← " + ua
      );
    }

    if (!body) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 " + urlPath);
      return;
    }

    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    // 不指定 host：同时监听 IPv4/IPv6，保证 localhost 解析到 ::1 时也能连上
    server.listen(port, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function checkTrusted(port) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: "127.0.0.1", port, path: "/index.html", rejectUnauthorized: true, timeout: 3000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 探测 3000 端口上跑的是不是我们自己的实例 */
function probeRunningInstance(port) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: "127.0.0.1",
        port,
        path: "/index.html",
        rejectUnauthorized: false,
        timeout: 2500,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 4000) res.destroy();
        });
        res.on("end", () => resolve(/化学工具|chem-addin|化学式/.test(data)));
        res.on("error", () => resolve(false));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/* ---------------- 控制台界面 ---------------- */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(msg) {
  console.log(msg);
}

function banner() {
  console.log("");
  console.log(C.cyan + C.bold + "  ⬡  " + ADDIN_NAME + " · Office 加载项" + C.reset);
  console.log(C.dim + "  Word / Excel / PowerPoint 化学式与结构式工具" + C.reset);
  console.log("");
}

function openApp(exe, args) {
  try {
    const child = execFile(exe, args || [], { windowsHide: false }, () => {});
    child.on("error", () => log(C.yellow + "  没能启动 " + exe + "，请手动打开。" + C.reset));
  } catch {
    log(C.yellow + "  没能启动 " + exe + "，请手动打开。" + C.reset);
  }
}

function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(C.bold + " 选择操作 [1-6, Q] > " + C.reset);
  rl.prompt();

  rl.on("line", (line) => {
    const cmd = line.trim().toLowerCase();
    switch (cmd) {
      case "1":
        openApp("cmd", ["/c", "start", "", "winword"]);
        break;
      case "2":
        openApp("cmd", ["/c", "start", "", "excel"]);
        break;
      case "3":
        openApp("cmd", ["/c", "start", "", "powerpnt"]);
        break;
      case "4":
        openApp("cmd", ["/c", "start", "", "https://localhost:" + PORT + "/index.html"]);
        break;
      case "5": {
        const p = writeManifest();
        register(p);
        log(C.green + "  ✔ 已重新注册到 Office，请重启 Office 后在「我的加载项」中查看。" + C.reset);
        break;
      }
      case "6":
        unregister();
        log(C.green + "  ✔ 已从 Office 注销（服务仍在运行）。" + C.reset);
        break;
      case "q":
      case "quit":
      case "exit":
        log(C.dim + "  正在退出…" + C.reset);
        rl.close();
        process.exit(0);
        return;
      default:
        log(C.dim + "  输入 1-6 或 Q。" + C.reset);
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

/* ---------------- 启动 ---------------- */

/** 后台静默模式：装成服务/开机自启时用，不显示菜单、不读 stdin，只跑 HTTPS 服务 */
const SILENT = process.argv.slice(2).some((a) => a === "--silent" || a === "-s");

/** 静默模式把 console.log 同时写进 service.log，方便排查 */
function setupSilentLogging() {
  try {
    const logPath = path.join(APP_DATA, "service.log");
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
    const orig = console.log;
    console.log = (...args) => {
      orig(...args);
      try {
        stream.write(`[${stamp()}] ${args.join(" ")}\n`);
      } catch {
        /* 日志写失败不影响服务 */
      }
    };
  } catch {
    /* 忽略 */
  }
}

async function main() {
  if (SILENT) setupSilentLogging();
  if (!SILENT) banner();

  fs.mkdirSync(APP_DATA, { recursive: true });

  const credentials = pickCert();
  log("  证书：" + C.dim + credentials.source + C.reset);

  const server = createServer(credentials);

  try {
    await listen(server, PORT);
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      const running = await probeRunningInstance(PORT);
      console.log("");
      if (running) {
        log(C.green + "  ✔ 已经有一个「" + ADDIN_NAME + "」在运行了" + C.reset);
        log("  不用重复启动，直接用那个窗口就行；如果找不到窗口：");
        log(C.dim + "    1. 看任务栏有没有一个叫「" + ADDIN_NAME + "」的黑色窗口" + C.reset);
        log(C.dim + "    2. 或先关掉旧窗口，再重新双击本程序" + C.reset);
      } else {
        log(C.red + "  端口 " + PORT + " 被其他程序占用了。" + C.reset);
        log("  请关掉占用它的程序后再打开本程序。");
        log(C.dim + "  想查是谁占的：在命令行执行  netstat -ano | findstr :3000" + C.reset);
      }
      if (!SILENT) await pause();
      process.exit(running ? 0 : 1);
    }
    throw err;
  }

  // 注意：Node 用的是自带的 CA 库，看不到 Windows 证书存储，
  // 所以这里只对「内置证书」做一次性安装；office-addin-dev-certs 的证书
  // 已经由它自己的工具装进系统了，重复提示反而会误导。
  if (credentials.source === "内置证书") {
    const trusted = await checkTrusted(PORT);
    if (!trusted) {
      log("  首次运行，正在把证书加入「受信任的根证书颁发机构」…");
      log(C.dim + "  （可能弹出安全警告，请点「是」）" + C.reset);
      await ensureTrusted(credentials.certPath);
    }
  } else {
    log(C.dim + "  证书来自 office-addin-dev-certs，已由该工具装入系统信任列表" + C.reset);
  }

  log("  服务：" + C.green + "https://localhost:" + PORT + C.reset + C.dim + "  (保持本窗口打开)" + C.reset);

  let manifestPath;
  try {
    manifestPath = writeManifest();
    const via = register(manifestPath);
    log(
      "  Office：" +
        C.green +
        "已注册「" +
        ADDIN_NAME +
        "」" +
        C.reset +
        C.dim +
        "  (" +
        manifestPath +
        ")" +
        C.reset
    );
    if (via === "powershell") log(C.dim + "  注册方式：PowerShell 注册表提供程序" + C.reset);
  } catch (err) {
    log(C.yellow + "  Office 注册失败：" + (err && err.message) + C.reset);
    log(C.dim + "  可以稍后按 5 重试。" + C.reset);
  }

  console.log("");
  console.log(C.dim + "  ─────────────────────────────────────────────" + C.reset);
  console.log("  在 Office 中打开：");
  console.log(C.dim + "     插入 → 我的加载项 → 共享文件夹 / 开发人员加载项 → " + ADDIN_NAME + C.reset);
  console.log("");
  console.log("  " + C.bold + "1" + C.reset + " 打开 Word      " + C.bold + "2" + C.reset + " 打开 Excel     " + C.bold + "3" + C.reset + " 打开 PowerPoint");
  console.log("  " + C.bold + "4" + C.reset + " 浏览器预览     " + C.bold + "5" + C.reset + " 重新注册       " + C.bold + "6" + C.reset + " 注销");
  console.log("  " + C.bold + "Q" + C.reset + " 退出并停止服务");
  console.log(C.dim + "  ─────────────────────────────────────────────" + C.reset);
  console.log("");

  if (SILENT) {
    // 后台模式：不读 stdin（否则读到 EOF 会退出），进程靠 server 的事件循环常驻
    console.log("  已进入后台模式，服务保持运行。停止：结束本进程即可。");
    const shutdown = () => {
      try {
        server.close();
      } catch {
        /* 忽略 */
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  menu();
}

function pause() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("按回车退出…", () => {
      rl.close();
      resolve();
    });
  });
}

main().catch(async (err) => {
  log(C.red + "启动失败：" + (err && err.message ? err.message : String(err)) + C.reset);
  if (!SILENT) await pause();
  process.exit(1);
});
