'use strict';
/* Browse → Extensions: the store. Installed sources, updates, what each repository offers, and the repositories themselves. */

const ExtUI = {
  loading: false,
  errors: {},        // repo url -> message

  ico: {
    globe: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>',
    down: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>',
    up: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/></svg>',
    gear: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  },

  LANGS: { en: 'English', multi: 'Multi', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', hi: 'Hindi', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese' },
  lang(c) { return this.LANGS[c] || (c ? c.toUpperCase() : 'Other'); },

  init() {
    $('#extRefresh').onclick = () => this.refresh(true);
    $('#addRepo').onclick = () => this.addRepo();
  },

  /** Draws the tab at once from what is known, then fills it in when the repositories answer. */
  render() {
    this.draw();
    if (!this.fetchedOnce) { this.fetchedOnce = true; this.refresh(false); }
  },

  async refresh(force) {
    if (this.loading) return;
    this.loading = true;
    this.errors = {};
    $('#extRefresh').classList.add('spin');
    await Promise.all(Sources.repos.map((r) => Sources.fetchIndex(r, force).catch((e) => { this.errors[r.url] = e.message || 'Could not load'; })));
    this.loading = false;
    $('#extRefresh').classList.remove('spin');
    this.draw();
  },

  row(o) {
    const site = o.site && /^https:\/\//.test(o.site) ? `<a class="ext-btn" href="${esc(o.site)}" aria-label="Open the website">${this.ico.globe}</a>` : '';
    return `<div class="ext-row" data-id="${esc(o.id)}">
      <span class="src-icon">${esc(o.icon || '🧩')}</span>
      <span class="row-text"><b>${esc(o.name)}</b><small>${esc(o.sub)}</small>${o.badge ? `<span class="tags"><em>${esc(o.badge)}</em></span>` : ''}</span>
      ${site}${o.action}</div>`;
  },

  draw() {
    const installed = Sources.installed;
    const entryFor = (id) => { for (const r of Sources.repos) { const ix = Sources.indexes[r.url]; const e = ix && ix.sources.find((s) => s.id === id); if (e) return { repo: r, ix, e }; } return null; };
    const updates = [], have = [];
    for (const x of Object.values(installed)) {
      const d = x.def, found = entryFor(d.id);
      const newer = found && Number(found.e.version) > d.version;
      (newer ? updates : have).push({ x, d, found, newer });
    }
    const html = [];
    const installedRow = (it) => this.row({
      id: it.d.id, name: it.d.name, icon: it.d.icon, site: it.d.site,
      sub: `${it.x.repoName || 'Repository'} · ${this.lang(it.d.lang)} · v${it.d.version}`, badge: it.d.license,
      action: it.newer ? `<button class="ext-btn accent" data-act="update" aria-label="Update">${this.ico.up}</button>` : `<button class="ext-btn" data-act="gear" aria-label="Details">${this.ico.gear}</button>`,
    });
    if (updates.length) html.push(`<h3 class="subhead">Updates pending</h3>${updates.map(installedRow).join('')}`);
    if (have.length) html.push(`<h3 class="subhead">Installed</h3>${have.map(installedRow).join('')}`);
    for (const r of Sources.repos) {
      const ix = Sources.indexes[r.url];
      if (this.errors[r.url]) { html.push(`<h3 class="subhead">${esc(r.name || 'Repository')}</h3><p class="none">${esc(this.errors[r.url])}</p>`); continue; }
      if (!ix) { html.push(`<h3 class="subhead">${esc(r.name || 'Repository')}</h3><p class="none">${this.loading ? 'Loading…' : 'Not loaded yet. Tap refresh.'}</p>`); continue; }
      const avail = ix.sources.filter((s) => !installed[s.id]);
      if (!avail.length) { html.push(`<h3 class="subhead">${esc(ix.name)}</h3><p class="none">Everything here is installed.</p>`); continue; }
      const groups = {};
      avail.forEach((s) => { (groups[s.lang || 'multi'] = groups[s.lang || 'multi'] || []).push(s); });
      for (const lang of Object.keys(groups).sort((a, b) => this.lang(a).localeCompare(this.lang(b)))) {
        html.push(`<h3 class="subhead">${esc(this.lang(lang))} · ${esc(ix.name)}</h3>`);
        html.push(groups[lang].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((s) => this.row({
          id: s.id, name: String(s.name || s.id).slice(0, 60), icon: s.icon, site: s.site,
          sub: `${ix.name} · ${this.lang(s.lang)} · v${s.version}`, badge: String(s.license || '').slice(0, 40),
          action: `<button class="ext-btn" data-act="install" data-repo="${esc(r.url)}" aria-label="Install">${this.ico.down}</button>`,
        })).join(''));
      }
    }
    $('#extList').innerHTML = html.join('') || '<p class="none">Nothing to show yet.</p>';
    $$('#extList .ext-row').forEach((row) => {
      const btn = row.querySelector('[data-act]');
      if (!btn) return;
      const id = row.dataset.id;
      btn.onclick = () => this.act(btn.dataset.act, id, btn);
    });
    this.drawRepos();
  },

  drawRepos() {
    $('#repoList').innerHTML = Sources.repos.map((r, i) => {
      const ix = Sources.indexes[r.url];
      return `<div class="ext-row repo"><span class="row-text"><b>${esc((ix && ix.name) || r.name || 'Repository')}</b><small>${esc(r.url)}</small></span>${r.url === OFFICIAL_REPO ? '<span class="tags"><em>Official</em></span>' : `<button class="ext-btn" data-rm="${i}" aria-label="Remove repository">✕</button>`}</div>`;
    }).join('');
    $$('#repoList [data-rm]').forEach((b) => { b.onclick = () => this.removeRepo(Number(b.dataset.rm)); });
  },

  async act(what, id, btn) {
    if (what === 'gear') return this.details(id);
    const found = (() => {
      const preferred = Sources.installed[id] && Sources.installed[id].repo;
      const order = Sources.repos.slice().sort((a) => (a.url === preferred ? -1 : 0));
      for (const r of order) { const ix = Sources.indexes[r.url]; const e = ix && ix.sources.find((s) => s.id === id); if (e) return { repo: r, e }; }
      return null;
    })();
    if (!found) return App.toast('That source is not in any repository right now', 3000);
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      await Sources.install(found.repo, found.e);
      App.toast(what === 'update' ? 'Updated' : 'Installed. Find it under Sources');
    } catch (e) {
      App.toast(e.message || 'Could not install', 5000);
    }
    this.draw();
    Browse.renderSources();
  },

  async details(id) {
    const x = Sources.installed[id];
    if (!x) return;
    const d = x.def;
    const ok = await App.dialog({
      title: d.name,
      message: `Version ${d.version} · ${this.lang(d.lang)} · ${d.license}. It can only contact: ${d.hosts.join(', ')}.`,
      ok: 'Uninstall', danger: true,
    });
    if (!ok) return;
    Sources.uninstall(id);
    App.toast('Removed');
    this.draw();
    Browse.renderSources();
  },

  async addRepo() {
    const url = await App.dialog({ title: 'Add a repository', message: 'Paste the link to a source list (an index.json).', input: 'https://', ok: 'Continue' });
    if (!url) return;
    const clean = url.trim();
    if (!/^https:\/\/\S+$/i.test(clean)) return App.toast('A repository link must start with https://', 3500);
    if (Sources.repos.some((r) => r.url === clean)) return App.toast('That repository is already added', 3000);
    const sure = await App.dialog({
      title: 'Only add repositories you trust',
      message: 'A repository decides which sources you can install, and so which books you are shown. Sources cannot run code and can only contact the sites they list, but a bad one could show you books you did not want. Kitab only supports sources of free, public books.',
      ok: 'Add it',
    });
    if (!sure) return;
    busy(true, 'Checking the repository…');
    try {
      const repo = { url: clean, name: '' };
      const ix = await Sources.fetchIndex(repo, true);
      repo.name = ix.name;
      Sources.repos.push(repo);
      Sources.saveRepos();
      busy(false);
      App.toast(`Added “${ix.name}” with ${ix.sources.length} source${ix.sources.length === 1 ? '' : 's'}`, 3500);
    } catch (e) {
      busy(false);
      App.toast(e.message || 'Could not read that link', 4500);
    }
    this.draw();
  },

  async removeRepo(i) {
    const r = Sources.repos[i];
    if (!r || r.url === OFFICIAL_REPO) return;
    if (!(await App.dialog({ title: 'Remove this repository?', message: 'Sources you installed from it stay installed until you uninstall them.', ok: 'Remove', danger: true }))) return;
    Sources.repos.splice(i, 1);
    delete Sources.indexes[r.url];
    Sources.saveRepos();
    this.draw();
  },
};
