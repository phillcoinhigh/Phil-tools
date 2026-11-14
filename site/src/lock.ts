// Token locks: the bytes. Shared by the page, the tests and the workflow script.
import { concat, utf8, uploadData, Upload } from "./draw";

export const OP_LOCK = 1, OP_RELEASE = 2;
export const KIND_LOCK = "phil-lock/terms", KIND_RELEASE = "phil-lock/release";
export const LOCK_SIZE = 320;
const u64le = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };

/** The terms uploaded at LOCK. `bump` is the escrow authority's bump seed for this lock account. */
export function termsRecord(amount: bigint, unlockTime: number, beneficiary: Uint8Array, bump: number, label: string): Uint8Array {
  const l = utf8(label);
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("The amount must be more than zero.");
  if (beneficiary.length !== 32) throw new Error("A wallet address is 32 bytes.");
  if (l.length > 32) throw new Error("The label must be at most 32 bytes.");
  return concat(utf8("LOCK1"), u64le(amount), u64le(BigInt(Math.floor(unlockTime))), beneficiary, Uint8Array.of(bump, l.length), l);
}
export const lockData = (amount: bigint, unlockTime: number, beneficiary: Uint8Array, bump: number, label: string, u: Upload = {}) =>
  uploadData(OP_LOCK, termsRecord(amount, unlockTime, beneficiary, bump, label), { kind: KIND_LOCK, ...u });
export const releaseData = (u: Upload = {}) => uploadData(OP_RELEASE, utf8("RELS1"), { kind: KIND_RELEASE, ...u });

export interface Lock {
  state: "empty" | "locked" | "released"; bump: number; decimals: number; label: string; amount: bigint; unlockTime: number;
  lockedSlot: number; lockedTime: number; releasedTime: number; releasedAmount: bigint;
  mint: Uint8Array; escrow: Uint8Array; beneficiary: Uint8Array; depositor: Uint8Array; tokenProgram: Uint8Array; termsDigest: Uint8Array;
}
export function decodeLock(d: Uint8Array): Lock | null {
  if (d.length < LOCK_SIZE || new TextDecoder().decode(d.slice(0, 8)) !== "PHILLOCK") return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u = (at: number) => v.getBigUint64(at, true);
  return { state: (["empty", "locked", "released"] as const)[d[8]] ?? "empty", bump: d[9], decimals: d[10], label: new TextDecoder().decode(d.slice(256, 256 + d[11])),
    amount: u(16), unlockTime: Number(v.getBigInt64(24, true)), lockedSlot: Number(u(32)), lockedTime: Number(u(40)), releasedTime: Number(u(48)), releasedAmount: u(56),
    mint: d.slice(64, 96), escrow: d.slice(96, 128), beneficiary: d.slice(128, 160), depositor: d.slice(160, 192), tokenProgram: d.slice(192, 224), termsDigest: d.slice(224, 256) };
}
/** A whole-coin amount with its decimals, for people. */
export function amountText(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals), whole = units / base, frac = units % base;
  const tail = decimals ? frac.toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return Number(whole).toLocaleString("en-GB") + (tail ? "." + tail.slice(0, 4) : "");
}
/** "in 3 days 4 hours", or "now". */
export function untilText(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  const parts = d ? [`${d} day${d === 1 ? "" : "s"}`, `${h} h`] : h ? [`${h} h`, `${m} min`] : m ? [`${m} min`, `${s} s`] : [`${s} s`];
  return "in " + parts.join(" ");
}
