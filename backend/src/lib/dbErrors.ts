/**
 * Turn a Drizzle/postgres-js error into something an operator can act on.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose `message`
 * is only `Failed query: insert into "sales_orders" (…) params: …` — the real
 * cause (PostgreSQL error code, constraint/column/table, detail) hangs off
 * `cause`. Routes used to return that wrapper verbatim, so the UI showed a SQL
 * fragment and hid the actual problem. Everything user-facing goes through
 * here instead, while the full error is still logged by the caller.
 */

export interface DbErrorInfo {
  /** PostgreSQL SQLSTATE, e.g. 23505 (unique violation). */
  code?: string
  constraint?: string
  column?: string
  table?: string
  detail?: string
  /** The driver's own message (never the "Failed query" wrapper). */
  message: string
}

interface PgErrorShape {
  code?: unknown
  constraint?: unknown
  column?: unknown
  table?: unknown
  detail?: unknown
  message?: unknown
  cause?: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The PostgreSQL error carried in `cause` (Drizzle) or the error itself. */
export function dbErrorInfo(err: unknown): DbErrorInfo {
  if (!err || typeof err !== 'object') {
    return { message: typeof err === 'string' ? err : 'Unknown database error' }
  }
  const outer = err as PgErrorShape
  const cause = (outer.cause && typeof outer.cause === 'object' ? outer.cause : outer) as PgErrorShape
  const message =
    asString(cause.message) ?? asString(outer.message) ?? 'Unknown database error'
  return {
    code: asString(cause.code),
    constraint: asString(cause.constraint),
    column: asString(cause.column),
    table: asString(cause.table),
    detail: asString(cause.detail),
    message,
  }
}

/**
 * A short, operator-readable explanation with the concrete object named.
 * Falls back to the driver message so a database problem is never swallowed.
 */
export function describeDbError(err: unknown): string {
  const info = dbErrorInfo(err)
  switch (info.code) {
    case '23505': { // unique_violation
      // postgres-js reports the constraint inside the message, not on a field.
      const constraint = info.constraint ?? info.message.match(/unique constraint "([^"]+)"/)?.[1]
      const detail = info.detail ? ` — ${info.detail}` : ''
      return `a record with the same unique value already exists${constraint ? ` (constraint ${constraint})` : ''}${detail}`
    }
    case '23502': // not_null_violation
      return `a required field is missing${info.column ? ` (${info.column})` : info.constraint ? ` (constraint ${info.constraint})` : ''}`
    case '23503': // foreign_key_violation
      return `the record references data that does not exist${info.constraint ? ` (constraint ${info.constraint})` : ''}`
    case '42703': // undefined_column
      return `the database is missing the column${info.column ? ` "${info.column}"` : ''}${info.table ? ` on ${info.table}` : ''} — apply the pending migrations and restart`
    case '42P01': // undefined_table
      return `the database is missing the table${info.table ? ` "${info.table}"` : ''} — apply the pending migrations and restart`
    case '22P02': // invalid_text_representation
    case '22003': // numeric_value_out_of_range
    case '22001': // string_data_right_truncation
      return `a value could not be stored in the column's data type${info.column ? ` (${info.column})` : ''}: ${info.message}`
    default:
      return info.message
  }
}
