import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config";
import router from "./routes";
import { startCoesScheduler } from "./services/coesScheduler";

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use(express.static(path.resolve("public")));

app.get("*", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

app.listen(config.port, () => {
  console.log(`Proyecto2 API ejecutandose en puerto ${config.port} (${config.nodeEnv}).`);
  startCoesScheduler();
});
