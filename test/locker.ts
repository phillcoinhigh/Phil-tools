// The token locker, run natively: Phil's emitted upload server + locker/runtime.c, with the
// harness standing in for Solana and for the token program's TransferChecked.
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import { hex, unhex, sha256, concat, utf8 } from "../site/src/draw";
import { lockData, releaseData, decodeLock, termsRecord, amountText, untilText, LOCK_SIZE } from "../site/src/lock";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) { fails++; console.log("FAIL", name, info); } else console.log("ok  ", name); };
const BIN = "out/phil-lock-native";
execSync(`giveaway/native/build.sh ${BIN} locker/runtime.c`, { stdio: "inherit" });

const PROGRAM = "11".repeat(32), LOCK = "22".repeat(32), MINT = "33".repeat(32), SOURCE = "44".repeat(32), ESCROW = "55".repeat(32), DEPOSITOR = "66".repeat(32), BENEFICIARY = "77".repeat(32), DEST = "88".repeat(32), OTHER = "99".repeat(32), SYSTEM = "00".repeat(32);
const TOKEN = "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", TOKEN_2022 = "06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc";
const BUMP = 254;
// The harness derives addresses the way Solana does, minus the off-curve rule.
const derive = (lockKey: string, bump: number) => hex(sha256(concat(utf8("lock"), unhex(lockKey), Uint8Array.of(bump), unhex(PROGRAM), utf8("ProgramDerivedAddress"))));
const AUTHORITY = derive(LOCK, BUMP);
interface Acct { key: string; owner: string; flag: 0 | 1 | 2; data: Uint8Array; lamports?: bigint }
function run(o: { time: number; accounts: Acct[]; ix: Uint8Array; fault?: number }) {
  const input = ["slot 8000", `time ${o.time}`, `fault ${o.fault ?? 0}`, `program ${PROGRAM}`, ...o.accounts.map((a) => `account ${a.key} ${a.owner} ${a.flag} ${a.data.length ? hex(a.data) : "-"} ${a.lamports ?? 1000000n}`), `ix ${hex(o.ix)}`, ""].join("\n");
  const out = execFileSync(BIN, { input }).toString().split("\n");
  return { logs: out.filter((l) => l.startsWith("LOG ")), ret: Number(/RET (\d+)/.exec(out.find((l) => l.startsWith("RET ")) ?? "")?.[1] ?? -1), data: out.filter((l) => l.startsWith("ACCOUNT ")).map((l) => unhex(l.split(" ")[2] ?? "")) };
}
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const held = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset).getBigUint64(64, true);
const NOW = 1763100000, UNLOCK = NOW + 30 * 86400, AMOUNT = 250_000_000_000_000n;   // 250 million coins, six decimals
const emptyLock = (): Acct => ({ key: LOCK, owner: PROGRAM, flag: 1, data: new Uint8Array(LOCK_SIZE) });
const mint = (owner = TOKEN, key = MINT): Acct => { const d = new Uint8Array(82); d.set(u64(1_000_000_000_000_000n), 36); d[44] = 6; d[45] = 1; return { key, owner, flag: 0, data: d }; };
const tokens = (key: string, holder: string, amount: bigint, o: { mint?: string; owner?: string; delegate?: boolean; closer?: boolean; frozen?: boolean } = {}): Acct => {
  const d = new Uint8Array(165); d.set(unhex(o.mint ?? MINT), 0); d.set(unhex(holder), 32); d.set(u64(amount), 64); d[108] = o.frozen ? 2 : 1;
  if (o.delegate) { d[72] = 1; d.set(unhex(OTHER), 76); } if (o.closer) { d[129] = 1; d.set(unhex(OTHER), 133); }
  return { key, owner: o.owner ?? TOKEN, flag: 1, data: d };
};
const wallet = (key: string, flag: 0 | 1 | 2): Acct => ({ key, owner: SYSTEM, flag, data: new Uint8Array(0) });
const program = (key = TOKEN): Acct => ({ key, owner: "aa".repeat(32), flag: 0, data: new Uint8Array(0) });
const terms = (o: { amount?: bigint; unlock?: number; bump?: number } = {}) => lockData(o.amount ?? AMOUNT, o.unlock ?? UNLOCK, unhex(BENEFICIARY), o.bump ?? BUMP, "team tokens");
const lockAccounts = (o: Partial<Record<"lock" | "mint" | "source" | "escrow" | "depositor" | "program", Acct>> = {}) => [o.lock ?? emptyLock(), o.mint ?? mint(), o.source ?? tokens(SOURCE, DEPOSITOR, 400_000_000_000_000n), o.escrow ?? tokens(ESCROW, AUTHORITY, 0n), o.depositor ?? wallet(DEPOSITOR, 2), o.program ?? program()];
const untouched = (r: ReturnType<typeof run>, a: Acct[]) => r.data.every((d, i) => hex(d) === hex(a[i].data));

// ---- LOCK ----
const locked = run({ time: NOW, accounts: lockAccounts(), ix: terms() });
const L = decodeLock(locked.data[0])!;
check("LOCK: Phil's server accepts the terms, the coins move into escrow, then the terms are written", locked.ret === 0 && locked.logs.findIndex((l) => l.includes("moved the coins into escrow")) < locked.logs.findIndex((l) => l.includes("LOCKED")) && /Phil: ACCEPTED/.test(locked.logs.join()), locked.ret + " " + locked.logs.join(" | "));
check("LOCK: exactly the amount leaves the depositor and arrives in escrow", held(locked.data[2]) === 400_000_000_000_000n - AMOUNT && held(locked.data[3]) === AMOUNT);
check("LOCK: the account records coin, escrow, beneficiary, depositor, amount and time", L.state === "locked" && hex(L.mint) === MINT && hex(L.escrow) === ESCROW && hex(L.beneficiary) === BENEFICIARY && hex(L.depositor) === DEPOSITOR && L.amount === AMOUNT && L.unlockTime === UNLOCK && L.lockedTime === NOW && L.bump === BUMP && L.decimals === 6 && L.label === "team tokens" && hex(L.tokenProgram) === TOKEN && hex(L.termsDigest) === hex(sha256(termsRecord(AMOUNT, UNLOCK, unhex(BENEFICIARY), BUMP, "team tokens"))));
const refuse = (name: string, code: number, accounts: Acct[], ix = terms(), time = NOW) => { const r = run({ time, accounts, ix }); check(`LOCK: ${name}`, r.ret === code && untouched(r, accounts), `${r.ret}`); };
refuse("an escrow someone else controls is refused", 1806, lockAccounts({ escrow: tokens(ESCROW, OTHER, 0n) }));
refuse("an escrow derived with a different bump is refused", 1806, lockAccounts(), terms({ bump: 253 }));
refuse("an escrow that already holds coins is refused", 1806, lockAccounts({ escrow: tokens(ESCROW, AUTHORITY, 5n) }));
refuse("an escrow with a delegate is refused", 1806, lockAccounts({ escrow: tokens(ESCROW, AUTHORITY, 0n, { delegate: true }) }));
refuse("an escrow someone else may close is refused", 1806, lockAccounts({ escrow: tokens(ESCROW, AUTHORITY, 0n, { closer: true }) }));
refuse("an escrow of a different coin is refused", 1806, lockAccounts({ escrow: tokens(ESCROW, AUTHORITY, 0n, { mint: OTHER }) }));
refuse("a stand-in for the token program is refused before it is called", 1804, lockAccounts({ program: program(OTHER), mint: mint(OTHER), escrow: tokens(ESCROW, AUTHORITY, 0n, { owner: OTHER }) }));
refuse("an unlock time that has already passed is refused", 1802, lockAccounts(), terms({ unlock: NOW }));
refuse("an amount of zero is refused", 1802, lockAccounts(), (() => { const good = lockData(1n, UNLOCK, unhex(BENEFICIARY), BUMP, "team tokens"); const rec = termsRecord(1n, UNLOCK, unhex(BENEFICIARY), BUMP, "team tokens"); rec.set(u64(0n), 5); const w = lockData(1n, UNLOCK, unhex(BENEFICIARY), BUMP, "team tokens", { declaredDigest: sha256(rec) }); void good; return concat(w.slice(0, -rec.length), rec); })());
refuse("the depositor must have signed", 1805, lockAccounts({ depositor: wallet(DEPOSITOR, 1) }));
refuse("more than the depositor holds: the token program refuses, nothing is written", 1808, lockAccounts({ source: tokens(SOURCE, DEPOSITOR, AMOUNT - 1n) }));
refuse("someone else's coins cannot be locked", 1808, lockAccounts({ source: tokens(SOURCE, OTHER, 400_000_000_000_000n) }));
refuse("terms altered after their digest was declared are rejected by Phil", 1201, lockAccounts(), (() => { const w = terms(); w[w.length - 40] ^= 1; return w; })());
refuse("a lock that exists cannot be locked again", 1403, lockAccounts({ lock: { ...emptyLock(), data: locked.data[0] } }));
refuse("an account the program does not own is refused", 1404, lockAccounts({ lock: { ...emptyLock(), owner: OTHER } }));
const t22 = run({ time: NOW, accounts: lockAccounts({ mint: mint(TOKEN_2022), source: tokens(SOURCE, DEPOSITOR, 400_000_000_000_000n, { owner: TOKEN_2022 }), escrow: tokens(ESCROW, AUTHORITY, 0n, { owner: TOKEN_2022 }), program: program(TOKEN_2022) }), ix: terms() });
check("LOCK: coins of the newer token program lock the same way", t22.ret === 0 && hex(decodeLock(t22.data[0])!.tokenProgram) === TOKEN_2022);

// Coins of the newer token program with extensions: a list of (type, length, value) after byte 166.
const extended = (types: number[]): Acct => { const base = mint(TOKEN_2022).data; const d = new Uint8Array(166 + types.length * 36 + 8); d.set(base); d[165] = 1; types.forEach((t, i) => { d[166 + 36 * i] = t; d[166 + 36 * i + 2] = 32; }); return { key: MINT, owner: TOKEN_2022, flag: 0, data: d }; };
const with22 = (m: Acct) => lockAccounts({ mint: m, source: tokens(SOURCE, DEPOSITOR, 400_000_000_000_000n, { owner: TOKEN_2022 }), escrow: tokens(ESCROW, AUTHORITY, 0n, { owner: TOKEN_2022 }), program: program(TOKEN_2022) });
refuse("a coin whose issuer can move anyone's coins (permanent delegate) cannot be locked", 1812, with22(extended([18, 12])));
refuse("a coin with a transfer hook cannot be locked", 1812, with22(extended([14])));
refuse("a coin that cannot be transferred cannot be locked", 1812, with22(extended([9])));
check("LOCK: harmless extensions (metadata, transfer fee) do not stop a lock", run({ time: NOW, accounts: with22(extended([18, 19, 1])), ix: terms() }).ret === 0);

// ---- RELEASE ----
const lockNow = (): Acct => ({ key: LOCK, owner: PROGRAM, flag: 1, data: locked.data[0] });
const escrowNow = (): Acct => ({ ...tokens(ESCROW, AUTHORITY, 0n), data: locked.data[3] });
const releaseAccounts = (o: Partial<Record<"lock" | "mint" | "escrow" | "to" | "program" | "authority", Acct>> = {}) => [o.lock ?? lockNow(), o.mint ?? mint(), o.escrow ?? escrowNow(), o.to ?? tokens(DEST, BENEFICIARY, 7n), o.program ?? program(), o.authority ?? wallet(AUTHORITY, 0)];
const early = run({ time: UNLOCK - 1, accounts: releaseAccounts(), ix: releaseData() });
check("RELEASE: one second early, nothing moves", early.ret === 1807 && untouched(early, releaseAccounts()));
const refuseRelease = (name: string, code: number, accounts: Acct[]) => { const r = run({ time: UNLOCK + 5, accounts, ix: releaseData() }); check(`RELEASE: ${name}`, r.ret === code && untouched(r, accounts), `${r.ret}`); };
refuseRelease("it cannot be sent to anyone but the beneficiary", 1810, releaseAccounts({ to: tokens(DEST, OTHER, 0n) }));
refuseRelease("it cannot be sent back into the escrow", 1810, releaseAccounts({ to: { ...escrowNow() } }));
refuseRelease("a different escrow cannot stand in", 1803, releaseAccounts({ escrow: tokens(OTHER, AUTHORITY, AMOUNT) }));
refuseRelease("a different coin cannot stand in", 1803, releaseAccounts({ mint: mint(TOKEN, OTHER) }));
refuseRelease("a stand-in for the token program is refused", 1804, releaseAccounts({ program: program(TOKEN_2022) }));
refuseRelease("a stand-in for the escrow's authority is refused", 1806, releaseAccounts({ authority: wallet(OTHER, 0) }));
refuseRelease("a lock that was never made releases nothing", 1405, releaseAccounts({ lock: emptyLock() }));
const released = run({ time: UNLOCK, accounts: releaseAccounts(), ix: releaseData() });
const R = decodeLock(released.data[0])!;
check("RELEASE: at the unlock time anyone can send it, with no signature from the depositor or beneficiary", released.ret === 0 && /RELEASED to the beneficiary/.test(released.logs.join()) && /Phil: ACCEPTED/.test(released.logs.join()), released.ret + " " + released.logs.join(" | "));
check("RELEASE: everything in the escrow reaches the beneficiary's token account", held(released.data[2]) === 0n && held(released.data[3]) === AMOUNT + 7n && R.state === "released" && R.releasedAmount === AMOUNT && R.releasedTime === UNLOCK && R.amount === AMOUNT);
const again = run({ time: UNLOCK + 9, accounts: releaseAccounts({ lock: { ...lockNow(), data: released.data[0] }, escrow: { ...escrowNow(), data: released.data[2] } }), ix: releaseData() });
check("RELEASE: a released lock cannot be released again", again.ret === 1405);
const none = run({ time: UNLOCK, accounts: releaseAccounts(), ix: Uint8Array.of(3) });
check("there is no third instruction: nothing cancels, changes or releases early", none.ret === 103 && untouched(none, releaseAccounts()));
const fault = run({ time: NOW, fault: 4, accounts: lockAccounts(), ix: terms() });
check("a reserved status from storage fails closed", fault.ret === 1800 && untouched(fault, lockAccounts()));

check("amounts and countdowns read naturally", amountText(AMOUNT, 6) === "250,000,000" && amountText(1_500_000n, 6) === "1.5" && untilText(0) === "now" && untilText(90061) === "in 1 day 1 h" && untilText(125) === "in 2 min 5 s");
const checker = [process.env.PHIL_REPO, "../phil", "/home/claude/src/phil"].filter(Boolean).map((p) => `${p}/scripts/check_runtime_abi.py`).find((p) => fs.existsSync(p));
if (checker) {
  execSync("$(command -v clang-18 || command -v clang) --target=x86_64-unknown-linux-gnu -std=c17 -ffreestanding -fno-builtin -DPHIL_DRAW_C_STRUCT_RETURN -S -emit-llvm locker/runtime.c -o out/phil-lock-runtime.ll");
  check("Phil's own checker accepts the locker's runtime against every signature Phil's LLVM declares", /PASS: runtime provider matches 46/.test(execSync(`python3 ${checker} giveaway/phil-llvm/phil-llvm-phase0-control-codec.ll out/phil-lock-runtime.ll`).toString()));
}
console.log(fails ? `\n${fails} FAILED` : "\nAll locker checks passed.");
process.exit(fails ? 1 : 0);
