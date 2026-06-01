import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { FactoryClient } from '../src/contracts/factory';
import { FactoryModule } from '../src/modules/factory';
import { Network } from '../src/types/common';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');

  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn(),
    })),
  };
});

const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';
const PAIR_AB = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const PAIR_BC = TOKEN_C;

function buildMockClient() {
  return {
    factory: {
      getPair: jest.fn(),
    },
  } as unknown as CoralSwapClient;
}

function buildFactoryClient() {
  const server = {} as any;
  return new FactoryClient(
    PAIR_AB,
    server,
    'Test SDF Network ; September 2015',
    {
      maxRetries: 0,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
    },
  );
}

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: 'address' });
}

function addressVec(addrs: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addrs.map((addr) => addressVal(addr)));
}

describe('FactoryModule', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('getPairAddress() returns the correct address for a token pair', async () => {
    const client = buildMockClient();
    client.factory.getPair = jest.fn().mockResolvedValue(PAIR_AB);
    const module = new FactoryModule(client);

    await expect(module.getPairAddress(TOKEN_A, TOKEN_B)).resolves.toBe(PAIR_AB);
    expect(client.factory.getPair).toHaveBeenCalledTimes(1);
  });

  it('reversed token order returns the same pair address', async () => {
    const client = buildMockClient();
    client.factory.getPair = jest.fn().mockResolvedValue(PAIR_AB);
    const module = new FactoryModule(client);

    const forward = await module.getPairAddress(TOKEN_A, TOKEN_B);
    const reversed = await module.getPairAddress(TOKEN_B, TOKEN_A);

    expect(forward).toBe(PAIR_AB);
    expect(reversed).toBe(PAIR_AB);
    expect(client.factory.getPair).toHaveBeenCalledTimes(1);
  });

  it('hits the cache on the second getPairAddress() call', async () => {
    const client = buildMockClient();
    client.factory.getPair = jest.fn().mockResolvedValue(PAIR_AB);
    const module = new FactoryModule(client);

    await module.getPairAddress(TOKEN_A, TOKEN_B);
    await module.getPairAddress(TOKEN_A, TOKEN_B);

    expect(client.factory.getPair).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when requested', async () => {
    const client = buildMockClient();
    client.factory.getPair = jest.fn().mockResolvedValue(PAIR_AB);
    const module = new FactoryModule(client);

    await module.getPairAddress(TOKEN_A, TOKEN_B);
    await module.getPairAddress(TOKEN_A, TOKEN_B, { bypassCache: true });

    expect(client.factory.getPair).toHaveBeenCalledTimes(2);
  });

  it('returns null when the pair does not exist', async () => {
    const client = buildMockClient();
    client.factory.getPair = jest.fn().mockResolvedValue(null);
    const module = new FactoryModule(client);

    await expect(module.getPairAddress(TOKEN_A, TOKEN_C)).resolves.toBeNull();
  });
});

describe('FactoryClient', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('getAllPairs() returns all pairs from the mocked response', async () => {
    const client = buildFactoryClient();
    const simulateRead = jest
      .spyOn(client as any, 'simulateRead')
      .mockResolvedValue(addressVec([PAIR_AB, PAIR_BC]));

    const pairs = await client.getAllPairs();

    expect(simulateRead).toHaveBeenCalledTimes(1);
    expect(pairs).toEqual([PAIR_AB, PAIR_BC]);
  });

  it('getPair() returns the pair address for a valid token pair', async () => {
    const client = buildFactoryClient();
    jest
      .spyOn(client as any, 'simulateRead')
      .mockResolvedValue(addressVal(PAIR_AB));

    await expect(client.getPair(TOKEN_A, TOKEN_B)).resolves.toBe(PAIR_AB);
  });

  it('getPair() returns the same pair address for reversed token order', async () => {
    const client = buildFactoryClient();
    jest
      .spyOn(client as any, 'simulateRead')
      .mockResolvedValue(addressVal(PAIR_AB));

    const forward = await client.getPair(TOKEN_A, TOKEN_B);
    const reversed = await client.getPair(TOKEN_B, TOKEN_A);

    expect(forward).toBe(PAIR_AB);
    expect(reversed).toBe(PAIR_AB);
  });

  it('getPair() returns null when the pair does not exist', async () => {
    const client = buildFactoryClient();
    jest.spyOn(client as any, 'simulateRead').mockResolvedValue(null);

    await expect(client.getPair(TOKEN_A, TOKEN_C)).resolves.toBeNull();
  });

  it('getAllPairs() handles an empty response', async () => {
    const client = buildFactoryClient();
    jest.spyOn(client as any, 'simulateRead').mockResolvedValue(null);

    await expect(client.getAllPairs()).resolves.toEqual([]);
  });
});
