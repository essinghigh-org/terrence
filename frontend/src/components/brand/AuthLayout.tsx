import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Terrence, TerrenceLogo } from "./Terrence";

/** Shared welcome surface for sign-in and first-time account creation. */
export function AuthLayout({ children, mode = "signin" }: Readonly<{
  children: ReactNode;
  mode?: "signin" | "signup";
}>): React.JSX.Element {
  return (
    <main className="login-page">
      <section className="login-story" aria-label="Welcome to Terrence">
        <Link to="/" className="login-brand" aria-label="Terrence home"><TerrenceLogo wordmark /></Link>
        <div className="login-story-content">
          <p className="login-eyebrow">A little order for your infrastructure</p>
          <h2>{mode === "signup" ? <>Your next<br />chapter.</> : <>Big plans.<br />Steady hands.</>}</h2>
          <p className="login-story-description">Your workspaces, plans, and people.<br />Together in one place.</p>
          <div className="login-illustration">
            <div className="login-orbit" aria-hidden="true" />
            <span className="login-node login-node--plan" aria-hidden="true">plan</span>
            <span className="login-node login-node--apply" aria-hidden="true">apply</span>
            <Terrence pose={mode === "signup" ? "guide" : "welcome"} animated className="login-mascot" />
            <span className="login-illustration-caption">Meet Terrence. Your infrastructure companion.</span>
          </div>
        </div>
        <p className="login-story-footer">Made for OpenTofu &amp; Terraform.</p>
      </section>
      <section className="login-form-panel" aria-label={mode === "signup" ? "Create account" : "Sign in"}>
        <TerrenceLogo wordmark className="login-mobile-brand" />
        {children}
        <p className="login-form-note">Infrastructure automation, with a human touch.</p>
      </section>
    </main>
  );
}
