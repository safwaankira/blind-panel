// A ledger 9 wallet on Wallet SDK 2.0.1, wrapped as a Midnight.js 5 wallet provider.
//
// Adapted from midnightntwrk/midnight-examples (examples/leaderboard/src/wallet.ts,
// Apache-2.0), built straight on @midnightntwrk/wallet-sdk instead of testkit-js.
// The provider shape follows AustinChris1/Equilux contract/deploy/client.ts.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import * as Rx from "rxjs";
import {
  type CoinPublicKey,
  DustSecretKey,
  type EncPublicKey,
  type FinalizedTransaction,
  type PreBinding,
  type Proof,
  type SignatureEnabled,
  Transaction,
  unshieldedToken,
  ZswapSecretKeys,
} from "@midnight-ntwrk/midnight-js-protocol/v9";
import { LedgerTransaction, type Ledger9WalletProvider, type TransactionAnswer } from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import {
  DefaultForkSchedule,
  DustAddress,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  ProtocolVersion,
  PublicKey,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  WalletSeeds,
  WalletTransaction,
  createKeystore,
  type FacadeState,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk";
import { FAUCET, redact, walletStateFile, type PreprodConfig } from "./config.js";

export type Log = (msg: string) => void;

type UnboundTransaction = Transaction<SignatureEnabled, Proof, PreBinding>;

/** Derive the wallet's three seeds and its unshielded keystore from a hex master seed. */
export function walletKeys(masterSeedHex: string, networkId: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(masterSeedHex)) throw new Error("WALLET_SEED must be 64 hex characters");
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(masterSeedHex, "hex"));
  const keystore = createKeystore({ kind: "schnorr", secret: seeds.unshielded }, networkId);
  return { seeds, keystore };
}

/** The addresses a person needs: unshielded (for the faucet) and DUST. */
export function walletAddresses(masterSeedHex: string, networkId: string) {
  const { seeds, keystore } = walletKeys(masterSeedHex, networkId);
  const dustPk = DustSecretKey.fromSeed(seeds.dust).publicKey;
  return {
    unshielded: String(keystore.getBech32Address()),
    dust: String(DustAddress.encodePublicKey(networkId, dustPk)),
  };
}

export class PanelWallet implements Ledger9WalletProvider {
  private readonly zswap: ZswapSecretKeys;

  private constructor(
    readonly wallet: WalletFacade,
    readonly keystore: UnshieldedKeystore,
    private readonly seeds: WalletSeeds,
  ) {
    this.zswap = ZswapSecretKeys.fromSeed(seeds.shielded);
  }

  get address(): string {
    return String(this.keystore.getBech32Address());
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.zswap.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswap.encryptionPublicKey;
  }

  // Midnight.js 5 hands the wallet era-tagged transaction handles; Wallet SDK 2
  // balances transactions adopted at the chain's active protocol version.
  async balanceTx(handle: LedgerTransaction<"Unbound">, ttl: Date = ttlOneHour()): Promise<TransactionAnswer> {
    if (handle.era !== "v9") throw new Error(`expected a ledger 9 transaction, got ${handle.era}`);
    const tx: UnboundTransaction = Transaction.deserialize("signature", "proof", "pre-binding", handle.serialize());
    const active = await this.activeProtocolVersion();
    const recipe = await this.wallet.balanceUnboundTransaction(WalletTransaction.adopt("Unbound", tx, active), { ttl });
    const signed = await this.wallet.signRecipe(recipe, (payload) => this.keystore.signDataAsync(payload));
    const finalized = await this.wallet.finalizeRecipe(signed);
    const unwrapped = WalletTransaction.unwrapWithin<FinalizedTransaction>(
      finalized,
      ProtocolVersion.epochOf(active, DefaultForkSchedule.v9),
    );
    if (unwrapped._tag === "Left") throw unwrapped.left;
    return unwrapped.right;
  }

  async submitTx(tx: LedgerTransaction<"Finalized", "v9"> | FinalizedTransaction): Promise<string> {
    const finalized: FinalizedTransaction = LedgerTransaction.isLedgerTransaction(tx)
      ? Transaction.deserialize("signature", "proof", "binding", tx.serialize())
      : tx;
    const active = await this.activeProtocolVersion();
    return this.wallet.submitTransaction(WalletTransaction.adopt("Finalized", finalized, active));
  }

  private async activeProtocolVersion() {
    return (await Rx.firstValueFrom(this.wallet.state())).activeProtocolVersion;
  }

  async stop(): Promise<void> {
    await this.saveState();
    await this.wallet.stop();
  }

  /** Snapshot the three sub-wallets so the next run syncs only the gap. */
  async saveState(): Promise<void> {
    const snap = {
      shielded: await this.wallet.shielded.serializeState(),
      unshielded: await this.wallet.unshielded.serializeState(),
      dust: await this.wallet.dust.serializeState(),
    };
    writeFileSync(`${walletStateFile}.tmp`, JSON.stringify(snap), { mode: 0o600 });
    renameSync(`${walletStateFile}.tmp`, walletStateFile);
  }

  static async start(cfg: PreprodConfig, masterSeedHex: string, log: Log): Promise<PanelWallet> {
    const { seeds, keystore } = walletKeys(masterSeedHex, cfg.networkId);
    const configuration = {
      networkId: cfg.networkId,
      indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
      provingServerUrl: new URL(cfg.proofServer),
      relayURL: new URL(cfg.nodeWS),
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
      // Preprod crossed the ledger 9 fork in place: a fresh wallet can start its
      // DUST sync at the fork instead of replaying all ledger 8 DUST history.
      skipLedgerV8DustHistory: true,
    };

    let wallet: WalletFacade | undefined;
    if (existsSync(walletStateFile)) {
      try {
        const snap = JSON.parse(readFileSync(walletStateFile, "utf8"));
        wallet = await WalletFacade.init({
          configuration,
          shielded: (c) => ShieldedWallet(c).restore(snap.shielded),
          unshielded: (c) => UnshieldedWallet(c).restore(snap.unshielded),
          dust: (c) => DustWallet(c).restore(snap.dust),
        });
        log("restored wallet snapshot");
      } catch (e) {
        log(`could not restore wallet snapshot (${redact(String(e))}); syncing from scratch`);
        wallet = undefined;
      }
    }
    wallet ??= await WalletFacade.init({
      configuration,
      shielded: (c) => ShieldedWallet(c).startWithSeed(seeds.shielded),
      unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
      dust: (c) => DustWallet(c).startWithSeed(seeds.dust),
    });
    await wallet.start(seeds);
    const w = new PanelWallet(wallet, keystore, seeds);
    log(`wallet ${w.address}`);
    log("syncing with Preprod (a first sync can take several minutes)…");
    const state = await wallet.waitForSyncedState();
    await w.saveState();
    const night = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    log(`synced: ${formatNight(night)} tNIGHT, ${formatDust(state.dust.balance(new Date()))} DUST`);
    return w;
  }

  /** Fail fast if unfunded; otherwise register NIGHT for DUST and wait until DUST can pay for a deploy. */
  async ensureDust(log: Log, minDust = 60n * SPECKS_PER_DUST): Promise<void> {
    let state = await this.wallet.waitForSyncedState();
    const nightType = unshieldedToken().raw;
    if ((state.unshielded.balances[nightType] ?? 0n) === 0n && state.dust.balance(new Date()) === 0n) {
      throw new Error(`wallet ${this.address} has no tNIGHT. Fund it at ${FAUCET} and run again.`);
    }
    state = await Rx.firstValueFrom(this.wallet.state().pipe(Rx.filter((s: FacadeState) => s.protocol._tag === "Settled")));
    const unregistered = state.unshielded.availableCoins.filter(
      (c) => c.utxo.type === nightType && !c.meta.registeredForDustGeneration,
    );
    if (unregistered.length > 0 && state.dust.balance(new Date()) < minDust) {
      log(`registering ${unregistered.length} NIGHT UTXO(s) for DUST generation…`);
      const { fee } = await this.wallet.estimateRegistration(unregistered);
      await this.wallet.waitForGeneratedDust(unregistered, fee);
      const recipe = await this.wallet.registerNightUtxosForDustGeneration(
        unregistered,
        this.keystore.getPublicKey(),
        (payload) => this.keystore.signDataAsync(payload),
      );
      const txId = await this.wallet.submitTransaction(await this.wallet.finalizeRecipe(recipe));
      log(`DUST registration submitted: ${txId}`);
    }
    log(`waiting for ${formatDust(minDust)} DUST…`);
    let last = 0;
    await Rx.firstValueFrom(
      this.wallet.state().pipe(
        Rx.tap((s) => {
          if (Date.now() - last > 60_000) {
            last = Date.now();
            log(`  DUST ${formatDust(s.dust.balance(new Date()))}`);
          }
        }),
        Rx.filter((s) => s.isSynced && s.dust.balance(new Date()) >= minDust),
        Rx.timeout({ first: 60 * 60_000 }),
      ),
    );
    log("DUST ready");
  }
}

const SPECKS_PER_DUST = 10n ** 15n;
export const formatNight = (raw: bigint) => `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0")}`;
export const formatDust = (raw: bigint) =>
  `${raw / SPECKS_PER_DUST}.${(raw % SPECKS_PER_DUST).toString().padStart(15, "0").slice(0, 4)}`;
