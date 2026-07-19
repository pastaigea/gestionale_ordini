import { describe, expect, it } from 'vitest'
import { forbidden } from './public-bundle-rules.mjs'

describe('controllo credenziali Fatture in Cloud', () => {
  const rule = forbidden.find(({ label }) => label === 'credenziale Fatture in Cloud')

  it.each([
    'FIC_TOKEN',
    'FIC_MANUAL_TOKEN',
    'FIC_ACCESS_TOKEN',
    'FIC_REFRESH_TOKEN',
    'FIC_CLIENT_SECRET',
    'FATTURE_IN_CLOUD_TOKEN',
    'FATTURE_IN_CLOUD_MANUAL_TOKEN',
  ])('intercetta il marcatore %s', (marker) => {
    expect(rule?.pattern.test(marker)).toBe(true)
  })

  it('non blocca un identificatore azienda pubblico', () => {
    expect(rule?.pattern.test('FIC_COMPANY_ID')).toBe(false)
  })
})
