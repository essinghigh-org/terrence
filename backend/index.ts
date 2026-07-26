
import { app } from "./src/app";

const port = Number(process.env.PORT ?? 3000);

app
  .listen(port);

console.log(
  `🦊 Backend is running at ${app.server?.hostname}:${app.server?.port}`
);
