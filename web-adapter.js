/* FOMO website adapter.
   The app was written against a small document-database API (doc().set/update/onSnapshot,
   collection().onSnapshot, user.id(), assets.upload()). This file provides the same API on top of
   Supabase: one "docs" table (path -> JSON), Supabase Auth for accounts, Storage for photos,
   and Realtime so everyone sees changes live. Access rules live in the database (see 1-setup.sql). */
(function () {
  const cfg = window.FOMO_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || !window.supabase) { window.FOMO_WEB_ERROR = "FOMO isn’t connected to its database yet."; return; }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  window.__sb = sb;

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const parentOf = (p) => p.replace(/\/[^/]+$/, "");
  const cache = {};                 // path -> data (only paths we've loaded or subscribed to)
  const docSubs = {}, collSubs = {}; // path/coll -> [fn]
  const collWatched = new Set(), docWatched = new Set();

  const snapDoc = (p) => ({ id: p.split("/").pop(), exists: p in cache, data: () => clone(cache[p]), metadata: { fromCache: false, hasPendingWrites: false } });
  const snapColl = (c) => {
    const docs = Object.keys(cache).filter((p) => parentOf(p) === c).sort().map(snapDoc);
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
  };
  function emit(p) {
    (docSubs[p] || []).forEach((f) => { try { f(snapDoc(p)); } catch (e) { console.error(e); } });
    const c = parentOf(p);
    (collSubs[c] || []).forEach((f) => { try { f(snapColl(c)); } catch (e) { console.error(e); } });
  }
  const errOf = (error) => {
    const msg = (error && (error.message || error.code)) || "error";
    const e = new Error(msg);
    e.code = /row-level security|permission|42501|JWT/i.test(msg + (error && error.code)) ? "permission_denied" : /quota|limit/i.test(msg) ? "quota_exceeded" : "unavailable";
    return e;
  };

  async function loadColl(c) {
    const rows = []; let from = 0;
    for (;;) {
      const { data, error } = await sb.from("docs").select("path,data").eq("coll", c).range(from, from + 999);
      if (error) throw errOf(error);
      rows.push(...data); if (data.length < 1000) break; from += 1000;
    }
    Object.keys(cache).forEach((p) => { if (parentOf(p) === c) delete cache[p]; });
    rows.forEach((r) => { cache[r.path] = r.data; });
  }
  async function loadDoc(p) {
    const { data, error } = await sb.from("docs").select("path,data").eq("path", p).maybeSingle();
    if (error) throw errOf(error);
    if (data) cache[p] = data.data; else delete cache[p];
  }
  async function refreshAll() {
    await Promise.all([...collWatched].map((c) => loadColl(c).then(() => { const s = snapColl(c); (collSubs[c] || []).forEach((f) => f(s)); }).catch(() => {})));
    await Promise.all([...docWatched].map((p) => loadDoc(p).then(() => emit(p)).catch(() => {})));
  }

  /* Realtime: one channel for the whole table; the database only sends rows this person may read.
     Re-subscribe whenever the signed-in person changes so private rows start/stop arriving. */
  let channel = null;
  function subscribeLive() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("docs-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (payload) => {
        if (payload.eventType === "DELETE") { const p = payload.old && payload.old.path; if (p && p in cache) { delete cache[p]; emit(p); } return; }
        const row = payload.new; if (!row || !row.path) return;
        const p = row.path;
        if (collWatched.has(parentOf(p)) || docWatched.has(p)) { cache[p] = row.data; emit(p); }
      })
      .subscribe((status) => { if (status === "SUBSCRIBED") refreshAll(); });
  }

  function docRef(p) {
    return {
      id: p.split("/").pop(), path: p,
      get: async () => { await loadDoc(p); return snapDoc(p); },
      set: async (d) => {
        const data = clone(d);
        const { error } = await sb.from("docs").upsert({ path: p, data, updated_at: new Date().toISOString() });
        if (error) throw errOf(error);
        cache[p] = data; emit(p);
      },
      update: async (d) => {
        if (!(p in cache)) await loadDoc(p);
        if (!(p in cache)) { const e = new Error("not found"); e.code = "not_found"; throw e; }
        const data = Object.assign(clone(cache[p]) || {}, clone(d));
        const { error } = await sb.from("docs").update({ data, updated_at: new Date().toISOString() }).eq("path", p);
        if (error) throw errOf(error);
        cache[p] = data; emit(p);
      },
      delete: async () => { const { error } = await sb.from("docs").delete().eq("path", p); if (error) throw errOf(error); delete cache[p]; emit(p); },
      onSnapshot: (next, onErr) => {
        (docSubs[p] = docSubs[p] || []).push(next); docWatched.add(p);
        loadDoc(p).then(() => next(snapDoc(p)), (e) => onErr && onErr(e));
        return () => { docSubs[p] = (docSubs[p] || []).filter((f) => f !== next); };
      },
      collection: (c) => collRef(p + "/" + c),
    };
  }
  function collRef(c) {
    return {
      path: c,
      doc: (id) => docRef(c + "/" + (id || Math.random().toString(36).slice(2))),
      get: async () => { await loadColl(c); return snapColl(c); },
      onSnapshot: (next, onErr) => {
        (collSubs[c] = collSubs[c] || []).push(next); collWatched.add(c);
        loadColl(c).then(() => next(snapColl(c)), (e) => onErr && onErr(e));
        return () => { collSubs[c] = (collSubs[c] || []).filter((f) => f !== next); };
      },
      where() { return this; }, orderBy() { return this; }, limit() { return this; },
    };
  }
  const db = { doc: docRef, collection: collRef };

  let session = null;
  const user = {
    id: async () => (session && session.user && session.user.id) || null,
    isOwner: async () => { if (!session) return false; const { data } = await sb.rpc("is_admin"); return !!data; },
    canEdit: async () => user.isOwner(),
    can: async () => !!session,
    me: async () => (session ? { id: session.user.id } : null),
  };
  const assets = {
    upload: async (blob) => {
      const uid = session && session.user.id; if (!uid) throw new Error("Log in to upload.");
      const ext = (blob.type && blob.type.split("/")[1]) || "jpg";
      const name = uid + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext.replace("jpeg", "jpg");
      const { error } = await sb.storage.from("media").upload(name, blob, { contentType: blob.type || "image/jpeg", upsert: false });
      if (error) throw errOf(error);
      const { data } = sb.storage.from("media").getPublicUrl(name);
      return { id: name, url: data.publicUrl, sizeBytes: blob.size, contentType: blob.type };
    },
  };

  /* Accounts. Sign-up uses the UCL email + password; log-in accepts the username or the email. */
  const listeners = [];
  const auth = {
    current: () => (session ? session.user.id : null),
    email: () => (session ? session.user.email : null),
    onChange: (f) => listeners.push(f),
    usernameTaken: async (u) => { const { data } = await sb.rpc("username_taken", { uname: u }); return !!data; },
    signUp: async (email, password, username) => {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) {
        if (/registered|exists/i.test(error.message)) throw new Error("An account with this email already exists. Log in instead.");
        if (/rate|limit/i.test(error.message)) throw new Error("Too many sign-ups right now. Wait a minute and try again.");
        throw new Error(error.message);
      }
      if (!data.session) throw new Error("Sign-up needs email confirmation turned off in Supabase (Authentication → Email → Confirm email). Ask the FOMO admin.");
      session = data.session;
      const { error: e2 } = await sb.from("docs").upsert({ path: "logins/" + session.user.id, data: { username, email } });
      if (e2) {
        if (/duplicate|unique/i.test(e2.message)) throw new Error("@" + username + " is taken. Try another.");
        throw new Error(e2.message);
      }
      return session.user.id;
    },
    signIn: async (identifier, password) => {
      let email = identifier.trim();
      if (email.indexOf("@") < 0) {
        const { data, error } = await sb.rpc("login_email", { uname: email.replace(/^@/, "") });
        if (error || !data) throw Object.assign(new Error("No account with that username. Create one below."), { field: "username" });
        email = data;
      }
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw Object.assign(new Error(/invalid/i.test(error.message) ? "That password doesn’t match this account." : error.message), { field: "password" });
      session = data.session;
      return session.user.id;
    },
    signOut: async () => { await sb.auth.signOut(); session = null; },
  };

  sb.auth.onAuthStateChange((event, s) => {
    const before = session && session.user.id;
    session = s;
    const after = s && s.user.id;
    if (before !== after) { subscribeLive(); listeners.forEach((f) => { try { f(after); } catch (e) { console.error(e); } }); }
  });

  const ready = sb.auth.getSession().then(({ data }) => { session = data.session; subscribeLive(); });
  window.FOMO_AUTH = auth;
  window.claude = { use: async (name) => { await ready; return { db, user, assets }[name] || null; } };
})();
