/* ===================================================================
   vdkify — dashboard
   Hash-routed views: #/ (sites overview + activity) and
   #/site/<name> (deploy feed, GitHub, env vars, domains, danger zone).
   Tunnel ("Go public") controls live in the topbar.
   =================================================================== */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = "vdkify-token";

  /* ---------- theme ---------- */
  const savedTheme = localStorage.getItem("vdkify-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = savedTheme || (prefersDark ? "dark" : "light");
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("vdkify-theme", next);
  });

  /* ---------- api ---------- */
  function token() { return localStorage.getItem(TOKEN_KEY) || ""; }

  async function api(path, opts) {
    const o = Object.assign({ headers: {} }, opts);
    o.headers = Object.assign({ Authorization: "Bearer " + token() }, o.headers);
    let res;
    try { res = await fetch(path, o); }
    catch { return { ok: false, status: 0, error: "Can't reach the server." }; }
    if (res.status === 401) { location.replace("login.html"); return { ok: false, status: 401, error: "Signed out." }; }
    const data = await res.json().catch(() => ({}));
    return Object.assign({ ok: res.ok, status: res.status }, data,
      !res.ok && !data.error ? { error: "Request failed (" + res.status + ")" } : {});
  }

  $("#sign-out").addEventListener("click", async () => {
    await api("api/logout", { method: "POST" });
    localStorage.removeItem(TOKEN_KEY);
    location.replace("login.html");
  });

  /* ---------- toast + helpers ---------- */
  let toastTimer;
  function toast(msg, kind) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function fmtAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function avatar(name, size) {
    const a = el("div", "avatar " + (size || "sm"), name.slice(0, 2));
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    a.style.background = `linear-gradient(135deg, hsl(${h} 62% 46%), hsl(${(h + 45) % 360} 62% 38%))`;
    return a;
  }

  // ArrayBuffer -> base64, chunked
  function b64(buf) {
    const u = new Uint8Array(buf);
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
  }

  function stripCommonRoot(list) {
    if (!list.length) return list;
    const first = list[0].path.split("/")[0];
    if (first && list.every((f) => f.path === first || f.path.startsWith(first + "/"))) {
      const stripped = list
        .map((f) => ({ path: f.path.slice(first.length + 1), file: f.file }))
        .filter((f) => f.path);
      if (stripped.length) return stripped;
    }
    return list;
  }

  const SKIP = /(^|\/)(\.git|node_modules|\.DS_Store|thumbs\.db)(\/|$)/i;

  async function filesToPayload(list) {
    const files = [];
    for (const f of list) {
      if (SKIP.test(f.path)) continue;
      files.push({ path: f.path, b64: b64(await f.file.arrayBuffer()) });
    }
    if (!files.length) throw new Error("nothing to deploy (after skipping .git/node_modules)");
    return { files };
  }

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve, reject) => {
      if (entry.isFile) {
        entry.file((file) => { out.push({ path: prefix + entry.name, file }); resolve(); }, reject);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        (function read() {
          reader.readEntries(async (batch) => {
            if (!batch.length) {
              try {
                for (const e of all) await walkEntry(e, prefix + entry.name + "/", out);
                resolve();
              } catch (err) { reject(err); }
              return;
            }
            all.push(...batch);
            read();
          }, reject);
        })();
      } else resolve();
    });
  }

  /* ---------- state + router ---------- */

  let SITES = [];
  let TUNNEL = { status: "off", url: null, error: null };
  let tunnelPoll = null;

  function currentRoute() {
    const h = location.hash || "#/";
    const m = h.match(/^#\/site\/([a-z0-9-]+)/);
    return m ? { view: "site", name: m[1] } : { view: "overview" };
  }

  window.addEventListener("hashchange", render);

  async function refresh() {
    const res = await api("api/sites");
    if (!res.ok) return;
    SITES = res.sites;
    TUNNEL = res.tunnel || TUNNEL;
    $("#domain-chip").textContent = `*.${res.baseDomain}:${res.port}`;
    render();
    renderTunnel();
  }

  function render() {
    const r = currentRoute();
    $("#view-overview").hidden = r.view !== "overview";
    $("#view-site").hidden = r.view !== "site";
    if (r.view === "overview") renderOverview();
    else renderSiteDetail(r.name);
  }

  /* ---------- tunnel (Go public) ---------- */

  function renderTunnel() {
    const box = $("#tunnel-box");
    box.replaceChildren();
    if (TUNNEL.status === "on" && TUNNEL.url) {
      const a = el("a", "tunnel-url", TUNNEL.url.replace(/^https?:\/\//, ""));
      a.href = TUNNEL.url; a.target = "_blank"; a.rel = "noopener";
      a.title = "Your public URL — click to open, sites are at /s/<name>/";
      const stop = el("button", "btn btn-sm", "Stop");
      stop.addEventListener("click", () => setTunnel("stop"));
      box.append(el("span", "dot ok"), a, stop);
    } else if (TUNNEL.status === "starting") {
      box.append(el("span", "dot busy"), el("span", "muted", "opening tunnel…"));
    } else {
      const go = el("button", "btn btn-sm btn-primary", "⚡ Go public");
      go.title = "Open a free public URL for your sites (localhost.run tunnel)";
      go.addEventListener("click", () => setTunnel("start"));
      box.append(go);
      if (TUNNEL.status === "error" && TUNNEL.error) {
        box.append(el("span", "tunnel-err", TUNNEL.error));
      }
    }
  }

  async function setTunnel(action) {
    const res = await api("api/tunnel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (res.ok) { TUNNEL = res; renderTunnel(); }
    clearInterval(tunnelPoll);
    if (action === "start") {
      tunnelPoll = setInterval(async () => {
        const t = await api("api/tunnel");
        if (t.ok) {
          TUNNEL = t; renderTunnel();
          if (t.status === "on") { toast("Public at " + t.url + " — sites at /s/<name>/ ✔", "ok"); refresh(); }
          if (t.status !== "starting") clearInterval(tunnelPoll);
        }
      }, 1500);
    } else {
      refresh();
    }
  }

  /* ---------- deploy actions (shared) ---------- */

  async function deployPayload(site, payload) {
    return api(`api/sites/${site}/deploy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  async function deployZip(site, file) {
    return api(`api/sites/${site}/deploy`, {
      method: "POST", headers: { "Content-Type": "application/zip" }, body: file
    });
  }
  async function afterDeploy(site, res) {
    if (res.ok) toast(`${site} published — ${res.files} files, ${fmtBytes(res.bytes)} ✔`, "ok");
    else toast(res.error || "Deploy failed", "err");
    await refresh();
  }

  function makeDropzone(site) {
    const zone = el("div", "dropzone");
    function idle() {
      zone.classList.remove("busy");
      zone.replaceChildren();
      zone.appendChild(el("div", "dz-big", "Drag & drop to deploy " + site));
      const line = el("div");
      line.append("folder or .zip — or ");
      const pickF = el("button", "linkish", "choose folder");
      pickF.type = "button";
      const pickZ = el("button", "linkish", "choose .zip");
      pickZ.type = "button";
      line.append(pickF, " / ", pickZ);
      zone.appendChild(line);

      pickF.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.webkitdirectory = true;
        inp.addEventListener("change", async () => {
          const list = [...inp.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
          if (!list.length) return;
          busy("Uploading…");
          try { await afterDeploy(site, await deployPayload(site, await filesToPayload(stripCommonRoot(list)))); }
          catch (e) { toast(e.message, "err"); idle(); }
        });
        inp.click();
      });
      pickZ.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = ".zip";
        inp.addEventListener("change", async () => {
          if (!inp.files[0]) return;
          busy("Uploading zip…");
          await afterDeploy(site, await deployZip(site, inp.files[0]));
        });
        inp.click();
      });
    }
    function busy(txt) { zone.classList.add("busy"); zone.textContent = txt; }
    idle();

    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const items = [...(e.dataTransfer.items || [])];
      const plain = [...(e.dataTransfer.files || [])];
      if (plain.length === 1 && /\.zip$/i.test(plain[0].name)) {
        busy("Uploading zip…");
        await afterDeploy(site, await deployZip(site, plain[0]));
        return;
      }
      const out = [];
      try {
        const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
        if (entries.length) for (const en of entries) await walkEntry(en, "", out);
        else for (const f of plain) out.push({ path: f.name, file: f });
        if (!out.length) { toast("Nothing droppable found", "err"); return; }
        busy(`Uploading ${out.length} files…`);
        await afterDeploy(site, await deployPayload(site, await filesToPayload(stripCommonRoot(out))));
      } catch (err) {
        toast(err.message || "Drop failed", "err");
        idle();
      }
    });
    return zone;
  }

  /* ---------- overview ---------- */

  function statusOf(s) {
    if (!s.lastDeploy) return { cls: "none", label: "No deploys yet" };
    if (s.lastDeploy.status === "failed") return { cls: "bad", label: "Last deploy failed · " + fmtAgo(s.lastDeploy.at) };
    return { cls: "ok", label: "Published · " + fmtAgo(s.lastDeploy.at) };
  }

  function renderOverview() {
    const grid = $("#sites-grid");
    grid.replaceChildren();
    for (const s of SITES) {
      const tile = el("article", "card site-tile");
      tile.appendChild(avatar(s.name, "sm"));
      const body = el("div", "tile-body");
      const nameRow = el("div", "tile-name-row");
      const st = statusOf(s);
      nameRow.append(el("span", "tile-name", s.name), el("span", "dot " + st.cls));
      body.appendChild(nameRow);
      const dom = el("a", "tile-domain", s.urls.domain.replace(/^https?:\/\//, ""));
      dom.href = s.urls.domain; dom.target = "_blank"; dom.rel = "noopener";
      dom.addEventListener("click", (e) => e.stopPropagation());
      body.appendChild(dom);
      const meta = el("div", "tile-meta");
      meta.append(st.label);
      if (s.repo) { meta.append(el("span", "sep", "·"), "⑂ " + s.repo); }
      body.appendChild(meta);
      tile.appendChild(body);
      tile.addEventListener("click", () => { location.hash = "#/site/" + s.name; });
      grid.appendChild(tile);
    }
    $("#sites-empty").hidden = SITES.length > 0;
    $("#sites-summary").textContent = SITES.length ? `${SITES.length} site${SITES.length > 1 ? "s" : ""}` : "";
    loadActivity();
  }

  async function loadActivity() {
    const res = await api("api/activity");
    const sec = $("#activity-section");
    if (!res.ok || !res.activity.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const list = $("#activity-list");
    list.replaceChildren();
    for (const a of res.activity) {
      const row = el("div", "activity-row");
      row.appendChild(el("span", "dot " + (a.status === "failed" ? "bad" : "ok")));
      const site = el("span", "site-ref", a.site);
      site.addEventListener("click", () => { location.hash = "#/site/" + a.site; });
      row.appendChild(site);
      const msg = a.status === "failed"
        ? `deploy failed (${a.source}) — ${a.error || "unknown error"}`
        : `published from ${a.source}${a.meta && a.meta.repo ? " · " + a.meta.repo + "@" + (a.meta.branch || "") : ""} · ${a.files} files · ${fmtBytes(a.bytes)}`;
      row.appendChild(el("span", "grow", msg));
      row.appendChild(el("span", "when", fmtAgo(a.at)));
      list.appendChild(row);
    }
  }

  /* ---------- new site form ---------- */

  $("#new-site-toggle").addEventListener("click", () => {
    const p = $("#new-site-panel");
    p.hidden = !p.hidden;
    if (!p.hidden) $("#ns-name").focus();
  });

  $("#new-site-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = $("#ns-note");
    const btn = $("#ns-submit");
    btn.disabled = true;
    note.className = "form-note";
    note.textContent = $("#ns-repo").value.trim() ? "Creating site and pulling from GitHub…" : "Creating site…";
    const res = await api("api/sites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#ns-name").value.trim().toLowerCase(),
        repo: $("#ns-repo").value.trim(),
        branch: $("#ns-branch").value.trim(),
        token: $("#ns-token").value.trim()
      })
    });
    btn.disabled = false;
    if (res.ok) {
      if (res.warning) { note.className = "form-note err"; note.textContent = res.warning; }
      else if (res.deployed) { note.className = "form-note ok"; note.textContent = `Live! ${res.deployed.files} files → ${res.site.urls.domain}`; }
      else { note.className = "form-note ok"; note.textContent = "Site created — open it and drop files to go live."; }
      e.target.reset();
      await refresh();
      if (!res.warning) { $("#new-site-panel").hidden = true; location.hash = "#/site/" + res.site.name; }
    } else {
      note.className = "form-note err";
      note.textContent = res.error;
    }
  });

  /* ---------- site detail ---------- */

  function renderSiteDetail(name) {
    const s = SITES.find((x) => x.name === name);
    const host = $("#site-detail");
    host.replaceChildren();
    if (!s) { host.appendChild(el("p", "muted", "No such site.")); return; }

    // header
    const head = el("div", "site-header");
    head.appendChild(avatar(s.name, "lg"));
    const tw = el("div", "title-wrap");
    tw.appendChild(el("h2", "", s.name));
    const sub = el("div", "sub-row");
    const st = statusOf(s);
    sub.append(el("span", "dot " + st.cls), st.label);
    if (s.repo) sub.append(" · ⑂ " + s.repo + (s.branch ? "@" + s.branch : ""));
    tw.appendChild(sub);
    head.appendChild(tw);
    const actions = el("div", "head-actions");
    const open = el("a", "btn btn-primary", "Open site ↗");
    open.href = s.urls.domain; open.target = "_blank"; open.rel = "noopener";
    actions.appendChild(open);
    if (s.urls.public) {
      const pub = el("a", "btn", "Public URL ↗");
      pub.href = s.urls.public; pub.target = "_blank"; pub.rel = "noopener";
      actions.appendChild(pub);
    }
    head.appendChild(actions);
    host.appendChild(head);

    // dropzone hero
    host.appendChild(makeDropzone(s.name));

    // two columns
    const grid = el("div", "detail-grid");
    const left = el("div", "detail-col");
    const right = el("div", "detail-col");
    grid.append(left, right);
    host.appendChild(grid);

    /* --- deploys feed --- */
    const depCard = el("section", "card deploy-list");
    depCard.appendChild(el("h3", "panel-title", "Deploys"));
    const depBody = el("div");
    depBody.appendChild(el("p", "muted", "Loading…"));
    depCard.appendChild(depBody);
    left.appendChild(depCard);

    api(`api/sites/${s.name}/deploys`).then((res) => {
      depBody.replaceChildren();
      if (!res.ok) { depBody.appendChild(el("p", "muted", res.error)); return; }
      if (!res.deploys.length) { depBody.appendChild(el("p", "muted", "No deploys yet — drop files above.")); return; }
      for (const d of res.deploys) {
        const item = el("div", "deploy-item");
        const main = el("div", "d-main");
        const l1 = el("div", "d-line1");
        l1.appendChild(el("span", "status-pill " + (d.status === "failed" ? "failed" : d.active ? "published" : "old"),
          d.status === "failed" ? "Failed" : d.active ? "Published" : "Ready"));
        l1.appendChild(el("span", "d-src", d.source));
        if (d.meta && d.meta.repo) l1.appendChild(el("span", "muted", d.meta.repo + "@" + (d.meta.branch || "")));
        main.appendChild(l1);
        if (d.status === "failed") {
          main.appendChild(el("div", "d-err", d.error || "unknown error"));
        } else {
          main.appendChild(el("div", "d-detail", `${d.files} files · ${fmtBytes(d.bytes)} · ${d.id}`));
        }
        item.appendChild(main);
        item.appendChild(el("span", "when", fmtAgo(d.at)));
        if (d.active) item.appendChild(el("span", "live-tag", "● LIVE"));
        else if (d.status === "ready") {
          const rb = el("button", "btn btn-sm", "Restore");
          rb.addEventListener("click", async () => {
            const r = await api(`api/sites/${s.name}/rollback`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: d.id })
            });
            if (r.ok) { toast(`${s.name} restored to ${d.id} ✔`, "ok"); refresh(); }
            else toast(r.error, "err");
          });
          item.appendChild(rb);
        }
        depBody.appendChild(item);
      }
    });

    /* --- github panel --- */
    const gh = el("section", "card");
    gh.appendChild(el("h3", "panel-title", "GitHub"));
    const ghStack = el("div", "stack");
    if (s.repo) {
      ghStack.appendChild(el("div", "panel-sub", `Connected to ${s.repo}${s.branch ? "@" + s.branch : ""}${s.hasToken ? " (private token saved)" : ""}`));
      const re = el("button", "btn btn-primary", "⟳ Redeploy from GitHub");
      re.addEventListener("click", async () => {
        re.disabled = true; re.textContent = "Pulling repo…";
        const res = await api(`api/sites/${s.name}/github`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
        if (res.ok) { toast(`${s.name} published from ${s.repo} ✔`, "ok"); refresh(); }
        else { toast(res.error, "err"); refresh(); }
      });
      ghStack.appendChild(re);
      ghStack.appendChild(el("div", "panel-sub", "Push to GitHub, then hit redeploy to ship it."));
    } else {
      ghStack.appendChild(el("div", "panel-sub", "Connect a repository — vdkify pulls it and deploys on demand."));
    }
    const rowRepo = el("div", "row");
    const inRepo = el("input", "input");
    inRepo.placeholder = s.repo ? "change repo: owner/repo" : "owner/repo or github.com URL";
    rowRepo.appendChild(inRepo);
    const rowOpts = el("div", "row");
    const inBranch = el("input", "input");
    inBranch.placeholder = "branch (default)";
    const inTok = el("input", "input");
    inTok.type = "password";
    inTok.placeholder = "token (private repos)";
    rowOpts.append(inBranch, inTok);
    const connect = el("button", "btn", s.repo ? "Update & redeploy" : "Connect & deploy");
    connect.addEventListener("click", async () => {
      if (!inRepo.value.trim() && !s.repo) return;
      connect.disabled = true; connect.textContent = "Pulling repo…";
      const body = { branch: inBranch.value.trim() };
      if (inRepo.value.trim()) body.repo = inRepo.value.trim();
      else body.repo = s.repo;
      if (inTok.value.trim()) body.token = inTok.value.trim();
      const res = await api(`api/sites/${s.name}/github`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.ok) { toast(`${s.name} published from GitHub ✔`, "ok"); }
      else toast(res.error, "err");
      refresh();
    });
    ghStack.append(rowRepo, rowOpts, connect);
    gh.appendChild(ghStack);
    right.appendChild(gh);

    /* --- domains panel --- */
    const dom = el("section", "card");
    dom.appendChild(el("h3", "panel-title", "Domains"));
    const dl = el("div", "domain-list");
    const d1 = el("div");
    d1.appendChild(el("span", "tag", "domain"));
    const a1 = el("a", "", s.urls.domain);
    a1.href = s.urls.domain; a1.target = "_blank"; a1.rel = "noopener";
    d1.appendChild(a1);
    dl.appendChild(d1);
    const d2 = el("div");
    d2.appendChild(el("span", "tag", "path"));
    const a2 = el("a", "", s.urls.path);
    a2.href = s.urls.path; a2.target = "_blank"; a2.rel = "noopener";
    d2.appendChild(a2);
    dl.appendChild(d2);
    if (s.urls.public) {
      const d3 = el("div");
      d3.appendChild(el("span", "tag", "public"));
      const a3 = el("a", "", s.urls.public);
      a3.href = s.urls.public; a3.target = "_blank"; a3.rel = "noopener";
      d3.appendChild(a3);
      dl.appendChild(d3);
    } else {
      const d3 = el("div", "panel-sub");
      d3.textContent = "Hit “⚡ Go public” in the top bar to get an internet URL for this site.";
      dl.appendChild(d3);
    }
    dom.appendChild(dl);
    right.appendChild(dom);

    /* --- env panel --- */
    const envc = el("section", "card");
    envc.appendChild(el("h3", "panel-title", "Environment variables"));
    const envSub = el("div", "panel-sub");
    envSub.append("Your site reads these at runtime — no rebuild. Include ");
    envSub.appendChild(el("code", "code", '<script src="/__env.js">'));
    envSub.append(" then use ");
    envSub.appendChild(el("code", "code", "window.ENV.KEY"));
    envSub.append(" (JSON at ");
    envSub.appendChild(el("code", "code", "/__env.json"));
    envSub.append(").");
    envc.appendChild(envSub);
    const ta = el("textarea", "env-editor");
    ta.placeholder = "API_URL=https://api.example.com\nFEATURE_FLAG=on";
    ta.spellcheck = false;
    envc.appendChild(ta);
    const saveRow = el("div", "row");
    const saveEnv = el("button", "btn btn-primary btn-sm", "Save env");
    saveRow.appendChild(saveEnv);
    if (s.envCount) saveRow.appendChild(el("span", "muted", s.envCount + " saved"));
    envc.appendChild(saveRow);
    api(`api/sites/${s.name}/env`).then((res) => {
      if (res.ok) ta.value = Object.entries(res.env).map(([k, v]) => `${k}=${v}`).join("\n");
    });
    saveEnv.addEventListener("click", async () => {
      const env = {};
      for (const raw of ta.value.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) { toast(`Bad line: "${line}" — use KEY=value`, "err"); return; }
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      const res = await api(`api/sites/${s.name}/env`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env })
      });
      if (res.ok) { toast(`${s.name}: ${res.count} env vars live ✔`, "ok"); refresh(); }
      else toast(res.error, "err");
    });
    right.appendChild(envc);

    /* --- danger zone --- */
    const danger = el("section", "card");
    danger.appendChild(el("h3", "panel-title", "Danger zone"));
    const delBtn = el("button", "btn btn-danger btn-sm", "Delete this site");
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete "${s.name}" and all its deploys? This can't be undone.`)) return;
      const res = await api(`api/sites/${s.name}`, { method: "DELETE" });
      if (res.ok) { toast(`${s.name} deleted`, "ok"); location.hash = "#/"; refresh(); }
      else toast(res.error, "err");
    });
    danger.appendChild(delBtn);
    right.appendChild(danger);
  }

  /* ---------- boot ---------- */

  (async () => {
    const status = await fetch("api/status", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (!status) { toast("Can't reach the server", "err"); return; }
    if (status.needsSetup || !token()) { location.replace("login.html"); return; }
    const sess = await api("api/session");
    if (!sess.ok) return;
    await refresh();
    setInterval(refresh, 20000); // keep "x min ago" and statuses fresh
  })();
})();
