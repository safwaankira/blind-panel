# Blind Panel

Hackathon judging on Midnight where judges stay anonymous, scores lock, and every team gets a receipt it can check.

**Try it:** open [safwaankira.github.io/blind-panel](https://safwaankira.github.io/blind-panel/), press **Run a demo round**, then open **Try to cheat**. The contract's compiled circuits run in your browser tab against a local copy of the ledger. No wallet, no sign-in.

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
| `publishTotals(project)` | anyone holding every receipt for the project | After scoring closes, refuses a project with fewer than two ballots, checks every opening against its locked ballot and writes per-criterion totals |

Every hash has its own domain tag (`blindpanel:<purpose>:v1`).

## Tests

```
cd contract
npm install --legacy-peer-deps
compact compile +0.36.1 --skip-zk src/blind_panel.compact build
npm test
```

`contract/test/blind-panel.test.ts`, 23 tests against the compiled contract through `@midnight-ntwrk/compact-runtime`:

- the happy path, with totals checked against hand-summed scores;
- a refusal test for every guard, matched by its error message;
- attacks: inflating a receipt, swapping a low ballot for a copy of a high one, a forged Merkle path, voting twice, a fourth judge on a full panel, an 11 out of 10, totals from a single ballot or from none;
- privacy: no judge leaf appears outside the judge tree, one judge's two ballots share no nullifier or commitment, and a dictionary attack over all 161,051 possible 0–10 scorecards recovers nothing.

**Mutation check.** `contract/scripts/mutate-guards.mjs` deletes each `assert` in turn, recompiles and reruns the suite. All 21 guards are caught by at least one test (`contract/mutation-report.json`). The method follows VINPassport's `mutate-guards.mjs`.

## Live on Preprod

Deployed to Midnight Preprod (ledger 9) on 2026-11-26 with `contract/deploy/run-preprod.ts`: Compact 0.36.1, compact-runtime 0.21.0, Midnight.js 5.0.1, Wallet SDK 2.0.1, proof server 9.0.2.

**Contract:** [`c95752eef1a8b1bcf5fcd5ebd0af451687bc0ed23a5af0cf51d1bf79dde9d0b6`](https://preprod.midnightexplorer.com/contracts/c95752eef1a8b1bcf5fcd5ebd0af451687bc0ed23a5af0cf51d1bf79dde9d0b6)

One judging event, 15 transactions. Every hash is also in [`deployments/preprod.json`](deployments/preprod.json).

| # | Step | Circuit | Block | Transaction |
| --- | --- | --- | --- | --- |
| 1 | deploy | `constructor` | 3,593,680 | [b46d2a24…dac9c5](https://preprod.midnightexplorer.com/transactions/b46d2a246b17c6fa1ba6daae8a90e920bcc4bb70de7b40e456261f684cdac9c5) |
| 2 | addJudge #1 | `addJudge` | 3,593,684 | [4617adaa…7d2c87](https://preprod.midnightexplorer.com/transactions/4617adaa85ee6d9b1ce1cf38687802951f0c0dc184f2f72720c254a2de7d2c87) |
| 3 | addJudge #2 | `addJudge` | 3,593,687 | [451fdbd0…1d59f7](https://preprod.midnightexplorer.com/transactions/451fdbd04b9bbdce96b9ad17c51ff4f534fd26c997d8bec44f7b89a56e1d59f7) |
| 4 | addJudge #3 | `addJudge` | 3,593,691 | [892eb5ee…ced249](https://preprod.midnightexplorer.com/transactions/892eb5eef7ed71b957ad58fffee5110cebf865f649228da63b4e24f821ced249) |
| 5 | addProject aurora | `addProject` | 3,593,695 | [ed81d4c7…000a14](https://preprod.midnightexplorer.com/transactions/ed81d4c7d1ded3299f86e56e5e0402bbc45882c8ff882558091fd61f84000a14) |
| 6 | addProject basalt | `addProject` | 3,593,699 | [0e31fd18…1c5564](https://preprod.midnightexplorer.com/transactions/0e31fd181eead8de342d865e431e96109e0f79ff64e3fc52c5b93cf79a1c5564) |
| 7 | openScoring | `openScoring` | 3,593,703 | [446436a1…87f7cf](https://preprod.midnightexplorer.com/transactions/446436a12f788819030e9f112fc6b517ae1bfad541087c9ec4d89a3fb187f7cf) |
| 8 | castBallot judge#1 to aurora | `castBallot` | 3,593,707 | [e6c3b458…26a110](https://preprod.midnightexplorer.com/transactions/e6c3b4580b1f9d382c372ff1ed4f353c4f6d0e774e6ef334613dc9c3fe26a110) |
| 9 | castBallot judge#2 to aurora | `castBallot` | 3,593,711 | [8d46758a…c5e8dd](https://preprod.midnightexplorer.com/transactions/8d46758aa80ed179b01e52ce8c2f68dbbbe1ba43494799af7cdd6b1ac9c5e8dd) |
| 10 | castBallot judge#3 to aurora | `castBallot` | 3,593,715 | [30a77588…7880df](https://preprod.midnightexplorer.com/transactions/30a775887160ded4560fb95ec0f8513f4a8da7f6137e8cd946bb1db0b77880df) |
| 11 | castBallot judge#1 to basalt | `castBallot` | 3,593,719 | [18959640…77e43b](https://preprod.midnightexplorer.com/transactions/1895964055e86470f09f498230cc29df4c062ff24cbbf8e173115f16ed77e43b) |
| 12 | castBallot judge#2 to basalt | `castBallot` | 3,593,723 | [b79d48db…79d5c9](https://preprod.midnightexplorer.com/transactions/b79d48db851749eb1541ca6413103defc9a1746f6dfb1b0763b43687d379d5c9) |
| 13 | closeScoring | `closeScoring` | 3,593,727 | [9fe92697…d08cc5](https://preprod.midnightexplorer.com/transactions/9fe92697e4249f0810dd8422d6c1233e08e00f9e86e4c3b54022e6e533d08cc5) |
| 14 | publishTotals aurora | `publishTotals` | 3,593,731 | [ac558e6d…cdd114](https://preprod.midnightexplorer.com/transactions/ac558e6d5832c91dd95a95ebff9a418d6e6be2ab287336dfcac7c92a16cdd114) |
| 15 | publishTotals basalt | `publishTotals` | 3,593,735 | [d3106790…ee0ee9](https://preprod.midnightexplorer.com/transactions/d31067905f772d288bcfb3b265b90e5a6d0a41c99d288a0b722dc933c0ee0ee9) |

Checked after the run:

- **Totals** equal the hand-summed scores: aurora (3 ballots) `[24, 21, 24, 21, 24]`, basalt (2 ballots) `[11, 11, 13, 12, 11]`.
- **Receipt** for aurora ballot 0: its commitment, recomputed off-chain with `commitmentOf`, matches the one on the ledger (`9f995728e7376a43…`). It was not sent as a `checkReceipt` transaction, because that would pass the opening as a circuit argument. `npm run deploy:preprod -- --onchain-receipt` sends it.

To run it yourself: `cd contract && npm run wallet:new`, fund the printed address from the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/), add a Blockfrost Midnight Preprod token as `BLOCKFROST_PROJECT_ID` in `.env`, start `midnightntwrk/proof-server:9.0.2` on port 6300, then `npm run deploy:preprod`.

## Known limits

From a second-model review of the contract (Muse, `L-01` and `L-04`). Neither is fixed yet.

- **The organiser controls the judge list.** `addJudge` takes any leaf from the organiser, with no cap, no duplicate check and no outside approval. An organiser can add judges they control, including several leaves for themselves, and those judges' ballots look the same as anyone else's. The contract proves that every ballot came from a listed judge, not that the list is fair.
- **A lost receipt blocks that project's totals.** `publishTotals` needs the opening of every locked ballot for the project. If a judge never hands a receipt to the team, or the team loses one, that project's totals can never be published, and there is no fallback.

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
