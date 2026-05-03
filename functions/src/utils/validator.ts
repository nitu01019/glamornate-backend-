import { z } from 'zod';

export const ServiceCategorySchema = z.enum([
  'massage',
  'facial',
  'body',
  'pedicure',
  'manicure',
  'wellness',
]);

export const RoleSchema = z.enum(['customer', 'spa_owner', 'spa_staff', 'admin']);

// Post-Stripe state machine (pay-at-spa only). The 6-state closed set:
// confirmed -> en_route -> in_progress -> completed | cancelled | no_show.
export const BookingStatusSchema = z.enum([
  'confirmed',
  'en_route',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
]);

export const SpaStatusSchema = z.enum([
  'active',
  'pending',
  'suspended',
  'verified',
  'rejected',
]);

export const TherapistStatusSchema = z.enum(['online', 'offline']);

export const VoucherTypeSchema = z.enum(['discount', 'gift_card', 'referral']);

export const DiscountTypeSchema = z.enum(['percentage', 'fixed', 'free_service']);

export const TransactionTypeSchema = z.enum([
  'booking_payment',
  'refund',
  'payout',
  'platform_fee',
]);

export const PayoutStatusSchema = z.enum(['pending', 'processing', 'paid']);

export const NotificationTypeSchema = z.enum([
  'booking_created',
  'booking_confirmed',
  'booking_cancelled',
  'new_booking',
  'refund_initiated',
  'reminder',
  'daily_reminder',
  'review',
  'welcome',
]);

export const GeoPointSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const MoneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
});

export const TimeSlotSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  isOpen: z.boolean(),
});

export const OperatingHoursSchema = z.object({
  mon: TimeSlotSchema,
  tue: TimeSlotSchema,
  wed: TimeSlotSchema,
  thu: TimeSlotSchema,
  fri: TimeSlotSchema,
  sat: TimeSlotSchema,
  sun: TimeSlotSchema,
});

// Validation helpers
export function validatePhoneNumber(phone: string): boolean {
  const phoneRegex = /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,9}$/;
  return phoneRegex.test(phone);
}

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validatePincode(pincode: string): boolean {
  const pincodeRegex = /^\d{6}$/;
  return pincodeRegex.test(pincode);
}

export function validateTime(time: string): boolean {
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
}

export function validateSlug(slug: string): boolean {
  const slugRegex = /^[a-z0-9-]+$/;
  return slugRegex.test(slug) && slug.length >= 3 && slug.length <= 100;
}

export function sanitizeInput(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim();
}

export const sanitizationMiddleware = <T extends z.ZodTypeAny>(schema: T) => {
  return z.preprocess((data) => {
    if (typeof data === 'object' && data !== null) {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
          sanitized[key] = sanitizeInput(value);
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }
    return data;
  }, schema);
};
