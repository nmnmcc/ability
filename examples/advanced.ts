import { Effect } from "effect"
import { Ability, AbilityRef } from "../src/index"

interface Comment {
  readonly authorId: string
  readonly body: string
}

interface Post {
  readonly id: string
  readonly authorId: string
  readonly published: boolean
  readonly title: string
  readonly body: string
  readonly tags: ReadonlyArray<string>
  readonly comments: ReadonlyArray<Comment>
}

interface User {
  readonly id: string
  readonly role: "admin" | "editor" | "guest"
}

type Subjects = {
  readonly Post: Post
  readonly User: User
}

const post: Post = {
  id: "p1",
  authorId: "u1",
  published: true,
  title: "Hello",
  body: "World",
  tags: ["effect", "authorization"],
  comments: [{ authorId: "u1", body: "Nice post" }]
}

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
  yield* ability.deny("delete", "Post", {
    conditions: { published: true },
    reason: "Published posts cannot be deleted"
  })
  yield* ability.allow(["read", "update"], "Post", {
    fields: ["title", "comments.**"],
    conditions: {
      authorId: "u1",
      tags: { $in: ["effect"] },
      comments: { $elemMatch: { authorId: "u1" } }
    }
  })
})

const program = Effect.gen(function* () {
  const ref = AbilityRef.make(ability)
  const events: Array<string> = []

  const unsubscribe = yield* AbilityRef.on(ref, "updated", () =>
    Effect.sync(() => {
      events.push("updated")
    }))
  const current = AbilityRef.get(ref) as typeof ability

  const deleteResult = yield* Ability.check(current, {
    action: "delete",
    value: Ability.subject("Post", post)
  }).pipe(
    Effect.match({
      onFailure: (error) => error._tag === "AuthorizationError" ? error.reason : "unexpected failure",
      onSuccess: () => "deleted"
    })
  )

  const fields = yield* Ability.permittedFields(current, {
    action: "update",
    subject: "Post",
    value: post
  }, {
    fieldsFrom: (rule) => rule.fields ?? ["id", "authorId", "published", "title", "body", "tags", "comments"]
  })

  yield* AbilityRef.update(ref, [
    {
      action: "read",
      subject: "Post"
    }
  ]).pipe(
    Effect.catchTag("RawRuleError", () => Effect.void)
  )

  unsubscribe()

  return {
    deleteResult,
    fields,
    events
  }
})

console.log(Effect.runSync(program))
