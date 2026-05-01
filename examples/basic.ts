import { Effect } from "effect"
import { Ability } from "../src/index"

interface Post {
  readonly id: string
  readonly authorId: string
  readonly published: boolean
  readonly title: string
  readonly body: string
}

interface User {
  readonly id: string
  readonly role: "admin" | "editor" | "guest"
}

type Subjects = {
  readonly Post: Post
  readonly User: User
}

const currentUser = {
  id: "u1",
  role: "editor"
} as const

const makeAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")

  yield* ability.allow("update", "Post", {
    fields: ["title", "body"],
    when: (post) => post.authorId === currentUser.id,
    reason: "Authors can edit their own draft content"
  })

  yield* ability.deny("delete", "Post", {
    when: (post) => post.published,
    reason: "Published posts cannot be deleted"
  })
})

const program = Effect.gen(function* () {
  const ability = yield* makeAbility
  const post: Post = {
    id: "p1",
    authorId: "u1",
    published: true,
    title: "Hello",
    body: "World"
  }

  const canUpdateTitle = yield* Ability.allows(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })

  const deleteResult = yield* Ability.check(ability, {
    action: "delete",
    subject: "Post",
    value: post
  }).pipe(
    Effect.match({
      onFailure: (error) => error._tag === "AuthorizationError" ? error.reason : "unknown",
      onSuccess: () => "deleted"
    })
  )

  return {
    canUpdateTitle,
    deleteResult
  }
})

console.log(Effect.runSync(program))

