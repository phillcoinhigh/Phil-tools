// Runs the token locker against a Solana node. Used by the workflow; needs a funded payer key.
//
//   selftest <rpc> <program id> <payer.json>
//       a made-up coin locked and released, with the refusals, against the real token program.
//   demo <rpc> <program id> <payer.json> <demo.json>
//       the demonstration coin: keeps one long lock in place, and each run makes a short lock
//       and releases it once its time has come.
import * as fs from "fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { readVerdict } from "../site/src/draw";
import { decodeLock, lockData, Lock, LOCK_SIZE } from "../site/src/lock";
import { lockInstructions, releaseInstructions, escrowAuthority, tokenAccountOf, LockTerms } from "../site/src/lock-tx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [command, url, programText, payerFile, ...rest] = process.argv.slice(2);
const conn = new Connection(url, "confirmed");
const program = new PublicKey(programText);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, "utf8"))));
const note = (...a: unknown[]) => console.error(...a);
const json = (f: string, fallback: any) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };

interface Sent { ok: boolean; signature: string | null; logs: string[]; units: number | null; error?: string }
async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<Sent> {
  try {
    const signature = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
    let tx = null;
    for (let i = 0; i < 20 && !tx; i++) { tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (!tx) await sleep(1500); }
    return { ok: true, signature, logs: tx?.meta?.logMessages ?? [], units: tx?.meta?.computeUnitsConsumed ?? null };
  } catch (e: any) {
    return { ok: false, signature: null, logs: e?.logs ?? e?.transactionLogs ?? [], units: null, error: String(e?.message ?? e).split("\n")[0] };
  }
}
async function readLock(lock: PublicKey): Promise<Lock> {
  const info = await conn.getAccountInfo(lock, "confirmed");
  const l = info && decodeLock(Uint8Array.from(info.data));
  if (!l) throw new Error("the lock is missing or empty");
  return l;
}
const chainTime = async () => (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
const terms = async (mint: PublicKey, amount: bigint, seconds: number, beneficiary: PublicKey, label: string): Promise<LockTerms> => ({
  program, depositor: payer.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID, amount, unlockTime: (await chainTime()) + seconds, beneficiary, label, rentLamports: await conn.getMinimumBalanceForRentExemption(LOCK_SIZE) });
async function waitUntil(unlock: number) { for (;;) { const now = await chainTime(); if (now >= unlock + 1) return; await sleep(Math.min(30000, Math.max(1500, (unlock + 1 - now) * 1000))); } }

async function selftest() {
  const problems: string[] = [];
  const expect = (name: string, ok: boolean, info = "") => { note(ok ? "ok  " : "FAIL", name, ok ? "" : info); if (!ok) problems.push(name); };
  const AMOUNT = 250_000_000_000_000n;
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  const mine = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, mine.address, payer, 1_000_000_000_000_000n);
  const friend = Keypair.generate();       // the beneficiary: a wallet that never signs anything

  const t = await terms(mint, AMOUNT, 25, friend.publicKey, "self-test");
  const bad = lockInstructions(t);
  const [, bump] = escrowAuthority(program, bad.lock.publicKey);
  const forged = lockData(t.amount, t.unlockTime, t.beneficiary.toBytes(), bump, t.label); forged[forged.length - 20] ^= 1;
  let r = await send(lockInstructions(t, bad.lock, forged).instructions, [payer, bad.lock]);
  expect("terms altered after their digest was declared are rejected by Phil on chain", !r.ok && /do not match the declared digest/.test(r.logs.join("\n")), r.error);
  const over = lockInstructions({ ...t, amount: 2_000_000_000_000_000n });
  r = await send(over.instructions, [payer, over.lock]);
  expect("more than the depositor holds cannot be locked", !r.ok && (await getAccount(conn, mine.address)).amount === 1_000_000_000_000_000n, r.error);

  const made = lockInstructions(t);
  const locked = await send(made.instructions, [payer, made.lock]);
  expect("Phil accepts the terms and the real token program moves the coins into escrow", locked.ok && readVerdict(locked.logs).accepted && /moved the coins into escrow/.test(locked.logs.join("\n")), locked.error + " " + locked.logs.join(" | "));
  const L = await readLock(made.lock.publicKey);
  expect("the escrow holds exactly the amount, and the depositor no longer does", (await getAccount(conn, made.escrow)).amount === AMOUNT && (await getAccount(conn, mine.address)).amount === 1_000_000_000_000_000n - AMOUNT && L.amount === AMOUNT && L.state === "locked");
  expect("the escrow is controlled by an address only the program can sign for", (await getAccount(conn, made.escrow)).owner.equals(escrowAuthority(program, made.lock.publicKey)[0]));
  const release = (o: Partial<{ destination: PublicKey }> = {}) => releaseInstructions({ program, payer: payer.publicKey, lock: made.lock.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID, escrow: made.escrow, beneficiary: friend.publicKey, ...o });
  r = await send(release(), [payer]);
  expect("it cannot be released early", !r.ok && (await getAccount(conn, made.escrow)).amount === AMOUNT, r.error);
  r = await send(lockInstructions(t, made.lock).instructions.slice(2), [payer]);
  expect("an existing lock's terms cannot be replaced", !r.ok && /REJECTED by policy/.test(r.logs.join("\n")), r.error);
  await waitUntil(L.unlockTime);
  r = await send(release({ destination: mine.address }), [payer]);
  expect("when the time comes it still cannot be sent to anyone but the beneficiary", !r.ok && (await getAccount(conn, made.escrow)).amount === AMOUNT, r.error);
  const released = await send(release(), [payer]);
  const theirs = tokenAccountOf(friend.publicKey, mint, TOKEN_PROGRAM_ID);
  expect("anyone can release it once the time has come, and the beneficiary receives everything", released.ok && readVerdict(released.logs).accepted && (await getAccount(conn, theirs)).amount === AMOUNT && (await getAccount(conn, made.escrow)).amount === 0n && (await readLock(made.lock.publicKey)).state === "released", released.error + " " + released.logs.join(" | "));
  r = await send(release(), [payer]);
  expect("it cannot be released twice", !r.ok, r.error);
  console.log(JSON.stringify({ ok: problems.length === 0, problems, lock: made.lock.publicKey.toBase58(), lockUnits: locked.units, releaseUnits: released.units }, null, 1));
  process.exit(problems.length ? 1 : 0);
}

async function demo() {
  const [demoFile] = rest;
  let d = json(demoFile, null);
  const DECIMALS = 6, unit = 10n ** BigInt(DECIMALS);
  if (!d || d.program !== program.toBase58()) {
    const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS);
    const mine = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    await mintTo(conn, payer, mint, mine.address, payer, 1_000_000_000n * unit);
    const long = lockInstructions(await terms(mint, 200_000_000n * unit, 180 * 86400, payer.publicKey, "Team tokens"));
    const sent = await send(long.instructions, [payer, long.lock]);
    if (!sent.ok) throw new Error("the long demo lock failed: " + sent.error + "\n" + sent.logs.join("\n"));
    d = { program: program.toBase58(), wallet: payer.publicKey.toBase58(), mint: mint.toBase58(), decimals: DECIMALS, supply: (1_000_000_000n * unit).toString(), long: { lock: long.lock.publicKey.toBase58(), locked: sent.signature }, short: [] };
    fs.writeFileSync(demoFile, JSON.stringify(d, null, 1) + "\n");
  }
  const mint = new PublicKey(d.mint);
  const short = lockInstructions(await terms(mint, 1_000_000n * unit, 45, payer.publicKey, "Released in under a minute"));
  const locked = await send(short.instructions, [payer, short.lock]);
  if (!locked.ok) throw new Error("the short demo lock failed: " + locked.error + "\n" + locked.logs.join("\n"));
  const L = await readLock(short.lock.publicKey);
  await waitUntil(L.unlockTime);
  const released = await send(releaseInstructions({ program, payer: payer.publicKey, lock: short.lock.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID, escrow: short.escrow, beneficiary: payer.publicKey }), [payer]);
  if (!released.ok) throw new Error("the short demo lock was not released: " + released.error + "\n" + released.logs.join("\n"));
  d.short = [...(d.short ?? []), { day: new Date().toISOString().slice(0, 10), lock: short.lock.publicKey.toBase58(), locked: locked.signature, released: released.signature, lockUnits: locked.units, releaseUnits: released.units }].slice(-30);
  fs.writeFileSync(demoFile, JSON.stringify(d, null, 1) + "\n");
  note(`demo: locked 1,000,000 for 45 seconds and released it; ${d.short.length} short locks so far`);
}

(command === "selftest" ? selftest() : command === "demo" ? demo() : Promise.reject(new Error("usage: selftest | demo"))).catch((e) => { note(String(e?.stack ?? e)); process.exit(1); });
