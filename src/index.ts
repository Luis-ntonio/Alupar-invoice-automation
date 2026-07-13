import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { config } from "./config";
import router from "./routes";
import { startCoesScheduler } from "./services/coesScheduler";
import { attachWebSocketServer } from "./services/realtime";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use(express.static(path.resolve("public")));

app.get("*", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(config.port, () => {
  console.log(`Proyecto2 API ejecutandose en puerto ${config.port} (${config.nodeEnv}).`);
  startCoesScheduler();
});
