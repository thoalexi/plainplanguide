import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import stars2027 from "./cms2027-stars.json";
import figures from "./medicare-figures.json";
import { parseStarsCsv, validateStars, validateFigures, sha256Hex, reconcilePartBCheck } from "./cmsImport";
import type { FiguresPayload, LiveData, StarsPayload } from "./plans";

/** Public: only live, owner-published payloads. Falls back to built-in data on any error. */
export const getLiveData = createServerFn({ method: "GET" }).handler(async (): Promise<LiveData | null> => {
  try {
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    const db = createClient<Database>(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      } },
    });
    const { data, error } = await db.rpc("get_live_datasets");
    if (error || !data?.length) return null;
    const live: LiveData = { publishedAt: {} };
    for (const r of data) {
      live.publishedAt![r.dataset_key] = r.published_at;
      if (r.dataset_key === "stars") live.stars = r.payload as unknown as StarsPayload;
      if (r.dataset_key === "figures") live.figures = r.payload as unknown as FiguresPayload;
    }
    return live;
  } catch { return null; }
});

const owner = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]);
async function assertOwner(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "owner" });
  if (!data) throw new Error("This screen is only for the site owner.");
}

export const getUpdateStatus = owner.handler(async ({ context }) => {
  const { data: isOwner } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "owner" });
  if (!isOwner) return { isOwner: false as const };
  const [checks, versions, liveFigures] = await Promise.all([
    context.supabase.from("dataset_checks").select("*"),
    context.supabase.from("dataset_versions").select("id,dataset_key,coverage_year,status,source_url,source_published,sha256,report,imported_at,published_at").order("imported_at", { ascending: false }).limit(50),
    currentLive(context, "figures"),
  ]);
  const servingFigures = (liveFigures ?? figures) as FiguresPayload;
  return { isOwner: true as const, checks: (checks.data ?? []).map((c) => reconcilePartBCheck(c, servingFigures)), versions: versions.data ?? [], builtInFigures: figures as FiguresPayload, servingFigures };
});

export const checkForUpdates = owner.inputValidator((d: { full?: boolean } | undefined) => ({ full: d?.full === true })).handler(async ({ data, context }) => {
  await assertOwner(context);
  const { runCmsCheck } = await import("./cmsCheck.server");
  return runCmsCheck(context.supabase as any, figures.coverageYear, data.full);
});

async function currentLive(ctx: { supabase: any }, key: string) {
  const { data } = await ctx.supabase.from("dataset_versions").select("payload").eq("dataset_key", key).eq("status", "live").maybeSingle();
  return data?.payload ?? null;
}

async function stage(ctx: { supabase: any }, row: { dataset_key: "stars" | "figures"; coverage_year: number; source_url: string | null; source_published: string | null; sha256: string; payload: unknown; report: unknown }) {
  const { data: existing } = await ctx.supabase.from("dataset_versions").select("id,status").eq("dataset_key", row.dataset_key).eq("sha256", row.sha256).maybeSingle();
  if (existing) return { id: existing.id as string, duplicate: true, status: existing.status as string };
  // The validation result names the exact version it tested; publish refuses any mismatch.
  row = { ...row, report: { ...(row.report as object), validatedSha256: row.sha256 } };
  const { data, error } = await ctx.supabase.from("dataset_versions").insert({ ...row, status: (row.report as { ok: boolean }).ok ? "staged" : "rejected" }).select("id,status").single();
  if (error) throw new Error("Could not save the preview. Nothing live was changed.");
  return { id: data.id as string, duplicate: false, status: data.status as string };
}

/** Stage star ratings from a CMS ZIP URL (cms.gov only) or uploaded Summary Ratings CSV text. */
export const stageStars = owner
  .inputValidator((d: { url?: string | undefined; csv?: string | undefined; released?: string | undefined }) => {
    if (d.url && !/^https:\/\/www\.cms\.gov\/files\/zip\/[\w.-]+\.zip$/.test(d.url)) throw new Error("Use an official cms.gov ZIP link.");
    if (!d.url && !d.csv) throw new Error("Give a CMS link or upload the Summary Ratings file.");
    if (d.csv && d.csv.length > 5_000_000) throw new Error("File too large.");
    if (d.released && !/^\d{4}-\d{2}-\d{2}$/.test(d.released)) throw new Error("Release date must be YYYY-MM-DD.");
    return d;
  })
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    let csv = data.csv ?? "";
    let checksumSource: string | Uint8Array = csv;
    if (data.url) {
      const res = await fetch(data.url, { headers: { "user-agent": "Mozilla/5.0 PlainPlanGuide" } });
      if (!res.ok) throw new Error(`CMS download failed (${res.status}). Download the ZIP yourself and upload the Summary Ratings CSV.`);
      const buf = new Uint8Array(await res.arrayBuffer());
      checksumSource = buf;
      const { unzipSync, strFromU8 } = await import("fflate");
      const files = unzipSync(buf, { filter: (f) => /Summary Ratings.*\.csv$/i.test(f.name) });
      const name = Object.keys(files)[0];
      if (!name) throw new Error("The ZIP has no Summary Ratings CSV.");
      csv = strFromU8(files[name]!, true);
    }
    let payload: StarsPayload;
    try { payload = parseStarsCsv(csv); } catch (e) { return { ok: false as const, error: (e as Error).message }; }
    const current = ((await currentLive(context, "stars")) ?? stars2027) as StarsPayload;
    const report = validateStars(payload, current, figures.coverageYear);
    const sha = await sha256Hex(checksumSource);
    const r = await stage(context, { dataset_key: "stars", coverage_year: payload.year, source_url: data.url ?? "Uploaded file", source_published: data.released ?? null, sha256: sha, payload: { ...payload, sha256: sha }, report });
    return { ok: true as const, ...r, report };
  });

/** Stage Medicare yearly figures typed by the owner from a CMS source. Never auto-confirmed. */
export const stageFigures = owner
  .inputValidator((d: FiguresPayload) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context);
    const current = ((await currentLive(context, "figures")) ?? figures) as FiguresPayload;
    const payload: FiguresPayload = { coverageYear: data.coverageYear, figures: data.figures };
    const report = validateFigures(payload, current);
    const sha = await sha256Hex(JSON.stringify(payload));
    const r = await stage(context, { dataset_key: "figures", coverage_year: payload.coverageYear, source_url: null, source_published: null, sha256: sha, payload, report });
    return { ok: true as const, ...r, report };
  });

export const publishVersion = owner.inputValidator((d: { id: string }) => d).handler(async ({ data, context }) => {
  await assertOwner(context);
  const { error } = await context.supabase.rpc("publish_dataset_version", { _id: data.id });
  if (error) throw new Error(error.message);
  return { ok: true };
});

export const restorePrevious = owner.inputValidator((d: { key: "stars" | "figures" }) => d).handler(async ({ data, context }) => {
  await assertOwner(context);
  const { error } = await context.supabase.rpc("restore_previous_version", { _key: data.key });
  if (error) throw new Error(error.message);
  return { ok: true };
});
