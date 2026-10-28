import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { home } from "../registry.ts";
import { validateOrg } from "./config.ts";
import type { Org } from "./types.ts";

// One YAML file per item in home()/<kind>/; listing ignores directories (org runtime data) and other files.
function store<T extends { name: string }>(kind: string, dirName: string, parse: (name: string, raw: Record<string, unknown>) => T) {
  const dir = () => path.join(home(), dirName);
  const file = (n: string) => path.join(dir(), `${n}.yaml`);
  const load = (n: string): T => {
    if (!fs.existsSync(file(n))) throw new Error(`no such ${kind}: ${n}; add it with maihem apply -f FILE`);
    return parse(n, YAML.parse(fs.readFileSync(file(n), "utf8")));
  };
  return {
    save(x: T): void {
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(file(x.name), YAML.stringify(x), { mode: 0o600 });
    },
    load,
    list: (): T[] => !fs.existsSync(dir()) ? [] : fs.readdirSync(dir(), { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".yaml")).map((f) => load(f.name.slice(0, -5))).sort((a, b) => a.name.localeCompare(b.name)),
    remove(n: string): void { load(n); fs.rmSync(file(n)); },
  };
}

const orgs = store<Org>("org", "orgs", (name, raw) => validateOrg({ ...raw, name }));
export const { save: saveOrg, load: loadOrg, list: listOrgs, remove: removeOrg } = orgs;
