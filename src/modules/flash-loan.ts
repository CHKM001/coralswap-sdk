import { xdr, scValToNative, Address, SorobanRpc } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../client';
import {
  FlashLoanRequest,
  FlashLoanResult,
  FlashLoanFeeEstimate,
  FlashLoanExecutedEvent,
  FlashLoanFailedEvent,
} from '../types/flash-loan';
import { FlashLoanConfig } from '../types/pool';
import { calculateRepayment, validateFeeFloor } from '../contracts/flash-receiver';
import { FlashLoanError } from '../errors';

/**
 * Flash Loan module -- first-class flash loan support for CoralSwap.
 *
 * Enables atomic borrow-and-repay operations within a single Soroban
 * transaction. The borrower must deploy a flash receiver contract that
 * implements the on_flash_loan callback.
 */
export class FlashLoanModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Estimate the flash loan fee for a given amount.
   *
   * @param pairAddress - The address of the pair providing the flash loan
   * @param token - The token being borrowed
   * @param amount - The amount requested to borrow
   * @returns Estimated total fee information
   * @throws {FlashLoanError} If flash loans are locked for the pair
   * @example
   * const est = await client.flashLoans.estimateFee('C...', 'C...', 1000n);
   */
  async estimateFee(
    pairAddress: string,
    token: string,
    amount: bigint,
  ): Promise<FlashLoanFeeEstimate> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(token, "token");
    validatePositiveAmount(amount, "amount");

    const pair = this.client.pair(pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress,
        },
      );
    }

    const feeAmount = (amount * BigInt(config.flashFeeBps)) / BigInt(10000);
    const feeFloorAmount = BigInt(config.flashFeeFloor);
    const actualFee = feeAmount > feeFloorAmount ? feeAmount : feeFloorAmount;

    return {
      token,
      amount,
      feeBps: config.flashFeeBps,
      feeAmount: actualFee,
      feeFloor: config.flashFeeFloor,
    };
  }

  /**
   * Execute a flash loan transaction.
   *
   * After submission the full transaction meta is fetched and Soroban events
   * are decoded. A `FlashLoanExecuted` event is attached to the returned
   * `FlashLoanResult`. If a `FlashLoanFailed` event is present, a
   * `FlashLoanError` is thrown with the decoded event details.
   *
   * The receiver contract at receiverAddress must implement the
   * on_flash_loan(sender, token, amount, fee, data) callback.
   *
   * @param request - Parameters required to execute the flash loan
   * @returns Receipt containing the transaction hash and flash loan details
   * @throws {FlashLoanError} If flash loans are locked or if fee config is invalid
   * @throws {TransactionError} If the execution on-chain fails
   * @example
   * const result = await client.flashLoans.execute({
   *   pairAddress: 'C...', token: 'C...', amount: 1000n, receiverAddress: 'C...', callbackData: Buffer.from('')
   * });
   */
  async execute(request: FlashLoanRequest): Promise<FlashLoanResult> {
    validateAddress(request.pairAddress, "pairAddress");
    validateAddress(request.token, "token");
    validatePositiveAmount(request.amount, "amount");
    validateAddress(request.receiverAddress, "receiverAddress");

    const pair = this.client.pair(request.pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress: request.pairAddress,
        },
      );
    }

    if (!validateFeeFloor(config.flashFeeBps, config.flashFeeFloor)) {
      throw new FlashLoanError("Flash loan fee below protocol floor", {
        feeBps: config.flashFeeBps,
        feeFloor: config.flashFeeFloor,
      });
    }

    const feeEstimate = await this.estimateFee(
      request.pairAddress,
      request.token,
      request.amount,
    );

    const op = pair.buildFlashLoan(
      this.client.publicKey,
      request.token,
      request.amount,
      request.receiverAddress,
      request.callbackData,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new FlashLoanError(
        `Flash loan failed: ${result.error?.message ?? 'Unknown error'}`,
      );
    }

    const txHash = result.txHash!;
    const ledger = result.data!.ledger;

    // Fetch the full transaction result to extract Soroban events.
    const events = await this.fetchSorobanEvents(txHash);

    // A FlashLoanFailed event means the callback reverted; surface it as an error.
    const failedEvent = this.decodeFailedEvent(events);
    if (failedEvent) {
      throw new FlashLoanError(
        `Flash loan callback failed: ${failedEvent.reason}`,
        failedEvent,
      );
    }

    // Decode the success event (may be absent on older contract versions).
    const executedEvent = this.decodeExecutedEvent(events) ?? {
      type: 'FlashLoanExecuted' as const,
      borrowedAmount: request.amount,
      feePaid: feeEstimate.feeAmount,
      callbackAddress: request.receiverAddress,
      token: request.token,
    };

    return {
      txHash,
      token: request.token,
      amount: request.amount,
      fee: feeEstimate.feeAmount,
      ledger,
      event: executedEvent,
    };
  }

  /**
   * Get the flash loan configuration for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns Current setup for flash loans including floor and bps
   * @example
   * const config = await client.flashLoans.getConfig('C...');
   */
  async getConfig(pairAddress: string): Promise<FlashLoanConfig> {
    const pair = this.client.pair(pairAddress);
    return pair.getFlashLoanConfig();
  }

  /**
   * Check if flash loans are available for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns True if the flash pool is unlocked
   * @example
   * const canFlash = await client.flashLoans.isAvailable('C...');
   */
  async isAvailable(pairAddress: string): Promise<boolean> {
    try {
      const config = await this.getConfig(pairAddress);
      return !config.locked;
    } catch {
      return false;
    }
  }

  /**
   * Calculate the total repayment amount (principal + fee).
   *
   * @param amount - The principal loaned amount
   * @param feeBps - The fee in basis points
   * @returns Total amount required for full repayment
   * @example
   * const totalDue = client.flashLoans.calculateRepayment(100n, 5);
   */
  calculateRepayment(amount: bigint, feeBps: number): bigint {
    return calculateRepayment(amount, feeBps);
  }

  /**
   * Get the maximum flash-borrowable amount for a token in a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param token - The address of the token to check limit for
   * @returns Maximum safe borrow limit accounting for a safety margin
   * @example
   * const maxBorrow = await client.flashLoans.getMaxBorrowable('C...', 'C...');
   */
  async getMaxBorrowable(pairAddress: string, token: string): Promise<bigint> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    // Maximum borrowable is the full reserve minus a safety margin
    const reserve = tokens.token0 === token ? reserve0 : reserve1;
    const safetyMargin = reserve / 100n; // 1% buffer
    return reserve - safetyMargin;
  }

  // ---------------------------------------------------------------------------
  // Private: event parsing helpers
  // ---------------------------------------------------------------------------

  /**
   * Retrieve Soroban contract events from a confirmed transaction's meta XDR.
   * Returns an empty array when the RPC call fails or the meta has no events.
   */
  private async fetchSorobanEvents(txHash: string): Promise<xdr.ContractEvent[]> {
    try {
      const txResult = await this.client.server.getTransaction(txHash);
      if (txResult.status !== 'SUCCESS') return [];

      // resultMetaXdr is already a parsed xdr.TransactionMeta object.
      const sorobanMeta = (txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse)
        .resultMetaXdr
        .v3()
        .sorobanMeta();

      return sorobanMeta?.events() ?? [];
    } catch {
      // Non-fatal: callers degrade gracefully when events are unavailable.
      return [];
    }
  }

  /**
   * Scan contract events for a `FlashLoanExecuted` topic and decode its data.
   * Returns null when no matching event is found.
   */
  private decodeExecutedEvent(events: xdr.ContractEvent[]): FlashLoanExecutedEvent | null {
    for (const event of events) {
      if (event.type().name !== 'contract') continue;

      const topics = event.body().v0().topics();
      if (!topics.length) continue;

      const eventName = this.topicSymbol(topics[0]);
      if (eventName !== 'FlashLoanExecuted') continue;

      try {
        // Event data is expected to be a map keyed by symbol.
        const data = scValToNative(event.body().v0().data()) as Record<string, unknown>;

        return {
          type: 'FlashLoanExecuted',
          borrowedAmount: BigInt(String(data['amount'] ?? data['borrowed_amount'] ?? 0)),
          feePaid: BigInt(String(data['fee'] ?? data['fee_paid'] ?? 0)),
          callbackAddress: String(data['callback'] ?? data['callback_address'] ?? data['receiver'] ?? ''),
          token: String(data['token'] ?? ''),
        };
      } catch {
        // Malformed data: skip this event.
        continue;
      }
    }

    return null;
  }

  /**
   * Scan contract events for a `FlashLoanFailed` topic and decode its data.
   * Returns null when no matching event is found.
   */
  private decodeFailedEvent(events: xdr.ContractEvent[]): FlashLoanFailedEvent | null {
    for (const event of events) {
      if (event.type().name !== 'contract') continue;

      const topics = event.body().v0().topics();
      if (!topics.length) continue;

      const eventName = this.topicSymbol(topics[0]);
      if (eventName !== 'FlashLoanFailed') continue;

      try {
        const data = scValToNative(event.body().v0().data()) as Record<string, unknown>;

        return {
          type: 'FlashLoanFailed',
          borrowedAmount: BigInt(String(data['amount'] ?? data['borrowed_amount'] ?? 0)),
          token: String(data['token'] ?? ''),
          reason: String(data['reason'] ?? data['error'] ?? 'callback reverted'),
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Extract the string value from a Symbol ScVal topic entry.
   * Returns an empty string for non-symbol values.
   */
  private topicSymbol(topic: xdr.ScVal): string {
    try {
      return topic.sym().toString();
    } catch {
      return '';
    }
  }
}
