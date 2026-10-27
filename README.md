# @nmnmcc/ability

Authorization tools for Effect programs. Authorization means the work of
deciding if a principal may do an act. A principal is the one who asks: a
person, an API token, or another service.

The library is made with [Effect](https://effect.website) only:

- Resources and principals are Schema classes. The types of rules, conditions
  and checks all come from them.
- A condition is plain data. You can test it on a value, make it smaller with
  the principal, change it into a database query, and keep it as JSON.
- A policy is a tree. Lists of rules are its leaves, and you put policies
  together with `all`, `any`, `firstOf` and `ceiling`.
- An `Authorizer` is an Effect service. A "no" goes into the error channel. When
  a policy can not be loaded, the check fails, so an error is never a "yes".

Version 3.1 removes runtime size and search caps. See
[MIGRATION.md](MIGRATION.md) to move from 2.x.

## Requirements

- Use strict type checking. Without it, the types do not give all of their
  safety.
- `effect` is a peer dependency. Your project must install it.

## Install

```sh
pnpm add @nmnmcc/ability effect
```

## Overview

```ts
import {
	Authorizer,
	Condition,
	Decision,
	Domain,
	Policy,
	Resource,
} from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
```

| Module       | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| `Resource`   | A kind of thing to act on, with its actions, its Schema, and a path.        |
| `Domain`     | The principal Schema and all the resources. Every type comes from it.       |
| `Condition`  | A test on a resource value, as plain data.                                  |
| `Policy`     | Rules, and a tree of rules that gives a decision, a residual and fields.    |
| `Decision`   | `Allow`, `Deny` or `NotApplicable`.                                         |
| `Authorizer` | An Effect service that checks the principal of the current request.         |
| `HttpApi`    | Annotations and a middleware for `effect/http-api`. A separate entry point. |

## First Steps

Make the principal and the resources. `Resource.Class` works in the same way as
`Schema.TaggedClass`. The class is a Schema, a constructor, and a resource at
the same time:

```ts
import { Effect, Schema } from "effect"
import { Decision, Domain, Policy, Resource } from "@nmnmcc/ability"

class User extends Schema.Class<User, { readonly brand: unique symbol }>(
	"User",
)({
	id: Schema.String,
}) {}

class Post extends Resource.Class<Post>()("Post", {
	actions: ["read", "update", "delete"],
	fields: {
		id: Schema.String,
		authorId: Schema.String,
		published: Schema.Boolean,
		title: Schema.String,
		body: Schema.String,
	},
}) {}

const Blog = Domain.make({ principal: User, resources: [Post] })
```

Make a policy. Each `yield*` gives one rule. The function runs at once and gives
back the policy:

```ts
const policy = Policy.define(Blog)(function* (_) {
	yield* _.allow("read", Post)

	yield* _.allow("update", Post, {
		fields: ["title", "body"],
		when: ($) => $.eq("authorId", $.principal("id")),
		reason: "Writers may change their own posts",
	})

	yield* _.deny("delete", Post, {
		when: ($) => $.eq("published", true),
		reason: "No one may delete a published post",
	})
})
```

The types check every name. `_.allow("fly", Post)` is a type error, because
`fly` is not an action of `Post`. `$.eq("authorId", 5)` is a type error, because
`authorId` is a string. `$.principal("name")` is a type error, because the
principal has no `name` field.

Get a decision:

```ts
const writer = User.make({ id: "u1" })
const post = Post.make({
	id: "p1",
	authorId: "u1",
	published: true,
	title: "Hello",
	body: "World",
})

const decision = Policy.decideSync(policy, {
	principal: writer,
	action: "delete",
	resource: post,
})

decision._tag // "Deny"
Decision.reason(decision) // "No one may delete a published post"
```

## Resources

A resource has a kind name, a list of actions, and Schema fields. Every value
has a `_tag` field with the kind name. The library uses `_tag` to find the
resource of a value.

There are two ways to make a resource:

```ts
// A Schema class. Its body may have its own getters and methods.
class Document extends Resource.Class<Document>()("Document", {
	actions: ["read", "update"],
	fields: { id: Schema.String, ownerId: Schema.NullOr(Schema.String) },
}) {
	get orphaned() {
		return this.ownerId === null
	}
}

// Plain objects with a `_tag` field.
const Comment = Resource.make("Comment", {
	actions: ["read", "write"],
	fields: { id: Schema.String, hidden: Schema.Boolean },
})
const comment = Comment.make({ id: "c1", hidden: false })
```

A resource may have a path. The path puts the resource in a tree, so one rule
can cover a part of the tree:

```ts
class Document extends Resource.Class<Document>()("Document", {
	actions: ["read", "update"],
	fields: {
		id: Schema.String,
		organizationId: Schema.String,
		teamId: Schema.NullOr(Schema.String),
	},
	path: (f) => ["org", f.organizationId, "team", f.teamId, "doc", f.id],
}) {}

// Every resource of the organization of the principal.
_.allow("read", "*", {
	when: ($) => $.under("org", $.principal("organizationId")),
})
```

## Rules

- `_.allow(action, resource, options)` and `_.deny(...)` make rules. The action
  and the resource may be lists.
- The action `"*"` means every action. The resource `"*"` means every resource.
- `when` is the condition. It gets a builder with the types of the resource.
- `fields` makes the rule about some fields only. Give real field paths or `"*"`
  for all fields. A parent includes its children: `settings` includes
  `settings.model`. Other stars, as in `settings.*` or `secret*`, are not valid.
  An empty list grants no fields. A deny on a child also stops a request for its
  whole parent.
- `reason`, `id` and `meta` are kept with the rule. `meta` is JSON data. Check a
  business Schema before passing it as meta. The domain has no meta Schema.

An allow rule with fields covers a request for the whole value: "may update some
fields" is a yes. A deny rule with fields does not stop a request for the whole
value. Ask for a field when the operation needs that field.

`Policy.define` checks every rule against the domain when it makes the policy. A
mistake is a `PolicyError` with the path of the first problem. This check is
needed for data from JavaScript or JSON. TypeScript rejects wrong names and
value types in ordinary code.

Give the library stable principal and resource values that your application has
already checked. A plain condition reads own data fields only. It does not call
getters or walk the prototype chain. Missing fields and `undefined` read as
`null`. Use a predicate for a value that comes from code.

Field paths come from the `fields` of a Struct or a standard Schema class. The
type of a class may have getters and methods; those are not plain fields.
Arrays, dynamic records, recursive types, object unions and custom Schema parts
are opaque. Opaque means the library does not read their inner fields. A rule
may grant the whole opaque field. A predicate may use its full value.

## Conditions

The builder in `when` has these functions:

| Function                 | True when                                         |
| ------------------------ | ------------------------------------------------- |
| `eq`, `ne`               | The field is (not) equal to the value.            |
| `lt`, `lte`, `gt`, `gte` | The field is less or greater. Numbers or strings. |
| `in`                     | The field is equal to one of the values.          |
| `exists`                 | The field is not `null` and not missing.          |
| `under(...prefix)`       | The path of the resource starts with the prefix.  |
| `and`, `or`, `not`       | Logic.                                            |
| `principal(field)`       | Not a test. It gives a field of the principal.    |
| `predicate(name, test)`  | The test function says yes. It may be an Effect.  |

The types check paths from Schema fields. The same paths are used for
conditions, principal references, rule fields and request fields. There is no
separate API for deeper paths.

Make a condition outside a rule with a domain and a kind:

```ts
const $ = Condition.builder(Blog, "Post")
const published = $.eq("published", true)
```

The builder keeps the types of the Schema fields. It does not take free type
arguments for the resource value or principal.

A missing field of a resource has the value `null`. A field of the principal
that is `null` or missing is different: a test with it is always false, also
with `ne`. So a guest with no `userId` never matches a document with no owner.
To test for `null`, use a fixed value, as in `$.eq("ownerId", null)`.

`predicate` is the one way out of plain data. Its test may give a boolean or an
`Effect`. The error type and the service type of the `Effect` go into the types
of the policy and of every check. A policy with a predicate can not become JSON
or a query, and the type system stops you when you try.

A predicate also keeps the types of the value and the principal that it reads.
So a predicate for a Document can not go into a rule for a Comment. Make
conditions with the builder: a node made by hand, or a spread of a node, is not
a condition, in the types or when the code runs.

Condition constructors check node shapes and keep their domain. They do not set
a size or depth cap.

## Policies

A list of rules has a combining algorithm. It decides which rule gives the
answer when more than one rule applies:

| Algorithm                 | Winner                                   |
| ------------------------- | ---------------------------------------- |
| `denyOverrides` (default) | A deny rule wins over every allow rule.  |
| `permitOverrides`         | An allow rule wins over every deny rule. |
| `firstApplicable`         | The first rule that applies.             |
| `lastApplicable`          | The last rule that applies.              |

```ts
const policy = Policy.define(Blog, { algorithm: "lastApplicable" })(
	function* (_) {
		// ...
	},
)
```

Put policies together:

| Combinator                    | Decision                                                         |
| ----------------------------- | ---------------------------------------------------------------- |
| `Policy.all([a, b])`          | Every policy must allow. One deny is enough to deny.             |
| `Policy.any([a, b])`          | One allow is enough.                                             |
| `Policy.firstOf([a, b])`      | The first policy that allows or denies.                          |
| `Policy.ceiling(policy, cap)` | A deny from `cap` always wins. An allow from `cap` does nothing. |

Policy constructors check rules and domains. They do not set a size or depth
cap.

A shared part of a tree is decided again for each place, so its predicates run
each time, and `Policy.explain` lists its rules each time.

For example, a user token may never do more than its member, and the platform
has deny rules for everyone:

```ts
const forToken = Policy.all([memberPolicy, tokenPolicy]).pipe(
	Policy.ceiling(platformPolicy),
)
```

A decision is one of three answers: `Allow`, `Deny`, or `NotApplicable`, when no
rule gives an answer. A check treats `NotApplicable` as a "no", but an
authorizer with a decider asks the decider first.

## Questions to a Policy

| Function                 | Answer                                                         |
| ------------------------ | -------------------------------------------------------------- |
| `Policy.decide`          | The decision for one resource value, as an `Effect`.           |
| `Policy.decideSync`      | The same, at once. Only for policies with no predicates.       |
| `Policy.explain`         | The decision and the rules that were tested, for an audit log. |
| `Policy.residual`        | The condition on resource values that the policy allows.       |
| `Policy.coverage`        | If the policy allows all, none or some of a part of a kind.    |
| `Policy.permittedFields` | The fields of a value that the policy lets a request use.      |

`Policy.residual` puts the principal into every rule and gives a condition on
the resource fields only. Use it to make a database query. It makes the
condition smaller, so it is often `True` or `False` when the answer does not
depend on the value, but it does no search: a condition such as
`owner = "a" OR owner <> "a"` stays as it is. To ask "may this principal do this
act on every value, or on some value, of this kind?", use `Policy.coverage`.

When a rule that the request may use has a predicate, the residual is one
predicate with the name `"policy"`. It runs the whole policy for each value, so
it gives the same answers and the same failures as `Policy.decide`.

The application owns the cost of building and using a residual.

### Scopes

A scope is a part of a kind, such as the posts of one writer. Give it as
`within`, with the same builder as the condition of a rule. A scope is plain
data: it may not have a predicate.

There are three questions about a scope. Each one is a question about two sets:
the values in the scope, and the values that the policy allows.

| Question                               | Sets                | Function                             |
| -------------------------------------- | ------------------- | ------------------------------------ |
| May the principal act on every value?  | scope ⊆ allowed     | `Policy.coverage` is `All`           |
| Which values may the principal act on? | scope ∩ allowed     | `Policy.residual`                    |
| May the principal act on some value?   | scope ∩ allowed ≠ ∅ | `Policy.coverage` is `All` or `Some` |

```ts
const ownPosts = {
	principal: writer,
	action: "update",
	kind: "Post",
	within: ($) => $.eq("authorId", $.principal("id")),
} satisfies Policy.KindRequest<typeof Blog>

Policy.coverage(policy, ownPosts)._tag // "All"
Policy.residual(policy, ownPosts) // authorId = "u1"
```

Use "every value" for an act on a value that does not exist yet. A new post has
no id, but its author is known, so a check on the scope of its author tells if
the writer may make it.

`Policy.coverage` gives one of four answers. Each one has `condition`, the exact
list query for the scope:

- `All`: the policy allows every value in the scope.
- `None`: the policy allows no value in the scope. An empty scope is `None` too,
  so a scope with a mistake never gives a "yes".
- `Some`: the policy allows some values and not others. It gives an example of
  each, `allowed` and `refused`.
- `Unknown`: a predicate or an unsupported Schema stops the proof. The reason
  for an unsupported Schema is `"schema"`. This answer grants no access.

`Condition.satisfiable(condition, { schema: ResourceSchema })` requires a
Schema. Coverage and satisfiability have no field or step cap.

The analysis supports fixed fields, scalars, scalar unions, and nullable or
optional scalar fields. It knows finite and integer number checks. It returns
`Unknown` for object unions, recursive Schemas, dynamic records, custom
declarations, transforms and checks it does not know. Optional or nullable
nested objects also give `Unknown`, since their child fields are related.
Ordinary decisions can still use supported fields of those resources, and a
predicate can use their full values.

`Some` means that values with each answer exist in the supported Schema. It does
not mean that either value is in your database. To know that, run the residual
as a query. Do not treat `Unknown` as evidence of an allowed value.

## Queries

Change a residual condition into a query with `Condition.fold`. You give one
function for each kind of node:

```ts
const toSql = Condition.fold<string>({
	true: () => "TRUE",
	false: () => "FALSE",
	compare: (op, field, value) => `${field} ${sqlOperator(op)} ${quote(value)}`,
	in: (field, values) => `${field} IN (${values.map(quote).join(", ")})`,
	exists: (field) => `${field} IS NOT NULL`,
	and: (parts) => `(${parts.join(" AND ")})`,
	or: (parts) => `(${parts.join(" OR ")})`,
	not: (part) => `NOT ${part}`,
})

const program = Effect.gen(function* () {
	const where = yield* toSql(
		Policy.residual(policy, { principal, action: "read", kind: "Post" }),
	)
})
```

`fold` fails with `Untranslatable` on a predicate, unless you give a `predicate`
function too. Take care with `null`: in this library `ne` is true when the field
is `null`, but in SQL `x <> 'a'` is not true when `x` is `NULL`. Use
`IS DISTINCT FROM` or a similar form. Give the values to the database as bound
parameters. A value from a principal may have a quote in it, and in the SQL text
it could change the query. `examples/multi-tenant.ts` shows how.

## JSON

A policy with no predicates can become JSON:

```ts
const PolicySchema = Policy.schema(Blog)

const text = Schema.encodeSync(PolicySchema)(policy)
const again = Schema.decodeSync(PolicySchema)(text)

const ConditionSchema = Condition.schema(Blog, "Post")
const conditionText = Schema.encodeSync(ConditionSchema)(published)
const condition = Schema.decodeSync(ConditionSchema)(conditionText)
```

The encoded value is a string. Do not call `JSON.stringify` on it or
`JSON.parse` before decoding it. The Codec is the storage boundary; an object is
not an encoded policy or condition.

The Codec checks JSON data, node shape, and the domain. Unknown tags, missing
conditions and wrong fields fail in the Schema error channel. Encoding also
checks JSON values, so a non-finite number can not silently become `null`. The
condition Codec binds its result to the domain and resource too. Predicates can
not enter either Codec.

## Authorizer

An authorizer is an Effect service. It gets the principal of the current request
and loads its policy. The loader gets the original principal value.

```ts
class Identity extends Context.Service<Identity, User>()("app/Identity") {}

class Auth extends Authorizer.Service<Auth>()("app/Auth", {
	domain: Blog,
	principal: Identity,
}) {}

const AuthLive = Authorizer.layer(Auth, {
	policy: (user) => loadPolicyOf(user),
})
```

The error type and the service type of every check come from the `principal`
Effect.

Authorizer has no cache options or `invalidate` method. When a business needs a
cache, its loader owns an Effect `Cache` in a Layer. Choose the key from the
data that selects the policy, set its expiry time, and remove entries after rule
changes. `examples/authorizer.ts` shows a cache keyed by member id, with a 30
second expiry and explicit invalidation. The principal used to decide is still
the current value of the request.

Use it in a handler:

```ts
const handler = Effect.gen(function* () {
	yield* Auth.check({ action: "update", resource: post })
	yield* Auth.check({ action: "read", kind: "Post" })
	yield* Auth.guard(
		{ action: "update", resource: post },
		{
			hide: () => PostNotFound.make({ id: post.id }),
		},
	)
	const where = yield* Auth.filter({ action: "read", kind: "Post" })
	// A new post of the writer: every post of this author may be made.
	yield* Auth.check({
		action: "update",
		kind: "Post",
		within: ($) => $.eq("authorId", $.principal("id")),
	})
	const covered = yield* Auth.coverage({ action: "delete", kind: "Post" })
	const showDeleteButton = covered._tag === "All" || covered._tag === "Some"
})
```

| Function          | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `check`           | Succeeds with `void`, or fails with `Forbidden`.                              |
| `guard`           | Fails with your error when the principal may not read the value, then checks. |
| `filter`          | Gives the residual condition, for a list query.                               |
| `coverage`        | Tells if the principal may act on all, none or some values in a scope.        |
| `decide`          | Gives the decision. It does not fail on a "no".                               |
| `permittedFields` | Gives the fields that the principal may use.                                  |

A check on a kind (`{ action, kind }`) passes only when the policy allows the
act on every value of the kind. With `within`, it passes only when the policy
allows the act on every value in the scope, and the scope is not empty. The
decider is asked only when the analysis proves that no value in the scope is
denied. `Unknown` fails the check and does not call the decider.

`filter` gives the scoped residual without a coverage search. It does not
promise to reduce every always-true or always-false condition to `True` or
`False`. A query that gives an empty list is not an error. One operation uses
one principal and policy snapshot; `guard` uses that same snapshot for both of
its checks.

The errors of a check:

- `Forbidden`: the policy says no. It has the action, the kind, the field, and
  the reason of the rule.
- `PolicyUnavailable`: the policy could not be loaded. It keeps the cause.
- `Pending`: the decider must wait for an answer. It has a `ticket`.

### Deciders

When no rule gives an answer, the authorizer asks the decider, if there is one.
A decider may answer at once, or fail with `Pending` when a person or another
service must answer later:

```ts
Authorizer.layer(Auth, {
	policy: loadPolicyOf,
	decider: (request) =>
		requests
			.create(request)
			.pipe(Effect.flatMap((ticket) => Authorizer.Pending.make({ ticket }))),
})
```

When the answer comes, keep it as a rule, for example in a grant policy that
comes first: `Policy.firstOf([grants, rules])`.

## HttpApi

`@nmnmcc/ability/HttpApi` checks requests in an `effect/http-api` server. Each
endpoint says what it needs. An endpoint with no annotation is closed, so a new
endpoint does nothing until you say what it needs:

```ts
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"

class Authorization extends HttpApiMiddleware.Service<
	Authorization,
	{ requires: Identity }
>()("app/Authorization", { error: AbilityHttpApi.errors }) {}

const update = HttpApiEndpoint.patch("update", "/posts/:id", {
	params: { id: Schema.String },
}).annotate(AbilityHttpApi.Required, [
	AbilityHttpApi.requires(Auth, "update", "Post", (params) =>
		Posts.find(params["id"]),
	),
])

const health = HttpApiEndpoint.get("health", "/health").annotate(
	AbilityHttpApi.Required,
	[],
)

// The checks run only in a group that uses the middleware.
const posts = HttpApiGroup.make("posts")
	.add(update, health)
	.middleware(Authorization)

const AuthorizationLive = AbilityHttpApi.layer(Authorization, Auth)
```

An act on a part of a kind takes a scope from the path parameters. A list takes
`lists`: the middleware does not check every value, because the handler gets its
query from the same requirement, with the same scope. An empty list is not an
error, unless you give `nonEmpty: true`. Then the middleware needs a coverage of
`All` or `Some`, so `Unknown` fails too:

```ts
const create = HttpApiEndpoint.post("create", "/users/:user/posts", {
	params: { user: Schema.String },
}).annotate(AbilityHttpApi.Required, [
	AbilityHttpApi.requires(Auth, "update", "Post", {
		within: (params) => ($) => $.eq("authorId", params["user"] ?? ""),
	}),
])

const postsOfUser = AbilityHttpApi.lists(Auth, "read", "Post", {
	within: (params) => ($) => $.eq("authorId", params["user"] ?? ""),
})

const list = HttpApiEndpoint.get("list", "/users/:user/posts", {
	params: { user: Schema.String },
}).annotate(AbilityHttpApi.Required, [postsOfUser])

const PostsLive = HttpApiBuilder.group(Api, "posts", (handlers) =>
	Effect.map(Auth, (auth) =>
		handlers.handle("list", () =>
			postsOfUser
				.filter(auth)
				.pipe(Effect.flatMap(toSql), Effect.flatMap(Posts.query)),
		),
	),
)
```

A path parameter may be `undefined`. A scope with `undefined` in it is a defect,
so give another value for it.

The annotations and the layer do nothing alone. Give the middleware to every
group with `.middleware(Authorization)`, or to the whole API. An endpoint in a
group without the middleware is not checked.

`GroupRequired` gives a default for a whole group: one list for GET requests and
one for every other method. `AbilityHttpApi.errors` gives the errors with HTTP
status codes: 403, 503, and 409.

## Resource use

The application owns input size, depth, time and memory budgets. The library
sets no caps on paths, policy or condition trees, meta, JSON text, Schema
catalogs or analysis searches. The `Limits` module has been removed.

Path types and scalar union checks use tail recursion. The library sets no type
depth cap; TypeScript still has its own limits. Runtime walks and JSON
operations also remain subject to the JavaScript engine. No arbitrary-depth or
fixed-cost guarantee is made.

A coverage search may try many combinations of field values. Use it when the
application can afford that work. `filter` and `residual` do no coverage search.

Types reject wrong shapes, names, paths and value types. Runtime checks still
reject wrong domains, invalid JSON, cycles in JSON data, and invalid nodes.
Unknown Schemas and predicates can still give `Unknown`; they never grant
access. The caller gives stable, checked principal and resource values.

### Measured examples

These are reference measurements for 3.1.0, taken on 2026-10-28 with Node.js
26.6.0, TypeScript 7.0.2, Effect 4.0.6 and @effect/tsgo 0.56.0 on Linux with an
AMD EPYC-Genoa CPU. They are samples, not supported maximums. Shape and machine
load affect the result.

The typed samples check conditions, principal references and rule fields. Fields
per resource include `ownerId`, apart from the single-path samples. Compiler
time includes parsing and type checking. Memory is the compiler's `Memory used`
statistic. Each value is the middle of five runs after one warmup, with
incremental checks off.

| Typed sample                              | Compiler time |  Memory |
| ----------------------------------------- | ------------: | ------: |
| 3 resources, 21 fields each, 60 rules     |        0.33 s | 161 MiB |
| 10 resources, 101 fields each, 1000 rules |        0.81 s | 178 MiB |
| 1 resource, 1001 fields, 20 rules         |        0.90 s | 168 MiB |
| One field path with 100 parts             |        0.41 s | 162 MiB |
| One field path with 500 parts             |        1.27 s | 177 MiB |

The 1000-part path sample failed with TypeScript error `TS2589` (type
instantiation is too deep). This does not put a 500-part cap in the library; 500
was the last successful path length tested. Branching Schema shapes can have a
different cost.

The runtime rule samples use `denyOverrides`, one scalar condition per rule, and
a value that matches the last rule. Each decision scans the full list. Check
time is one `Policy.decideSync` call; load time is one JSON decode of the whole
policy, with no I/O. Values are the middle of five warm batches.

| Rules | Check time | JSON load time |
| ----- | ---------: | -------------: |
| 100   |   0.045 ms |         1.2 ms |
| 1000  |    0.76 ms |        14.6 ms |
| 10000 |     5.7 ms |         124 ms |

The 10000-rule policy also passed residual checks and JSON round trips. Its JSON
text had about 1.48 million code units.

A chain of 1000 condition levels and a chain of 500 policy levels both passed
decisions and JSON round trips. The next tested depths, 2000 and 1000, failed
during JSON encoding with a call stack error. These are observed samples, not
exact engine limits.

Coverage of a simple condition on 40 boolean fields took about 7.4 ms. An
unsatisfiable condition that places six items into five slots with no sharing
used 30 boolean fields and took about 314 ms in one run. The eight-item,
seven-slot case used 56 fields and did not finish in the runner's 15-second
wait. Search shape matters more than field count alone.

Run the same samples with:

```sh
devenv shell -- node benchmarks/resource-use.mjs
```

The runner uses separate processes for runtime probes, a 512 MiB Node heap and a
15-second wait per probe. Each compiler run gets 20 seconds. These are
measurement settings. The library has no such caps. The script prints failures
as results and removes its temporary type samples when it ends.

## Examples

Each example is a small program. Run it with Node.js, which runs `.ts` files
itself:

```sh
node examples/basic.ts
```

| Example                       | What it shows                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `examples/basic.ts`           | A blog: a domain, a policy, field rules and a decision with a reason.                            |
| `examples/authorizer.ts`      | Team documents: a business cache, `guard`, `filter`, coverage and a decider.                     |
| `examples/multi-tenant.ts`    | A task tracker for many teams: roles, API tokens, a platform limit, scopes and SQL list queries. |
| `examples/field-access.ts`    | A staff list: parent and child field rules, and `permittedFields`.                               |
| `examples/stored-policies.ts` | A help desk: policies kept as JSON, `meta` on rules, checks when a policy loads, and `explain`.  |
| `examples/predicates.ts`      | Meeting rooms: a predicate that asks an Effect service, its error type, and `provideContext`.    |
| `examples/algorithms.ts`      | File sharing: the four combining algorithms, `any`, `firstOf` and `ceiling`.                     |
| `examples/http-api.ts`        | A notes API: the `effect/http-api` middleware, one-value checks, list scopes and closed routes.  |
