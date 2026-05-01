import { assert, describe, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { Ability, AbilityExtra, AbilityRef } from "../src/index";

interface Comment {
  readonly authorId: string;
  readonly body: string;
}

interface Address {
  readonly city: string;
  readonly street: string;
}

interface Post {
  readonly id: string;
  readonly authorId: string;
  readonly published: boolean;
  readonly title: string;
  readonly body: string;
  readonly tags: ReadonlyArray<string>;
  readonly comments: ReadonlyArray<Comment>;
  readonly address: Address;
}

interface User {
  readonly id: string;
  readonly role: "admin" | "editor" | "guest";
}

type Subjects = {
  readonly Post: Post;
  readonly User: User;
};

const draftPost: Post = {
  id: "p1",
  authorId: "u1",
  published: false,
  title: "Hello",
  body: "World",
  tags: ["effect", "auth"],
  comments: [{ authorId: "u1", body: "Nice" }],
  address: {
    city: "Shanghai",
    street: "Century Avenue",
  },
};

const publishedPost: Post = {
  ...draftPost,
  published: true,
};

describe("Ability", () => {
  it("defines an ability synchronously", () => {
    const ability = Ability.define<Subjects>()(function* (ability) {
      yield* ability.allow("read", "Post");
    });

    assert.strictEqual(Effect.isEffect(ability), false);
    assert.strictEqual(ability.rules.length, 1);
  });

  it.effect("supports manage/all and later deny overrides", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("manage", "all");
        yield* ability.deny("delete", "Post", {
          conditions: { published: true },
          reason: "Published posts cannot be deleted",
        });
      });

      yield* Ability.check(ability, {
        action: "read",
        subject: "User",
      });

      const reason = yield* Ability.check(ability, {
        action: "delete",
        subject: "Post",
        value: publishedPost,
      }).pipe(
        Effect.catchTag("AuthorizationError", (error) =>
          Effect.succeed(error.reason),
        ),
      );

      assert.strictEqual(reason, "Published posts cannot be deleted");
    }),
  );

  it.effect(
    "supports multiple actions, conditions, and field restrictions",
    () =>
      Effect.gen(function* () {
        const ability = Ability.define<Subjects>()(function* (ability) {
          yield* ability.allow(["read", "update"], "Post", {
            fields: ["title", "address.**"],
            conditions: { authorId: "u1" },
          });
        });

        yield* Ability.check(ability, {
          action: "update",
          subject: "Post",
          value: draftPost,
          field: "address.city",
        });

        const deniedField = yield* Ability.check(ability, {
          action: "update",
          subject: "Post",
          value: draftPost,
          field: "body",
        }).pipe(
          Effect.catchTag("AuthorizationError", (error) =>
            Effect.succeed(error._tag),
          ),
        );

        const deniedCondition = yield* Ability.check(ability, {
          action: "update",
          subject: "Post",
          value: {
            ...draftPost,
            authorId: "u2",
          },
          field: "title",
        }).pipe(
          Effect.catchTag("AuthorizationError", (error) =>
            Effect.succeed(error._tag),
          ),
        );

        assert.strictEqual(deniedField, "AuthorizationError");
        assert.strictEqual(deniedCondition, "AuthorizationError");
      }),
  );

  it.effect("supports Mongo-style condition operators", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: {
            "address.city": "Shanghai",
            tags: { $in: ["effect"] },
            comments: {
              $elemMatch: {
                authorId: "u1",
              },
            },
          },
        });
      });

      yield* Ability.check(ability, {
        action: "read",
        subject: "Post",
        value: draftPost,
      });
    }),
  );

  class PredicateError extends Data.TaggedError("PredicateError")<{}> {}

  it.effect("preserves predicate errors in the Effect error channel", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: { authorId: "u1" },
          when: () => Effect.fail(new PredicateError()),
        });
      });

      const result = yield* Ability.check(ability, {
        action: "read",
        subject: "Post",
        value: draftPost,
      }).pipe(
        Effect.catchTag("PredicateError", (error) =>
          Effect.succeed(error._tag),
        ),
      );

      assert.strictEqual(result, "PredicateError");
    }),
  );

  it.effect("uses pure subject wrappers without mutating values", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: { authorId: "u1" },
        });
      });
      const wrapped = Ability.subject("Post", draftPost);

      yield* Ability.check(ability, {
        action: "read",
        value: wrapped,
      });

      assert.strictEqual(Ability.unwrapSubject(wrapped), draftPost);
      assert.deepStrictEqual(Object.keys(draftPost), [
        "id",
        "authorId",
        "published",
        "title",
        "body",
        "tags",
        "comments",
        "address",
      ]);
    }),
  );

  it.effect("detects subject types with a custom detector", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("read", "Post");
        },
        {
          detectSubjectType: (value) =>
            (value as { readonly __typename: "Post" }).__typename,
        },
      );

      yield* Ability.check(ability, {
        action: "read",
        value: {
          ...draftPost,
          __typename: "Post",
        },
      });
    }),
  );

  it.effect("computes permitted fields with deny rules removing fields", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("update", "Post", {
          fields: ["title", "body"],
          conditions: { authorId: "u1" },
        });
        yield* ability.deny("update", "Post", {
          fields: ["body"],
          conditions: { published: true },
        });
      });

      const fields = yield* Ability.permittedFields(
        ability,
        {
          action: "update",
          subject: "Post",
          value: publishedPost,
        },
        {
          fieldsFrom: (rule) =>
            rule.fields ?? ["id", "authorId", "published", "title", "body"],
        },
      );

      assert.deepStrictEqual(fields, ["title"]);
    }),
  );

  it.effect(
    "round-trips raw rules and rejects function predicates in strict serialization",
    () =>
      Effect.gen(function* () {
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
        ]);

        const rawRules = yield* Ability.toRawRules(ability);

        const strictError = yield* Ability.toRawRules(
          Ability.define<Subjects>()(function* (ability) {
            yield* ability.allow("read", "Post", {
              when: () => true,
            });
          }),
        ).pipe(
          Effect.catchTag("SerializationError", (error) =>
            Effect.succeed(error._tag),
          ),
        );

        assert.strictEqual(rawRules.length, 2);
        assert.strictEqual(rawRules[1]?.inverted, true);
        assert.strictEqual(strictError, "SerializationError");
      }),
  );

  it.effect("expands action aliases in one direction", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("modify", "Post", {
            conditions: { authorId: "u1" },
          });
        },
        {
          actionAliases: {
            modify: ["update", "delete"],
          } as const,
        },
      );

      yield* Ability.check(ability, {
        action: "update",
        subject: "Post",
        value: draftPost,
      });

      const relevantRule = yield* Ability.relevantRuleFor(ability, {
        action: "delete",
        subject: "Post",
        value: draftPost,
      });

      const reverseAlias = yield* Ability.check(
        Ability.define<Subjects>()(
          function* (ability) {
            yield* ability.allow(["update", "delete"], "Post");
          },
          {
            actionAliases: {
              modify: ["update", "delete"],
            } as const,
          },
        ),
        {
          action: "modify" as never,
          subject: "Post",
          value: draftPost,
        },
      ).pipe(
        Effect.catchTag("AuthorizationError", (error) =>
          Effect.succeed(error._tag),
        ),
      );

      assert.strictEqual(relevantRule?.action, "modify");
      assert.strictEqual(reverseAlias, "AuthorizationError");
    }),
  );

  it("rejects invalid action aliases", () => {
    assert.throws(() =>
      Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("read", "Post");
        },
        {
          actionAliases: {
            access: "access",
          } as const,
        },
      ), Ability.AliasError);

    assert.throws(() => Ability.createAliasResolver({ manage: "read" }), Ability.AliasError);
  });

  it.effect("exposes indexed rules and actions for introspection", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("manage", "all");
          yield* ability.allow("access", "Post", {
            fields: ["title"],
          });
          yield* ability.deny("delete", "Post", {
            reason: "No deletes",
          });
        },
        {
          actionAliases: {
            access: ["read", "update"],
          } as const,
        },
      );

      const possibleRules = yield* Ability.possibleRulesFor(ability, {
        action: "delete",
        subject: "Post",
      });
      const fieldRules = yield* Ability.rulesFor(ability, {
        action: "update",
        subject: "Post",
        field: "title",
      });
      const actions = yield* Ability.actionsFor(ability, {
        subject: "Post",
      });

      assert.deepStrictEqual(possibleRules.map((rule) => rule._tag), [
        "Deny",
        "Allow",
      ]);
      assert.deepStrictEqual(fieldRules.map((rule) => rule.action), [
        "access",
        "manage",
      ]);
      assert.deepStrictEqual([...actions].sort(), [
        "access",
        "delete",
        "manage",
        "read",
        "update",
      ]);
    }),
  );
});

describe("AbilityExtra", () => {
  it("packs and unpacks raw rules without comma-joining arrays", () => {
    const rawRules: ReadonlyArray<Ability.RawRule> = [
      {
        action: ["read", "update"],
        subject: "Post",
        fields: ["title", "body"],
        conditions: { authorId: "u1" },
      },
      {
        action: "delete",
        subject: "Post",
        inverted: true,
        reason: "No deletes",
      },
    ];

    const packed = AbilityExtra.packRules(rawRules);
    const unpacked = AbilityExtra.unpackRules(packed);

    assert.deepStrictEqual(unpacked, rawRules);
    assert.deepStrictEqual(packed[0]?.[0], ["read", "update"]);
  });

  it.effect("extracts scalar condition fields", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("create", "Post", {
          conditions: {
            authorId: "u1",
            "address.city": "Shanghai",
            title: { $regex: "^Draft" },
          },
        });
      });

      const fields = yield* AbilityExtra.rulesToFields(ability, {
        action: "create",
        subject: "Post",
      });

      assert.deepStrictEqual(fields, {
        authorId: "u1",
        address: {
          city: "Shanghai",
        },
      });
    }),
  );

  it.effect("converts rules to generic logical conditions", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: { authorId: "u1" },
        });
        yield* ability.allow("read", "Post", {
          conditions: { published: true },
        });
        yield* ability.deny("read", "Post", {
          conditions: { published: false },
        });
      });

      const condition = yield* AbilityExtra.rulesToCondition(
        ability,
        {
          action: "read",
          subject: "Post",
        },
        (rule) => rule.conditions as Record<string, unknown>,
        {
          and: (conditions) => ({ $and: conditions }),
          or: (conditions) => ({ $or: conditions }),
          not: (condition) => ({ $not: condition }),
          empty: () => ({}),
        },
      );

      assert.deepStrictEqual(condition, {
        $or: [
          {
            $and: [
              { published: true },
              { $not: { published: false } },
            ],
          },
          {
            $and: [
              { authorId: "u1" },
              { $not: { published: false } },
            ],
          },
        ],
      });
    }),
  );

  it.effect("fails query generation for function predicates", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: { authorId: "u1" },
          when: () => true,
        });
      });

      const errorTag = yield* AbilityExtra.rulesToQuery(
        ability,
        {
          action: "read",
          subject: "Post",
        },
        (rule) => rule.conditions as Record<string, unknown>,
      ).pipe(
        Effect.catchTag("QueryGenerationError", (error) =>
          Effect.succeed(error._tag),
        ),
      );

      assert.strictEqual(errorTag, "QueryGenerationError");
    }),
  );
});

describe("AbilityRef", () => {
  it.effect("updates an ability through an explicit mutable boundary", () =>
    Effect.gen(function* () {
      const initial = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post");
      });
      const next = Ability.define<Subjects>()(function* (ability) {
        yield* ability.deny("read", "Post", {
          reason: "Read disabled",
        });
      });
      const ref = AbilityRef.make(initial);
      const events: Array<string> = [];

      const unsubscribe = yield* AbilityRef.on(ref, "updated", () =>
        Effect.sync(() => {
          events.push("updated");
        }),
      );

      yield* AbilityRef.set(ref, next);
      unsubscribe();
      yield* AbilityRef.set(ref, initial);

      const reason = yield* Ability.check(AbilityRef.get(ref), {
        action: "read",
        subject: "Post",
      }).pipe(
        Effect.catchTag("AuthorizationError", (error) =>
          Effect.succeed(error.reason),
        ),
      );

      assert.deepStrictEqual(events, ["updated"]);
      assert.strictEqual(reason, undefined);
    }),
  );
});
