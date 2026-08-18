import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./index.css";
import App from "./App";
import { applyTheme } from "./lib/theme";
import { bootstrapAuth } from "./lib/api";

applyTheme();

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  // Bootstrap the access token from the HttpOnly refresh cookie before first
  // render so ProtectedRoute sees an authenticated session on reload. A
  // missing/expired session resolves fast (single 401); a hung refresh must
  // not block first paint, so the attempt is bounded. The app renders on
  // success AND failure alike (finally).
  const bootstrap = Promise.race([
    bootstrapAuth(),
    new Promise<null>((resolve): void => {
      setTimeout((): void => resolve(null), 4000);
    }),
  ]);
  void bootstrap.finally((): void => {
    createRoot(rootElement).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}