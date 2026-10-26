export interface LabelPresetDesign {
  width: number
  height: number
  fields: Array<{
    kind: 'brand' | 'name' | 'rate' | 'code' | 'attr1' | 'attr2'
    x: number
    baseline: number
    capHeight: number
    maxWidth: number
    refWidth: number
  }>
  qr: { x: number; bottom: number; size: number; magnification: number; modules: number }
}

export interface LabelPreset {
  key: string
  label: string
  width: number
  height: number
  columns: number
  rows: number
  reference: boolean
  brand?: string
  codeLength?: number
  design?: LabelPresetDesign
}

const SLIM_DESIGN: LabelPresetDesign = {
  width: 50,
  height: 10,
  fields: [
    { kind: 'brand', x: 2.06, baseline: 3.125, capHeight: 2.5, maxWidth: 33.09, refWidth: 3.75 },
    { kind: 'name', x: 1.5, baseline: 7.25, capHeight: 2.5, maxWidth: 23.22, refWidth: 2.25 },
    { kind: 'code', x: 24.72, baseline: 3.75, capHeight: 3.125, maxWidth: 16.71, refWidth: 3.125 },
    { kind: 'rate', x: 24.72, baseline: 7.75, capHeight: 3.5, maxWidth: 16.71, refWidth: 2.5 },
  ],
  qr: { x: 41.43, bottom: 9.375, size: 7.875, magnification: 3, modules: 21 },
}

export const FALLBACK_LABEL_PRESETS: LabelPreset[] = [
  {
    key: 'label-50x40',
    label: '50 × 40 mm',
    width: 50,
    height: 40,
    columns: 4,
    rows: 7,
    reference: true,
    brand: 'OPAL LINE',
    design: {
      width: 50,
      height: 40,
      fields: [
        { kind: 'brand', x: 3.875, baseline: 9.125, capHeight: 6.625, maxWidth: 46.125, refWidth: 7 },
        { kind: 'name', x: 3.375, baseline: 15.375, capHeight: 4.625, maxWidth: 46.625, refWidth: 1.625 },
        { kind: 'rate', x: 3.125, baseline: 24.125, capHeight: 6.25, maxWidth: 30.75, refWidth: 4.125 },
        { kind: 'code', x: 3.375, baseline: 30.625, capHeight: 4, maxWidth: 30.5, refWidth: 4.75 },
        { kind: 'attr1', x: 3.375, baseline: 36.125, capHeight: 3.125, maxWidth: 16.75, refWidth: 5.75 },
        { kind: 'attr2', x: 20.125, baseline: 36.125, capHeight: 3.125, maxWidth: 13.75, refWidth: 5.75 },
      ],
      qr: { x: 33.875, bottom: 35.5, size: 15.75, magnification: 6, modules: 21 },
    },
  },
  {
    key: 'label-50x25',
    label: '50 × 25 mm',
    width: 50,
    height: 25,
    columns: 4,
    rows: 11,
    reference: true,
    brand: 'OPAL LINE',
    design: {
      width: 50,
      height: 25,
      fields: [
        { kind: 'brand', x: 4.125, baseline: 4.875, capHeight: 3.875, maxWidth: 45.875, refWidth: 6.625 },
        { kind: 'name', x: 3.375, baseline: 8.625, capHeight: 3, maxWidth: 46.625, refWidth: 1.625 },
        { kind: 'rate', x: 3.375, baseline: 13.375, capHeight: 3.75, maxWidth: 31.375, refWidth: 3.75 },
        { kind: 'code', x: 3.375, baseline: 17.875, capHeight: 3, maxWidth: 31.375, refWidth: 3.75 },
        { kind: 'attr1', x: 3.375, baseline: 22, capHeight: 2.625, maxWidth: 13.75, refWidth: 4.75 },
        { kind: 'attr2', x: 17.125, baseline: 21.75, capHeight: 2.375, maxWidth: 17.625, refWidth: 4.375 },
      ],
      qr: { x: 34.75, bottom: 21.625, size: 10.5, magnification: 4, modules: 21 },
    },
  },
  {
    key: 'label-35x22',
    label: '35 × 22 mm',
    width: 35,
    height: 22,
    columns: 5,
    rows: 13,
    reference: true,
    brand: 'OPAL LINE',
    design: {
      width: 35,
      height: 22,
      fields: [
        { kind: 'brand', x: 2.875, baseline: 4.875, capHeight: 3.875, maxWidth: 32.125, refWidth: 4.375 },
        { kind: 'name', x: 2.875, baseline: 9, capHeight: 3.75, maxWidth: 32.125, refWidth: 1.875 },
        { kind: 'rate', x: 2.875, baseline: 13.375, capHeight: 3, maxWidth: 21.375, refWidth: 2.875 },
        { kind: 'code', x: 2.875, baseline: 16.875, capHeight: 2, maxWidth: 21.375, refWidth: 2.875 },
        { kind: 'attr1', x: 2.875, baseline: 19.875, capHeight: 2, maxWidth: 11.75, refWidth: 3.5 },
        { kind: 'attr2', x: 14.625, baseline: 19.875, capHeight: 2, maxWidth: 9.625, refWidth: 3.75 },
      ],
      qr: { x: 24.25, bottom: 20.375, size: 7.875, magnification: 3, modules: 21 },
    },
  },
  {
    key: 'label-50x10',
    label: '50 × 10 mm · Standard',
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    reference: true,
    brand: 'OPAL LINE',
    design: SLIM_DESIGN,
  },
  {
    key: 'label-50x10-loni',
    label: '50 × 10 mm · Alternate',
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    reference: true,
    brand: 'OPAL LINE',
    design: SLIM_DESIGN,
  },
  {
    key: 'label-50x10-compact',
    label: '50 × 10 mm · Compact',
    width: 50,
    height: 10,
    columns: 4,
    rows: 28,
    reference: true,
    brand: 'OPAL LINE',
    design: SLIM_DESIGN,
  },
]

function close(a: number, b: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) <= 0.001
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLabelPreset(value: unknown): value is LabelPreset {
  if (!isRecord(value) || !isRecord(value.design)) return false
  return (
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    typeof value.columns === 'number' &&
    typeof value.rows === 'number' &&
    typeof value.reference === 'boolean' &&
    (value.brand === undefined || typeof value.brand === 'string') &&
    (value.codeLength === undefined || typeof value.codeLength === 'number') &&
    Array.isArray(value.design.fields) &&
    isRecord(value.design.qr)
  )
}

function sameGeometry(actual: LabelPresetDesign, expected: LabelPresetDesign): boolean {
  if (
    !isRecord(actual.qr) ||
    !Array.isArray(actual.fields) ||
    !close(actual.width, expected.width) ||
    !close(actual.height, expected.height) ||
    actual.fields.length !== expected.fields.length ||
    !close(actual.qr.x, expected.qr.x) ||
    !close(actual.qr.bottom, expected.qr.bottom) ||
    !close(actual.qr.size, expected.qr.size) ||
    actual.qr.magnification !== expected.qr.magnification ||
    actual.qr.modules !== expected.qr.modules
  ) return false

  return actual.fields.every((field, index) => {
    if (!isRecord(field)) return false
    const reference = expected.fields[index]
    return field.kind === reference.kind &&
      close(field.x, reference.x) &&
      close(field.baseline, reference.baseline) &&
      close(field.capHeight, reference.capHeight) &&
      close(field.maxWidth, reference.maxWidth) &&
      close(field.refWidth, reference.refWidth)
  })
}

function hasValidGeometry(preset: LabelPreset): boolean {
  const design = preset.design
  if (!design || !Array.isArray(design.fields) || design.fields.length === 0) return false
  if (
    !Number.isFinite(preset.width) ||
    !Number.isFinite(preset.height) ||
    !close(design.width, preset.width) ||
    !close(design.height, preset.height) ||
    !Number.isFinite(design.qr.x) ||
    !Number.isFinite(design.qr.bottom) ||
    !Number.isFinite(design.qr.size) ||
    design.qr.size <= 0 ||
    !Number.isInteger(design.qr.modules) ||
    design.qr.modules <= 0 ||
    !Number.isInteger(design.qr.magnification) ||
    design.qr.magnification <= 0 ||
    design.qr.x < 0 ||
    design.qr.x + design.qr.size > preset.width + 0.001 ||
    design.qr.bottom > preset.height + 0.001
  ) return false

  const qrTop = design.qr.bottom - ((design.qr.modules + 3) * design.qr.size) / design.qr.modules
  if (qrTop < -0.001) return false

  const allowedKinds = new Set(['brand', 'name', 'rate', 'code', 'attr1', 'attr2'])
  return design.fields.every((field) =>
    isRecord(field) &&
    typeof field.kind === 'string' &&
    allowedKinds.has(field.kind) &&
    Number.isFinite(field.x) &&
    Number.isFinite(field.baseline) &&
    Number.isFinite(field.capHeight) &&
    Number.isFinite(field.maxWidth) &&
    Number.isFinite(field.refWidth) &&
    field.x >= 0 &&
    field.baseline > 0 &&
    field.baseline <= preset.height &&
    field.capHeight > 0 &&
    field.maxWidth > 0 &&
    field.x + field.maxWidth <= preset.width + 0.001 &&
    field.refWidth > 0,
  )
}

/** Verify the server's six known templates against the bundled approved layouts. */
export function validateReferenceLabelPresets(
  actualPresets: unknown,
  expectedPresets: LabelPreset[],
): boolean {
  if (!Array.isArray(actualPresets)) return false
  return expectedPresets.every((expected) => {
    const actual = actualPresets.find(
      (candidate): candidate is LabelPreset => isLabelPreset(candidate) && candidate.key === expected.key,
    )
    if (!actual || !actual.design || !expected.design) return false
    return Boolean(
      actual.width === expected.width &&
      actual.height === expected.height &&
      actual.brand === expected.brand &&
      actual.codeLength === expected.codeLength &&
      hasValidGeometry(actual) &&
      sameGeometry(actual.design, expected.design),
    )
  })
}
