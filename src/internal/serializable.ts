/**
 * @since 0.1.0
 */

/**
 * @internal
 */
export const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype

/**
 * @internal
 */
export const cloneSerializable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneSerializable))
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      output[key] = cloneSerializable(value[key])
    }
    return Object.freeze(output)
  }
  return value
}
