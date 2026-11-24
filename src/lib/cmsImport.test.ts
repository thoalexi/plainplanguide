import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseStarsCsv, validateStars, validateFigures, newestLink, MI_CONTRACTS, sha256Hex } from "./cmsImport";
import stars from "./cms2027-stars.json";
import figures from "./medicare-figures.json";
import { PLANS, estimateAnnual, applyLiveData, PART_D_OOP_CAP, FIGURES, type StarsPayload, type FiguresPayload } from "./plans";

const hdr = "Title row\nContract Number,Org,2027 Part C Summary,2027 Part D Summary,2027 Overall\n";
const rows = Array.from({ length: 120 }, (_, i) => `H${String(1000 + i)},X,4,3.5,4.5`).join("\n");

describe("star import", () => {
  it("parses ratings by contract and keeps unavailable as unavailable", () => {
    const p = parseStarsCsv(hdr + rows + "\nH9999,X,Plan too new to be measured,Plan too new to be measured,Plan too new to be measured\n");
    expect(p.year).toBe(2027);
    expect(p.ratings['H1000']).toEqual({ stars: 4.5, category: "overall" });
    expect(p.unavailable['H9999']).toBe("Plan too new to be measured");
    expect(p.ratings['H9999']).toBeUndefined();
  });
  it("rejects malformed files", () => {
    expect(() => parseStarsCsv("a,b\n1,2")).toThrow();
    expect(() => parseStarsCsv(hdr + rows + "\nH1000,X,4,4,4")).toThrow(/twice/);
    expect(() => parseStarsCsv(hdr + "H0001,X,4,4,9\n" + rows)).toThrow(/range/);
    expect(() => parseStarsCsv(hdr + "H0001,X,4,4,4")).toThrow(/incomplete/);
  });
  it("unchanged import reports no changes and same checksum", async () => {
    const r = validateStars(stars as StarsPayload, stars as StarsPayload, 2027);
    expect(r.ok).toBe(true); expect(r.changes).toEqual([]);
    expect(await sha256Hex("x")).toBe(await sha256Hex("x"));
  });
  it("wrong year fails validation", () => {
    expect(validateStars({ ...(stars as StarsPayload), year: 2026 }, stars as StarsPayload, 2027).ok).toBe(false);
  });
  it("matches the real 2027 CMS file when available", () => {
    const f = "/tmp/cms/stars2027/2027 Star Ratings Data Table - Summary Ratings (Oct 8 2026).csv";
    if (!existsSync(f)) return;
    const p = parseStarsCsv(readFileSync(f, "latin1"));
    expect(p.ratings).toEqual(stars.ratings);
    expect(p.unavailable).toEqual(stars.unavailable);
    expect(MI_CONTRACTS.every((c) => p.ratings[c] || p.unavailable[c])).toBe(true);
  });
});

describe("figures", () => {
  it("2027 Part D cap and deductible are confirmed CMS values", () => {
    expect(PART_D_OOP_CAP).toBe(2400);
    expect(FIGURES.partDStandardDeductible.value).toBe(700);
    expect(FIGURES.partBMonthly).toMatchObject({ value: 209.4, year: 2027, confirmed: true });
  });
  it("rejects non-CMS sources and mismatched confirmed years", () => {
    const bad = JSON.parse(JSON.stringify(figures)) as FiguresPayload;
    bad.figures.partBMonthly.source = "https://example.com"; bad.figures.partBMonthly.confirmed = true; bad.figures.partBMonthly.year = 2026;
    const r = validateFigures(bad, figures as FiguresPayload);
    expect(r.ok).toBe(false); expect(r.errors.length).toBe(2);
  });
  it("plans keep their own drug deductible", () => {
    const ded = new Set(PLANS.filter((p) => p.real && p.drugCoverage).map((p) => p.rxDeductible));
    expect(ded.size).toBeGreaterThan(3);
  });
});

describe("calculations and publish/rollback", () => {
  const plan = PLANS.find((p) => p.real && p.drugCoverage)!;
  it("worst case = premiums + Part B + medical max + Part D cap", () => {
    const e = estimateAnnual(plan, "some", 0);
    expect(e.worstCase).toBe((plan.monthlyPremium + FIGURES.partBMonthly.value) * 12 + plan.drugPremium * 12 + plan.oopMax! + 2400);
  });
  it("applies a published version and restores the built-in one", () => {
    const f = JSON.parse(JSON.stringify(figures)) as FiguresPayload; f.figures.partDOopCap.value = 2500;
    applyLiveData({ figures: f, publishedAt: { figures: "t1" } });
    expect(estimateAnnual(plan, "some", 0).worstCase).toBe((plan.monthlyPremium + FIGURES.partBMonthly.value) * 12 + plan.drugPremium * 12 + plan.oopMax! + 2500);
    applyLiveData(null);
    expect(FIGURES.partDOopCap.value).toBe(2400);
  });
  it("new contracts show no rating", () => {
    const c = Object.keys(stars.unavailable).find((k) => MI_CONTRACTS.includes(k));
    const p = PLANS.find((x) => x.id.startsWith(c + "_"));
    if (p) { expect(p.starRating).toBe(0); expect(p.starYear).toBeNull(); }
  });
});

describe("update check", () => {
  it("picks the newest current-year link deterministically", () => {
    const html = '"/files/zip/cy2026-landscape-202609.zip" "/files/zip/cy2027-landscape-202609-1.zip" "/files/zip/cy2027-landscape-202611.zip"';
    expect(newestLink(html, /\/files\/zip\/cy(\d{4})-landscape-[\w-]+\.zip/gi, 2027)).toBe("/files/zip/cy2027-landscape-202611.zip");
    expect(newestLink("nothing", /x(\d{4})/gi, 2027)).toBeNull();
  });
});
