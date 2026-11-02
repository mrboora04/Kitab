#!/usr/bin/env node
// Checks every source in sources/ and writes index.json (with each file's SHA-256).
//   node tools/build-index.mjs          write index.json
//   node tools/build-index.mjs --check  fail if a source is invalid or index.json is out of date (used by CI)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const check = process.argv.includes('--check');
const REPO_NAME = 'Kitab Official Sources';

/** The same rules Kitab applies when it installs a source (see SOURCE_FORMAT.md). */
function validate(d) {
  const str = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'it is not a source';
  if (d.schema !== 1) return 'schema must be 1';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(d.id || '')) return 'id must be 2-40 characters: a-z, 0-9 and -';
  if (!str(d.name, 60)) return 'name is missing';
  if (!Number.isInteger(d.version) || d.version < 1) return 'version must be a whole number from 1';
  if (!str(d.license, 200)) return 'license is missing: say what kind of books the source offers';
  if (d.adult) return 'sources with adult content are not allowed';
  if (!Array.isArray(d.hosts) || !d.hosts.length || d.hosts.length > 6 || d.hosts.some((h) => !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h))) return 'hosts must list 1-6 website names';
  if (!['json', 'html', 'opds'].includes(d.type)) return 'type must be json, html or opds';
  if (JSON.stringify(d).length > 20000) return 'the file is too large';
  const hostOk = (url) => {
    let u; try { u = new URL(url); } catch { return false; }
    return u.protocol === 'https:' && d.hosts.some((h) => (h.startsWith('*.') ? u.hostname === h.slice(2) || u.hostname.endsWith(h.slice(1)) : u.hostname === h));
  };
  const coverOk = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && (d.coverHosts || []).includes(u.hostname); } catch { return false; } };
  if (d.coverHosts && (!Array.isArray(d.coverHosts) || d.coverHosts.length > 4 || d.coverHosts.some((h) => !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h)))) return 'coverHosts must list up to 4 website names';
  let bad = '';
  const walk = (v) => {
    if (bad) return;
    if (typeof v === 'string') { const x = v.replace(/\{[^}]*\}/g, 'x'); if (/^https?:\/\//i.test(v) && !hostOk(x) && !coverOk(x)) bad = `points at a website not in hosts or coverHosts: ${v.slice(0, 70)}`; }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(d);
  return bad;
}

const files = readdirSync('sources').filter((f) => f.endsWith('.json')).sort();
const sources = [];
let failed = false;
for (const f of files) {
  const text = readFileSync(`sources/${f}`, 'utf8');
  let d;
  try { d = JSON.parse(text); } catch (e) { console.error(`✗ ${f}: not valid JSON`); failed = true; continue; }
  const why = validate(d);
  if (why) { console.error(`✗ ${f}: ${why}`); failed = true; continue; }
  if (f !== `${d.id}.json`) { console.error(`✗ ${f}: the file must be named ${d.id}.json`); failed = true; continue; }
  sources.push({
    id: d.id, name: d.name, lang: d.lang || 'multi', version: d.version, file: `sources/${f}`,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'), site: d.site || '', icon: d.icon || '', license: d.license,
  });
  console.log(`✓ ${f} (v${d.version})`);
}
if (failed) process.exit(1);

// A directory of free-book websites and packs of sources (installed together)
const ids = new Set(sources.map((x) => x.id));
const readList = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
const directory = readList('directory.json'), packs = readList('packs.json');
for (const d of directory) {
  const why = !/^[a-z0-9-]{2,40}$/.test(d.id || '') ? 'bad id' : !d.name || d.name.length > 60 ? 'bad name' : !/^https:\/\/[^\s]+$/.test(d.url || '') ? 'url must be https' : !d.category ? 'missing category'
    : !d.about || d.about.length > 140 ? 'about must be 1-140 characters' : !d.license ? 'missing license note' : (d.source && !ids.has(d.source)) ? `source ${d.source} is not in sources/` : '';
  if (why) { console.error(`✗ directory.json: ${d.id || d.name}: ${why}`); failed = true; }
}
for (const k of packs) {
  if (!/^[a-z0-9-]{2,40}$/.test(k.id || '') || !k.name || !Array.isArray(k.sources) || !k.sources.length || k.sources.some((i) => !ids.has(i))) { console.error(`✗ packs.json: ${k.id}: every source in a pack must exist in sources/`); failed = true; }
}
if (failed) process.exit(1);

const index = JSON.stringify({ schema: 1, name: REPO_NAME, sources, packs, directory }, null, 2) + '\n';
if (check) {
  if (!existsSync('index.json') || readFileSync('index.json', 'utf8') !== index) {
    console.error('✗ index.json is out of date. Run: node tools/build-index.mjs');
    process.exit(1);
  }
  console.log('index.json is up to date');
} else {
  writeFileSync('index.json', index);
  console.log(`wrote index.json with ${sources.length} source${sources.length === 1 ? '' : 's'}`);
}
