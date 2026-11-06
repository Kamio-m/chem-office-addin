/*
 * 把前端 + 启动器打包成一个独立的 exe（Node SEA 单文件应用）。
 * 用法：npm run exe
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT_NAME = "化学工具.exe";

// postject 处理 PE 时对含中文的路径不友好，中间产物统一放到纯英文临时目录
const BUILD = path.join(os.tmpdir(), "chem-addin-build");

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

function step(msg) {
  console.log(`\x1b[36m▶\x1b[0m ${msg}`);
}

// 1. 前端构建
if (!existsSync(path.join(DIST, "index.html"))) {
  step("dist/ 不存在，先执行前端构建…");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

// 2. 准备中间目录
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

// 3. 收集资源
const assets = {};
for (const file of walk(DIST)) assets[file.rel] = file.full;
// 内置自签证书是可选项：仓库不提交证书（.key 是私钥），别人 clone 后必然缺失。
// 缺了就跳过——运行期会回落到 office-addin-dev-certs 装进系统的那套证书。
for (const name of ["localhost.crt", "localhost.key"]) {
  const p = path.join(ROOT, "launcher", "cert", name);
  if (existsSync(p)) assets[`cert/${name}`] = p;
}

// 每次打包给任务窗格 URL 加一个版本号，强制 Office 重新加载（否则旧页面会一直缓存）
const stamp = new Date().toLocaleString("sv-SE").slice(0, 16).replace(/[-: ]/g, "");
const rawManifest = readFileSync(path.join(ROOT, "manifest.xml"), "utf8");
const patchedManifest = rawManifest
  .replace(/https:\/\/localhost:3000\/index\.html(\?v=\d+)?/g, `https://localhost:3000/index.html?v=${stamp}`)
  .replace(/https:\/\/localhost:3000\/commands\.html(\?v=\d+)?/g, `https://localhost:3000/commands.html?v=${stamp}`);
const manifestOut = path.join(BUILD, "manifest.xml");
writeFileSync(manifestOut, patchedManifest);
assets["manifest.xml"] = manifestOut;
console.log(`\x1b[2m   任务窗格 URL 版本号: v=${stamp}\x1b[0m`);

for (const [key, file] of Object.entries(assets)) {
  if (!existsSync(file)) throw new Error(`缺少资源 ${key} ← ${file}`);
}

// 4. SEA 配置
const seaConfig = {
  main: path.join(ROOT, "launcher", "server.cjs"),
  output: path.join(BUILD, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
const configPath = path.join(BUILD, "sea-config.json");
writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

step(`打包 ${Object.keys(assets).length} 个资源…`);
execFileSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });

// 5. 以 node.exe 为底注入 blob
const target = path.join(BUILD, "chem-addin.exe");
copyFileSync(process.execPath, target);

step("注入 SEA blob…");
const postject = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
execFileSync(
  process.execPath,
  [
    postject,
    target,
    "NODE_SEA_BLOB",
    path.join(BUILD, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" }
);

// 6. 输出
const finalPath = path.join(ROOT, OUT_NAME);
copyFileSync(target, finalPath);
const sizeMb = (statSync(finalPath).size / 1024 / 1024).toFixed(1);

console.log("");
console.log(`\x1b[32m✔\x1b[0m 已生成 ${OUT_NAME}（${sizeMb} MB）`);
console.log(`  ${finalPath}`);
console.log("");
console.log(`  双击即可运行：内嵌前端、自动注册加载项、启动本地 https 服务。`);
console.log(`  \x1b[2m提示：体积主要来自 Node 运行时，属正常现象。\x1b[0m`);
