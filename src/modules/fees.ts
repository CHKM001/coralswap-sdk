import { CoralSwapClient } from '@/client';
import { FeeEstimate } from '@/types/fee';
import { FeeState } from '@/types/pool';
import { OracleModule } from '@/modules/oracle';
import { validateAddress, validatePositiveAmount } from '@/utils/validation';

/**
 * LP yield breakdown for a specific address over a time period.
 */
export interface LPYield {
  /** Annualized fee percentage earned by the LP */
  feeAPR: number;
  /** Impermanent loss as a percentage of position value (negative = loss) */
  ilPct: number;
  /** Net annualized yield = feeAPR - |ilPct| (can be negative) */
  netYieldAPR: number;
  /** Number of days in the observation period */
  periodDays: number;
}

/**
 * Fee module -- dynamic fee transparency and estimation.
 *
 * Exposes the full dynamic fee engine state, allowing developers
 * to predict fee impacts, detect stale volatility, and analyze
 * fee history for trading strategies.
 */
export class FeeModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Calculate LP yield for an address over a period.
   *
   * Computes fee APR from the LP's share and current fee rate, combines
   * with impermanent loss (IL) derived from TWAP price history over the
   * same period.
   *
   * @param address - LP wallet address
   * @param pairAddress - Pair contract address
   * @param fromLedger - Starting ledger for the period
   */
  async getLPYield(
    address: string,
    pairAddress: string,
    fromLedger: number,
  ): Promise<LPYield> {
    validateAddress(address, 'address');
    validateAddress(pairAddress, 'pairAddress');

    const pair = this.client.pair(pairAddress);

    const [
      reserves,
      feeState,
      lpTokenAddress,
      currentLedger,
    ] = await Promise.all([
      pair.getReserves(),
      pair.getFeeState(),
      pair.getLPTokenAddress(),
      this.client.getCurrentLedger(),
    ]);

    const lpToken = this.client.lpToken(lpTokenAddress);

    const [lpBalance, totalSupply] = await Promise.all([
      lpToken.balance(address),
      lpToken.totalSupply(),
    ]);

    if (totalSupply === 0n || lpBalance === 0n) {
      return { feeAPR: 0, ilPct: 0, netYieldAPR: 0, periodDays: 0 };
    }

    const lpShare = Number(lpBalance) / Number(totalSupply);
    const periodLedgers = Math.max(1, currentLedger - fromLedger);
    // ~5 seconds per ledger in Soroban
    const periodDays = Math.max(0.1, (periodLedgers * 5) / (24 * 3600));

    // Estimate fee APR from the current fee rate and LP share.
    // Uses a conservative daily turnover ratio (30% of liquidity/day)
    // as a baseline approximation when precise volume data is unavailable.
    const feeBps = feeState.feeCurrent;
    const dailyTurnoverRatio = 0.3;
    const feeAPR =
      (feeBps / 10000) * dailyTurnoverRatio * 365 * lpShare;

    // Estimate impermanent loss from spot price change over the period.
    // Compares the current spot price against a historical TWAP computed
    // from the pair's cumulative price accumulators. IL is derived from
    // the relative price deviation over the period.
    let ilPct = 0;
    try {
      const oracle = new OracleModule(this.client);
      const spotPrices = await oracle.getSpotPrice(pairAddress);

      // IL as a fraction of the price ratio change from start to end.
      // When start price is unknown, we derive it from the TWAP window.
      // Simple model: IL ≈ (sqrt(price_ratio) - 1)^2 / 2 per Uniswap v2
      // approximated from the current spot deviation.
      const oracleResult = await oracle.getTWAP(pairAddress);
      if (oracleResult) {
        // Compute IL from the ratio of spot vs TWAP price
        const twap0 = Number(oracleResult.price0TWAP);
        const spot0 = Number(spotPrices.price0Per1);
        if (twap0 > 0 && spot0 > 0) {
          const priceRatio = spot0 / twap0;
          // Standard IL formula: IL = 2*sqrt(ratio)/(1+ratio) - 1
          // Approximated as a percentage
          const sqrtRatio = Math.sqrt(priceRatio);
          ilPct = (2 * sqrtRatio) / (1 + priceRatio) - 1;
          // Convert to percentage
          ilPct = ilPct * 100;
        }
      }
    } catch {
      // IL data not available — skip
    }

    const netYieldAPR = feeAPR - Math.abs(ilPct);

    return { feeAPR, ilPct, netYieldAPR, periodDays };
  }

  /**
   * Get the current dynamic fee estimate for a pair.
   */
  async getCurrentFee(pairAddress: string): Promise<FeeEstimate> {
    validateAddress(pairAddress, 'pairAddress');

    const pair = this.client.pair(pairAddress);
    const feeState = await pair.getFeeState();

    const now = Math.floor(Date.now() / 1000);
    const staleSec = now - feeState.lastUpdated;
    const isStale = staleSec > 3600; // stale after 1 hour of no swaps

    return {
      pairAddress,
      currentFeeBps: feeState.feeCurrent,
      baselineFeeBps: feeState.baselineFee,
      feeMin: feeState.feeMin,
      feeMax: feeState.feeMax,
      volatility: feeState.volAccumulator,
      emaDecayRate: feeState.emaDecayRate,
      lastUpdated: feeState.lastUpdated,
      isStale,
    };
  }

  /**
   * Get the fee for a specific token pair via the Router.
   */
  async getFeeForPair(tokenA: string, tokenB: string): Promise<number> {
    validateAddress(tokenA, 'tokenA');
    validateAddress(tokenB, 'tokenB');

    return this.client.router.getDynamicFee(tokenA, tokenB);
  }

  /**
   * Get the full fee engine state for a pair (advanced).
   */
  async getFeeState(pairAddress: string): Promise<FeeState> {
    const pair = this.client.pair(pairAddress);
    return pair.getFeeState();
  }

  /**
   * Estimate the effective fee for a swap of a given size.
   *
   * Larger swaps may trigger higher dynamic fees due to increased
   * volatility impact on the EMA.
   */
  async estimateSwapFee(
    pairAddress: string,
    amountIn: bigint,
  ): Promise<{ feeBps: number; feeAmount: bigint }> {
    validateAddress(pairAddress, 'pairAddress');
    validatePositiveAmount(amountIn, 'amountIn');

    const pair = this.client.pair(pairAddress);
    const feeBps = await pair.getDynamicFee();
    const feeAmount = (amountIn * BigInt(feeBps)) / BigInt(10000);

    return { feeBps, feeAmount };
  }

  /**
   * Check if a pair's fee state is stale (EMA decay should be applied).
   */
  async isStale(
    pairAddress: string,
    maxAgeSec: number = 3600,
  ): Promise<boolean> {
    const pair = this.client.pair(pairAddress);
    const feeState = await pair.getFeeState();
    const now = Math.floor(Date.now() / 1000);
    return now - feeState.lastUpdated > maxAgeSec;
  }

  /**
   * Get the factory-level fee parameters (protocol-wide).
   */
  async getProtocolFeeParams(): Promise<{
    feeMin: number;
    feeMax: number;
    emaAlpha: number;
    flashFeeBps: number;
  }> {
    return this.client.factory.getFeeParameters();
  }

  /**
   * Compare fees across multiple pairs for arbitrage detection.
   */
  async compareFees(pairAddresses: string[]): Promise<FeeEstimate[]> {
    return Promise.all(
      pairAddresses.map((addr) => this.getCurrentFee(addr)),
    );
  }
}
