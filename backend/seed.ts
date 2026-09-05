import { newResourceId } from "./src/lib/resource-id";
import { db } from "./src/db";
import { users, organizations, workspaces } from "./src/db/schema";
import { hashPassword } from "./src/lib/password-hashing";
import { and, eq } from "drizzle-orm";
import { withDbLock } from "./src/lib/db-lock";

async function seed(): Promise<void> {
    const passwordHash = await hashPassword("testpass");
    const userId = newResourceId("user");
    await db.insert(users).values({
        id: userId,
        username: "testuser",
        passwordHash
    }).onConflictDoNothing();

    const [org] = await db.insert(organizations).values({
        id: newResourceId("org"),
        name: "test-org"
    }).onConflictDoUpdate({ target: organizations.name, set: { name: "test-org" } }).returning({ id: organizations.id });
    if (org === undefined) throw new Error("Seed organization was not persisted");

    const workspace = await db.query.workspaces.findFirst({
        where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, "frontend-app")),
    });
    if (workspace === undefined) {
        await db.insert(workspaces).values({
            id: newResourceId("ws"),
            orgId: org.id,
            name: "frontend-app",
            autoApply: true
        });
    }

    console.log("Seeded database.");
}
void withDbLock("seed:test-org", seed).then((): void => { process.exit(0); });
