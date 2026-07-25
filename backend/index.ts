
import { app } from "./src/app";

app
  .listen(3000);

console.log(
  `🦊 Backend is running at ${app.server?.hostname}:${app.server?.port}`
);
