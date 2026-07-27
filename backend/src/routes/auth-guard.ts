// @ts-nocheck
import { Elysia } from "elysia";

/**
 * Reusable authentication guard plugin that can be composed into route groups.
 * Checks that the user or token identity is present.
 */
export const authGuard = new Elysia({ name: "auth-guard" })
  .derive({ as: "global" }, async ({ user, set }: any) => {
    if (!user) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    return {};
  });
