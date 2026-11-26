// Midnight.js 5 providers and the compiled Blind Panel contract, for Preprod.
// Modelled on AustinChris1/Equilux contract/deploy/client.ts, moved to ledger 9
// (Midnight.js 5.0.1, Wallet SDK 2.0.1, compact-runtime 0.21.0).
import { WebSocket } from "ws";
import { ContractState } from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/v9/compact-js";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProviders,
} from "@midnight-ntwrk/midnight-js-types";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { Contract, ledger, type ProvableCircuits } from "../build/contract/index.js";
import { buildDir, deployDir, type PreprodConfig } from "./config.js";
import type { PanelWallet } from "./wallet.js";
import { PRIVATE_STATE_ID, witnesses, type PS } from "./witnesses.js";

// GraphQL subscriptions in Node need a global WebSocket.
(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

export type Circuit = keyof ProvableCircuits<PS>;
export type Providers = MidnightProviders<Circuit, typeof PRIVATE_STATE_ID, PS>;

export const compiledContract = CompiledContract.make("blind-panel", Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(buildDir),
);

export function buildProviders(wallet: PanelWallet, cfg: PreprodConfig): Providers {
  const zkConfigProvider = new NodeZkConfigProvider<Circuit>(buildDir);
  return {
    privateStateProvider: levelPrivateStateProvider<typeof PRIVATE_STATE_ID, PS>({
      midnightDbName: `${deployDir}/.private-state.preprod`,
      privateStateStoreName: "blind-panel-private-state",
      accountId: wallet.getCoinPublicKey(),
      // Encrypts the local private-state store. Derived from the (gitignored) seed.
      privateStoragePasswordProvider: () => `Bp!${process.env.WALLET_SEED!.slice(0, 32)}#Pre`,
    }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    walletProvider: createLedger9WalletProvider(wallet),
    midnightProvider: createLedger9MidnightProvider((tx) => wallet.submitTx(tx)),
    config: { networkId: cfg.networkId, ttlSeconds: 3600 },
  } as Providers;
}

export async function deploy(providers: Providers, organizerKey: Uint8Array, maxScore: bigint, initial: PS) {
  return deployContract(providers, {
    compiledContract,
    args: [organizerKey, maxScore],
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: initial,
  });
}

export async function join(providers: Providers, contractAddress: string, initial: PS) {
  return findDeployedContract(providers, {
    contractAddress,
    compiledContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: initial,
  });
}

export async function setPrivateState(providers: Providers, contractAddress: string, ps: PS) {
  await providers.privateStateProvider.forContract(contractAddress).set(PRIVATE_STATE_ID, ps);
}

export async function readLedger(providers: Providers, contractAddress: string) {
  const read = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!read) throw new Error(`no contract state at ${contractAddress}`);
  return ledger(read.contractState.deserialize({ v9: ContractState }).data);
}
