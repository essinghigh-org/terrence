import { db } from "./src/db";
import { users, organizations, workspaces } from "./src/db/schema";

async function seed(): Promise<void> {
    const passwordHash = await Bun.password.hash("testpass", { algorithm: "bcrypt", cost: 10 });
    const userId = crypto.randomUUID();
    await db.insert(users).values({
        id: userId,
        username: "testuser",
        passwordHash
    }).onConflictDoNothing();

    const orgId = crypto.randomUUID();
    await db.insert(organizations).values({
        id: orgId,
        name: "test-org"
    }).onConflictDoNothing();

    await db.insert(workspaces).values({
        id: crypto.randomUUID(),
        orgId,
        name: "frontend-app",
        autoApply: true
    }).onConflictDoNothing();

    console.log("Seeded database.");
}
void seed().then((): void => { process.exit(0); });
