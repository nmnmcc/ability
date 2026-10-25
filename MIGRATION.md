# From 1.x to 2.0

Version 2.0 makes the library smaller and stricter. Most programs need only the
changes in the first part. The second part lists the changes in behavior. Read
it before you deploy, mainly if you keep policies as JSON.

## Changes to the code

### The `Rule` and `Principal` modules are gone

The types and the builder of rules are in `Policy` now.

| 1.x                        | 2.0                        |
| -------------------------- | -------------------------- |
| `Rule.builder(domain)`     | `Policy.builder(domain)`   |
| `Rule.make(data)`          | `Policy.rule(data)`        |
| `Rule.Rule<E, R, O, D, I>` | `Policy.Rule<D, I, X>`     |
| `Rule.Builder<D>`          | `Policy.Builder<D>`        |
| `Rule.DataFor<D, K>`       | `Policy.DataFor<D, K>`     |
| `Principal.Class<User>(…)` | `Schema.Class<User>(…)`    |
| `Policy.rules(domain, xs)` | `Policy.define(domain)(…)` |
| `Policy.empty(domain)`     | `Policy.define(domain)(…)` |

A principal is any Schema of objects. A list of rules goes into a policy through
`Policy.define`:

```ts
const policy = Policy.define(App)(function* () {
	yield* rules
})
```

### Two type fields in place of four

A condition, a rule and a policy keep two type fields now:

| 1.x                     | 2.0               |
| ----------------------- | ----------------- |
| `Condition<E, R, O, I>` | `Condition<I, X>` |
| `Policy<D, E, R, O>`    | `Policy<D, X>`    |
| `Coverage<E, R, O, I>`  | `Coverage<I, X>`  |

The `Residuals` type is gone, with `Policy.residuals`. Use `Policy.residual`,
which gives a `Condition<I, X>`.

`I` is what a condition reads, as before. `X` is `Condition.Opaque<E, R>` when
there is a predicate, with its error type `E` and its service type `R`, and
`never` for plain data. `Condition.ErrorOf<X>` and `Condition.ServicesOf<X>`
give `E` and `R`. Most code names no type fields, and needs no change.

The types `Checked`, `Variance`, `Marks`, `AndCondition`, `OrCondition`,
`NotCondition`, `PredicateCondition`, `PredicateRun` and `TypedNode` are gone.
They kept the types of each child of a node. A node is a class now, so a spread
of a node is not a node, and the types of its children are not needed.

### Data first

These functions take the policy or the condition first, and the request or the
input second. The forms with the request first are gone:

`Policy.decide`, `decideSync`, `explain`, `permittedFields`, `residual`,
`coverage`, and `Condition.evaluate`, `evaluateSync`, `partial`, `satisfiable`.

`Policy.ceiling`, `Policy.provideContext`, `Condition.provideContext` and
`Condition.fold` keep both forms, for `pipe`.

```ts
// 1.x
policy.pipe(Policy.decide(request))
// 2.0
Policy.decide(policy, request)
```

### The Authorizer takes the principal in the service

```ts
// 1.x
class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"app/Auth",
	App,
) {}
const AuthLive = Authorizer.layer(Auth, { principal: Identity, policy })

// 2.0
class Auth extends Authorizer.Service<Auth>()("app/Auth", {
	domain: App,
	principal: Identity,
}) {}
const AuthLive = Authorizer.layer(Auth, { policy })
```

The error type and the service type of every check come from the `principal`
Effect. The `Config` type is gone.

### A list in HttpApi gives its query

`HttpApi.lists` gives a requirement with a `filter` function. The handler gets
the list query from it, with the same scope as the middleware:

```ts
const postsOfUser = HttpApi.lists(Auth, "read", "Post", {
	within: (params) => ($) => $.eq("authorId", params.user ?? ""),
})
// In the handler, with the authorizer from `yield* Auth`:
const where = Effect.flatMap(Auth, (auth) => postsOfUser.filter(auth))
```

### Other removed functions

| 1.x                                            | 2.0                               |
| ---------------------------------------------- | --------------------------------- |
| `Condition.simplifier()`                       | `Condition.simplify`              |
| `Policy.scopeHasValue`, `scopeIsEmpty`         | `Policy.coverage`                 |
| `Resource.hasValue`, `hasNoValue`              | gone: the search reads the shape  |
| `Resource.isPlainField`, `domainOf`            | gone: the search reads the shape  |
| `Resource.fieldPaths`, `descriptor.fieldPaths` | `Policy.permittedFields`          |
| `Rule.matchesField`, `matchesInside`           | gone                              |
| `Policy.residuals`                             | `Policy.residual`                 |
| `Policy.fitsKind`, `isPolicy`                  | gone                              |
| `Resource.descriptor`, `kindOf`, `isResource`  | gone: a value has its `_tag`      |
| `Domain.descriptorOf`, `isDomain`              | gone                              |
| `Condition.toJsonValue`                        | `Schema.encode(Condition.schema)` |
| `Condition.isAst`, `hasPredicate`              | gone                              |

## Changes in behavior

### A rule is checked when it goes into a policy

`Policy.define` checks every rule against the domain, and throws a `PolicyError`
with each problem. A problem has its path, and a name that a name with a mistake
may mean:

```text
A rule does not fit the domain: The field "titel" is not a field of every
resource of the rule. Did you mean "title"?
```

The Schema of a policy gives the same problems at their JSON paths.

### A condition reads only data fields

A condition reads an own field that a loop over the keys sees. A getter, a field
that a loop does not see, or a field from the prototype of a class is a defect
when a check runs, and a rule that names one is a `PolicyError`. Use a predicate
for a value that comes from code.

### Field patterns

- `*` stands for any text inside one part of a name, as in `secret*`.
- `**` stands for any number of parts, and it must be a whole part. A pattern
  such as `data.**value` is an error now. Write `data.**.value`.
- A name covers the fields below it: `settings` covers `settings.model`.
- A pattern that matches no field of the resources of its rule is an error.
- A part with a star matches any key of a record. A name matches a key when the
  Schema of the keys takes it.

### Limits

Each limit is in the new `Limits` module. A condition may have at most 100000
nodes and 500 levels, and a policy tree at most 256 levels and 100000 nodes. A
shared part counts for each place. The builder and the combinators throw an
error past a limit, so no policy can make a check slow. A field path may have at
most 5 parts. The decoders read at most 1000000 objects and array items.

### Coverage reads the shape of the Schema

`Policy.coverage` and a check on a kind read the shape of the Schema: its
fields, literals, `null`, and integer and finite numbers. They do not read other
checks, such as a minimum length. So:

- `All` and `None` hold for every value of the Schema, as before.
- `Some` means that, by the shape, a value may get either answer.
- `Unknown` comes only from a predicate or from the budget. The reason
  `"schema"` is gone.

Records, classes and unions now get a real answer, where 1.x gave `Unknown`. So
some checks on a kind that always failed in 1.x may now pass. Each such "yes" is
right for every value of the Schema.

### Shared parts

A part that a policy uses in many places is decided again for each place. So its
predicates run each time, and `Policy.explain` lists its rules each time.

### The cache of the Authorizer

The cache key is the JSON text of the principal, from the Schema of the
principal. A principal is kept only when the value that the Schema decodes from
that text is equal to it. The loader always gets that decoded copy, also with no
cache, so it must decide by the data of the principal, not by the identity of
its objects. Give `cache: { key }` to make the key in another way.

## Before you deploy

Policies that 1.x took may not load in 2.0: a pattern with `**` inside a part, a
field path with more than 5 parts, a field that is a getter, or a pattern that
matches no field. In an `Authorizer`, such a policy fails with
`PolicyUnavailable`, so no check passes. Decode every stored policy with the
Schema of 2.0 first:

```ts
const check = Schema.decodeUnknownExit(Policy.schema(App))
const broken = storedPolicies.filter((stored) =>
	Exit.isFailure(check(stored.json)),
)
```
