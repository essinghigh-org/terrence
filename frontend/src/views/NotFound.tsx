import { Link, useLocation } from "react-router-dom";
import { buttonVariants } from "../components/ui/button";
import { Terrence } from "../components/brand/Terrence";
import { cn } from "../lib/utils";

/**
 * Custom 404 fallback (P3). Replaces the catch-all redirect to /app so an
 * unknown route shows a real error page with navigation instead of silently
 * landing on the dashboard.
 */
export function NotFound(): React.JSX.Element {
  const location = useLocation();
  const insideApp = location.pathname.startsWith("/app/");

  return (
    <div className="flex min-h-[70svh] flex-col items-center justify-center px-4 py-10 text-center">
      <Terrence pose="lost" className="mb-3 w-56 rounded-full bg-accent/40" />
      <p className="mt-3 font-mono text-sm tracking-widest text-muted-foreground">404 / UNCHARTED TERRITORY</p>
      <h1 className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{location.pathname}</code>{" "}
        does not exist or may have moved.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          to={insideApp ? "/app" : "/"}
          className={cn(buttonVariants({ variant: "default", size: "default" }))}
        >
          {insideApp ? "Go to dashboard" : "Go home"}
        </Link>
        <Link
          to="/app/docs"
          className={cn(buttonVariants({ variant: "outline", size: "default" }))}
        >
          Read the docs
        </Link>
      </div>
    </div>
  );
}