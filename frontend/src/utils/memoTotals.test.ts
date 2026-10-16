import { describe, expect, it } from 'vitest'

import { formatAmount, parseAmount, staleTotalsMessage, sumColumn } from './memoTotals'

/**
 * Reading amounts the way memos here write them, and adding them up.
 *
 * The cases that matter most are the refusals: a column of employee codes,
 * badge numbers or dates must never be summed, and a column with a heading
 * typed into a body row must say which cell stopped it rather than guess.
 */

describe('reading one amount', () => {
  it.each([
    ['1200', 1200, 0],
    ['1,200', 1200, 0],
    ['1,200,000', 1200000, 0],
    ['12,00,000', 1200000, 0],
    ['12.50', 1250, 2],
    ['0.5', 5, 1],
    ['Rs. 45,000', 45000, 0],
    ['Rs 45,000', 45000, 0],
    ['PKR 45,000/-', 45000, 0],
    ['45,000/-', 45000, 0],
    ['$1,200', 1200, 0],
    ['₹ 1,200', 1200, 0],
    ['1,200 PKR', 1200, 0],
    ['-1,200', -1200, 0],
    ['(1,200)', -1200, 0],
    ['( 1,200.75 )', -120075, 2],
    ['  1,200  ', 1200, 0],
    // A non-breaking space, which is what a pasted cell often carries.
    ['Rs.\xa01,200', 1200, 0],
  ])('reads %s', (text, scaled, decimals) => {
    expect(parseAmount(text)).toMatchObject({ scaled, decimals })
  })

  it('keeps the currency and the suffix, to write the total the same way', () => {
    expect(parseAmount('Rs. 1,25,000/-')).toMatchObject({
      prefix: 'Rs.',
      suffix: '/-',
      grouping: 'lakh',
      parenthesised: false,
    })
    expect(parseAmount('(1,200)')).toMatchObject({ parenthesised: true, grouping: 'thousands' })
    expect(parseAmount('1200')).toMatchObject({ grouping: 'none' })
  })

  it.each([
    [''],
    ['   '],
    ['Amount'],
    ['EMP1234'],
    ['EMP-1234'],
    ['Rs1200'],
    ['1200PKR'],
    ['2024-01-15'],
    ['0300-1234567'],
    ['1,2345'],
    ['1,200 per month'],
    ['(1,200'],
    ['1,200)'],
    ['-'],
    ['1 200'],
    ['12.'],
  ])('leaves %j alone', text => {
    expect(parseAmount(text)).toBeNull()
  })

  it('refuses a figure too large to add exactly', () => {
    expect(parseAmount('9,007,199,254,740,993')).toBeNull()
  })
})

describe('writing one back', () => {
  const plain = { decimals: 0, prefix: '', suffix: '', grouping: 'none' as const, parenthesised: false }

  it('groups by thousands and by lakh', () => {
    expect(formatAmount(1234567, { ...plain, grouping: 'thousands' })).toBe('1,234,567')
    expect(formatAmount(1234567, { ...plain, grouping: 'lakh' })).toBe('12,34,567')
    expect(formatAmount(999, { ...plain, grouping: 'lakh' })).toBe('999')
    expect(formatAmount(1000, { ...plain, grouping: 'lakh' })).toBe('1,000')
    expect(formatAmount(100000, { ...plain, grouping: 'lakh' })).toBe('1,00,000')
  })

  it('keeps the decimals, even when the sum is under one', () => {
    expect(formatAmount(5, { ...plain, decimals: 2 })).toBe('0.05')
    expect(formatAmount(123456, { ...plain, decimals: 2, grouping: 'thousands' })).toBe('1,234.56')
  })

  it('writes a negative the way the column did', () => {
    expect(formatAmount(-1200, { ...plain, grouping: 'thousands' })).toBe('-1,200')
    expect(formatAmount(-1200, { ...plain, grouping: 'thousands', parenthesised: true })).toBe(
      '(1,200)',
    )
  })

  it('places the currency the way it was written', () => {
    expect(formatAmount(1200, { ...plain, prefix: 'Rs.', grouping: 'thousands' })).toBe('Rs. 1,200')
    expect(formatAmount(1200, { ...plain, prefix: 'PKR', suffix: '/-', grouping: 'thousands' })).toBe(
      'PKR 1,200/-',
    )
    expect(formatAmount(1200, { ...plain, prefix: '$', grouping: 'thousands' })).toBe('$1,200')
    expect(formatAmount(1200, { ...plain, suffix: 'PKR', grouping: 'thousands' })).toBe('1,200 PKR')
  })
})

describe('adding up a column', () => {
  const cells = (...texts: string[]) => texts.map((text, at) => ({ text, where: `row ${at + 2}` }))

  it('adds the figures and skips the blanks', () => {
    expect(sumColumn(cells('1,200', '', '800', '  '))).toMatchObject({ ok: true, text: '2,000' })
  })

  it('takes the column’s own style: currency, suffix, most decimals, lakh grouping', () => {
    expect(sumColumn(cells('Rs. 1,25,000/-', 'Rs. 75,000/-'))).toMatchObject({
      ok: true,
      text: 'Rs. 2,00,000/-',
    })
    expect(sumColumn(cells('10.5', '2', '0.25'))).toMatchObject({ ok: true, text: '12.75' })
  })

  it('drops a currency the figures do not agree on', () => {
    expect(sumColumn(cells('Rs. 1,200', 'PKR 800'))).toMatchObject({ ok: true, text: '2,000' })
  })

  it('adds a deduction in brackets as a deduction', () => {
    expect(sumColumn(cells('5,000', '(1,200)'))).toMatchObject({ ok: true, text: '3,800' })
    expect(sumColumn(cells('1,000', '(1,200)'))).toMatchObject({ ok: true, text: '(200)' })
  })

  it('adds exactly, where floating point would not', () => {
    expect(sumColumn(cells('0.1', '0.2'))).toMatchObject({ ok: true, text: '0.3' })
  })

  it('refuses a column with a cell that is not a figure, and names it', () => {
    const outcome = sumColumn([
      { text: 'Amount', where: 'row 1' },
      { text: '1,200', where: 'row 2' },
    ])
    expect(outcome).toEqual({
      ok: false,
      reason: '“Amount” in row 1 is not a figure, so the column was not totalled.',
    })
  })

  it('refuses employee codes, however numeric they look', () => {
    expect(sumColumn(cells('EMP-1021', 'EMP-1022'))).toMatchObject({ ok: false })
  })

  it('refuses percentages, which do not add', () => {
    expect(sumColumn(cells('10%', '12%'))).toEqual({
      ok: false,
      reason: 'Percentages are not added up.',
    })
  })

  it('refuses a column with nothing in it', () => {
    expect(sumColumn(cells('', ''))).toEqual({
      ok: false,
      reason: 'There are no figures in that column to total.',
    })
  })

  it('refuses a sum that could not be exact', () => {
    expect(sumColumn(cells('9,007,199,254,740,000', '1,000'))).toMatchObject({
      ok: false,
      reason: 'Those figures are too large to add up exactly.',
    })
  })
})

describe('the sentence under the editor', () => {
  it('says nothing when every total is right', () => {
    expect(staleTotalsMessage([])).toBeNull()
  })

  it('names one column, or several', () => {
    expect(staleTotalsMessage(['Proposed salary'])).toBe(
      'The total under “Proposed salary” no longer matches the figures above it. Put the caret in the column and press Total column again, or correct it by hand.',
    )
    expect(staleTotalsMessage(['Current', 'Proposed', 'Increase'])).toMatch(
      /^The totals under “Current”, “Proposed” and “Increase” no longer match the figures above them\./,
    )
  })
})
