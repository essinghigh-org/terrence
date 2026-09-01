import { Link, useLocation } from "react-router-dom";
import { buttonVariants } from "../components/ui/button";
import { FileQuestion } from "lucide-react";
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
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <FileQuestion className="size-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{location.pathname}</code>{" "}
        does not exist or may have moved.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          to={insideApp ? "/app" : "/"}
          className={cn(buttonVariants({ variant: "default", size: "default" }))}
        >
          {insideApp ? "Go to dashboard" : "Go home"}
        </Link>
        {!insideApp && (
          <Link
            to="/app"
            className={cn(buttonVariants({ variant: "outline", size: "default" }))}
          >
            Open the app
          </Link>
        )}
      </div>
    </div>
  );
}