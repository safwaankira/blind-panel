# Blind Panel

Hackathon judging on Midnight where judges stay anonymous, scores lock, and every team gets a receipt it can check.

**Try it:** open the app, press **Run a demo round**, then open **Try to cheat**. The contract's compiled circuits run in your browser tab against a local copy of the ledger. No wallet, no sign-in.

## Why

Organisers publish a winners list. Teams outside the top places usually get no scores, no feedback and no way to check that their ballots were counted. Judges who score in a shared spreadsheet can also edit scores after seeing other judges' scores.

Blind Panel fixes the parts a contract can fix:

| Problem | What the contract does | Where |
| --- | --- | --- |
| A judge edits a score after the fact | One ballot per judge per project, write-once | `castBallot`, nullifier in `spent` |
| Judges are pressured or lobbied | A judge is a leaf in a Merkle tree; ballots don't say which judge | `judgeLeafOf`, `judges.checkRoot` |
| Teams can't check their ballots were counted | Each team gets a receipt (scorecard + salt) and checks it against the locked commitment | `checkReceipt` |
| Results can be quietly adjusted | After scoring closes, the team itself publishes per-criterion totals from its receipts; every receipt must match its locked ballot | `publishTotals` |
| Scores leak from hashes | Each scorecard is a salted `persistentCommit`, so trying every possible scorecard recovers nothing | test: dictionary attack |

## What is public, what is not

On the ledger: the judge tree root, project keys, one salted commitment per ballot, one nullifier per ballot, ballot counts per project, and each project's totals once published.

Never on the ledger: which judge cast a ballot, any individual score, any salt.

## Contract

`contract/src/blind_panel.compact`, Compact language 0.28 (toolchain 0.36.1).

| Circuit | Who | Does |
| --- | --- | --- |
| `addJudge`, `addProject`, `openScoring`, `closeScoring` | organiser | Setup and phase changes, gated by the organiser's secret key |
| `castBallot(project)` | any judge | Proves membership with a private Merkle path, spends a one-time nullifier, checks each score is at most the rubric maximum, locks a salted commitment of the scorecard. Panels hold up to 3 judges. |
| `checkReceipt(project, i, opening)` | anyone with a receipt | Returns whether the receipt opens ballot `i` |
| `publishTotals(project)` | anyone holding every receipt for the project | After scoring closes, checks every opening against its locked ballot and writes per-criterion totals |

Every hash has its own domain tag (`blindpanel:<purpose>:v1`).

## Tests

```
cd contract
npm install --legacy-peer-deps
compact compile +0.36.1 --skip-zk src/blind_panel.compact build
npm test
```

`contract/test/blind-panel.test.ts`, 21 tests against the compiled contract through `@midnight-ntwrk/compact-runtime`:

- the happy path, with totals checked against hand-summed scores;
- a refusal test for every guard, matched by its error message;
- attacks: inflating a receipt, swapping a low ballot for a copy of a high one, a forged Merkle path, voting twice, a fourth judge on a full panel, an 11 out of 10;
- privacy: no judge leaf appears outside the judge tree, one judge's two ballots share no nullifier or commitment, and a dictionary attack over all 161,051 possible 0–10 scorecards recovers nothing.

**Mutation check.** `contract/scripts/mutate-guards.mjs` deletes each `assert` in turn, recompiles and reruns the suite. All 20 guards are caught by at least one test (`contract/mutation-report.json`). The method follows VINPassport's `mutate-guards.mjs`.

## App

`web/`, Vite + React. `web/src/event.ts` runs one judging event on the real compiled circuits; `contract/lib/panel.ts` is the engine shared with the tests.

```
cd web
npm install --legacy-peer-deps
npm run build
```

## Credits

- Judging model (categories, criteria with min and max scores, assignments, ballots) and the score sliders are adapted from [HackGT timber](https://github.com/HackGT/timber) and [HackGT api](https://github.com/HackGT/api) `services/expo`, both MIT.
- Contract patterns (domain-separated hashes, Merkle membership with a one-time nullifier, salted commitments) follow Midnight's examples and the Tell leak zoo's fixed contracts.

## License

Apache-2.0. See `LICENSE`.
