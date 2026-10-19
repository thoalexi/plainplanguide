import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { supabase } from "@/integrations/supabase/client";
import { checkForUpdates, getUpdateStatus, publishVersion, restorePrevious, stageFigures, stageStars } from "@/lib/cmsUpdates.functions";
import type { FigureKey, FiguresPayload } from "@/lib/plans";
import sources from "../../../data/sources.json";
import { WATCHED, STATUS_TEXT, deriveStatus, hasConfirmedPartB } from "@/lib/cmsImport";

export const Route = createFileRoute("/_authenticated/admin/cms-updates")({
  head: () => ({
    meta: [
      { title: "CMS Updates — PlainPlanGuide" },
      { name: "description", content: "Private owner screen for reviewing CMS data updates." },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:title", content: "CMS Updates — PlainPlanGuide" },
      { property: "og:description", content: "Private owner screen." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CmsUpdates,
});

type Report = { ok: boolean; errors: string[]; warnings: string[]; changes: string[]; summary: Record<string, number> };
const btn = "inline-flex min-h-12 items-center rounded-md px-4 font-bold";
const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : "Never");

function ReportView({ r }: { r: Report }) {
  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3 text-sm">
      <p className={r.ok ? "font-bold text-success" : "font-bold text-destructive"}>{r.ok ? "Passed all checks" : "Failed checks — cannot be published"}</p>
      <p className="mt-1 text-muted-foreground">{Object.entries(r.summary).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
      {r.errors.map((e) => <p key={e} className="text-destructive">✕ {e}</p>)}
      {r.warnings.map((e) => <p key={e} className="text-warning">! {e}</p>)}
      {r.changes.length ? <details className="mt-2"><summary className="cursor-pointer font-bold">{r.changes.length} changed figure(s)</summary><ul className="mt-1 list-disc pl-5">{r.changes.map((c) => <li key={c}>{c}</li>)}</ul></details> : <p className="mt-1">No changes compared with what's live now.</p>}
    </div>
  );
}

function CmsUpdates() {
  const qc = useQueryClient();
  const status = useServerFn(getUpdateStatus), check = useServerFn(checkForUpdates), sStars = useServerFn(stageStars),
    sFig = useServerFn(stageFigures), publish = useServerFn(publishVersion), restore = useServerFn(restorePrevious);
  const q = useQuery({ queryKey: ["cms-status"], queryFn: () => status() });
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ id?: string; report: Report; duplicate?: boolean; error?: string } | null>(null);
  const [starUrl, setStarUrl] = useState(""); const [released, setReleased] = useState("");
  const [fig, setFig] = useState<FiguresPayload | null>(null);
  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg("");
    try { await f(); setMsg(done); } catch (e) { setMsg((e as Error).message); }
    setBusy(false); qc.invalidateQueries({ queryKey: ["cms-status"] }); qc.invalidateQueries({ queryKey: ["live-cms-data"] });
  };
  const d = q.data;
  if (q.isLoading) return <Shell><p>Loading…</p></Shell>;
  if (!d?.isOwner) return <Shell><p>This screen is only for the site owner.</p><button className={`${btn} mt-4 border border-border`} onClick={() => supabase.auth.signOut().then(() => location.assign("/"))}>Sign out</button></Shell>;
  const figs = fig ?? d.servingFigures;
  const liveOf = (k: string) => d.versions.find((v) => v.dataset_key === k && v.status === "live");
  const checkOf = (k: string) => d.checks.find((c) => c.dataset_key === k);

  return (
    <Shell>
      <p className="text-muted-foreground">Nothing here changes the public site until you press <strong>Publish</strong>. Failed previews never replace live data.</p>
      {msg && <p role="status" className="mt-4 rounded-md bg-card p-3 font-bold">{msg}</p>}

      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-bold">1. Check for updates</h2>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} className={`${btn} bg-primary text-primary-foreground`} onClick={() => run(() => check({ data: {} }), "Check finished.")}>Check CMS now</button>
            <button disabled={busy} className={`${btn} border border-border bg-card`} onClick={() => run(() => check({ data: { full: true } }), "Full comparison finished.")}>Full comparison</button>
          </div></div>
        <p className="mt-1 text-sm text-muted-foreground">Runs only when you press a button. "Check CMS now" reads release dates and file names; it downloads a file only when a change is suggested. "Full comparison" also downloads files to compare their contents. Checks only flag — they never publish.</p>
        {(() => {
          const rows = [...WATCHED.map((w) => ({ key: w.key, st: deriveStatus(checkOf(w.key)) })), { key: "formulary", st: deriveStatus(null, true) }];
          const counts = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [STATUS_TEXT[r.st]]: (a[STATUS_TEXT[r.st]] ?? 0) + 1 }), {});
          return <p className="mt-3 rounded-md bg-card p-3 font-bold">{rows.length} distinct sources: {Object.entries(counts).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(" · ")}</p>;
        })()}
        <div className="mt-3 space-y-3">
          {WATCHED.map((w) => {
            const c = checkOf(w.key); const st = deriveStatus(c);
            const used = w.covers.map((k) => sources.datasets.find((s) => s.key === k)).filter(Boolean) as typeof sources.datasets;
            const live = w.covers.map((k) => liveOf(k)).find(Boolean);
            const tone = st === "update" || st === "failed" ? "text-destructive" : st === "never" ? "text-warning" : "text-foreground";
            return (
              <div key={w.key} className="rounded-md border border-border bg-card p-3 text-sm">
                <p className="font-bold">{w.key === "partb" ? "Part B 2027 premium and deductible announcement" : used.map((s) => s.label).join(" + ")}</p>
                <p className={`font-bold ${tone}`}>{STATUS_TEXT[st]}</p>
                <p>Last successful check: {when(c?.last_success_at)}</p>
                {c?.last_error && <p className="text-destructive">Last check failed {when(c.last_checked_at)}: {c.last_error}</p>}
                <p>Newest release found at CMS: {c?.found_release ? <>{c.found_file ?? c.found_release}{c.found_url && <> — <a className="text-primary underline" href={c.found_url} target="_blank" rel="noreferrer">CMS link</a></>}</> : "—"}</p>
                <p>Serving the website: {w.key === "partb" ? (hasConfirmedPartB(d.servingFigures, d.servingFigures.coverageYear) ? "2027 amounts" : `Premium: ${d.servingFigures.figures.partBMonthly.year}; deductible: ${d.servingFigures.figures.partBDeductible.year} (2027 amounts not both confirmed)`) : live ? `published version from ${when(live.published_at)}` : used.map((s) => `built-in ${s.file} (CMS release ${s.released ?? "not stated"})`).join("; ")}</p>
                {c && !c.contents_compared && c.last_success_at && <p className="text-muted-foreground">File contents not compared.</p>}
                {c?.note && <p className="text-muted-foreground">{w.key === "partb" && c.found_release === "announced" && hasConfirmedPartB(d.servingFigures, d.servingFigures.coverageYear) ? "The website uses confirmed 2027 Part B amounts. Announcement availability checked only; amounts not compared." : c.note}</p>}
              </div>
            );
          })}
          <div className="rounded-md border border-border bg-card p-3 text-sm">
            <p className="font-bold">Drug lists (formularies)</p>
            <p className="font-bold">{STATUS_TEXT.manual}</p>
            <p className="text-muted-foreground">Looked up per plan when a visitor uses Check my drugs. A saved document is reused for 30 days, and only if its title or address states 2027; otherwise visitors see "couldn't confirm" with the insurer link and upload option.</p>
          </div>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold">2. Preview changes</h2>
        <h3 className="mt-4 text-xl font-bold">Star ratings</h3>
        <p className="text-sm text-muted-foreground">Paste the CMS "Star Ratings Data Tables" ZIP link, or upload the "Summary Ratings" CSV from inside it. Ratings are matched by contract number only.</p>
        <label className="mt-2 block"><span className="font-bold">CMS ZIP link</span>
          <input value={starUrl} onChange={(e) => setStarUrl(e.target.value)} placeholder="https://www.cms.gov/files/zip/…star-ratings-data-tables….zip" className="mt-1 h-12 w-full rounded-md border border-input bg-card px-3 text-base" /></label>
        <label className="mt-2 block"><span className="font-bold">CMS release date (optional)</span>
          <input type="date" value={released} onChange={(e) => setReleased(e.target.value)} className="mt-1 h-12 rounded-md border border-input bg-card px-3 text-base" /></label>
        <div className="mt-3 flex flex-wrap gap-3">
          <button disabled={busy || !starUrl} className={`${btn} bg-primary text-primary-foreground`} onClick={() => run(async () => { const r = await sStars({ data: { url: starUrl, released: released || undefined } }); setLast(r.ok ? r : { report: { ok: false, errors: [r.error], warnings: [], changes: [], summary: {} } }); }, "Preview ready.")}>Download and preview</button>
          <label className={`${btn} cursor-pointer border border-border bg-card`}>Upload CSV instead
            <input type="file" accept=".csv" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const csv = await f.text(); run(async () => { const r = await sStars({ data: { csv, released: released || undefined } }); setLast(r.ok ? r : { report: { ok: false, errors: [r.error], warnings: [], changes: [], summary: {} } }); }, "Preview ready."); }} /></label>
        </div>

        <h3 className="mt-8 text-xl font-bold">Yearly Medicare figures</h3>
        <p className="text-sm text-muted-foreground">Type only amounts CMS has officially announced, with the cms.gov link. Leave "Confirmed" off for last-year figures — the site will label them with their year.</p>
        <div className="mt-2 space-y-3">
          {(Object.keys(figs.figures) as FigureKey[]).map((k) => {
            const f = figs.figures[k];
            const set = (patch: Partial<typeof f>) => setFig({ ...figs, figures: { ...figs.figures, [k]: { ...f, ...patch } } });
            return (
              <fieldset key={k} className="rounded-md border border-border bg-card p-3">
                <legend className="px-1 font-bold">{f.label}</legend>
                <div className="grid gap-2 sm:grid-cols-[8rem_6rem_1fr]">
                  <label className="text-sm">Amount ($)<input type="number" step="0.01" value={f.value} onChange={(e) => set({ value: Number(e.target.value) })} className="mt-1 h-12 w-full rounded-md border border-input bg-background px-2 text-base" /></label>
                  <label className="text-sm">Year<input type="number" value={f.year} onChange={(e) => set({ year: Number(e.target.value) })} className="mt-1 h-12 w-full rounded-md border border-input bg-background px-2 text-base" /></label>
                  <label className="text-sm">CMS source link<input value={f.source} onChange={(e) => set({ source: e.target.value })} className="mt-1 h-12 w-full rounded-md border border-input bg-background px-2 text-base" /></label>
                </div>
                <label className="mt-2 flex min-h-12 items-center gap-2"><input type="checkbox" className="size-6" checked={f.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} /> Confirmed by CMS for {figs.coverageYear}</label>
              </fieldset>
            );
          })}
        </div>
        <button disabled={busy} className={`${btn} mt-3 bg-primary text-primary-foreground`} onClick={() => run(async () => setLast(await sFig({ data: figs })), "Preview ready.")}>Preview figure changes</button>

        {last && <div className="mt-6"><h3 className="text-lg font-bold">Preview result{last.duplicate ? " (this exact file was already imported — no duplicate created)" : ""}</h3><ReportView r={last.report} /></div>}
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-bold">3. Publish checked update · 4. Restore previous version</h2>
        {(["stars", "figures"] as const).map((k) => (
          <div key={k} className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xl font-bold">{k === "stars" ? "Star ratings" : "Yearly figures"}</h3>
              <button disabled={busy || !liveOf(k)} className={`${btn} border border-border bg-card`} onClick={() => confirm("Go back to the previous published version?") && run(() => restore({ data: { key: k } }), "Restored previous version.")}>Restore previous version</button></div>
            {!liveOf(k) && <p className="text-sm text-muted-foreground">Using the built-in data file.</p>}
            <ul className="mt-2 space-y-2">
              {d.versions.filter((v) => v.dataset_key === k).map((v) => (
                <li key={v.id} className="rounded-md border border-border bg-card p-3 text-sm">
                  <p className="font-bold">{v.coverage_year} · {v.status === "live" ? "LIVE" : v.status} · imported {when(v.imported_at)}{v.published_at ? ` · published ${when(v.published_at)}` : ""}</p>
                  <p className="break-all text-muted-foreground">Source: {v.source_url ?? "Typed from CMS"}{v.source_published ? ` (CMS release ${v.source_published})` : ""} · checksum {v.sha256.slice(0, 12)}…</p>
                  <ReportView r={v.report as unknown as Report} />
                  {v.status === "staged" && (v.report as { validatedSha256?: string })?.validatedSha256 !== v.sha256 && <p className="mt-2 text-destructive">This check result does not match this exact file. Preview it again before publishing.</p>}
                  {v.status === "staged" && (v.report as { validatedSha256?: string })?.validatedSha256 === v.sha256 && <button disabled={busy} className={`${btn} mt-2 bg-success text-primary-foreground`} onClick={() => confirm("Publish this to the public site?") && run(() => publish({ data: { id: v.id } }), "Published. The site now uses this version.")}>Publish checked update</button>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-10"><h1 className="mb-2 text-3xl font-bold">CMS Updates</h1>{children}</main>
    </div>
  );
}
