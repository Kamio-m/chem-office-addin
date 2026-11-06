/** 在线化合物联想：走后端 /api/chem/suggest（本地代理 PubChem，绕过 CORS） */

import type { Suggestion } from "./suggest";

interface RemoteItem {
  formula: string;
  name: string;
}

export type OnlineState = "idle" | "loading" | "ok" | "off";

export async function fetchOnlineSuggestions(
  token: string,
  signal: AbortSignal
): Promise<Suggestion[]> {
  const resp = await fetch(`/api/chem/suggest?q=${encodeURIComponent(token)}`, { signal });
  if (!resp.ok) throw new Error("HTTP " + resp.status);

  const data = (await resp.json()) as { ok: boolean; items?: RemoteItem[]; error?: string };
  if (!data.ok) throw new Error(data.error || "online failed");

  return (data.items || [])
    .filter((it) => it.formula)
    .map<Suggestion>((it) => ({
      text: it.formula,
      label: it.formula,
      hint: it.name || undefined,
      kind: "online",
    }));
}
