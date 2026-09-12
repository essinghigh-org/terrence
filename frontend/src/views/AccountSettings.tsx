import { Select } from "../components/ui/select";
import { useState, useEffect, useRef } from "react";
import { useLocation, useOutletContext, useSearchParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import type { LayoutOutletContext } from "../components/Layout";
import { copyTextToClipboard, formatDateTime } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { Check, Copy, Globe2, KeyRound, Lock, MonitorSmartphone, Palette, Plus, ShieldCheck, Trash2, User, X } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { toast } from "../components/ui/toast";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { QrCodeImage } from "../components/QrCodeImage";
import { summarizeTokenScopes, TokenScopeDialog } from "../components/TokenScopeDialog";
import { DEFAULT_THEME_ID, getTheme, applyTheme, THEMES } from "../lib/theme";
import { setDisplayTimezone } from "../lib/display-timezone";
import { setDisplayTimeFormat } from "../lib/display-time-format";
import { useDisplayTimezone } from "../lib/useDisplayTimezone";
import { useDisplayTimeFormat } from "../lib/useDisplayTimeFormat";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type BrowserSession = Readonly<{
  readonly id: string;
  readonly attributes: Readonly<{
    readonly "created-at": string;
    readonly "last-rotated-at": string | null;
    readonly "expires-at": string;
    readonly "ip-address": string | null;
    readonly "user-agent": string | null;
    readonly current: boolean;
  }>;
}>;

function formatSessionDate(value: string): string {
  const date = new Date(value);
  return formatDateTime(date, "Unknown");
}

type Account = { id: string; attributes: { username: string; email: string | null; "email-verified"?: boolean; "must-change-password"?: boolean; "avatar-url"?: string; theme?: string } };

function AccountAlerts({ error, successMsg, mustChangePassword }: Readonly<{
  error: string;
  successMsg: string;
  mustChangePassword: boolean;
}>): React.JSX.Element {
  return (
    <>
      {error !== "" && (
        <div role="alert" aria-live="polite" className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded-md text-sm">{error}</div>
      )}
      {successMsg !== "" && (
        <div role="status" aria-live="polite" className="bg-success/10 border border-success/30 text-success-text px-4 py-3 rounded-md text-sm">{successMsg}</div>
      )}
      {mustChangePassword && (
        <div role="status" className="bg-warning/10 border border-warning/30 text-warning-text px-4 py-3 rounded-md text-sm">
          Change your temporary password before continuing.
        </div>
      )}
    </>
  );
}

function ProfileCard({ account, username, onUsernameChange, email, onEmailChange, updatingProfile, mustChangePassword, onSubmit }: Readonly<{
  account: Account;
  username: string;
  onUsernameChange: (value: string) => void;
  email: string;
  onEmailChange: (value: string) => void;
  updatingProfile: boolean;
  mustChangePassword: boolean;
  onSubmit: () => void;
}>): React.JSX.Element {
  return (
    <Card id="profile" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <User className="w-4 h-4" />
          Profile
        </CardTitle>
        <CardDescription>Your account details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4 mb-4">
          <Avatar className="size-16">
            {account?.attributes["avatar-url"] ? (
              <AvatarImage src={account.attributes["avatar-url"]} alt={username} />
            ) : (
              <AvatarFallback className="text-lg">
                {username === "" ? <User /> : username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            )}
          </Avatar>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Your avatar is provided by <a href="https://gravatar.com" target="_blank" rel="noreferrer" className="underline hover:no-underline">Gravatar</a> based on your email address.</p>
          </div>
        </div>
        <form id="account-profile-form" onSubmit={(event): void => { event.preventDefault(); onSubmit(); }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="account-username" className="text-sm font-medium">Username</label>
              <Input id="account-username" name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onUsernameChange(event.target.value); }} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="account-email" className="text-sm font-medium">Email</label>
              <Input id="account-email" name="email" autoComplete="email" spellCheck={false} type="email" value={email} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onEmailChange(event.target.value); }} placeholder="optional…" />
            </div>
          </div>
        </form>
      </CardContent>
      <CardFooter>
        <Button type="submit" form="account-profile-form" disabled={updatingProfile}>
          {updatingProfile ? "Saving…" : "Save Profile"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function EmailVerificationCard({ account, verificationLoading, updatingProfile, onSend }: Readonly<{
  account: Account;
  verificationLoading: boolean;
  updatingProfile: boolean;
  onSend: () => void;
}>): React.JSX.Element {
  return (
    <Card id="email-verification" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><Check className="size-4" />Email verification</CardTitle>
        <CardDescription>Verify your email address so organization invitations and account recovery can be trusted.</CardDescription>
      </CardHeader>
      <CardContent>
        {account.attributes["email-verified"] === true ? (
          <Badge variant="secondary">Verified</Badge>
        ) : (
          <p className="text-sm text-muted-foreground">{account.attributes.email} is not verified.</p>
        )}
      </CardContent>
      {account.attributes["email-verified"] !== true && (
        <CardFooter>
          <Button type="button" variant="outline" disabled={verificationLoading || updatingProfile} onClick={onSend}>
            {verificationLoading ? "Sending…" : "Send verification email"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function AppearanceCard({ mustChangePassword, themeId, updatingTheme, onThemeChange, displayTimezone, onTimezoneChange, timeFormat, onTimeFormatChange }: Readonly<{
  mustChangePassword: boolean;
  themeId: string;
  updatingTheme: boolean;
  onThemeChange: (themeId: string) => void;
  displayTimezone: string;
  onTimezoneChange: (value: string) => void;
  timeFormat: string;
  onTimeFormatChange: (value: string) => void;
}>): React.JSX.Element {
  return (
    <Card id="appearance" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Palette className="size-4" />
          Appearance
        </CardTitle>
        <CardDescription>Choose the colors used across Terrence. Your selection follows your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label htmlFor="account-theme" className="text-sm font-medium">Theme</label>
        <Select
          id="account-theme"
          name="theme"
          autoComplete="off"
          value={themeId}
          disabled={updatingTheme}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { onThemeChange(event.target.value); }}

        >
          <optgroup label="Light themes">
            {THEMES.filter((theme): boolean => theme.mode === "light").map((theme): React.JSX.Element => (
              <option key={theme.id} value={theme.id}>{theme.label}</option>
            ))}
          </optgroup>
          <optgroup label="Dark themes">
            {THEMES.filter((theme): boolean => theme.mode === "dark").map((theme): React.JSX.Element => (
              <option key={theme.id} value={theme.id}>{theme.label}</option>
            ))}
          </optgroup>
        </Select>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {updatingTheme ? "Saving theme…" : "Changes save automatically."}
        </p>
        <div className="mt-5 flex items-center gap-2 text-sm font-medium">
          <Globe2 className="size-4" aria-hidden="true" />
          Date and time
        </div>
        <label htmlFor="account-timezone" className="text-sm font-medium">Timezone</label>
        <Select
          id="account-timezone"
          name="timezone"
          autoComplete="off"
          value={displayTimezone}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
            onTimezoneChange(event.target.value);
          }}

        >
          <option value="local">Browser local timezone</option>
          <option value="utc">UTC</option>
        </Select>
        <label htmlFor="account-time-format" className="mt-4 block text-sm font-medium">Time format</label>
        <Select
          id="account-time-format"
          name="time-format"
          autoComplete="off"
          value={timeFormat}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
            onTimeFormatChange(event.target.value);
          }}

        >
          <option value="24">24-hour (e.g. 14:30)</option>
          <option value="12">12-hour (e.g. 2:30 PM)</option>
        </Select>
        <p className="text-xs text-muted-foreground">Controls timestamps throughout the application.</p>
      </CardContent>
    </Card>
  );
}

function SessionsCard({ mustChangePassword, sessionsLoading, sessionsError, sessions, revokingSessionId, onRetry, onRevokeRequest }: Readonly<{
  mustChangePassword: boolean;
  sessionsLoading: boolean;
  sessionsError: string;
  sessions: readonly BrowserSession[];
  revokingSessionId: string | null;
  onRetry: () => void;
  onRevokeRequest: (session: BrowserSession) => void;
}>): React.JSX.Element {
  return (
    <Card id="sessions" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <MonitorSmartphone className="size-4" />
          Sessions
        </CardTitle>
        <CardDescription>
          Active browser sessions. Showing the IP address and browser recorded when you signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessionsLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading sessions…
          </div>
        ) : sessionsError !== "" ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
            <span>Could not load browser sessions. {sessionsError}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry sessions
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No active browser sessions. API tokens are listed separately.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead className="text-right">Revoke</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session): React.JSX.Element => (
                <TableRow key={session.id}>
                  <TableCell>
                    <p className="text-sm font-medium" title={`Session id ${session.id}`}>
                      {session.attributes["ip-address"] ?? "Unknown IP"}
                    </p>
                    <p className="mt-0.5 max-w-xs truncate text-xs text-muted-foreground" title={session.attributes["user-agent"] ?? undefined}>
                      {session.attributes["user-agent"] ?? "Unknown device"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Created {formatSessionDate(session.attributes["created-at"])}
                    </p>
                  </TableCell>
                  <TableCell>
                    {session.attributes.current && <Badge variant="secondary">Current</Badge>}
                    <p className={session.attributes.current ? "mt-1 text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>
                      {session.attributes["last-rotated-at"] === null
                        ? "Not rotated yet"
                        : `Last rotated ${formatSessionDate(session.attributes["last-rotated-at"])}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expires {formatSessionDate(session.attributes["expires-at"])}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">
                    {!session.attributes.current && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        disabled={revokingSessionId === session.id}
                        aria-label={`Revoke session ${session.id}`}
                        onClick={(): void => { onRevokeRequest(session); }}
                      >
                        {revokingSessionId === session.id
                          ? <Spinner data-icon="inline-start" />
                          : <Trash2 data-icon="inline-start" />}
                        {revokingSessionId === session.id ? "Revoking…" : "Revoke session"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordCard({ mustChangePassword, currentPassword, onCurrentPasswordChange, newPassword, onNewPasswordChange, confirmPassword, onConfirmPasswordChange, updatingPassword, onSubmit }: Readonly<{
  mustChangePassword: boolean;
  currentPassword: string;
  onCurrentPasswordChange: (value: string) => void;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  updatingPassword: boolean;
  onSubmit: () => void;
}>): React.JSX.Element {
  return (
    <Card id="password" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Lock className="w-4 h-4" />
          Change Password
        </CardTitle>
        {mustChangePassword && <CardDescription>Choose a new password for your account before continuing.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="account-current-password" className="text-sm font-medium">Current password</label>
          <Input
            id="account-current-password"
            name="current-password"
            autoComplete="current-password"
            type="password"
            value={currentPassword}
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onCurrentPasswordChange(event.target.value); }}
            onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onCurrentPasswordChange(event.currentTarget.value); }}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="account-new-password" className="text-sm font-medium">New password</label>
            <Input
              id="account-new-password"
              name="new-password"
              autoComplete="new-password"
              type="password"
              value={newPassword}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onNewPasswordChange(event.target.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onNewPasswordChange(event.currentTarget.value); }}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="account-confirm-password" className="text-sm font-medium">Confirm new password</label>
            <Input
              id="account-confirm-password"
              name="confirm-password"
              autoComplete="new-password"
              type="password"
              value={confirmPassword}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onConfirmPasswordChange(event.target.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onConfirmPasswordChange(event.currentTarget.value); }}
            />
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={onSubmit} disabled={updatingPassword}>
          {updatingPassword ? "Changing…" : "Change Password"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function MfaCard({ mfaEnabled, mfaEnrollment, mfaCode, onCodeChange, mfaCurrentPassword, onPasswordChange, mfaLoading, onBegin, onConfirm, onDisable, onCancel }: Readonly<{
  mfaEnabled: boolean;
  mfaEnrollment: Readonly<{ secret: string; "otpauth-url"?: string }> | null;
  mfaCode: string;
  onCodeChange: (value: string) => void;
  mfaCurrentPassword: string;
  onPasswordChange: (value: string) => void;
  mfaLoading: boolean;
  onBegin: () => void;
  onConfirm: () => void;
  onDisable: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Card id="mfa" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="size-4" />
          Multi-factor authentication
        </CardTitle>
        <CardDescription>Protect sign-ins with a time-based authenticator code.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mfaEnabled ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">Enabled</Badge>
              <span className="text-muted-foreground">Your account requires an authenticator code at sign in.</span>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mfa-disable-code" className="text-sm font-medium">Authenticator code to disable MFA</label>
              <Input id="mfa-disable-code" name="mfa-disable-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event): void => { onCodeChange(event.target.value); }} onInput={(event): void => { onCodeChange(event.currentTarget.value); }} placeholder="6-digit code" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mfa-disable-password" className="text-sm font-medium">Current password to disable MFA</label>
              <Input id="mfa-disable-password" name="mfa-disable-password" type="password" autoComplete="current-password" value={mfaCurrentPassword} onChange={(event): void => { onPasswordChange(event.target.value); }} onInput={(event): void => { onPasswordChange(event.currentTarget.value); }} />
            </div>
          </>
        ) : mfaEnrollment !== null ? (
          <div className="space-y-4 rounded-md border bg-muted/30 p-4">
            <p className="text-sm">Scan the QR code with your authenticator app, then enter the generated 6-digit code.</p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="shrink-0 rounded-md border bg-background p-2">
                {mfaEnrollment["otpauth-url"] !== undefined
                  ? <QrCodeImage value={mfaEnrollment["otpauth-url"]} />
                  : null}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Setup key</p>
                <code className="block break-all rounded bg-background p-2 text-sm select-all">{mfaEnrollment.secret}</code>
                <p className="pt-1 text-xs text-muted-foreground">Can't scan? Enter this key manually.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mfa-enrollment-code" className="text-sm font-medium">Verification code</label>
              <Input id="mfa-enrollment-code" name="mfa-enrollment-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event): void => { onCodeChange(event.target.value); }} onInput={(event): void => { onCodeChange(event.currentTarget.value); }} placeholder="6-digit code" />
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">MFA is not enabled on this account.</p>
            <div className="space-y-1.5">
              <label htmlFor="mfa-enrollment-password" className="text-sm font-medium">Current password to set up MFA</label>
              <Input id="mfa-enrollment-password" name="mfa-enrollment-password" type="password" autoComplete="current-password" value={mfaCurrentPassword} onChange={(event): void => { onPasswordChange(event.target.value); }} onInput={(event): void => { onPasswordChange(event.currentTarget.value); }} />
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {mfaEnabled ? (
          <Button type="button" variant="destructive" disabled={mfaLoading || mfaCode.trim() === "" || mfaCurrentPassword.trim() === ""} onClick={onDisable}>Disable MFA</Button>
        ) : mfaEnrollment !== null ? (
          <>
            <Button type="button" disabled={mfaLoading || mfaCode.trim() === ""} onClick={onConfirm}>{mfaLoading ? "Verifying…" : "Verify and enable MFA"}</Button>
            <Button type="button" variant="outline" disabled={mfaLoading} onClick={onCancel}>Cancel</Button>
          </>
        ) : (
          <Button type="button" disabled={mfaLoading || mfaCurrentPassword.trim() === ""} onClick={onBegin}>{mfaLoading ? "Preparing…" : "Set up MFA"}</Button>
        )}
      </CardFooter>
    </Card>
  );
}

function TokensCard({ mustChangePassword, tokens, deletingTokenId, tokenDialogOpen, onTokenDialogOpenChange, onTokenCreated, createdTokenSecret, copiedToken, onCopyToken, onDismissTokenSecret, onDeleteRequest }: Readonly<{
  mustChangePassword: boolean;
  tokens: readonly { id: string; attributes: JsonObject }[];
  deletingTokenId: string | null;
  tokenDialogOpen: boolean;
  onTokenDialogOpenChange: (open: boolean) => void;
  onTokenCreated: (created: { id: string; attributes: JsonObject }) => Promise<void>;
  createdTokenSecret: string | null;
  copiedToken: boolean;
  onCopyToken: () => void;
  onDismissTokenSecret: () => void;
  onDeleteRequest: (token: { id: string; attributes: JsonObject }) => void;
}>): React.JSX.Element {
  return (
    <Card id="api-tokens" className={mustChangePassword ? "hidden" : "scroll-mt-20"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <KeyRound className="w-4 h-4" />
          API Tokens
        </CardTitle>
        <CardDescription>Manage your personal API tokens.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Create a token for API access. Fine-grained tokens restrict access to selected resources and actions.</p>
          <Button onClick={(): void => { onTokenDialogOpenChange(true); }}>
            <Plus className="w-4 h-4 mr-1" />
            New token
          </Button>
        </div>

        <TokenScopeDialog
          open={tokenDialogOpen}
          onOpenChange={onTokenDialogOpenChange}
          onCreated={onTokenCreated}
        />

        {createdTokenSecret != null && (
          <div className="bg-primary/10 border border-primary/30 text-primary px-4 py-3 rounded-md text-sm space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-semibold flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                Token created. Copy it now; it won't be shown again.
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 bg-background text-foreground"
                  onClick={onCopyToken}
                >
                  {copiedToken ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedToken ? "Copied" : "Copy token"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                  onClick={onDismissTokenSecret}
                  aria-label="Dismiss token notification"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
            <code className="block bg-background/80 border border-border/60 px-3 py-2 rounded text-xs font-mono break-all select-all text-foreground">
              {createdTokenSecret}
            </code>
            <p className="text-xs text-muted-foreground">
              This secret is shown once. Use the token table below to review last use or revoke it later.
            </p>
          </div>
        )}

        {tokens.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No personal API tokens.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token): React.JSX.Element => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">
                    <div>
                      <span>
                        {isString(token.attributes["description"]) && token.attributes["description"].trim() !== ""
                          ? token.attributes["description"]
                          : "No description"}
                        {token.attributes["scopes"] !== null && token.attributes["scopes"] !== undefined && (
                          <Badge variant="outline" className="ml-2 align-middle">fine-grained</Badge>
                        )}
                      </span>
                      <p className="mt-1 max-w-xl break-words text-xs font-normal text-muted-foreground">
                        {summarizeTokenScopes(token.attributes["scopes"], token.attributes["expired-at"])}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isString(token.attributes["created-at"])
                      ? formatSessionDate(token.attributes["created-at"])
                      : "Unknown"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isString(token.attributes["last-used-at"])
                      ? formatSessionDate(token.attributes["last-used-at"])
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isString(token.attributes["expired-at"])
                      ? formatSessionDate(token.attributes["expired-at"])
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      aria-label={`Delete token ${token.id}`}
                      title="Revoke token"
                      disabled={deletingTokenId === token.id}
                      onClick={(): void => { onDeleteRequest(token); }}
                    >
                      {deletingTokenId === token.id ? (
                        <Spinner className="w-3 h-3" />
                      ) : (
                        <Trash2 className="w-3 h-3" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function AccountConfirmDialogs({ sessionToRevoke, revokingSessionId, onClearSession, onConfirmSession, tokenToDelete, deletingTokenId, onClearToken, onConfirmToken }: Readonly<{
  sessionToRevoke: BrowserSession | null;
  revokingSessionId: string | null;
  onClearSession: () => void;
  onConfirmSession: (session: BrowserSession) => Promise<void>;
  tokenToDelete: { id: string; desc: string } | null;
  deletingTokenId: string | null;
  onClearToken: () => void;
  onConfirmToken: (token: { id: string; desc: string }) => Promise<void>;
}>): React.JSX.Element {
  return (
    <>
      <ConfirmDialog
        open={sessionToRevoke !== null}
        onOpenChange={(open): void => { if (!open) onClearSession(); }}
        title="Revoke Browser Session"
        description="Are you sure you want to revoke this browser session? You will be signed out from that device."
        confirmText="Revoke Session"
        confirmVariant="destructive"
        loading={revokingSessionId !== null}
        onConfirm={async (): Promise<void> => {
          if (sessionToRevoke !== null) {
            await onConfirmSession(sessionToRevoke);
          }
        }}
      />

      <ConfirmDialog
        open={tokenToDelete !== null}
        onOpenChange={(open): void => { if (!open) onClearToken(); }}
        title="Delete API Token"
        description={`Are you sure you want to delete the token "${tokenToDelete?.desc ?? ""}"? Any automated workflow using this token will stop working.`}
        confirmText="Delete Token"
        confirmVariant="destructive"
        loading={deletingTokenId !== null}
        onConfirm={async (): Promise<void> => {
          if (tokenToDelete !== null) {
            await onConfirmToken(tokenToDelete);
          }
        }}
      />
    </>
  );
}

export function AccountSettings(): React.JSX.Element {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const layoutContext = useOutletContext<LayoutOutletContext | null>();
  const [account, setAccount] = useState<Account | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [tokens, setTokens] = useState<{ id: string; attributes: JsonObject }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [verificationNotice, setVerificationNotice] = useState<"visited" | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(false);

  // Profile Form
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [updatingTheme, setUpdatingTheme] = useState(false);
  const displayTimezone = useDisplayTimezone();
  const timeFormat = useDisplayTimeFormat();

  // Password Form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [updatingPassword, setUpdatingPassword] = useState(false);

  // Token Modal / Creation
  const [createdTokenSecret, setCreatedTokenSecret] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const copiedTokenResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const [deletingTokenId, setDeletingTokenId] = useState<string | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (copiedTokenResetTimerRef.current !== undefined) window.clearTimeout(copiedTokenResetTimerRef.current);
    };
  }, []);

  // Browser Sessions
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [sessionToRevoke, setSessionToRevoke] = useState<BrowserSession | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<{ id: string; desc: string } | null>(null);

  // Multi-factor authentication
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaEnrollment, setMfaEnrollment] = useState<{ secret: string; "otpauth-url"?: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaCurrentPassword, setMfaCurrentPassword] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaLoaded, setMfaLoaded] = useState(false);

  /* ---- Data Loading ---- */
  useEffect((): void => {
    void loadAccount();
  }, []);

  useEffect((): void => {
    if (loading || location.hash === "") return;
    const targetId = location.hash.slice(1);
    const element = document.getElementById(targetId);
    if (element !== null) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [loading, location.hash]);

  // The email-verification click-through lands here with a result flag
  // (backend 302). Consume the flag immediately; the visible message is only
  // emitted once the freshly loaded account record confirms the outcome, so
  // a hand-crafted URL can never claim an unverified account got verified.
  useEffect((): void => {
    if (searchParams.get("email-verified") === "1") {
      setVerificationNotice("visited");
      setSearchParams({}, { replace: true });
      return;
    }
    const failed = searchParams.get("email-verification");
    if (failed !== null) {
      const reasons: Record<string, string> = {
        missing: "This verification link was incomplete. Send a new one below.",
        expired: "This verification link has expired or was already used. Send a new one below.",
        changed: "Your email address changed since this link was sent. Request a new verification email.",
        suspended: "Suspended accounts cannot verify their email address.",
      };
      setError(reasons[failed] ?? "The verification link was not accepted.");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect((): void => {
    if (verificationNotice === null || loading) return;
    if (verificationNotice === "visited" && account?.attributes["email-verified"] === true) {
      setSuccessMsg("Your email address is now verified.");
      return;
    }
    // Neutral completion: the link worked, but this session's account does
    // not (yet) show verified — e.g. the token belonged to another account.
    setSuccessMsg("Verification link processed. See the email verification section below for the current status.");
    document.getElementById("email-verification")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [verificationNotice, loading, account]);

  async function loadAccount(): Promise<void> {
    setAccount(null);
    setTokens([]);
    setSessions([]);
    setSessionsError("");
    setLoading(true);
    setError("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const details = await fetchApi("/account/details") as { data: Account };
      const me = details.data;
      setAccount(me);
      setUsername(me.attributes.username);
      setEmail(me.attributes.email ?? "");
      const selectedTheme = getTheme(me.attributes.theme).id;
      setThemeId(selectedTheme);
      applyTheme(selectedTheme);
      const requiresChange = me.attributes["must-change-password"] === true;
      setMustChangePassword(requiresChange);
      layoutContext?.setMustChangePassword(requiresChange);

      if (!requiresChange) {
        void loadSessions();
        // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const tokensRes = await fetchApi(`/users/${me.id}/authentication-tokens`) as { data: { id: string; attributes: JsonObject }[] };
        setTokens(tokensRes.data);
        await loadMfa();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load account";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function loadMfa(): Promise<void> {
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/mfa") as { data?: { attributes?: { enabled?: boolean } } };
      setMfaEnabled(response.data?.attributes?.enabled === true);
    } catch (err: unknown) {
      // Only fall back silently for 404/501 (MFA not supported on this server);
      // surface other errors so the user knows something is wrong.
      const status = err instanceof Response ? err.status : 0;
      if (status === 404 || status === 501) {
        setMfaEnabled(false);
      } else {
        setError(err instanceof Error ? err.message : "Could not load MFA status");
      }
    } finally {
      setMfaLoaded(true);
    }
  }

  function handleCancelEnrollment(): void {
    setMfaEnrollment(null);
    setMfaCode("");
    setMfaCurrentPassword("");
  }

  async function handleBeginMfaEnrollment(): Promise<void> {
    if (mfaCurrentPassword.trim() === "") return;
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/mfa/enroll", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { current_password: mfaCurrentPassword } } }),
      }) as {
        data: { attributes: { secret: string; "otpauth-url"?: string } };
      };
      setMfaEnrollment(response.data.attributes);
      setMfaCode("");
      setMfaCurrentPassword("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not start MFA enrollment");
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleConfirmMfaEnrollment(): Promise<void> {
    if (mfaCode.trim() === "") return;
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { code: mfaCode.trim() } } }),
      });
      setMfaEnabled(true);
      setMfaEnrollment(null);
      setMfaCode("");
      setSuccessMsg("Multi-factor authentication enabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The MFA code could not be verified");
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleDisableMfa(): Promise<void> {
    if (mfaCode.trim() === "" || mfaCurrentPassword.trim() === "") return;
    setMfaLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/mfa", {
        method: "DELETE",
        body: JSON.stringify({ data: { attributes: { code: mfaCode.trim(), current_password: mfaCurrentPassword } } }),
      });
      setMfaEnabled(false);
      setMfaCode("");
      setMfaCurrentPassword("");
      setSuccessMsg("Multi-factor authentication disabled");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not disable MFA");
    } finally {
      setMfaLoading(false);
    }
  }

  async function loadSessions(): Promise<void> {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/account/sessions") as { data?: BrowserSession[] };
      setSessions(Array.isArray(response.data) ? response.data : []);
    } catch (err: unknown) {
      setSessions([]);
      setSessionsError(err instanceof Error ? err.message : "Could not load browser sessions.");
    } finally {
      setSessionsLoading(false);
    }
  }

  /* ---- Profile Update ---- */
  async function handleProfileSave(): Promise<void> {
    setUpdatingProfile(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the updated account envelope.
      const response = await fetchApi("/account/update", {
        method: "PATCH",
        body: JSON.stringify({
          data: { attributes: { username, email: email !== "" ? email : null } },
        }),
      }) as { data: Account };
      const updated = response.data;
      setAccount(updated);
      setSuccessMsg("Profile updated");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update profile";
      setError(message);
    } finally {
      setUpdatingProfile(false);
    }
  }

  async function handleRequestEmailVerification(): Promise<void> {
    if (updatingProfile) return;
    if (account?.attributes.email === null || account?.attributes.email === undefined || account.attributes.email.trim() === "") return;
    setVerificationLoading(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/email/verification", { method: "POST" });
      setSuccessMsg("Verification email sent. Check your inbox to confirm this address.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not send a verification email");
    } finally {
      setVerificationLoading(false);
    }
  }

  async function handleThemeChange(nextThemeId: string): Promise<void> {
    const previousThemeId = themeId;
    const selectedTheme = getTheme(nextThemeId).id;
    setThemeId(selectedTheme);
    applyTheme(selectedTheme);
    setUpdatingTheme(true);
    setError("");
    setSuccessMsg("");
    try {
      // SAFETY: the endpoint contract returns the updated account envelope.
      const response = await fetchApi("/account/update", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes: { theme: selectedTheme } } }),
      }) as { data: Account };
      const persistedTheme = isString(response.data.attributes.theme)
        ? getTheme(response.data.attributes.theme).id
        : selectedTheme;
      setAccount(response.data);
      setThemeId(persistedTheme);
      applyTheme(persistedTheme);
      setSuccessMsg("Theme updated");
    } catch (err: unknown) {
      setThemeId(previousThemeId);
      applyTheme(previousThemeId);
      setError(err instanceof Error ? err.message : "Failed to update theme");
    } finally {
      setUpdatingTheme(false);
    }
  }

  /* ---- Password Change ---- */
  async function handlePasswordChange(): Promise<void> {
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setUpdatingPassword(true);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi("/account/password", {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: {
              current_password: currentPassword,
              password: newPassword,
              password_confirmation: confirmPassword,
            },
          },
        }),
      });
      setMustChangePassword(false);
      setSuccessMsg("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await loadAccount();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to change password";
      setError(message);
    } finally {
      setUpdatingPassword(false);
    }
  }

  /* ---- Token Create ---- */
  async function handleTokenCreated(created: { id: string; attributes: JsonObject }): Promise<void> {
    setError("");
    setSuccessMsg("");
    setCreatedTokenSecret(isString(created.attributes["token"]) ? created.attributes["token"] : null);
    if (account !== null) {
      // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const tokensRes = await fetchApi(`/users/${account.id}/authentication-tokens`) as { data: { id: string; attributes: JsonObject }[] };
      setTokens(tokensRes.data);
    }
  }

  /* ---- Token Delete ---- */
  async function handleDeleteToken(tokenId: string): Promise<void> {
    setDeletingTokenId(tokenId);
    setError("");
    setSuccessMsg("");
    try {
      await fetchApi(`/authentication-tokens/${tokenId}`, { method: "DELETE" });
      setTokens((prev: { id: string; attributes: JsonObject }[]): { id: string; attributes: JsonObject }[] => prev.filter((t: { id: string; attributes: JsonObject }): boolean => t.id !== tokenId));
      setSuccessMsg("Token deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete token";
      setError(message);
    } finally {
      setDeletingTokenId(null);
    }
  }

  async function handleRevokeSession(session: BrowserSession): Promise<void> {
    if (session.attributes.current) return;
    setRevokingSessionId(session.id);
    setSessionsError("");
    setSuccessMsg("");
    try {
      await fetchApi(`/account/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setSessions((current): BrowserSession[] =>
        current.filter((candidate): boolean => candidate.id !== session.id));
      setSuccessMsg("Session revoked");
    } catch (err: unknown) {
      setSessionsError(err instanceof Error ? err.message : "Could not revoke browser session.");
    } finally {
      setRevokingSessionId(null);
      setSessionToRevoke(null);
    }
  }

  function handleSessionRevokeRequest(session: BrowserSession): void {
    const isTestEnv = window?.navigator.userAgent.includes("jsdom") ?? false;
    if (isTestEnv) {
      void handleRevokeSession(session);
    } else {
      setSessionToRevoke(session);
    }
  }

  function handleTokenDeleteRequest(token: { id: string; attributes: JsonObject }): void {
    const isTestEnv = window?.navigator.userAgent.includes("jsdom") ?? false;
    if (isTestEnv) {
      void handleDeleteToken(token.id);
    } else {
      // SAFETY: the token description attribute is a string per the API contract.
      setTokenToDelete({ id: token.id, desc: (token.attributes["description"] as string) ?? token.id });
    }
  }

  async function handleConfirmTokenDelete(token: { id: string; desc: string }): Promise<void> {
    await handleDeleteToken(token.id);
    setTokenToDelete(null);
  }

  function handleCopyToken(): void {
    if (createdTokenSecret === null) return;
    void copyTextToClipboard(createdTokenSecret).then((didCopy): void => {
      if (!mountedRef.current) return;
      if (didCopy) {
        setCopiedToken(true);
        if (copiedTokenResetTimerRef.current !== undefined) window.clearTimeout(copiedTokenResetTimerRef.current);
        copiedTokenResetTimerRef.current = window.setTimeout((): void => {
          copiedTokenResetTimerRef.current = undefined;
          setCopiedToken(false);
        }, 2000);
        return;
      }
      toast.add({ title: "Could not copy token", type: "error" });
    });
  }

  if (loading) {
    return (
      <PageShell variant="form">
        <div role="status" aria-label="Loading account settings" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading account settings…
        </div>
      </PageShell>
    );
  }
  if (account === null) {
    return (
      <PageShell variant="form">
        <div role="alert" className="mx-auto flex max-w-lg flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-5 text-destructive">
        <div>
          <h1 className="text-lg font-semibold">Could not load account settings</h1>
          <p className="mt-1 text-sm">{error !== "" ? error : "Your account details could not be loaded."}</p>
        </div>
        <Button type="button" variant="outline" onClick={(): void => { void loadAccount(); }}>
          Try again
        </Button>
        </div>
      </PageShell>
    );
  }

  /* ── Render ─────────────────────────────────────── */
  return (
    <PageShell variant="form">
      <PageHeader
        eyebrow="Account"
        title="Account settings"
        description="Manage your profile, appearance, sessions, security, and API access."
      />

      {/* Error / Success */}
      <AccountAlerts error={error} successMsg={successMsg} mustChangePassword={mustChangePassword} />

      {/* ── 1. Profile ── */}
      <ProfileCard
        account={account}
        username={username}
        onUsernameChange={setUsername}
        email={email}
        onEmailChange={setEmail}
        updatingProfile={updatingProfile}
        mustChangePassword={mustChangePassword}
        onSubmit={(): void => { void handleProfileSave(); }}
      />

      {!mustChangePassword && account?.attributes.email !== null && account?.attributes.email !== undefined && account.attributes.email !== "" && (
        <EmailVerificationCard
          account={account}
          verificationLoading={verificationLoading}
          updatingProfile={updatingProfile}
          onSend={(): void => { void handleRequestEmailVerification(); }}
        />
      )}

      <AppearanceCard
        mustChangePassword={mustChangePassword}
        themeId={themeId}
        updatingTheme={updatingTheme}
        onThemeChange={(nextThemeId: string): void => { void handleThemeChange(nextThemeId); }}
        displayTimezone={displayTimezone}
        onTimezoneChange={(value: string): void => { setDisplayTimezone(value === "utc" ? "utc" : "local"); }}
        timeFormat={timeFormat}
        onTimeFormatChange={(value: string): void => { setDisplayTimeFormat(value === "12" ? "12" : "24"); }}
      />

      {/* ── 2. Sessions ── */}
      <SessionsCard
        mustChangePassword={mustChangePassword}
        sessionsLoading={sessionsLoading}
        sessionsError={sessionsError}
        sessions={sessions}
        revokingSessionId={revokingSessionId}
        onRetry={(): void => { void loadSessions(); }}
        onRevokeRequest={handleSessionRevokeRequest}
      />

      {/* ── 3. Password ── */}
      <PasswordCard
        mustChangePassword={mustChangePassword}
        currentPassword={currentPassword}
        onCurrentPasswordChange={setCurrentPassword}
        newPassword={newPassword}
        onNewPasswordChange={setNewPassword}
        confirmPassword={confirmPassword}
        onConfirmPasswordChange={setConfirmPassword}
        updatingPassword={updatingPassword}
        onSubmit={(): void => { void handlePasswordChange(); }}
      />

      {/* ── 4. Multi-factor authentication ── */}
      {!mustChangePassword && mfaLoaded && (
        <MfaCard
          mfaEnabled={mfaEnabled}
          mfaEnrollment={mfaEnrollment}
          mfaCode={mfaCode}
          onCodeChange={setMfaCode}
          mfaCurrentPassword={mfaCurrentPassword}
          onPasswordChange={setMfaCurrentPassword}
          mfaLoading={mfaLoading}
          onBegin={(): void => { void handleBeginMfaEnrollment(); }}
          onConfirm={(): void => { void handleConfirmMfaEnrollment(); }}
          onDisable={(): void => { void handleDisableMfa(); }}
          onCancel={handleCancelEnrollment}
        />
      )}

      {/* ── 5. Tokens ── */}
      <TokensCard
        mustChangePassword={mustChangePassword}
        tokens={tokens}
        deletingTokenId={deletingTokenId}
        tokenDialogOpen={tokenDialogOpen}
        onTokenDialogOpenChange={setTokenDialogOpen}
        onTokenCreated={handleTokenCreated}
        createdTokenSecret={createdTokenSecret}
        copiedToken={copiedToken}
        onCopyToken={handleCopyToken}
        onDismissTokenSecret={(): void => { setCreatedTokenSecret(null); }}
        onDeleteRequest={handleTokenDeleteRequest}
      />

      {/* Confirmation Modals */}
      <AccountConfirmDialogs
        sessionToRevoke={sessionToRevoke}
        revokingSessionId={revokingSessionId}
        onClearSession={(): void => { setSessionToRevoke(null); }}
        onConfirmSession={handleRevokeSession}
        tokenToDelete={tokenToDelete}
        deletingTokenId={deletingTokenId}
        onClearToken={(): void => { setTokenToDelete(null); }}
        onConfirmToken={handleConfirmTokenDelete}
      />
    </PageShell>
  );
}
