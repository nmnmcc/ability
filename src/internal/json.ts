/** The JSON text boundary for conditions and policies. */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import type * as Schema from "effect/Schema"
import * as Nodes from "./nodes.ts"

/** An input problem with its path. */
export class Problem extends Data.TaggedError("Problem")<{
	readonly path: ReadonlyArray<PropertyKey>
	readonly message: string
}> {}

export const problem = (path: ReadonlyArray<PropertyKey>, message: string) =>
	new Problem({ path, message })

/** Puts a constructor error at the part of the input that caused it. */
export const at = <A>(path: ReadonlyArray<PropertyKey>, make: () => A): A => {
	try {
		return make()
	} catch (error) {
		if (error instanceof Problem) {
			throw error
		}
		throw problem(path, error instanceof Error ? error.message : String(error))
	}
}

/** Checks and copies one JSON value. Each value counts once. */
const copyValue = (
	input: unknown,
): { readonly value: Schema.Json; readonly size: number } => {
	const count = { size: 0 }
	// A native Set finds ancestor objects by identity. Shared children are valid JSON.
	const ancestors = new Set<object>()
	const visit = (
		value: unknown,
		path: ReadonlyArray<PropertyKey>,
	): Schema.Json => {
		count.size += 1

		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		) {
			return value
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			return value
		}
		if (typeof value !== "object" || value === null) {
			throw problem(path, "The value must be JSON data with finite numbers")
		}

		const list = Array.isArray(value)
		if (
			!list &&
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		) {
			throw problem(path, "A JSON object must have plain data fields")
		}
		if (ancestors.has(value))
			throw problem(path, "JSON data must not have a cycle")
		ancestors.add(value)
		try {
			const keys = Reflect.ownKeys(value)
			const length = list ? value.length : keys.length

			if (list && keys.length !== length + 1) {
				throw problem(
					path,
					"A JSON array must have every item and no added fields",
				)
			}
			const read = (key: PropertyKey): Schema.Json => {
				const field = Object.getOwnPropertyDescriptor(value, key)
				if (
					typeof key !== "string" ||
					field === undefined ||
					field.enumerable !== true ||
					!("value" in field)
				) {
					throw problem(
						[...path, key],
						"A JSON field must be an own data field",
					)
				}
				return visit(field.value, [...path, list ? Number(key) : key])
			}
			return list
				? Object.freeze(
						Array.from({ length }, (_, index) => read(String(index))),
					)
				: Object.freeze(
						Object.fromEntries(Arr.map(keys, (key) => [key, read(key)])),
					)
		} finally {
			ancestors.delete(value)
		}
	}
	const value = visit(input, [])
	return { value, size: count.size }
}

/** Makes the plain JSON data of a rule. */
export const copyMeta = (input: unknown) => copyValue(input)

/** Parses text before any node decoder reads it. */
export const parse = (input: string): Schema.Json => {
	if (typeof input !== "string") {
		throw problem([], "The input must be JSON text")
	}

	return at([], () => copyValue(JSON.parse(input)).value)
}

/** Checks the value before JSON.stringify can change or lose a value. */
export const stringify = (input: unknown): string => {
	const value = copyValue(input).value
	const text = JSON.stringify(value)

	return text
}

/** Reads only parsed JSON objects. */
export const object = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
): Record<string, unknown> => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw problem(path, "The value must be an object")
	}
	return input as Record<string, unknown>
}

/** Stops a misspelled or unknown field at the load boundary. */
export const fields = (
	input: Record<string, unknown>,
	names: ReadonlyArray<string>,
	path: ReadonlyArray<PropertyKey>,
): void => {
	const unknown = Arr.findFirst(
		Object.keys(input),
		(name) => !names.includes(name),
	)
	if (unknown._tag === "Some") {
		throw problem(
			[...path, unknown.value],
			`The field "${unknown.value}" is not known`,
		)
	}
}

export const readString = (
	input: Record<string, unknown>,
	name: string,
	path: ReadonlyArray<PropertyKey>,
): string => {
	const value = input[name]
	if (typeof value !== "string") {
		throw problem([...path, name], `The field "${name}" must be a string`)
	}
	return value
}

export const readList = (
	input: Record<string, unknown>,
	name: string,
	path: ReadonlyArray<PropertyKey>,
): ReadonlyArray<unknown> => {
	const value = input[name]
	if (!Array.isArray(value)) {
		throw problem([...path, name], `The field "${name}" must be an array`)
	}
	return value
}

const operand = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
): Nodes.Operand => {
	const data = object(input, path)
	if (data["_tag"] === "Literal") {
		fields(data, ["_tag", "value"], path)
		const value = data["value"]
		if (
			!Nodes.isScalar(value) ||
			(typeof value === "number" && !Number.isFinite(value))
		) {
			throw problem(
				[...path, "value"],
				"A fixed value must be a string, a finite number, a boolean or null",
			)
		}
		return Nodes.literal(value)
	}
	if (data["_tag"] === "Principal") {
		fields(data, ["_tag", "path"], path)
		return Nodes.principalRef(readString(data, "path", path))
	}
	throw problem(
		[...path, "_tag"],
		'An operand must have the tag "Literal" or "Principal"',
	)
}

/** Decodes a condition inside a parsed policy or at the text root. */
export const decodeAt = (
	input: unknown,
	path: ReadonlyArray<PropertyKey> = [],
): Nodes.Node => {
	const visit = (
		value: unknown,
		place: ReadonlyArray<PropertyKey>,
	): Nodes.Node =>
		at(place, () => {
			const data = object(value, place)
			const operands = (name: string): ReadonlyArray<Nodes.Operand> => {
				const values = readList(data, name, place)

				return Arr.map(values, (item, index) =>
					operand(item, [...place, name, index]),
				)
			}
			switch (data["_tag"]) {
				case "True":
				case "False":
					fields(data, ["_tag"], place)
					return data["_tag"] === "True" ? Nodes.always : Nodes.never
				case "Compare": {
					fields(data, ["_tag", "op", "field", "value"], place)
					const op = readString(data, "op", place)
					if (!Nodes.isCompareOperator(op)) {
						throw problem([...place, "op"], `"${op}" is not a compare operator`)
					}

					return new Nodes.Compare({
						op,
						field: readString(data, "field", place),
						value: operand(data["value"], [...place, "value"]),
					})
				}
				case "In":
					fields(data, ["_tag", "field", "values"], place)
					return new Nodes.In({
						field: readString(data, "field", place),
						values: operands("values"),
					})
				case "Exists":
					fields(data, ["_tag", "field"], place)
					return new Nodes.Exists({ field: readString(data, "field", place) })
				case "Under":
					fields(data, ["_tag", "prefix"], place)
					return new Nodes.Under({ prefix: operands("prefix") })
				case "And":
				case "Or": {
					fields(data, ["_tag", "conditions"], place)
					const children = readList(data, "conditions", place)

					return new Nodes[data["_tag"]](
						Arr.map(children, (child, index) =>
							visit(child, [...place, "conditions", index]),
						),
					)
				}
				case "Not":
					fields(data, ["_tag", "condition"], place)
					return new Nodes.Not(
						visit(data["condition"], [...place, "condition"]),
					)
				default:
					throw problem([...place, "_tag"], "The condition has no known tag")
			}
		})
	return visit(input, path)
}

export const toJson = (node: Nodes.Node): unknown => Nodes.toJson(node)

export const encode = (node: Nodes.Node): string =>
	at([], () => node.pipe(toJson, stringify))
