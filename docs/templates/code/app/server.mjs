// __APP_NAME__/app/server.mjs — minimal self-authored HTTP server.
// Listens on 0.0.0.0:__APP_PORT__ and returns 200 (so healthcheck + CI pass).
// Replace with your real application.
import { createServer } from "node:http";

const PORT = Number(process.env.__APP_PREFIX___PORT || __APP_PORT__);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Hello from __APP_NAME__\n");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`__APP_NAME__ listening on 0.0.0.0:${PORT}`);
});
