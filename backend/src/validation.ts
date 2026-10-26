import { z } from 'zod'
import type { Request, Response, NextFunction } from 'express'

// GSTIN: 2-digit state code, 10-char PAN (5 letters, 4 digits, 1 letter),
// entity code, the literal 'Z', then a checksum character.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trims and upper-cases a GSTIN. Empty stays empty. */
export function normalizeGstin(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/** True when the value is empty (allowed) or a well-formed 15-character GSTIN. */
export function isValidGstin(value: unknown): boolean {
  const v = normalizeGstin(value)
  return v === '' || GSTIN_REGEX.test(v)
}

/** Trims an email address. Empty stays empty. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim()
}

/** True when the value is empty (allowed) or a plausible email address. */
export function isValidEmail(value: unknown): boolean {
  const v = normalizeEmail(value)
  return v === '' || (v.length <= 255 && EMAIL_REGEX.test(v))
}

/**
 * Validation shared by the supplier create/update routes. Name is the only
 * required field; email and GSTIN are optional but must be well-formed when
 * present. Returns an error message, or null when the payload is acceptable.
 */
export function validateSupplierInput(
  input: { name?: unknown; email?: unknown; gstin?: unknown },
  opts: { requireName?: boolean } = {},
): string | null {
  if (opts.requireName !== false && !String(input.name ?? '').trim()) return 'Supplier name is required'
  if (!isValidEmail(input.email)) return 'Enter a valid email address'
  if (!isValidGstin(input.gstin)) return 'Enter a valid 15-character GSTIN'
  return null
}

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(255)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character')

export const loginSchema = z.object({
  username: z.string().min(1, 'Username or email is required').max(255),
  password: z.string().min(1, 'Password is required').max(255),
})

export const createOrderSchema = z.object({
  customer: z.string().min(1, 'Customer is required').max(255),
  email: z.string().email('Invalid email').max(255).optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  payment: z.string().max(50).optional().or(z.literal('')),
  fulfillment: z.string().max(50).optional().or(z.literal('')),
  status: z.string().max(50).optional().or(z.literal('')),
  date: z.string().datetime().optional().or(z.literal('')),
  note: z.string().max(1000).optional().or(z.literal('')),
  // Which shop the order was rung up at. Zod strips keys the schema does not
  // declare, so omitting this here silently discarded the location before the
  // handler ever saw it.
  locationId: z.string().max(100).optional().or(z.literal('')),
  items: z.array(z.object({
    title: z.string().min(1).max(255),
    sku: z.string().max(100).optional(),
    productSku: z.string().max(100).optional(),
    quantity: z.number().int().min(1),
    price: z.number().min(0),
    // Shopify ProductVariant id (numeric or gid:// form) when the line was
    // billed against a specific variant. Optional so flat products and every
    // existing client keep working unchanged.
    variantId: z.union([z.string().max(120), z.number()]).optional(),
  })).min(1, 'At least one item is required'),
  billingAddress: z.object({
    name: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    address1: z.string().max(255).optional(),
    address2: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(100).optional(),
    zip: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
  }).optional(),
  shippingAddress: z.object({
    name: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    address1: z.string().max(255).optional(),
    address2: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(100).optional(),
    zip: z.string().max(20).optional(),
    country: z.string().max(100).optional(),
  }).optional(),
  syncToShopify: z.boolean().optional(),
})

export const updateOrderSchema = createOrderSchema.partial()

export const silverRateSchema = z.object({
  rate: z.number().positive('Rate must be positive').finite('Rate must be a valid number'),
  syncFirst: z.boolean().optional(),
})

export const pushProductsSchema = z.object({
  // Accepts both UUID PKs and legacy short ids (e.g. '007', 'P006') that exist in the table
  ids: z.array(z.string().min(1).max(64)).optional(),
})

export const pushInventorySchema = z.object({
  // Same as pushProductsSchema: legacy short ids are valid product PKs
  ids: z.array(z.string().min(1).max(64)).optional(),
})

export const productPriceSchema = z.object({
  // Local product id — accepts UUID PKs and legacy short ids ('007', 'P006')
  id: z.string().min(1).max(64),
})

export const createInvoiceSchema = z.object({
  number: z.string().min(1, 'Invoice number is required').max(100),
  customer: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional().or(z.literal('')),
  date: z.string().datetime().optional(),
  paymentMethod: z.string().max(100).optional(),
  paymentStatus: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  subtotal: z.number().min(0).optional(),
  gst: z.number().min(0).max(100).optional(),
  gstAmount: z.number().min(0).optional(),
  discount: z.number().min(0).optional(),
  grandTotal: z.number().min(0).optional(),
  items: z.array(z.object({
    product: z.string().max(255),
    sku: z.string().max(100),
    qty: z.number().int().min(1),
    weight: z.number().min(0).optional(),
    silverRate: z.number().min(0).optional(),
    makingCharge: z.number().min(0).optional(),
    tax: z.number().min(0).optional(),
    amount: z.number().min(0).optional(),
  })).optional(),
})

export const updateInvoiceSchema = createInvoiceSchema.partial()

export const createProductSchema = z.object({
  name: z.string().min(1, 'Product name is required').max(255),
  sku: z.string().min(1, 'SKU is required').max(100),
  category: z.string().min(1, 'Category is required').max(100),
  collection: z.string().max(100).optional().or(z.literal('')),
  purity: z.number().min(0).max(100).optional(),
  grossWeight: z.number().min(0).optional(),
  stoneWeight: z.number().min(0).optional(),
  netWeight: z.number().min(0).optional(),
  makingCharge: z.number().min(0).optional(),
  gst: z.number().min(0).max(100).optional(),
  hsn: z.string().max(50).optional().or(z.literal('')),
  supplier: z.string().max(255).optional().or(z.literal('')),
  silverRate: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  compareAtPrice: z.number().min(0).optional(),
  stock: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).optional(),
  shopifyId: z.string().max(100).optional().or(z.literal('')),
  status: z.string().max(50).optional().or(z.literal('')),
  image: z.string().url().max(500).optional().or(z.literal('')),
  vendor: z.string().max(255).optional().or(z.literal('')),
  productType: z.string().max(100).optional().or(z.literal('')),
  tags: z.string().max(500).optional().or(z.literal('')),
  trackInventory: z.boolean().optional(),
})

export const updateProductSchema = createProductSchema.partial()

// ─── Shopify-style product variants ────────────────────────────────────────
// Option definitions on the parent product (max 3, matching Shopify's limit),
// and one validated row per option-value combination.
export const productOptionSchema = z.object({
  name: z.string().min(1, 'Option name is required').max(100),
  values: z.array(z.string().min(1).max(100)).min(1, 'At least one value is required').max(50),
})

export const productVariantSchema = z.object({
  id: z.string().max(64).optional(),
  title: z.string().min(1, 'Variant title is required').max(255),
  optionValues: z.array(z.string().min(1).max(100)).min(1).max(3),
  sku: z.string().min(1, 'Variant SKU is required').max(100),
  sellingPrice: z.number().min(0).optional(),
  compareAtPrice: z.number().min(0).optional(),
  costPrice: z.number().min(0).optional(),
  grossWeight: z.number().min(0).optional(),
  stock: z.number().int().min(0),
  reorderLevel: z.number().int().min(0).optional(),
  status: z.string().max(50).optional(),
})

export const saveProductVariantsSchema = z.object({
  options: z.array(productOptionSchema).min(1, 'At least one option is required').max(3),
  variants: z.array(productVariantSchema).min(1, 'At least one variant is required').max(200),
})

export const createCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required').max(255),
  email: z.string().email('Invalid email').max(255).optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  province: z.string().max(100).optional().or(z.literal('')),
  shopifyId: z.string().max(100).optional().or(z.literal('')),
  status: z.string().max(50).optional().or(z.literal('')),
})

export const updateCustomerSchema = createCustomerSchema.partial()

export const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email').max(255),
  username: z.string().min(3, 'Username must be at least 3 characters').max(50).regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores').optional().or(z.literal('')),
  password: strongPassword.optional(),
  role: z.string().max(50),
  status: z.string().max(50).optional(),
  avatarColor: z.string().max(20).optional(),
  permissions: z.record(z.string(), z.object({
    view: z.boolean(),
    create: z.boolean(),
    edit: z.boolean(),
    delete: z.boolean(),
  })).optional(),
})

export const updateUserSchema = createUserSchema.partial()

export const syncSchema = z.object({
  resources: z.array(z.enum(['orders', 'products', 'customers', 'inventory', 'price'])).optional(),
})

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: strongPassword,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: strongPassword,
})

// Either rotate the superadmin recovery password to a new strong value or
// reset it back to the built-in default.
export const recoveryPasswordSchema = z.union([
  z.object({ password: strongPassword }),
  z.object({ reset: z.literal(true) }),
])

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
})

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      })
    }
    req.body = result.data
    next()
  }
}

export { z }