import type { Config } from "@netlify/functions";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, tradeOffers, trades, users } from "../../db/schema.js";

type User = typeof users.$inferSelect;
type Item = { name: string; badges: { t: string; c: string }[]; v: number };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: string, status = 400) => json({ error }, status);

const hashPassword = (pw: string, salt: string) => scryptSync(pw, salt, 64).toString("hex");

const publicUser = (u: User) => ({ username: u.username, robloxUser: u.robloxUser });

const cleanRoblox = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/^@/, "")
    .slice(0, 40);

async function currentUser(req: Request): Promise<User | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);
  return rows[0]?.user ?? null;
}

async function newSession(userId: number) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ token, userId });
  return token;
}

function cleanItems(raw: unknown): Item[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 9) return null;
  const out: Item[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") return null;
    const name = String((it as any).name ?? "").slice(0, 80);
    const v = Number((it as any).v);
    if (!name || !Number.isFinite(v) || v < 0 || v > 100000) return null;
    const badgesRaw = Array.isArray((it as any).badges) ? (it as any).badges.slice(0, 8) : [];
    const badges = badgesRaw.map((b: any) => ({
      t: String(b?.t ?? "").slice(0, 30),
      c: /^p-[a-z]{2,4}$/.test(String(b?.c ?? "")) ? String(b.c) : "p-nrm",
    }));
    out.push({ name, badges, v });
  }
  return out;
}

async function listTrades() {
  const offerCounts = db
    .select({ tradeId: tradeOffers.tradeId, n: count().as("n") })
    .from(tradeOffers)
    .groupBy(tradeOffers.tradeId)
    .as("oc");
  const rows = await db
    .select({
      id: trades.id,
      off: trades.offering,
      want: trades.wanting,
      createdAt: trades.createdAt,
      trader: users.username,
      robloxUser: users.robloxUser,
      offers: offerCounts.n,
    })
    .from(trades)
    .innerJoin(users, eq(trades.userId, users.id))
    .leftJoin(offerCounts, eq(offerCounts.tradeId, trades.id))
    .orderBy(desc(trades.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, offers: Number(r.offers ?? 0) }));
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  try {
    // POST /api/auth — sign in, or create the account if the username is new
    if (parts[0] === "auth" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const robloxUser = cleanRoblox(body.robloxUser);
      if (username.length < 3 || username.length > 24) return fail("Username must be 3–24 characters.");
      if (!/^[A-Za-z0-9_.-]+$/.test(username)) return fail("Username may only use letters, numbers, _ . -");
      if (password.length < 4) return fail("Password must be at least 4 characters.");
      const key = username.toLowerCase();

      const [existing] = await db.select().from(users).where(eq(users.usernameKey, key)).limit(1);
      let user: User;
      if (existing) {
        const a = Buffer.from(hashPassword(password, existing.salt), "hex");
        const b = Buffer.from(existing.passwordHash, "hex");
        if (a.length !== b.length || !timingSafeEqual(a, b)) return fail("Incorrect password for existing account.", 401);
        user = existing;
        if (robloxUser && robloxUser !== existing.robloxUser) {
          [user] = await db.update(users).set({ robloxUser }).where(eq(users.id, existing.id)).returning();
        }
      } else {
        const salt = randomBytes(16).toString("hex");
        [user] = await db
          .insert(users)
          .values({ usernameKey: key, username, salt, passwordHash: hashPassword(password, salt), robloxUser })
          .returning();
      }
      return json({ token: await newSession(user.id), user: publicUser(user) });
    }

    // GET /api/trades — public list
    if (parts[0] === "trades" && parts.length === 1 && method === "GET") {
      return json(await listTrades());
    }

    // Everything below requires a signed-in user
    const me = await currentUser(req);

    if (parts[0] === "me") {
      if (!me) return fail("Not signed in.", 401);
      if (method === "GET") return json(publicUser(me));
      if (method === "PATCH") {
        const body = await req.json().catch(() => ({}));
        const [u] = await db
          .update(users)
          .set({ robloxUser: cleanRoblox(body.robloxUser) })
          .where(eq(users.id, me.id))
          .returning();
        return json(publicUser(u));
      }
    }

    if (parts[0] === "logout" && method === "POST") {
      const token = (req.headers.get("authorization") || "").slice(7);
      if (token) await db.delete(sessions).where(eq(sessions.token, token));
      return json({ ok: true });
    }

    if (parts[0] === "trades") {
      if (!me) return fail("Sign in to use the Trade Center.", 401);

      if (parts.length === 1 && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const off = cleanItems(body.off);
        const want = cleanItems(body.want);
        if (!off || !want) return fail("Each side needs 1–9 valid Loomians.");
        await db.insert(trades).values({ userId: me.id, offering: off, wanting: want });
        return json(await listTrades(), 201);
      }

      const id = Number(parts[1]);
      if (!Number.isInteger(id)) return fail("Not found", 404);
      const [trade] = await db.select().from(trades).where(eq(trades.id, id)).limit(1);
      if (!trade) return fail("Trade not found.", 404);

      if (parts.length === 2 && method === "DELETE") {
        if (trade.userId !== me.id) return fail("You can only delete your own trades.", 403);
        await db.delete(trades).where(eq(trades.id, id));
        return json(await listTrades());
      }

      if (parts[2] === "offer" && method === "POST") {
        if (trade.userId === me.id) return fail("You can't send an offer on your own trade.");
        const [dup] = await db
          .select({ id: tradeOffers.id })
          .from(tradeOffers)
          .where(and(eq(tradeOffers.tradeId, id), eq(tradeOffers.userId, me.id)))
          .limit(1);
        const already = !!dup;
        if (!already) await db.insert(tradeOffers).values({ tradeId: id, userId: me.id });
        const [owner] = await db.select().from(users).where(eq(users.id, trade.userId)).limit(1);
        return json({ already, robloxUser: owner?.robloxUser ?? "", trades: await listTrades() });
      }
    }

    return fail("Not found", 404);
  } catch (err) {
    console.error(err);
    return fail("Server error. Please try again.", 500);
  }
};

export const config: Config = {
  path: ["/api/auth", "/api/me", "/api/logout", "/api/trades", "/api/trades/*"],
};
