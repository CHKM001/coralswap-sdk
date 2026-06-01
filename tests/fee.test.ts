import { FeeModule } from '../src/modules/fees';
import { ValidationError } from '../src/errors';
import { CoralSwapClient } from '../src/client';
import { FeeState } from '../src/types/pool';

const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const INVALID_PAIR = 'not-a-stellar-address';
const FIXED_NOW = 1_700_000_000;

function makeFeeState(overrides: Partial<FeeState> = {}): FeeState {
  return {
    priceLast: 123n,
    volAccumulator: 456n,
    lastUpdated: FIXED_NOW - 120,
    feeCurrent: 30,
    feeMin: 10,
    feeMax: 100,
    emaAlpha: 50,
    feeLastChanged: FIXED_NOW - 240,
    emaDecayRate: 5,
    baselineFee: 25,
    ...overrides,
  };
}

function createMockClient(feeState: FeeState = makeFeeState(), feeBps = 30) {
  const pair = {
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
    getFeeState: jest.fn().mockResolvedValue(feeState),
  };

  return {
    pair: jest.fn().mockReturnValue(pair),
    router: {
      getDynamicFee: jest.fn().mockResolvedValue(feeBps),
    },
    factory: {
      getFeeParameters: jest.fn().mockResolvedValue({
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 50,
        flashFeeBps: 5,
      }),
    },
  } as unknown as CoralSwapClient;
}

describe('FeeModule', () => {
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW * 1000);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('getCurrentFee() returns feeBps for a valid pair', async () => {
    const client = createMockClient(makeFeeState({ feeCurrent: 42 }), 42);
    const module = new FeeModule(client);

    const estimate = await module.getCurrentFee(PAIR);

    expect(estimate.pairAddress).toBe(PAIR);
    expect(estimate.currentFeeBps).toBe(42);
  });

  it('getCurrentFee() marks the fee state stale after one hour', async () => {
    const client = createMockClient(
      makeFeeState({ lastUpdated: FIXED_NOW - 3601 }),
      30,
    );
    const module = new FeeModule(client);

    const estimate = await module.getCurrentFee(PAIR);

    expect(estimate.isStale).toBe(true);
  });

  it('getCurrentFee() leaves the fee state fresh within one hour', async () => {
    const client = createMockClient(
      makeFeeState({ lastUpdated: FIXED_NOW - 3599 }),
      30,
    );
    const module = new FeeModule(client);

    const estimate = await module.getCurrentFee(PAIR);

    expect(estimate.isStale).toBe(false);
  });

  it('getFeeState() returns all fee state fields', async () => {
    const feeState = makeFeeState({
      priceLast: 999n,
      volAccumulator: 888n,
      lastUpdated: FIXED_NOW - 90,
      feeCurrent: 33,
      feeMin: 11,
      feeMax: 99,
      emaAlpha: 77,
      feeLastChanged: FIXED_NOW - 180,
      emaDecayRate: 6,
      baselineFee: 31,
    });
    const client = createMockClient(feeState, 33);
    const module = new FeeModule(client);

    const state = await module.getFeeState(PAIR);

    expect(state).toEqual(feeState);
  });

  it('estimateSwapFee() uses the dynamic fee returned by the pair', async () => {
    const client = createMockClient(makeFeeState(), 55);
    const module = new FeeModule(client);

    const result = await module.estimateSwapFee(PAIR, 10_000n);

    expect(result.feeBps).toBe(55);
    expect(result.feeAmount).toBe(55n);
  });

  it('invalid pair address throws ValidationError', async () => {
    const client = createMockClient();
    const module = new FeeModule(client);

    await expect(module.getCurrentFee(INVALID_PAIR)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
