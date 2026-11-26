// Preprod connection settings and the local files the deploy script uses.
// Midnight retired its own Preprod indexer and RPC on 9 October 2026; Blockfrost
// serves them now, and every request needs a Midnight Preprod project token.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const deployDir = path.dirname(fileURLToPath(import.meta.url));
export const contractDir = path.resolve(deployDir, "..");
export const repoRoot = path.resolve(contractDir, "..");
export const buildDir = path.join(contractDir, "build");

/** Wallet seed and Blockfrost token live here. Gitignored. */
export const envFile = path.join(repoRoot, ".env");
/** Public record of the run: contract address and tx hashes. Committed. */
export const deploymentFile = path.join(repoRoot, "deployments", "preprod.json");
/** Demo secrets (organiser, judges) and receipts, so a failed run can resume. Gitignored. */
export const runStateFile = path.join(deployDir, ".run-state.preprod.json");
/** Wallet sync snapshot, so a second run doesn't resync from genesis. Gitignored. */
export const walletStateFile = path.join(deployDir, ".wallet-state.preprod.json");

export const NETWORK_ID = "preprod";
export const FAUCET = "https://midnight-tmnight-preprod.nethermind.dev/";
export const EXPLORER = "https://preprod.midnightexplorer.com";

export function loadEnv(): void {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export interface PreprodConfig {
  networkId: string;
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
  proofServer: string;
}

const withKey = (url: string, id: string) => `${url}?project_id=${encodeURIComponent(id)}`;

export function preprodConfig(): PreprodConfig {
  const id = process.env.BLOCKFROST_PROJECT_ID?.trim();
  if (!id) {
    throw new Error(
      `BLOCKFROST_PROJECT_ID is not set. Create a Midnight Preprod project at blockfrost.io and add ` +
        `BLOCKFROST_PROJECT_ID=<token> to ${envFile}.`,
    );
  }
  return {
    networkId: NETWORK_ID,
    indexer: withKey("https://midnight-preprod.blockfrost.io/api/v0", id),
    indexerWS: withKey("wss://midnight-preprod.blockfrost.io/api/v0/ws", id),
    node: withKey("https://rpc.midnight-preprod.blockfrost.io", id),
    nodeWS: withKey("wss://rpc.midnight-preprod.blockfrost.io", id),
    proofServer: process.env.MIDNIGHT_PROOF_SERVER ?? "http://127.0.0.1:6300",
  };
}

/** Never log a URL that carries the Blockfrost token. */
export const redact = (s: string) => s.replace(/project_id=[^&\s"']+/g, "project_id=***");
