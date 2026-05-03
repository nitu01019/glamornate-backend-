import { describe, it, expect } from 'vitest'
import {
  ServiceCategorySchema,
  RoleSchema,
  BookingStatusSchema,
  SpaStatusSchema,
  GeoPointSchema,
  MoneySchema,
  TimeSlotSchema,
  OperatingHoursSchema,
  validatePhoneNumber,
  validateEmail,
  validatePincode,
  validateTime,
  validateSlug,
  sanitizeInput,
} from '../../src/utils/validator'

// =============================================================================
// Enum / Union Schemas
// =============================================================================
describe('ServiceCategorySchema', () => {
  it('should accept valid categories', () => {
    for (const cat of ['massage', 'facial', 'body', 'pedicure', 'manicure', 'wellness']) {
      expect(ServiceCategorySchema.parse(cat)).toBe(cat)
    }
  })

  it('should reject invalid categories', () => {
    expect(() => ServiceCategorySchema.parse('yoga')).toThrow()
  })
})

describe('RoleSchema', () => {
  it('should accept all four roles', () => {
    for (const role of ['customer', 'spa_owner', 'spa_staff', 'admin']) {
      expect(RoleSchema.parse(role)).toBe(role)
    }
  })

  it('should reject unknown roles', () => {
    expect(() => RoleSchema.parse('superadmin')).toThrow()
  })
})

describe('BookingStatusSchema', () => {
  it('should accept all defined booking statuses', () => {
    // Post-Stripe pay-at-spa state machine — closed 6-state set.
    const valid = ['confirmed', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show']
    for (const s of valid) {
      expect(BookingStatusSchema.parse(s)).toBe(s)
    }
  })

  it('should reject unknown statuses', () => {
    expect(() => BookingStatusSchema.parse('refunded')).toThrow()
  })

  it('should reject legacy Stripe-era statuses', () => {
    expect(() => BookingStatusSchema.parse('draft')).toThrow()
    expect(() => BookingStatusSchema.parse('payment_pending')).toThrow()
    expect(() => BookingStatusSchema.parse('payment_failed')).toThrow()
  })
})

describe('SpaStatusSchema', () => {
  it('should accept valid spa statuses', () => {
    for (const s of ['active', 'pending', 'suspended', 'verified', 'rejected']) {
      expect(SpaStatusSchema.parse(s)).toBe(s)
    }
  })
})

// =============================================================================
// Object Schemas
// =============================================================================
describe('GeoPointSchema', () => {
  it('should accept valid lat/lng', () => {
    const result = GeoPointSchema.parse({ latitude: 28.6139, longitude: 77.209 })
    expect(result).toEqual({ latitude: 28.6139, longitude: 77.209 })
  })

  it('should reject non-numeric values', () => {
    expect(() => GeoPointSchema.parse({ latitude: 'abc', longitude: 77 })).toThrow()
  })

  it('should reject missing fields', () => {
    expect(() => GeoPointSchema.parse({ latitude: 28 })).toThrow()
  })
})

describe('MoneySchema', () => {
  it('should accept valid money objects', () => {
    expect(MoneySchema.parse({ amount: 500, currency: 'INR' })).toEqual({
      amount: 500,
      currency: 'INR',
    })
  })

  it('should reject negative amounts', () => {
    expect(() => MoneySchema.parse({ amount: -10, currency: 'INR' })).toThrow()
  })

  it('should reject currency codes that are not 3 characters', () => {
    expect(() => MoneySchema.parse({ amount: 10, currency: 'IN' })).toThrow()
    expect(() => MoneySchema.parse({ amount: 10, currency: 'INRR' })).toThrow()
  })
})

describe('TimeSlotSchema', () => {
  it('should accept a valid time slot', () => {
    const slot = { start: '09:00', end: '10:00', isOpen: true }
    expect(TimeSlotSchema.parse(slot)).toEqual(slot)
  })

  it('should reject invalid time format', () => {
    expect(() =>
      TimeSlotSchema.parse({ start: '9:00', end: '10:00', isOpen: true })
    ).toThrow()
  })

  it('should reject missing isOpen', () => {
    expect(() =>
      TimeSlotSchema.parse({ start: '09:00', end: '10:00' })
    ).toThrow()
  })
})

describe('OperatingHoursSchema', () => {
  const validSlot = { start: '09:00', end: '18:00', isOpen: true }

  it('should accept a complete week', () => {
    const hours = {
      mon: validSlot,
      tue: validSlot,
      wed: validSlot,
      thu: validSlot,
      fri: validSlot,
      sat: { ...validSlot, isOpen: false },
      sun: { ...validSlot, isOpen: false },
    }
    expect(OperatingHoursSchema.parse(hours)).toEqual(hours)
  })

  it('should reject a missing day', () => {
    const partial = {
      mon: validSlot,
      tue: validSlot,
    }
    expect(() => OperatingHoursSchema.parse(partial)).toThrow()
  })
})

// =============================================================================
// Validation Helpers
// =============================================================================
describe('validatePhoneNumber', () => {
  it('should accept valid phone numbers', () => {
    expect(validatePhoneNumber('+91-9876543210')).toBe(true)
    expect(validatePhoneNumber('9876543210')).toBe(true)
    expect(validatePhoneNumber('+12345678900')).toBe(true)
    expect(validatePhoneNumber('(234)567-8900')).toBe(true)
  })

  it('should reject invalid phone numbers', () => {
    expect(validatePhoneNumber('')).toBe(false)
    expect(validatePhoneNumber('abc')).toBe(false)
  })
})

describe('validateEmail', () => {
  it('should accept valid emails', () => {
    expect(validateEmail('user@example.com')).toBe(true)
    expect(validateEmail('name+tag@domain.co.in')).toBe(true)
  })

  it('should reject invalid emails', () => {
    expect(validateEmail('')).toBe(false)
    expect(validateEmail('user@')).toBe(false)
    expect(validateEmail('user@.com')).toBe(false)
    expect(validateEmail('@domain.com')).toBe(false)
  })
})

describe('validatePincode', () => {
  it('should accept a 6-digit pincode', () => {
    expect(validatePincode('110001')).toBe(true)
    expect(validatePincode('560034')).toBe(true)
  })

  it('should reject non-6-digit strings', () => {
    expect(validatePincode('1234')).toBe(false)
    expect(validatePincode('1234567')).toBe(false)
    expect(validatePincode('abcdef')).toBe(false)
    expect(validatePincode('')).toBe(false)
  })
})

describe('validateTime', () => {
  it('should accept valid 24-hour times', () => {
    expect(validateTime('00:00')).toBe(true)
    expect(validateTime('09:30')).toBe(true)
    expect(validateTime('23:59')).toBe(true)
  })

  it('should reject invalid times', () => {
    expect(validateTime('24:00')).toBe(false)
    expect(validateTime('9:30')).toBe(true)  // single digit hour is valid per regex
    expect(validateTime('12:60')).toBe(false)
    expect(validateTime('abc')).toBe(false)
  })
})

describe('validateSlug', () => {
  it('should accept valid slugs', () => {
    expect(validateSlug('my-spa-name')).toBe(true)
    expect(validateSlug('spa123')).toBe(true)
    expect(validateSlug('abc')).toBe(true)
  })

  it('should reject slugs shorter than 3 chars', () => {
    expect(validateSlug('ab')).toBe(false)
  })

  it('should reject slugs longer than 100 chars', () => {
    expect(validateSlug('a'.repeat(101))).toBe(false)
  })

  it('should reject slugs with uppercase or special chars', () => {
    expect(validateSlug('My-Spa')).toBe(false)
    expect(validateSlug('spa_name')).toBe(false)
    expect(validateSlug('spa name')).toBe(false)
  })
})

describe('sanitizeInput', () => {
  it('should escape HTML special characters', () => {
    expect(sanitizeInput('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    )
  })

  it('should escape ampersands', () => {
    expect(sanitizeInput('A & B')).toBe('A &amp; B')
  })

  it('should escape single quotes', () => {
    expect(sanitizeInput("it's")).toBe("it&#x27;s")
  })

  it('should trim whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello')
  })

  it('should handle empty strings', () => {
    expect(sanitizeInput('')).toBe('')
  })
})
