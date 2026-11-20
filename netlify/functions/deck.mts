// Deck editing API: names per visitor IP, saved versions in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const MIN_CLIENT = 6;
const store = () => getStore({ name: "deck-edits", consistency: "strong" });
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function cleanNote(n: any) {
  return {
    id: clean(n?.id, 40).replace(/[^a-z0-9]/gi, ""), sec: clean(n?.sec, 80),
    x: Math.max(0, Math.min(100, Number(n?.x) || 0)), y: Math.max(0, Math.min(100, Number(n?.y) || 0)),
    color: ["pink", "yellow", "green"].includes(n?.color) ? n.color : "pink",
    text: String(n?.text ?? "").slice(0, 2000), by: clean(n?.by, 60), at: clean(n?.at, 40),
  };
}

async function latestKey(s: ReturnType<typeof store>) {
  const { blobs } = await s.list({ prefix: "versions/" });
  const keys = blobs.map(b => b.key).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

export default async (req: Request, context: Context) => {
  const s = store();
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const ip = context.ip || "unknown";
  const personKey = "people/" + encodeURIComponent(ip);

  try {
    if (route === "me" && req.method === "GET") {
      const p = (await s.get(personKey, { type: "json" })) as { name?: string } | null;
      return json({ name: p?.name ?? null });
    }

    if (route === "me" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = clean(body.name, 60);
      if (!name) return json({ error: "Name required" }, 400);
      const prev = (await s.get(personKey, { type: "json" })) as { first?: string } | null;
      const now = new Date().toISOString();
      await s.setJSON(personKey, { name, ip, first: prev?.first ?? now, last: now });
      return json({ name });
    }

    if (route === "content" && req.method === "GET") {
      const key = await latestKey(s);
      if (!key) return json({ minClient: MIN_CLIENT, version: null, changes: {}, pages: [], order: null });
      const v = (await s.get(key, { type: "json" })) as Record<string, unknown> | null;
      if (!v) return json({ minClient: MIN_CLIENT, version: null, changes: {}, pages: [], order: null });
      const { changes, notes, order, ip: _ip, ...meta } = v as any;
      return json({ minClient: MIN_CLIENT, version: meta, changes: changes ?? {}, pages: Array.isArray((v as any).pages) ? (v as any).pages : [], order: Array.isArray(order) ? order : null });
    }

    if (route === "versions" && req.method === "GET") {
      const { blobs } = await s.list({ prefix: "versions/" });
      const keys = blobs.map(b => b.key).sort().reverse().slice(0, 100);
      const metas = await Promise.all(keys.map(async k => {
        const m = await s.getMetadata(k);
        return m ? { id: k.slice("versions/".length), ...(m.metadata as object) } : null;
      }));
      return json({ versions: metas.filter(Boolean) });
    }

    if (route === "notes" && req.method === "GET") {
      let { blobs } = await s.list({ prefix: "notes/" });
      if (!blobs.length && !(await s.get("meta/notes-migrated"))) {
        // Bring across notes saved inside versions before notes had their own store
        const vs = (await s.list({ prefix: "versions/" })).blobs.map(b => b.key).sort().reverse();
        for (const k of vs) {
          const v = (await s.get(k, { type: "json" })) as any;
          if (Array.isArray(v?.notes) && v.notes.length) { for (const n of v.notes) if (n?.id) await s.setJSON("notes/" + n.id, cleanNote(n)); break; }
        }
        await s.set("meta/notes-migrated", "1");
        blobs = (await s.list({ prefix: "notes/" })).blobs;
      }
      const notes = (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })))).filter(Boolean);
      return json({ notes });
    }

    if (route === "note" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const n = cleanNote(body.note);
      if (!n.id || !n.sec) return json({ error: "Bad note" }, 400);
      await s.setJSON("notes/" + n.id, n);
      return json({ ok: true });
    }

    if (route === "note-delete" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = clean(body.id, 40).replace(/[^a-z0-9]/gi, "");
      if (id) await s.delete("notes/" + id);
      return json({ ok: true });
    }

    if (route.startsWith("version/") && req.method === "GET") {
      const id = route.slice("version/".length);
      if (!/^[0-9]{15}-[a-z0-9]{6}$/.test(id)) return json({ error: "Bad id" }, 400);
      const v = (await s.get("versions/" + id, { type: "json" })) as any;
      if (!v) return json({ error: "Not found" }, 404);
      const { ip: _ip, ...rest } = v;
      if (!Array.isArray(rest.notes)) rest.notes = [];
      return json(rest);
    }

    if (route === "save" && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 8_000_000) return json({ error: "Too large" }, 413);
      const body = JSON.parse(raw || "{}");
      if (Array.isArray(body.notes) && !(Number(body.client) >= MIN_CLIENT)) return json({ error: "This page is out of date. Refresh to keep editing." }, 409);
      const changes = body.changes && typeof body.changes === "object" ? body.changes : {};
      const person = (await s.get(personKey, { type: "json" })) as { name?: string } | null;
      const name = clean(body.name || person?.name || "Unknown", 60);
      const note = clean(body.note, 140);
      const edited = Array.isArray(body.edited) ? body.edited.map((x: unknown) => clean(x, 80)).slice(0, 12) : [];
      const time = new Date().toISOString();
      let id = String(Date.now()).padStart(15, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
      let prevEdited: string[] = [];
      if (body.autosave) {
        // Fold quick autosaves by the same person into one history entry
        const lk = await latestKey(s);
        if (lk) {
          const m = (await s.getMetadata(lk))?.metadata as any;
          if (m && m.auto && m.name === name && Date.now() - Date.parse(m.time) < 3 * 60_000) {
            id = lk.slice("versions/".length);
            prevEdited = String(m.edited || "").split(" | ").filter(Boolean);
          }
        }
      }
      const count = Object.keys(changes).length;
      const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 100).map((p: any) => ({
        id: clean(p?.id, 80), html: String(p?.html ?? "").slice(0, 400_000), by: clean(p?.by, 60), at: clean(p?.at, 40),
      })).filter((p: any) => /^pg-[a-z0-9]+$/.test(p.id) && p.html);
      const allEdited = [...prevEdited.filter((x: string) => !edited.includes(x)), ...edited].slice(-6);
      const meta = { name, time, count, pageCount: pages.length, note, auto: !!body.autosave, edited: allEdited.join(" | ").slice(0, 600) };
      const order = Array.isArray(body.order) ? body.order.map((x: unknown) => clean(x, 80)).filter(Boolean).slice(0, 200) : null;
      await s.setJSON("versions/" + id, { id, ip, ...meta, changes, pages, order }, { metadata: meta });
      return json({ id, ...meta });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
};

export const config: Config = { path: "/api/*" };
