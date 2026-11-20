// Deck editing API: names per visitor IP, saved versions in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const store = () => getStore({ name: "deck-edits", consistency: "strong" });
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

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
      if (!key) return json({ version: null, changes: {} });
      const v = (await s.get(key, { type: "json" })) as Record<string, unknown> | null;
      if (!v) return json({ version: null, changes: {} });
      const { changes, ip: _ip, ...meta } = v as any;
      return json({ version: meta, changes: changes ?? {} });
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

    if (route.startsWith("version/") && req.method === "GET") {
      const id = route.slice("version/".length);
      if (!/^[0-9]{15}-[a-z0-9]{6}$/.test(id)) return json({ error: "Bad id" }, 400);
      const v = (await s.get("versions/" + id, { type: "json" })) as any;
      if (!v) return json({ error: "Not found" }, 404);
      const { ip: _ip, ...rest } = v;
      return json(rest);
    }

    if (route === "save" && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 3_000_000) return json({ error: "Too large" }, 413);
      const body = JSON.parse(raw || "{}");
      const changes = body.changes && typeof body.changes === "object" ? body.changes : {};
      const person = (await s.get(personKey, { type: "json" })) as { name?: string } | null;
      const name = clean(body.name || person?.name || "Unknown", 60);
      const note = clean(body.note, 140);
      const edited = Array.isArray(body.edited) ? body.edited.map((x: unknown) => clean(x, 80)).slice(0, 12) : [];
      const time = new Date().toISOString();
      const id = String(Date.now()).padStart(15, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
      const count = Object.keys(changes).length;
      const meta = { name, time, count, note, edited: edited.slice(0, 6).join(" | ").slice(0, 600) };
      await s.setJSON("versions/" + id, { id, ip, changes, ...meta }, { metadata: meta });
      return json({ id, ...meta });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
};

export const config: Config = { path: "/api/*" };
