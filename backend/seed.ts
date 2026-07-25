import { db } from "./src/db";
import { users, organizations, workspaces } from "./src/db/schema";
import * as bcrypt from "bcryptjs";

async function seed() {
    const passwordHash = await bcrypt.hash("testpass", 10);
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
seed().then(() => process.exit(0));
