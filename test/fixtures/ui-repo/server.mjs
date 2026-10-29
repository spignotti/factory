import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// Tiny web app for the evaluator's E2E tests: static pages plus one JSON API.
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const routes = {
  "/": ["web/index.html", "text/html"],
  "/tours": ["web/tours.html", "text/html"],
  "/api/tours": ["web/tours.json", "application/json"],
};
createServer((req, res) => {
  const route = routes[new URL(req.url, "http://app").pathname];
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": route[1] });
  res.end(readFileSync(new URL(route[0], import.meta.url)));
}).listen(port, "0.0.0.0");
