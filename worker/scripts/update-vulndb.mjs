// Rebuilds src/vulndb.json from the Retire.js vulnerability database (Apache-2.0, https://github.com/RetireJS/retire.js).
// Keeps only what the Worker needs: the regexes that read a library's version from its file name, URL or first lines,
// and each vulnerability's version range, severity and IDs. Run: node scripts/update-vulndb.mjs
import { writeFile } from "node:fs/promises";

const SRC = "https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v4.json";
const repo = await (await fetch(SRC)).json();
const out = {};
for (const [name, lib] of Object.entries(repo)) {
  if (name === "retire-example" || !lib.vulnerabilities?.length) continue;
  const ex = lib.extractors || {};
  const vulns = lib.vulnerabilities.map((v) => ({
    below: v.below,
    atOrAbove: v.atOrAbove,
    severity: v.severity,
    summary: v.identifiers?.summary?.slice(0, 160),
    cve: (v.identifiers?.CVE || []).slice(0, 3),
  }));
  out[name] = {
    uri: ex.uri || [],
    filename: ex.filename || [],
    filecontent: ex.filecontent || [],
    vulns,
  };
}
await writeFile(new URL("../src/vulndb.json", import.meta.url), JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} libraries`);
