import { describe, expect, it } from "vitest";
import { explainOrder } from "./plans";

const NO_PREFS = { doctorsFlex: "network-ok" as const, travels: false, extras: { dental: false, vision: false, hearing: false, fitness: false } };
const WITH_PREFS = { doctorsFlex: "network-ok" as const, travels: false, extras: { dental: true, vision: false, hearing: false, fitness: false } };

describe("ranking explanation bullets", () => {
  it("says plainly how plans are sorted when nothing was selected", () => {
    const out = explainOrder(NO_PREFS, "total");
    expect(out).toContain("plans are sorted by estimated yearly cost, lowest first.");
    expect(out.some((l) => l.startsWith("After that"))).toBe(false);
  });
  it("links the sorting rule to the selected benefits when something was selected", () => {
    const out = explainOrder(WITH_PREFS, "total");
    expect(out[0]).toContain("dental");
    expect(out[1]).toBe("After that, plans are sorted by estimated yearly cost, lowest first.");
  });
});
