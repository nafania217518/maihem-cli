import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { LEVEL, REASONING } from "../src/org/types.ts";
import { checkOrgs, crossCheck, manager, neighbours, validateOrg } from "../src/org/config.ts";

const m = (role: string, reports_to?: string) => ({ role, definition: "d1", ...(reports_to ? { reports_to } : {}) });
const team = { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev") };
const base = { name: "x", repo: "~/r", members: team };

describe("org config", () => {
  it("org needs repo and members", () => {
    expect(validateOrg(base).repo).toBe("~/r");
    for (const k of ["repo", "members"]) expect(() => validateOrg({ ...base, [k]: undefined })).toThrow(`org "x": "${k}" is required`);
    expect(() => validateOrg({ ...base, members: {} })).toThrow(/^org "x": members/);
    expect(() => validateOrg({ ...base, members: ["a"] })).toThrow(/^org "x": members/);
  });
  it("member names are checked and user/org are reserved", () => {
    for (const n of ["user", "org", "Bad", "-a"]) expect(() => validateOrg({ ...base, members: { ...team, [n]: m("dev") } })).toThrow(`org "x": invalid member name "${n}"`);
  });
  it("a member has a role, a definition and an optional reports_to", () => {
    expect(validateOrg(base).members).toEqual({ ba: { role: "ba", definition: "d1" }, sa: { role: "sa", definition: "d1" }, pm: { role: "pm", definition: "d1" }, tl: { role: "tl", definition: "d1" }, dev1: { role: "dev", definition: "d1" } });
    expect(() => validateOrg({ ...base, members: { ...team, dev1: { ...m("dev"), foo: 1 } } })).toThrow('org "x": unknown field "foo" in member "dev1"');
    expect(() => validateOrg({ ...base, members: { ...team, dev1: { role: "dev" } } })).toThrow('org "x": member "dev1" needs a definition name');
  });
  it("role must be one of ba, sa, pm, tl, dev", () => {
    expect(() => validateOrg({ ...base, members: { ...team, qa: m("qa") } })).toThrow('org "x": member "qa" role must be one of ba, sa, pm, tl, dev');
    expect(() => validateOrg({ ...base, members: { ...team, qa: { definition: "d1" } } })).toThrow('org "x": member "qa" role must be one of ba, sa, pm, tl, dev');
  });
  it("every role is required", () => {
    const { tl: _, ...noTl } = team;
    expect(() => validateOrg({ ...base, members: { ...noTl, dev1: m("dev") } })).toThrow('org "x": role "tl" needs a member');
  });
  it("ba, sa and pm have exactly one member", () => {
    for (const r of ["ba", "sa", "pm"]) expect(() => validateOrg({ ...base, members: { ...team, extra: m(r) } })).toThrow(`org "x": role "${r}" has exactly one member`);
    expect(Object.keys(validateOrg({ ...base, members: { ...team, tl2: m("tl"), dev1: m("dev", "tl"), dev2: m("dev", "tl2") } }).members)).toHaveLength(7);
  });
  it("reports_to is refused outside a DEV with several TLs", () => {
    for (const [k, r] of [["pm", "ba"], ["tl", "sa"], ["ba", "sa"], ["sa", "ba"], ["dev1", "tl"]]) expect(() => validateOrg({ ...base, members: { ...team, [k]: m(k === "dev1" ? "dev" : k, r) } })).toThrow(`org "x": member "${k}" may not set reports_to (only a DEV, when the org has several TLs)`);
    expect(() => validateOrg({ ...base, members: { ...team, tl2: m("tl", "sa"), dev1: m("dev", "tl") } })).toThrow('org "x": member "tl2" may not set reports_to');
  });
  it("a DEV must name its TL when the org has several TLs", () => {
    const two = { ...team, tl2: m("tl") };
    expect(() => validateOrg({ ...base, members: two })).toThrow('org "x": member "dev1" must name its TL in reports_to (the org has several TLs)');
    for (const r of ["zz", "sa", "dev1"]) expect(() => validateOrg({ ...base, members: { ...two, dev1: m("dev", r) } })).toThrow('org "x": member "dev1" must name its TL in reports_to');
    expect(validateOrg({ ...base, members: { ...two, dev1: m("dev", "tl2") } }).members.dev1.reports_to).toBe("tl2");
  });
  it("limits default to parallel 1 and reject unknown keys", () => {
    expect(validateOrg(base).limits).toEqual({ parallel: 1 });
    expect(validateOrg({ ...base, limits: { parallel: 3, tokens: 100 } }).limits).toEqual({ parallel: 3, tokens: 100 });
    expect(() => validateOrg({ ...base, limits: { foo: 1 } })).toThrow('org "x": unknown limit "foo"');
    expect(() => validateOrg({ ...base, limits: { parallel: 0 } })).toThrow('org "x": limits.parallel must be a positive integer');
    expect(() => validateOrg({ ...base, limits: { tokens: 1.5 } })).toThrow('org "x": limits.tokens must be a positive integer');
    expect(validateOrg({ ...base, limits: { tokens: "1.5M" } }).limits.tokens).toBe(1_500_000);
    expect(() => validateOrg({ ...base, limits: 3 })).toThrow('org "x": limits must be a map');
  });
  it("limits take review_rounds, noop_sessions, retry_seconds, retry_max_seconds and triage_chars", () => {
    const all = { review_rounds: 2, noop_sessions: 4, retry_seconds: 5, retry_max_seconds: 60, triage_chars: 100 };
    expect(validateOrg({ ...base, limits: all }).limits).toMatchObject(all);
    for (const k of Object.keys(all)) expect(() => validateOrg({ ...base, limits: { [k]: 0 } })).toThrow(`org "x": limits.${k} must be a positive integer`);
  });

  it("limits take no wakes_per_ticket", () => {
    expect(() => validateOrg({ ...base, limits: { wakes_per_ticket: 5 } })).toThrow('org "x": unknown limit "wakes_per_ticket"');
  });
  it("workflow and plain-string members are rejected", () => {
    expect(() => checkOrgs({ x: { repo: "r", members: team, workflow: "w" } })).toThrow('apply file: unknown field "workflow" in org "x"');
    expect(() => validateOrg({ ...base, workflow: "w" })).toThrow('org "x": unknown field "workflow"');
    expect(() => validateOrg({ ...base, members: { ...team, dev1: "d1" } })).toThrow('org "x": member "dev1" must be a map of role, definition and reports_to');
    expect(checkOrgs({ x: { repo: "r", members: team } })[0].name).toBe("x");
  });
  it("crossCheck finds members with unknown definitions", () => {
    expect(() => crossCheck(validateOrg(base), () => true)).not.toThrow();
    expect(() => crossCheck(validateOrg(base), () => false)).toThrow('org "x": member "ba" uses unknown definition "d1"');
  });
  it("manager follows the grid; a DEV names its TL when there are several", () => {
    const o = validateOrg(base);
    expect(["ba", "sa", "pm", "tl", "dev1", "nobody"].map((x) => manager(o, x))).toEqual([undefined, undefined, "ba", "sa", "tl", undefined]);
    const o2 = validateOrg({ ...base, members: { ...team, tl2: m("tl"), dev1: m("dev", "tl2"), dev2: m("dev", "tl") } });
    expect(["tl2", "dev1", "dev2"].map((x) => manager(o2, x))).toEqual(["sa", "tl2", "tl"]);
  });
  it("neighbours follow the grid", () => {
    const o = validateOrg(base), n = (x: string) => neighbours(o, x).sort();
    expect(n("ba")).toEqual(["pm", "sa"]);
    expect(n("sa")).toEqual(["ba", "tl"]);
    expect(n("pm")).toEqual(["ba", "tl"]);
    expect(n("tl")).toEqual(["dev1", "pm", "sa"]);
    expect(n("dev1")).toEqual(["tl"]);
    expect(n("nobody")).toEqual([]);
    const o2 = validateOrg({ ...base, members: { ...team, tl2: m("tl"), dev1: m("dev", "tl2"), dev2: m("dev", "tl") } });
    expect(neighbours(o2, "dev1")).toEqual(["tl2"]);
    expect(neighbours(o2, "tl").sort()).toEqual(["dev2", "pm", "sa"]);
    expect(neighbours(o2, "pm").sort()).toEqual(["ba", "tl", "tl2"]);
  });
  it("the example org config sets each definition's reasoning to its role's level default", () => {
    const cfg = parse(readFileSync(new URL("../../../examples/org.yaml", import.meta.url), "utf8"));
    for (const mem of Object.values<{ role: keyof typeof LEVEL; definition: string }>(cfg.orgs.demo.members))
      expect(cfg.definitions[mem.definition].reasoning).toBe(REASONING[LEVEL[mem.role]]);
  });
});
