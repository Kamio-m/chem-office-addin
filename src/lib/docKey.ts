/**
 * 文档级标识：草稿按文档隔离。
 *
 * 目标：同一个文档切页签 / 关面板 / 刷新后内容还在；换一个新文档则是空白。
 *
 * 取 id 的优先级：
 *   1. 文档内嵌设置（Office.context.document.settings，随文档保存，新建文档天生没有）
 *   2. 文档 URL 映射（localStorage 里记 url → id，兼容设置还没保存就先关了文档的情况）
 *   3. 新生成一个随机 id
 *
 * 在浏览器里预览（没有 Office 宿主）时退化为固定 id，方便开发调试。
 */

const ID_SETTING = "chemToolsDocId";
const MAP_KEY = "chem-addin.docmap";
const STANDALONE = "standalone";

let cached: string | null = null;

function randomId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function hasOfficeHost(): boolean {
  try {
    return typeof Office !== "undefined" && !!Office.context && !!Office.context.document;
  } catch {
    return false;
  }
}

function officeSettings(): Office.Settings | null {
  try {
    const settings = Office.context?.document?.settings;
    return settings && typeof settings.get === "function" ? settings : null;
  } catch {
    return null;
  }
}

function documentUrl(): string {
  try {
    return String(Office.context?.document?.url ?? "");
  } catch {
    return "";
  }
}

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(MAP_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>) {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 当前文档的稳定标识；同一文档内多次调用返回同一个值 */
export function getDocumentKey(): string {
  if (cached) return cached;

  if (!hasOfficeHost()) {
    cached = STANDALONE;
    return cached;
  }

  const settings = officeSettings();
  const url = documentUrl();
  const map = readMap();

  let id = "";
  try {
    const stored = settings?.get(ID_SETTING);
    if (typeof stored === "string" && stored) id = stored;
  } catch {
    /* 设置不可用就走 URL 映射 */
  }
  if (!id && url && map[url]) id = map[url];
  if (!id) id = randomId();

  // 双保险落盘：文档设置（异步保存）+ url 映射（同步，立刻可用）
  try {
    if (settings && settings.get(ID_SETTING) !== id) {
      settings.set(ID_SETTING, id);
      settings.saveAsync(() => {
        /* 失败也无所谓，url 映射还在 */
      });
    }
  } catch {
    /* 忽略 */
  }
  if (url && map[url] !== id) {
    map[url] = id;
    writeMap(map);
  }

  cached = id;
  return cached;
}

/** 把草稿键加上文档后缀：chem-addin.ket-draft → chem-addin.ket-draft:<文档 id> */
export function scopedKey(base: string): string {
  return `${base}:${getDocumentKey()}`;
}

/**
 * 读当前文档的草稿。
 * 老版本用的是全局键：只有当文档是「已保存的真实文件」（有 URL）时，
 * 才把旧草稿迁移过来，避免把上一次的图灌进新建的空白文档。
 */
export function readScopedDraft(base: string): string | null {
  const key = scopedKey(base);
  let scoped: string | null = null;
  try {
    scoped = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (scoped !== null) return scoped;

  // 一段式迁移：全局键 → 当前文档（仅限已保存文档）
  try {
    const legacy = localStorage.getItem(base);
    if (legacy !== null && legacy.length > 0 && documentUrl()) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(base);
      return legacy;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

export function saveScopedDraft(base: string, value: string) {
  try {
    localStorage.setItem(scopedKey(base), value);
  } catch {
    /* 隐私模式忽略 */
  }
}
