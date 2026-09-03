import { Elysia } from "elysia";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { emailVerificationTokens, users } from "../db/schema";
import { authPlugin } from "../auth";
import { apiURL, auditLog } from "../lib/utils";
import { generateAuthenticationToken, hashAuthenticationToken, tokenHashCandidates } from "../lib/token-service";
import { normalizeEmail } from "../lib/identity";
import { getSettings } from "../lib/settings";
import { isSmtpEncryption, sendEmail } from "../lib/smtp";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ url: string }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  set: SetObj;
}>;

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 60 * 1000;

function error(set: SetObj, status: number, detail: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  const title = status === 400 ? "Bad Request"
    : status === 403 ? "Forbidden"
      : status === 404 ? "Not Found"
        : status === 409 ? "Conflict"
          : status === 429 ? "Too Many Requests"
            : status === 502 ? "Bad Gateway"
              : status === 503 ? "Service Unavailable"
                : "Unprocessable Entity";
  return { errors: [{ status: String(status), title, detail }] };
}

function tokenFromContext(ctx: Pick<Ctx, "params" | "query" | "body">): string {
  const fromParams = ctx.params?.["token"];
  if (typeof fromParams === "string" && fromParams !== "") return fromParams;
  const fromQuery = ctx.query?.["token"];
  if (typeof fromQuery === "string" && fromQuery !== "") return fromQuery;
  const body = ctx.body !== null && typeof ctx.body === "object" ? ctx.body as Record<string, unknown> : {};
  const data = body["data"] !== null && typeof body["data"] === "object" ? body["data"] as Record<string, unknown> : {};
  const attrs = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
  return typeof attrs["token"] === "string" ? attrs["token"] : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character): string => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function smtpMessage(to: string, verificationUrl: string): Readonly<{ to: readonly string[]; subject: string; text: string; html: string }> {
  const safeUrl = escapeHtml(verificationUrl);
  return {
    to: [to],
    subject: "Verify your Terrence email address",
    text: `Verify your Terrence email address by opening this link:\n${verificationUrl}\n\nThis link expires in 24 hours.`,
    html: `<html><body><p>Verify your Terrence email address by opening this link:</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>This link expires in 24 hours.</p></body></html>`,
  };
}

export const emailVerificationRoutes = new Elysia({ name: "email-verification" })
  .use(authPlugin)
  .post("/api/v2/account/email/verification", async ({ user, request, set }: Ctx): Promise<unknown> => {
    if (user === null || user === undefined) return error(set, 404, "Not Found");
    if (user.deletedAt !== null || user.isSuspended === true) return error(set, 403, "Suspended accounts cannot verify email");
    const email = normalizeEmail(user.email);
    if (email === null) return error(set, 422, "A valid email address is required");
    if (user.emailVerifiedAt !== null) {
      return { data: { type: "email-verification", attributes: { verified: true } } };
    }
    const recent = await db.query.emailVerificationTokens.findFirst({
      where: and(eq(emailVerificationTokens.userId, user.id), gt(emailVerificationTokens.createdAt, Date.now() - REQUEST_COOLDOWN_MS), isNull(emailVerificationTokens.usedAt)),
    });
    if (recent !== undefined) return error(set, 429, "A verification email was sent recently");
    const smtp = await getSettings("smtp");
    const host = typeof smtp["host"] === "string" ? smtp["host"].trim() : "";
    const senderEmail = typeof smtp["sender-email"] === "string" ? smtp["sender-email"].trim() : "";
    if (smtp["enabled"] !== true || host === "" || senderEmail === "") return error(set, 503, "Email delivery is not configured");
    const rawToken = generateAuthenticationToken("email");
    const tokenHash = hashAuthenticationToken(rawToken);
    const now = Date.now();
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, user.id));
      await t.insert(emailVerificationTokens).values({
        id: `emailverify-${crypto.randomUUID()}`,
        userId: user.id,
        email,
        tokenHash,
        expiresAt: now + TOKEN_TTL_MS,
        createdAt: now,
        usedAt: null,
      });
    });
    const verificationUrl = apiURL(request, `/api/v2/account/email/verify?token=${encodeURIComponent(rawToken)}`);
    try {
      await sendEmail(
        {
          host,
          port: typeof smtp["port"] === "number" ? smtp["port"] : 25,
          username: typeof smtp["username"] === "string" && smtp["username"] !== "" ? smtp["username"] : null,
          password: typeof smtp["password"] === "string" ? smtp["password"] : null,
          senderEmail,
          auth: smtp["auth"] === "none" || smtp["auth"] === "login" || smtp["auth"] === "plain" ? smtp["auth"] : "plain",
          encryption: isSmtpEncryption(smtp["encryption"]) ? smtp["encryption"] : null,
        },
        smtpMessage(email, verificationUrl),
      );
    } catch {
      await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, tokenHash));
      return error(set, 502, "Verification email could not be sent");
    }
    await auditLog("request", "email-verification", user.id, user.id, null, { email });
    return { data: { type: "email-verification", attributes: { verified: false, "expires-at": new Date(now + TOKEN_TTL_MS).toISOString() } } };
  })
  .get("/api/v2/account/email/verify", async (ctx: Ctx): Promise<Response> => {
    // This route is the href inside the verification email, so every outcome
    // lands in the browser, not in an API client. Always answer with a
    // redirect into the SPA (which carries the result via query flags) instead
    // of a JSON error document; the SPA turns the flag into visible feedback.
    const redirect = (query: string): Response => new Response(null, {
      status: 302,
      headers: { Location: `/app/account${query}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
    const rawToken = tokenFromContext(ctx);
    if (rawToken.trim() === "") return redirect("?email-verification=missing");
    const [tokenHash, legacyTokenHash] = tokenHashCandidates(rawToken);
    const tokenRows = await db.query.emailVerificationTokens.findMany({ where: inArray(emailVerificationTokens.tokenHash, [tokenHash, legacyTokenHash]), limit: 2 });
    const row = tokenRows.find((candidate) => candidate.tokenHash === tokenHash) ?? tokenRows[0];
    if (row === undefined || row.usedAt !== null || row.expiresAt <= Date.now()) return redirect("?email-verification=expired");
    if (row.tokenHash === legacyTokenHash) {
      await db.update(emailVerificationTokens).set({ tokenHash }).where(eq(emailVerificationTokens.id, row.id));
    }
    const target = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (target === undefined || target.email === null || normalizeEmail(target.email) !== row.email) return redirect("?email-verification=changed");
    if (target.deletedAt !== null || target.isSuspended === true) return redirect("?email-verification=suspended");
    const now = Date.now();
    const claimed = await db.transaction(async (tx: unknown): Promise<boolean> => {
      const t = tx as typeof db;
      const claimedRows = await t.update(emailVerificationTokens).set({ usedAt: now }).where(and(eq(emailVerificationTokens.id, row.id), isNull(emailVerificationTokens.usedAt), gt(emailVerificationTokens.expiresAt, now))).returning({ id: emailVerificationTokens.id });
      if (claimedRows.length === 0) return false;
      await t.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, row.userId));
      return true;
    });
    if (!claimed) return redirect("?email-verification=expired");
    await auditLog("verify", "email-verification", row.userId, row.userId, null, { email: row.email });
    return redirect("?email-verified=1");
  });
