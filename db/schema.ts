import { pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial().primaryKey(),
  usernameKey: text("username_key").notNull().unique(),
  username: text().notNull(),
  passwordHash: text("password_hash").notNull(),
  salt: text().notNull(),
  robloxUser: text("roblox_user").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const trades = pgTable("trades", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  offering: jsonb().notNull(),
  wanting: jsonb().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tradeOffers = pgTable(
  "trade_offers",
  {
    id: serial().primaryKey(),
    tradeId: integer("trade_id").notNull().references(() => trades.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [uniqueIndex("trade_offers_trade_user").on(t.tradeId, t.userId)]
);
