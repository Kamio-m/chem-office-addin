import {
 defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import httpsMod from "node:https";

/**
 * 开发态下的 PubChem 代理。
 * 生产环境由 launcher/server.cjs 提供同一个端点（那边是 SEA 单文件，代码只能内联），
 * 这里是等价实现，逻辑保持一致。
 */
function pubchemDevProxy(): any {
  const cache = new Map<string, { at: number; items: any[] }>();

  const fetchJson = (url: string, timeoutMs: number) =>
    new Promise<any>((resolve, reject) => {
      const req = httpsMod.get(
        url,
        { timeout: timeoutMs, headers: { "User-Agent": "ChemTools/1.0" } },
        (resp) => {
          if (resp.statusCode !== 200) {
            resp.resume();
            reject(new Error("HTTP " + resp.statusCode));
            return;
          }
          let data = "";
          resp.setEncoding("utf8");
          resp.on("data", (c) => (data += c));
          resp.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
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

const ELEMENT_TOKENS = new Set<string>(
  'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ')
);
/**
 * 只放行无机化学式：
 *  1. 全部元素 token 都是真实元素符号（KNOLL→L 不是元素，滤掉）
 *  2. 含 C 又含 H 视为有机物滤过（CH4/CH3COOH/葡萄糖…），
 *     碳酸盐体系（CO3/HCO3/H2CO3）与氰/硫氰酸盐例外，仍属无机
 */
function isInorganic(f: string) {
  const tokens: string[] = f.match(/[A-Z][a-z]?/g) || [];
  if (!tokens.length) return false;
  for (const t of tokens) if (!ELEMENT_TOKENS.has(t)) return false;
  const hasC = tokens.indexOf('C') >= 0;
  const hasH = tokens.indexOf('H') >= 0;
  if (hasC && hasH && !/(CO3|SCN|OCN|CNO|CN)/.test(f)) return false;
  return true;
}

  // 只从返回项里抽化学式，并按前缀严格过滤（与 server.cjs 中逻辑一致）
  const extractFormulas = (terms: string[], prefix: string) => {
    const candidate = /[A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*/g;
    const valid = /^(?:[A-Z][a-z]?\d*)+$/;
    const found = new Map<string, string>();
    for (const term of terms) {
      const hits = String(term).match(candidate) || [];
      for (const hit of hits) {
        if (!valid.test(hit)) continue;
        if (!isInorganic(hit)) continue; // 无机物之外一律滤过
        if (!hit.toUpperCase().startsWith(prefix.toUpperCase())) continue;
        if (hit === prefix) continue;
        if (!found.has(hit)) {
          const src = String(term);
          let hint = src === hit ? "" : src.split("(")[0].trim() || src;
          if (hint === hit) hint = "";
          found.set(hit, hint.slice(0, 24));
        }
      }
    }
    return [...found.entries()].slice(0, 4).map(([formula, name]) => ({ formula, name }));
  };

  const suggest = async (term: string) => {
    if (term.length < 2) return [];
    const hit = cache.get(term);
    if (hit && Date.now() - hit.at < 600000) return hit.items;

    const ac = await fetchJson(
      `https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/${encodeURIComponent(term)}?json`,
      2500
    );
    const terms: string[] = ac?.dictionary_terms?.compound || [];
    let items = extractFormulas(terms, term);

    // 名字里没带「(化学式)」的条目，反查 PubChem 拿分子式再过滤（与 server.cjs 一致）
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
            const f = p?.PropertyTable?.Properties?.[0]?.MolecularFormula || "";
            return f ? `${name} (${f})` : "";
          } catch {
            return "";
          }
        })
      );
      const merged = new Map<string, { formula: string; name: string }>(
        items.map((i) => [i.formula, i])
      );
      for (const it of extractFormulas(looked.filter(Boolean), term)) {
        if (!merged.has(it.formula)) merged.set(it.formula, it);
      }
      items = [...merged.values()].slice(0, 4);
    }
    cache.set(term, { at: Date.now(), items });
    return items;
  };

  return {
    name: "chem-pubchem-proxy",
    configureServer(server: any) {
      server.middlewares.use("/api/chem/suggest", async (req: any, res: any) => {
        const q = new URL(req.url || "", "https://placeholder").searchParams.get("q") || "";
        let payload: any;
        try {
          payload = { ok: true, items: await suggest(q) };
        } catch (err) {
          payload = { ok: false, error: String(err) };
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
      });
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  let https: UserConfig["server"] extends { https?: infer H } ? H : any = false;

  try {
    // office-addin-dev-certs 复用 ~/.office-addin-dev-certs 下已信任的本地证书
    const mod: any = await import("office-addin-dev-certs");
    const devCerts = mod.default ?? mod;
    const options = await devCerts.getHttpsServerOptions();
    https = { key: options.key, cert: options.cert };
  } catch {
    console.warn(
      "\n[chem-addin] 未获取到本地开发证书，将以 http 启动。\n" +
        "Office 加载项要求 https，请先执行: npm run certs\n"
    );
  }

  const config: UserConfig = {
    define: {
      __BUILD_TIME__: JSON.stringify(new Date().toLocaleString("sv-SE").slice(0, 16)),
      // Ketcher 及其依赖里有 Node 时代残留的 process / global 引用
      global: "globalThis",
    },
    resolve: {
      alias: {
        process: "process/browser",
      },
    },
    optimizeDeps: {
      esbuildOptions: {
        define: { global: "globalThis" },
      },
    },
    plugins: [react(), pubchemDevProxy()] as UserConfig["plugins"],
    base: "/",
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      https,
      headers: { "Access-Control-Allow-Origin": "*" },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Ketcher 的依赖里混用了 ESM/CJS，需要让 Rollup 一并转换，否则生产包里会残留 require
      commonjsOptions: { transformMixedEsModules: true },
      chunkSizeWarningLimit: 30000,
      rollupOptions: {
        // 两个入口：任务窗格 + 功能区按钮的后台命令页
        input: {
          index: "index.html",
          commands: "commands.html",
        },
      },
    },
  };

  return config;
});
