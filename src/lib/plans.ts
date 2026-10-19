import cms from "./cms2027-mi.json";
import extrasData from "./cms2027-mi-extras.json";
import zipCounty from "./mi-zip-county.json";
import stars2026 from "./cms2026-stars.json";
import stars2027 from "./cms2027-stars.json";
import figures from "./medicare-figures.json";
const STARS_2026 = stars2026 as Record<string, number>;
export type StarsPayload = { year: number; ratings: Record<string, { stars: number; category?: string }>; unavailable: Record<string, string> };
let S27 = stars2027 as StarsPayload;
/** CMS rating by contract ID from the current star file; 2026 only for contracts CMS left out of it entirely. */
function starFor(contract: string): { stars: number; year: number | null } {
  const r = S27.ratings[contract];
  if (r) return { stars: r.stars, year: S27.year };
  if (S27.unavailable[contract]) return { stars: 0, year: null };
  const old = STARS_2026[contract];
  return old ? { stars: old, year: 2026 } : { stars: 0, year: null };
}
export type Figure = { value: number; year: number; confirmed: boolean; source: string; label: string };
export type FigureKey = "partDOopCap" | "partDStandardDeductible" | "partBMonthly" | "partBDeductible";
export type FiguresPayload = { coverageYear: number; figures: Record<FigureKey, Figure> };
let FIG_YEAR = figures.coverageYear;
export const FIGURES = JSON.parse(JSON.stringify(figures.figures)) as Record<FigureKey, Figure>;
/** "2027 figure" or "2026 figure — 2027 not yet announced" */
export const figureNote = (f: Figure) => (f.confirmed ? `${f.year} figure` : `${f.year} figure — ${FIG_YEAR} not yet announced`);
export const PLAN_COUNT = cms.plans.length;

// Official CMS CY2027 Landscape (file 202609.1) — every Medicare Advantage plan sold in Michigan.
// Premiums, out-of-pocket limits, star ratings and county availability are real CMS figures.
// Dental/vision/hearing come from the CMS CY2027 PBP Benefits file (scripts/build-mi-extras.py).
// Medical spending, coinsurance and drug spending are still estimates.
export const DATA_SOURCE = "CMS CY2027 Medicare Advantage Landscape & Plan Benefit Package files";

export type PlanType = "Original + Medigap" | "Advantage HMO" | "Advantage PPO" | "Special Needs (SNP)" | "Other Advantage" | "Original only";
/** A Michigan county name, or "" when the ZIP is outside Michigan / unknown. */
export type Region = string;

const ZIPS = zipCounty as Record<string, string>;
export const COUNTIES: string[] = Array.from(new Set(cms.plans.flatMap((p) => p.counties))).sort();
export const REGION_LABELS: Record<string, string> = Object.fromEntries(COUNTIES.map((c) => [c, `${c} County`]));

export function regionFromZip(zip: string): Region {
  return ZIPS[zip] ?? "";
}
export const regionLabel = (r: Region) => (r ? `${r} County, Michigan` : "Outside Michigan — showing Original Medicare & Medigap only");

/** Label shown beside estimates while Part B uses a prior-year fallback; null once confirmed for the coverage year. */
export const partBFallbackLabel = () => (FIGURES.partBMonthly.confirmed && FIGURES.partBMonthly.year === FIG_YEAR ? null : `Uses ${FIGURES.partBMonthly.year} Part B amount — ${FIG_YEAR} not announced yet`);
export let PART_B_MONTHLY = FIGURES.partBMonthly.value;
export let PART_D_OOP_CAP = FIGURES.partDOopCap.value;
export let FIGURE_YEAR = FIGURES.partBMonthly.year;
const PDP_PREMIUM = Math.round(cms.pdpMedian); // median 2027 Michigan stand-alone Part D premium

export interface Plan {
  id: string;
  name: string;
  carrier: string;
  type: PlanType;
  cmsType?: string;
  regions: Region[] | "all";
  monthlyPremium: number;
  deductible: number;
  oopMax: number | null;
  coinsurance: number;
  drugCoverage: boolean;
  drugPremium: number;
  networkSize: "Any Medicare doctor" | "Plan network" | "Network + out-of-network";
  referralsNeeded: boolean;
  /** From CMS Plan Benefit Package data; null = not reported */
  dental: boolean | null;
  vision: boolean | null;
  hearing: boolean | null;
  extrasDetail?: { dental: string; vision: string; hearing: string; fitness: string; otc: string } | undefined;
  /** Gym/fitness benefit included in premium (CMS PBP data) */
  fitness: boolean | null;
  /** Monthly Part B premium giveback, if the plan offers one */
  partBGiveback: number | null;
  /** Medicare-covered preventive care (yearly checkup, mammograms, screenings) at $0 copay */
  preventiveZero: boolean | null;
  starRating: number;
  /** Real in-network cost sharing from CMS PBP data: $ per visit, or { pct } coinsurance. stay = cost of a 5-day hospital stay. */
  copays?: { pcp?: Share | undefined; spec?: Share | undefined; er?: Share | undefined; stay?: Share | undefined; medDed?: number | undefined } | undefined;
  /** Yearly prescription deductible (CMS Landscape), when the plan includes drugs */
  rxDeductible?: number | undefined;
  /** Year the star rating comes from (2026 = last year's rating shown until CMS publishes 2027), null if none */
  starYear?: number | null;
  hospitals: string[];
  summary: string;
  real: boolean;
}

export type Share = number | { pct: number };

function mapType(t: string, snp: boolean): PlanType {
  if (snp) return "Special Needs (SNP)";
  if (t.startsWith("HMO")) return "Advantage HMO";
  if (t.includes("PPO")) return "Advantage PPO";
  return "Other Advantage";
}

type Extra = { dental: boolean; dentalComprehensive?: boolean; dentalMax?: number | null; dentalOptional?: boolean; vision: boolean; visionExam?: boolean; eyewear?: boolean; eyewearMax?: number | null; hearing: boolean; hearingExam?: boolean; hearingAids?: boolean; hearingAidMax?: number | null; fitness?: boolean; otc?: boolean; otcMax?: number | null; otcPer?: string | null; partBGiveback?: number; preventiveZero?: boolean; pcp?: Share; spec?: Share; er?: Share; stay?: Share; medDed?: number };
const EXTRAS = extrasData as Record<string, Extra>;
const usd = (n: number) => "$" + n.toLocaleString();

function extrasDetail(e: Extra | undefined): Plan["extrasDetail"] {
  if (!e) return undefined;
  return {
    dental: e.dental ? `${e.dentalComprehensive ? "Cleanings + fillings/crowns" : "Cleanings & X-rays"}${e.dentalMax ? `, up to ${usd(e.dentalMax)}/yr` : ""}` : e.dentalOptional ? "Optional add-on (extra cost)" : "Not covered",
    vision: e.vision ? `${e.visionExam ? "Eye exam" : ""}${e.visionExam && e.eyewear ? " + " : ""}${e.eyewear ? `glasses/contacts${e.eyewearMax ? ` up to ${usd(e.eyewearMax)}/yr` : ""}` : ""}` : "Not covered",
    hearing: e.hearing ? `${e.hearingExam ? "Hearing exam" : ""}${e.hearingExam && e.hearingAids ? " + " : ""}${e.hearingAids ? `hearing aids${e.hearingAidMax ? ` up to ${usd(e.hearingAidMax)}` : " (copay)"}` : ""}` : "Not covered",
    fitness: e.fitness ? "Gym/fitness benefit included" : "Not covered",
    otc: e.otc ? `Allowance for everyday health items${e.otcMax ? ` — ${usd(e.otcMax)}/${e.otcPer ?? "yr"}` : ""}` : "Not covered",
  };
}

const cmsPlans: Plan[] = cms.plans.map((p) => {
  const type = mapType(p.cmsType, p.snp);
  const hmo = p.cmsType.startsWith("HMO");
  const pos = p.cmsType.includes("POS");
  const x = EXTRAS[p.id];
  const snpNote = p.snp ? " Special Needs Plan — only for people who qualify (e.g. Medicare + Medicaid, certain chronic conditions, or nursing-home care)." : "";
  const net = hmo ? (pos ? "HMO-POS: a network plan that may cover some care outside the network, usually at a higher cost." : "Must use network doctors, except emergencies.")
    : p.cmsType.startsWith("PFFS") ? "PFFS: you can see doctors who agree to the plan's payment terms. Each doctor can decide visit by visit, so always ask first."
    : "PPO: see out-of-network doctors at higher cost.";
  return {
    id: p.id,
    name: p.name,
    carrier: p.carrier,
    type,
    cmsType: p.cmsType,
    regions: p.counties,
    monthlyPremium: p.premium,
    oopMax: p.moop ?? 9250,
    coinsurance: hmo ? 0.12 : 0.15,
    drugCoverage: p.rx,
    drugPremium: p.rx ? 0 : PDP_PREMIUM,
    networkSize: hmo && !pos ? "Plan network" : "Network + out-of-network",
    referralsNeeded: hmo && !pos,
    dental: x ? x.dental : null, vision: x ? x.vision : null, hearing: x ? x.hearing : null,
    fitness: x ? (x.fitness ?? false) : null,
    partBGiveback: x?.partBGiveback ?? null,
    preventiveZero: x ? (x.preventiveZero ?? null) : null,
    extrasDetail: extrasDetail(x),
    copays: x ? { pcp: x.pcp, spec: x.spec, er: x.er, stay: x.stay, medDed: x.medDed } : undefined,
    rxDeductible: p.rx ? (p.rxDed ?? 0) : undefined,
    deductible: x?.medDed ?? 0,
    starRating: starFor(p.id.split("_")[0] ?? "").stars,
    starYear: starFor(p.id.split("_")[0] ?? "").year,
    hospitals: [],
    summary: `${net}${p.rx ? "" : " Does not include drug coverage."}${snpNote}`,
    real: true,
  };
});

const originalPlans: Plan[] = [
  { id: "orig", name: "Original Medicare (A + B) + Part D", carrier: "Medicare", type: "Original only", regions: "all", monthlyPremium: 0, deductible: FIGURES.partBDeductible.value, oopMax: null, coinsurance: 0.2, drugCoverage: false, drugPremium: PDP_PREMIUM, networkSize: "Any Medicare doctor", referralsNeeded: false, dental: false, vision: false, hearing: false, fitness: false, partBGiveback: null, preventiveZero: true, starRating: 0, hospitals: [], summary: "Go to any doctor that takes Medicare, but you pay 20% with no yearly limit. Risky without extra coverage.", real: false },
  { id: "medigap-g", name: "Medigap Plan G + Part D", carrier: "Various insurers (typical price)", type: "Original + Medigap", regions: "all", monthlyPremium: 168, deductible: FIGURES.partBDeductible.value, oopMax: FIGURES.partBDeductible.value, coinsurance: 0, drugCoverage: false, drugPremium: PDP_PREMIUM, networkSize: "Any Medicare doctor", referralsNeeded: false, dental: false, vision: false, hearing: false, fitness: false, partBGiveback: null, preventiveZero: true, starRating: 0, hospitals: [], summary: "Highest peace of mind. After the small Part B deductible, nearly everything is covered. Price shown is a typical estimate.", real: false },
  { id: "medigap-n", name: "Medigap Plan N + Part D", carrier: "Various insurers (typical price)", type: "Original + Medigap", regions: "all", monthlyPremium: 122, deductible: FIGURES.partBDeductible.value, oopMax: 900, coinsurance: 0.03, drugCoverage: false, drugPremium: PDP_PREMIUM, networkSize: "Any Medicare doctor", referralsNeeded: false, dental: false, vision: false, hearing: false, fitness: false, partBGiveback: null, preventiveZero: true, starRating: 0, hospitals: [], summary: "Cheaper than Plan G, with small copays ($20 office / $50 ER). Still use any Medicare doctor. Price shown is a typical estimate.", real: false },
];

export const PLANS: Plan[] = [...originalPlans, ...cmsPlans];
export const plansFor = (r: Region) => PLANS.filter((p) => p.regions === "all" || (r !== "" && p.regions.includes(r)));

export type Health = "healthy" | "some" | "chronic";
export const MEDICAL_SPEND: Record<Health, number> = { healthy: 1500, some: 8000, chronic: 30000 };

export interface Answers {
  zip: string;
  health: Health;
  doctorsFlex: "any" | "network-ok";
  hospital: string;
  drugsMonthly: number; // retail monthly cost of prescriptions
  priority: "low-premium" | "balanced" | "peace" | "flex";
  extras: { dental: boolean; vision: boolean; hearing: boolean; fitness?: boolean };
  travels: boolean;
}

/** Typical yearly care for each health level (illustrative): visits, ER trips, hospital stays, plus other care (tests, imaging, outpatient) in dollars. */
export const CARE_USE: Record<Health, { pcp: number; spec: number; er: number; stays: number; other: number }> = {
  healthy: { pcp: 2, spec: 1, er: 0, stays: 0, other: 800 },
  some: { pcp: 4, spec: 6, er: 0.5, stays: 0.25, other: 3000 },
  chronic: { pcp: 6, spec: 14, er: 1, stays: 1, other: 10000 },
};
// Approximate Medicare-allowed prices, used only when a plan charges a percentage instead of a flat copay.
const BASE_PRICE = { pcp: 130, spec: 200, er: 1500, stay: 15000 };
const shareCost = (s: Share | undefined, base: number, fallbackPct: number) =>
  s === undefined ? base * fallbackPct : typeof s === "number" ? s : base * (s.pct / 100);

export function estimateAnnual(plan: Plan, health: Health, drugsMonthly: number) {
  const premiums = (plan.monthlyPremium + PART_B_MONTHLY) * 12;
  const drugPrem = plan.drugCoverage ? 0 : plan.drugPremium * 12;
  let medical: number;
  const c = plan.copays;
  if (c) {
    // Medicare Advantage: use the plan's real copays from CMS.
    const u = CARE_USE[health];
    const k = plan.coinsurance;
    const otherAfterDed = Math.min(u.other, plan.deductible) + Math.max(0, u.other - plan.deductible) * k;
    medical = u.pcp * shareCost(c.pcp, BASE_PRICE.pcp, k) + u.spec * shareCost(c.spec, BASE_PRICE.spec, k)
      + u.er * shareCost(c.er, BASE_PRICE.er, k) + u.stays * shareCost(c.stay, BASE_PRICE.stay, k) + otherAfterDed;
  } else {
    const spend = MEDICAL_SPEND[health];
    medical = Math.min(spend, plan.deductible) + Math.max(0, spend - plan.deductible) * plan.coinsurance;
  }
  if (plan.oopMax !== null) medical = Math.min(medical, plan.oopMax);
  const drugRetail = drugsMonthly * 12;
  const rxDed = plan.rxDeductible ?? 0;
  const drugs = plan.type === "Original only" && !plan.drugCoverage && drugsMonthly === 0 ? 0
    : plan.drugCoverage
      ? Math.min(Math.min(drugRetail, rxDed) + Math.max(0, drugRetail - rxDed) * 0.25, PART_D_OOP_CAP)
      : Math.min(drugRetail * 0.3, PART_D_OOP_CAP);
  const worstCase = plan.oopMax === null ? null : premiums + drugPrem + plan.oopMax + PART_D_OOP_CAP;
  return { premiums: premiums + drugPrem, medical: Math.round(medical), drugs: Math.round(drugs), total: Math.round(premiums + drugPrem + medical + drugs), worstCase };
}

/** Lets you see doctors outside a network (PPO, HMO-POS, Original Medicare/Medigap). From plan type, not network lists. */
const outOfNetworkOk = (p: Plan) => p.networkSize !== "Plan network";

/**
 * Rule-based fit: counts which stated preferences this plan meets, using only plan attributes
 * from CMS data (plan type, benefit flags). No hidden point weights. Hospital is info only
 * because plan data does not include hospital networks.
 */
export function scorePlan(plan: Plan, a: Answers) {
  const cost = estimateAnnual(plan, a.health, a.drugsMonthly);
  let matched = 0;
  const reasons: string[] = [];
  const cautions: string[] = [];
  if (plan.type === "Original only") cautions.push("No limit on what you could pay in a bad year.");
  if (a.doctorsFlex === "any") {
    if (plan.networkSize === "Any Medicare doctor") { matched++; reasons.push("Lets you keep any doctor who takes Medicare."); }
    else if (outOfNetworkOk(plan)) { matched++; reasons.push("Can see out-of-network doctors (at a higher cost)."); }
    else cautions.push("You'd need to use network doctors only.");
  }
  if (a.hospital && a.hospital !== "none") {
    cautions.push(plan.networkSize === "Any Medicare doctor"
      ? `${a.hospital}: any hospital that takes Medicare is covered — confirm it accepts Medicare.`
      : `Confirm ${a.hospital} is in this plan's network before enrolling (we don't have network lists).`);
  }
  if (a.travels) {
    if (outOfNetworkOk(plan)) { matched++; reasons.push(plan.networkSize === "Any Medicare doctor" ? "Works anywhere in the U.S." : "Some coverage outside the network when traveling."); }
    else cautions.push("Limited coverage when traveling outside the area.");
  }
  (["dental", "vision", "hearing", "fitness"] as const).forEach((x) => {
    if (!a.extras[x]) return;
    if (plan[x] === null) cautions.push(`Check the plan's Summary of Benefits for ${x} coverage.`);
    else if (plan[x]) { matched++; reasons.push(`Includes ${x}.`); }
    else cautions.push(`No ${x} coverage—you'd buy it separately.`);
  });
  if (plan.monthlyPremium === 0 && plan.real) reasons.push("$0 plan premium.");
  if (plan.type === "Special Needs (SNP)") cautions.push("Only for people who qualify for this Special Needs Plan.");
  if (plan.referralsNeeded) cautions.push("Referrals needed to see specialists.");
  if (plan.oopMax && plan.oopMax > 6000) cautions.push(`In a bad year you could pay up to $${plan.oopMax.toLocaleString()} for covered medical care, plus drugs.`);
  return { plan, cost, score: matched, matched, reasons, cautions };
}

export type SortKey = "total" | "premium" | "oop";
export const sortForPriority = (p: Answers["priority"]): SortKey => (p === "low-premium" ? "premium" : p === "peace" ? "oop" : "total");
export const SORT_LABEL: Record<SortKey, string> = { total: "estimated yearly cost", premium: "monthly premium", oop: "illustrative high-cost scenario" };

type Scored = ReturnType<typeof scorePlan>;
const keyOf = (s: Scored, k: SortKey) => (k === "total" ? s.cost.total : k === "premium" ? s.plan.monthlyPremium : s.cost.worstCase ?? Infinity);
/**
 * Ordered, explainable rules:
 * 1. Plans with a yearly limit first; Original Medicare alone (no limit) next; Special Needs Plans last.
 * 2. Within each group, plans meeting more of your stated preferences first.
 * 3. Then by the chosen sort (estimated yearly cost, premium, or high-cost scenario).
 * 4. When sorting by estimated cost and neighbors are within $250, the lower high-cost scenario goes first.
 */
export function rankPlans(scored: Scored[], key: SortKey = "total"): Scored[] {
  const wc = (s: Scored) => s.cost.worstCase ?? Infinity;
  const sortGroup = (g: Scored[]) => {
    g.sort((x, y) => y.matched - x.matched || keyOf(x, key) - keyOf(y, key));
    if (key === "total")
      for (let pass = 0; pass < g.length; pass++)
        for (let i = 0; i + 1 < g.length; i++) {
          const a = g[i]!, b = g[i + 1]!;
          if (a.matched === b.matched && Math.abs(a.cost.total - b.cost.total) <= 250 && wc(b) < wc(a)) { g[i] = b; g[i + 1] = a; }
        }
    return g;
  };
  const grp = (s: Scored) => (s.plan.type === "Special Needs (SNP)" ? 2 : s.plan.type === "Original only" ? 1 : 0);
  return [0, 1, 2].flatMap((n) => sortGroup(scored.filter((s) => grp(s) === n)));
}

/** Plain-language list of the ranking rules in use, for the "Why this order?" note. */
export function explainOrder(a: Pick<Answers, "doctorsFlex" | "travels" | "extras">, key: SortKey): string[] {
  const prefs = [
    a.doctorsFlex === "any" && "seeing doctors outside a network",
    a.travels && "coverage when traveling",
    ...(["dental", "vision", "hearing", "fitness"] as const).filter((x) => a.extras[x]),
  ].filter(Boolean) as string[];
  const out = [];
  if (prefs.length) out.push(`We show plans that best match what matters to you (${prefs.join(", ")}). For example, if you selected dental or hearing coverage, plans offering those benefits appear higher. If we can't confirm whether a plan includes a benefit, we won't assume it does. You can always check with the insurance company.`);
  out.push(`${prefs.length ? "After that, plans" : "Plans"} are sorted by ${SORT_LABEL[key]}, lowest first.`);
  if (key === "total") out.push("If two plans cost within about $250 of each other, the one with the lower high-cost year goes first.");
  out.push("Original Medicare alone (no yearly spending limit) comes after plans with a limit. Special Needs Plans, which have eligibility rules, are listed last.");
  return out;
}

export const money = (n: number) => "$" + Math.round(n).toLocaleString();

/** Owner-published data from the CMS Updates screen; null = use the built-in files. */
export type LiveData = { stars?: StarsPayload | null; figures?: FiguresPayload | null; publishedAt?: Record<string, string> };
let appliedKey = "";
/** Apply live overrides once per distinct payload (same data on server and browser, so no hydration mismatch). */
export function applyLiveData(live: LiveData | null | undefined) {
  const key = JSON.stringify(live?.publishedAt ?? {});
  if (key === appliedKey) return;
  appliedKey = key;
  S27 = live?.stars ?? (stars2027 as StarsPayload);
  const f = live?.figures ?? (figures as FiguresPayload);
  FIG_YEAR = f.coverageYear;
  Object.assign(FIGURES, JSON.parse(JSON.stringify(f.figures)));
  PART_B_MONTHLY = FIGURES.partBMonthly.value;
  PART_D_OOP_CAP = FIGURES.partDOopCap.value;
  FIGURE_YEAR = FIGURES.partBMonthly.year;
  for (const p of PLANS) {
    if (p.real) {
      const s = starFor(p.id.split("_")[0] ?? "");
      p.starRating = s.stars; p.starYear = s.year;
    } else {
      p.deductible = FIGURES.partBDeductible.value;
      if (p.id === "medigap-g") p.oopMax = FIGURES.partBDeductible.value;
    }
  }
}
