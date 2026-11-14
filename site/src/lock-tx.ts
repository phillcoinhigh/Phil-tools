// Builds the locker's transactions. The website (signed by a wallet) and the workflow script
// (signed by a key) both use exactly this, so what is proven on a validator is what a visitor sends.
import { PublicKey, SystemProgram, TransactionInstruction, Keypair } from "@solana/web3.js";
import { lockData, releaseData, LOCK_SIZE } from "./lock";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The address that controls a lock's escrow. Only the locker program can sign for it. */
export const escrowAuthority = (program: PublicKey, lock: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("lock"), lock.toBuffer()], program);
/** The standard token account for an owner and a coin. */
export const tokenAccountOf = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
/** "Create this owner's token account for the coin if it does not exist yet." */
export const ensureTokenAccount = (payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => new TransactionInstruction({
  programId: ASSOCIATED_TOKEN_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: tokenAccountOf(owner, mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: tokenProgram, isSigner: false, isWritable: false }] });

export interface LockTerms { program: PublicKey; depositor: PublicKey; mint: PublicKey; tokenProgram: PublicKey; amount: bigint; unlockTime: number; beneficiary: PublicKey; label: string; rentLamports: number; source?: PublicKey }
/** One transaction: make the lock account, make its escrow, and lock. The new lock account signs too. */
export function lockInstructions(t: LockTerms, lock: Keypair = Keypair.generate(), data?: Uint8Array): { lock: Keypair; escrow: PublicKey; instructions: TransactionInstruction[] } {
  const [authority, bump] = escrowAuthority(t.program, lock.publicKey);
  const escrow = tokenAccountOf(authority, t.mint, t.tokenProgram);
  const source = t.source ?? tokenAccountOf(t.depositor, t.mint, t.tokenProgram);
  return { lock, escrow, instructions: [
    SystemProgram.createAccount({ fromPubkey: t.depositor, newAccountPubkey: lock.publicKey, lamports: t.rentLamports, space: LOCK_SIZE, programId: t.program }),
    ensureTokenAccount(t.depositor, authority, t.mint, t.tokenProgram),
    new TransactionInstruction({ programId: t.program, data: Buffer.from(data ?? lockData(t.amount, t.unlockTime, t.beneficiary.toBytes(), bump, t.label)), keys: [
      { pubkey: lock.publicKey, isSigner: false, isWritable: true }, { pubkey: t.mint, isSigner: false, isWritable: false }, { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true }, { pubkey: t.depositor, isSigner: true, isWritable: true }, { pubkey: t.tokenProgram, isSigner: false, isWritable: false }] }),
  ] };
}
export interface ReleaseTerms { program: PublicKey; payer: PublicKey; lock: PublicKey; mint: PublicKey; tokenProgram: PublicKey; escrow: PublicKey; beneficiary: PublicKey; destination?: PublicKey }
/** One transaction, sendable by anyone: make the beneficiary's token account if needed, and release. */
export function releaseInstructions(t: ReleaseTerms): TransactionInstruction[] {
  const [authority] = escrowAuthority(t.program, t.lock);
  return [
    ...(t.destination ? [] : [ensureTokenAccount(t.payer, t.beneficiary, t.mint, t.tokenProgram)]),
    new TransactionInstruction({ programId: t.program, data: Buffer.from(releaseData()), keys: [
      { pubkey: t.lock, isSigner: false, isWritable: true }, { pubkey: t.mint, isSigner: false, isWritable: false }, { pubkey: t.escrow, isSigner: false, isWritable: true },
      { pubkey: t.destination ?? tokenAccountOf(t.beneficiary, t.mint, t.tokenProgram), isSigner: false, isWritable: true }, { pubkey: t.tokenProgram, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: false, isWritable: false }] }),
  ];
}
