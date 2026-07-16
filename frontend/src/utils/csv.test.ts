import { describe, it, expect } from 'vitest'
import { serializeTransactionsToCSV } from './csv'
import { TransactionHistoryItem } from '../hooks/useTransactionHistory'

describe('serializeTransactionsToCSV', () => {
  it('returns only headers when transactions list is empty', () => {
    const csv = serializeTransactionsToCSV([])
    expect(csv).toBe('date,type,token,amount,tx hash')
  })

  it('serializes standard transaction items correctly', () => {
    const items: TransactionHistoryItem[] = [
      {
        id: '1',
        type: 'mint',
        token: 'USDC',
        amount: '100.50',
        date: '2026-06-26T12:00:00Z',
        status: 'success',
        hash: '0x1234567890abcdef',
      },
      {
        id: '2',
        type: 'burn',
        token: 'XLM',
        amount: '10.00',
        date: '2026-06-26T12:05:00Z',
        status: 'failed',
        hash: '0xfedcba0987654321',
      },
    ]

    const csv = serializeTransactionsToCSV(items)
    const expected = [
      'date,type,token,amount,tx hash',
      '2026-06-26T12:00:00Z,mint,USDC,100.50,0x1234567890abcdef',
      '2026-06-26T12:05:00Z,burn,XLM,10.00,0xfedcba0987654321',
    ].join('\n')

    expect(csv).toBe(expected)
  })

  it('escapes fields containing commas, newlines, or double quotes', () => {
    const items: TransactionHistoryItem[] = [
      {
        id: '1',
        type: 'create',
        token: 'My,Token', // contains comma
        amount: '500',
        date: '2026-06-26T12:10:00Z',
        status: 'success',
        hash: 'hash"with"quotes', // contains double quotes
      },
      {
        id: '2',
        type: 'other',
        token: 'Newline\nToken', // contains newline
        amount: '1.00',
        date: '2026-06-26T12:15:00Z',
        status: 'success',
        hash: 'normalhash',
      },
    ]

    const csv = serializeTransactionsToCSV(items)
    const expected = [
      'date,type,token,amount,tx hash',
      '2026-06-26T12:10:00Z,create,"My,Token",500,"hash""with""quotes"',
      '2026-06-26T12:15:00Z,other,"Newline\nToken",1.00,normalhash',
    ].join('\n')

    expect(csv).toBe(expected)
  })
})
