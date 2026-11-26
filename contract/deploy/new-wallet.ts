// Creates a fresh Preprod-only wallet seed, saves it to the repo-root .env
// (gitignored), and prints the address to fund from the Preprod faucet.
//   npm run wallet:new            refuses if .env already has a seed
//   npm run wallet:address        prints the address for the saved seed
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { generateRandomSeed } from "@midnightntwrk/wallet-sdk";
import { envFile, FAUCET, loadEnv, NETWORK_ID } from "./config.js";
import { walletAddresses } from "./wallet.js";

const showOnly = process.argv.includes("--show");
loadEnv();
let seed = process.env.WALLET_SEED?.trim();

if (!showOnly) {
  if (seed) {
    console.error(`${envFile} already has WALLET_SEED. Not overwriting it. Use --show to print its address.`);
    process.exit(1);
  }
  seed = Buffer.from(generateRandomSeed()).toString("hex");
  const prev = existsSync(envFile) ? readFileSync(envFile, "utf8").trimEnd() + "\n" : "";
  const body =
    prev +
    "# Blind Panel deploy wallet. PREPROD ONLY: never fund it with real NIGHT, never commit this file.\n" +
    `WALLET_SEED=${seed}\n` +
    (prev.includes("BLOCKFROST_PROJECT_ID") ? "" : "# Midnight Preprod project token from blockfrost.io\nBLOCKFROST_PROJECT_ID=\n");
  writeFileSync(envFile, body, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(`New Preprod wallet seed saved to ${envFile}`);
}

if (!seed) {
  console.error(`No WALLET_SEED in ${envFile}. Run npm run wallet:new first.`);
  process.exit(1);
}
const { unshielded, dust } = walletAddresses(seed, NETWORK_ID);
console.log(`Unshielded address (fund this): ${unshielded}`);
console.log(`DUST address:                   ${dust}`);
console.log(`Faucet: ${FAUCET}`);
