# @nmnmcc/ability

Authorization tools for Effect programs. Authorization means the work of
deciding if a person may do an act. The rules run on the CASL rule engine.

A check is an `Effect` value. When a check says no, the answer goes into the
typed error channel of the `Effect`. The rule model is the same as in CASL:
actions, subjects, fields, conditions, allow rules, and deny rules.

## Requirements

- Use strict type checking. Without it, the types do not give all of their
  safety.
- `effect` and `@casl/ability` are peer dependencies. Your project must install
  them.
- This package does not export CASL functions again. Import CASL functions from
  `@casl/ability`.

## Install

```sh
pnpm add @nmnmcc/ability effect @casl/ability
```

## Overview

Import the package like this:

```ts
import { Ability, AbilityExtra } from "@nmnmcc/ability"
```

| Name              | What it is                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `Ability`         | A list of authorization rules. The list is in order and does not change.                    |
| `Rule`            | One allow rule or one deny rule. `Ability.define` keeps each rule you give with `yield*`.   |
| `Ability.define`  | Makes an `Ability` from a generator function. It does not run an `Effect`.                  |
| `Ability.check`   | Makes the decision. It gives `void` when the answer is yes. It fails when the answer is no. |
| `Ability.subject` | Puts a subject name on a plain object. It does not change the object.                       |
| `AbilityExtra`    | Tools to make rules smaller for sending, and to change rules into queries.                  |

Some important behavior:

- The last rule that matches decides.
- The action `manage` means every action.
- The subject `all` means every subject.
- A check does not give a boolean. When you need a boolean, use an Effect
  function such as `Effect.match`.

## First Steps

Give your subjects as a type map:

```ts
import { Effect } from "effect"
import { Ability } from "@nmnmcc/ability"

interface Post {
	readonly id: string
	readonly authorId: string
	readonly published: boolean
	readonly title: string
	readonly body: string
}

type Subjects = {
	readonly Post: Post
}
```

Make an ability:

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow("read", "Post")

	yield* ability.allow("update", "Post", {
		fields: ["title", "body"],
		conditions: { authorId: "u1" },
		reason: "Writers may change their own posts",
	})

	yield* ability.deny("delete", "Post", {
		conditions: { published: true },
		reason: "No one may delete a published post",
	})
})
```

Do a check in an Effect program:

```ts
const post: Post = {
	id: "p1",
	authorId: "u1",
	published: true,
	title: "Hello",
	body: "World",
}

const program = Effect.gen(function* () {
	yield* Ability.check(ability, {
		action: "update",
		subject: "Post",
		value: post,
		field: "title",
	})

	const deleteResult = yield* Ability.check(ability, {
		action: "delete",
		subject: "Post",
		value: post,
	}).pipe(
		Effect.match({
			onFailure: (error) =>
				error._tag === "AuthorizationError" ? error.reason : "some other error",
			onSuccess: () => "deleted",
		}),
	)

	return deleteResult
})
```

## Rules

**Form**

```ts
Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow(action, subject, options)
	yield* ability.deny(action, subject, options)
}, options)
```

`Ability.define` gives back an `Ability`. It does not give an `Effect`. It keeps
the `Rule` values in the order you give them, and they do not change after
that.

**Example** (more than one action)

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow(["read", "update"], "Post", {
		fields: ["title", "body"],
		conditions: { authorId: "u1" },
	})
})
```

**Example** (`manage` and `all`)

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow("manage", "all")
	yield* ability.deny("delete", "Post", {
		conditions: { published: true },
		reason: "No one may delete a published post",
	})
})
```

The check looks at the rules from the end of the list. In this example, the
later `deny("delete", "Post")` rule wins over the earlier
`allow("manage", "all")` rule when its condition matches.

## Checks

**Form**

```ts
Ability.check(ability, request)
ability.pipe(Ability.check(request))
```

`Ability.check` gives this type:

```ts
Effect.Effect<
	void,
	| Ability.AuthorizationError
	| Ability.ConditionError
	| Ability.SubjectDetectionError
>
```

- Success means the answer is yes.
- `AuthorizationError` means no allow rule matched, or a deny rule won.
- `ConditionError` means a condition threw an error while the check ran.
- `SubjectDetectionError` means the request had no subject, and the check could
  not get the subject from the value.

**Example** (get a boolean from the Effect)

```ts
const canUpdateTitle = Ability.check(ability, {
	action: "update",
	subject: "Post",
	value: post,
	field: "title",
}).pipe(
	Effect.match({
		onFailure: () => false,
		onSuccess: () => true,
	}),
)
```

This package has no `can`, `cannot`, or `allows` function that gives a boolean
at once.

## Conditions and Fields

Conditions use the CASL Mongo matcher and the CASL `MongoQuery` type. Mongo is a
database, and its query form is well known.

**Example** (Mongo conditions)

```ts
interface Comment {
	readonly authorId: string
	readonly body: string
}

interface PostWithComments extends Post {
	readonly comments: ReadonlyArray<Comment>
}

type Subjects = {
	readonly Post: PostWithComments
}

const ability = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow("read", "Post", {
		conditions: {
			published: { $eq: false },
			comments: { $elemMatch: { authorId: "u1" } },
		},
	})
})
```

A field is a path with dots, such as `address.city`. The types go down only a
small number of levels, so type checking stays fast. CASL field patterns such
as `address.**` also work.

**Example** (limit the fields)

```ts
interface Address {
	readonly city: string
	readonly street: string
}

interface PostWithAddress extends Post {
	readonly address: Address
}

type Subjects = {
	readonly Post: PostWithAddress
}

const ability = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow("update", "Post", {
		fields: ["title", "address.**"],
		conditions: { authorId: "u1" },
	})
})

declare const post: PostWithAddress

const program = Ability.check(ability, {
	action: "update",
	subject: "Post",
	value: post,
	field: "address.city",
})
```

When a request has no `value`, an allow rule with conditions can still say yes
for the subject type. Give a `value` when the conditions must be tested on one
object. A deny rule with conditions also needs a value before its conditions
can match. A deny rule with no conditions works without a value.

## Permitted Fields

`Ability.permittedFields` gives the fields that the matching rules let a request
use. Allow rules add fields. Deny rules take fields away.

**Form**

```ts
Ability.permittedFields(ability, request, {
	fieldsFrom: (rule) => rule.fields ?? fallbackFields,
})
```

**Example**

```ts
const fields = Ability.permittedFields(
	ability,
	{
		action: "update",
		subject: "Post",
		value: post,
	},
	{
		fieldsFrom: (rule) =>
			rule.fields ?? ["id", "authorId", "published", "title", "body"],
	},
)
```

The check uses `fieldsFrom` when a matching rule has no `fields` list.

## Subjects

A request can give the subject name:

```ts
const program = Ability.check(ability, {
	action: "read",
	subject: "Post",
	value: post,
})
```

You can also put the subject name on the value:

```ts
const wrapped = Ability.subject("Post", post)

const program = Ability.check(ability, {
	action: "read",
	value: wrapped,
})

const original = Ability.unwrapSubject(wrapped)
```

`Ability.subject` is pure. It does not change the object.

When a request has no `subject` and the value has no subject name, give a
function that gets the subject from the value:

```ts
const ability = Ability.define<Subjects>()(
	function* (ability) {
		yield* ability.allow("read", "Post")
	},
	{
		detectSubjectType: (value) =>
			(value as { readonly __typename: "Post" }).__typename,
	},
)

const program = Ability.check(ability, {
	action: "read",
	value: {
		...post,
		__typename: "Post",
	},
})
```

Without this function, the check uses the name of the constructor of the value,
when there is one.

## Action Aliases

An alias is a second name. An action alias makes one rule action cover more
actions.

**Example**

```ts
const ability = Ability.define<Subjects>()(
	function* (ability) {
		yield* ability.allow("modify", "Post", {
			fields: ["title", "body"],
			conditions: { authorId: "u1" },
		})
	},
	{
		actionAliases: {
			modify: ["update", "delete"],
		} as const,
	},
)

const program = Ability.check(ability, {
	action: "update",
	subject: "Post",
	value: post,
	field: "title",
})
```

Aliases go one way only. A `modify` rule matches `update` and `delete`. But an
`update` rule and a `delete` rule together do not give `modify`.

A bad alias throws an error at once:

- An alias may not have the name `manage`.
- An alias may not point to `manage`.
- An alias may not point to an empty list.
- Aliases may not make a loop.

## Raw Rules and Updates

Raw rules are plain data. You can turn them into JSON and back with no loss.

**Form**

```ts
Ability.fromRawRules<Subjects>(rules, options)
Ability.toRawRules(ability)
Ability.update(ability, rules)
ability.pipe(Ability.update(rules))
```

**Example**

```ts
const program = Effect.gen(function* () {
	const ability = yield* Ability.fromRawRules<Subjects>([
		{
			action: "read",
			subject: "Post",
			conditions: { authorId: "u1" },
		},
		{
			action: "delete",
			subject: "Post",
			inverted: true,
			reason: "No deletes",
		},
	])

	const rules = yield* Ability.toRawRules(ability)

	const nextAbility = yield* Ability.update(ability, [
		{
			action: "read",
			subject: "Post",
		},
	])

	return { rules, nextAbility }
})
```

`Ability.update` gives a new ability. The old ability does not change. The new
ability keeps the options of the old one, such as action aliases and subject
detection.

`Ability.fromRawRules` and `Ability.update` can fail with:

- `RawRuleError` when a raw rule is not right.
- `AliasError` when the action aliases are not right.

## Looking at Rules

These functions also give Effect values. You can give the ability as the first
argument, or use them with `pipe`.

| Function                   | What it gives                                                                 |
| -------------------------- | ----------------------------------------------------------------------------- |
| `Ability.possibleRulesFor` | The rules that may apply, before the field and condition tests.               |
| `Ability.rulesFor`         | The rules that may apply, after the field test and before the condition test. |
| `Ability.relevantRuleFor`  | The rule that wins, after the field and condition tests.                      |
| `Ability.actionsFor`       | The actions that have rules for a subject.                                    |

**Example**

```ts
const program = Effect.gen(function* () {
	const rules = yield* Ability.rulesFor(ability, {
		action: "update",
		subject: "Post",
		field: "title",
	})

	const rule = yield* Ability.relevantRuleFor(ability, {
		action: "delete",
		subject: "Post",
		value: post,
	})

	const actions = yield* ability.pipe(
		Ability.actionsFor({
			subject: "Post",
		}),
	)

	return { rules, rule, actions }
})
```

`possibleRulesFor`, `rulesFor`, and `actionsFor` can fail with
`SubjectDetectionError`. `relevantRuleFor` can also fail with `ConditionError`.

## AbilityExtra

`AbilityExtra` works on abilities you already made, and on raw rules.

### Small Rules for Sending

```ts
import { AbilityExtra } from "@nmnmcc/ability"

const packed = AbilityExtra.packRules(rules)
const unpacked = AbilityExtra.unpackRules(packed)
```

`packRules` changes raw rules into short arrays. `unpackRules` changes them back
into raw rule objects.

### Starting Values from Conditions

`rulesToFields` takes the simple condition values from the matching allow rules.
This helps when you make the first values of a new object.

```ts
const defaults = AbilityExtra.rulesToFields(ability, {
	action: "read",
	subject: "Post",
})
```

For a rule with `{ conditions: { authorId: "u1" } }`, the result has
`{ authorId: "u1" }`.

### Rules to Queries

Use `rulesToCondition` when you have your own query form:

```ts
const condition = AbilityExtra.rulesToCondition(
	ability,
	{
		action: "read",
		subject: "Post",
	},
	(rule) => rule.conditions ?? {},
	{
		and: (conditions) => ({ $and: conditions }),
		or: (conditions) => ({ $or: conditions }),
		not: (condition) => ({ $not: condition }),
		empty: () => ({}),
	},
)
```

Use `rulesToQuery` for the general query form of this package:

```ts
const query = ability.pipe(
	AbilityExtra.rulesToQuery(
		{
			action: "read",
			subject: "Post",
		},
		(rule) => rule.conditions ?? {},
	),
)
```

A rule change function may give a plain value or an Effect. When it throws an
error, the result fails with `QueryGenerationError`.

## CASL

This package uses the CASL rule engine to index rules and to match Mongo
conditions. It does not export CASL functions again.

When you need CASL functions, import them from `@casl/ability`:

```ts
import { AbilityBuilder, createMongoAbility, subject } from "@casl/ability"

const { can, cannot, build } = new AbilityBuilder(createMongoAbility)

can("read", "Post")
cannot("delete", "Post", { published: true })

const caslAbility = build()
const canRead = caslAbility.can("read", subject("Post", post))
```

This package has no database adapters and no `accessibleBy` functions. Use the
CASL packages for that work.

## Examples

- [examples/basic.ts](./examples/basic.ts)
- [examples/advanced.ts](./examples/advanced.ts)
- [examples/acbc.ts](./examples/acbc.ts)
- [tests/Ability.test.ts](./tests/Ability.test.ts)
