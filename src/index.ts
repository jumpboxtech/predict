import { Hono } from "hono";
import { registerSnapHandler } from "@farcaster/snap-hono";

type Env = { DB: D1Database };

const BASE = "https://predict.jumpbox.tech";
const IMG = "https://jumpbox.tech/predict";

async function initDb(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      votes_a INTEGER DEFAULT 0,
      votes_b INTEGER DEFAULT 0,
      resolved TEXT,
      created_at INTEGER NOT NULL,
      resolves_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS votes (
      market_id TEXT NOT NULL,
      fid INTEGER NOT NULL,
      choice TEXT NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (market_id, fid)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS players (
      fid INTEGER PRIMARY KEY,
      correct INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0
    )`),
  ]);
}

type Market = {
  id: string; question: string; option_a: string; option_b: string;
  votes_a: number; votes_b: number; resolved: string | null;
  created_at: number; resolves_at: number;
};

type Player = { fid: number; correct: number; total: number; streak: number; points: number };

async function getOrSeedMarkets(db: D1Database): Promise<Market[]> {
  let markets = (await db.prepare("SELECT * FROM markets WHERE resolved IS NULL ORDER BY resolves_at ASC LIMIT 3").all<Market>()).results || [];

  if (markets.length === 0) {
    const seeds = [
      { q: "Will BTC close above $150K this week?", a: "Yes", b: "No", hours: 168 },
      { q: "Will ETH flip SOL in daily volume this month?", a: "ETH flips", b: "SOL holds", hours: 720 },
      { q: "Will a new L2 launch in the next 7 days?", a: "Yes", b: "No", hours: 168 },
    ];
    const now = Date.now();
    for (const s of seeds) {
      const id = crypto.randomUUID().slice(0, 8);
      await db.prepare("INSERT INTO markets (id, question, option_a, option_b, created_at, resolves_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, s.q, s.a, s.b, now, now + s.hours * 3600000).run();
    }
    markets = (await db.prepare("SELECT * FROM markets WHERE resolved IS NULL ORDER BY resolves_at ASC LIMIT 3").all<Market>()).results || [];
  }
  return markets;
}

async function getPlayer(db: D1Database, fid: number): Promise<Player> {
  const row = await db.prepare("SELECT * FROM players WHERE fid = ?").bind(fid).first<Player>();
  if (row) return row;
  await db.prepare("INSERT OR IGNORE INTO players (fid) VALUES (?)").bind(fid).run();
  return { fid, correct: 0, total: 0, streak: 0, points: 0 };
}

async function getLeaderboard(db: D1Database): Promise<Player[]> {
  return (await db.prepare("SELECT * FROM players ORDER BY points DESC LIMIT 5").all<Player>()).results || [];
}

async function getVote(db: D1Database, marketId: string, fid: number): Promise<string | null> {
  const row = await db.prepare("SELECT choice FROM votes WHERE market_id = ? AND fid = ?").bind(marketId, fid).first<{ choice: string }>();
  return row?.choice ?? null;
}

function feedPage(markets: Market[], player: Player, leaderboard: Player[], votes: Record<string, string | null>) {
  const marketElements: Record<string, object> = {};
  const marketIds: string[] = [];

  for (let i = 0; i < Math.min(markets.length, 3); i++) {
    const m = markets[i];
    const total = m.votes_a + m.votes_b;
    const pctA = total > 0 ? Math.round((m.votes_a / total) * 100) : 50;
    const pctB = 100 - pctA;
    const myVote = votes[m.id];
    const hoursLeft = Math.max(0, Math.round((m.resolves_at - Date.now()) / 3600000));

    const mId = `m-${i}`;
    const chartId = `chart-${i}`;
    const actionsId = `act-${i}`;
    const btnAId = `ba-${i}`;
    const btnBId = `bb-${i}`;
    const timeId = `t-${i}`;
    marketIds.push(mId);

    marketElements[mId] = {
      type: "stack",
      props: { gap: "sm" },
      children: [chartId, ...(myVote ? [timeId] : [actionsId, timeId])],
    };

    marketElements[chartId] = {
      type: "bar_chart",
      props: {
        bars: [
          { label: `${m.option_a} ${pctA}%`, value: m.votes_a || 1, color: "blue" as const },
          { label: `${m.option_b} ${pctB}%`, value: m.votes_b || 1, color: "amber" as const },
        ],
        max: Math.max(m.votes_a, m.votes_b, 1),
      },
    };

    if (!myVote) {
      marketElements[actionsId] = {
        type: "stack",
        props: { direction: "horizontal" as const, gap: "sm" },
        children: [btnAId, btnBId],
      };
      marketElements[btnAId] = {
        type: "button",
        props: { label: m.option_a, variant: "primary" as const },
        on: { press: { action: "submit", params: { target: `${BASE}/?a=vote&m=${m.id}&c=a` } } },
      };
      marketElements[btnBId] = {
        type: "button",
        props: { label: m.option_b, variant: "secondary" as const },
        on: { press: { action: "submit", params: { target: `${BASE}/?a=vote&m=${m.id}&c=b` } } },
      };
    }

    marketElements[timeId] = {
      type: "text",
      props: {
        content: myVote
          ? `You picked: ${myVote === "a" ? m.option_a : m.option_b} · ${hoursLeft}h left`
          : `${m.question} · ${hoursLeft}h left · ${total} votes`,
        size: "sm" as const,
      },
    };
  }

  const lbItems: Record<string, object> = {};
  const lbIds: string[] = [];

  for (let i = 0; i < Math.min(leaderboard.length, 3); i++) {
    const p = leaderboard[i];
    const id = `lb-${i}`;
    lbIds.push(id);
    lbItems[id] = {
      type: "item",
      props: {
        title: `#${i + 1} — FID ${p.fid}`,
        description: `${p.points}pts · ${p.correct}/${p.total} correct${p.streak >= 3 ? " · " + p.streak + " streak" : ""}`,
      },
    };
  }

  return {
    version: "2.0" as const,
    theme: { accent: "amber" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "sm" },
          children: ["banner", "stats", "sep", ...marketIds, ...(lbIds.length ? ["lbsep", "lb"] : []), "share"],
        },
        banner: {
          type: "image",
          props: { url: `${IMG}/predict-banner.png`, aspect: "16:9" as const, alt: "Predict" },
        },
        stats: {
          type: "stack",
          props: { direction: "horizontal" as const, gap: "sm", justify: "between" as const },
          children: ["record", "pts"],
        },
        record: {
          type: "text",
          props: { content: `${player.correct}/${player.total} correct${player.streak >= 3 ? " · " + player.streak + " streak" : ""}`, size: "sm" as const },
        },
        pts: {
          type: "badge",
          props: { label: `${player.points} pts`, color: "amber" as const },
        },
        sep: { type: "separator", props: {} },
        ...marketElements,
        ...(lbIds.length ? {
          lbsep: { type: "separator", props: {} },
          lb: { type: "item_group", props: { separator: true }, children: lbIds },
        } : {}),
        ...lbItems,
        share: {
          type: "button",
          props: { label: "Challenge Friends", variant: "secondary" as const, icon: "share" as const },
          on: {
            press: {
              action: "compose_cast",
              params: { text: `Make your predictions. ${BASE}`, embeds: [BASE] },
            },
          },
        },
      },
    },
  };
}

function votedPage(market: Market, choice: string) {
  const total = market.votes_a + market.votes_b;
  const pctA = total > 0 ? Math.round((market.votes_a / total) * 100) : 50;
  const pctB = 100 - pctA;

  return {
    version: "2.0" as const,
    theme: { accent: "green" as const },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: { gap: "md" },
          children: ["icon", "title", "chart", "back"],
        },
        icon: { type: "icon", props: { name: "check" as const, color: "green" as const } },
        title: {
          type: "text",
          props: { content: `Locked in: ${choice === "a" ? market.option_a : market.option_b}`, weight: "bold" as const },
        },
        chart: {
          type: "bar_chart",
          props: {
            bars: [
              { label: `${market.option_a} ${pctA}%`, value: market.votes_a || 1, color: "blue" as const },
              { label: `${market.option_b} ${pctB}%`, value: market.votes_b || 1, color: "amber" as const },
            ],
          },
        },
        back: {
          type: "button",
          props: { label: "Back to Markets", variant: "primary" as const, icon: "arrow-left" as const },
          on: { press: { action: "submit", params: { target: `${BASE}/?a=feed` } } },
        },
      },
    },
  };
}

const app = new Hono<{ Bindings: Env }>();

let _db: D1Database | null = null;

app.use("*", async (c, next) => {
  _db = c.env.DB;
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; img-src https:;");
});

registerSnapHandler(app, async (ctx) => {
  const db = _db!;
  await initDb(db);

  const url = new URL(ctx.request.url);
  const action = url.searchParams.get("a");

  const fid = ctx.action.type === "get" ? 0 : (ctx.action.user?.fid ?? 0);
  const player = await getPlayer(db, fid);
  const markets = await getOrSeedMarkets(db);
  const leaderboard = await getLeaderboard(db);

  if (action === "vote" && fid > 0) {
    const marketId = url.searchParams.get("m");
    const choice = url.searchParams.get("c");
    if (marketId && (choice === "a" || choice === "b")) {
      const existing = await getVote(db, marketId, fid);
      if (!existing) {
        await db.prepare("INSERT INTO votes (market_id, fid, choice, voted_at) VALUES (?, ?, ?, ?)")
          .bind(marketId, fid, choice, Date.now()).run();
        const col = choice === "a" ? "votes_a" : "votes_b";
        await db.prepare(`UPDATE markets SET ${col} = ${col} + 1 WHERE id = ?`).bind(marketId).run();
        await db.prepare("UPDATE players SET total = total + 1 WHERE fid = ?").bind(fid).run();

        const market = await db.prepare("SELECT * FROM markets WHERE id = ?").bind(marketId).first<Market>();
        if (market) return votedPage(market, choice);
      }
    }
  }

  const votes: Record<string, string | null> = {};
  if (fid > 0) {
    for (const m of markets) {
      votes[m.id] = await getVote(db, m.id, fid);
    }
  }

  return feedPage(markets, player, leaderboard, votes);
});

app.get("/health", (c) => c.json({ status: "ok", snap: "jumpbox-predict" }));

export default app;
