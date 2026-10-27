/** Conditions read stable own data fields supplied by the application. */
import * as Arr from "effect/Array"

/** A missing value, an accessor, or `undefined` reads as `null`. */
export const readPart = (value: unknown, name: string): unknown => {
	if (typeof value !== "object" || value === null) return null
	const property = Object.getOwnPropertyDescriptor(value, name)
	return property !== undefined &&
		"value" in property &&
		property.value !== undefined
		? property.value
		: null
}

/** Reads the own data fields of a path. */
export const readPath = (
	value: unknown,
	names: ReadonlyArray<string>,
): unknown =>
	Arr.reduce(names, value, (current, name) => readPart(current, name))
