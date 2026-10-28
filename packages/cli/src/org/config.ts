import { parseCount } from "../count.ts";
import { checkEntries, isMap } from "../definition.ts";
import { LEVEL, ROLES, TRACK } from "./types.ts";
import type { Limits, Member, Org, Role } from "./types.ts";

const posInt = (x: unknown): boolean => Number.isInteger(x) && (x as number) > 0;
const LIMITS = ["parallel", "tokens", "review_rounds", "noop_sessions", "retry_seconds", "retry_max_seconds", "triage_chars"];
const SINGLE: Role[] = ["ba", "sa", "pm"];

export function validateOrg(raw: Record<string, unknown>): Org {
  const name = raw.name as string, e = (m: string) => new Error(`org "${name}": ${m}`);
  const extra = Object.keys(raw).find((k) => !["name", "repo", "members", "limits"].includes(k));
  if (extra) throw e(`unknown field "${extra}"`);
  if (typeof raw.repo !== "string" || !raw.repo) throw e('"repo" is required');
  const m = raw.members;
  if (m === undefined) throw e('"members" is required');
  if (!isMap(m) || !Object.keys(m).length) throw e("members must be a non-empty map of name: {role, definition, reports_to}");
  const members: Record<string, Member> = {};
  for (const [k, o] of Object.entries(m)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(k) || k === "user" || k === "org") throw e(`invalid member name "${k}"`);
    if (!isMap(o)) throw e(`member "${k}" must be a map of role, definition and reports_to`);
    const bad = Object.keys(o).find((f) => !["role", "definition", "reports_to"].includes(f));
    if (bad) throw e(`unknown field "${bad}" in member "${k}"`);
    if (!(ROLES as readonly unknown[]).includes(o.role)) throw e(`member "${k}" role must be one of ${ROLES.join(", ")}`);
    if (typeof o.definition !== "string" || !o.definition) throw e(`member "${k}" needs a definition name`);
    members[k] = { role: o.role as Role, definition: o.definition, ...(o.reports_to === undefined ? {} : { reports_to: o.reports_to as string }) };
  }
  for (const r of ROLES) {
    const n = Object.values(members).filter((x) => x.role === r).length;
    if (!n) throw e(`role "${r}" needs a member`);
    if (n > 1 && SINGLE.includes(r)) throw e(`role "${r}" has exactly one member`);
  }
  const tls = Object.values(members).filter((x) => x.role === "tl").length;
  for (const [k, v] of Object.entries(members)) {
    if (v.role === "dev" && tls > 1) { if (members[v.reports_to as string]?.role !== "tl") throw e(`member "${k}" must name its TL in reports_to (the org has several TLs)`); }
    else if (v.reports_to !== undefined) throw e(`member "${k}" may not set reports_to (only a DEV, when the org has several TLs)`);
  }
  const l = raw.limits ?? {};
  if (!isMap(l)) throw e("limits must be a map");
  const bad = Object.keys(l).find((k) => !LIMITS.includes(k));
  if (bad) throw e(`unknown limit "${bad}"`);
  for (const [k, v] of Object.entries(l)) if (k !== "tokens" && !posInt(v)) throw e(`limits.${k} must be a positive integer`);
  const limits: Limits = { parallel: 1, ...l, ...(l.tokens !== undefined && { tokens: parseCount(l.tokens, `org "${name}": limits.tokens`) }) };
  return { name, repo: raw.repo, members, limits };
}

export const checkOrgs = (sec: unknown): Org[] => checkEntries("org", sec, ["repo", "members", "limits"], validateOrg);

export function crossCheck(org: Org, hasDefinition: (n: string) => boolean): void {
  for (const [m, { definition: d }] of Object.entries(org.members)) if (!hasDefinition(d)) throw new Error(`org "${org.name}": member "${m}" uses unknown definition "${d}"`);
}

const UP: Partial<Record<Role, Role>> = { dev: "tl", tl: "sa", pm: "ba" };
// one level up the member's track; undefined: the human (BA, SA)
export function manager(org: Org, member: string): string | undefined {
  const x = org.members[member], up = x && UP[x.role];
  if (!up) return undefined;
  const c = Object.keys(org.members).filter((n) => org.members[n].role === up);
  return x.reports_to ?? (c.length === 1 ? c[0] : undefined);
}

// who a member may talk to: up and down its track, across its level
export function neighbours(org: Org, member: string): string[] {
  const r = org.members[member]?.role;
  if (!r) return [];
  return Object.keys(org.members).filter((n) => {
    const s = org.members[n].role;
    return manager(org, n) === member || manager(org, member) === n || (LEVEL[s] === LEVEL[r] && TRACK[s] !== TRACK[r]);
  });
}
