// Witnesses for the deployed contract: the same implementations the local
// engine and tests use (contract/lib/panel.ts), so on-chain and local runs
// prove with identical private inputs.
//
// One private state holds every demo actor's secrets because this script plays
// organiser, three judges and two teams from one process. In a real event each
// party runs its own prover with only its own secret.
import { witnesses, randomSalt, type PS, type Opening } from "../lib/panel.js";

export { witnesses, type PS, type Opening };

export const PRIVATE_STATE_ID = "blindPanelPrivateState";

export const initialPrivateState = (organizerSecret: Uint8Array): PS => ({
  organizerSecret,
  judgeSecret: new Uint8Array(32),
  card: null,
  salt: new Uint8Array(32),
  openings: [],
});

export const freshSecret = randomSalt;
