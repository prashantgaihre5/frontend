/**
 * nonceQueue.js — Singleton de gestion séquentielle des nonces
 * ============================================================
 *
 * FIX A : Nonce collision entre server.js (/api/drain) et watcher.js.
 *   Les deux utilisent le même wallet (même PRIVATE_KEY = même adresse)
 *   → ils concourent pour les mêmes nonces on-chain.
 *   Solution : un seul NonceQueue partagé via ce module singleton.
 *   Toute transaction du process Node passe par ici.
 *
 * FIX B : L'ancienne implémentation passait `wallet` via _tick() →
 *   _processNext(wallet). Si deux appelants utilisaient des wallets
 *   différents, le deuxième item était traité avec le wallet du premier.
 *   Solution : chaque item de queue stocke son propre wallet.
 *
 * Usage :
 *   const { nonceQueue } = require('./nonceQueue');
 *   const tx = await nonceQueue.send(wallet, (nonce) =>
 *     contract.someMethod(arg1, arg2, { nonce, gasLimit })
 *   );
 */

class NonceQueue {
  constructor() {
    this._nonce   = null;  // null = non initialisé, sera lu on-chain
    this._running = false;
    this._queue   = [];    // { txFn, resolve, reject, wallet }
  }

  /**
   * Planifie une transaction.
   * Chaque appelant reçoit UNIQUEMENT le résultat de SA transaction.
   *
   * @param {ethers.Wallet} wallet  Le wallet signataire
   * @param {Function}      txFn   (nonce: number) => Promise
   * @returns {Promise}
   */
  send(wallet, txFn) {
    return new Promise((resolve, reject) => {
      // Stocke le wallet dans l'item — pas dans _tick (FIX B)
      this._queue.push({ txFn, resolve, reject, wallet });
      this._tick();
    });
  }

  _tick() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;
    this._processNext().finally(() => {
      this._running = false;
      if (this._queue.length > 0) setImmediate(() => this._tick());
    });
  }

  async _processNext() {
    // Chaque item porte son wallet (FIX B)
    const { txFn, resolve, reject, wallet } = this._queue.shift();

    try {
      // Lit le nonce depuis la chain si non initialisé ou après erreur
      if (this._nonce === null) {
        this._nonce = await wallet.provider.getTransactionCount(
          wallet.address, "pending"
        );
        console.log(`[NonceQueue] 🔢 Nonce initialisé : ${this._nonce} (${wallet.address})`);
      }

      const nonce = this._nonce;
      const tx    = await txFn(nonce);

      // Incrément APRÈS succès seulement
      this._nonce++;
      resolve(tx);

    } catch (err) {
      // Reset sur toute erreur liée au nonce
      const isNonceErr =
        err.message?.toLowerCase().includes("nonce")       ||
        err.message?.toLowerCase().includes("replacement") ||
        err.code === "NONCE_EXPIRED"                        ||
        err.code === "REPLACEMENT_UNDERPRICED"              ||
        err.code === "TRANSACTION_REPLACED";

      if (isNonceErr) {
        console.warn(`[NonceQueue] 🔢 Reset nonce (${err.code ?? err.message.slice(0, 50)})`);
        this._nonce = null;
      }

      reject(err);
    }
  }

  /** Force un reset du nonce (utile après redémarrage/reconnexion) */
  reset() {
    this._nonce = null;
  }
}

// Singleton — une seule instance pour tout le process Node
const nonceQueue = new NonceQueue();

module.exports = { nonceQueue };
