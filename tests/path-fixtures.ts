import { Array as Arr, Schema } from "effect"
import { Domain, Resource } from "../src/index.ts"

type Nested<
	N extends number,
	S extends Schema.Top = Schema.String,
	Depth extends ReadonlyArray<unknown> = [],
> = Depth["length"] extends N
	? S
	: Nested<N, Schema.Struct<{ readonly a: S }>, readonly [...Depth, unknown]>

/** Build the same fixed shape in the type and in the Schema. */
export const nested = <const N extends number>(depth: N): Nested<N> =>
	Arr.reduce(
		Arr.makeBy(depth, () => 0),
		Schema.String as Schema.Top,
		(child) => Schema.Struct({ a: child }),
	) as Nested<N>

const ten = "a.a.a.a.a.a.a.a.a.a"
export const path100 =
	`${ten}.${ten}.${ten}.${ten}.${ten}.${ten}.${ten}.${ten}.${ten}.${ten}` as const
export const path101 = `${path100}.a` as const

export const Deep = Resource.make("Deep", {
	actions: ["read", "write"],
	fields: nested(101).fields,
})
export const Leaf = Resource.make("Leaf", {
	actions: ["read", "write"],
	fields: nested(100).fields,
})
export const App = Domain.make({
	principal: nested(100),
	resources: [Deep, Leaf],
})

type ValueOf<S> = S extends { readonly Type: infer T } ? T : never

/** Build the same fixed shape as the Schema, without a decoder. */
export const valueAtDepth = <const N extends number>(
	depth: N,
	leaf: string,
): ValueOf<Nested<N>> =>
	Arr.reduce(
		Arr.makeBy(depth, () => 0),
		leaf as unknown,
		(a) => ({ a }),
	) as ValueOf<Nested<N>>
