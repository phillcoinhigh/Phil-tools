# Token locker

Locks an amount of one coin until a time, then releases it to one named wallet. On Solana devnet.

**The rules.** The program has two instructions and no owner.

- `LOCK` moves the coins into an escrow token account and writes the terms once: coin, amount,
  unlock time, beneficiary.
- `RELEASE` may be sent by anyone once the unlock time has passed. It moves everything in the
  escrow to the beneficiary's own token account for that coin, and nowhere else.

Nothing cancels a lock, changes it, or releases it early.

**The escrow.** It is an ordinary (associated) token account whose authority is a program-derived
address made from the lock account's address (`["lock", lock]`). Only this program can sign for
it, and it only does so in `RELEASE`.

**Phil.** Both instructions are uploads through `UploadServer`, the function Phil's LLVM backend
emits, in the frame format of Phil's control codec v1 (see `giveaway/README.md`). Kinds
`phil-lock/terms` and `phil-lock/release`. The runtime also enforces the ownership rules
described in `mutation/`. The locker's own logic is ours, not Phil.

| File | What it is |
|---|---|
| `runtime.c` | The program |
| `run.ts` | Self-test against the real token program, and the demonstration coin |
| `../site/src/lock-tx.ts` | Builds the transactions. The website and `run.ts` use the same code |
| `../site/src/lock.ts` | Record formats and the lock account's layout |
| `program.json`, `demo.json` | The deployed program and the demonstration coin's locks |

Built with `giveaway/build.sh locker/out/phil_lock.so locker/runtime.c`.

## What LOCK checks

The token program is one of Solana's two and owns the mint. The depositor signed. The escrow is
an initialized, empty token account of this coin, owned by the token program, whose authority is
the derived address, with no delegate and no separate close authority. The unlock time is in the
future and the amount is not zero. For coins of the newer token program, the mint must not carry
a permanent delegate, a transfer hook, or the non-transferable extension. The amount recorded is
what actually arrived in the escrow, so a coin that charges a fee on transfer is recorded truthfully.

## Limits

- **Devnet, unaudited.** Tested natively (`npm run test:locker`), on a local validator and on
  devnet against the real token program. Not reviewed by anyone independent.
- **Upgradeable.** The deploy key can replace the program. "Nobody can unlock early" is fully
  true only once the program's upgrade authority is removed.
- **Freeze authority.** If a coin's issuer can freeze accounts, it can freeze the escrow.
- **One cliff.** No gradual vesting yet.
