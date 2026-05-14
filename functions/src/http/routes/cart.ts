/**
 * Cart routes.
 *
 * - POST /cart/preview  — canonical price + availability preview (stateless,
 *                         no persistence). Echoes the caller's items back with
 *                         current prices, durations, and availability flags so
 *                         the UI can render an accurate summary.
 * - POST /cart/validate — alias preserved for legacy mobile clients that were
 *                         shipped before the rename in Round 5 C-6.
 *
 * Auth model — NONE (matches the legacy Next.js handlers).
 *
 * Response envelope: `ApiResponse<CartPreviewData>` from `@glamornate/contracts`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { catalogServices } from '../../shared/catalog';
import { okResponse, errResponse } from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const cartRouter = Router();

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------
const CartItemSchema = z.object({
  serviceId: z.string().min(1, 'serviceId is required'),
  quantity: z.number().int().min(1).max(10).optional(),
});

const CartPreviewBodySchema = z.object({
  items: z
    .array(CartItemSchema)
    .min(1, 'Cart is empty')
    .max(50, 'Cart cannot exceed 50 items'),
});

type CartPreviewBody = z.infer<typeof CartPreviewBodySchema>;

interface CartItemPreview {
  serviceId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  originalPrice: number | null;
  discountPercent: number | null;
  duration: string;
  durationMinutes: number;
  lineTotal: number;
  available: boolean;
}

interface CartPreviewData {
  items: CartItemPreview[];
  summary: {
    itemCount: number;
    subtotal: number;
    totalSavings: number;
    totalDurationMinutes: number;
    currency: string;
  };
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Pure preview logic (no I/O). Reused by the two route handlers below.
// ---------------------------------------------------------------------------
function buildPreview(body: CartPreviewBody): CartPreviewData {
  const validated: CartItemPreview[] = [];
  const warnings: string[] = [];

  for (const item of body.items) {
    const quantity = Math.max(1, Math.min(item.quantity ?? 1, 10));
    const service = catalogServices.find((s) => s.id === item.serviceId);
    if (!service) {
      warnings.push(`Service not found: ${item.serviceId}`);
      validated.push({
        serviceId: item.serviceId,
        name: 'Unknown Service',
        quantity,
        unitPrice: 0,
        originalPrice: null,
        discountPercent: null,
        duration: '0min',
        durationMinutes: 0,
        lineTotal: 0,
        available: false,
      });
      continue;
    }
    if (!service.isActive) {
      warnings.push(`Service unavailable: ${service.name}`);
    }
    validated.push({
      serviceId: service.id,
      name: service.name,
      quantity,
      unitPrice: service.basePrice,
      originalPrice: service.originalPrice ?? null,
      discountPercent: service.discountPercent ?? null,
      duration: service.duration,
      durationMinutes: service.durationMinutes,
      lineTotal: service.basePrice * quantity,
      available: service.isActive,
    });
  }

  const subtotal = validated.reduce((sum, v) => sum + v.lineTotal, 0);
  const totalDurationMinutes = validated.reduce(
    (sum, v) => sum + v.durationMinutes * v.quantity,
    0,
  );
  const totalSavings = validated.reduce((sum, v) => {
    if (v.originalPrice !== null && v.available) {
      return sum + (v.originalPrice - v.unitPrice) * v.quantity;
    }
    return sum;
  }, 0);

  const data: CartPreviewData = {
    items: validated,
    summary: {
      itemCount: validated.filter((v) => v.available).length,
      subtotal,
      totalSavings,
      totalDurationMinutes,
      currency: 'INR',
    },
  };
  if (warnings.length > 0) {
    data.warnings = warnings;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
function handlePreview(req: Request, res: Response): void {
  try {
    const body = getValidated<CartPreviewBody>(req, 'body');
    const data = buildPreview(body);
    res.json(okResponse(data));
  } catch (error) {
    // eslint-disable-next-line no-console -- server-side diagnostic only; response body stays sanitized
    console.error('[cart] preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to preview cart';
    res.status(500).json(errResponse(message));
  }
}

cartRouter.post(
  '/cart/preview',
  validate('body', CartPreviewBodySchema),
  handlePreview,
);

// Legacy alias — identical behavior.
cartRouter.post(
  '/cart/validate',
  validate('body', CartPreviewBodySchema),
  handlePreview,
);
