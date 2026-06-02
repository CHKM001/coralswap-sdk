import { filterEvents } from '../src/utils/events';
import { ContractEvent } from '../src/types/events';

const MOCK_EVENTS: ContractEvent[] = [
    {
        type: 'swap',
        contractId: 'CA111111111111111111111111111111111111111111111111111111',
        ledger: 100,
        timestamp: 100,
        txHash: 'hash1',
    },
    {
        type: 'mint',
        contractId: 'CA111111111111111111111111111111111111111111111111111111',
        ledger: 110,
        timestamp: 110,
        txHash: 'hash2',
    },
    {
        type: 'swap',
        contractId: 'CA222222222222222222222222222222222222222222222222222222',
        ledger: 120,
        timestamp: 120,
        txHash: 'hash3',
    },
    {
        type: 'burn',
        contractId: 'CA222222222222222222222222222222222222222222222222222222',
        ledger: 130,
        timestamp: 130,
        txHash: 'hash4',
    },
];

describe('filterEvents', () => {
    it('returns all events unchanged when filter is empty', () => {
        const result = filterEvents(MOCK_EVENTS, {});
        expect(result).toHaveLength(4);
        expect(result).toEqual(MOCK_EVENTS);
    });

    it('filters by type (single match)', () => {
        const result = filterEvents(MOCK_EVENTS, { types: ['swap'] });
        expect(result).toHaveLength(2);
        expect(result.every((e) => e.type === 'swap')).toBe(true);
        expect(result[0].txHash).toBe('hash1');
        expect(result[1].txHash).toBe('hash3');
    });

    it('filters by multiple types', () => {
        const result = filterEvents(MOCK_EVENTS, { types: ['mint', 'burn'] });
        expect(result).toHaveLength(2);
        expect(result[0].type).toBe('mint');
        expect(result[1].type).toBe('burn');
    });

    it('filters by contract address', () => {
        const addr = 'CA111111111111111111111111111111111111111111111111111111';
        const result = filterEvents(MOCK_EVENTS, { contractAddress: addr });
        expect(result).toHaveLength(2);
        expect(result.every((e) => e.contractId === addr)).toBe(true);
    });

    it('filters by fromLedger (inclusive)', () => {
        const result = filterEvents(MOCK_EVENTS, { fromLedger: 120 });
        expect(result).toHaveLength(2);
        expect(result[0].ledger).toBe(120);
        expect(result[1].ledger).toBe(130);
    });

    it('filters by toLedger (inclusive)', () => {
        const result = filterEvents(MOCK_EVENTS, { toLedger: 110 });
        expect(result).toHaveLength(2);
        expect(result[0].ledger).toBe(100);
        expect(result[1].ledger).toBe(110);
    });

    it('filters by ledger range (both from and to)', () => {
        const result = filterEvents(MOCK_EVENTS, { fromLedger: 110, toLedger: 120 });
        expect(result).toHaveLength(2);
        expect(result[0].ledger).toBe(110);
        expect(result[1].ledger).toBe(120);
    });

    it('combines multiple filters (type + address)', () => {
        const addr = 'CA111111111111111111111111111111111111111111111111111111';
        const result = filterEvents(MOCK_EVENTS, {
            types: ['swap'],
            contractAddress: addr,
        });
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('swap');
        expect(result[0].contractId).toBe(addr);
        expect(result[0].txHash).toBe('hash1');
    });

    it('returns empty array when no events match', () => {
        const result = filterEvents(MOCK_EVENTS, { types: ['non_existent'] });
        expect(result).toHaveLength(0);
    });

    it('works with open-ended range (from only)', () => {
        const result = filterEvents(MOCK_EVENTS, { fromLedger: 125 });
        expect(result).toHaveLength(1);
        expect(result[0].ledger).toBe(130);
    });

    it('works with open-ended range (to only)', () => {
        const result = filterEvents(MOCK_EVENTS, { toLedger: 105 });
        expect(result).toHaveLength(1);
        expect(result[0].ledger).toBe(100);
    });
});
