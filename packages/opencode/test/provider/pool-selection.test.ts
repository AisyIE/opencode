import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { failoverPoolEntry, resolvePoolEntry, type ProviderPool } from "../../src/provider/pool"

test("metered pool sticks to one entry per session", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providerID = "pool-test-metered"
      await Auth.Pool.set(providerID, "a", "key-a")
      await Auth.Pool.set(providerID, "b", "key-b")

      const pool: ProviderPool = {
        policy: "metered",
        affinity: "session",
        entries: [
          { entryId: "a", baseURL: "https://a.example.com/v1" },
          { entryId: "b", baseURL: "https://b.example.com/v1" },
        ],
      }

      const first = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      const second = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      const third = await resolvePoolEntry({ providerID, pool, sessionID: "s2" })

      expect(first?.entryId).toBe("a")
      expect(second?.entryId).toBe("a")
      expect(third?.entryId).toBe("a")
    },
  })
})

test("quota pool distributes by least recently used", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providerID = "pool-test-quota"
      await Auth.Pool.set(providerID, "a", "key-a")
      await Auth.Pool.set(providerID, "b", "key-b")

      const pool: ProviderPool = {
        policy: "quota",
        affinity: "none",
        entries: [
          { entryId: "a", baseURL: "https://a.example.com/v1" },
          { entryId: "b", baseURL: "https://b.example.com/v1" },
        ],
      }

      const first = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      const second = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      const third = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })

      expect(first?.entryId).toBe("a")
      expect(second?.entryId).toBe("b")
      expect(third?.entryId).toBe("a")
    },
  })
})

test("failover bans the current entry for the session", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providerID = "pool-test-failover"
      await Auth.Pool.set(providerID, "a", "key-a")
      await Auth.Pool.set(providerID, "b", "key-b")

      const pool: ProviderPool = {
        policy: "metered",
        affinity: "session",
        entries: [
          { entryId: "a", baseURL: "https://a.example.com/v1" },
          { entryId: "b", baseURL: "https://b.example.com/v1" },
        ],
      }

      const first = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      expect(first?.entryId).toBe("a")

      const switched = await failoverPoolEntry({ providerID, pool, sessionID: "s1" })
      expect(switched?.entryId).toBe("b")

      const second = await resolvePoolEntry({ providerID, pool, sessionID: "s1" })
      expect(second?.entryId).toBe("b")
    },
  })
})
