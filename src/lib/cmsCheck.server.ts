import type { SupabaseClient } from "@supabase/supabase-js";
import sources from "../../data/sources.json";
import { WATCHED, newestLink, compareRelease, sha256Hex, hasConfirmedPartB, type Watched } from "./cmsImport";
import bundledFigures from "./medicare-figures.json";
import type { FiguresPayload } from "./plans";

export type CheckResult = { key: string; ok: boolean; updateAvailable: boolean; compared: boolean; note: string };
const UA = { "user-agent": "Mozilla/5.0 PlainPlanGuide update check" };
const MAX_BYTES = 60_000_000;

/** File link of the version serving the site: published version if live, else the built-in file. */
function baselineFor(key: string, liveUrl: string | null): string | null {
  if (key === "stars" && liveUrl?.startsWith("https://www.cms.gov")) return new URL(liveUrl).pathname;
  const s = sources.datasets.find((d) => d.key === key) as { cmsLink?: string; released?: string | null } | undefined;
  return key === "hospitals" ? (s?.released ?? null) : (s?.cmsLink ?? null);
}

async function checksumOf(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok || !res.body) throw new Error(`file download returned ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) { await res.body.cancel(); return null; }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > MAX_BYTES ? null : sha256Hex(buf);
}

async function checkOne(w: Watched, coverageYear: number, full: boolean, prev: { found_checksum: string | null; update_available: boolean } | null, liveUrl: string | null, servingFigures: FiguresPayload) {
  if (w.kind === "announcement") {
    const res = await fetch(w.page, { headers: UA, redirect: "follow" });
    if (res.status === 404) return { found: null, file: null, url: null, checksum: null, update: false, compared: false, note: `CMS has not posted ${coverageYear} Part B amounts yet. Estimates keep the 2026 amounts, labeled.` };
    if (!res.ok) throw new Error(`CMS page returned ${res.status}`);
    const confirmed = hasConfirmedPartB(servingFigures, coverageYear);
    return { found: "announced", file: null, url: w.page, checksum: null, update: !confirmed, compared: false, note: confirmed ? `The website uses confirmed ${coverageYear} Part B premium and deductible amounts. Announcement availability checked only; amounts not compared.` : `CMS posted the ${coverageYear} Part B amounts. Enter and confirm them under Yearly Medicare figures.` };
  }
  if (w.kind === "metastore") {
    // CMS's data catalog rejects the custom site User-Agent with HTTP 403.
    const res = await fetch(w.api);
    if (!res.ok) throw new Error(`CMS data catalog returned ${res.status}`);
    const meta = (await res.json()) as { released?: string; modified?: string; distribution?: { downloadURL?: string }[] };
    const found = (meta.released ?? meta.modified)?.slice(0, 10) ?? null;
    if (!found) throw new Error("CMS data catalog gave no release date");
    const url = meta.distribution?.[0]?.downloadURL ?? null;
    const base = baselineFor(w.key, liveUrl);
    const checksum = url && (full || found !== base) ? await checksumOf(url) : null;
    const r = compareRelease(found, base, { checksum: prev?.found_checksum ?? null }, checksum);
    return { found, file: url?.split("/").pop() ?? null, url, checksum: checksum ?? prev?.found_checksum ?? null, ...r, note: r.update ? `CMS released ${found}; site uses ${base}.` : `CMS release ${found} matches the list in use.` };
  }
  const res = await fetch(w.page, { headers: UA });
  if (!res.ok) throw new Error(`CMS page returned ${res.status}`);
  const link = newestLink(await res.text(), new RegExp(w.pattern.source, "gi"), coverageYear);
  if (!link) throw new Error(`no ${coverageYear} file found on the CMS page`);
  const url = new URL(link.startsWith("/") ? link : `/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/${link}`, "https://www.cms.gov").toString();
  const base = baselineFor(w.key, liveUrl);
  const fileUrl = url.endsWith(".zip") ? url : null;
  const checksum = fileUrl && (full || link !== base) ? await checksumOf(fileUrl) : null;
  const r = compareRelease(link, base, { checksum: prev?.found_checksum ?? null }, checksum);
  return { found: link, file: link.split("/").pop() ?? link, url, checksum: checksum ?? prev?.found_checksum ?? null, ...r, note: r.update ? "Newer CMS file found — review before using." : "Same file as the one in use." };
}

/** Runs only when the owner presses "Check CMS now". One request per distinct source; flags only, never publishes. */
export async function runCmsCheck(db: SupabaseClient, coverageYear: number, full = false): Promise<CheckResult[]> {
  const [{ data: prevRows }, { data: live }] = await Promise.all([
    db.from("dataset_checks").select("dataset_key,found_checksum,update_available"),
    db.from("dataset_versions").select("dataset_key,source_url,payload").eq("status", "live"),
  ]);
  const servingFigures = ((live ?? []).find((r) => r.dataset_key === "figures")?.payload ?? bundledFigures) as FiguresPayload;
  const out: CheckResult[] = [];
  for (const w of WATCHED) {
    const prev = (prevRows ?? []).find((r: any) => r.dataset_key === w.key) ?? null;
    const liveUrl = (live ?? []).find((r: any) => r.dataset_key === w.key)?.source_url ?? null;
    const now = new Date().toISOString();
    try {
      const r = await checkOne(w, coverageYear, full, prev, liveUrl, servingFigures);
      await db.from("dataset_checks").upsert({ dataset_key: w.key, last_checked_at: now, last_success_at: now, last_error: null, found_url: r.url, found_release: r.found, found_file: r.file, found_checksum: r.checksum, update_available: r.update, contents_compared: r.compared, note: r.note });
      out.push({ key: w.key, ok: true, updateAvailable: r.update, compared: r.compared, note: r.note });
    } catch (e) {
      const msg = (e as Error).message;
      // Keep any known unpublished update and the last success visible.
      await db.from("dataset_checks").upsert({ dataset_key: w.key, last_checked_at: now, last_error: msg, update_available: prev?.update_available ?? false, contents_compared: false });
      out.push({ key: w.key, ok: false, updateAvailable: prev?.update_available ?? false, compared: false, note: `Check failed: ${msg}` });
    }
  }
  return out;
}
