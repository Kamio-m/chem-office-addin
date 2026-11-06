export type HostName = "word" | "excel" | "powerpoint" | "none";

export interface HostInfo {
  host: HostName;
  platform: string;
  label: string;
  inOffice: boolean;
}

const LABELS: Record<HostName, string> = {
  word: "Word",
  excel: "Excel",
  powerpoint: "PowerPoint",
  none: "浏览器预览",
};

export function detectHost(): Promise<HostInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (host: HostName, platform: string, inOffice: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ host, platform, label: LABELS[host], inOffice });
    };

    const timer = setTimeout(() => finish("none", "browser", false), 4000);

    const office = typeof Office !== "undefined" ? Office : undefined;
    if (!office || typeof office.onReady !== "function") {
      clearTimeout(timer);
      finish("none", "browser", false);
      return;
    }

    office
      .onReady()
      .then((info) => {
        clearTimeout(timer);
        const platform = String(info.platform ?? "");
        switch (info.host) {
          case Office.HostType.Word:
            finish("word", platform, true);
            break;
          case Office.HostType.Excel:
            finish("excel", platform, true);
            break;
          case Office.HostType.PowerPoint:
            finish("powerpoint", platform, true);
            break;
          default:
            finish("none", platform, false);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        finish("none", "browser", false);
      });
  });
}

export function isSetSupported(name: string, version: string): boolean {
  try {
    return Office?.context?.requirements?.isSetSupported(name, version) ?? false;
  } catch {
    return false;
  }
}
