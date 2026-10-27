# Move to 3.1

Version 3 has a smaller input contract. It rejects more mistakes in TypeScript
and checks dynamic data at a few clear boundaries. This is a major version.
There is no compatibility layer for the removed APIs.

The four rule algorithms, policy combinators, predicates, concrete decisions,
residuals, field permissions and HttpApi integration remain. A failure to load a
policy still grants no access.

## Builders belong to a domain

Use `Policy.define(domain)` or `Policy.builder(domain)` for rules. The free
`Policy.rule` constructor is gone.

The condition builder needs a domain and a resource kind:

```ts
const $ = Condition.builder(App, "Post")
const own = $.eq("authorId", $.principal("id"))
```

Do not supply free resource or principal type arguments. The builder type is
`Condition.Builder<typeof App, "Post">`.

The domain keeps the principal Schema type. A resource keeps the types of its
Schema fields. Field paths come from those fields, not from the full instance
type. Getters, methods, array indices and dynamic record keys are not paths. Use
a predicate to work with such values. Predicates still get the full class value,
with its methods, and keep their Effect error and service types.

Paths have no library depth cap. `DeepTarget`, `DeepRequest` and the deeper path
overloads are gone. Give a deeply nested or complex value one stable field, or
use a predicate for its contents.

## Field permissions use paths

Give a real path, a parent path or `"*"`:

```ts
_.allow("update", Post, { fields: ["settings"] })
_.deny("update", Post, { fields: ["settings.secret"] })
```

`settings` includes `settings.model` and its other children. The deny on
`settings.secret` also stops a request to change the whole `settings` value.
`fields: []` grants no fields.

Patterns such as `secret*`, `settings.*` and `**.secret` are gone. Replace a
parent pattern with its parent path. Replace a pattern across separate fields
with an explicit list of real paths. An unknown path is an error.

## Codecs read and write JSON text

`Policy.schema(domain)` now has encoded type `string`:

```ts
const codec = Policy.schema(App)
const text = Schema.encodeSync(codec)(policy)
const loaded = Schema.decodeSync(codec)(text)
```

Remove `JSON.stringify` around an encoded policy. Remove `JSON.parse` before the
decode call. For an old object held in memory, turn it into text once at the
migration boundary and pass that text to the Codec. It must meet the field and
JSON contracts.

The condition Codec also needs the domain and kind:

```ts
const codec = Condition.schema(App, "Post")
const text = Schema.encodeSync(codec)(condition)
const loaded = Schema.decodeSync(codec)(text)
```

Decoding binds the condition to the domain before returning it. Public object
encoding types are gone. Use the Codec as the storage format boundary. Unknown
tags, missing conditions, wrong fields and invalid JSON are Schema errors.
Non-finite numbers are rejected when encoding. They do not become `null`.
Predicates still can not enter a Codec or a synchronous decision.

## Meta is JSON data

`Domain.make` no longer takes `meta`. There is no Meta type parameter. A rule
takes `Schema.Json`. Functions, class instances, `undefined`, Effect values and
custom codecs are not meta.

Check the business shape before making the rule:

```ts
const GrantMeta = Schema.Struct({ grantedBy: Schema.String })
const meta = Schema.decodeSync(GrantMeta)({ grantedBy: "admin" })
_.allow("read", Post, { meta })
```

The policy Codec checks the JSON contract. Code that reads a business meta shape
from a loaded policy must check that shape itself.

## The loader owns its cache

`Authorizer.layer` has no `cache` option. Services have no `invalidate` method.
The loader gets the original principal, without a copy or a JSON round trip. For
example, `-0` stays `-0`.

Put an Effect `Cache` in a business Layer when one is needed. The loader uses
that cache. Choose the key, the expiry time and the changes that remove an
entry. The key must include the data used to select or build the policy.
`examples/authorizer.ts` shows a member-id key, a 30 second expiry and explicit
invalidation after a rule change.

The principal used by a decision is the current principal of the request. One
operation still uses one principal and policy snapshot. `guard` uses it for both
its read and action checks. A load failure is `PolicyUnavailable`.

## Stable data and conservative analysis

The caller gives stable principal and resource values that it has already
checked. Plain conditions read own data fields only. They do not walk
prototypes, call getters or use special Error fields. Missing fields and
`undefined` keep the missing-value behavior of 2.x.

Catalogs support fixed Struct and standard Schema.Class fields. Scalars, scalar
unions, null and optional scalar fields have normal analysis. Complex parts are
opaque: field permissions may name the whole part, and predicates may use its
value, but plain conditions do not read its inner fields.

Coverage returns `Unknown` with reason `"schema"` for object unions, recursive
Schemas, dynamic records, custom declarations, transforms or checks it does not
know. Optional or nullable nested objects also give `Unknown`. This avoids a
proof that ignores relations between fields.

`Condition.satisfiable` requires an explicit Schema:

```ts
Condition.satisfiable(condition, { schema: Post })
```

It no longer accepts a budget. Coverage and satisfiability have no search caps.
`Unknown` never passes a kind check or calls a fallback decider. HttpApi lists
with `nonEmpty: true` also reject `Unknown`.

`Authorizer.filter` gives the scoped residual directly. It does no coverage
search. Do not rely on every always-true or always-false result being reduced to
a `True` or `False` node. The residual still agrees with concrete decisions,
including predicate order and failures.

## Resource use belongs to the application

Version 3.1 removes all runtime size, depth and search caps from 3.0. The
`Limits` module and `LimitExceeded` error are gone, with no compatibility
exports. Remove those imports and error handlers. `Unknown.reason` is now
`"schema" | "predicate"`; remove handlers for `"budget"`.

Path types and scalar union checks use tail recursion, without a library depth
cap. This does not remove the limits of TypeScript or the JavaScript engine.

Set input, time and memory budgets in the application where they are needed. A
coverage search may try many combinations. `filter` and `residual` do not run
that search. The JSON Codec still checks node shapes, field names, domains and
finite numbers. Cyclic data is not JSON and is still rejected.
