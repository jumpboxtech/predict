import { Hono } from "hono";
import { registerSnapHandler } from "@farcaster/snap-hono";

type Env = { DB: D1Database };

const BASE = "https://predict.jumpbox.tech";
const IMG = "https://jumpbox.tech/predict";
const TREASURY = "0x7c3B6f7863fac4E9d2415b9BD286E22aeb264df4";
const PROTOCOL_FEE_BPS = 1000; // 10%
const BET_AMOUNT = "0.0001"; // ETH
const BET_WEI = "100000000000000"; // 0.0001 ETH in wei
const BASE_CHAIN_ID = 8453;

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
      tx_hash TEXT,
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

// --- Snap Pages ---

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

    // Flat: question text, chart, actions — no wrapper stack
    const qId = `q-${i}`;
    marketElements[qId] = {
      type: "text",
      props: { content: `${m.question}`, size: "sm" as const, weight: "bold" as const },
    };
    marketElements[mId] = {
      type: "stack",
      props: { gap: "sm" },
      children: [qId, chartId, ...(myVote ? [timeId] : [actionsId])],
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
      // Bet buttons open the Mini App with market + choice params
      marketElements[btnAId] = {
        type: "button",
        props: { label: `${m.option_a} (${BET_AMOUNT} ETH)`, variant: "primary" as const, icon: "coins" as const },
        on: { press: { action: "open_mini_app", params: { target: `${BASE}/app?m=${m.id}&c=a` } } },
      };
      marketElements[btnBId] = {
        type: "button",
        props: { label: `${m.option_b} (${BET_AMOUNT} ETH)`, variant: "secondary" as const, icon: "coins" as const },
        on: { press: { action: "open_mini_app", params: { target: `${BASE}/app?m=${m.id}&c=b` } } },
      };
    }

    marketElements[timeId] = {
      type: "text",
      props: {
        content: myVote
          ? `Bet placed: ${myVote === "a" ? m.option_a : m.option_b} · ${hoursLeft}h left`
          : `${m.question} · ${hoursLeft}h · ${total} bets`,
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
        description: `${p.points}pts · ${p.correct}/${p.total}${p.streak >= 3 ? " · " + p.streak + " streak" : ""}`,
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
          children: ["banner", "stats", ...marketIds, "share"],
        },
        banner: { type: "image", props: { url: `${IMG}/predict-banner.png`, aspect: "16:9" as const, alt: "Predict" } },
        stats: {
          type: "stack",
          props: { direction: "horizontal" as const, gap: "sm", justify: "between" as const },
          children: ["record", "pts"],
        },
        record: { type: "text", props: { content: `${player.correct}/${player.total} correct${player.streak >= 3 ? " · " + player.streak + " streak" : ""}`, size: "sm" as const } },
        pts: { type: "badge", props: { label: `${player.points} pts`, color: "amber" as const } },
        ...marketElements,
        ...lbItems,
        share: {
          type: "button",
          props: { label: "Challenge Friends", variant: "secondary" as const, icon: "share" as const },
          on: { press: { action: "compose_cast", params: { text: `Make your predictions. ${BASE}`, embeds: [BASE] } } },
        },
      },
    },
  };
}

// --- Mini App HTML (betting page) ---

function miniAppHtml(marketId: string, choice: string, market: Market | null) {
  const choiceLabel = market ? (choice === "a" ? market.option_a : market.option_b) : choice;
  const question = market?.question ?? "Loading...";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="fc:frame" content='{"version":"1","name":"Predict","iconUrl":"${IMG}/predict-banner.png","homeUrl":"${BASE}/app","splashImageUrl":"${IMG}/predict-banner.png","splashBackgroundColor":"#0a0a14"}'>
  <title>Predict — Place Bet</title>
  <script type="importmap">{"imports":{"@farcaster/miniapp-sdk":"https://cdn.jsdelivr.net/npm/@farcaster/miniapp-sdk@0.3.0/dist/index.js"}}<\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a14; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { max-width: 400px; width: 100%; padding: 32px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .question { color: #8b9ab8; font-size: 14px; margin-bottom: 24px; }
    .choice { display: inline-block; background: #1e3050; color: #f59e0b; padding: 4px 12px; border-radius: 8px; font-size: 13px; font-weight: 600; margin-bottom: 24px; }
    .amount { font-size: 32px; font-weight: 700; font-family: 'SF Mono', monospace; margin-bottom: 4px; }
    .split { color: #5e7190; font-size: 12px; margin-bottom: 32px; }
    button { width: 100%; padding: 14px; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .btn-primary { background: #f59e0b; color: #0a0a14; }
    .btn-primary:hover { background: #fbbf24; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { text-align: center; color: #8b9ab8; font-size: 13px; margin-top: 16px; min-height: 20px; }
    .status.error { color: #ef4444; }
    .status.success { color: #22c55e; }
    .back { display: block; text-align: center; color: #5e7190; font-size: 13px; margin-top: 16px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Place Your Bet</h1>
    <p class="question">${question}</p>
    <div class="choice">${choiceLabel}</div>
    <p class="amount">${BET_AMOUNT} ETH</p>
    <p class="split">90% to treasury · 10% protocol fee · Base network</p>
    <button class="btn-primary" id="bet-btn" onclick="placeBet()">Connect & Bet</button>
    <p class="status" id="status"></p>
  </div>

  <script type="module">
    import { sdk } from "@farcaster/miniapp-sdk";

    const MARKET_ID = "${marketId}";
    const CHOICE = "${choice}";
    const TREASURY = "${TREASURY}";
    const BET_WEI = "${BET_WEI}";
    const BASE_CHAIN = ${BASE_CHAIN_ID};
    const API = "${BASE}";

    let provider = null;
    let account = null;

    try {
      await sdk.actions.ready();
    } catch(e) {
      console.log("SDK ready:", e);
    }

    window.placeBet = placeBet;

    async function placeBet() {
      const btn = document.getElementById("bet-btn");
      const status = document.getElementById("status");
      btn.disabled = true;

      try {
        status.textContent = "Connecting wallet...";
        status.className = "status";

        // Farcaster SDK provides the ethereum provider
        try {
          provider = await sdk.wallet.ethProvider;
        } catch(e) {
          provider = window.ethereum;
        }
        if (!provider) throw new Error("No wallet found. Open this in Farcaster.");

        const accounts = await provider.request({ method: "eth_requestAccounts" });
        account = accounts[0];
        if (!account) throw new Error("No account connected");

        // Switch to Base
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + BASE_CHAIN.toString(16) }] });
        } catch (e) {
          if (e.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [{ chainId: "0x" + BASE_CHAIN.toString(16), chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 } }]
            });
          }
        }

        status.textContent = "Sending " + ${JSON.stringify(BET_AMOUNT)} + " ETH...";

        const txHash = await provider.request({
          method: "eth_sendTransaction",
          params: [{
            from: account,
            to: TREASURY,
            value: "0x" + BigInt(BET_WEI).toString(16),
            chainId: "0x" + BASE_CHAIN.toString(16),
          }],
        });

        status.textContent = "Confirming transaction...";

        // Wait for confirmation
        let confirmed = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
          if (receipt && receipt.status === "0x1") { confirmed = true; break; }
          if (receipt && receipt.status === "0x0") throw new Error("Transaction reverted");
        }
        if (!confirmed) throw new Error("Transaction timed out");

        status.textContent = "Recording bet...";

        // Record the verified bet
        const res = await fetch(API + "/api/bet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marketId: MARKET_ID, choice: CHOICE, txHash, from: account }),
        });

        if (!res.ok) throw new Error("Failed to record bet");

        status.textContent = "Bet placed! Close this to return to the feed.";
        status.className = "status success";
        btn.textContent = "Bet Confirmed";

      } catch (e) {
        status.textContent = e.message || "Something went wrong";
        status.className = "status error";
        btn.disabled = false;
        btn.textContent = "Try Again";
      }
    }
  </script>
</body>
</html>`;
}

// --- Farcaster Mini App Manifest ---

const manifest = {
  accountAssociation: {
    header: "placeholder",
    payload: "placeholder",
    signature: "placeholder",
  },
  frame: {
    version: "1",
    name: "Predict",
    iconUrl: `${IMG}/predict-banner.png`,
    homeUrl: `${BASE}/app`,
    splashImageUrl: `${IMG}/predict-banner.png`,
    splashBackgroundColor: "#0a0a14",
  },
};

// --- Hono App ---

const app = new Hono<{ Bindings: Env }>();

let _db: D1Database | null = null;

app.use("*", async (c, next) => {
  _db = c.env.DB;
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

// Mini App manifest
app.get("/.well-known/farcaster.json", (c) => c.json(manifest));

// Mini App HTML page
app.get("/app", async (c) => {
  const db = _db!;
  await initDb(db);
  const marketId = c.req.query("m") || "";
  const choice = c.req.query("c") || "a";
  let market: Market | null = null;
  if (marketId) {
    market = await db.prepare("SELECT * FROM markets WHERE id = ?").bind(marketId).first<Market>() ?? null;
  }
  return c.html(miniAppHtml(marketId, choice, market));
});

// API: record verified bet
app.post("/api/bet", async (c) => {
  const db = _db!;
  await initDb(db);

  const { marketId, choice, txHash, from } = await c.req.json<{
    marketId: string; choice: string; txHash: string; from: string;
  }>();

  if (!marketId || !choice || !txHash || !from) {
    return c.json({ error: "Missing fields" }, 400);
  }
  if (choice !== "a" && choice !== "b") {
    return c.json({ error: "Invalid choice" }, 400);
  }

  // Verify tx on Base via public RPC
  const txRes = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash],
    }),
  });
  const txData: any = await txRes.json();
  const receipt = txData.result;

  if (!receipt || receipt.status !== "0x1") {
    return c.json({ error: "Transaction not confirmed" }, 400);
  }

  // Verify the tx sent to our treasury
  const txDetailRes = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash],
    }),
  });
  const txDetail: any = await txDetailRes.json();
  const tx = txDetail.result;

  if (!tx || tx.to?.toLowerCase() !== TREASURY.toLowerCase()) {
    return c.json({ error: "Transaction not sent to treasury" }, 400);
  }

  const valueSent = BigInt(tx.value || "0");
  const minValue = BigInt(BET_WEI) * 90n / 100n; // allow slight variance
  if (valueSent < minValue) {
    return c.json({ error: "Insufficient bet amount" }, 400);
  }

  // Record the bet — use tx sender address as a pseudo-FID for now
  // In production, verify FID via Farcaster auth
  const fid = parseInt(from.slice(2, 10), 16) % 1000000; // deterministic pseudo-FID from address
  const existing = await db.prepare("SELECT choice FROM votes WHERE market_id = ? AND fid = ?").bind(marketId, fid).first();
  if (existing) {
    return c.json({ error: "Already voted on this market" }, 400);
  }

  await db.prepare("INSERT INTO votes (market_id, fid, choice, tx_hash, voted_at) VALUES (?, ?, ?, ?, ?)")
    .bind(marketId, fid, choice, txHash, Date.now()).run();
  const col = choice === "a" ? "votes_a" : "votes_b";
  await db.prepare(`UPDATE markets SET ${col} = ${col} + 1 WHERE id = ?`).bind(marketId).run();
  await db.prepare("INSERT OR IGNORE INTO players (fid) VALUES (?)").bind(fid).run();
  await db.prepare("UPDATE players SET total = total + 1 WHERE fid = ?").bind(fid).run();

  return c.json({ ok: true, txHash, market: marketId, choice });
});

// Snap handler
registerSnapHandler(app, async (ctx) => {
  const db = _db!;
  await initDb(db);

  const url = new URL(ctx.request.url);
  const action = url.searchParams.get("a");
  const fid = ctx.action.type === "get" ? 0 : (ctx.action.user?.fid ?? 0);
  const player = await getPlayer(db, fid);
  const markets = await getOrSeedMarkets(db);
  const leaderboard = await getLeaderboard(db);

  const votes: Record<string, string | null> = {};
  if (fid > 0) {
    for (const m of markets) {
      votes[m.id] = await getVote(db, m.id, fid);
    }
  }

  return feedPage(markets, player, leaderboard, votes);
});

app.get("/health", (c) => c.json({ status: "ok", snap: "jumpbox-predict", treasury: TREASURY }));

export default app;
