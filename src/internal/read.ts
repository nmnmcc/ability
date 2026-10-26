/**
 * How a condition reads a field of a value. A condition reads only plain
 * data: an own data field, with a value and no getter. This is the data that
 * a Schema describes, and that every value from Effect has, so the catalog of
 * the Schema holds every value that a read can give. A loop over the keys may
 * not see such a field: a value of a `Schema.TaggedError` keeps `message` in
 * a hidden field, as every `Error` does.
 */
import * as Arr from "effect/Array"
import * as Option from "effect/Option"

/** The prototypes of a value, from its own prototype up. */
const prototypesOf = (value: object): ReadonlyArray<object> =>
	Arr.unfold(Object.getPrototypeOf(value) as object | null, (prototype) =>
		prototype === null
			? Option.none()
			: Option.some([prototype, Object.getPrototypeOf(prototype)] as const),
	)

/**
 * The fields that every `Error` may have from the engine or from its class:
 * a stack that the engine makes, or a name from a getter of Effect. Their
 * values are not data that a Schema makes, so a read takes such a field only
 * when it is an own data field. The catalog takes these fields of a struct
 * or a class as fields that may be missing, as any of them may hold an
 * `Error`: see `Catalog`.
 */
export const errorFields: ReadonlyArray<string> = [
	"message",
	"name",
	"stack",
	"cause",
]

/**
 * Reads one part of a value:
 * - an own data field gives its value, with `null` for `undefined`;
 * - a part of `null`, of a scalar, or a missing field gives `null`;
 * - a name that the value has only from `Object.prototype`, such as
 *   `constructor`, gives `null`;
 * - a field of {@link errorFields} of an `Error` that is not an own data
 *   field, as a `stack` that the engine keeps in an accessor, or a `name`
 *   from a getter of Effect, gives `null`;
 * - a name that the value has only as a method of a prototype, as `pipe` of
 *   a `Schema.Class` with an optional `pipe` and no value of it, gives
 *   `null`: a method is code, not data, and the Schema says that the field
 *   is missing.
 *
 * Any other field, such as a getter or other data from the prototype of a
 * class, is a defect. Its value is not data that the Schema describes, and a
 * read of it as `null` could let a value pass a deny rule.
 */
export const readPart = (value: unknown, name: string): unknown => {
	if (typeof value !== "object" || value === null) {
		return null
	}
	const property = Object.getOwnPropertyDescriptor(value, name)
	if (value instanceof Error && errorFields.includes(name)) {
		return property !== undefined &&
			"value" in property &&
			property.value !== undefined
			? property.value
			: null
	}
	if (property === undefined) {
		const owner = Arr.findFirst(prototypesOf(value), (prototype) =>
			Object.hasOwn(prototype, name),
		)
		if (Option.isNone(owner) || owner.value === Object.prototype) {
			return null
		}
		const inherited = Object.getOwnPropertyDescriptor(owner.value, name)
		if (
			inherited !== undefined &&
			"value" in inherited &&
			typeof inherited.value === "function"
		) {
			return null
		}
		throw new Error(`The field "${name}" of the value is not plain data`)
	}
	if (!("value" in property)) {
		throw new Error(`The field "${name}" of the value is not plain data`)
	}
	return property.value === undefined ? null : property.value
}

/** Reads a field of a value by the names of its parts. */
export const readPath = (
	value: unknown,
	names: ReadonlyArray<string>,
): unknown =>
	Arr.reduce(names, value, (current, name) => readPart(current, name))
