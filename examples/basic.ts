import {Effect} from "effect"
import {Ability} from "../src/index"

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

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")

  yield* ability.allow("update", "Post", {
    fields: ["title", "body"],
    conditions: {authorId: "u1"},
    reason: "Authors can edit their own draft content"
  })

  yield* ability.deny("delete", "Post", {
    conditions: {published: true},
    reason: "Published posts cannot be deleted"
  })
})

const program = Effect.gen(function* () {
  const post: Post = {
    id: "p1",
    authorId: "u1",
    published: true,
    title: "Hello",
    body: "World"
  }

  const canUpdateTitle = yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  }).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    })
  )

  const deleteResult = yield* Ability.check(ability, {
    action: "delete",
    subject: "Post",
    value: post
  }).pipe(
    Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason)),
    Effect.catch(() => Effect.succeed("unexpected failure"))
  )

  return {
    canUpdateTitle,
    deleteResult
  }
})

console.log(Effect.runSync(program))
