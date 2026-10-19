import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { deriveStatus, compareRelease, STATUS_TEXT, WATCHED, hasConfirmedPartB, reconcilePartBCheck } from "./cmsImport";
import { runCmsCheck } from "./cmsCheck.server";
import { formularyYear } from "./formularyYear";
import { FIGURES, applyLiveData, partBFallbackLabel, PLANS, estimateAnnual, type FiguresPayload } from "./plans";
import figures from "./medicare-figures.json";

const ok = { last_checked_at: "2026-10-15", last_success_at: "2026-10-15", last_error: null, update_available: false, contents_compared: false };

describe("Part B published figures freshness", () => {
  const confirmed = structuredClone(figures) as FiguresPayload;
  confirmed.figures.partBMonthly = { ...confirmed.figures.partBMonthly, year: 2027, confirmed: true };
  confirmed.figures.partBDeductible = { ...confirmed.figures.partBDeductible, year: 2027, confirmed: true };
  it("requires both 2027 amounts, not a partial or wrong-year confirmation", () => {
    expect(hasConfirmedPartB(confirmed, 2027)).toBe(true);
    expect(hasConfirmedPartB(confirmed, 2026)).toBe(false);
    const partial = structuredClone(confirmed);
    partial.figures.partBDeductible.confirmed = false;
    expect(hasConfirmedPartB(partial, 2027)).toBe(false);
  });
  it("clears the announcement notice after publishing and restores it with fallback figures", () => {
    const check = { ...ok, dataset_key: "partb", found_release: "announced", update_available: true };
    const published = reconcilePartBCheck(check, confirmed);
    expect(published.update_available).toBe(false);
    expect(deriveStatus(published)).toBe("no-newer-metadata");
    expect(reconcilePartBCheck(published, figures).update_available).toBe(true);
    expect(reconcilePartBCheck({ ...check, dataset_key: "stars" }, confirmed).update_available).toBe(true);
  });
  it("a new check uses live figures instead of bundled 2026 values", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = { from: (table: string) => ({
      select: () => table === "dataset_versions" ? { eq: async () => ({ data: [{ dataset_key: "figures", source_url: null, payload: confirmed }] }) } : Promise.resolve({ data: [] }),
      upsert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
    }) };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("", { status: url.includes("2027-medicare-parts-b") ? 200 : 500 })));
    try {
      await runCmsCheck(db as unknown as Parameters<typeof runCmsCheck>[0], 2027);
      expect(rows.find((r) => r.dataset_key === "partb")).toMatchObject({ update_available: false, contents_compared: false, found_release: "announced" });
      rows.length = 0;
      const fallbackDb = { from: (table: string) => ({
        select: () => table === "dataset_versions" ? { eq: async () => ({ data: [] }) } : Promise.resolve({ data: [] }),
        upsert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
      }) };
      await runCmsCheck(fallbackDb as unknown as Parameters<typeof runCmsCheck>[0], 2027);
      expect(rows.find((r) => r.dataset_key === "partb")?.update_available).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("freshness status", () => {
  it("failed check is never green", () => {
    expect(deriveStatus({ ...ok, last_error: "CMS page returned 500" })).toBe("failed");
  });
  it("metadata-only says so and never 'verified current'", () => {
    expect(STATUS_TEXT[deriveStatus(ok)]).toBe("No newer release found — metadata only");
    expect(Object.values(STATUS_TEXT).join(" ")).not.toMatch(/verified current/i);
  });
  it("known unpublished update stays visible even after a failed re-check", () => {
    expect(deriveStatus({ ...ok, update_available: true, last_error: "timeout" })).toBe("update");
  });
  it("same file name with changed contents is an update", () => {
    expect(compareRelease("a.zip", "a.zip", { checksum: "111" }, "222")).toEqual({ update: true, compared: true });
    expect(compareRelease("a.zip", "a.zip", { checksum: "111" }, "111")).toEqual({ update: false, compared: true });
    expect(compareRelease("a.zip", "a.zip", { checksum: null }, null).compared).toBe(false);
  });
  it("newer release than the version serving the site is an update", () => {
    expect(compareRelease("b.zip", "a.zip").update).toBe(true);
  });
  it("benefits and service-level data share one check", () => {
    const pbp = WATCHED.filter((w) => w.covers.includes("services") || w.covers.includes("pbp"));
    expect(pbp).toHaveLength(1);
    expect(new Set(WATCHED.map((w) => w.key)).size).toBe(WATCHED.length);
  });
  it("no scheduled check route remains", () => {
    expect(() => readFileSync("src/routes/api/public/cms-check.ts")).toThrow();
  });
});

describe("drug list coverage year", () => {
  it("accepts only a single stated 2027", () => {
    expect(formularyYear("https://x.com/2027-formulary.pdf")).toBe(2027);
    expect(formularyYear("https://x.com/formulary.pdf", "2026 Drug List")).toBe(2026);
    expect(formularyYear("https://x.com/formulary.pdf", "Drug List")).toBeNull();
    expect(formularyYear("https://x.com/2026-2027.pdf")).toBeNull();
  });
});

describe("publish requires exact-version validation", () => {
  const sql = readFileSync("drizzle/migrations/0004_cms_freshness_status.sql", "utf8");
  it("checks staged status and the validated checksum of the same row", () => {
    expect(sql).toMatch(/st <> 'staged'/);
    expect(sql).toMatch(/vsha IS NULL OR vsha <> sha/);
  });
});

describe("Part B 2026 fallback", () => {
  it("labels estimates while unconfirmed, and math + label switch together", () => {
    const plan = PLANS.find((p) => p.real)!;
    expect(FIGURES.partBMonthly.year).toBe(2026);
    expect(partBFallbackLabel()).toMatch(/2026 Part B/);
    const before = estimateAnnual(plan, "some", 0).total;
    const next = JSON.parse(JSON.stringify(figures)) as FiguresPayload;
    next.figures.partBMonthly = { ...next.figures.partBMonthly, value: 300, year: 2027, confirmed: true };
    applyLiveData({ figures: next, publishedAt: {} });
    expect(partBFallbackLabel()).toBeNull();
    expect(estimateAnnual(plan, "some", 0).total).toBeCloseTo(before + (300 - 202.9) * 12, 0);
  });
});
