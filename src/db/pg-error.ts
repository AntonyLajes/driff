/**
 * Postgres error helpers that walk the error's `cause` chain.
 *
 * drizzle-orm wraps driver errors in a `DrizzleQueryError` whose `.code` is
 * undefined — the real `PostgresError` (with `code`/`constraint_name`) sits in
 * `.cause`. Checking only the top-level object misses unique violations, so the
 * slug-collision retry never fires and the request 500s. Always unwrap.
 */

const MAX_CAUSE_DEPTH = 5;

const walkCauses = function* (err: unknown): Generator<Record<string, unknown>> {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") {
      return;
    }
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
};

/** True when `err` (or any of its causes) is a Postgres unique violation (23505). */
export const isUniqueViolation = (err: unknown): boolean => {
  for (const node of walkCauses(err)) {
    if (node.code === "23505") {
      return true;
    }
  }
  return false;
};

/** Name of the violated unique constraint/index, if this is a unique violation. */
export const uniqueViolationConstraint = (err: unknown): string | null => {
  if (!isUniqueViolation(err)) {
    return null;
  }
  for (const node of walkCauses(err)) {
    const name = node.constraint_name ?? node.constraint;
    if (typeof name === "string") {
      return name;
    }
  }
  return null;
};
